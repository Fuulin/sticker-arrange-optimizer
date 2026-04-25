import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Upload,
  Download,
  Loader2,
  ImageIcon,
  RotateCcw,
  X,
  Minus,
  Plus,
  Search,
  Images,
  Trash2,
} from "lucide-react";
import { cn } from "./lib/cn";
import {
  cmToPx,
  pxToCm,
  A4_CM,
  CRICUT_PTC_CM,
  CM_PER_INCH,
  DPI_PRESETS,
} from "./lib/units";
import {
  importFiles,
  disposeLibrarySticker,
  type LibrarySticker,
} from "./lib/import";
import type {
  PackResult,
  Placement,
  SerializablePackRequest,
  WorkerOutMessage,
} from "./packer/types";
import { CricutExport } from "./cricut/CricutExport";

// ======================================================================
// Types & defaults
// ======================================================================

/** User overrides per selected sticker. */
interface SelectionEntry {
  /** LibrarySticker id. */
  id: string;
  quantity: number;
  /** Multiplier on the sticker's native physical size (1 = native). */
  scale: number;
}

interface PackState {
  loading: boolean;
  progressPlaced: number;
  progressRequested: number;
  result: PackResult | null;
  /**
   * Cropped, rotated sticker bitmaps keyed by sticker id. Sent once by
   * the worker ahead of any `partial` / `done` messages so the main
   * thread can render intermediate layouts as they stream in. Kept in
   * `PackState` (not on `result`) because its lifetime spans the entire
   * pack run — including the window where `result` is a `PackSnapshot`
   * that doesn't yet have `extraFits`.
   */
  variantBitmaps: Record<string, ImageBitmap[]>;
  error: string | null;
  canvasWidthPx: number;
  canvasHeightPx: number;
}

const DEFAULT_DPI = 300;
const DEFAULT_MARGIN_MM = 2;
const DEFAULT_ALPHA = 16;
const DEFAULT_CANVAS_PAD_MM = 3;
const MAX_CANVAS_PAD_MM = 50;

interface CanvasPaddingMm {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const mmToPx = (mm: number, dpi: number) =>
  Math.max(0, Math.round((mm / 10 / CM_PER_INCH) * dpi));

// ======================================================================
// Top-level App
// ======================================================================

export default function App() {
  const [library, setLibrary] = useState<LibrarySticker[]>([]);
  const [selection, setSelection] = useState<SelectionEntry[]>([]);

  const [dpi, setDpi] = useState(DEFAULT_DPI);
  const [canvasWcm, setCanvasWcm] = useState<number>(A4_CM.w);
  const [canvasHcm, setCanvasHcm] = useState<number>(A4_CM.h);
  const [marginMm, setMarginMm] = useState(DEFAULT_MARGIN_MM);
  const [canvasPadMm, setCanvasPadMm] = useState<CanvasPaddingMm>({
    left: DEFAULT_CANVAS_PAD_MM,
    right: DEFAULT_CANVAS_PAD_MM,
    top: DEFAULT_CANVAS_PAD_MM,
    bottom: DEFAULT_CANVAS_PAD_MM,
  });
  const [canvasPadLinked, setCanvasPadLinked] = useState(true);
  const [alpha, setAlpha] = useState(DEFAULT_ALPHA);
  const [stride, setStride] = useState(2);
  const [rotationStep, setRotationStep] = useState(15);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const canvasWidthPx = cmToPx(canvasWcm, dpi);
  const canvasHeightPx = cmToPx(canvasHcm, dpi);
  const marginPx = mmToPx(marginMm, dpi);
  const canvasPadPx = useMemo(
    () => ({
      left: mmToPx(canvasPadMm.left, dpi),
      right: mmToPx(canvasPadMm.right, dpi),
      top: mmToPx(canvasPadMm.top, dpi),
      bottom: mmToPx(canvasPadMm.bottom, dpi),
    }),
    [canvasPadMm, dpi],
  );
  const setCanvasPadSide = useCallback(
    (side: keyof CanvasPaddingMm, value: number) => {
      const clamped = Math.max(
        0,
        Math.min(MAX_CANVAS_PAD_MM, Number.isFinite(value) ? value : 0),
      );
      setCanvasPadMm((prev) =>
        canvasPadLinked
          ? { left: clamped, right: clamped, top: clamped, bottom: clamped }
          : { ...prev, [side]: clamped },
      );
    },
    [canvasPadLinked],
  );

  const [pack, setPack] = useState<PackState>({
    loading: false,
    progressPlaced: 0,
    progressRequested: 0,
    result: null,
    variantBitmaps: {},
    error: null,
    canvasWidthPx,
    canvasHeightPx,
  });

  const [view, setView] = useState<"pack" | "cricut">("pack");

  // -------------------- Worker --------------------
  // Each pack run owns its own Worker instance. When the user tweaks
  // params (qty / scale / DPI / …) mid-pack, we `terminate()` the
  // in-flight worker rather than waiting for it to finish — otherwise
  // pack jobs pile up on a serial message queue and the UI falls
  // seconds behind user input.
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    // Only a teardown hook — workers are created lazily in `runPack`.
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  /**
   * Closes every bitmap inside a variantBitmaps map. Called when the
   * main thread is about to drop its reference (e.g. a new pack run is
   * starting). Without this, old ImageBitmaps would live until GC.
   */
  const disposeVariantBitmaps = useCallback(
    (variants: Record<string, ImageBitmap[]>) => {
      for (const arr of Object.values(variants)) {
        for (const b of arr) b.close();
      }
    },
    [],
  );

  // -------------------- Library helpers --------------------
  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      setImporting(true);
      try {
        const imported = await importFiles(files, dpi);
        setLibrary((lib) => [...lib, ...imported]);
        // Pop open the gallery so the user can immediately browse the new
        // stickers (especially important for PSDs that explode into dozens
        // or hundreds of layers).
        if (imported.length > 0) setGalleryOpen(true);
      } finally {
        setImporting(false);
      }
    },
    [dpi],
  );

  const removeFromLibrary = useCallback((id: string) => {
    setLibrary((lib) => {
      const tgt = lib.find((x) => x.id === id);
      if (tgt) disposeLibrarySticker(tgt);
      return lib.filter((x) => x.id !== id);
    });
    setSelection((sel) => sel.filter((s) => s.id !== id));
  }, []);

  const clearLibrary = useCallback(() => {
    library.forEach(disposeLibrarySticker);
    setLibrary([]);
    setSelection([]);
  }, [library]);

  // -------------------- Selection helpers --------------------
  const bumpSelection = useCallback((id: string, delta: number) => {
    setSelection((sel) => {
      const existing = sel.find((s) => s.id === id);
      if (!existing) {
        if (delta <= 0) return sel;
        return [...sel, { id, quantity: delta, scale: 1 }];
      }
      const nextQty = Math.max(0, existing.quantity + delta);
      if (nextQty === 0) return sel.filter((s) => s.id !== id);
      return sel.map((s) =>
        s.id === id ? { ...s, quantity: nextQty } : s,
      );
    });
  }, []);

  const setSelectionQty = useCallback((id: string, quantity: number) => {
    setSelection((sel) => {
      const q = Math.max(0, Math.floor(quantity));
      const existing = sel.find((s) => s.id === id);
      if (!existing) {
        if (q === 0) return sel;
        return [...sel, { id, quantity: q, scale: 1 }];
      }
      if (q === 0) return sel.filter((s) => s.id !== id);
      return sel.map((s) => (s.id === id ? { ...s, quantity: q } : s));
    });
  }, []);

  const removeFromSelection = useCallback((id: string) => {
    setSelection((sel) => sel.filter((s) => s.id !== id));
  }, []);

  const setSelectionScale = useCallback((id: string, scale: number) => {
    const clamped = Math.max(0.05, Math.min(5, scale));
    setSelection((sel) =>
      sel.map((s) => (s.id === id ? { ...s, scale: clamped } : s)),
    );
  }, []);

  // -------------------- Packer --------------------
  const runPack = useCallback(
    (
      lib: LibrarySticker[],
      sel: SelectionEntry[],
      canvasWPx: number,
      canvasHPx: number,
      marginPxArg: number,
      paddingPxArg: { left: number; right: number; top: number; bottom: number },
      alphaArg: number,
      strideArg: number,
      rotStepDeg: number,
      dpiArg: number,
    ) => {
      const libMap = new Map(lib.map((l) => [l.id, l]));
      const effective = sel
        .map((s) => ({ entry: s, lib: libMap.get(s.id) }))
        .filter((x): x is { entry: SelectionEntry; lib: LibrarySticker } =>
          Boolean(x.lib) && x.entry.quantity > 0,
        );

      // No selected stickers → cancel any in-flight pack, clear state.
      if (effective.length === 0) {
        if (workerRef.current) {
          workerRef.current.terminate();
          workerRef.current = null;
        }
        setPack((prev) => {
          disposeVariantBitmaps(prev.variantBitmaps);
          return {
            loading: false,
            progressPlaced: 0,
            progressRequested: 0,
            result: null,
            variantBitmaps: {},
            error: null,
            canvasWidthPx: canvasWPx,
            canvasHeightPx: canvasHPx,
          };
        });
        return;
      }

      // Kill any in-flight worker so its pending messages are dropped
      // and the CPU is freed for the new run. The previous run's
      // variantBitmaps are disposed in the setPack below.
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      const worker = new Worker(
        new URL("./packer/worker.ts", import.meta.url),
        { type: "module" },
      );
      workerRef.current = worker;

      const reqId = ++reqIdRef.current;
      setPack((prev) => {
        // Free the previous run's bitmaps. Keep `result` around (so the
        // canvas doesn't flash blank) until the new run emits its first
        // `partial` message — at which point it will be replaced.
        disposeVariantBitmaps(prev.variantBitmaps);
        return {
          ...prev,
          loading: true,
          error: null,
          progressPlaced: 0,
          progressRequested: effective.reduce(
            (a, x) => a + x.entry.quantity,
            0,
          ),
          variantBitmaps: {},
          canvasWidthPx: canvasWPx,
          canvasHeightPx: canvasHPx,
        };
      });

      Promise.all(
        effective.map(async ({ entry, lib: l }) => {
          // Resample bitmap so that its px dimensions equal the sticker's
          // *intended* physical size at the canvas DPI.
          const factor = entry.scale * (dpiArg / l.nativeDpi);
          const bmp = await rasterizeAtFactor(l.bitmap, factor);
          return {
            id: entry.id,
            bitmap: bmp,
            quantity: entry.quantity,
          };
        }),
      ).then((clones) => {
        if (reqId !== reqIdRef.current || workerRef.current !== worker) {
          // A newer pack request superseded us during rasterization.
          clones.forEach((c) => c.bitmap.close());
          return;
        }
        const req: SerializablePackRequest = {
          canvasWidth: canvasWPx,
          canvasHeight: canvasHPx,
          margin: marginPxArg,
          padding: paddingPxArg,
          stride: strideArg,
          alphaThreshold: alphaArg,
          rotationStepDeg: rotStepDeg,
          stickers: clones,
        };
        const transfers: Transferable[] = clones.map((c) => c.bitmap);
        const handler = (e: MessageEvent<WorkerOutMessage>) => {
          if (reqId !== reqIdRef.current) return;
          const msg = e.data;
          if (msg.type === "progress") {
            setPack((p) => ({
              ...p,
              progressPlaced: msg.placed,
              progressRequested: msg.requested,
            }));
          } else if (msg.type === "variants") {
            // First message of the stream: store the bitmaps so every
            // subsequent `partial` / `done` snapshot can be rendered.
            setPack((p) => {
              // Defensive: if something already stashed bitmaps (retry?),
              // free them first.
              disposeVariantBitmaps(p.variantBitmaps);
              return { ...p, variantBitmaps: msg.variantBitmaps };
            });
          } else if (msg.type === "partial") {
            // Live snapshot — render the improved layout immediately.
            // `extraFits` isn't known yet, so stub it as {}; the
            // SuggestionDrawer is gated on `!pack.loading` so this
            // empty map won't render a stale suggestion either.
            setPack((p) => ({
              ...p,
              result: { ...msg.snapshot, extraFits: {} },
              progressPlaced: msg.snapshot.placed,
              progressRequested: msg.snapshot.requested,
            }));
          } else if (msg.type === "done") {
            // `done` carries the final layout but `extraFits` is left
            // empty by the worker — the probe runs afterwards and
            // arrives in a follow-up `extraFits` message. Keep the
            // handler registered so we catch it.
            setPack((p) => ({
              ...p,
              loading: false,
              progressPlaced: msg.result.placed,
              progressRequested: msg.result.requested,
              result: msg.result,
              error: null,
            }));
          } else if (msg.type === "extraFits") {
            // Follow-up after `done`. Merge the numbers into whatever
            // result is currently on the pack state — guarded so a
            // superseded request can't clobber a newer result.
            setPack((p) => {
              if (!p.result) return p;
              return {
                ...p,
                result: { ...p.result, extraFits: msg.extraFits },
              };
            });
            worker.removeEventListener("message", handler);
          } else if (msg.type === "error") {
            setPack((p) => ({ ...p, loading: false, error: msg.message }));
            worker.removeEventListener("message", handler);
          }
        };
        worker.addEventListener("message", handler);
        worker.postMessage({ type: "pack", request: req }, transfers);
      });
    },
    [disposeVariantBitmaps],
  );

  // Pack runs are expensive — up to a few seconds at Exact quality with
  // many stickers and rotation=15°. Debouncing by 1s lets the user drag
  // sliders, type quantities, etc. freely without us kicking off (and
  // immediately terminating) repeated worker jobs.
  useEffect(() => {
    const t = setTimeout(() => {
      runPack(
        library,
        selection,
        canvasWidthPx,
        canvasHeightPx,
        marginPx,
        canvasPadPx,
        alpha,
        stride,
        rotationStep,
        dpi,
      );
    }, 1000);
    return () => clearTimeout(t);
  }, [
    library,
    selection,
    canvasWidthPx,
    canvasHeightPx,
    marginPx,
    canvasPadPx,
    alpha,
    stride,
    rotationStep,
    dpi,
    runPack,
  ]);

  // -------------------- Download --------------------
  const [downloading, setDownloading] = useState(false);
  const downloadPng = useCallback(async () => {
    if (!pack.result) return;
    setDownloading(true);
    try {
      const c = document.createElement("canvas");
      c.width = pack.canvasWidthPx;
      c.height = pack.canvasHeightPx;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      drawPlacements(ctx, pack.result.placements, pack.variantBitmaps);
      const url = c.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = `packed-${canvasWcm.toFixed(1)}x${canvasHcm.toFixed(1)}cm-${dpi}dpi.png`;
      a.click();
    } finally {
      setDownloading(false);
    }
  }, [pack, canvasWcm, canvasHcm, dpi]);

  if (view === "cricut" && pack.result) {
    return (
      <CricutExport
        result={pack.result}
        variantBitmaps={pack.variantBitmaps}
        canvasWidthPx={pack.canvasWidthPx}
        canvasHeightPx={pack.canvasHeightPx}
        dpi={dpi}
        alphaThreshold={alpha}
        onBack={() => setView("pack")}
      />
    );
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-neutral-950 text-neutral-100">
      <Sidebar
        library={library}
        selection={selection}
        dpi={dpi}
        canvasWcm={canvasWcm}
        canvasHcm={canvasHcm}
        marginMm={marginMm}
        canvasPadMm={canvasPadMm}
        canvasPadLinked={canvasPadLinked}
        alpha={alpha}
        stride={stride}
        rotationStep={rotationStep}
        onDpi={setDpi}
        onCanvasWcm={setCanvasWcm}
        onCanvasHcm={setCanvasHcm}
        onMarginMm={setMarginMm}
        onCanvasPadSide={setCanvasPadSide}
        onCanvasPadLinked={setCanvasPadLinked}
        onAlpha={setAlpha}
        onStride={setStride}
        onRotationStep={setRotationStep}
        onOpenGallery={() => setGalleryOpen(true)}
        onFilesSelected={addFiles}
        importing={importing}
        onSetScale={setSelectionScale}
        onBumpQty={bumpSelection}
        onSetQty={setSelectionQty}
        onRemoveSelection={removeFromSelection}
        pack={pack}
        onDownload={downloadPng}
        onExportCricut={() => setView("cricut")}
        downloading={downloading}
      />
      <PreviewPane
        pack={pack}
        canvasWcm={canvasWcm}
        canvasHcm={canvasHcm}
        canvasPadPx={canvasPadPx}
        selection={selection}
        library={library}
        onBumpQty={bumpSelection}
      />
      {galleryOpen ? (
        <GalleryModal
          library={library}
          selection={selection}
          onClose={() => setGalleryOpen(false)}
          onBump={bumpSelection}
          onRemoveSelection={removeFromSelection}
          onRemoveFromLibrary={removeFromLibrary}
          onClearLibrary={clearLibrary}
          onFilesSelected={addFiles}
          importing={importing}
        />
      ) : null}
    </div>
  );
}

// ======================================================================
// Sidebar
// ======================================================================

interface SidebarProps {
  library: LibrarySticker[];
  selection: SelectionEntry[];
  dpi: number;
  canvasWcm: number;
  canvasHcm: number;
  marginMm: number;
  canvasPadMm: CanvasPaddingMm;
  canvasPadLinked: boolean;
  alpha: number;
  stride: number;
  rotationStep: number;
  onDpi: (n: number) => void;
  onCanvasWcm: (n: number) => void;
  onCanvasHcm: (n: number) => void;
  onMarginMm: (n: number) => void;
  onCanvasPadSide: (side: keyof CanvasPaddingMm, value: number) => void;
  onCanvasPadLinked: (linked: boolean) => void;
  onAlpha: (n: number) => void;
  onStride: (n: number) => void;
  onRotationStep: (n: number) => void;
  onOpenGallery: () => void;
  onFilesSelected: (files: FileList | File[]) => void;
  importing: boolean;
  onSetScale: (id: string, scale: number) => void;
  onBumpQty: (id: string, delta: number) => void;
  onSetQty: (id: string, q: number) => void;
  onRemoveSelection: (id: string) => void;
  pack: PackState;
  onDownload: () => void;
  onExportCricut: () => void;
  downloading: boolean;
}

function Sidebar(props: SidebarProps) {
  const libMap = useMemo(
    () => new Map(props.library.map((l) => [l.id, l])),
    [props.library],
  );
  const placedPct = props.pack.progressRequested
    ? Math.round(
        (props.pack.progressPlaced / props.pack.progressRequested) * 100,
      )
    : 0;
  const coverage = props.pack.result
    ? Math.round(props.pack.result.bboxCoverage * 100)
    : 0;

  return (
    <aside className="flex h-full w-[400px] shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-5 py-4">
        <div className="flex size-8 items-center justify-center rounded-md bg-neutral-800">
          <ImageIcon className="size-4" />
        </div>
        <div>
          <div className="text-sm font-semibold">Sticker Optimizer</div>
          <div className="text-xs text-neutral-400">Print-ready packing</div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {/* Canvas */}
        <Section title="Canvas">
          <div className="grid grid-cols-2 gap-2">
            <CmField
              label="Width (cm)"
              value={props.canvasWcm}
              onChange={props.onCanvasWcm}
              min={1}
              max={200}
            />
            <CmField
              label="Height (cm)"
              value={props.canvasHcm}
              onChange={props.onCanvasHcm}
              min={1}
              max={200}
            />
          </div>
          <div className="flex gap-2">
            <PresetButton
              active={
                Math.abs(props.canvasWcm - A4_CM.w) < 0.05 &&
                Math.abs(props.canvasHcm - A4_CM.h) < 0.05
              }
              onClick={() => {
                props.onCanvasWcm(A4_CM.w);
                props.onCanvasHcm(A4_CM.h);
              }}
              label="A4"
            />
            <PresetButton
              active={
                Math.abs(props.canvasWcm - A4_CM.h) < 0.05 &&
                Math.abs(props.canvasHcm - A4_CM.w) < 0.05
              }
              onClick={() => {
                props.onCanvasWcm(A4_CM.h);
                props.onCanvasHcm(A4_CM.w);
              }}
              label="A4 Landscape"
            />
            <PresetButton
              active={
                Math.abs(props.canvasWcm - CRICUT_PTC_CM.w) < 0.05 &&
                Math.abs(props.canvasHcm - CRICUT_PTC_CM.h) < 0.05
              }
              onClick={() => {
                props.onCanvasWcm(CRICUT_PTC_CM.w);
                props.onCanvasHcm(CRICUT_PTC_CM.h);
              }}
              label="Cricut"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-300">
              DPI
            </label>
            <div className="flex gap-1">
              {DPI_PRESETS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => props.onDpi(d)}
                  className={cn(
                    "flex-1 rounded border px-2 py-1 text-xs transition-colors",
                    props.dpi === d
                      ? "border-neutral-100 bg-neutral-100 text-neutral-900"
                      : "border-neutral-800 bg-neutral-900 text-neutral-300 hover:bg-neutral-800",
                  )}
                >
                  {d}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-neutral-500 tabular-nums">
              Output: {cmToPx(props.canvasWcm, props.dpi)}×
              {cmToPx(props.canvasHcm, props.dpi)} px
            </p>
          </div>
          <CanvasPaddingControls
            padMm={props.canvasPadMm}
            linked={props.canvasPadLinked}
            onChange={props.onCanvasPadSide}
            onLinkedChange={props.onCanvasPadLinked}
          />
        </Section>

        {/* Packing */}
        <Section title="Packing">
          <CmField
            label="Feather margin (mm)"
            value={props.marginMm}
            onChange={props.onMarginMm}
            min={0}
            max={100}
            step={0.5}
          />
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-300">
              Quality
            </label>
            <div className="grid grid-cols-4 overflow-hidden rounded-md border border-neutral-800">
              {[
                { label: "Fast", v: 8 },
                { label: "Balanced", v: 4 },
                { label: "Fine", v: 2 },
                { label: "Exact", v: 1 },
              ].map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => props.onStride(opt.v)}
                  className={cn(
                    "px-2 py-1.5 text-xs transition-colors",
                    props.stride === opt.v
                      ? "bg-neutral-100 text-neutral-900"
                      : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-neutral-500">
              {props.stride}px pack grid.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-300">
              Rotation step
            </label>
            <div className="grid grid-cols-7 overflow-hidden rounded-md border border-neutral-800 text-[11px]">
              {[
                { label: "Off", v: 0 },
                { label: "90°", v: 90 },
                { label: "45°", v: 45 },
                { label: "30°", v: 30 },
                { label: "15°", v: 15 },
                { label: "10°", v: 10 },
                { label: "5°", v: 5 },
              ].map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => props.onRotationStep(opt.v)}
                  className={cn(
                    "px-1 py-1.5 transition-colors",
                    props.rotationStep === opt.v
                      ? "bg-neutral-100 text-neutral-900"
                      : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <NumberField
            label="Alpha threshold (0-255)"
            value={props.alpha}
            onChange={props.onAlpha}
            min={0}
            max={255}
          />
        </Section>

        {/* Library / Selection */}
        <Section
          title={`Selected${props.selection.length ? ` (${props.selection.length})` : ""}`}
          right={
            <button
              type="button"
              onClick={props.onOpenGallery}
              className="flex items-center gap-1 rounded-md bg-neutral-100 px-2 py-1 text-[11px] font-medium text-neutral-900 hover:bg-white"
            >
              <Images className="size-3" />
              Library ({props.library.length})
            </button>
          }
        >
          <SelectedList
            libMap={libMap}
            selection={props.selection}
            pack={props.pack}
            onSetScale={props.onSetScale}
            onBumpQty={props.onBumpQty}
            onSetQty={props.onSetQty}
            onRemove={props.onRemoveSelection}
          />
          {props.selection.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-neutral-800 bg-neutral-900 p-4 text-center">
              <p className="text-[11px] text-neutral-400">
                {props.library.length === 0
                  ? "No stickers imported yet."
                  : "Pick stickers from the library to start packing."}
              </p>
              {props.library.length === 0 ? (
                <QuickImportButton
                  onFilesSelected={props.onFilesSelected}
                  importing={props.importing}
                />
              ) : (
                <button
                  type="button"
                  onClick={props.onOpenGallery}
                  className="rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-white"
                >
                  Open Library
                </button>
              )}
            </div>
          ) : null}
        </Section>
      </div>

      {/* Footer */}
      <footer className="border-t border-neutral-800 bg-neutral-950 p-4">
        <div className="mb-2 flex items-center justify-between text-xs">
          <span className="text-neutral-400">Placed</span>
          <span className="tabular-nums text-neutral-200">
            {props.pack.progressPlaced} / {props.pack.progressRequested} (
            {placedPct}%)
          </span>
        </div>
        <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full bg-neutral-100 transition-[width] duration-150"
            style={{ width: `${placedPct}%` }}
          />
        </div>
        <div className="mb-3 flex items-center justify-between text-xs text-neutral-500">
          <span>Coverage (bbox)</span>
          <span className="tabular-nums">{coverage}%</span>
        </div>
        {props.pack.result ? (
          <UnplacedSummary
            pack={props.pack}
            selection={props.selection}
            libMap={libMap}
          />
        ) : null}
        <button
          type="button"
          onClick={props.onDownload}
          disabled={!props.pack.result || props.downloading}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {props.downloading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          Download PNG
        </button>
        <button
          type="button"
          onClick={props.onExportCricut}
          disabled={!props.pack.result}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
          title={props.pack.result ? "" : "Pack some stickers first"}
        >
          Export for Cricut →
        </button>
        {props.pack.error ? (
          <p className="mt-2 text-xs text-red-400">{props.pack.error}</p>
        ) : null}
      </footer>
    </aside>
  );
}

// ======================================================================
// Selected list (rows in the sidebar — only entries in `selection`)
// ======================================================================

function SelectedList({
  libMap,
  selection,
  pack,
  onSetScale,
  onBumpQty,
  onSetQty,
  onRemove,
}: {
  libMap: Map<string, LibrarySticker>;
  selection: SelectionEntry[];
  pack: PackState;
  onSetScale: (id: string, scale: number) => void;
  onBumpQty: (id: string, delta: number) => void;
  onSetQty: (id: string, q: number) => void;
  onRemove: (id: string) => void;
}) {
  const MAX_THUMB = 64;
  const MIN_THUMB = 12;

  // Compute per-entry effective physical longest edge for the relative preview.
  const physicalLongestCm = selection.map((entry) => {
    const lib = libMap.get(entry.id);
    if (!lib) return 0;
    const longestPx = Math.max(lib.bitmap.width, lib.bitmap.height);
    const nativeCm = (longestPx / lib.nativeDpi) * CM_PER_INCH;
    return nativeCm * entry.scale;
  });
  const maxLongestCm = Math.max(0.0001, ...physicalLongestCm);

  return (
    <div className="flex flex-col gap-2">
      {selection.map((entry, i) => {
        const lib = libMap.get(entry.id);
        if (!lib) return null;
        const ps = pack.result?.perSticker[entry.id];
        // `ps` comes from the most recently COMPLETED pack run. If the user
        // has since edited the quantity (or a new pack is still in flight)
        // the displayed placed/requested will mismatch the current input,
        // which is confusing. Treat those cases as "no result yet" and fall
        // back to the cm readout instead of showing stale numbers.
        const isStale =
          pack.loading || (!!ps && ps.requested !== entry.quantity);
        const psLive = isStale ? undefined : ps;
        const shortfall = psLive ? psLive.requested - psLive.placed : 0;
        const hasShortfall = !!psLive && shortfall > 0;

        const longestCm = physicalLongestCm[i];
        const thumbPx = Math.max(
          MIN_THUMB,
          (longestCm / maxLongestCm) * MAX_THUMB,
        );
        const effWcm =
          (lib.bitmap.width / lib.nativeDpi) * CM_PER_INCH * entry.scale;
        const effHcm =
          (lib.bitmap.height / lib.nativeDpi) * CM_PER_INCH * entry.scale;

        return (
          <div
            key={entry.id}
            className={cn(
              "rounded-md border bg-neutral-900 p-2 transition-colors",
              hasShortfall ? "border-amber-600/60" : "border-neutral-800",
            )}
          >
            <div className="flex items-start gap-3">
              <div
                className="checker flex shrink-0 items-center justify-center overflow-hidden rounded"
                style={{ width: MAX_THUMB, height: MAX_THUMB }}
                title={`${lib.name} @ ${effWcm.toFixed(2)}×${effHcm.toFixed(2)} cm`}
              >
                <img
                  src={lib.thumbUrl}
                  alt=""
                  className="object-contain"
                  style={{
                    width: thumbPx,
                    height: thumbPx,
                    transition: "width 120ms ease-out, height 120ms ease-out",
                  }}
                />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1 truncate text-xs text-neutral-200">
                    {lib.name}
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemove(entry.id)}
                    aria-label="Remove"
                    className="shrink-0 text-neutral-500 hover:text-red-400"
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <div
                  className={cn(
                    "mt-0.5 text-[11px] tabular-nums",
                    hasShortfall ? "text-amber-400" : "text-neutral-500",
                  )}
                >
                  {psLive
                    ? hasShortfall
                      ? `placed ${psLive.placed} / ${psLive.requested} · ${shortfall} unplaced`
                      : `placed ${psLive.placed} / ${psLive.requested}`
                    : `${effWcm.toFixed(2)}×${effHcm.toFixed(2)} cm${pack.loading ? " · packing…" : ""}`}
                </div>

                <div className="mt-2 flex items-center gap-1.5">
                  <span className="w-8 shrink-0 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                    Qty
                  </span>
                  <button
                    type="button"
                    onClick={() => onBumpQty(entry.id, -1)}
                    aria-label="Decrease"
                    className="flex size-6 items-center justify-center rounded border border-neutral-800 bg-neutral-950 text-neutral-300 hover:bg-neutral-800"
                  >
                    <Minus className="size-3" />
                  </button>
                  <input
                    type="number"
                    value={entry.quantity}
                    onChange={(e) =>
                      onSetQty(entry.id, parseInt(e.target.value) || 0)
                    }
                    className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-right text-xs tabular-nums"
                    min={0}
                    aria-label="Quantity"
                  />
                  <button
                    type="button"
                    onClick={() => onBumpQty(entry.id, 1)}
                    aria-label="Increase"
                    className="flex size-6 items-center justify-center rounded border border-neutral-800 bg-neutral-950 text-neutral-300 hover:bg-neutral-800"
                  >
                    <Plus className="size-3" />
                  </button>
                </div>

                <div className="mt-1.5 flex items-center gap-2">
                  <span className="w-8 shrink-0 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                    Size
                  </span>
                  <input
                    type="range"
                    min={0.25}
                    max={3}
                    step={0.05}
                    value={entry.scale}
                    onChange={(e) =>
                      onSetScale(entry.id, parseFloat(e.target.value))
                    }
                    onDoubleClick={() => onSetScale(entry.id, 1)}
                    className="h-1 flex-1 cursor-pointer accent-neutral-100"
                    aria-label="Scale"
                  />
                  <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-neutral-400">
                    {entry.scale.toFixed(2)}×
                  </span>
                </div>
                <div className="text-right text-[10px] tabular-nums text-neutral-600">
                  native {lib.nativeDpi} dpi · native{" "}
                  {pxToCm(lib.bitmap.width, lib.nativeDpi).toFixed(2)}×
                  {pxToCm(lib.bitmap.height, lib.nativeDpi).toFixed(2)} cm
                  {lib.source === "psd" ? " · psd" : ""}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ======================================================================
// Gallery modal
// ======================================================================

function GalleryModal({
  library,
  selection,
  onClose,
  onBump,
  onRemoveSelection,
  onRemoveFromLibrary,
  onClearLibrary,
  onFilesSelected,
  importing,
}: {
  library: LibrarySticker[];
  selection: SelectionEntry[];
  onClose: () => void;
  onBump: (id: string, delta: number) => void;
  onRemoveSelection: (id: string) => void;
  onRemoveFromLibrary: (id: string) => void;
  onClearLibrary: () => void;
  onFilesSelected: (files: FileList | File[]) => void;
  importing: boolean;
}) {
  const [q, setQ] = useState("");
  const selMap = useMemo(
    () => new Map(selection.map((s) => [s.id, s])),
    [selection],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return library;
    return library.filter((l) => l.name.toLowerCase().includes(needle));
  }, [library, q]);

  // Group by PSD file name if present.
  const groups = useMemo(() => {
    const map = new Map<string, LibrarySticker[]>();
    for (const l of filtered) {
      const key = l.groupName ?? "Standalone";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(l);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur"
      onClick={onClose}
    >
      <div
        className="flex h-[86dvh] w-[min(1200px,94vw)] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-neutral-800 px-5 py-3">
          <div className="flex size-8 items-center justify-center rounded-md bg-neutral-800">
            <Images className="size-4" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold">Sticker library</div>
            <div className="text-xs text-neutral-400">
              {library.length} stickers ·{" "}
              {selection.reduce((a, s) => a + s.quantity, 0)} in selection
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-neutral-500" />
              <input
                type="search"
                placeholder="Search…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-56 rounded-md border border-neutral-800 bg-neutral-900 py-1.5 pl-7 pr-2 text-xs focus:border-neutral-600 focus:outline-none"
                aria-label="Search stickers"
              />
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/*,.psd,.psb"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) onFilesSelected(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="flex items-center gap-1.5 rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {importing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              Import PNG / PSD
            </button>
            {library.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Remove all ${library.length} stickers?`))
                    onClearLibrary();
                }}
                className="flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
              >
                <Trash2 className="size-3" />
                Clear
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex size-8 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            >
              <X className="size-4" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {library.length === 0 ? (
            <EmptyLibrary
              onImport={() => fileInputRef.current?.click()}
              importing={importing}
            />
          ) : (
            <div className="flex flex-col gap-6">
              {groups.map(([groupName, items]) => (
                <section key={groupName}>
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                    {groupName}
                    <span className="ml-2 text-neutral-600">
                      {items.length}
                    </span>
                  </h3>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
                    {items.map((l) => (
                      <GalleryCard
                        key={l.id}
                        lib={l}
                        selectionEntry={selMap.get(l.id)}
                        onBump={onBump}
                        onRemoveSelection={onRemoveSelection}
                        onRemoveFromLibrary={onRemoveFromLibrary}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GalleryCard({
  lib,
  selectionEntry,
  onBump,
  onRemoveSelection,
  onRemoveFromLibrary,
}: {
  lib: LibrarySticker;
  selectionEntry: SelectionEntry | undefined;
  onBump: (id: string, delta: number) => void;
  onRemoveSelection: (id: string) => void;
  onRemoveFromLibrary: (id: string) => void;
}) {
  const selected = !!selectionEntry;
  const qty = selectionEntry?.quantity ?? 0;
  const nativeWcm = pxToCm(lib.bitmap.width, lib.nativeDpi);
  const nativeHcm = pxToCm(lib.bitmap.height, lib.nativeDpi);
  return (
    <div
      className={cn(
        "group relative flex cursor-pointer flex-col overflow-hidden rounded-md border bg-neutral-900 transition-colors",
        selected
          ? "border-emerald-500/60 ring-2 ring-emerald-500/30"
          : "border-neutral-800 hover:border-neutral-600",
      )}
      onClick={() => onBump(lib.id, 1)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onBump(lib.id, 1);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="checker relative aspect-square w-full">
        <img
          src={lib.thumbUrl}
          alt={lib.name}
          className="absolute inset-0 size-full object-contain p-2"
          draggable={false}
        />
        {selected ? (
          <div className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-full bg-emerald-500 px-2 py-0.5 text-[11px] font-semibold text-neutral-950 shadow-lg">
            ×{qty}
          </div>
        ) : null}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemoveFromLibrary(lib.id);
          }}
          aria-label="Delete from library"
          className="absolute left-1.5 top-1.5 hidden size-6 items-center justify-center rounded-full bg-neutral-950/80 text-neutral-400 hover:bg-red-500 hover:text-white group-hover:flex"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
      <div className="flex flex-col gap-1 p-2">
        <div
          className="truncate text-[11px] text-neutral-200"
          title={lib.name}
        >
          {lib.name.split(" / ").slice(-1)[0]}
        </div>
        <div className="text-[10px] tabular-nums text-neutral-500">
          {nativeWcm.toFixed(2)}×{nativeHcm.toFixed(2)} cm · {lib.nativeDpi}dpi
        </div>
        {selected ? (
          <div className="mt-1 flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onBump(lib.id, -1);
              }}
              aria-label="Decrease quantity"
              className="flex size-6 items-center justify-center rounded border border-neutral-800 bg-neutral-950 text-neutral-300 hover:bg-neutral-800"
            >
              <Minus className="size-3" />
            </button>
            <div className="flex-1 text-center text-xs font-semibold tabular-nums text-neutral-100">
              {qty}
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onBump(lib.id, 1);
              }}
              aria-label="Increase quantity"
              className="flex size-6 items-center justify-center rounded border border-neutral-800 bg-neutral-950 text-neutral-300 hover:bg-neutral-800"
            >
              <Plus className="size-3" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveSelection(lib.id);
              }}
              aria-label="Remove from selection"
              className="flex size-6 items-center justify-center rounded border border-neutral-800 bg-neutral-950 text-neutral-400 hover:bg-red-500 hover:text-white"
            >
              <X className="size-3" />
            </button>
          </div>
        ) : (
          <div className="mt-1 text-center text-[10px] text-neutral-500">
            Click to add
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyLibrary({
  onImport,
  importing,
}: {
  onImport: () => void;
  importing: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-neutral-900 ring-1 ring-neutral-800">
        <Upload className="size-6 text-neutral-400" />
      </div>
      <div>
        <div className="text-sm font-medium">Your library is empty</div>
        <p className="mt-1 max-w-sm text-pretty text-xs text-neutral-500">
          Drop PNG files or a Photoshop{" "}
          <span className="font-semibold text-neutral-300">.psd</span> — every
          layer becomes its own sticker.
        </p>
      </div>
      <button
        type="button"
        onClick={onImport}
        disabled={importing}
        className="flex items-center gap-2 rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-60"
      >
        {importing ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Upload className="size-4" />
        )}
        Import files
      </button>
    </div>
  );
}

// ======================================================================
// Unplaced summary
// ======================================================================

function UnplacedSummary({
  pack,
  selection,
  libMap,
}: {
  pack: PackState;
  selection: SelectionEntry[];
  libMap: Map<string, LibrarySticker>;
}) {
  if (!pack.result) return null;
  const items = selection
    .map((s) => {
      const ps = pack.result?.perSticker[s.id];
      const lib = libMap.get(s.id);
      if (!ps || !lib) return null;
      const short = ps.requested - ps.placed;
      if (short <= 0) return null;
      return { lib, short };
    })
    .filter((x): x is { lib: LibrarySticker; short: number } => x !== null);
  if (items.length === 0) return null;
  const totalShort = items.reduce((acc, it) => acc + it.short, 0);
  return (
    <div className="mb-3 rounded-md border border-amber-600/40 bg-amber-950/30 p-2.5">
      <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-amber-300">
        <span>Unplaced</span>
        <span className="tabular-nums">{totalShort}</span>
      </div>
      <div className="flex flex-col gap-1">
        {items.map(({ lib, short }) => (
          <div
            key={lib.id}
            className="flex items-center gap-2 text-[11px] text-amber-200"
          >
            <img
              src={lib.thumbUrl}
              alt=""
              className="size-5 shrink-0 rounded object-contain"
            />
            <span className="min-w-0 flex-1 truncate">{lib.name}</span>
            <span className="tabular-nums">×{short}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ======================================================================
// Preview pane
// ======================================================================

function PreviewPane({
  pack,
  canvasWcm,
  canvasHcm,
  canvasPadPx,
  selection,
  library,
  onBumpQty,
}: {
  pack: PackState;
  canvasWcm: number;
  canvasHcm: number;
  canvasPadPx: { left: number; right: number; top: number; bottom: number };
  selection: SelectionEntry[];
  library: LibrarySticker[];
  onBumpQty: (id: string, delta: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = pack.canvasWidthPx;
    c.height = pack.canvasHeightPx;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (pack.result) {
      drawPlacements(ctx, pack.result.placements, pack.variantBitmaps);
    }
    // Depends on `variantBitmaps` too so streaming `variants` messages
    // trigger a redraw once the first `partial` result lands.
  }, [
    pack.result,
    pack.variantBitmaps,
    pack.canvasWidthPx,
    pack.canvasHeightPx,
  ]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      const pad = 48;
      const sx = (rect.width - pad) / pack.canvasWidthPx;
      const sy = (rect.height - pad) / pack.canvasHeightPx;
      setScale(Math.min(1, sx, sy));
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [pack.canvasWidthPx, pack.canvasHeightPx]);

  return (
    <div
      ref={wrapRef}
      className="relative flex h-full flex-1 items-center justify-center overflow-hidden bg-neutral-900"
    >
      <div
        className="checker relative shadow-2xl ring-1 ring-neutral-800"
        style={{
          width: pack.canvasWidthPx * scale,
          height: pack.canvasHeightPx * scale,
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            width: pack.canvasWidthPx * scale,
            height: pack.canvasHeightPx * scale,
          }}
        />
        {canvasPadPx.left > 0 ||
        canvasPadPx.right > 0 ||
        canvasPadPx.top > 0 ||
        canvasPadPx.bottom > 0 ? (
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-sm border border-dashed border-sky-400/70"
            style={{
              left: canvasPadPx.left * scale,
              top: canvasPadPx.top * scale,
              right: canvasPadPx.right * scale,
              bottom: canvasPadPx.bottom * scale,
            }}
          />
        ) : null}
      </div>
      <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-3 rounded-md bg-neutral-950/80 px-3 py-1.5 text-xs text-neutral-300 backdrop-blur">
        <span className="tabular-nums">
          {canvasWcm.toFixed(1)} × {canvasHcm.toFixed(1)} cm
        </span>
        <span className="text-neutral-600">·</span>
        <span className="tabular-nums">
          {pack.canvasWidthPx} × {pack.canvasHeightPx} px
        </span>
        <span className="text-neutral-600">·</span>
        <span className="tabular-nums">{Math.round(scale * 100)}%</span>
        {pack.loading ? (
          <>
            <span className="text-neutral-600">·</span>
            <Loader2 className="size-3 animate-spin" />
            <span>packing…</span>
          </>
        ) : null}
      </div>
      <SuggestionDrawer
        pack={pack}
        selection={selection}
        library={library}
        onBumpQty={onBumpQty}
      />
    </div>
  );
}

// ======================================================================
// Suggestion drawer
// ======================================================================

/**
 * Slides up from the bottom of the preview pane when the packer has
 * finished and there is still room on the canvas for more copies of the
 * user's selected stickers. Each card shows the exact number of extras
 * that would fit, plus a quick button to bump the quantity by 1 or add
 * them all.
 */
function SuggestionDrawer({
  pack,
  selection,
  library,
  onBumpQty,
}: {
  pack: PackState;
  selection: SelectionEntry[];
  library: LibrarySticker[];
  onBumpQty: (id: string, delta: number) => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(true);

  // Re-open when a new result arrives with suggestions (user may have
  // dismissed a previous run's drawer — show them the fresh one).
  const resultKey = pack.result
    ? `${pack.result.placed}/${pack.result.requested}`
    : "";
  useEffect(() => {
    setDismissed(false);
    setOpen(true);
  }, [resultKey]);

  if (!pack.result || pack.loading || dismissed) return null;

  const libMap = new Map(library.map((l) => [l.id, l]));
  const selIds = new Set(selection.map((s) => s.id));
  const suggestions = Object.entries(pack.result.extraFits)
    .filter(([id, n]) => n > 0 && selIds.has(id) && libMap.has(id))
    .sort((a, b) => b[1] - a[1]);

  if (suggestions.length === 0) return null;

  const total = suggestions.reduce((acc, [, n]) => acc + n, 0);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        <div className="pointer-events-auto overflow-hidden rounded-lg border border-emerald-500/40 bg-neutral-950/95 shadow-2xl ring-1 ring-emerald-500/20 backdrop-blur">
          <div className="flex w-full items-center gap-3 px-4 py-2.5">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="flex flex-1 items-center gap-3 text-left"
              aria-expanded={open}
            >
              <div className="flex size-7 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-300">
                <Plus className="size-4" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-emerald-100">
                  Room for {total} more sticker{total === 1 ? "" : "s"}
                </div>
                <div className="text-[11px] text-neutral-400">
                  Click any card to add one. The packer will re-run and you
                  can keep adding until it reports a tight fit.
                </div>
              </div>
              <span
                className={cn(
                  "text-xs text-neutral-500 transition-transform",
                  open ? "rotate-180" : "rotate-0",
                )}
                aria-hidden
              >
                ▾
              </span>
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              aria-label="Dismiss suggestions"
              className="flex size-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            >
              <X className="size-4" />
            </button>
          </div>
          {open ? (
            <div className="border-t border-neutral-800 p-3">
              <div className="flex gap-2 overflow-x-auto pb-1">
                {suggestions.map(([id, n]) => {
                  const lib = libMap.get(id);
                  if (!lib) return null;
                  return (
                    <div
                      key={id}
                      className="flex w-[148px] shrink-0 flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-900 p-2"
                    >
                      <div className="checker flex aspect-square items-center justify-center overflow-hidden rounded">
                        <img
                          src={lib.thumbUrl}
                          alt=""
                          className="size-full object-contain p-1"
                        />
                      </div>
                      <div
                        className="truncate text-[11px] text-neutral-200"
                        title={lib.name}
                      >
                        {lib.name.split(" / ").slice(-1)[0]}
                      </div>
                      <div className="text-[10px] font-medium uppercase tracking-wide text-emerald-400">
                        +{n} fit
                      </div>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => onBumpQty(id, 1)}
                          className="flex-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/20"
                        >
                          +1
                        </button>
                        <button
                          type="button"
                          onClick={() => onBumpQty(id, n)}
                          className="flex-1 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700"
                        >
                          +{n}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ======================================================================
// Tiny controls
// ======================================================================

function Section({
  title,
  children,
  right,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <section className="border-b border-neutral-800 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          {title}
        </h3>
        {right}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-neutral-300">{label}</div>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = parseInt(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm tabular-nums focus:border-neutral-500 focus:outline-none"
      />
    </label>
  );
}

function CmField({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.1,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-neutral-300">{label}</div>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm tabular-nums focus:border-neutral-500 focus:outline-none"
      />
    </label>
  );
}

function CanvasPaddingControls({
  padMm,
  linked,
  onChange,
  onLinkedChange,
}: {
  padMm: CanvasPaddingMm;
  linked: boolean;
  onChange: (side: keyof CanvasPaddingMm, value: number) => void;
  onLinkedChange: (linked: boolean) => void;
}) {
  const sides: {
    key: keyof CanvasPaddingMm;
    label: string;
  }[] = [
    { key: "top", label: "Top" },
    { key: "right", label: "Right" },
    { key: "bottom", label: "Bottom" },
    { key: "left", label: "Left" },
  ];
  const anyActive =
    padMm.top > 0 || padMm.right > 0 || padMm.bottom > 0 || padMm.left > 0;
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/60 p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-neutral-300">
          Canvas margin (mm)
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
            <input
              type="checkbox"
              checked={linked}
              onChange={(e) => onLinkedChange(e.target.checked)}
              className="size-3 accent-neutral-100"
            />
            Link all
          </label>
          {anyActive ? (
            <button
              type="button"
              onClick={() => onChange("top", 0)}
              className="rounded border border-neutral-800 bg-neutral-950 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              aria-label="Reset margins"
            >
              Reset
            </button>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {sides.map((s) => {
          const v = padMm[s.key];
          return (
            <div key={s.key} className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-[11px] text-neutral-400">
                {s.label}
              </span>
              <input
                type="range"
                min={0}
                max={MAX_CANVAS_PAD_MM}
                step={0.5}
                value={v}
                onChange={(e) => onChange(s.key, parseFloat(e.target.value))}
                onDoubleClick={() => onChange(s.key, 0)}
                className="h-1 flex-1 cursor-pointer accent-neutral-100"
                aria-label={`${s.label} margin (mm)`}
              />
              <input
                type="number"
                min={0}
                max={MAX_CANVAS_PAD_MM}
                step={0.5}
                value={v}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  if (!Number.isNaN(n)) onChange(s.key, n);
                }}
                className="w-14 shrink-0 rounded border border-neutral-800 bg-neutral-950 px-1.5 py-0.5 text-right text-[11px] tabular-nums focus:border-neutral-500 focus:outline-none"
                aria-label={`${s.label} margin value`}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PresetButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 rounded border px-2 py-1 text-[11px] transition-colors",
        active
          ? "border-neutral-100 bg-neutral-100 text-neutral-900"
          : "border-neutral-800 bg-neutral-900 text-neutral-300 hover:bg-neutral-800",
      )}
    >
      {label}
    </button>
  );
}

function QuickImportButton({
  onFilesSelected,
  importing,
}: {
  onFilesSelected: (files: FileList | File[]) => void;
  importing: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="image/png,image/*,.psd,.psb"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) onFilesSelected(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => ref.current?.click()}
        disabled={importing}
        className="flex items-center gap-2 rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-white disabled:opacity-60"
      >
        {importing ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Upload className="size-3" />
        )}
        Import PNG / PSD
      </button>
    </>
  );
}

// unused but kept to silence tree-shake concerns for lucide imports in shared helpers
void RotateCcw;

// ======================================================================
// Rendering / scaling helpers
// ======================================================================

/**
 * Produce a resized `ImageBitmap` at a given multiplier of the source. Used
 * to convert a sticker's native-DPI bitmap into canvas-DPI pixels before
 * packing. factor = scale * (canvasDpi / nativeDpi).
 */
async function rasterizeAtFactor(
  bitmap: ImageBitmap,
  factor: number,
): Promise<ImageBitmap> {
  if (!Number.isFinite(factor) || Math.abs(factor - 1) < 1e-3) {
    return createImageBitmap(bitmap);
  }
  const w = Math.max(1, Math.round(bitmap.width * factor));
  const h = Math.max(1, Math.round(bitmap.height * factor));
  const off = new OffscreenCanvas(w, h);
  const ctx = off.getContext("2d");
  if (!ctx) return createImageBitmap(bitmap);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  return off.transferToImageBitmap();
}

function drawPlacements(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  placements: Placement[],
  variantBitmaps: Record<string, ImageBitmap[]>,
) {
  for (const p of placements) {
    const variants = variantBitmaps[p.stickerId];
    if (!variants) continue;
    const bmp = variants[p.variantIdx];
    if (!bmp) continue;
    ctx.drawImage(bmp, p.x, p.y, p.width, p.height);
  }
}

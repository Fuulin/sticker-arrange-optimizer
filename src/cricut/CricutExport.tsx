import { useEffect, useMemo, useRef, useState } from "react";
import type { PackResult, Placement } from "../packer/types";
import {
  tileCanvas,
  assignPlacementsToTiles,
  placementFitsInTile,
  type Tile,
} from "./tiles";
import { bitmapToContours, type Polyline } from "./contour";

export interface CricutExportProps {
  result: PackResult;
  variantBitmaps: Record<string, ImageBitmap[]>;
  canvasWidthPx: number;
  canvasHeightPx: number;
  dpi: number;
  onBack: () => void;
}

const INCH_PER_MM = 1 / 25.4;
const PTC_IN = { w: 9.25, h: 6.75 };

function mmToPx(mm: number, dpi: number): number {
  return Math.max(0, Math.round(mm * INCH_PER_MM * dpi));
}

export function CricutExport(props: CricutExportProps) {
  const [bleedMm, setBleedMm] = useState(1);
  const [showCut, setShowCut] = useState(true);
  const [showGrid, setShowGrid] = useState(true);

  const tileWpx = useMemo(
    () => mmToPx(PTC_IN.w * 25.4, props.dpi),
    [props.dpi],
  );
  const tileHpx = useMemo(
    () => mmToPx(PTC_IN.h * 25.4, props.dpi),
    [props.dpi],
  );
  const tiles = useMemo(
    () =>
      tileCanvas(
        props.canvasWidthPx,
        props.canvasHeightPx,
        tileWpx,
        tileHpx,
      ),
    [props.canvasWidthPx, props.canvasHeightPx, tileWpx, tileHpx],
  );

  const assignment = useMemo(
    () => assignPlacementsToTiles(props.result.placements, tiles),
    [props.result.placements, tiles],
  );

  const overhanging = useMemo(() => {
    const out = new Set<Placement>();
    for (let i = 0; i < tiles.length; i++) {
      const list = assignment.get(i) ?? [];
      for (const p of list) {
        if (!placementFitsInTile(p, tiles[i])) out.add(p);
      }
    }
    return out;
  }, [assignment, tiles]);

  const [contours, setContours] = useState<Map<Placement, Polyline[]>>(
    new Map(),
  );
  const [computing, setComputing] = useState(false);

  // Debounced contour recompute on bleed/placement changes.
  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setComputing(true);
      const next = new Map<Placement, Polyline[]>();
      const bleedPx = mmToPx(bleedMm, props.dpi);
      const simpTol = Math.max(1, Math.round((0.3 / 25.4) * props.dpi));
      for (const p of props.result.placements) {
        if (cancelled) break;
        const variants = props.variantBitmaps[p.stickerId];
        const bmp = variants?.[p.variantIdx];
        if (!bmp) continue;
        const sx = p.width / bmp.width;
        const sy = p.height / bmp.height;
        // NOTE: the packer's alpha threshold is not currently threaded
        // through to the Cricut view. Use 16 (the existing default) as a
        // fixed value; if this becomes user-configurable later it can be
        // surfaced as a prop.
        const raw = bitmapToContours(bmp, 16, bleedPx, simpTol);
        const scaled = raw.map((poly) =>
          poly.map((pt) => ({ x: pt.x * sx, y: pt.y * sy })),
        );
        next.set(p, scaled);
      }
      if (!cancelled) {
        setContours(next);
        setComputing(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
      setComputing(false);
    };
  }, [bleedMm, props.result.placements, props.variantBitmaps, props.dpi]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  // Fit-to-viewport.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      const pad = 48;
      const sx = (rect.width - pad) / props.canvasWidthPx;
      const sy = (rect.height - pad) / props.canvasHeightPx;
      setScale(Math.min(1, sx, sy));
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [props.canvasWidthPx, props.canvasHeightPx]);

  // Draw print layer.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = props.canvasWidthPx;
    c.height = props.canvasHeightPx;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    for (const p of props.result.placements) {
      const variants = props.variantBitmaps[p.stickerId];
      const bmp = variants?.[p.variantIdx];
      if (!bmp) continue;
      ctx.drawImage(bmp, p.x, p.y, p.width, p.height);
    }
  }, [props.result, props.variantBitmaps, props.canvasWidthPx, props.canvasHeightPx]);

  const totalPlaced = props.result.placements.length;

  return (
    <div className="flex h-dvh w-full flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-5 py-3">
        <button
          type="button"
          onClick={props.onBack}
          className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs hover:bg-neutral-800"
        >
          ← Back
        </button>
        <div className="text-sm font-semibold">Cricut Export</div>
        <div className="ml-auto text-xs text-neutral-400 tabular-nums">
          {tiles.length} tile{tiles.length === 1 ? "" : "s"} · {totalPlaced}{" "}
          sticker{totalPlaced === 1 ? "" : "s"}
          {overhanging.size > 0 ? (
            <span className="ml-2 text-amber-400">
              · {overhanging.size} over boundary
            </span>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Controls */}
        <aside className="flex w-[260px] shrink-0 flex-col gap-4 border-r border-neutral-800 bg-neutral-950 p-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-300">
              Bleed: {bleedMm.toFixed(1)} mm
            </label>
            <input
              type="range"
              min={0}
              max={5}
              step={0.1}
              value={bleedMm}
              onChange={(e) => setBleedMm(Number(e.target.value))}
              className="w-full"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-neutral-300">
            <input
              type="checkbox"
              checked={showCut}
              onChange={(e) => setShowCut(e.target.checked)}
            />
            Show cut lines
          </label>
          <label className="flex items-center gap-2 text-xs text-neutral-300">
            <input
              type="checkbox"
              checked={showGrid}
              onChange={(e) => setShowGrid(e.target.checked)}
            />
            Show tile grid
          </label>
          <button
            type="button"
            disabled
            className="mt-auto flex w-full items-center justify-center gap-2 rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
          >
            Download {tiles.length === 1 ? ".svg" : `.zip (${tiles.length} files)`}
          </button>
        </aside>

        {/* Preview */}
        <div
          ref={wrapRef}
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-neutral-900"
        >
          {computing ? (
            <div className="absolute right-4 top-4 rounded-md bg-neutral-800/80 px-2 py-1 text-[11px] text-neutral-300">
              Recomputing cut lines…
            </div>
          ) : null}
          <div
            className="relative shadow-2xl ring-1 ring-neutral-800"
            style={{
              width: props.canvasWidthPx * scale,
              height: props.canvasHeightPx * scale,
            }}
          >
            <canvas
              ref={canvasRef}
              style={{
                width: props.canvasWidthPx * scale,
                height: props.canvasHeightPx * scale,
              }}
            />
            {/* Overlays drawn in Task 8. */}
            <OverlaySvg
              canvasWidthPx={props.canvasWidthPx}
              canvasHeightPx={props.canvasHeightPx}
              scale={scale}
              tiles={tiles}
              placements={props.result.placements}
              overhanging={overhanging}
              showCut={showCut}
              showGrid={showGrid}
              contours={contours}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function OverlaySvg(props: {
  canvasWidthPx: number;
  canvasHeightPx: number;
  scale: number;
  tiles: Tile[];
  placements: Placement[];
  overhanging: Set<Placement>;
  showCut: boolean;
  showGrid: boolean;
  contours: Map<Placement, Polyline[]>;
}) {
  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={props.canvasWidthPx * props.scale}
      height={props.canvasHeightPx * props.scale}
      viewBox={`0 0 ${props.canvasWidthPx} ${props.canvasHeightPx}`}
      preserveAspectRatio="none"
    >
      {props.showGrid ? (
        <g stroke="#3b82f6" strokeWidth={4} fill="none" opacity={0.8}>
          {props.tiles.map((t, i) => (
            <rect
              key={i}
              x={t.x}
              y={t.y}
              width={t.width}
              height={t.height}
            />
          ))}
        </g>
      ) : null}

      {props.showCut ? (
        <g
          stroke="#ef4444"
          strokeWidth={Math.max(1, 2 / props.scale)}
          fill="none"
          vectorEffect="non-scaling-stroke"
        >
          {props.placements.map((p, i) => {
            const polys = props.contours.get(p);
            if (!polys) return null;
            return polys.map((poly, j) => {
              if (!poly.length) return null;
              const d =
                `M ${poly[0].x + p.x} ${poly[0].y + p.y} ` +
                poly
                  .slice(1)
                  .map((pt) => `L ${pt.x + p.x} ${pt.y + p.y}`)
                  .join(" ") +
                " Z";
              return <path key={`${i}-${j}`} d={d} />;
            });
          })}
        </g>
      ) : null}

      <g
        stroke="#eab308"
        strokeWidth={Math.max(2, 3 / props.scale)}
        fill="none"
        vectorEffect="non-scaling-stroke"
        strokeDasharray="8 4"
      >
        {props.placements
          .filter((p) => props.overhanging.has(p))
          .map((p, i) => (
            <rect
              key={i}
              x={p.x}
              y={p.y}
              width={p.width}
              height={p.height}
            />
          ))}
      </g>
    </svg>
  );
}

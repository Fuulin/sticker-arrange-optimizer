import { readPsd, type Layer, type Psd } from "ag-psd";
import { CM_PER_INCH } from "./units";

export interface LibrarySticker {
  id: string;
  name: string;
  bitmap: ImageBitmap;
  /** Preview URL (object URL) for thumbnails. */
  thumbUrl: string;
  /**
   * DPI the bitmap was authored at. For standalone PNGs, this falls back to
   * the `fallbackDpi` passed to `importFiles`. For PSD layers, this is the
   * document's horizontal resolution (if the PSD declares it).
   */
  nativeDpi: number;
  /** Short provenance label shown in the gallery. */
  source: "png" | "psd";
  /** Name of the containing PSD when applicable, for grouping. */
  groupName?: string;
}

/** Walk a PSD's layer tree, collecting raster leaves (skipping groups). */
function collectLayers(
  layers: Layer[] | undefined,
  out: Layer[],
  pathPrefix: string[] = [],
) {
  if (!layers) return;
  for (const l of layers) {
    if (l.hidden) continue;
    if (l.children && l.children.length) {
      collectLayers(l.children, out, [...pathPrefix, l.name ?? "group"]);
    } else if (l.canvas) {
      // Stash the path so we can build a friendly name.
      (l as Layer & { __path?: string[] }).__path = pathPrefix;
      out.push(l);
    }
  }
}

function psdResolution(psd: Psd): number | null {
  const r = psd.imageResources?.resolutionInfo;
  if (!r) return null;
  // unit 1 = PPI, unit 2 = PPCM (rare).
  if (r.horizontalResolutionUnit === "PPI") return r.horizontalResolution;
  if (r.horizontalResolutionUnit === "PPCM") return r.horizontalResolution * CM_PER_INCH;
  // Fallback: assume PPI.
  return r.horizontalResolution;
}

async function canvasToBitmap(
  canvas: HTMLCanvasElement,
): Promise<ImageBitmap | null> {
  if (canvas.width <= 0 || canvas.height <= 0) return null;
  return createImageBitmap(canvas);
}

async function canvasToThumbUrl(canvas: HTMLCanvasElement): Promise<string> {
  return canvas.toDataURL("image/png");
}

export async function importFiles(
  files: FileList | File[],
  fallbackDpi: number,
): Promise<LibrarySticker[]> {
  const out: LibrarySticker[] = [];
  for (const file of Array.from(files)) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".psd") || lower.endsWith(".psb")) {
      try {
        const buf = await file.arrayBuffer();
        const psd = readPsd(buf);
        const dpi = psdResolution(psd) ?? fallbackDpi;
        const leaves: Layer[] = [];
        collectLayers(psd.children, leaves);
        const docName = file.name.replace(/\.psd$|\.psb$/i, "");
        for (const layer of leaves) {
          const c = layer.canvas;
          if (!c) continue;
          const bmp = await canvasToBitmap(c);
          if (!bmp) continue;
          const thumbUrl = await canvasToThumbUrl(c);
          const path = (layer as Layer & { __path?: string[] }).__path ?? [];
          const name = [docName, ...path, layer.name ?? "layer"].join(" / ");
          out.push({
            id: crypto.randomUUID(),
            name,
            bitmap: bmp,
            thumbUrl,
            nativeDpi: dpi,
            source: "psd",
            groupName: docName,
          });
        }
      } catch (err) {
        console.error("Failed to parse PSD", file.name, err);
      }
    } else if (file.type.startsWith("image/")) {
      try {
        const bmp = await createImageBitmap(file);
        const thumbUrl = URL.createObjectURL(file);
        out.push({
          id: crypto.randomUUID(),
          name: file.name,
          bitmap: bmp,
          thumbUrl,
          nativeDpi: fallbackDpi,
          source: "png",
        });
      } catch (err) {
        console.error("Failed to load image", file.name, err);
      }
    }
  }
  return out;
}

export function disposeLibrarySticker(s: LibrarySticker) {
  try {
    s.bitmap.close();
  } catch {
    /* ignore */
  }
  if (s.thumbUrl.startsWith("blob:")) URL.revokeObjectURL(s.thumbUrl);
}

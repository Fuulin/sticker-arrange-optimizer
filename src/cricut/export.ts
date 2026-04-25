import JSZip from "jszip";
import type { Placement } from "../packer/types";
import { CRICUT_PTC_IN, INCH_PER_MM, mmToPx } from "../lib/units";
import { bitmapToContours, type Polyline } from "./contour";
import {
  assignPlacementsToTiles,
  tileCanvas,
  type Tile,
} from "./tiles";

export interface BuildExportInput {
  placements: Placement[];
  variantBitmaps: Record<string, ImageBitmap[]>;
  canvasWidthPx: number;
  canvasHeightPx: number;
  dpi: number;
  bleedMm: number;
  alphaThreshold: number;
  /** When true, tiles with no placements assigned are excluded from the
   * export bundle. */
  skipEmptyTiles?: boolean;
  /** Tile size in canvas pixels. Default = 9.25" × 6.75" at `dpi`. */
  tileWidthPx?: number;
  tileHeightPx?: number;
}

function simplifyTolerancePx(dpi: number): number {
  // ~0.3 mm of tolerance.
  return Math.max(1, Math.round(0.3 * INCH_PER_MM * dpi));
}

/** Render a tile's print layer to a PNG data URL. */
async function renderTilePng(
  tile: Tile,
  placements: Placement[],
  variantBitmaps: Record<string, ImageBitmap[]>,
): Promise<string> {
  const c = new OffscreenCanvas(tile.width, tile.height);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  ctx.clearRect(0, 0, tile.width, tile.height);
  for (const p of placements) {
    const variants = variantBitmaps[p.stickerId];
    if (!variants) continue;
    const bmp = variants[p.variantIdx];
    if (!bmp) continue;
    // Draw in tile-local coordinates.
    ctx.drawImage(bmp, p.x - tile.x, p.y - tile.y, p.width, p.height);
  }
  const blob = await c.convertToBlob({ type: "image/png" });
  return blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function polylineToPathD(points: Polyline, offsetX = 0, offsetY = 0): string {
  if (!points.length) return "";
  const parts: string[] = [];
  parts.push(`M ${points[0].x + offsetX} ${points[0].y + offsetY}`);
  for (let i = 1; i < points.length; i++) {
    parts.push(`L ${points[i].x + offsetX} ${points[i].y + offsetY}`);
  }
  parts.push("Z");
  return parts.join(" ");
}

/** Assemble one tile's SVG string. */
async function buildTileSvg(
  tile: Tile,
  placements: Placement[],
  variantBitmaps: Record<string, ImageBitmap[]>,
  bleedMm: number,
  alphaThreshold: number,
  dpi: number,
): Promise<string> {
  const pngUrl = await renderTilePng(tile, placements, variantBitmaps);
  const bleedPx = mmToPx(bleedMm, dpi);
  const simpTol = simplifyTolerancePx(dpi);

  const cutPaths: string[] = [];
  for (const p of placements) {
    const variants = variantBitmaps[p.stickerId];
    const bmp = variants?.[p.variantIdx];
    if (!bmp) continue;
    const contours = bitmapToContours(bmp, alphaThreshold, bleedPx, simpTol);
    // Contour points are in the variant bitmap's local coordinates. The
    // packer draws the bitmap at (p.x, p.y) with p.width x p.height. The
    // bitmap is already pre-scaled to those dims, so a 1:1 mapping:
    //   canvas_x = p.x + contour_x
    // works because bitmap.width === p.width and bitmap.height === p.height
    // (the packer stores the cropped/rotated variants at their final
    // draw size).
    // To be safe against scale drift we compute an explicit scale.
    const sx = p.width / bmp.width;
    const sy = p.height / bmp.height;
    for (const poly of contours) {
      const scaled = poly.map((pt) => ({ x: pt.x * sx, y: pt.y * sy }));
      const d = polylineToPathD(scaled, p.x - tile.x, p.y - tile.y);
      if (d) cutPaths.push(d);
    }
  }

  const widthIn = (tile.width / dpi).toFixed(4);
  const heightIn = (tile.height / dpi).toFixed(4);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${widthIn}in" height="${heightIn}in" viewBox="0 0 ${tile.width} ${tile.height}">
  <g id="print">
    <image x="0" y="0" width="${tile.width}" height="${tile.height}" href="${pngUrl}"/>
  </g>
  <g id="cut" fill="none" stroke="#000" stroke-width="0.5">
    ${cutPaths.map((d) => `<path d="${d}"/>`).join("\n    ")}
  </g>
</svg>
`;
}

/** Lightweight structural check: parses, has both layers, dimensions match. */
function selfCheckSvg(
  svg: string,
  expectedWidth: number,
  expectedHeight: number,
): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    return "SVG parse error";
  }
  if (!doc.getElementById("print")) return "missing print layer";
  if (!doc.getElementById("cut")) return "missing cut layer";

  // Dimension validation.
  const img = doc.querySelector("#print image");
  if (!img) return "missing print image";
  if (Number(img.getAttribute("width")) !== expectedWidth)
    return "print width mismatch";
  if (Number(img.getAttribute("height")) !== expectedHeight)
    return "print height mismatch";
  const viewBox = doc.documentElement.getAttribute("viewBox");
  if (viewBox !== `0 0 ${expectedWidth} ${expectedHeight}`)
    return "viewBox mismatch";

  return null;
}

export interface BuildExportResult {
  /** Each entry: filename (no path) + SVG content. */
  files: Array<{ name: string; svg: string }>;
  tiles: Tile[];
}

export async function buildCricutExport(
  input: BuildExportInput,
): Promise<BuildExportResult> {
  const tileWpx =
    input.tileWidthPx ?? mmToPx(CRICUT_PTC_IN.w * 25.4, input.dpi);
  const tileHpx =
    input.tileHeightPx ?? mmToPx(CRICUT_PTC_IN.h * 25.4, input.dpi);
  const allTiles = tileCanvas(
    input.canvasWidthPx,
    input.canvasHeightPx,
    tileWpx,
    tileHpx,
  );
  const assign = assignPlacementsToTiles(input.placements, allTiles);

  // Pick the tiles that will actually appear in the export. When
  // `skipEmptyTiles` is on, drop any tile whose centroid-assigned list
  // is empty — those would yield a blank Cricut sheet the user has to
  // skip manually otherwise.
  const exported: Array<{ tile: Tile; placements: Placement[] }> = [];
  for (let i = 0; i < allTiles.length; i++) {
    const placements = assign.get(i) ?? [];
    if (input.skipEmptyTiles && placements.length === 0) continue;
    exported.push({ tile: allTiles[i], placements });
  }

  const files: BuildExportResult["files"] = [];
  const total = exported.length;
  for (let i = 0; i < exported.length; i++) {
    const { tile, placements } = exported[i];
    const svg = await buildTileSvg(
      tile,
      placements,
      input.variantBitmaps,
      input.bleedMm,
      input.alphaThreshold,
      input.dpi,
    );
    const err = selfCheckSvg(svg, tile.width, tile.height);
    if (err) throw new Error(`SVG self-check failed for tile ${i + 1}: ${err}`);
    const name =
      total === 1 ? "tile.svg" : `tile-${i + 1}-of-${total}.svg`;
    files.push({ name, svg });
  }
  return { files, tiles: exported.map((e) => e.tile) };
}

/** Browser download helper. */
function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadCricutExport(
  result: BuildExportResult,
  baseName: string,
): Promise<void> {
  if (result.files.length === 1) {
    const blob = new Blob([result.files[0].svg], {
      type: "image/svg+xml;charset=utf-8",
    });
    triggerDownload(blob, `${baseName}.svg`);
    return;
  }
  const zip = new JSZip();
  for (const f of result.files) zip.file(f.name, f.svg);
  const zipBlob = await zip.generateAsync({ type: "blob" });
  triggerDownload(zipBlob, `${baseName}-${result.files.length}tiles.zip`);
}

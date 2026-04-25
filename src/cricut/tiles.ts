import type { Placement } from "../packer/types";

export interface Tile {
  /** 0-based column index, left-to-right. */
  col: number;
  /** 0-based row index, top-to-bottom. */
  row: number;
  /** Tile origin in canvas pixels. */
  x: number;
  y: number;
  /** Tile size in canvas pixels. May exceed canvas bounds; the last row
   * and column are *not* clipped — they always match `tileWidthPx` /
   * `tileHeightPx` so exported SVGs are consistent 9.25"×6.75" files. */
  width: number;
  height: number;
}

export function tileCanvas(
  canvasWidthPx: number,
  canvasHeightPx: number,
  tileWidthPx: number,
  tileHeightPx: number,
): Tile[] {
  const cols = Math.max(1, Math.ceil(canvasWidthPx / tileWidthPx));
  const rows = Math.max(1, Math.ceil(canvasHeightPx / tileHeightPx));
  const out: Tile[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({
        col: c,
        row: r,
        x: c * tileWidthPx,
        y: r * tileHeightPx,
        width: tileWidthPx,
        height: tileHeightPx,
      });
    }
  }
  return out;
}

/** Centroid (center of the bounding box) of a placement in canvas px. */
function centroid(p: Placement): { x: number; y: number } {
  return { x: p.x + p.width / 2, y: p.y + p.height / 2 };
}

/**
 * Assign each placement to exactly one tile based on its centroid.
 * Returns a map from tile index (into the `tiles` array) to the list of
 * placements assigned to that tile.
 */
export function assignPlacementsToTiles(
  placements: Placement[],
  tiles: Tile[],
): Map<number, Placement[]> {
  const out = new Map<number, Placement[]>();
  for (let i = 0; i < tiles.length; i++) out.set(i, []);
  for (const p of placements) {
    const { x, y } = centroid(p);
    let bestIdx = 0;
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (
        x >= t.x &&
        x < t.x + t.width &&
        y >= t.y &&
        y < t.y + t.height
      ) {
        bestIdx = i;
        break;
      }
    }
    out.get(bestIdx)!.push(p);
  }
  return out;
}

/**
 * Is this placement's bounding box fully contained inside the given
 * tile? Used to flag overhanging stickers in the preview.
 */
export function placementFitsInTile(p: Placement, tile: Tile): boolean {
  return (
    p.x >= tile.x &&
    p.y >= tile.y &&
    p.x + p.width <= tile.x + tile.width &&
    p.y + p.height <= tile.y + tile.height
  );
}

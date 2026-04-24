# Cricut Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app "Cricut Export" view that turns a packed sticker layout into Cricut-ready SVG files (one per 9.25″×6.75″ Print-Then-Cut tile), each embedding the printed artwork and a cut-path layer traced around each sticker with a user-adjustable bleed.

**Architecture:** New `src/cricut/` module of pure TypeScript functions (alpha-mask → dilated mask → contour polylines → SVG paths; canvas → tile grid → per-tile SVGs → zip). A new `CricutExport.tsx` React view is swapped into the main viewport via a top-level `view: "pack" | "cricut"` state in `App.tsx`. The existing packer, main preview, and sidebar are untouched except for a Cricut canvas preset and an "Export for Cricut" button.

**Tech Stack:** React 19 + TypeScript + Vite, OffscreenCanvas / ImageBitmap for alpha extraction, JSZip for multi-tile bundling, SVG 1.1 with embedded base64 PNG for Cricut Design Space import.

**Note on testing:** The project has no unit-test framework (see `package.json`) and the spec explicitly keeps it that way. Verification for each task is done manually via `npm run dev` and in-browser checks — each task ends with an explicit manual-check step with concrete expected output. Pure functions get a temporary `console.log`-based sanity check that is removed after verification.

**Spec:** `docs/superpowers/specs/2026-04-24-cricut-export-design.md`

---

## File Structure

- Create: `src/cricut/contour.ts` — alpha mask → dilated mask → traced polylines → simplified polylines. Pure functions over typed arrays and `ImageBitmap`.
- Create: `src/cricut/tiles.ts` — tile grid layout + centroid-based sticker assignment. Pure functions.
- Create: `src/cricut/export.ts` — per-tile PNG rendering, SVG assembly, JSZip packaging, download orchestration.
- Create: `src/cricut/CricutExport.tsx` — React view component (header, controls panel, preview canvas with overlays, download button).
- Modify: `src/lib/units.ts` — add `CRICUT_PTC_CM` constant.
- Modify: `src/App.tsx` — add Cricut canvas preset button, `view` state, "Export for Cricut" button, render `CricutExport` when active.
- Modify: `package.json` / `package-lock.json` — add `jszip` runtime dependency.

---

## Task 1: Cricut canvas preset button

**Files:**
- Modify: `src/lib/units.ts`
- Modify: `src/App.tsx:25-27` (import), `src/App.tsx:625-649` (preset row)

- [ ] **Step 1: Add the Cricut PTC dimension constant**

Edit `src/lib/units.ts`. After the `A4_CM` line, add:

```typescript
/** Cricut Print-Then-Cut standard max (9.25" × 6.75"), in cm. Landscape. */
export const CRICUT_PTC_CM = { w: 23.495, h: 17.145 } as const;
```

- [ ] **Step 2: Import it in App.tsx**

Edit the units import block at `src/App.tsx:22-28`:

```typescript
import {
  cmToPx,
  pxToCm,
  A4_CM,
  CRICUT_PTC_CM,
  CM_PER_INCH,
  DPI_PRESETS,
} from "./lib/units";
```

- [ ] **Step 3: Add the Cricut preset button**

In `src/App.tsx`, locate the `<div className="flex gap-2">` block around line 626 that holds the existing `PresetButton` elements. After the closing `</PresetButton>` for "A4 Landscape" (around line 648), add a third button:

```tsx
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
```

- [ ] **Step 4: Manual check**

Run:

```bash
npm run dev
```

Expected: dev server starts, no TypeScript errors. In the browser, the sidebar's Canvas section shows three preset buttons: **A4**, **A4 Landscape**, **Cricut**. Clicking **Cricut** sets Width to `23.5` (displayed as `23.50` or similar depending on the `CmField` formatter) and Height to `17.1`, and the button visibly becomes "active". Clicking **A4** switches back to `21.0 × 29.7`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/units.ts src/App.tsx
git commit -m "Add Cricut Print-Then-Cut canvas preset"
```

---

## Task 2: Scaffold view swap and "Export for Cricut" button

**Files:**
- Create: `src/cricut/CricutExport.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create the placeholder CricutExport component**

Create `src/cricut/CricutExport.tsx`:

```tsx
import type { PackResult } from "../packer/types";

export interface CricutExportProps {
  result: PackResult;
  variantBitmaps: Record<string, ImageBitmap[]>;
  canvasWidthPx: number;
  canvasHeightPx: number;
  dpi: number;
  onBack: () => void;
}

export function CricutExport(props: CricutExportProps) {
  return (
    <div className="flex h-full w-full flex-col bg-neutral-950 text-neutral-100">
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
          {props.result.placements.length} stickers ·{" "}
          {props.canvasWidthPx}×{props.canvasHeightPx} px · {props.dpi} DPI
        </div>
      </header>
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
        Cricut export view — UI coming in later tasks.
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the view state and handlers in App.tsx**

In `src/App.tsx`, after the `const [pack, setPack] = useState<PackState>` block (around line 141-150), add:

```typescript
  const [view, setView] = useState<"pack" | "cricut">("pack");
```

Import the component near the top of `src/App.tsx` (add after the other local imports, around line 33):

```typescript
import { CricutExport } from "./cricut/CricutExport";
```

- [ ] **Step 3: Add the "Export for Cricut" button**

In `src/App.tsx`, inside the sidebar footer — immediately after the closing `</button>` tag of the existing "Download PNG" button (around line 850), add:

```tsx
        <button
          type="button"
          onClick={props.onExportCricut}
          disabled={!props.pack.result}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
          title={props.pack.result ? "" : "Pack some stickers first"}
        >
          Export for Cricut →
        </button>
```

- [ ] **Step 4: Wire the prop through SidebarProps**

In `src/App.tsx`, add to `SidebarProps` (around line 548-580), alongside `onDownload`:

```typescript
  onExportCricut: () => void;
```

- [ ] **Step 5: Pass the handler into the Sidebar and render the Cricut view**

Replace the top-level `return` block of the `App` component (around line 484-541). Find the `<Sidebar ... onDownload={downloadPng} downloading={downloading} />` line and add `onExportCricut={() => setView("cricut")}` as a prop.

Then wrap the existing return value in a conditional:

```tsx
  if (view === "cricut" && pack.result) {
    return (
      <CricutExport
        result={pack.result}
        variantBitmaps={pack.variantBitmaps}
        canvasWidthPx={pack.canvasWidthPx}
        canvasHeightPx={pack.canvasHeightPx}
        dpi={dpi}
        onBack={() => setView("pack")}
      />
    );
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-neutral-950 text-neutral-100">
      <Sidebar
        /* ... existing props ... */
        onExportCricut={() => setView("cricut")}
      />
      {/* ... rest unchanged ... */}
    </div>
  );
```

- [ ] **Step 6: Manual check**

Run:

```bash
npm run dev
```

Expected: no TS errors. In the browser:
- Before packing: "Export for Cricut →" button is visible under "Download PNG" and disabled with a tooltip.
- After packing some stickers: button becomes enabled.
- Clicking it swaps the viewport to the Cricut Export view (back button top-left, title, stats on the right, placeholder text in the middle).
- Clicking "← Back" returns to the packing view with all state intact.

- [ ] **Step 7: Commit**

```bash
git add src/cricut/CricutExport.tsx src/App.tsx
git commit -m "Scaffold Cricut export view and swap navigation"
```

---

## Task 3: Alpha mask + dilation (contour.ts part 1)

**Files:**
- Create: `src/cricut/contour.ts`

- [ ] **Step 1: Create the module with the alpha-extraction function**

Create `src/cricut/contour.ts`:

```typescript
/**
 * A binary mask over a rectangular pixel grid. `data[y * width + x]` is 1
 * where the source pixel is considered opaque, 0 otherwise.
 */
export interface BinaryMask {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Extract a binary alpha mask from an ImageBitmap. Pixels whose alpha
 * channel is strictly greater than `alphaThreshold` (0..255) count as
 * opaque.
 */
export function extractAlphaMask(
  bitmap: ImageBitmap,
  alphaThreshold: number,
): BinaryMask {
  const w = bitmap.width;
  const h = bitmap.height;
  const off = new OffscreenCanvas(w, h);
  const ctx = off.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable for alpha extraction");
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 3; i < out.length; i++, j += 4) {
    out[i] = img[j] > alphaThreshold ? 1 : 0;
  }
  return { width: w, height: h, data: out };
}
```

- [ ] **Step 2: Add the dilation function**

Append to `src/cricut/contour.ts`:

```typescript
/**
 * Chebyshev (square-neighborhood) dilation by `radius` pixels. The
 * returned mask covers every original pixel plus every pixel within
 * `radius` cells on any of the 8 axes. A zero or negative radius returns
 * a copy of the input mask.
 *
 * Implementation: two-pass separable dilation (horizontal then vertical)
 * using a sliding-window OR. O(w * h * radius) worst case.
 */
export function dilate(mask: BinaryMask, radius: number): BinaryMask {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) return { ...mask, data: new Uint8Array(mask.data) };

  const w = mask.width;
  const h = mask.height;
  const horizontal = new Uint8Array(w * h);

  // Horizontal pass.
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      let v = 0;
      for (let xx = x0; xx <= x1; xx++) {
        if (mask.data[rowOff + xx]) {
          v = 1;
          break;
        }
      }
      horizontal[rowOff + x] = v;
    }
  }

  // Vertical pass.
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h - 1, y + r);
      let v = 0;
      for (let yy = y0; yy <= y1; yy++) {
        if (horizontal[yy * w + x]) {
          v = 1;
          break;
        }
      }
      out[y * w + x] = v;
    }
  }
  return { width: w, height: h, data: out };
}
```

- [ ] **Step 3: Manual sanity check**

Add a *temporary* self-test at the bottom of `src/cricut/contour.ts`:

```typescript
// TEMP sanity check — remove after verifying.
if (import.meta.hot) {
  const m: BinaryMask = {
    width: 5,
    height: 5,
    data: new Uint8Array([
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 1, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
    ]),
  };
  const d = dilate(m, 1);
  // Expected: a 3x3 square of 1s around (2,2).
  console.log("[contour self-test] dilate radius 1 of single pixel:");
  for (let y = 0; y < 5; y++) {
    console.log(Array.from(d.data.slice(y * 5, (y + 1) * 5)).join(" "));
  }
}
```

Run `npm run dev` and open any page that imports this module. Since nothing yet imports `contour.ts`, temporarily add `import "./cricut/contour";` at the very top of `src/main.tsx` just for this check.

Expected browser console output:

```
[contour self-test] dilate radius 1 of single pixel:
0 0 0 0 0
0 1 1 1 0
0 1 1 1 0
0 1 1 1 0
0 0 0 0 0
```

- [ ] **Step 4: Remove the sanity check and the temporary import**

Delete the `if (import.meta.hot) { ... }` block from `src/cricut/contour.ts` and the `import "./cricut/contour";` line from `src/main.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/cricut/contour.ts
git commit -m "Add alpha-mask extraction and dilation for cut contours"
```

---

## Task 4: Contour tracing + RDP simplification (contour.ts part 2)

**Files:**
- Modify: `src/cricut/contour.ts`

- [ ] **Step 1: Add the Moore-neighborhood boundary tracer**

Append to `src/cricut/contour.ts`:

```typescript
export interface Point {
  x: number;
  y: number;
}

/** One closed polyline. The first point is NOT repeated at the end. */
export type Polyline = Point[];

/**
 * Trace every closed contour in a binary mask. Uses a Moore-neighborhood
 * boundary-following algorithm: scans for unvisited boundary pixels
 * top-to-bottom, left-to-right, then walks each boundary clockwise back
 * to the start. Interior holes produce their own contours (walked
 * counter-clockwise in pixel-up coordinates, which is the SVG fill-rule
 * interpretation of "inside").
 *
 * Coordinates are in mask-pixel units: integer `x` in [0, width-1],
 * integer `y` in [0, height-1].
 */
export function traceContours(mask: BinaryMask): Polyline[] {
  const { width: w, height: h, data } = mask;
  const visited = new Uint8Array(w * h);
  const contours: Polyline[] = [];

  // Moore neighborhood offsets, clockwise starting from the cell directly
  // above the current cell (the conventional start direction for a
  // boundary walk that just came from the left).
  const dx = [0, 1, 1, 1, 0, -1, -1, -1];
  const dy = [-1, -1, 0, 1, 1, 1, 0, -1];

  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : data[y * w + x];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      if (visited[y * w + x]) continue;
      // Only start a walk when we're at a boundary pixel — i.e. the cell
      // immediately to the left is background or we're at the left edge.
      if (x > 0 && data[y * w + (x - 1)]) continue;

      const contour: Polyline = [];
      let cx = x;
      let cy = y;
      // Previous direction index: we "came from" the left (dir 6).
      let prevDir = 6;

      while (true) {
        visited[cy * w + cx] = 1;
        contour.push({ x: cx, y: cy });

        // Search clockwise starting from (prevDir + 6) % 8, which is the
        // cell that sits "behind-left" of our entry direction. This is
        // the Moore-neighborhood rule for finding the next boundary
        // pixel.
        const startDir = (prevDir + 6) % 8;
        let found = false;
        for (let i = 0; i < 8; i++) {
          const d = (startDir + i) % 8;
          const nx = cx + dx[d];
          const ny = cy + dy[d];
          if (at(nx, ny)) {
            if (nx === x && ny === y && contour.length > 2) {
              found = true;
              cx = -1; // sentinel to break outer loop
              break;
            }
            cx = nx;
            cy = ny;
            prevDir = d;
            found = true;
            break;
          }
        }
        if (!found) break; // isolated pixel
        if (cx === -1) break;
      }

      if (contour.length >= 3) contours.push(contour);
    }
  }

  return contours;
}
```

- [ ] **Step 2: Add Ramer-Douglas-Peucker simplification**

Append to `src/cricut/contour.ts`:

```typescript
/**
 * Ramer-Douglas-Peucker simplification. Drops intermediate points whose
 * perpendicular distance from the straight line between the surviving
 * anchors is less than `tolerance` mask-pixel units. Closed polylines
 * are handled by temporarily treating the start and end as the anchor
 * segment; the returned polyline is still closed (first point not
 * repeated).
 */
export function simplifyPolyline(
  points: Polyline,
  tolerance: number,
): Polyline {
  if (points.length <= 2 || tolerance <= 0) return points.slice();
  const sqTol = tolerance * tolerance;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let maxSq = -1;
    let maxIdx = -1;
    const ax = points[lo].x;
    const ay = points[lo].y;
    const bx = points[hi].x;
    const by = points[hi].y;
    const ex = bx - ax;
    const ey = by - ay;
    const len2 = ex * ex + ey * ey || 1;
    for (let i = lo + 1; i < hi; i++) {
      const px = points[i].x - ax;
      const py = points[i].y - ay;
      const t = (px * ex + py * ey) / len2;
      const tx = t * ex - px;
      const ty = t * ey - py;
      const sq = tx * tx + ty * ty;
      if (sq > maxSq) {
        maxSq = sq;
        maxIdx = i;
      }
    }
    if (maxSq > sqTol && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([lo, maxIdx]);
      stack.push([maxIdx, hi]);
    }
  }

  const out: Polyline = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) out.push(points[i]);
  }
  return out;
}
```

- [ ] **Step 3: Add the top-level pipeline function**

Append to `src/cricut/contour.ts`:

```typescript
/**
 * Full pipeline: ImageBitmap → list of simplified, closed polylines in
 * bitmap-pixel coordinates, each offset outward by `bleedPx` pixels.
 * A single sticker with an interior hole yields two polylines (outer
 * and inner). Fully transparent bitmaps yield an empty array.
 *
 * `simplifyTolPx` defaults to 1 pixel; callers that want ~0.3 mm at a
 * given DPI should compute `(0.3 / 25.4) * dpi` themselves.
 */
export function bitmapToContours(
  bitmap: ImageBitmap,
  alphaThreshold: number,
  bleedPx: number,
  simplifyTolPx = 1,
): Polyline[] {
  const mask = extractAlphaMask(bitmap, alphaThreshold);
  const expanded = dilate(mask, bleedPx);
  const raw = traceContours(expanded);
  return raw.map((p) => simplifyPolyline(p, simplifyTolPx));
}
```

- [ ] **Step 4: Manual sanity check**

Temporarily add to `src/cricut/contour.ts`:

```typescript
if (import.meta.hot) {
  // 5x5 solid 3x3 square in the middle. Expected contour: 8 corner/edge
  // points forming a square around the 3x3 block.
  const m: BinaryMask = {
    width: 5,
    height: 5,
    data: new Uint8Array([
      0, 0, 0, 0, 0,
      0, 1, 1, 1, 0,
      0, 1, 1, 1, 0,
      0, 1, 1, 1, 0,
      0, 0, 0, 0, 0,
    ]),
  };
  const cs = traceContours(m);
  console.log("[contour self-test] contours of 3x3 square:");
  console.log("  count:", cs.length);
  for (const c of cs) {
    console.log("  points:", c.length, c.map((p) => `(${p.x},${p.y})`).join(" "));
  }
  console.log(
    "[contour self-test] simplified tol=0.5:",
    simplifyPolyline(cs[0] ?? [], 0.5).length,
    "points",
  );
}
```

Add the temp import back to `src/main.tsx`: `import "./cricut/contour";`.

Run `npm run dev` and check the browser console.

Expected:

```
[contour self-test] contours of 3x3 square:
  count: 1
  points: 8 (1,1) (2,1) (3,1) (3,2) (3,3) (2,3) (1,3) (1,2)
[contour self-test] simplified tol=0.5: 4 points
```

(`count: 1` + 8 boundary pixels; simplification to 4 corner points.)

- [ ] **Step 5: Remove the sanity check block and the temp import**

- [ ] **Step 6: Commit**

```bash
git add src/cricut/contour.ts
git commit -m "Trace and simplify contours for Cricut cut paths"
```

---

## Task 5: Tile grid + centroid assignment

**Files:**
- Create: `src/cricut/tiles.ts`

- [ ] **Step 1: Create the module**

Create `src/cricut/tiles.ts`:

```typescript
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
```

- [ ] **Step 2: Manual sanity check**

Temporarily add to the bottom of `src/cricut/tiles.ts`:

```typescript
if (import.meta.hot) {
  const tiles = tileCanvas(2480, 3508, 2775, 2025); // A4 @ 300dpi vs PTC
  console.log("[tiles self-test] A4 @ 300dpi:", tiles.length, "tiles");
  for (const t of tiles) {
    console.log(
      `  col=${t.col} row=${t.row} origin=(${t.x},${t.y}) size=${t.width}x${t.height}`,
    );
  }
}
```

Add to `src/main.tsx`: `import "./cricut/tiles";`. Run `npm run dev`.

Expected console output:

```
[tiles self-test] A4 @ 300dpi: 2 tiles
  col=0 row=0 origin=(0,0) size=2775x2025
  col=0 row=1 origin=(0,2025) size=2775x2025
```

(A4 at 300dpi is 2480×3508 px. Width fits in one 2775-px column. Height 3508 needs two 2025-px rows.)

- [ ] **Step 3: Remove the sanity check and the temp import**

- [ ] **Step 4: Commit**

```bash
git add src/cricut/tiles.ts
git commit -m "Tile canvas into Cricut Print-Then-Cut regions"
```

---

## Task 6: SVG + ZIP export

**Files:**
- Modify: `package.json`
- Create: `src/cricut/export.ts`

- [ ] **Step 1: Add JSZip dependency**

Run:

```bash
npm install jszip@^3.10
```

Verify `package.json` has `"jszip": "^3.10.x"` under `dependencies`.

- [ ] **Step 2: Create the export module**

Create `src/cricut/export.ts`:

```typescript
import JSZip from "jszip";
import type { Placement } from "../packer/types";
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
  /** Tile size in canvas pixels. Default = 9.25" × 6.75" at `dpi`. */
  tileWidthPx?: number;
  tileHeightPx?: number;
}

const INCH_PER_MM = 1 / 25.4;
const PTC_IN = { w: 9.25, h: 6.75 };

function mmToPx(mm: number, dpi: number): number {
  return Math.max(0, Math.round(mm * INCH_PER_MM * dpi));
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

/** Lightweight structural check: parses, has both layers, has cut paths. */
function selfCheckSvg(svg: string): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    return "SVG parse error";
  }
  if (!doc.getElementById("print")) return "missing print layer";
  if (!doc.getElementById("cut")) return "missing cut layer";
  const paths = doc.querySelectorAll("#cut path");
  if (paths.length === 0) return "no cut paths";
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
  const tileWpx = input.tileWidthPx ?? mmToPx(PTC_IN.w * 25.4, input.dpi);
  const tileHpx = input.tileHeightPx ?? mmToPx(PTC_IN.h * 25.4, input.dpi);
  const tiles = tileCanvas(
    input.canvasWidthPx,
    input.canvasHeightPx,
    tileWpx,
    tileHpx,
  );
  const assign = assignPlacementsToTiles(input.placements, tiles);
  const files: BuildExportResult["files"] = [];
  const total = tiles.length;
  for (let i = 0; i < tiles.length; i++) {
    const tilePlacements = assign.get(i) ?? [];
    const svg = await buildTileSvg(
      tiles[i],
      tilePlacements,
      input.variantBitmaps,
      input.bleedMm,
      input.alphaThreshold,
      input.dpi,
    );
    const err = selfCheckSvg(svg);
    if (err) throw new Error(`SVG self-check failed for tile ${i + 1}: ${err}`);
    const name =
      total === 1 ? "tile.svg" : `tile-${i + 1}-of-${total}.svg`;
    files.push({ name, svg });
  }
  return { files, tiles };
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
```

- [ ] **Step 3: Build check**

Run:

```bash
npm run build
```

Expected: compiles with no TS errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/cricut/export.ts
git commit -m "Assemble Cricut tile SVGs and zip-download helper"
```

---

## Task 7: Cricut Export view — preview canvas with overlays

**Files:**
- Modify: `src/cricut/CricutExport.tsx`

- [ ] **Step 1: Replace the placeholder with the real layout shell**

Overwrite `src/cricut/CricutExport.tsx` with:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import type { PackResult, Placement } from "../packer/types";
import {
  tileCanvas,
  assignPlacementsToTiles,
  placementFitsInTile,
  type Tile,
} from "./tiles";

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
}) {
  // Placeholder — no drawing yet. Will be filled in Task 8.
  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={props.canvasWidthPx * props.scale}
      height={props.canvasHeightPx * props.scale}
      viewBox={`0 0 ${props.canvasWidthPx} ${props.canvasHeightPx}`}
      preserveAspectRatio="none"
    />
  );
}
```

- [ ] **Step 2: Manual check**

Run `npm run dev`. Pack some stickers on the main page, then click "Export for Cricut →".

Expected:
- The view shows a header with back button, title, and tile/sticker counts.
- Left sidebar shows a bleed slider (starts at 1.0 mm), two checkboxes (both on), and a disabled Download button labeled `.svg` (single tile) or `.zip (N files)` (multi-tile).
- Main area shows the packed layout rendered on a scaled canvas.
- No overlays drawn yet (that's Task 8).
- Moving the bleed slider updates the label but doesn't affect visuals yet.

- [ ] **Step 3: Commit**

```bash
git add src/cricut/CricutExport.tsx
git commit -m "Cricut export view: controls panel and preview canvas"
```

---

## Task 8: Cut-line, tile-grid, and overhang overlays

**Files:**
- Modify: `src/cricut/CricutExport.tsx`

- [ ] **Step 1: Add contour computation with caching**

At the top of `src/cricut/CricutExport.tsx`, add to the imports:

```typescript
import { bitmapToContours, type Polyline } from "./contour";
```

Inside the `CricutExport` component (after the `overhanging` memo), add:

```typescript
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
```

- [ ] **Step 2: Pass contours into the overlay**

In the JSX, update the `<OverlaySvg ... />` element to include:

```tsx
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
```

And add the `computing` badge inside the `<div ref={wrapRef}>` preview area, immediately above the `<div className="relative shadow-2xl ...">`:

```tsx
          {computing ? (
            <div className="absolute right-4 top-4 rounded-md bg-neutral-800/80 px-2 py-1 text-[11px] text-neutral-300">
              Recomputing cut lines…
            </div>
          ) : null}
```

- [ ] **Step 3: Replace the placeholder OverlaySvg with the real one**

Replace the `OverlaySvg` function body with:

```tsx
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
```

- [ ] **Step 4: Manual check**

Run `npm run dev`. Pack a few stickers on an A4 canvas, then click "Export for Cricut →".

Expected:
- Blue rectangles outline the tile grid (2 tiles vertically for A4).
- Red closed paths trace each sticker ~1 mm outside its opaque edge.
- Any sticker whose bounding box crosses a tile boundary gets a yellow dashed rectangle around it, and the header shows "N over boundary".
- Moving the bleed slider: "Recomputing cut lines…" badge flashes briefly, then the red paths redraw further from or closer to each sticker.
- Toggling "Show cut lines" and "Show tile grid" hides/shows each layer.

- [ ] **Step 5: Commit**

```bash
git add src/cricut/CricutExport.tsx
git commit -m "Overlay cut paths, tile grid, and overhang warnings on preview"
```

---

## Task 9: Wire up the Download button

**Files:**
- Modify: `src/cricut/CricutExport.tsx`

- [ ] **Step 1: Import the export helpers**

Add to the imports at the top of `src/cricut/CricutExport.tsx`:

```typescript
import {
  buildCricutExport,
  downloadCricutExport,
} from "./export";
```

- [ ] **Step 2: Add the download handler**

Inside the `CricutExport` component, just before the `return`, add:

```typescript
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const onDownload = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const result = await buildCricutExport({
        placements: props.result.placements,
        variantBitmaps: props.variantBitmaps,
        canvasWidthPx: props.canvasWidthPx,
        canvasHeightPx: props.canvasHeightPx,
        dpi: props.dpi,
        bleedMm,
        alphaThreshold: 16,
      });
      const wcm = ((props.canvasWidthPx * 2.54) / props.dpi).toFixed(1);
      const hcm = ((props.canvasHeightPx * 2.54) / props.dpi).toFixed(1);
      const base = `cricut-${wcm}x${hcm}cm`;
      await downloadCricutExport(result, base);
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : "Export failed",
      );
    } finally {
      setDownloading(false);
    }
  };
```

- [ ] **Step 3: Replace the disabled download button**

In the controls panel, replace the disabled `<button>` at the bottom of the `<aside>` with:

```tsx
          <div className="mt-auto flex flex-col gap-2">
            <button
              type="button"
              onClick={onDownload}
              disabled={downloading}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {downloading
                ? "Exporting…"
                : `Download ${
                    tiles.length === 1
                      ? ".svg"
                      : `.zip (${tiles.length} files)`
                  }`}
            </button>
            {downloadError ? (
              <p className="text-xs text-red-400">{downloadError}</p>
            ) : null}
          </div>
```

- [ ] **Step 4: Manual check — single tile (Cricut preset)**

Run `npm run dev`. Set canvas to the Cricut preset (23.5 × 17.1 cm), pack a few stickers, click Export for Cricut, then Download.

Expected:
- A file named `cricut-23.5x17.1cm.svg` downloads.
- Open it directly in a browser (`open ~/Downloads/cricut-*.svg`): the artwork and outlines render. The SVG's declared size is `9.2500in × 6.7500in`.
- Open it in Cricut Design Space (or upload via the web app): it imports with recognizable print + cut layers at real-world size.

- [ ] **Step 5: Manual check — multi-tile (A4)**

Switch back to the A4 preset, pack more stickers, click Export for Cricut, then Download.

Expected:
- A file named `cricut-21.0x29.7cm-2tiles.zip` downloads.
- Unzip: contains `tile-1-of-2.svg` and `tile-2-of-2.svg`. Each tile renders its share of stickers at `9.25in × 6.75in`.
- Stickers flagged as overhanging in the preview are contained in their assigned tile's SVG in full (their cut lines don't wrap around).

- [ ] **Step 6: Commit**

```bash
git add src/cricut/CricutExport.tsx
git commit -m "Wire Cricut export download button"
```

---

## Task 10: README update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a Cricut export section**

In `README.md`, under the `## Features` list, add a new bullet:

```markdown
- **Cricut export** — one-click Print-Then-Cut bundle: each sticker gets
  a cut path traced around its opaque edge with an adjustable bleed,
  packed as SVG(s) ready to drag into Cricut Design Space. Canvases
  larger than 9.25″×6.75″ auto-tile into a zip, one SVG per page.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document Cricut export in README"
```

---

## Self-review checklist (already applied)

- **Spec coverage:** canvas presets (Task 1), view swap + button (Task 2), contour pipeline (Tasks 3–4), tiling + centroid assignment (Task 5), SVG + zip export with self-check (Task 6), preview UI (Task 7), overlays including overhang warning (Task 8), download wiring (Task 9). Error handling (empty pack → button disabled in Task 2; contour failures → skipped in Task 8 via `?.` / early return; zip failure → toast in Task 9; SVG self-check → throw in Task 6 → surfaced as `downloadError` in Task 9). Docs (Task 10).
- **Type consistency:** `Polyline`, `Point`, `BinaryMask`, `Tile`, `BuildExportInput`, `BuildExportResult` — each defined once, referenced by the same name everywhere. `placementFitsInTile` (defined Task 5, used Task 7). `bitmapToContours` signature fixed in Task 4, called with the same 4-arg form in Tasks 6 and 8.
- **Placeholders:** none. Every code step shows exact code; every verification step shows exact expected output.

---

## Notes

- The packer's `alphaThreshold` is hard-coded to 16 on the Cricut side (the existing default). If the main-page slider value should flow through, add `alpha: number` to `CricutExportProps` and thread it in. Left out of v1 for simplicity.
- Contours run on the main thread. If it noticeably stalls the UI with 100+ stickers, promote `src/cricut/contour.ts` work into a Web Worker using the same pattern as `src/packer/worker.ts`.
- The SVG self-check (`DOMParser`) covers structural issues but does not validate Cricut-specific quirks. Manual round-trips in Design Space remain the acceptance bar per the spec.

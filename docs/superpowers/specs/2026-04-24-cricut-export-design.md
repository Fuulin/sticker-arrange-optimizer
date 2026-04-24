# Cricut Export — Design Spec

**Date:** 2026-04-24
**Status:** Approved for planning

## Goal

Add a one-click path from a packed sticker layout to a Cricut-ready file. The
user clicks "Export for Cricut", lands on a new in-app view, previews the
cut lines over the layout, and downloads a single SVG (or a zip of SVGs)
that Cricut Design Space imports with print and cut layers already wired up.

## Non-goals

- No changes to the packer itself. Packing ignores Cricut size constraints.
- No new routes or URL changes. The Cricut view is an in-app swap of the
  main content.
- No Cricut-specific settings beyond bleed in v1 (e.g. no cut-line color
  picker, no per-sticker overrides, no direct-cut SVG without print layer).
- No test framework added. Manual verification in Cricut Design Space is
  the acceptance bar.

## User flow

1. User imports stickers, picks quantities, packs as today.
2. User clicks **Export for Cricut** in the sidebar (enabled only when a
   pack result exists).
3. The main view swaps to a **Cricut Export** view: preview of the packed
   layout with cut lines overlaid, tile grid overlaid, a bleed slider, and
   a download button.
4. User adjusts bleed (default 1 mm) — cut lines redraw live.
5. User clicks **Download**. If the canvas fits within the Cricut
   Print-Then-Cut max (9.25″ × 6.75″) the download is a single `.svg`. If
   the canvas is larger, it's a `.zip` containing one SVG per tile.
6. User clicks **Back** to return to the packing view. State is preserved.

## Architecture

### View swap

A top-level `view: "pack" | "cricut"` state in `App.tsx` chooses which
content to render. Sidebar gets an **Export for Cricut** button that flips
`view` to `"cricut"`; the Cricut view has a **← Back** button that flips
it back. No router, no URL change. All pack state (`pack.result`,
`pack.variantBitmaps`, canvas dimensions, DPI, library) stays in `App`'s
state and is passed into the Cricut view as props.

### New module: `src/cricut/`

- `contour.ts` — pure functions. `bitmapToContours(bitmap, alphaThreshold,
  bleedPx, dpi)` returns an array of closed polylines (each a list of
  `{x, y}` points in bitmap-local coordinates). Uses the same dilation
  routine already in `packer.ts` (factored out if needed) and a
  Moore-neighborhood boundary walk, followed by
  Ramer-Douglas-Peucker simplification at ~0.3 mm tolerance.
- `tiles.ts` — `tileCanvas(canvasW, canvasH, tileW, tileH)` returns a grid
  of `{x, y, w, h, col, row}` tile rects. `assignToTiles(placements,
  tiles)` assigns each placement to a tile by centroid.
- `export.ts` — `buildSvg(tile, placements, variantBitmaps, bleedMm, dpi)`
  returns an SVG string. `buildZip(tileSvgs)` returns a `Blob` using
  JSZip. `downloadTiles(tiles, ...)` orchestrates the flow.
- `CricutExport.tsx` — the view component. Renders preview canvas,
  controls panel (bleed slider, toggles), download button, header bar.

### Canvas presets on the main page

Sidebar gets a row of preset buttons above the W/H inputs: **A4** (21 ×
29.7 cm, current default) and **Cricut** (23.5 × 17.1 cm = 9.25″ × 6.75″).
Clicking a preset sets W and H; inputs remain editable for custom sizes.
Picking the Cricut preset means no tiling on export — the canvas is
already one tile.

## Cut-contour generation

Per placed sticker:

1. **Extract alpha mask** from the variant bitmap in
   `pack.variantBitmaps[stickerId][variantIdx]`, using the same alpha
   threshold the packer uses (default 16).
2. **Dilate** by `mm_to_px(bleed_mm, dpi)` pixels, reusing the packer's
   existing dilation routine.
3. **Trace** closed contours with a Moore-neighborhood boundary walk. A
   sticker with inner holes produces multiple contours.
4. **Simplify** with Ramer-Douglas-Peucker at ~0.3 mm equivalent tolerance
   to shrink SVG size and keep Design Space responsive.
5. **Translate** points by `(placement.x, placement.y)` to land in canvas
   coordinates. Rotation is already baked into the variant bitmap, so no
   rotation math here.
6. **Emit** one `<path d="M ... Z">` per contour.

Contour results are cached keyed by `(stickerId, variantIdx, bleedMm, dpi)`
so moving the bleed slider only recomputes what actually changed. Runs on
the main thread for v1; can move to a worker later if slow.

## Tiling

- Fixed tile size: **9.25″ × 6.75″** (Cricut PTC standard, no Design Space
  toggle required).
- Grid laid out top-left → bottom-right across the canvas. Last row/column
  may be partially empty — the tile's SVG just has less content.
- **Sticker-to-tile assignment is by centroid** of the placement's bounding
  box. The whole sticker goes to whichever tile contains its centroid;
  its print raster and cut contour are both rendered in full inside that
  tile's SVG, even if part of them crosses the tile boundary.
- A sticker whose bounding box extends past its assigned tile's boundary is
  **flagged as overhanging**. The Cricut preview outlines these in yellow
  and shows a warning icon. The user can still export — the print may clip
  at the paper edge during printing, but the cut line stays intact.

## SVG output format

One SVG per tile:

```xml
<svg width="9.25in" height="6.75in" viewBox="0 0 2775 2025"
     xmlns="http://www.w3.org/2000/svg">
  <g id="print">
    <image x="0" y="0" width="2775" height="2025"
           href="data:image/png;base64,..." />
  </g>
  <g id="cut" fill="none" stroke="#000" stroke-width="0.5">
    <path d="M ... Z" />
    ...
  </g>
</svg>
```

- `viewBox` is in canvas pixels at the current DPI.
- `width`/`height` in inches → Cricut Design Space imports at true physical
  scale, no user resizing.
- The embedded PNG is the rendered sticker artwork for that tile only,
  cropped from the canvas. Base64 data URL. Rendered via the same
  `drawPlacements` routine as the existing PNG download.
- Cut color is fixed to black (`#000`), stroke-width 0.5 px, no fill.

**Fallback:** if a base64-embedded PNG exceeds browser data-URL limits
(rare at tile sizes), the zip contains `tile-N.svg` + `tile-N.png`
side-by-side, with the SVG referencing the PNG via relative URL.

## Download UX

- **Single tile (canvas ≤ PTC):** one file, e.g.
  `cricut-23.5x17.1cm-1tile.svg`.
- **Multiple tiles:** one zip, e.g. `cricut-21.0x29.7cm-2tiles.zip`
  containing `tile-1-of-2.svg`, `tile-2-of-2.svg`, ordered top-left →
  bottom-right.

JSZip (~30 KB) is added as a dependency.

## Cricut Export view — UI

Full-viewport layout when `view === "cricut"`:

- **Header bar (top):** ← Back button; title "Cricut Export"; right-side
  summary stats ("2 tiles · 47 stickers · 2 over boundary").
- **Controls panel (left, narrow):**
  - Bleed slider: 0–5 mm, default 1 mm, 0.1 mm step, 150 ms debounce.
  - Show cut lines toggle (default on).
  - Show tile grid toggle (default on).
  - Download button (primary CTA; label reflects single-file vs. zip).
- **Preview (main area):**
  - Packed layout drawn 1:1 from `placements` + `variantBitmaps`.
  - Blue tile-grid overlay.
  - Red cut contours overlay.
  - Yellow outline + warning icon on overhanging stickers.
  - Zoom/pan reuses the existing `PreviewPane` controls (factor into a
    shared hook or duplicate the small amount of state).

During contour recompute, a faint "Recomputing cut lines…" badge shows;
old paths stay visible to avoid flashing.

## Error handling

- Empty pack result → Export button disabled with tooltip "Pack some
  stickers first".
- Contour extraction fails for one sticker (fully transparent variant,
  etc.) → skip it, log a console warning, continue with the rest.
- JSZip load or Blob creation failure → inline toast "Export failed"; the
  download button re-enables.
- Base64 PNG too large → fall back to external PNG files in the zip (see
  SVG format section).
- Self-check on every generated SVG: validates it parses, has non-zero
  print + cut layers, and dimensions match the expected tile. On failure,
  download is refused with an error message rather than handing the user a
  broken file.

## Testing

Manual verification is the acceptance bar:

- Open each generated SVG in Cricut Design Space and confirm the print
  and cut layers are recognized and sized correctly.
- Fixture set (stored in `/src/testdata/`): a small sticker, a donut
  sticker with an interior hole, a sticker positioned right at a tile
  boundary. Pack + export by hand and eyeball the outputs.

No unit-test framework is added in this project.

## Implementation phasing

Each step leaves the app in a working state:

1. Canvas presets (A4 / Cricut buttons in the sidebar).
2. `view` state + "Export for Cricut" button + placeholder CricutExport
   view. Shell only, no logic.
3. `src/cricut/contour.ts` — cut-contour extraction over a single
   `ImageBitmap`.
4. `src/cricut/tiles.ts` — tile grid + centroid assignment.
5. `src/cricut/export.ts` — SVG assembly and zip packaging.
6. CricutExport view wiring — controls, overlays, download button.
7. Overhang warning highlights.

## Open questions / deferred

- Moving contour extraction to a Web Worker if the main-thread version
  feels slow on large packs. Defer until measured.
- Cut-line color control. Fixed to black for v1.
- Per-sticker bleed overrides. Global slider only for v1.
- Direct-cut SVG (no print layer) for vinyl-cutting workflows. Not in v1.

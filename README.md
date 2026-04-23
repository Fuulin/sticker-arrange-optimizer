# Sticker Optimizer

Alpha-aware PNG sticker packer. Upload a set of PNG stickers with complex
shapes, set a quantity per sticker and a canvas size, and the app round-robin
places as many as will fit — respecting each sticker's actual opaque shape
(not just its bounding box) and a configurable feather margin.

## Features

- **Custom canvas size** with live re-packing as you type.
- **Per-sticker quantity** — round-robin insertion so every sticker gets a
  fair share before any one hogs the space.
- **Alpha-shape packing** — uses each PNG's transparency mask so complex
  shapes nest tightly.
- **Feather margin** — guaranteed clearance (default 5 px) between opaque
  pixels of any two stickers.
- **Quality slider** — trade packing precision for speed (1/2/4/8 px grid).
- **Optional 90° rotations** — try all four orientations for tighter fits.
- **Web Worker** — packing runs off the main thread; the UI stays smooth.
- **Download PNG** — export the packed canvas at full resolution.

## Stack

- React 18 + TypeScript + Vite
- Tailwind CSS for styling
- Lucide icons
- `OffscreenCanvas` / `ImageBitmap` for GPU-free alpha extraction

## Getting started

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

## How the packing works

1. For each sticker we render up to 4 rotated variants, crop each to its
   opaque bounding box, and build a binary mask at a downsampled grid
   resolution (controlled by the **Quality** setting).
2. Each mask is dilated by `margin / stride` cells in every direction. The
   dilated mask is used for *collision checks*; the undilated mask is used
   to *stamp* the occupancy grid. The result is exactly `margin` pixels of
   clearance between any two stickers' opaque regions.
3. A round-robin loop tries to place one copy of each sticker per pass.
   Within a pass we scan top-left → bottom-right for the first position
   that fits, preferring the larger-footprint rotation variant when
   rotations are enabled. The loop stops when a full pass places nothing.
4. Placements (bitmap index, x, y) are sent back to the main thread along
   with the rotated-cropped bitmaps, and drawn to a preview `<canvas>`.

## Build

```bash
npm run build
npm run preview
```
# sticker-arrange-optimizer

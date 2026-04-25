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
 * channel is greater than or equal to `alphaThreshold` (0..255) count as
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
    out[i] = img[j] >= alphaThreshold ? 1 : 0;
  }
  return { width: w, height: h, data: out };
}

/**
 * Chebyshev (square-neighborhood) dilation by `radius` pixels. The
 * returned mask covers every original pixel plus every pixel within
 * `radius` cells on any of the 8 axes. A zero or negative radius returns
 * a copy of the input mask.
 *
 * Implementation: two-pass separable dilation (horizontal then vertical).
 * Naïve window scan with early-break on first set bit; O(w * h * radius)
 * worst case, faster in practice on dense masks.
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

/**
 * Pad a mask with `pad` pixels of background on every side. Returned
 * coordinates are shifted by `(pad, pad)`; subtract that off to map
 * back to the original mask's coordinate frame.
 */
function padMask(mask: BinaryMask, pad: number): BinaryMask {
  if (pad <= 0) return { ...mask, data: new Uint8Array(mask.data) };
  const w = mask.width + pad * 2;
  const h = mask.height + pad * 2;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < mask.height; y++) {
    out.set(
      mask.data.subarray(y * mask.width, (y + 1) * mask.width),
      (y + pad) * w + pad,
    );
  }
  return { width: w, height: h, data: out };
}

/**
 * Full pipeline: ImageBitmap → list of simplified, closed polylines in
 * bitmap-pixel coordinates, each offset outward by `bleedPx` pixels.
 * A single sticker with an interior hole yields two polylines (outer
 * and inner). Fully transparent bitmaps yield an empty array.
 *
 * The mask is padded by `bleedPx + 1` before dilation so the cut
 * contour can extend cleanly past the bitmap's original bounds —
 * otherwise large bleeds get clipped into a rectangular silhouette
 * instead of an organic offset of the original alpha shape.
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
  const pad = Math.max(0, Math.floor(bleedPx)) + 1;
  const padded = padMask(mask, pad);
  const expanded = dilate(padded, bleedPx);
  const raw = traceContours(expanded);
  const out: Polyline[] = [];
  for (const p of raw) {
    const simplified = simplifyPolyline(p, simplifyTolPx);
    // Drop degenerate contours from anti-aliasing noise: a real closed
    // path needs at least 3 distinct vertices to enclose any area.
    if (simplified.length < 3) continue;
    out.push(simplified.map((pt) => ({ x: pt.x - pad, y: pt.y - pad })));
  }
  return out;
}

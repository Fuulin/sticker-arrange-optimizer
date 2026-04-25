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

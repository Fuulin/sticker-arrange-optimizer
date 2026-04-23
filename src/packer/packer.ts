import type {
  PackResult,
  Placement,
  SerializablePackRequest,
} from "./types";

/*
 * Brute-force alpha-aware sticker packer.
 *
 * Pipeline:
 *   1. For each sticker, generate N rotated variants (N = 360 / rotationStep).
 *      Each variant is cropped to its opaque bbox, rasterized once at full
 *      resolution, and analysed at grid resolution (downsampled by `stride`).
 *   2. For each variant build a tight binary mask (opaque pixels) and a
 *      dilated mask inflated by `margin / stride` cells on every side. The
 *      dilated mask is used for collision tests, the undilated mask is used
 *      to stamp the occupancy grid — giving exactly `margin` px clearance.
 *   3. Maintain (a) an occupancy grid and (b) a summed-area table (integral
 *      image) of the grid. The integral image lets us reject whole placement
 *      rectangles in O(1): if the mask-bbox region has zero occupancy, the
 *      position is free without a per-pixel test. Integral image is rebuilt
 *      once per placement.
 *   4. Round-robin over stickers: on every pass, each sticker with remaining
 *      quantity gets one placement attempt. For each attempt we brute-force
 *      every rotation variant and every grid position (top-left scan) and
 *      accept the first fit. The outer loop stops when a full pass places
 *      nothing — i.e. when no sticker fits at any angle at any position.
 */

/**
 * Binary mask, bitpacked row-major. Each row is `rowWords` 32-bit words
 * (32 cells per word, bit 0 = column 0). Bits beyond column w in the last
 * word are always 0. Packing gives ~32x fewer ops for collision/stamp.
 */
interface Mask {
  data: Uint32Array;
  w: number;
  h: number;
  rowWords: number;
}

function emptyMask(w: number, h: number): Mask {
  const rowWords = Math.max(1, (w + 31) >>> 5);
  return { data: new Uint32Array(rowWords * h), w, h, rowWords };
}

interface Variant {
  /**
   * Cropped rotated bitmap. Lives on the lead worker only \u2014 helper
   * workers that receive deserialized variants set this to null, since
   * only masks are needed for collision and stamping.
   */
  bitmap: ImageBitmap | null;
  width: number; // canvas px
  height: number; // canvas px
  mask: Mask;
  dilated: Mask;
  dilatedOffsetX: number; // in grid cells, relative to bitmap origin
  dilatedOffsetY: number;
  rotationDeg: number;
}

// ---------- mask utilities ----------

function extractMask(
  ctx: OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
  alphaThreshold: number,
): Mask {
  const img = ctx.getImageData(0, 0, w, h).data;
  const m = emptyMask(w, h);
  const rw = m.rowWords;
  const md = m.data;
  let p = 3;
  for (let y = 0; y < h; y++) {
    const base = y * rw;
    for (let x = 0; x < w; x++, p += 4) {
      if (img[p] >= alphaThreshold) md[base + (x >>> 5)] |= 1 << (x & 31);
    }
  }
  return m;
}

/**
 * Chebyshev dilation by r cells, padded by r on every side. Two passes
 * (horizontal then vertical), both bitwise on the packed row words. The
 * horizontal pass ORs the source row into the destination at each of the
 * 2r+1 offsets 0..2r (cell-index shift = word shift + bit shift with carry).
 * The vertical pass ORs each horizontally-dilated row into rows [y, y+2r].
 */
function dilate(mask: Mask, r: number): { mask: Mask; pad: number } {
  if (r <= 0) return { mask, pad: 0 };
  const w1 = mask.w + 2 * r;
  const h1 = mask.h;
  const horiz = emptyMask(w1, h1);
  const srcRW = mask.rowWords;
  const dstRW = horiz.rowWords;
  const sData = mask.data;
  const hData = horiz.data;
  for (let y = 0; y < h1; y++) {
    const sBase = y * srcRW;
    const dBase = y * dstRW;
    for (let k = 0; k <= 2 * r; k++) {
      const wordShift = k >>> 5;
      const bitShift = k & 31;
      if (bitShift === 0) {
        for (let i = 0; i < srcRW; i++) {
          const s = sData[sBase + i];
          if (s !== 0) hData[dBase + i + wordShift] |= s;
        }
      } else {
        const invShift = 32 - bitShift;
        let carry = 0;
        for (let i = 0; i < srcRW; i++) {
          const s = sData[sBase + i];
          hData[dBase + i + wordShift] |= (s << bitShift) | carry;
          carry = s >>> invShift;
        }
        const tail = dBase + srcRW + wordShift;
        if (carry !== 0 && tail < dBase + dstRW) hData[tail] |= carry;
      }
    }
  }
  const h2 = h1 + 2 * r;
  const vert = emptyMask(w1, h2);
  const rw = dstRW;
  const vData = vert.data;
  for (let sy = 0; sy < h1; sy++) {
    const sBase = sy * rw;
    for (let k = 0; k <= 2 * r; k++) {
      const dBase = (sy + k) * rw;
      for (let i = 0; i < rw; i++) {
        const s = hData[sBase + i];
        if (s !== 0) vData[dBase + i] |= s;
      }
    }
  }
  return { mask: vert, pad: r };
}

// ---------- occupancy + integral image ----------

class Occupancy {
  readonly w: number;
  readonly h: number;
  /**
   * rowWords = ceil(w/32) + 1. The extra sentinel word lets shifted
   * collision/stamp safely read the next word without a bounds check:
   * cells beyond column w are never set, so the sentinel is always 0.
   */
  readonly rowWords: number;
  readonly data: Uint32Array;
  /** Integral image of `data` (unpacked sums), size (w+1)*(h+1). */
  private integral: Int32Array;
  /**
   * Scratch buffer used by `probeCollision` to hold the bitpacked
   * `col_set` of a colliding mask row (columns in mask-local coords where
   * the mask overlaps occupied cells). Grown on demand.
   */
  private scratch: Uint32Array;
  /**
   * Smallest row index that has been modified since the last integral
   * rebuild. `ensureIntegral` then only rebuilds [dirtyMinY, h). Rows
   * above dirtyMinY are unchanged, and their cumulative row-ends in the
   * integral are still valid — making most rebuilds near-free after the
   * occupancy fills top-down.
   */
  private dirtyMinY: number;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.rowWords = ((w + 31) >>> 5) + 1;
    this.data = new Uint32Array(this.rowWords * h);
    this.integral = new Int32Array((w + 1) * (h + 1));
    this.scratch = new Uint32Array(16);
    this.dirtyMinY = 0;
  }

  ensureIntegral() {
    if (this.dirtyMinY >= this.h) return;
    const W = this.w;
    const H = this.h;
    const IW = W + 1;
    const data = this.data;
    const I = this.integral;
    const RW = this.rowWords;
    for (let y = this.dirtyMinY; y < H; y++) {
      let rowSum = 0;
      const prevRow = y * IW;
      const row = (y + 1) * IW;
      const base = y * RW;
      for (let x = 0; x < W; x++) {
        rowSum += (data[base + (x >>> 5)] >>> (x & 31)) & 1;
        I[row + x + 1] = rowSum + I[prevRow + x + 1];
      }
    }
    this.dirtyMinY = H;
  }

  /** Sum of data[y:y+h, x:x+w]. Assumes integral is up-to-date. */
  regionSum(x: number, y: number, w: number, h: number): number {
    const I = this.integral;
    const IW = this.w + 1;
    const x2 = x + w;
    const y2 = y + h;
    return (
      I[y2 * IW + x2] - I[y * IW + x2] - I[y2 * IW + x] + I[y * IW + x]
    );
  }

  /**
   * Probe whether the mask collides at (px, py) and, if so, return a sound
   * forward skip distance k >= 1 such that every px' in (px, px+k) is
   * guaranteed to also collide. Returns 0 when the mask does NOT collide
   * (position is free).
   *
   * Skip derivation
   * ---------------
   * Walk mask rows until one has a non-zero collision bitmap
   * `col_set = mask_row(my) AND occ_window(py+my, px)` (the mask-local
   * columns where the mask touches occupied cells). The same occ cells
   * remain occupied at any px' > px, so for px' = px+k the occ cell that
   * was struck by mask col `s` is now under mask col `s-k`. Thus px+k
   * still collides iff `(mask_row << k) & col_set != 0` (bit s-k of the
   * original mask_row mapped to bit s via a left shift of k). The
   * smallest k >= 1 for which that AND is zero is the first px' we
   * can't prove collides — a sound skip. Upper bound k <= mw (when the
   * shifted mask has no bits at positions <= max(col_set)).
   *
   * Multi-row skip
   * --------------
   * Position px+k is proven to collide iff AT LEAST ONE of the probed
   * rows still collides at k. Per-row skip d_i is the smallest k where
   * row i stops colliding. So the overall sound skip is `max_i d_i`:
   * for any k < max d_i, some row (the one with d_i > k) is still
   * colliding, hence px+k is guaranteed to collide. At k = max d_i,
   * no row provably still collides, so it's the first position we must
   * re-probe. Strictly tighter than the single-row skip.
   */
  probeCollision(m: Mask, px: number, py: number): number {
    const occ = this.data;
    const oRW = this.rowWords;
    const mRW = m.rowWords;
    const md = m.data;
    const mw = m.w;
    const shift = px & 31;
    const wordOff = px >>> 5;
    if (this.scratch.length < mRW) this.scratch = new Uint32Array(mRW);
    const colSet = this.scratch;
    const inv = 32 - shift;
    let maxSkip = 0;

    for (let y = 0; y < m.h; y++) {
      const mBase = y * mRW;
      const oBase = (py + y) * oRW + wordOff;
      let any = 0;
      if (shift === 0) {
        for (let i = 0; i < mRW; i++) {
          const c = md[mBase + i] & occ[oBase + i];
          colSet[i] = c;
          any |= c;
        }
      } else {
        for (let i = 0; i < mRW; i++) {
          const mwWord = md[mBase + i];
          let c = 0;
          if (mwWord !== 0) {
            const win =
              (occ[oBase + i] >>> shift) | (occ[oBase + i + 1] << inv);
            c = mwWord & win;
          }
          colSet[i] = c;
          any |= c;
        }
      }
      if (any === 0) continue;
      const rowSkip = skipForCollision(md, mBase, colSet, mRW, mw);
      if (rowSkip > maxSkip) maxSkip = rowSkip;
    }
    return maxSkip;
  }

  stamp(m: Mask, px: number, py: number) {
    const occ = this.data;
    const oRW = this.rowWords;
    const mRW = m.rowWords;
    const md = m.data;
    const shift = px & 31;
    const wordOff = px >>> 5;
    if (shift === 0) {
      for (let y = 0; y < m.h; y++) {
        const mBase = y * mRW;
        const oBase = (py + y) * oRW + wordOff;
        for (let i = 0; i < mRW; i++) occ[oBase + i] |= md[mBase + i];
      }
    } else {
      const inv = 32 - shift;
      for (let y = 0; y < m.h; y++) {
        const mBase = y * mRW;
        const oBase = (py + y) * oRW + wordOff;
        for (let i = 0; i < mRW; i++) {
          const mw = md[mBase + i];
          if (mw === 0) continue;
          occ[oBase + i] |= mw << shift;
          occ[oBase + i + 1] |= mw >>> inv;
        }
      }
    }
    if (py < this.dirtyMinY) this.dirtyMinY = py;
  }

  /** Mark every cell inside [x, x+w) × [y, y+h) as occupied. */
  blockRect(x: number, y: number, w: number, h: number) {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.w, x + w);
    const y1 = Math.min(this.h, y + h);
    if (x1 <= x0 || y1 <= y0) return;
    const data = this.data;
    const RW = this.rowWords;
    const wStart = x0 >>> 5;
    const wEnd = (x1 - 1) >>> 5;
    const loBit = x0 & 31;
    const hiBit = (x1 - 1) & 31;
    // JS `1 << 32` wraps to 1, so mask-of-N-bits needs a guard when N=32.
    const lowMask = (loBit === 0 ? 0xffffffff : (0xffffffff << loBit)) >>> 0;
    const highMask =
      hiBit === 31 ? 0xffffffff : ((1 << (hiBit + 1)) - 1) >>> 0;
    if (wStart === wEnd) {
      const single = (lowMask & highMask) >>> 0;
      for (let yy = y0; yy < y1; yy++) data[yy * RW + wStart] |= single;
    } else {
      for (let yy = y0; yy < y1; yy++) {
        const base = yy * RW;
        data[base + wStart] |= lowMask;
        for (let wi = wStart + 1; wi < wEnd; wi++) data[base + wi] = 0xffffffff;
        data[base + wEnd] |= highMask;
      }
    }
    if (y0 < this.dirtyMinY) this.dirtyMinY = y0;
  }
}

// ---------- variant construction ----------

async function buildVariant(
  bitmap: ImageBitmap,
  rotationDeg: number,
  alphaThreshold: number,
  stride: number,
  marginCells: number,
): Promise<Variant | null> {
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const outW = Math.max(1, Math.ceil(srcW * cos + srcH * sin));
  const outH = Math.max(1, Math.ceil(srcW * sin + srcH * cos));

  const full = new OffscreenCanvas(outW, outH);
  const fctx = full.getContext("2d");
  if (!fctx) return null;
  fctx.translate(outW / 2, outH / 2);
  fctx.rotate(rad);
  fctx.drawImage(bitmap, -srcW / 2, -srcH / 2);

  const gW = Math.max(1, Math.ceil(outW / stride));
  const gH = Math.max(1, Math.ceil(outH / stride));
  const gc = new OffscreenCanvas(gW, gH);
  const gctx = gc.getContext("2d", { willReadFrequently: true });
  if (!gctx) return null;
  gctx.imageSmoothingEnabled = true;
  gctx.drawImage(full, 0, 0, gW, gH);
  const fullMask = extractMask(gctx, gW, gH, alphaThreshold);

  // Opaque-bbox scan on the bitpacked mask: walk words, skip empty ones, and
  // use clz32/ctz-equivalent bit math to get first/last set column cheaply.
  const fmData = fullMask.data;
  const fmRW = fullMask.rowWords;
  let minX = gW,
    minY = gH,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < gH; y++) {
    const base = y * fmRW;
    let rowMin = -1;
    let rowMax = -1;
    for (let i = 0; i < fmRW; i++) {
      const w = fmData[base + i];
      if (w === 0) continue;
      // ctz: lowest set bit index in this word.
      const low = 31 - Math.clz32(w & -w);
      // msb: highest set bit index in this word.
      const high = 31 - Math.clz32(w);
      const firstCol = i * 32 + low;
      const lastCol = i * 32 + high;
      if (rowMin < 0 || firstCol < rowMin) rowMin = firstCol;
      if (lastCol > rowMax) rowMax = lastCol;
    }
    if (rowMin < 0) continue;
    if (rowMin < minX) minX = rowMin;
    if (rowMax > maxX) maxX = rowMax;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;

  const cropX = Math.max(0, minX * stride);
  const cropY = Math.max(0, minY * stride);
  const cropW = Math.min(outW, (maxX + 1) * stride) - cropX;
  const cropH = Math.min(outH, (maxY + 1) * stride) - cropY;
  if (cropW <= 0 || cropH <= 0) return null;

  const cropped = new OffscreenCanvas(cropW, cropH);
  const cctx = cropped.getContext("2d");
  if (!cctx) return null;
  cctx.drawImage(full, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  const croppedBitmap = cropped.transferToImageBitmap();

  // Crop the bitpacked mask. For each destination row y, read bits
  // [minX, maxX] from source row (y+minY) and splice into destination
  // starting at bit 0 via word-aligned shift + carry.
  const tW = maxX - minX + 1;
  const tH = maxY - minY + 1;
  const tight = emptyMask(tW, tH);
  const tRW = tight.rowWords;
  const tData = tight.data;
  const srcWordOff = minX >>> 5;
  const srcShift = minX & 31;
  const srcInv = 32 - srcShift;
  for (let y = 0; y < tH; y++) {
    const sBase = (y + minY) * fmRW + srcWordOff;
    const dBase = y * tRW;
    if (srcShift === 0) {
      for (let i = 0; i < tRW; i++) tData[dBase + i] = fmData[sBase + i] | 0;
    } else {
      for (let i = 0; i < tRW; i++) {
        const lo = fmData[sBase + i] >>> srcShift;
        const hi = fmData[sBase + i + 1] << srcInv;
        tData[dBase + i] = (lo | hi) >>> 0;
      }
    }
    // Clear bits beyond column tW in the last word.
    const tailBits = tW & 31;
    if (tailBits !== 0) {
      const mask = ((1 << tailBits) - 1) >>> 0;
      tData[dBase + tRW - 1] &= mask;
    }
  }
  const { mask: dilated, pad } = dilate(tight, marginCells);

  return {
    bitmap: croppedBitmap,
    width: cropW,
    height: cropH,
    mask: tight,
    dilated,
    dilatedOffsetX: -pad,
    dilatedOffsetY: -pad,
    rotationDeg,
  };
}

// ---------- main pack ----------

export interface PackCallbacks {
  /** Fires with monotonic best-so-far placed count. */
  onProgress?: (placed: number, requested: number) => void;
  /**
   * Fires once, right after variant construction, before any attempts.
   * Callee takes ownership of the bitmaps (the worker transfers them to
   * the main thread; nothing in `pack()` uses them after this point).
   */
  onVariants?: (variantBitmaps: Record<string, ImageBitmap[]>) => void;
  /**
   * Fires every time the packer finds a strictly better layout. Drives
   * the live-preview stream so the UI shows the layout progressively
   * improving instead of sitting idle until the whole search completes.
   */
  onImprove?: (snapshot: {
    placements: Placement[];
    requested: number;
    placed: number;
    perSticker: Record<string, { requested: number; placed: number }>;
    bboxCoverage: number;
  }) => void;
}

export async function pack(
  req: SerializablePackRequest,
  cb: PackCallbacks = {},
): Promise<PackResult> {
  const { onProgress, onVariants, onImprove } = cb;
  const stride = Math.max(1, Math.floor(req.stride));
  const gridW = Math.max(1, Math.floor(req.canvasWidth / stride));
  const gridH = Math.max(1, Math.floor(req.canvasHeight / stride));
  const marginCells = Math.max(0, Math.round(req.margin / stride));
  const pad = req.padding;
  const padCellsL = pad ? Math.max(0, Math.round(pad.left / stride)) : 0;
  const padCellsR = pad ? Math.max(0, Math.round(pad.right / stride)) : 0;
  const padCellsT = pad ? Math.max(0, Math.round(pad.top / stride)) : 0;
  const padCellsB = pad ? Math.max(0, Math.round(pad.bottom / stride)) : 0;
  const applyPadding = (occ: Occupancy) => {
    if (padCellsL > 0) occ.blockRect(0, 0, padCellsL, gridH);
    if (padCellsR > 0) occ.blockRect(gridW - padCellsR, 0, padCellsR, gridH);
    if (padCellsT > 0) occ.blockRect(0, 0, gridW, padCellsT);
    if (padCellsB > 0) occ.blockRect(0, gridH - padCellsB, gridW, padCellsB);
  };

  // Rotation list.
  const step = Math.max(0, req.rotationStepDeg);
  const rotations: number[] =
    step <= 0 ? [0] : buildRotationList(step);

  // Build variants for each sticker.
  const stickerVariants = new Map<string, Variant[]>();
  const variantBitmaps: Record<string, ImageBitmap[]> = {};
  for (const s of req.stickers) {
    const list: Variant[] = [];
    for (const r of rotations) {
      const v = await buildVariant(
        s.bitmap,
        r,
        req.alphaThreshold,
        stride,
        marginCells,
      );
      if (v) list.push(v);
    }
    // Dedupe variants that produce identical masks (e.g. 180° of a symmetric sticker).
    const uniq: Variant[] = [];
    for (const v of list) {
      const dup = uniq.find(
        (u) =>
          u.mask.w === v.mask.w &&
          u.mask.h === v.mask.h &&
          maskEquals(u.mask, v.mask),
      );
      if (!dup) uniq.push(v);
    }
    stickerVariants.set(s.id, uniq);
    // Bitmaps are always set in the variant-building path (only helper-
    // worker deserialization nulls them), so the cast is safe.
    variantBitmaps[s.id] = uniq.map((v) => v.bitmap as ImageBitmap);
  }

  // Hand the bitmaps to the caller up-front. The worker transfers them
  // to the main thread here, so the subsequent pack loop must not touch
  // `variantBitmaps` or the Variant.bitmap fields again (findPlacement
  // and probeExtraFits operate purely on masks — confirmed safe).
  onVariants?.(variantBitmaps);

  // Total quantity across all stickers (constant across attempts).
  let totalRequested = 0;
  for (const s of req.stickers) totalRequested += s.quantity;

  // --------------------------------------------------------------------
  // Multi-start: the packing problem is order-sensitive (a greedy run
  // that places big items first leaves different gaps than one that
  // places small items first). We run several attempts with different
  // orderings and keep the result that placed the most stickers. The
  // cost multiplier is modest because most runs terminate early once
  // every sticker has been tried at every remaining position.
  // --------------------------------------------------------------------
  const ids = req.stickers.map((s) => s.id);
  // Rank by the 0° variant's bbox area as a cheap "physical size" proxy.
  const areaById = new Map<string, number>();
  for (const id of ids) {
    const vs = stickerVariants.get(id);
    const v = vs?.[0];
    areaById.set(id, v ? v.width * v.height : 0);
  }
  const byAreaDesc = [...ids].sort(
    (a, b) => (areaById.get(b) ?? 0) - (areaById.get(a) ?? 0),
  );
  const byAreaAsc = [...byAreaDesc].reverse();
  const orderings: string[][] = [
    byAreaDesc, // biggest first — classic bin-packing heuristic
    byAreaAsc, // smallest first — occasionally wins on dense, similar-sized sets
    ids, // user's declaration order
    shuffled(ids, 17),
    shuffled(ids, 91),
    shuffled(ids, 233),
  ];

  let best: AttemptResult | null = null;
  let bestProgressPlaced = 0;

  const runOne = (ord: string[]) => {
    const attempt = runAttempt(
      ord,
      stickerVariants,
      stride,
      gridW,
      gridH,
      req,
      applyPadding,
      (placed) => {
        // Emit upward progress only — avoid making the UI bar jump back
        // between attempts.
        if (placed > bestProgressPlaced) {
          bestProgressPlaced = placed;
          onProgress?.(placed, totalRequested);
        }
      },
    );
    if (
      !best ||
      attempt.placedCount > best.placedCount ||
      (attempt.placedCount === best.placedCount &&
        attempt.bboxArea > best.bboxArea)
    ) {
      best = attempt;
      if (attempt.placedCount > bestProgressPlaced) {
        bestProgressPlaced = attempt.placedCount;
        onProgress?.(attempt.placedCount, totalRequested);
      }
      // Live-stream the improved layout so the UI can render it before
      // the full search completes. `placements` is owned by `attempt` and
      // not mutated by later attempts (each runAttempt makes its own
      // array), so it's safe to hand over by reference.
      onImprove?.({
        placements: attempt.placements,
        requested: totalRequested,
        placed: attempt.placedCount,
        perSticker: attempt.perSticker,
        bboxCoverage:
          attempt.bboxArea / (req.canvasWidth * req.canvasHeight || 1),
      });
    }
  };

  // Phase 1: seeded orderings (deterministic, always run).
  for (const ord of orderings) {
    runOne(ord);
    const cur = best as AttemptResult | null;
    if (cur && cur.placedCount === totalRequested) break;
  }

  // Phase 2: if anything is still unplaced, keep shuffling and retrying
  // within a wall-clock budget. This is the "shift things around" pass —
  // each shuffle is a fresh greedy run from scratch, so two tightly-
  // packed stickers that previously blocked a third may land elsewhere
  // this time, freeing up the exact pocket the unplaced sticker needs.
  const HARD_BUDGET_MS = 4000;
  const startTime = performance.now();
  let seed = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const cur = best as AttemptResult | null;
    if (!cur) break;
    if (cur.placedCount === totalRequested) break;
    if (performance.now() - startTime >= HARD_BUDGET_MS) break;
    runOne(shuffled(ids, seed++));
  }

  // Defensive fallback (shouldn't happen — orderings is non-empty).
  if (!best) {
    best = runAttempt(
      ids,
      stickerVariants,
      stride,
      gridW,
      gridH,
      req,
      applyPadding,
    );
  }

  const bboxCoverage =
    best.bboxArea / (req.canvasWidth * req.canvasHeight || 1);

  // Post-pack probe: greedily keep placing selected stickers into the
  // leftover space until nothing else fits, counting how many extras of
  // each would still have fit. This powers the "you could fit more" UI
  // drawer. Round-robin order keeps any one sticker from hogging space.
  const extraFits = probeExtraFits(
    best.occ,
    ids,
    stickerVariants,
  );

  return {
    placements: best.placements,
    requested: totalRequested,
    placed: best.placedCount,
    perSticker: best.perSticker,
    bboxCoverage,
    extraFits,
  };
}

/**
 * Probe how many more copies of each sticker would fit into the leftover
 * space. MUTATES `occ` (fine — we're done with it). Iteration is round-
 * robin over ids so fairness between stickers is maintained, matching the
 * UI intent of "here's a balanced way to use up the remaining area".
 */
function probeExtraFits(
  occ: Occupancy,
  ids: string[],
  stickerVariants: Map<string, Variant[]>,
): Record<string, number> {
  const extras: Record<string, number> = {};
  for (const id of ids) extras[id] = 0;
  const exhausted = new Set<string>();
  // Safety cap in case of pathological inputs (tiny stickers + huge canvas).
  const HARD_CAP = 2000;
  let produced = 0;
  let madeProgress = true;
  while (madeProgress && produced < HARD_CAP) {
    madeProgress = false;
    for (const id of ids) {
      if (exhausted.has(id)) continue;
      const variants = stickerVariants.get(id);
      if (!variants || variants.length === 0) {
        exhausted.add(id);
        continue;
      }
      occ.ensureIntegral();
      const hit = findPlacement(occ, variants);
      if (!hit) {
        exhausted.add(id);
        continue;
      }
      const v = variants[hit.vIdx];
      occ.stamp(v.mask, hit.x - v.dilatedOffsetX, hit.y - v.dilatedOffsetY);
      extras[id]++;
      produced++;
      madeProgress = true;
      if (produced >= HARD_CAP) break;
    }
  }
  return extras;
}

// ---------- attempt runner ----------

interface AttemptResult {
  placements: Placement[];
  perSticker: Record<string, { requested: number; placed: number }>;
  placedCount: number;
  bboxArea: number;
  /** Final occupancy grid (retained on the winning attempt only). */
  occ: Occupancy;
}

/**
 * Run a single greedy pack attempt with the given sticker-id ordering.
 * Each attempt creates its own occupancy grid so multiple attempts can
 * coexist in `pack()` without interfering.
 */
function runAttempt(
  order: string[],
  stickerVariants: Map<string, Variant[]>,
  stride: number,
  gridW: number,
  gridH: number,
  req: SerializablePackRequest,
  applyPadding: (occ: Occupancy) => void,
  onProgress?: (placed: number) => void,
): AttemptResult {
  const occ = new Occupancy(gridW, gridH);
  applyPadding(occ);
  const remaining = new Map<string, number>();
  const perSticker: Record<string, { requested: number; placed: number }> = {};
  for (const s of req.stickers) {
    remaining.set(s.id, s.quantity);
    perSticker[s.id] = { requested: s.quantity, placed: 0 };
  }
  const placements: Placement[] = [];
  /**
   * Stickers whose placement has already failed in a previous pass. Since
   * the occupancy grid only grows monotonically, a sticker that can't fit
   * now will never fit later — safe to skip on every subsequent pass.
   */
  const exhausted = new Set<string>();
  let placedCount = 0;
  let bboxArea = 0;

  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    for (const id of order) {
      const left = remaining.get(id) ?? 0;
      if (left <= 0) continue;
      if (exhausted.has(id)) continue;
      const variants = stickerVariants.get(id);
      if (!variants || variants.length === 0) {
        exhausted.add(id);
        continue;
      }

      occ.ensureIntegral();
      const hit = findPlacement(occ, variants);
      if (!hit) {
        exhausted.add(id);
        continue;
      }
      const v = variants[hit.vIdx];
      const stampX = hit.x - v.dilatedOffsetX;
      const stampY = hit.y - v.dilatedOffsetY;
      occ.stamp(v.mask, stampX, stampY);
      placements.push({
        stickerId: id,
        x: stampX * stride,
        y: stampY * stride,
        rotation: v.rotationDeg,
        width: v.width,
        height: v.height,
        variantIdx: hit.vIdx,
      });
      remaining.set(id, left - 1);
      perSticker[id].placed++;
      placedCount++;
      bboxArea += v.width * v.height;
      madeProgress = true;
      onProgress?.(placedCount);
    }
  }

  return { placements, perSticker, placedCount, bboxArea, occ };
}

/** Deterministic Fisher–Yates shuffle using a seeded LCG (mulberry32). */
function shuffled(arr: string[], seed: number): string[] {
  const out = [...arr];
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildRotationList(stepDeg: number): number[] {
  const list: number[] = [];
  for (let a = 0; a < 360 - 1e-6; a += stepDeg) {
    list.push(Number(a.toFixed(4)));
  }
  return list;
}

/**
 * Smallest k >= 1 with `(mask_row << k) & colSet == 0` across all words.
 * Both inputs are bitpacked rows of `rw` 32-bit words; `mw` is the mask's
 * cell width and bounds the search (k in 1..mw suffices, see proof in
 * Occupancy.probeCollision).
 */
function skipForCollision(
  mask: Uint32Array,
  mBase: number,
  colSet: Uint32Array,
  rw: number,
  mw: number,
): number {
  for (let k = 1; k <= mw; k++) {
    const ws = k >>> 5;
    const bs = k & 31;
    let hit = false;
    if (bs === 0) {
      for (let i = 0; i < rw; i++) {
        const src = i - ws >= 0 ? mask[mBase + i - ws] : 0;
        if ((src & colSet[i]) !== 0) {
          hit = true;
          break;
        }
      }
    } else {
      const invBs = 32 - bs;
      for (let i = 0; i < rw; i++) {
        const a = i - ws >= 0 ? mask[mBase + i - ws] : 0;
        const b = i - ws - 1 >= 0 ? mask[mBase + i - ws - 1] : 0;
        const shifted = ((a << bs) | (b >>> invBs)) >>> 0;
        if ((shifted & colSet[i]) !== 0) {
          hit = true;
          break;
        }
      }
    }
    if (!hit) return k;
  }
  // Unreachable given the upper bound — returning mw+1 is still sound.
  return mw + 1;
}

function maskEquals(a: Mask, b: Mask): boolean {
  if (a.w !== b.w || a.h !== b.h) return false;
  const ad = a.data;
  const bd = b.data;
  const n = ad.length;
  for (let i = 0; i < n; i++) if (ad[i] !== bd[i]) return false;
  return true;
}

/**
 * Scan top-left → bottom-right across all variants and return the first fit.
 *
 * Inner loop optimisations
 * ------------------------
 * 1. Integral-image O(1) reject: if the dilated-bbox region has zero
 *    occupancy the variant trivially fits — accept immediately.
 * 2. Sound skip-forward: on collision, `probeCollision` returns a skip
 *    k >= 1 such that every x' in (x, x+k) is proven to also collide for
 *    that variant. Across variants tried at the same (x, y) we take the
 *    minimum skip, which is still sound (positions we jump over collide
 *    with *every* variant we tested). `minSkipEligible` bumps the skip
 *    up to the first x where the smallest variant is in-bounds — skipped
 *    positions were already out-of-bounds for every variant.
 * 3. Variant order cached once, not per-call.
 */
function findPlacement(
  occ: Occupancy,
  variants: Variant[],
): { x: number; y: number; vIdx: number } | null {
  const W = occ.w;
  const H = occ.h;
  // Try larger footprints first (packs tighter empirically).
  const order = variants
    .map((_, i) => i)
    .sort(
      (a, b) =>
        variants[b].dilated.w * variants[b].dilated.h -
        variants[a].dilated.w * variants[a].dilated.h,
    );
  // Smallest dilated width across variants — used to break out of the
  // row loop once x is too close to the right edge for *any* variant.
  let minMW = Infinity;
  for (const v of variants) {
    if (v.dilated.w < minMW) minMW = v.dilated.w;
  }
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x + minMW <= W) {
      let minSkip = Infinity;
      for (const vi of order) {
        const v = variants[vi];
        const mw = v.dilated.w;
        const mh = v.dilated.h;
        if (x + mw > W || y + mh > H) continue;
        const sum = occ.regionSum(x, y, mw, mh);
        if (sum === 0) return { x, y, vIdx: vi };
        const skip = occ.probeCollision(v.dilated, x, y);
        if (skip === 0) return { x, y, vIdx: vi };
        if (skip < minSkip) minSkip = skip;
      }
      // If no variant was in-bounds, minSkip stays Infinity; the while
      // guard (`x + minMW <= W`) guarantees at least the smallest variant
      // fits, so `minSkip` is always finite here.
      x += minSkip === Infinity ? 1 : minSkip;
    }
  }
  return null;
}

// ======================================================================
// Parallel-execution primitives
// ----------------------------------------------------------------------
// `pack()` above still works end-to-end in a single worker. The exports
// below let a *coordinator* worker fan out attempts across a pool of
// helper workers:
//
//   1. Coordinator calls `buildPackContext(req)` \u2014 produces the full
//      per-sticker variant set and the padding/grid config exactly once.
//   2. Coordinator calls `serializePackContext(ctx)` \u2014 produces a
//      structured-cloneable payload (mask buffers + metadata). Helpers
//      receive it via `postMessage` and rebuild their own `PackContext`
//      via `deserializePackContext`.
//   3. Each helper repeatedly receives an `order: string[]` and calls
//      `runAttemptInContext(ctx, order)` returning `{ result, occBuffer }`.
//      `occBuffer` is the bitpacked occupancy bytes; transferable.
//   4. Coordinator picks the best result; for the winner it reconstructs
//      an `Occupancy` from `occBuffer` via `occupancyFromBuffer` and calls
//      `probeExtraFitsInContext` to compute the "you could fit more"
//      numbers.
// ======================================================================

/**
 * Structured-cloneable snapshot of a single `Variant`. The mask buffers
 * are plain `ArrayBuffer`s so they can be cloned into each helper. We
 * never transfer (which would detach and break the coordinator's copy);
 * the JS structured-clone cost for a few MB is negligible next to the
 * packing work itself.
 */
export interface SerializedVariant {
  // `ArrayBufferLike` covers both `ArrayBuffer` and `SharedArrayBuffer`;
  // that's what `Uint32Array.prototype.buffer` returns under recent TS
  // lib definitions.
  maskBuf: ArrayBufferLike;
  maskW: number;
  maskH: number;
  maskRowWords: number;
  dilatedBuf: ArrayBufferLike;
  dilatedW: number;
  dilatedH: number;
  dilatedRowWords: number;
  dilatedOffsetX: number;
  dilatedOffsetY: number;
  width: number;
  height: number;
  rotationDeg: number;
}

export interface SerializedPackContext {
  stickerIds: string[];
  stickersVariants: Record<string, SerializedVariant[]>;
  stickersQty: Record<string, number>;
  stride: number;
  gridW: number;
  gridH: number;
  canvasWidth: number;
  canvasHeight: number;
  padCellsL: number;
  padCellsR: number;
  padCellsT: number;
  padCellsB: number;
  totalRequested: number;
}

/**
 * Runtime form of a pack context. Held by both coordinator and helpers.
 * Carries everything `runAttemptInContext` needs \u2014 variants, quantities,
 * padding \u2014 so an attempt is a pure function of `(ctx, order)`.
 */
export interface PackContext {
  stickerIds: string[];
  stickersVariants: Map<string, Variant[]>;
  stickersQty: Map<string, number>;
  stride: number;
  gridW: number;
  gridH: number;
  canvasWidth: number;
  canvasHeight: number;
  padCellsL: number;
  padCellsR: number;
  padCellsT: number;
  padCellsB: number;
  totalRequested: number;
  /** Blocks the padding bands on a freshly-constructed occupancy grid. */
  applyPadding: (occ: Occupancy) => void;
}

/**
 * Serializable result of one attempt. Same shape as the internal
 * `AttemptResult` minus the `Occupancy` object \u2014 that flies back as a
 * transferable `ArrayBuffer` via `AttemptEnvelope.occBuffer` instead.
 */
export interface AttemptSnapshot {
  placements: Placement[];
  perSticker: Record<string, { requested: number; placed: number }>;
  placedCount: number;
  bboxArea: number;
}

export interface AttemptEnvelope {
  result: AttemptSnapshot;
  occBuffer: ArrayBufferLike;
}

/**
 * Build variants + grid/padding config. Mirrors the upfront section of
 * `pack()` but returns a reusable `PackContext` and the sticker bitmaps
 * (which the coordinator will transfer to the main thread once).
 */
export async function buildPackContext(
  req: SerializablePackRequest,
): Promise<{
  ctx: PackContext;
  variantBitmaps: Record<string, ImageBitmap[]>;
}> {
  const stride = Math.max(1, Math.floor(req.stride));
  const gridW = Math.max(1, Math.floor(req.canvasWidth / stride));
  const gridH = Math.max(1, Math.floor(req.canvasHeight / stride));
  const marginCells = Math.max(0, Math.round(req.margin / stride));
  const pad = req.padding;
  const padCellsL = pad ? Math.max(0, Math.round(pad.left / stride)) : 0;
  const padCellsR = pad ? Math.max(0, Math.round(pad.right / stride)) : 0;
  const padCellsT = pad ? Math.max(0, Math.round(pad.top / stride)) : 0;
  const padCellsB = pad ? Math.max(0, Math.round(pad.bottom / stride)) : 0;
  const applyPadding = (occ: Occupancy) => {
    if (padCellsL > 0) occ.blockRect(0, 0, padCellsL, gridH);
    if (padCellsR > 0) occ.blockRect(gridW - padCellsR, 0, padCellsR, gridH);
    if (padCellsT > 0) occ.blockRect(0, 0, gridW, padCellsT);
    if (padCellsB > 0) occ.blockRect(0, gridH - padCellsB, gridW, padCellsB);
  };

  const step = Math.max(0, req.rotationStepDeg);
  const rotations: number[] = step <= 0 ? [0] : buildRotationList(step);

  const stickersVariants = new Map<string, Variant[]>();
  const variantBitmaps: Record<string, ImageBitmap[]> = {};
  for (const s of req.stickers) {
    const list: Variant[] = [];
    for (const r of rotations) {
      const v = await buildVariant(
        s.bitmap,
        r,
        req.alphaThreshold,
        stride,
        marginCells,
      );
      if (v) list.push(v);
    }
    const uniq: Variant[] = [];
    for (const v of list) {
      const dup = uniq.find(
        (u) =>
          u.mask.w === v.mask.w &&
          u.mask.h === v.mask.h &&
          maskEquals(u.mask, v.mask),
      );
      if (!dup) uniq.push(v);
    }
    stickersVariants.set(s.id, uniq);
    variantBitmaps[s.id] = uniq.map((v) => v.bitmap as ImageBitmap);
  }

  const stickerIds = req.stickers.map((s) => s.id);
  const stickersQty = new Map<string, number>();
  let totalRequested = 0;
  for (const s of req.stickers) {
    stickersQty.set(s.id, s.quantity);
    totalRequested += s.quantity;
  }

  const ctx: PackContext = {
    stickerIds,
    stickersVariants,
    stickersQty,
    stride,
    gridW,
    gridH,
    canvasWidth: req.canvasWidth,
    canvasHeight: req.canvasHeight,
    padCellsL,
    padCellsR,
    padCellsT,
    padCellsB,
    totalRequested,
    applyPadding,
  };
  return { ctx, variantBitmaps };
}

/** Coordinator-side \u2014 clones the mask buffers for transport to helpers. */
export function serializePackContext(ctx: PackContext): SerializedPackContext {
  const stickersVariants: Record<string, SerializedVariant[]> = {};
  for (const id of ctx.stickerIds) {
    const variants = ctx.stickersVariants.get(id) ?? [];
    stickersVariants[id] = variants.map((v) => ({
      // `.slice(0)` gives each helper its own detached copy \u2014 lets the
      // structured clone proceed without transferring (which would
      // detach the coordinator's copy and break subsequent helpers).
      maskBuf: v.mask.data.buffer.slice(0),
      maskW: v.mask.w,
      maskH: v.mask.h,
      maskRowWords: v.mask.rowWords,
      dilatedBuf: v.dilated.data.buffer.slice(0),
      dilatedW: v.dilated.w,
      dilatedH: v.dilated.h,
      dilatedRowWords: v.dilated.rowWords,
      dilatedOffsetX: v.dilatedOffsetX,
      dilatedOffsetY: v.dilatedOffsetY,
      width: v.width,
      height: v.height,
      rotationDeg: v.rotationDeg,
    }));
  }
  const stickersQty: Record<string, number> = {};
  for (const [k, v] of ctx.stickersQty) stickersQty[k] = v;
  return {
    stickerIds: [...ctx.stickerIds],
    stickersVariants,
    stickersQty,
    stride: ctx.stride,
    gridW: ctx.gridW,
    gridH: ctx.gridH,
    canvasWidth: ctx.canvasWidth,
    canvasHeight: ctx.canvasHeight,
    padCellsL: ctx.padCellsL,
    padCellsR: ctx.padCellsR,
    padCellsT: ctx.padCellsT,
    padCellsB: ctx.padCellsB,
    totalRequested: ctx.totalRequested,
  };
}

/** Helper-side \u2014 rebuild runtime `PackContext` from the cloned payload. */
export function deserializePackContext(s: SerializedPackContext): PackContext {
  const stickersVariants = new Map<string, Variant[]>();
  for (const id of s.stickerIds) {
    const variants: Variant[] = (s.stickersVariants[id] ?? []).map((sv) => ({
      bitmap: null,
      width: sv.width,
      height: sv.height,
      mask: {
        data: new Uint32Array(sv.maskBuf),
        w: sv.maskW,
        h: sv.maskH,
        rowWords: sv.maskRowWords,
      },
      dilated: {
        data: new Uint32Array(sv.dilatedBuf),
        w: sv.dilatedW,
        h: sv.dilatedH,
        rowWords: sv.dilatedRowWords,
      },
      dilatedOffsetX: sv.dilatedOffsetX,
      dilatedOffsetY: sv.dilatedOffsetY,
      rotationDeg: sv.rotationDeg,
    }));
    stickersVariants.set(id, variants);
  }
  const stickersQty = new Map<string, number>();
  for (const [k, v] of Object.entries(s.stickersQty)) stickersQty.set(k, v);
  const {
    gridW,
    gridH,
    padCellsL,
    padCellsR,
    padCellsT,
    padCellsB,
  } = s;
  const applyPadding = (occ: Occupancy) => {
    if (padCellsL > 0) occ.blockRect(0, 0, padCellsL, gridH);
    if (padCellsR > 0) occ.blockRect(gridW - padCellsR, 0, padCellsR, gridH);
    if (padCellsT > 0) occ.blockRect(0, 0, gridW, padCellsT);
    if (padCellsB > 0) occ.blockRect(0, gridH - padCellsB, gridW, padCellsB);
  };
  return {
    stickerIds: s.stickerIds,
    stickersVariants,
    stickersQty,
    stride: s.stride,
    gridW,
    gridH,
    canvasWidth: s.canvasWidth,
    canvasHeight: s.canvasHeight,
    padCellsL,
    padCellsR,
    padCellsT,
    padCellsB,
    totalRequested: s.totalRequested,
    applyPadding,
  };
}

/**
 * Run one greedy attempt and return a transferable result + occ buffer.
 * Pure w.r.t. the context \u2014 each call allocates its own `Occupancy`, so
 * helpers can reuse the same context across many attempts safely.
 */
export function runAttemptInContext(
  ctx: PackContext,
  order: string[],
): AttemptEnvelope {
  const occ = new Occupancy(ctx.gridW, ctx.gridH);
  ctx.applyPadding(occ);
  const remaining = new Map<string, number>();
  const perSticker: Record<string, { requested: number; placed: number }> = {};
  for (const id of ctx.stickerIds) {
    const q = ctx.stickersQty.get(id) ?? 0;
    remaining.set(id, q);
    perSticker[id] = { requested: q, placed: 0 };
  }
  const placements: Placement[] = [];
  const exhausted = new Set<string>();
  let placedCount = 0;
  let bboxArea = 0;

  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    for (const id of order) {
      const left = remaining.get(id) ?? 0;
      if (left <= 0) continue;
      if (exhausted.has(id)) continue;
      const variants = ctx.stickersVariants.get(id);
      if (!variants || variants.length === 0) {
        exhausted.add(id);
        continue;
      }
      occ.ensureIntegral();
      const hit = findPlacement(occ, variants);
      if (!hit) {
        exhausted.add(id);
        continue;
      }
      const v = variants[hit.vIdx];
      const stampX = hit.x - v.dilatedOffsetX;
      const stampY = hit.y - v.dilatedOffsetY;
      occ.stamp(v.mask, stampX, stampY);
      placements.push({
        stickerId: id,
        x: stampX * ctx.stride,
        y: stampY * ctx.stride,
        rotation: v.rotationDeg,
        width: v.width,
        height: v.height,
        variantIdx: hit.vIdx,
      });
      remaining.set(id, left - 1);
      perSticker[id].placed++;
      placedCount++;
      bboxArea += v.width * v.height;
      madeProgress = true;
    }
  }

  return {
    result: { placements, perSticker, placedCount, bboxArea },
    // Hand off the underlying buffer. The local `occ` goes out of scope
    // immediately after, so losing `data.buffer` is fine.
    occBuffer: occ.data.buffer,
  };
}

/**
 * Coordinator-side \u2014 rebuild an `Occupancy` from the bitpacked bytes of a
 * completed attempt so `probeExtraFitsInContext` can run on it.
 */
export function occupancyFromBuffer(
  w: number,
  h: number,
  buffer: ArrayBufferLike,
): Occupancy {
  const occ = new Occupancy(w, h);
  const incoming = new Uint32Array(buffer);
  // `Uint32Array.set` copies; dirtyMinY stays 0 so the integral image
  // will rebuild on first access \u2014 which is exactly what we want.
  occ.data.set(incoming);
  return occ;
}

/**
 * Coordinator-side finalize pass on the winning attempt. Equivalent to
 * the in-line `probeExtraFits(best.occ, ids, stickerVariants)` call that
 * the monolithic `pack()` does, but usable from outside this module.
 */
export function probeExtraFitsInContext(
  occ: Occupancy,
  ctx: PackContext,
): Record<string, number> {
  return probeExtraFits(occ, ctx.stickerIds, ctx.stickersVariants);
}

/**
 * Deterministic seeded shuffle for orderings \u2014 exposed so the
 * coordinator can generate the same ordering distribution as monolithic
 * `pack()` when it fans attempts out to helpers.
 */
export function shuffledIds(ids: string[], seed: number): string[] {
  return shuffled(ids, seed);
}

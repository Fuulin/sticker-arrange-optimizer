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

interface Mask {
  data: Uint8Array;
  w: number;
  h: number;
}

interface Variant {
  bitmap: ImageBitmap;
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
  const img = ctx.getImageData(0, 0, w, h);
  const data = new Uint8Array(w * h);
  for (let i = 0, p = 3; i < w * h; i++, p += 4) {
    if (img.data[p] >= alphaThreshold) data[i] = 1;
  }
  return { data, w, h };
}

/** Chebyshev dilation by r cells, padded by r on every side. */
function dilate(mask: Mask, r: number): { mask: Mask; pad: number } {
  if (r <= 0) return { mask, pad: 0 };
  const { w, h, data } = mask;
  const ow = w + 2 * r;
  const oh = h + 2 * r;
  const tmp = new Uint8Array(ow * h);
  for (let y = 0; y < h; y++) {
    const src = y * w;
    const dst = y * ow;
    for (let x = 0; x < w; x++) {
      if (data[src + x]) {
        const start = dst + x;
        for (let k = 0; k <= 2 * r; k++) tmp[start + k] = 1;
      }
    }
  }
  const out = new Uint8Array(ow * oh);
  for (let x = 0; x < ow; x++) {
    for (let y = 0; y < h; y++) {
      if (tmp[y * ow + x]) {
        for (let k = 0; k <= 2 * r; k++) out[(y + k) * ow + x] = 1;
      }
    }
  }
  return { mask: { data: out, w: ow, h: oh }, pad: r };
}

// ---------- occupancy + integral image ----------

class Occupancy {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;
  /** Integral image of `data`, size (w+1)*(h+1), Int32 for safety. */
  private integral: Int32Array;
  private integralDirty = true;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h);
    this.integral = new Int32Array((w + 1) * (h + 1));
  }

  rebuildIntegral() {
    const W = this.w;
    const H = this.h;
    const IW = W + 1;
    const data = this.data;
    const I = this.integral;
    // First row/col are already 0 (rebuild from scratch).
    I.fill(0);
    for (let y = 0; y < H; y++) {
      let rowSum = 0;
      const prevRow = y * IW;
      const row = (y + 1) * IW;
      for (let x = 0; x < W; x++) {
        rowSum += data[y * W + x];
        I[row + x + 1] = rowSum + I[prevRow + x + 1];
      }
    }
    this.integralDirty = false;
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

  collidesPixel(m: Mask, px: number, py: number): boolean {
    const occ = this.data;
    const W = this.w;
    const mw = m.w;
    const md = m.data;
    for (let y = 0; y < m.h; y++) {
      const orow = (py + y) * W + px;
      const mrow = y * mw;
      for (let x = 0; x < mw; x++) {
        if (md[mrow + x] && occ[orow + x]) return true;
      }
    }
    return false;
  }

  stamp(m: Mask, px: number, py: number) {
    const occ = this.data;
    const W = this.w;
    const mw = m.w;
    const md = m.data;
    for (let y = 0; y < m.h; y++) {
      const orow = (py + y) * W + px;
      const mrow = y * mw;
      for (let x = 0; x < mw; x++) {
        if (md[mrow + x]) occ[orow + x] = 1;
      }
    }
    this.integralDirty = true;
  }

  ensureIntegral() {
    if (this.integralDirty) this.rebuildIntegral();
  }

  /** Mark every cell inside [x, x+w) × [y, y+h) as occupied. */
  blockRect(x: number, y: number, w: number, h: number) {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.w, x + w);
    const y1 = Math.min(this.h, y + h);
    if (x1 <= x0 || y1 <= y0) return;
    const occ = this.data;
    const W = this.w;
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * W;
      for (let xx = x0; xx < x1; xx++) occ[row + xx] = 1;
    }
    this.integralDirty = true;
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

  let minX = gW,
    minY = gH,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < gH; y++) {
    for (let x = 0; x < gW; x++) {
      if (fullMask.data[y * gW + x]) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
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

  const tW = maxX - minX + 1;
  const tH = maxY - minY + 1;
  const tightData = new Uint8Array(tW * tH);
  for (let y = 0; y < tH; y++) {
    for (let x = 0; x < tW; x++) {
      tightData[y * tW + x] = fullMask.data[(y + minY) * gW + (x + minX)];
    }
  }
  const tight: Mask = { data: tightData, w: tW, h: tH };
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
    variantBitmaps[s.id] = uniq.map((v) => v.bitmap);
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

function maskEquals(a: Mask, b: Mask): boolean {
  if (a.w !== b.w || a.h !== b.h) return false;
  const n = a.data.length;
  for (let i = 0; i < n; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/**
 * Scan top-left → bottom-right across all variants and return the first fit.
 * Integral image lets us skip almost every empty region in O(1).
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
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (const vi of order) {
        const v = variants[vi];
        const mw = v.dilated.w;
        const mh = v.dilated.h;
        if (x + mw > W || y + mh > H) continue;
        // Fast reject: if the mask bbox has ANY occupancy, fall back to pixel test.
        // If the bbox is completely empty, the dilated mask trivially fits.
        const sum = occ.regionSum(x, y, mw, mh);
        if (sum === 0) return { x, y, vIdx: vi };
        // Partial overlap: might still fit around existing shapes.
        if (!occ.collidesPixel(v.dilated, x, y)) return { x, y, vIdx: vi };
      }
    }
  }
  return null;
}

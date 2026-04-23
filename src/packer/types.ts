export interface SerializablePackRequest {
  canvasWidth: number;
  canvasHeight: number;
  /** Feather margin (canvas px) maintained around every sticker. */
  margin: number;
  /**
   * Inset padding (canvas px) per edge. Placements are forbidden from
   * entering these bands — a "safe area" inside the canvas. Defaults to 0
   * on every side when omitted.
   */
  padding?: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
  /** Pack-grid downscale factor. 1=precise+slow, 8=fast+loose. */
  stride: number;
  /** Alpha cutoff [0..255] that counts as "opaque". */
  alphaThreshold: number;
  /**
   * Rotation step in degrees. 0 disables rotation entirely. Any positive
   * value V produces rotations {0, V, 2V, ...} < 360. E.g. 90 -> 4 variants,
   * 15 -> 24 variants.
   */
  rotationStepDeg: number;
  stickers: Array<{
    id: string;
    bitmap: ImageBitmap;
    quantity: number;
  }>;
}

export interface Placement {
  stickerId: string;
  /** Top-left of the cropped rotated variant, in canvas px. */
  x: number;
  y: number;
  /** Rotation applied, in degrees (0-359). */
  rotation: number;
  /** Cropped variant width/height in canvas px. */
  width: number;
  height: number;
  /** Index into the variant bitmap list for the sticker. */
  variantIdx: number;
}

/**
 * Lightweight snapshot of the packer's current best layout. Emitted
 * repeatedly as a `partial` message while the packer is still iterating
 * through orderings/shuffles; the UI renders whichever snapshot is
 * freshest so the user sees the layout improve live. Does NOT include
 * `variantBitmaps` — those are sent once up front via `VariantsMessage`
 * and retained on the main thread.
 */
export interface PackSnapshot {
  placements: Placement[];
  requested: number;
  placed: number;
  perSticker: Record<string, { requested: number; placed: number }>;
  bboxCoverage: number;
}

export interface PackResult extends PackSnapshot {
  /**
   * For each sticker id, how many additional copies would still fit on the
   * remaining canvas if the user increased its quantity. 0 means no more
   * fit. Computed greedily (round-robin) against the winning attempt's
   * leftover space. Only populated on the final `done` message.
   */
  extraFits: Record<string, number>;
}

export interface ProgressMessage {
  type: "progress";
  placed: number;
  requested: number;
}

/**
 * One-shot message emitted by the worker immediately after variant
 * construction and before any packing attempts. Carries the cropped,
 * rotated bitmaps keyed by sticker id; the main thread stores them and
 * pairs them with placement indices from subsequent `partial` / `done`
 * messages to render the canvas. Transferred, so the worker relinquishes
 * ownership.
 */
export interface VariantsMessage {
  type: "variants";
  variantBitmaps: Record<string, ImageBitmap[]>;
}

/**
 * Streaming update with the best layout found SO FAR. Emitted every time
 * the packer finds a strictly better solution, allowing the UI to update
 * live (and the user to download an intermediate PNG) while the packer
 * keeps searching.
 */
export interface PartialMessage {
  type: "partial";
  snapshot: PackSnapshot;
}

export interface DoneMessage {
  type: "done";
  result: PackResult;
}

/**
 * Follow-up message emitted AFTER `done`. Carries the "you could fit
 * more" numbers computed by probing the winning attempt's leftover
 * space. Decoupled from `done` because the probe can take a while on a
 * mostly-empty canvas with tiny stickers (round-robin greedy placement
 * up to a cap), and blocking the main `done` on it was making the UI
 * feel unresponsive even after a full pack was found.
 */
export interface ExtraFitsMessage {
  type: "extraFits";
  extraFits: Record<string, number>;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export type WorkerOutMessage =
  | ProgressMessage
  | VariantsMessage
  | PartialMessage
  | DoneMessage
  | ExtraFitsMessage
  | ErrorMessage;

export interface WorkerInMessage {
  type: "pack";
  request: SerializablePackRequest;
}

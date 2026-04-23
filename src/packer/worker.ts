/// <reference lib="webworker" />
// ======================================================================
// Coordinator worker.
//
// Owns the externally-visible worker protocol (see types.ts) that the
// main thread talks to. Internally spawns a pool of helper workers that
// each run pack attempts in parallel, so the 6 seeded orderings + any
// shuffled retries within the wall-clock budget can execute concurrently.
//
// Parallelisation wins
// --------------------
// - Phase 1 (deterministic seeded orderings): instead of 6 attempts
//   serialised, up to N run concurrently. On medium inputs where several
//   orderings each take a few hundred ms, this is a near-linear wall-
//   clock reduction.
// - Phase 2 (shuffle-until-budget): the 4 s budget is a hard wall-clock
//   cap. More concurrent workers → more attempts tried within the same
//   budget → better final pack quality, not faster wall-clock.
//
// Main-thread API is unchanged: the main thread still posts a single
// `pack` message and receives `variants` / `partial` / `progress` /
// `done` / `error`.
// ======================================================================
import {
  buildPackContext,
  serializePackContext,
  runAttemptInContext,
  occupancyFromBuffer,
  probeExtraFitsInContext,
  shuffledIds,
  type AttemptSnapshot,
} from "./packer";
import type {
  SerializablePackRequest,
  WorkerInMessage,
  WorkerOutMessage,
} from "./types";
import type {
  HelperInMessage,
  HelperOutMessage,
} from "./attempt-worker";

declare const self: DedicatedWorkerGlobalScope;

/**
 * One helper's lifecycle state, owned by the coordinator.
 *   - `busy` flips true on dispatch and back to false on "done"/"error".
 *   - `ready` flips true after the helper acks `init`.
 */
interface Helper {
  worker: Worker;
  busy: boolean;
  ready: boolean;
  attemptId: number | null;
}

const HARD_BUDGET_MS = 4000;

/**
 * How many helpers to spawn. Capped so we don't create more than the
 * number of attempts we actually want early on (6 seeded orderings),
 * and capped by `hardwareConcurrency` to avoid over-subscription. Falls
 * back to 4 when the API is unavailable.
 */
function helperCount(): number {
  const hw =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  // Leave one core for the coordinator + main thread.
  return Math.max(1, Math.min(6, hw - 1));
}

self.onmessage = async (e: MessageEvent<WorkerInMessage>) => {
  const msg = e.data;
  if (msg.type !== "pack") return;
  try {
    await runPack(msg.request);
  } catch (err) {
    const out: WorkerOutMessage = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(out);
  }
};

async function runPack(request: SerializablePackRequest): Promise<void> {
  // 1. Build variants once on the coordinator. Same work the monolithic
  //    `pack()` used to do inline — OffscreenCanvas rasterisation of
  //    every rotation, bitpacked mask extraction, dilation.
  const { ctx, variantBitmaps } = await buildPackContext(request);

  // 2. Hand the rendered bitmaps to the main thread. Transferring detaches
  //    them here, which is fine — the packing loop uses masks only.
  {
    const transfer: Transferable[] = [];
    for (const arr of Object.values(variantBitmaps)) {
      for (const b of arr) transfer.push(b);
    }
    const out: WorkerOutMessage = { type: "variants", variantBitmaps };
    self.postMessage(out, transfer);
  }

  // 3. Short-circuit if there's nothing to place.
  if (ctx.totalRequested === 0 || ctx.stickerIds.length === 0) {
    const out: WorkerOutMessage = {
      type: "done",
      result: {
        placements: [],
        requested: 0,
        placed: 0,
        perSticker: {},
        bboxCoverage: 0,
        extraFits: {},
      },
    };
    self.postMessage(out);
    return;
  }

  // 4. Spawn helper pool. Serialize the context once and clone it into
  //    each helper's init message (the helper makes its own detached
  //    copies of the mask buffers, so shuffles across helpers don't
  //    interfere).
  const N = helperCount();
  const serialized = serializePackContext(ctx);
  const helpers: Helper[] = [];
  for (let i = 0; i < N; i++) {
    const w = new Worker(
      new URL("./attempt-worker.ts", import.meta.url),
      { type: "module" },
    );
    helpers.push({ worker: w, busy: false, ready: false, attemptId: null });
  }
  await Promise.all(
    helpers.map(
      (h) =>
        new Promise<void>((resolve, reject) => {
          const onFirstMsg = (ev: MessageEvent<HelperOutMessage>) => {
            if (ev.data.type === "ready") {
              h.ready = true;
              h.worker.removeEventListener("message", onFirstMsg);
              resolve();
            } else if (ev.data.type === "error") {
              h.worker.removeEventListener("message", onFirstMsg);
              reject(new Error(ev.data.message));
            }
          };
          h.worker.addEventListener("message", onFirstMsg);
          const init: HelperInMessage = { type: "init", context: serialized };
          h.worker.postMessage(init);
        }),
    ),
  );

  // 5. Ordering queue. Phase 1 = seeded orderings (same as monolithic
  //    pack()); phase 2 = lazy shuffles refilled as helpers drain.
  const ids = ctx.stickerIds;
  const areaById = new Map<string, number>();
  for (const id of ids) {
    const vs = ctx.stickersVariants.get(id);
    const v = vs?.[0];
    areaById.set(id, v ? v.width * v.height : 0);
  }
  const byAreaDesc = [...ids].sort(
    (a, b) => (areaById.get(b) ?? 0) - (areaById.get(a) ?? 0),
  );
  const byAreaAsc = [...byAreaDesc].reverse();
  const queue: string[][] = [
    byAreaDesc,
    byAreaAsc,
    ids,
    shuffledIds(ids, 17),
    shuffledIds(ids, 91),
    shuffledIds(ids, 233),
  ];
  let shuffleSeed = 1000;
  const startTime = performance.now();

  // 6. Best-so-far state.
  let best: {
    snapshot: AttemptSnapshot;
    occBuffer: ArrayBufferLike;
  } | null = null;
  let bestProgressPlaced = 0;
  let nextAttemptId = 0;
  let attemptsInFlight = 0;
  let finished = false;

  const budgetExpired = () =>
    performance.now() - startTime >= HARD_BUDGET_MS;
  const fullPack = () =>
    best !== null && best.snapshot.placedCount === ctx.totalRequested;

  const refillQueueIfNeeded = () => {
    while (queue.length < N) {
      if (finished) return;
      if (fullPack()) return;
      if (budgetExpired()) return;
      queue.push(shuffledIds(ids, shuffleSeed++));
    }
  };

  const emitPartial = (snap: AttemptSnapshot) => {
    const coverage =
      snap.bboxArea / (ctx.canvasWidth * ctx.canvasHeight || 1);
    const out: WorkerOutMessage = {
      type: "partial",
      snapshot: {
        placements: snap.placements,
        requested: ctx.totalRequested,
        placed: snap.placedCount,
        perSticker: snap.perSticker,
        bboxCoverage: coverage,
      },
    };
    self.postMessage(out);
  };

  const emitProgress = (placed: number) => {
    const out: WorkerOutMessage = {
      type: "progress",
      placed,
      requested: ctx.totalRequested,
    };
    self.postMessage(out);
  };

  // 7. Dispatch loop — settles once every helper is idle and we've
  //    decided to stop (budget spent, full pack achieved, or queue empty).
  await new Promise<void>((resolve) => {
    const maybeFinish = () => {
      const done =
        fullPack() ||
        budgetExpired() ||
        (queue.length === 0 && attemptsInFlight === 0);
      if (done && attemptsInFlight === 0 && !finished) {
        finished = true;
        resolve();
      }
    };

    const dispatch = () => {
      if (finished) return;
      refillQueueIfNeeded();
      for (const h of helpers) {
        if (h.busy || !h.ready) continue;
        if (fullPack()) break;
        if (budgetExpired()) break;
        const order = queue.shift();
        if (!order) break;
        h.busy = true;
        const attemptId = nextAttemptId++;
        h.attemptId = attemptId;
        attemptsInFlight++;
        const out: HelperInMessage = { type: "attempt", attemptId, order };
        h.worker.postMessage(out);
      }
      maybeFinish();
    };

    for (const h of helpers) {
      h.worker.addEventListener(
        "message",
        (ev: MessageEvent<HelperOutMessage>) => {
          const m = ev.data;
          if (m.type === "done") {
            h.busy = false;
            h.attemptId = null;
            attemptsInFlight--;
            const snap = m.result;
            // Same strictly-better rule as monolithic pack():
            //   (placed > best.placed) || (== placed && bbox > best.bbox)
            const strictlyBetter =
              !best ||
              snap.placedCount > best.snapshot.placedCount ||
              (snap.placedCount === best.snapshot.placedCount &&
                snap.bboxArea > best.snapshot.bboxArea);
            if (strictlyBetter) {
              best = { snapshot: snap, occBuffer: m.occBuffer };
              if (snap.placedCount > bestProgressPlaced) {
                bestProgressPlaced = snap.placedCount;
                emitProgress(bestProgressPlaced);
              }
              emitPartial(snap);
            }
            dispatch();
          } else if (m.type === "error") {
            // Treat as a lost attempt; other helpers may still finish
            // successfully.
            if (h.busy) {
              h.busy = false;
              h.attemptId = null;
              attemptsInFlight--;
            }
            dispatch();
          }
        },
      );
    }

    dispatch();
  });

  // 8. Terminate helpers.
  for (const h of helpers) h.worker.terminate();

  // 9. Defensive fallback (shouldn't trigger): if somehow no helper
  //    produced a result, run one attempt inline so the main thread
  //    always gets a non-empty response.
  if (!best) {
    const env = runAttemptInContext(ctx, ids);
    best = { snapshot: env.result, occBuffer: env.occBuffer };
  }

  // 10. ExtraFits on the winning attempt's occupancy.
  const winOcc = occupancyFromBuffer(ctx.gridW, ctx.gridH, best.occBuffer);
  const extraFits = probeExtraFitsInContext(winOcc, ctx);
  const coverage =
    best.snapshot.bboxArea / (ctx.canvasWidth * ctx.canvasHeight || 1);
  const out: WorkerOutMessage = {
    type: "done",
    result: {
      placements: best.snapshot.placements,
      requested: ctx.totalRequested,
      placed: best.snapshot.placedCount,
      perSticker: best.snapshot.perSticker,
      bboxCoverage: coverage,
      extraFits,
    },
  };
  self.postMessage(out);
}

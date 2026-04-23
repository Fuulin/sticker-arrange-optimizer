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
 * Set to `true` to emit timing logs from the coordinator to the browser
 * console. Off by default; flip on to see where wall-clock is spent on
 * a slow input (buildContext, first-attempt, helper spawn, etc.).
 */
const DEBUG_TIMING = true;
const tlog = (label: string, t0: number) => {
  if (!DEBUG_TIMING) return;
  const ms = (performance.now() - t0).toFixed(1);
  // eslint-disable-next-line no-console
  console.log(`[packer] ${label}: ${ms}ms`);
};

/**
 * How many helpers to spawn. Capped so we don't create more than the
 * number of additional attempts we want (5 \u2014 we already ran the first
 * inline on the coordinator), and capped by `hardwareConcurrency` to
 * avoid over-subscription. Falls back to 4 when the API is unavailable.
 */
function helperCount(): number {
  const hw =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  // Leave one core for the coordinator + main thread.
  return Math.max(1, Math.min(5, hw - 1));
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
  const tAll = performance.now();

  // ------------------------------------------------------------------
  // 1. Build variants. Single-threaded rasterisation + mask extraction.
  // ------------------------------------------------------------------
  const tCtx = performance.now();
  const { ctx, variantBitmaps } = await buildPackContext(request);
  tlog("buildPackContext", tCtx);

  // 2. Hand the rendered bitmaps to the main thread.
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

  // Shared best-so-far state (mutated by both the inline first attempt
  // and any helper completions).
  let best: {
    snapshot: AttemptSnapshot;
    occBuffer: ArrayBufferLike;
  } | null = null;
  let bestProgressPlaced = 0;

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
  const fullPack = () =>
    best !== null && best.snapshot.placedCount === ctx.totalRequested;
  /**
   * Two-phase finalize:
   *   1. Emit `done` with the layout immediately \u2014 `extraFits` left
   *      empty so the UI unblocks the instant packing converges.
   *   2. Run the (potentially slow) leftover-space probe and emit a
   *      follow-up `extraFits` message that the main thread merges in.
   *
   * Decoupling was motivated by a concrete bug report: on a huge canvas
   * with a handful of small stickers, `probeExtraFits` can round-robin-
   * place hundreds of extras before it's done, stalling the `done`
   * message for multiple seconds even though the actual pack finished
   * in ~300ms. The user sees the layout appear, then a moment later the
   * "you could fit N more" numbers populate the suggestion drawer.
   */
  const finalizeAndEmitDone = () => {
    if (!best) return;
    const b = best;

    // --- Phase 1: emit `done` with empty extraFits. ---
    const coverage =
      b.snapshot.bboxArea / (ctx.canvasWidth * ctx.canvasHeight || 1);
    const doneMsg: WorkerOutMessage = {
      type: "done",
      result: {
        placements: b.snapshot.placements,
        requested: ctx.totalRequested,
        placed: b.snapshot.placedCount,
        perSticker: b.snapshot.perSticker,
        bboxCoverage: coverage,
        extraFits: {},
      },
    };
    self.postMessage(doneMsg);
    tlog("total(doneEmitted)", tAll);

    // --- Phase 2: probe extras with a wall-clock budget, then emit. ---
    const tOcc = performance.now();
    const winOcc = occupancyFromBuffer(ctx.gridW, ctx.gridH, b.occBuffer);
    tlog("occupancyFromBuffer", tOcc);
    const tProbe = performance.now();
    const extraFits = probeExtraFitsInContext(winOcc, ctx, {
      budgetMs: 500,
      hardCap: 500,
    });
    tlog("probeExtraFits", tProbe);
    const extraMsg: WorkerOutMessage = { type: "extraFits", extraFits };
    self.postMessage(extraMsg);
    tlog("total(extraFitsEmitted)", tAll);
  };

  // ------------------------------------------------------------------
  // 4. Inline first attempt: `byAreaDesc` (biggest-first, the classic
  //    bin-packing heuristic and the strongest single ordering on
  //    typical inputs). Running it on the coordinator means the user
  //    sees a full naive solution at `firstAttempt` time \u2014 no helper-
  //    spin-up or mask-buffer-cloning overhead sits in front of it.
  //    For "everything fits comfortably" inputs this is the whole run.
  // ------------------------------------------------------------------
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

  {
    const t = performance.now();
    const env = runAttemptInContext(ctx, byAreaDesc);
    tlog("firstAttempt(byAreaDesc)", t);
    best = { snapshot: env.result, occBuffer: env.occBuffer };
    bestProgressPlaced = env.result.placedCount;
    emitProgress(bestProgressPlaced);
    emitPartial(env.result);
  }

  // If the first attempt already fits everything, we're done. Skip
  // helper spawning entirely — this is the critical fast-path the
  // user reported missing.
  if (DEBUG_TIMING) {
    // eslint-disable-next-line no-console
    console.log(
      `[packer] after firstAttempt: placed=${best!.snapshot.placedCount} requested=${ctx.totalRequested} fullPack=${fullPack()}`,
    );
  }
  if (fullPack()) {
    finalizeAndEmitDone();
    return;
  }

  // ------------------------------------------------------------------
  // 5. Harder case: spawn helper pool and explore more orderings in
  //    parallel under the wall-clock budget.
  // ------------------------------------------------------------------
  const N = helperCount();
  const tSpawn = performance.now();
  const serialized = serializePackContext(ctx);
  tlog("serializePackContext", tSpawn);

  const helpers: Helper[] = [];
  for (let i = 0; i < N; i++) {
    const w = new Worker(
      new URL("./attempt-worker.ts", import.meta.url),
      { type: "module" },
    );
    helpers.push({ worker: w, busy: false, ready: false, attemptId: null });
  }

  // Remaining orderings to try (skip byAreaDesc \u2014 we ran it inline).
  const queue: string[][] = [
    byAreaAsc,
    ids,
    shuffledIds(ids, 17),
    shuffledIds(ids, 91),
    shuffledIds(ids, 233),
  ];
  let shuffleSeed = 1000;
  const startTime = performance.now();

  let nextAttemptId = 0;
  let attemptsInFlight = 0;
  let finished = false;

  const budgetExpired = () =>
    performance.now() - startTime >= HARD_BUDGET_MS;

  const refillQueueIfNeeded = () => {
    while (queue.length < N) {
      if (finished) return;
      if (fullPack()) return;
      if (budgetExpired()) return;
      queue.push(shuffledIds(ids, shuffleSeed++));
    }
  };

  // ------------------------------------------------------------------
  // 6. Dispatch loop.
  //
  //    Two non-obvious behaviours:
  //    (a) We *don't* wait for all helpers to ack `ready` before
  //        dispatching. Each helper dispatches its first attempt as
  //        soon as it's individually ready \u2014 overlap init with work.
  //    (b) On a full pack we `resolve()` immediately without waiting
  //        for in-flight stragglers. The original parallel design
  //        waited for `attemptsInFlight === 0`, which created an
  //        artificial "slowest-of-N" floor even for trivial inputs.
  // ------------------------------------------------------------------
  await new Promise<void>((resolve) => {
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    const maybeFinish = () => {
      if (finished) return;
      if (fullPack()) {
        finish();
        return;
      }
      if (budgetExpired() && attemptsInFlight === 0) {
        finish();
        return;
      }
      if (queue.length === 0 && attemptsInFlight === 0) {
        finish();
        return;
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
          if (m.type === "ready") {
            h.ready = true;
            dispatch();
          } else if (m.type === "done") {
            h.busy = false;
            h.attemptId = null;
            attemptsInFlight--;
            const snap = m.result;
            // Strictly-better rule matches monolithic pack():
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
            // Treat the helper as dead \u2014 don't re-dispatch to it.
            // (An init-time error means deserialization failed; an
            // attempt-time error means the attempt threw. Either way
            // this helper is unlikely to succeed on a retry, and
            // cycling it would burn the wall-clock budget.)
            if (h.busy) {
              h.busy = false;
              h.attemptId = null;
              attemptsInFlight--;
            }
            h.ready = false;
            dispatch();
          }
        },
      );
      // Kick off init. Structured clone of `serialized` fires here,
      // which is where the mask buffers get duplicated into the helper.
      const init: HelperInMessage = { type: "init", context: serialized };
      h.worker.postMessage(init);
    }

    // In the pathological "all helpers failed to spawn" case, nothing
    // will ever fire a message. `queue` is non-empty and
    // `attemptsInFlight === 0`, so maybeFinish() doesn't resolve. Kick
    // it once so we fall back to `best` (the inline first attempt).
    maybeFinish();
  });
  tlog("parallelPhase", startTime);

  // ------------------------------------------------------------------
  // 7. Terminate helpers (including any in-flight attempts \u2014 we don't
  //    need their results now that `best` is full or budget is spent).
  // ------------------------------------------------------------------
  for (const h of helpers) h.worker.terminate();

  finalizeAndEmitDone();
}

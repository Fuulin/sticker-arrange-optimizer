/// <reference lib="webworker" />
// ======================================================================
// Helper worker: runs individual pack attempts on demand.
//
// Protocol
// --------
// In:
//   { type: "init", context: SerializedPackContext }
//     - Sent once, before any "attempt". Rebuilds the PackContext locally
//       from the cloned mask buffers + metadata. Helper is reusable
//       across many attempts with the same context.
//
//   { type: "attempt", attemptId: number, order: string[] }
//     - Run one greedy attempt with the given sticker ordering. Replies
//       with the serialized result + the occupancy buffer (transferred).
//
// Out:
//   { type: "ready" }
//     - Sent once after "init" is processed.
//
//   { type: "done", attemptId, result, occBuffer }
//     - Sent after each "attempt". `occBuffer` is the helper's
//       occupancy grid bytes, transferred so the coordinator can
//       run `probeExtraFitsInContext` on the winning attempt without
//       re-running anything.
//
//   { type: "error", message }
//     - Any unexpected error. Coordinator treats the helper as dead.
// ======================================================================
import {
  deserializePackContext,
  runAttemptInContext,
  type PackContext,
  type SerializedPackContext,
  type AttemptSnapshot,
} from "./packer";

export type HelperInMessage =
  | { type: "init"; context: SerializedPackContext }
  | { type: "attempt"; attemptId: number; order: string[] };

export type HelperOutMessage =
  | { type: "ready" }
  | {
      type: "done";
      attemptId: number;
      result: AttemptSnapshot;
      occBuffer: ArrayBufferLike;
    }
  | { type: "error"; message: string };

declare const self: DedicatedWorkerGlobalScope;

let ctx: PackContext | null = null;

self.onmessage = (e: MessageEvent<HelperInMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      ctx = deserializePackContext(msg.context);
      const out: HelperOutMessage = { type: "ready" };
      self.postMessage(out);
      return;
    }
    if (msg.type === "attempt") {
      if (!ctx) {
        throw new Error("attempt received before init");
      }
      const envelope = runAttemptInContext(ctx, msg.order);
      const out: HelperOutMessage = {
        type: "done",
        attemptId: msg.attemptId,
        result: envelope.result,
        occBuffer: envelope.occBuffer,
      };
      // Transfer the occ buffer to the coordinator. It's a fresh
      // allocation per attempt so losing it locally is fine.
      self.postMessage(out, [envelope.occBuffer as ArrayBuffer]);
      return;
    }
  } catch (err) {
    const out: HelperOutMessage = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(out);
  }
};

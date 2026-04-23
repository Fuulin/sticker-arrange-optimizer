/// <reference lib="webworker" />
import { pack } from "./packer";
import type {
  WorkerInMessage,
  WorkerOutMessage,
} from "./types";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (e: MessageEvent<WorkerInMessage>) => {
  const msg = e.data;
  if (msg.type !== "pack") return;
  try {
    const result = await pack(msg.request, {
      onProgress: (placed, requested) => {
        const p: WorkerOutMessage = { type: "progress", placed, requested };
        self.postMessage(p);
      },
      onVariants: (variantBitmaps) => {
        // Transfer the bitmaps to the main thread in one shot. They're
        // never touched here again — the pack loop uses masks only.
        const transfer: Transferable[] = [];
        for (const arr of Object.values(variantBitmaps)) {
          for (const b of arr) transfer.push(b);
        }
        const out: WorkerOutMessage = { type: "variants", variantBitmaps };
        self.postMessage(out, transfer);
      },
      onImprove: (snapshot) => {
        const out: WorkerOutMessage = { type: "partial", snapshot };
        self.postMessage(out);
      },
    });
    const out: WorkerOutMessage = { type: "done", result };
    self.postMessage(out);
  } catch (err) {
    const out: WorkerOutMessage = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(out);
  }
};

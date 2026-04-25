import type { PackResult } from "../packer/types";

export interface CricutExportProps {
  result: PackResult;
  variantBitmaps: Record<string, ImageBitmap[]>;
  canvasWidthPx: number;
  canvasHeightPx: number;
  dpi: number;
  onBack: () => void;
}

export function CricutExport(props: CricutExportProps) {
  return (
    <div className="flex h-full w-full flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-5 py-3">
        <button
          type="button"
          onClick={props.onBack}
          className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs hover:bg-neutral-800"
        >
          ← Back
        </button>
        <div className="text-sm font-semibold">Cricut Export</div>
        <div className="ml-auto text-xs text-neutral-400 tabular-nums">
          {props.result.placements.length} stickers ·{" "}
          {props.canvasWidthPx}×{props.canvasHeightPx} px · {props.dpi} DPI
        </div>
      </header>
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
        Cricut export view — UI coming in later tasks.
      </div>
    </div>
  );
}

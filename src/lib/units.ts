export const INCH_PER_CM = 1 / 2.54;
export const CM_PER_INCH = 2.54;

export function cmToPx(cm: number, dpi: number): number {
  return Math.max(1, Math.round((cm * dpi) / CM_PER_INCH));
}

export function pxToCm(px: number, dpi: number): number {
  return (px * CM_PER_INCH) / dpi;
}

/** A4 in cm (portrait). */
export const A4_CM = { w: 21.0, h: 29.7 } as const;

/** Preset DPI values. 300 is standard print quality. */
export const DPI_PRESETS = [72, 150, 300, 600] as const;

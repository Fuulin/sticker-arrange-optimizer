export const INCH_PER_CM = 1 / 2.54;
export const CM_PER_INCH = 2.54;
export const INCH_PER_MM = 1 / 25.4;

export function cmToPx(cm: number, dpi: number): number {
  return Math.max(1, Math.round((cm * dpi) / CM_PER_INCH));
}

export function pxToCm(px: number, dpi: number): number {
  return (px * CM_PER_INCH) / dpi;
}

export function mmToPx(mm: number, dpi: number): number {
  return Math.max(0, Math.round(mm * INCH_PER_MM * dpi));
}

/** A4 in cm (portrait). */
export const A4_CM = { w: 21.0, h: 29.7 } as const;

/** Cricut Print-Then-Cut standard max (9.25" × 6.75"), in cm. Landscape. */
export const CRICUT_PTC_CM = { w: 23.495, h: 17.145 } as const;

/** Cricut Print-Then-Cut tile size in inches (landscape). */
export const CRICUT_PTC_IN = { w: 9.25, h: 6.75 } as const;

/** Preset DPI values. 300 is standard print quality. */
export const DPI_PRESETS = [72, 150, 300, 600] as const;

export type ResolutionMode = 'dpi' | 'pixel';
export const PIXEL_SIDE_UNITS_PER_INCH = { um: 25400, mm: 25.4 };

export function formatPixelSize(value: number) {
  return value < 0.01 ? value.toExponential(2) : value.toFixed(2);
}

export const TRANSPARENT = 0;
export const OPAQUE_ZERO = 1;
export const OPAQUE_ONE = 2;

export const METERS_PER_INCH = 0.0254;
export const MIN_DPI = 1;
export const MAX_DPI = 0xffffffff * METERS_PER_INCH; // PNG pHYs stores unsigned 32-bit pixels per meter.
export const MAX_DIMENSION = 4096;

export type PixelSideUnit = 'um' | 'mm';
export type LayerFill = typeof TRANSPARENT | typeof OPAQUE_ZERO | typeof OPAQUE_ONE;
export type Selection = { x: number; y: number; width: number; height: number };
export type Layer = { id: string; name: string; pixels: Uint8Array; visible: boolean; locked: boolean };

export type CompositeMask = {
  pixels: Uint8Array; // Composited 0/1 values; unresolved entries hold 0.
  resolved: Uint8Array; // A zero means no visible layer supplied an opaque pixel.
};

export function isSupportedDpi(value: number) {
  return Number.isFinite(value) && value >= MIN_DPI && value <= MAX_DPI;
}

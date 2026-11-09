import { TRANSPARENT, type Selection } from './mask-model.ts';

export type PixelBlock = {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: Uint8Array;
};

export function clipPixelBlock(block: Selection, width: number, height: number): Selection | null {
  const x = Math.max(0, block.x);
  const y = Math.max(0, block.y);
  const right = Math.min(width, block.x + block.width);
  const bottom = Math.min(height, block.y + block.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export function writeClippedBlock(target: Uint8Array, canvasWidth: number, block: PixelBlock, clipped: Selection) {
  for (let row = 0; row < clipped.height; row += 1) {
    const y = clipped.y + row;
    const source = (y - block.y) * block.width + clipped.x - block.x;
    target.set(block.pixels.subarray(source, source + clipped.width), y * canvasWidth + clipped.x);
  }
}

export function clearPixelRegion(pixels: Uint8Array, canvasWidth: number, region: Selection) {
  for (let y = region.y; y < region.y + region.height; y += 1) {
    const start = y * canvasWidth + region.x;
    pixels.fill(TRANSPARENT, start, start + region.width);
  }
}

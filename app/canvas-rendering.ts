import { OPAQUE_ONE, TRANSPARENT } from './mask-model';
import type { PixelBlock } from './pixel-block';

export function resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

export function createBlockPreviewRenderer() {
  // Moving the preview changes its position, but not the captured pixel buffer.
  const cache = new WeakMap<Uint8Array, Map<number, HTMLCanvasElement>>();
  return (context: CanvasRenderingContext2D, block: PixelBlock, alpha: number) => {
    let variants = cache.get(block.pixels);
    if (!variants) {
      variants = new Map();
      cache.set(block.pixels, variants);
    }
    let temporary = variants.get(alpha);
    if (!temporary) {
      temporary = document.createElement('canvas');
      resizeCanvas(temporary, block.width, block.height);
      const temporaryContext = temporary.getContext('2d');
      if (temporaryContext) {
        const image = temporaryContext.createImageData(block.width, block.height);
        for (let index = 0; index < block.pixels.length; index += 1) {
          const state = block.pixels[index];
          if (state === TRANSPARENT) continue;
          const target = index * 4;
          const value = state === OPAQUE_ONE ? 255 : 0;
          image.data[target] = value;
          image.data[target + 1] = value;
          image.data[target + 2] = value;
          image.data[target + 3] = alpha;
        }
        temporaryContext.putImageData(image, 0, 0);
        variants.set(alpha, temporary);
      } else {
        temporary = undefined;
      }
    }
    if (temporary) context.drawImage(temporary, block.x, block.y);
    context.save();
    context.strokeStyle = '#ff8b7f';
    context.strokeRect(block.x, block.y, block.width, block.height);
    context.restore();
  };
}

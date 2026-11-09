import { METERS_PER_INCH, OPAQUE_ONE, OPAQUE_ZERO, type CompositeMask } from '../mask-model.ts';

function uint32(value: number) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = new TextEncoder().encode(type);
  return concatBytes([uint32(data.length), typeBytes, data, uint32(crc32(concatBytes([typeBytes, data])))]);
}

export async function encodeMaskPng({ pixels, resolved }: CompositeMask, width: number, height: number, dpi: number, preserveTransparency: boolean) {
  const hasTransparency = preserveTransparency && resolved.includes(0);
  const bitDepth = hasTransparency ? 2 : 1;
  const samplesPerByte = 8 / bitDepth;
  const rowBytes = Math.ceil(width / samplesPerByte);
  const raw = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y += 1) {
    const targetRow = y * (rowBytes + 1) + 1;
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      // Palette indices 0, 1 and 2 denote transparent, black and white.
      const sample = hasTransparency ? (resolved[index] ? pixels[index] + 1 : 0) : pixels[index];
      const shift = 8 - bitDepth * (x % samplesPerByte + 1);
      raw[targetRow + Math.floor(x / samplesPerByte)] |= sample << shift;
    }
  }
  const compressedStream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  const compressed = new Uint8Array(await new Response(compressedStream).arrayBuffer());
  const header = concatBytes([uint32(width), uint32(height), new Uint8Array([bitDepth, hasTransparency ? 3 : 0, 0, 0, 0])]);
  const palette = hasTransparency ? [
    pngChunk('PLTE', new Uint8Array([0, 0, 0, 0, 0, 0, 255, 255, 255])),
    pngChunk('tRNS', new Uint8Array([0])),
  ] : [];
  const pixelsPerMeter = Math.round(dpi / METERS_PER_INCH);
  const physical = concatBytes([uint32(pixelsPerMeter), uint32(pixelsPerMeter), new Uint8Array([1])]);
  return new Blob([concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    ...palette, pngChunk('pHYs', physical), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array()),
  ])], { type: 'image/png' });
}

export async function readPngLayer(file: Blob, width: number, height: number) {
  const pixels = new Uint8Array(width * height);
  const bitmap = await createImageBitmap(file);
  const temporary = document.createElement('canvas');
  temporary.width = bitmap.width;
  temporary.height = bitmap.height;
  const context = temporary.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not read the image.');
  context.drawImage(bitmap, 0, 0);
  const sourcePixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const copyWidth = Math.min(width, bitmap.width);
  const copyHeight = Math.min(height, bitmap.height);
  for (let y = 0; y < copyHeight; y += 1) {
    for (let x = 0; x < copyWidth; x += 1) {
      const source = (y * bitmap.width + x) * 4;
      if (sourcePixels[source + 3] < 128) continue;
      const luminance = sourcePixels[source] * 0.2126 + sourcePixels[source + 1] * 0.7152 + sourcePixels[source + 2] * 0.0722;
      pixels[y * width + x] = luminance >= 128 ? OPAQUE_ONE : OPAQUE_ZERO;
    }
  }
  bitmap.close();
  return pixels;
}

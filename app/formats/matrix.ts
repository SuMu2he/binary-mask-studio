import { MAX_DIMENSION, OPAQUE_ONE, OPAQUE_ZERO, TRANSPARENT, type CompositeMask, type Selection } from '../mask-model.ts';

export function regionToText(pixels: Uint8Array, canvasWidth: number, region: Selection) {
  const rows: string[] = [];
  for (let y = 0; y < region.height; y += 1) {
    const values = new Array<string>(region.width);
    for (let x = 0; x < region.width; x += 1) {
      const value = pixels[(region.y + y) * canvasWidth + region.x + x];
      values[x] = value === OPAQUE_ONE ? '1' : value === OPAQUE_ZERO ? '0' : '·';
    }
    rows.push(values.join(' '));
  }
  return rows.join('\n');
}

export function parseMatrixText(text: string) {
  const cleaned = text.trim().replace(/^\s*\[/, '').replace(/\]\s*$/, '');
  const lines = cleaned.split(/[;\r\n]+/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('No matrix data found.');
  const rows = lines.map((line, rowIndex) => {
    const compact = line.replace(/[\s,]/g, '');
    const values = /^[01.·]+$/.test(compact) ? compact.split('') : line.split(/[\s,]+/).filter(Boolean);
    const valid = values.every((value) => value === '0' || value === '1' || value === 'null' || value === '.' || value === '·');
    if (!values.length || !valid) throw new Error(`Row ${rowIndex + 1} contains unsupported content.`);
    return values.map((value) => value === '1' ? OPAQUE_ONE : value === '0' ? OPAQUE_ZERO : TRANSPARENT);
  });
  const matrixWidth = rows[0].length;
  if (rows.some((row) => row.length !== matrixWidth)) throw new Error('Every matrix row must have the same number of columns.');
  if (matrixWidth > MAX_DIMENSION || rows.length > MAX_DIMENSION) throw new Error(`The matrix must not exceed ${MAX_DIMENSION} × ${MAX_DIMENSION}.`);
  return rows;
}

export function readMatrixLayer(text: string, width: number, height: number) {
  const pixels = new Uint8Array(width * height);
  const rows = parseMatrixText(text);
  const copyHeight = Math.min(height, rows.length);
  const copyWidth = Math.min(width, rows[0].length);
  for (let y = 0; y < copyHeight; y += 1) {
    for (let x = 0; x < copyWidth; x += 1) pixels[y * width + x] = rows[y][x];
  }
  return pixels;
}

export function* compositeTextChunks({ pixels, resolved }: CompositeMask, width: number, height: number, separator: string, preserveTransparency: boolean) {
  // A Blob can consume these batches directly, avoiding one canvas-sized string.
  const rows: string[] = [];
  for (let y = 0; y < height; y += 1) {
    const values = new Array<string>(width);
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      values[x] = preserveTransparency && !resolved[index] ? 'null' : pixels[index] ? '1' : '0';
    }
    rows.push(values.join(separator));
    if (rows.length === 64) {
      yield rows.join('\n') + (y + 1 < height ? '\n' : '');
      rows.length = 0;
    }
  }
  if (rows.length) yield rows.join('\n');
}

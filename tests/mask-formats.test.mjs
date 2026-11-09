import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, inflateSync } from 'node:zlib';
import { compositeTextChunks, parseMatrixText, readMatrixLayer, regionToText } from '../app/formats/matrix.ts';
import { encodeMaskPng } from '../app/formats/png.ts';
import { deserializeProject, serializeProject } from '../app/formats/project.ts';
import { MAX_DIMENSION, MAX_DPI } from '../app/mask-model.ts';
import { evaluateNumericExpression } from '../app/numeric-expression.ts';

// Odd width exercises padding at the end of PNG scanlines.
const composite = {
  pixels: Uint8Array.of(0, 1, 0, 1, 0, 1, 0, 0, 1, 0),
  resolved: Uint8Array.of(1, 1, 0, 1, 1, 1, 0, 1, 1, 0),
};
const csv = '0,1,null,1,0\n1,null,0,1,null';
const flatCsv = '0,1,0,1,0\n1,0,0,1,0';
const layerPixels = Uint8Array.of(1, 2, 0, 2, 1, 2, 0, 1, 2, 0);
const compositeToText = (...args) => Array.from(compositeTextChunks(...args)).join('');

test('matrix export preserves exact CSV/TXT text in both transparency modes', () => {
  assert.equal(compositeToText(composite, 5, 2, ',', true), csv);
  assert.equal(compositeToText(composite, 5, 2, ' ', true), csv.replaceAll(',', ' '));
  assert.equal(compositeToText(composite, 5, 2, ',', false), flatCsv);
  assert.equal(compositeToText(composite, 5, 2, ' ', false), flatCsv.replaceAll(',', ' '));
});

test('matrix import accepts current and legacy transparent values and compact rows', () => {
  assert.deepEqual(parseMatrixText(csv), [[1, 2, 0, 2, 1], [2, 0, 1, 2, 0]]);
  assert.deepEqual(parseMatrixText('[01·.; 1 0 null 1]'), [[1, 2, 0, 0], [2, 1, 0, 2]]);
  assert.deepEqual(readMatrixLayer(csv, 3, 3), Uint8Array.of(1, 2, 0, 2, 0, 1, 0, 0, 0));
  assert.deepEqual(readMatrixLayer(csv, 2, 1), Uint8Array.of(1, 2));
});

test('matrix import preserves validation and matrix editor preserves its text notation', () => {
  assert.throws(() => parseMatrixText('   '), { message: 'No matrix data found.' });
  assert.throws(() => parseMatrixText('0,0\n0,2'), { message: 'Row 2 contains unsupported content.' });
  assert.throws(() => parseMatrixText('0,1\n1'), { message: 'Every matrix row must have the same number of columns.' });
  assert.throws(() => parseMatrixText('0'.repeat(MAX_DIMENSION + 1)), /must not exceed/);
  assert.equal(regionToText(layerPixels, 5, { x: 0, y: 0, width: 5, height: 2 }), '0 1 · 1 0\n1 · 0 1 ·');
  assert.equal(regionToText(layerPixels, 5, { x: 1, y: 0, width: 3, height: 2 }), '1 · 1\n· 0 1');
});

test('matrix batches retain the exact row separators at and across batch boundaries', () => {
  for (const height of [64, 65, 128, 129]) {
    const mask = { pixels: new Uint8Array(height), resolved: new Uint8Array(height) };
    const chunks = [...compositeTextChunks(mask, 1, height, ',', true)];
    assert.equal(chunks.length, Math.ceil(height / 64));
    assert.equal(chunks.join(''), new Array(height).fill('null').join('\n'));
  }
});

async function readPng(blob) {
  assert.equal(blob.type, 'image/png');
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const chunks = new Map();
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const type = bytes.toString('ascii', typeStart, dataStart);
    assert.equal(bytes.readUInt32BE(dataEnd), crc32(bytes.subarray(typeStart, dataEnd)), type);
    chunks.set(type, bytes.subarray(dataStart, dataEnd));
    offset = dataEnd + 4;
  }
  const header = chunks.get('IHDR');
  assert.equal(header.readUInt32BE(0), 5);
  assert.equal(header.readUInt32BE(4), 2);
  return { header, chunks, scanlines: [...inflateSync(chunks.get('IDAT'))] };
}

test('transparent PNG preserves exact palette indices, row padding and DPI', async () => {
  const { header, chunks, scanlines } = await readPng(await encodeMaskPng(composite, 5, 2, 25400 / 3.45, true));
  assert.deepEqual([...chunks.keys()], ['IHDR', 'PLTE', 'tRNS', 'pHYs', 'IDAT', 'IEND']);
  assert.deepEqual([...header.subarray(8)], [2, 3, 0, 0, 0]);
  assert.deepEqual([...chunks.get('PLTE')], [0, 0, 0, 0, 0, 0, 255, 255, 255]);
  assert.deepEqual([...chunks.get('tRNS')], [0]);
  assert.deepEqual(scanlines, [0, 0b01100010, 0b01000000, 0, 0b10000110, 0]);
  const physical = chunks.get('pHYs');
  assert.equal(physical.readUInt32BE(0), Math.round(1e6 / 3.45));
  assert.equal(physical.readUInt32BE(4), physical.readUInt32BE(0));
  assert.equal(physical[8], 1);
});

test('flattened and already opaque PNGs use the same 1-bit scanlines', async () => {
  const flattened = await readPng(await encodeMaskPng(composite, 5, 2, 300, false));
  const opaque = { ...composite, resolved: new Uint8Array(10).fill(1) };
  const opaquePng = await readPng(await encodeMaskPng(opaque, 5, 2, 300, true));
  assert.deepEqual(flattened, opaquePng);
  assert.deepEqual([...flattened.chunks.keys()], ['IHDR', 'pHYs', 'IDAT', 'IEND']);
  assert.deepEqual([...flattened.header.subarray(8)], [1, 0, 0, 0, 0]);
  assert.deepEqual(flattened.scanlines, [0, 0b01010000, 0, 0b10010000]);
});

const legacy = {
  format: 'binary-mask-studio',
  version: 1,
  width: 2,
  height: 2,
  dpi: 300,
  activeLayerId: 'top',
  layers: [
    { id: 'top', name: 'Upper', visible: false, locked: true, pixels: 'AAECAA==' },
    { id: 'base', name: 'Base', visible: true, locked: false, pixels: 'AgEBAg==' },
  ],
};
const readProject = (payload) => deserializeProject(JSON.stringify(payload), () => 'generated-layer');

test('legacy .bmask opens and resaves byte-for-byte with all layer states', () => {
  const project = readProject(legacy);
  assert.equal(project.pixelSizeUnit, null);
  assert.equal(project.activeLayerId, 'top');
  assert.deepEqual(project.layers[0], { ...legacy.layers[0], pixels: Uint8Array.of(0, 1, 2, 0) });
  assert.equal(serializeProject(project), JSON.stringify(legacy));
});

test('project round trip retains exact fractional DPI, pixel unit and existing fallbacks', () => {
  const dpi = 25400 / 3.4567;
  const project = readProject({ ...legacy, dpi, pixelSizeUnit: 'mm' });
  assert.equal(project.dpi, dpi);
  assert.equal(project.pixelSizeUnit, 'mm');
  assert.deepEqual(readProject(JSON.parse(serializeProject(project))), project);
  const missing = readProject({ ...legacy, pixelSizeUnit: 'px', activeLayerId: 'missing', layers: [{ ...legacy.layers[0], id: '', name: '' }] });
  assert.equal(missing.pixelSizeUnit, null);
  assert.equal(missing.activeLayerId, 'generated-layer');
  assert.equal(missing.layers[0].name, 'Layer 1');
});

test('project rejects unsupported versions, invalid dimensions, DPI and layer bytes', () => {
  assert.throws(() => readProject({ ...legacy, version: 2 }), /not a supported/);
  assert.throws(() => readProject({ ...legacy, width: 1.5 }), /dimensions are invalid/);
  assert.throws(() => readProject({ ...legacy, dpi: MAX_DPI + 1 }), /DPI is invalid/);
  assert.throws(() => readProject({ ...legacy, layers: [] }), /contains no layers/);
  assert.throws(() => readProject({ ...legacy, layers: [{ ...legacy.layers[0], pixels: 'AwECAA==' }] }), /corrupted data/);
  assert.throws(() => readProject({ ...legacy, layers: [{ ...legacy.layers[0], pixels: 'AA==' }] }), /corrupted data/);
});

test('numeric input preserves arithmetic, scientific notation and invalid input handling', () => {
  assert.equal(evaluateNumericExpression('(1e3+2E2)/2'), 600);
  assert.equal(evaluateNumericExpression('3.4567e-3'), 0.0034567);
  assert.equal(evaluateNumericExpression('2×(4−1)'), 6);
  assert.equal(evaluateNumericExpression('1/0'), null);
  assert.equal(evaluateNumericExpression('1e309'), null);
  assert.equal(evaluateNumericExpression('1e-'), null);
});

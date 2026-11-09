import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPixelSize } from '../app/canvas-calibration.ts';
import { createLayerHistory } from '../app/layer-history.ts';
import { clearPixelRegion, clipPixelBlock, writeClippedBlock } from '../app/pixel-block.ts';

const makeLayer = (id, values) => ({ id, name: id, pixels: Uint8Array.from(values), visible: true, locked: false });

test('history shares unchanged buffers and isolates pixel and metadata writes', () => {
  const history = createLayerHistory();
  const first = makeLayer('first', [0, 1, 2]);
  const second = makeLayer('second', [2, 1, 0]);
  const before = history.snapshot([first, second], 'first', ['first']);
  assert.equal(before.layers[0].pixels, first.pixels);
  assert.equal(before.layers[1].pixels, second.pixels);
  second.visible = false;
  const writable = history.writablePixels(first);
  writable[0] = 2;
  assert.notEqual(writable, before.layers[0].pixels);
  assert.equal(history.writablePixels(first), writable);
  assert.equal(before.layers[1].visible, true);
  assert.equal(before.layers[0].pixels[0], 0);

  const after = history.snapshot([first, second], 'second', ['first', 'second']);
  assert.equal(after.layers[1].pixels, before.layers[1].pixels);
  const restored = history.restore(before);
  restored[0].name = 'renamed';
  history.writablePixels(restored[0])[1] = 2;
  assert.equal(before.layers[0].name, 'first');
  assert.deepEqual(before.layers[0].pixels, Uint8Array.of(0, 1, 2));
  assert.deepEqual(after.layers[0].pixels, Uint8Array.of(2, 1, 2));
  assert.deepEqual(after.selectedLayerIds, ['first', 'second']);
});

test('clipped block writes match per-pixel placement on every edge, preserving transparent pixels', () => {
  const width = 5;
  const height = 4;
  const source = Uint8Array.of(0, 1, 2, 1, 2, 0);
  for (let y = -3; y <= height; y += 1) {
    for (let x = -4; x <= width; x += 1) {
      const block = { x, y, width: 3, height: 2, pixels: source };
      const expected = new Uint8Array(width * height).fill(2);
      for (let sy = 0; sy < block.height; sy += 1) {
        for (let sx = 0; sx < block.width; sx += 1) {
          const px = x + sx;
          const py = y + sy;
          if (px >= 0 && py >= 0 && px < width && py < height) expected[py * width + px] = source[sy * block.width + sx];
        }
      }
      const actual = new Uint8Array(width * height).fill(2);
      const clipped = clipPixelBlock(block, width, height);
      if (clipped) writeClippedBlock(actual, width, block, clipped);
      assert.deepEqual(actual, expected, `block at (${x}, ${y})`);
    }
  }
});

test('moving a block clears its source before writing the overlapping destination', () => {
  const canvas = Uint8Array.of(2, 1, 0, 2);
  const source = { x: 0, y: 0, width: 3, height: 1 };
  const block = { ...source, x: 1, pixels: canvas.slice(0, 3) };
  clearPixelRegion(canvas, 4, source);
  writeClippedBlock(canvas, 4, block, clipPixelBlock(block, 4, 1));
  assert.deepEqual(canvas, Uint8Array.of(0, 2, 1, 0));
});

test('pixel size display keeps two decimals, including small values', () => {
  assert.equal(formatPixelSize(3.4), '3.40');
  assert.equal(formatPixelSize(0.0034567), '3.46e-3');
});

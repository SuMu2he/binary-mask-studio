'use client';

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type CSSProperties } from 'react';
import HelpDialog from './help-dialog';
import AboutDialog from './about-dialog';
import NumericInput, { validateNumericInputs } from './numeric-input';
import { PanelSplitter, usePanelLayout } from './panel-layout';
import { compositeTextChunks, parseMatrixText, readMatrixLayer, regionToText } from './formats/matrix';
import { encodeMaskPng, readPngLayer } from './formats/png';
import { deserializeProject, serializeProject } from './formats/project';
import { createBlockPreviewRenderer, resizeCanvas } from './canvas-rendering';
import { createLayerHistory, type HistorySnapshot } from './layer-history';
import { useLinkedDimensions } from './linked-dimensions';
import { clearPixelRegion, clipPixelBlock, writeClippedBlock } from './pixel-block';
import { formatPixelSize, PIXEL_SIDE_UNITS_PER_INCH, type ResolutionMode } from './canvas-calibration';
import { FieldSuffix, SectionHeading } from './components/editor-primitives';
import { LayersPanel } from './components/layers-panel';
import { MatrixEditorDialog, MATRIX_COLUMNS, MATRIX_ROWS, type MatrixScope, type MatrixView } from './components/matrix-editor-dialog';
import { NewCanvasDialog } from './components/new-canvas-dialog';
import { PixelInspector } from './components/pixel-inspector';
import {
  MAX_DIMENSION, OPAQUE_ONE, OPAQUE_ZERO, TRANSPARENT, isSupportedDpi,
  type Layer, type LayerFill, type PixelSideUnit, type Selection,
} from './mask-model';

type ShapeKind = 'circle' | 'triangle' | 'rectangle';
type ParametricKind = ShapeKind | 'text' | 'grating';
type Tool = 'shape' | 'draw' | 'erase' | 'select' | 'move';
type BooleanOperation = 'set1' | 'set0' | 'xor';
type SizeUnit = 'px' | 'mm';
type GratingWriteMode = 'cover' | 'lines';
type GratingPolarity = 'line1' | 'line0';
type TextFont = 'sans' | 'serif' | 'mono';
type TextWeight = '400' | '700';
type TextAlignment = 'left' | 'center' | 'right';
type Point = { x: number; y: number };
type Bounds = { minX: number; maxX: number; minY: number; maxY: number };
type BinaryBlock = { width: number; height: number; pixels: Uint8Array };
type MovePreview = BinaryBlock & Point & { source: Selection };
type Quote = { content: string; source: string };
type ShapeSpec = { kind: ShapeKind; centerX: number; centerY: number; sizeX: number; sizeY: number; projection: number; rotation: number };
type TransformSpec = { centerX: number; centerY: number; rotation: number };
type TextSpec = TransformSpec & { content: string; fontSize: number; font: TextFont; weight: TextWeight; lineHeight: number; letterSpacing: number; alignment: TextAlignment };
type GratingSpec = TransformSpec & { width: number; height: number; period: number; duty: number; phase: number };
type TextRun = { text: string; x: number; baseline: number };
type TextLayout = { runs: TextRun[]; bounds: Bounds; width: number; height: number };
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_DPI = 300;
const DEFAULT_SHAPE_SIZE = 300;
const MIN_ZOOM = 2;
const MAX_ZOOM = 1600;
const HISTORY_BYTE_LIMIT = 128 * 1024 * 1024;
const TEXT_FONTS: Record<TextFont, string> = {
  sans: '"Microsoft YaHei", "Noto Sans SC", Arial, sans-serif',
  serif: 'SimSun, "Songti SC", "Noto Serif SC", serif',
  mono: 'Consolas, "Microsoft YaHei", monospace',
};

const BUILT_IN_QUOTES: Quote[] = [
  { content: '行到水穷处，坐看云起时。', source: '王维《终南别业》' },
  { content: '无边落木萧萧下，不尽长江滚滚来。', source: '杜甫《登高》' },
  { content: '十年生死两茫茫，不思量，自难忘。', source: '苏轼《江城子·乙卯正月二十日夜记梦》' },
  { content: '知不可乎骤得，托遗响于悲风。', source: '苏轼《赤壁赋》' },
  { content: '后之视今，亦犹今之视昔，悲夫！', source: '王羲之《兰亭集序》' },
];

function makeId(prefix = 'layer') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function createLayer(width: number, height: number, name: string, fill: LayerFill = TRANSPARENT): Layer {
  const pixels = new Uint8Array(width * height);
  if (fill !== TRANSPARENT) pixels.fill(fill);
  return { id: makeId(), name, pixels, visible: true, locked: false };
}

function cloneLayer(layer: Layer): Layer {
  return { ...layer, pixels: new Uint8Array(layer.pixels) };
}

function toPixels(value: number, unit: SizeUnit, dpi: number) {
  return unit === 'px' ? value : (value / 25.4) * dpi;
}

function fromPixels(value: number, unit: SizeUnit, dpi: number) {
  return unit === 'px' ? value : (value / dpi) * 25.4;
}

function localToWorld(point: Point, spec: TransformSpec): Point {
  const theta = (spec.rotation * Math.PI) / 180;
  const cosine = Math.cos(theta);
  const sine = Math.sin(theta);
  return { x: spec.centerX + point.x * cosine + point.y * sine, y: spec.centerY - point.x * sine + point.y * cosine };
}

function worldToLocal(x: number, y: number, spec: TransformSpec): Point {
  const theta = (spec.rotation * Math.PI) / 180;
  const cosine = Math.cos(theta);
  const sine = Math.sin(theta);
  const dx = x - spec.centerX;
  const dy = y - spec.centerY;
  return { x: dx * cosine - dy * sine, y: dx * sine + dy * cosine };
}

function triangleVertices(spec: ShapeSpec): [Point, Point, Point] {
  const centroidX = (spec.sizeX + spec.projection) / 3;
  return [
    { x: -centroidX, y: spec.sizeY / 3 },
    { x: spec.sizeX - centroidX, y: spec.sizeY / 3 },
    { x: spec.projection - centroidX, y: (-2 * spec.sizeY) / 3 },
  ];
}

function insideTriangle(point: Point, vertices: [Point, Point, Point]) {
  const sign = (p: Point, a: Point, b: Point) => (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
  const d1 = sign(point, vertices[0], vertices[1]);
  const d2 = sign(point, vertices[1], vertices[2]);
  const d3 = sign(point, vertices[2], vertices[0]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function isInsideShape(x: number, y: number, spec: ShapeSpec) {
  const point = worldToLocal(x, y, spec);
  if (spec.kind === 'circle') {
    const radiusX = spec.sizeX / 2;
    const radiusY = spec.sizeY / 2;
    if (radiusX <= 0 || radiusY <= 0) return false;
    return (point.x * point.x) / (radiusX * radiusX) + (point.y * point.y) / (radiusY * radiusY) <= 1;
  }
  if (spec.kind === 'rectangle') return Math.abs(point.x) <= spec.sizeX / 2 && Math.abs(point.y) <= spec.sizeY / 2;
  return insideTriangle(point, triangleVertices(spec));
}

function shapeBounds(spec: ShapeSpec): Bounds {
  if (spec.kind === 'circle') {
    const theta = (spec.rotation * Math.PI) / 180;
    const radiusX = spec.sizeX / 2;
    const radiusY = spec.sizeY / 2;
    const extentX = Math.sqrt((radiusX * Math.cos(theta)) ** 2 + (radiusY * Math.sin(theta)) ** 2);
    const extentY = Math.sqrt((radiusX * Math.sin(theta)) ** 2 + (radiusY * Math.cos(theta)) ** 2);
    return { minX: spec.centerX - extentX, maxX: spec.centerX + extentX, minY: spec.centerY - extentY, maxY: spec.centerY + extentY };
  }
  const localPoints = spec.kind === 'triangle' ? triangleVertices(spec) : [
    { x: -spec.sizeX / 2, y: -spec.sizeY / 2 }, { x: spec.sizeX / 2, y: -spec.sizeY / 2 },
    { x: spec.sizeX / 2, y: spec.sizeY / 2 }, { x: -spec.sizeX / 2, y: spec.sizeY / 2 },
  ];
  const points = localPoints.map((point) => localToWorld(point, spec));
  return {
    minX: Math.min(...points.map((point) => point.x)), maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)), maxY: Math.max(...points.map((point) => point.y)),
  };
}

function pixelBounds(bounds: Bounds, width: number, height: number) {
  const theoreticalMinX = Math.ceil(bounds.minX - 0.5);
  const theoreticalMaxX = Math.floor(bounds.maxX - 0.5);
  const theoreticalMinY = Math.ceil(bounds.minY - 0.5);
  const theoreticalMaxY = Math.floor(bounds.maxY - 0.5);
  const minX = Math.max(0, theoreticalMinX);
  const maxX = Math.min(width - 1, theoreticalMaxX);
  const minY = Math.max(0, theoreticalMinY);
  const maxY = Math.min(height - 1, theoreticalMaxY);
  return { minX, maxX, minY, maxY, theoreticalMinX, theoreticalMaxX, theoreticalMinY, theoreticalMaxY, hasIntersection: minX <= maxX && minY <= maxY };
}

function writeShape(pixels: Uint8Array, width: number, height: number, spec: ShapeSpec, operation: BooleanOperation) {
  const range = pixelBounds(shapeBounds(spec), width, height);
  if (!range.hasIntersection) return 0;
  let touched = 0;
  for (let y = range.minY; y <= range.maxY; y += 1) for (let x = range.minX; x <= range.maxX; x += 1) {
    if (!isInsideShape(x + 0.5, y + 0.5, spec)) continue;
    const index = y * width + x;
    if (operation === 'set1') pixels[index] = OPAQUE_ONE;
    else if (operation === 'set0') pixels[index] = OPAQUE_ZERO;
    else pixels[index] = pixels[index] === OPAQUE_ONE ? OPAQUE_ZERO : OPAQUE_ONE;
    touched += 1;
  }
  return touched;
}

function setTextFont(context: CanvasRenderingContext2D, spec: TextSpec) {
  context.font = `${spec.weight} ${Math.max(0.5, spec.fontSize)}px ${TEXT_FONTS[spec.font]}`;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
}

function measureTextLayout(context: CanvasRenderingContext2D, spec: TextSpec): TextLayout {
  setTextFont(context, spec);
  const lines = spec.content.replace(/\r\n?/g, '\n').split('\n');
  const fontSize = Math.max(0.5, spec.fontSize);
  const lineAdvance = Math.max(0.5, fontSize * Math.max(0.1, spec.lineHeight));
  const letterSpacing = Math.max(-fontSize * 0.9, spec.letterSpacing);
  const characterLines = lines.map((line) => Array.from(line));
  const lineWidths = characterLines.map((characters, index) => {
    if (Math.abs(letterSpacing) < 0.001) return context.measureText(lines[index]).width;
    return Math.max(0, characters.reduce((sum, character) => sum + context.measureText(character).width, 0) + Math.max(0, characters.length - 1) * letterSpacing);
  });
  const blockWidth = Math.max(0, ...lineWidths);
  const blockHeight = fontSize + Math.max(0, lines.length - 1) * lineAdvance;
  const blockTop = -blockHeight / 2;
  const runs: TextRun[] = [];
  let minX = -blockWidth / 2;
  let maxX = blockWidth / 2;
  let minY = blockTop;
  let maxY = blockTop + blockHeight;

  lines.forEach((line, lineIndex) => {
    const lineWidth = lineWidths[lineIndex];
    const startX = spec.alignment === 'left' ? -blockWidth / 2 : spec.alignment === 'right' ? blockWidth / 2 - lineWidth : -lineWidth / 2;
    const baseline = blockTop + fontSize * 0.8 + lineIndex * lineAdvance;
    if (Math.abs(letterSpacing) < 0.001) {
      runs.push({ text: line, x: startX, baseline });
      const metrics = context.measureText(line);
      minX = Math.min(minX, startX - (metrics.actualBoundingBoxLeft || 0));
      maxX = Math.max(maxX, startX + (metrics.actualBoundingBoxRight || lineWidth));
      minY = Math.min(minY, baseline - (metrics.actualBoundingBoxAscent || fontSize * 0.8));
      maxY = Math.max(maxY, baseline + (metrics.actualBoundingBoxDescent || fontSize * 0.2));
      return;
    }
    let x = startX;
    characterLines[lineIndex].forEach((character, characterIndex) => {
      const metrics = context.measureText(character);
      runs.push({ text: character, x, baseline });
      minX = Math.min(minX, x - (metrics.actualBoundingBoxLeft || 0));
      maxX = Math.max(maxX, x + (metrics.actualBoundingBoxRight || metrics.width));
      minY = Math.min(minY, baseline - (metrics.actualBoundingBoxAscent || fontSize * 0.8));
      maxY = Math.max(maxY, baseline + (metrics.actualBoundingBoxDescent || fontSize * 0.2));
      x += metrics.width + (characterIndex < characterLines[lineIndex].length - 1 ? letterSpacing : 0);
    });
  });
  return { runs, bounds: { minX, maxX, minY, maxY }, width: blockWidth, height: blockHeight };
}

function drawTextLayout(context: CanvasRenderingContext2D, layout: TextLayout, mode: 'fill' | 'stroke') {
  for (const run of layout.runs) {
    if (mode === 'fill') context.fillText(run.text, run.x, run.baseline);
    else context.strokeText(run.text, run.x, run.baseline);
  }
}

function transformedBounds(bounds: Bounds, spec: TransformSpec): Bounds {
  const points = [
    { x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY },
  ].map((point) => localToWorld(point, spec));
  return {
    minX: Math.min(...points.map((point) => point.x)), maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)), maxY: Math.max(...points.map((point) => point.y)),
  };
}

function gratingBounds(spec: GratingSpec): Bounds {
  return transformedBounds({ minX: -spec.width / 2, maxX: spec.width / 2, minY: -spec.height / 2, maxY: spec.height / 2 }, spec);
}

function isGratingLine(localX: number, spec: GratingSpec) {
  if (spec.duty <= 0) return false;
  if (spec.duty >= 100) return true;
  const wrapped = (((localX - spec.phase + spec.period / 2) % spec.period) + spec.period) % spec.period - spec.period / 2;
  const halfLineWidth = (spec.period * spec.duty) / 200;
  return wrapped >= -halfLineWidth && wrapped < halfLineWidth;
}

function sampleGratingPixel(x: number, y: number, spec: GratingSpec) {
  const local = worldToLocal(x + 0.5, y + 0.5, spec);
  if (Math.abs(local.x) > spec.width / 2 || Math.abs(local.y) > spec.height / 2) return null;
  return isGratingLine(local.x, spec);
}

function gratingWriteValue(line: boolean, mode: GratingWriteMode, polarity: GratingPolarity, operation: BooleanOperation, previous: number) {
  if (mode === 'cover') return line === (polarity === 'line1') ? OPAQUE_ONE : OPAQUE_ZERO;
  if (!line) return null;
  if (operation === 'set1') return OPAQUE_ONE;
  if (operation === 'set0') return OPAQUE_ZERO;
  return previous === OPAQUE_ONE ? OPAQUE_ZERO : OPAQUE_ONE;
}

function writeGrating(pixels: Uint8Array, width: number, height: number, spec: GratingSpec, mode: GratingWriteMode, polarity: GratingPolarity, operation: BooleanOperation) {
  const range = pixelBounds(gratingBounds(spec), width, height);
  if (!range.hasIntersection || spec.width <= 0 || spec.height <= 0 || spec.period <= 0) return 0;
  let touched = 0;
  for (let y = range.minY; y <= range.maxY; y += 1) for (let x = range.minX; x <= range.maxX; x += 1) {
    const line = sampleGratingPixel(x, y, spec);
    if (line === null) continue;
    const index = y * width + x;
    const value = gratingWriteValue(line, mode, polarity, operation, pixels[index]);
    if (value === null) continue;
    pixels[index] = value;
    touched += 1;
  }
  return touched;
}

const PREVIEW_STROKE_WIDTH = 3.5;

function strokeParametricBoundary(context: CanvasRenderingContext2D, outside: boolean, scale: number) {
  context.save();
  context.setLineDash([6 / scale, 4 / scale]);
  context.lineWidth = PREVIEW_STROKE_WIDTH / scale; context.strokeStyle = '#ffffff'; context.stroke();
  context.lineWidth = 1.5 / scale; context.strokeStyle = outside ? '#c94b42' : '#316749'; context.stroke();
  context.restore();
}

function drawGratingPreview(context: CanvasRenderingContext2D, spec: GratingSpec, outside: boolean, previewScale: number) {
  const halfWidth = spec.width / 2;
  const halfHeight = spec.height / 2;
  const lineWidth = (spec.period * spec.duty) / 100;
  context.beginPath();
  context.rect(-halfWidth, -halfHeight, spec.width, spec.height);
  // Close guides would merge into what looks like a solid fill at this zoom.
  if (Math.min(lineWidth, spec.period - lineWidth) * previewScale >= PREVIEW_STROKE_WIDTH) {
    const phase = spec.phase % spec.period;
    const firstIndex = Math.ceil((-halfWidth - phase - lineWidth / 2) / spec.period);
    const lastIndex = Math.floor((halfWidth - phase + lineWidth / 2) / spec.period);
    const lineCount = lastIndex - firstIndex + 1;
    if (lineCount <= 4096) {
      for (let index = firstIndex; index <= lastIndex; index += 1) {
        const center = phase + index * spec.period;
        for (const edge of [center - lineWidth / 2, center + lineWidth / 2]) {
          if (edge <= -halfWidth || edge >= halfWidth) continue;
          context.moveTo(edge, -halfHeight);
          context.lineTo(edge, halfHeight);
        }
      }
    }
  }
  strokeParametricBoundary(context, outside, previewScale);
}

function measureTextBounds(spec: TextSpec): Bounds {
  if (typeof document === 'undefined') return { minX: spec.centerX, maxX: spec.centerX, minY: spec.centerY, maxY: spec.centerY };
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return { minX: spec.centerX, maxX: spec.centerX, minY: spec.centerY, maxY: spec.centerY };
  return transformedBounds(measureTextLayout(context, spec).bounds, spec);
}

function writeText(pixels: Uint8Array, width: number, height: number, spec: TextSpec, operation: BooleanOperation) {
  const measuredBounds = measureTextBounds(spec);
  const paddedBounds = { minX: measuredBounds.minX - 2, maxX: measuredBounds.maxX + 2, minY: measuredBounds.minY - 2, maxY: measuredBounds.maxY + 2 };
  const range = pixelBounds(paddedBounds, width, height);
  if (!range.hasIntersection) return 0;
  const scratch = document.createElement('canvas');
  scratch.width = range.maxX - range.minX + 1;
  scratch.height = range.maxY - range.minY + 1;
  const context = scratch.getContext('2d', { willReadFrequently: true });
  if (!context) return 0;
  context.translate(spec.centerX - range.minX, spec.centerY - range.minY);
  context.rotate((-spec.rotation * Math.PI) / 180);
  const layout = measureTextLayout(context, spec);
  context.fillStyle = '#fff';
  drawTextLayout(context, layout, 'fill');
  context.setTransform(1, 0, 0, 1, 0, 0);
  const image = context.getImageData(0, 0, scratch.width, scratch.height).data;
  let touched = 0;
  for (let y = 0; y < scratch.height; y += 1) for (let x = 0; x < scratch.width; x += 1) {
    if (image[(y * scratch.width + x) * 4 + 3] < 128) continue;
    const index = (range.minY + y) * width + range.minX + x;
    if (operation === 'set1') pixels[index] = OPAQUE_ONE;
    else if (operation === 'set0') pixels[index] = OPAQUE_ZERO;
    else pixels[index] = pixels[index] === OPAQUE_ONE ? OPAQUE_ZERO : OPAQUE_ONE;
    touched += 1;
  }
  return touched;
}

function compositeLayers(layers: Layer[], width: number, height: number) {
  const pixels = new Uint8Array(width * height);
  const resolved = new Uint8Array(width * height);
  for (const layer of layers) {
    if (!layer.visible) continue;
    for (let index = 0; index < layer.pixels.length; index += 1) {
      if (resolved[index] || layer.pixels[index] === TRANSPARENT) continue;
      pixels[index] = layer.pixels[index] === OPAQUE_ONE ? 1 : 0;
      resolved[index] = 1;
    }
  }
  return { pixels, resolved };
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function LinkIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.2 13.8a4.5 4.5 0 0 0 6.4.1l2.3-2.3a4.5 4.5 0 0 0-6.4-6.4l-1.3 1.3" /><path d="M13.8 10.2a4.5 4.5 0 0 0-6.4-.1l-2.3 2.3a4.5 4.5 0 0 0 6.4 6.4l1.3-1.3" /></svg>;
}


function EraserIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m13.5 3.5-11 10a2.1 2.1 0 0 0 0 3L6 20h5l9.5-9.5a2.1 2.1 0 0 0 0-3l-4-4a2.1 2.1 0 0 0-3 0Z" /><path d="m7 9 8 8M11 20h10" /></svg>;
}

function FitIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /><rect x="7" y="7" width="10" height="10" rx="1" /></svg>;
}

function randomBuiltInQuote() {
  return BUILT_IN_QUOTES[Math.floor(Math.random() * BUILT_IN_QUOTES.length)];
}

async function fetchRandomQuote() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2800);
  try {
    const response = await fetch('https://v1.jinrishici.com/all.json', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json() as { content?: unknown; author?: unknown; origin?: unknown };
    const content = typeof data.content === 'string' ? data.content.trim() : '';
    const author = typeof data.author === 'string' ? data.author.trim() : '';
    const origin = typeof data.origin === 'string' ? data.origin.trim() : '';
    if (!content || content.length > 72 || (!author && !origin)) return null;
    return { content, source: `${author}${origin ? `《${origin}》` : ''}` } satisfies Quote;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}



export default function Home() {
  const { workspaceRef, leftRef, rightRef, style: workspaceStyle, canvas: canvasSplitter,
    left: leftSplitter, right: rightSplitter, layers: layersSplitter } = usePanelLayout();
  const [initialLayer] = useState(() => createLayer(DEFAULT_WIDTH, DEFAULT_HEIGHT, 'Layer 1'));
  const layersRef = useRef<Layer[]>([initialLayer]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositeImageRef = useRef<ImageData | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasFrameRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const shapeFieldsRef = useRef<HTMLElement>(null);
  const newCanvasFieldsRef = useRef<HTMLElement>(null);
  const matrixFieldsRef = useRef<HTMLElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<Point | null>(null);
  const selectionStartRef = useRef<Point | null>(null);
  const panRef = useRef<{ clientX: number; clientY: number; scrollLeft: number; scrollTop: number } | null>(null);
  const spacePressedRef = useRef(false);
  const dirtyRef = useRef(false);
  const undoRef = useRef<HistorySnapshot[]>([]);
  const redoRef = useRef<HistorySnapshot[]>([]);
  const [layerHistory] = useState(createLayerHistory);
  const [renderBlockPreview] = useState(createBlockPreviewRenderer);
  const matrixDraftRef = useRef<Uint8Array | null>(null);
  const pendingZoomAnchorRef = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const appliedAutoFitRequestRef = useRef(-1);
  const paintFrameRef = useRef<number | null>(null);
  const queuedQuoteRef = useRef<Quote | null>(null);
  const quoteFetchPendingRef = useRef(false);

  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [dpi, setDpi] = useState(DEFAULT_DPI);
  const [canvasPixelSizeUnit, setCanvasPixelSizeUnit] = useState<PixelSideUnit | null>(null);
  const [documentView, setDocumentView] = useState({ layers: [initialLayer], version: 1 });
  const [historyView, setHistoryView] = useState({ version: 0, canUndo: false, canRedo: false });
  const [activeLayerId, setActiveLayerId] = useState(initialLayer.id);
  const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>([initialLayer.id]);
  const [dragLayerId, setDragLayerId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('shape');
  const [brushSize, setBrushSize] = useState(12);
  const [paintValue, setPaintValue] = useState<0 | 1>(1);
  const [brushDragging, setBrushDragging] = useState(false);
  const [shape, setShape] = useState<ParametricKind>('circle');
  const [centerX, setCenterX] = useState(DEFAULT_WIDTH / 2);
  const [centerY, setCenterY] = useState(DEFAULT_HEIGHT / 2);
  const { x: dimensionX, y: dimensionY, setX: setDimensionX, setY: setDimensionY, linked: aspectLinked,
    toggle: toggleAspect, updateX: updateDimensionX, updateY: updateDimensionY } = useLinkedDimensions(DEFAULT_SHAPE_SIZE, DEFAULT_SHAPE_SIZE);
  const [triangleBase, setTriangleBase] = useState(DEFAULT_SHAPE_SIZE);
  const [triangleHeight, setTriangleHeight] = useState((DEFAULT_SHAPE_SIZE * Math.sqrt(3)) / 2);
  const [triangleProjection, setTriangleProjection] = useState(DEFAULT_SHAPE_SIZE / 2);
  const [equilateral, setEquilateral] = useState(true);
  const [textContent, setTextContent] = useState('忽闻海上有仙山 山在虚无缥缈间');
  const [textFontSize, setTextFontSize] = useState(72);
  const [textFont, setTextFont] = useState<TextFont>('sans');
  const [textWeight, setTextWeight] = useState<TextWeight>('700');
  const [textLineHeight, setTextLineHeight] = useState(1.2);
  const [textLetterSpacing, setTextLetterSpacing] = useState(0);
  const [textAlignment, setTextAlignment] = useState<TextAlignment>('center');
  const { x: gratingWidth, y: gratingHeight, setX: setGratingWidth, setY: setGratingHeight, linked: gratingAspectLinked,
    toggle: toggleGratingAspect, updateX: updateGratingWidth, updateY: updateGratingHeight } = useLinkedDimensions(200, 200);
  const [gratingPeriod, setGratingPeriod] = useState(20);
  const [gratingDuty, setGratingDuty] = useState(50);
  const [gratingPhase, setGratingPhase] = useState(0);
  const [gratingWriteMode, setGratingWriteMode] = useState<GratingWriteMode>('cover');
  const [gratingPolarity, setGratingPolarity] = useState<GratingPolarity>('line1');
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>('px');
  const [rotation, setRotation] = useState(0);
  const [operation, setOperation] = useState<BooleanOperation>('set1');
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 });
  const [pointerInCanvas, setPointerInCanvas] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<Selection | null>(null);
  const [binaryClipboard, setBinaryClipboard] = useState<BinaryBlock | null>(null);
  const [pastePreview, setPastePreview] = useState<(BinaryBlock & Point) | null>(null);
  const [movePreview, setMovePreview] = useState<MovePreview | null>(null);
  const [zoom, setZoom] = useState(100);
  const [fitScale, setFitScale] = useState(0.5);
  const [autoFitRequest, setAutoFitRequest] = useState(0);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [matrixView, setMatrixView] = useState<MatrixView>('cells');
  const [matrixScope, setMatrixScope] = useState<MatrixScope>('layer');
  const [matrixText, setMatrixText] = useState('');
  const [matrixDraftView, setMatrixDraftView] = useState<{ pixels: Uint8Array | null; version: number }>({ pixels: null, version: 0 });
  const [matrixStartX, setMatrixStartX] = useState(0);
  const [matrixStartY, setMatrixStartY] = useState(0);
  const [newCanvasOpen, setNewCanvasOpen] = useState(false);
  const [newWidth, setNewWidth] = useState(DEFAULT_WIDTH);
  const [newHeight, setNewHeight] = useState(DEFAULT_HEIGHT);
  const [newDpi, setNewDpi] = useState(DEFAULT_DPI);
  const [newResolutionMode, setNewResolutionMode] = useState<ResolutionMode>('dpi');
  const [newPixelSideUnit, setNewPixelSideUnit] = useState<PixelSideUnit>('um');
  const [helpOpen, setHelpOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [quote, setQuote] = useState<Quote>(BUILT_IN_QUOTES[0]);
  const [dirty, setDirty] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const [processing, setProcessing] = useState('');
  const [exportBaseName, setExportBaseName] = useState(`binary-mask-${DEFAULT_WIDTH}x${DEFAULT_HEIGHT}`);
  const [exportTransparency, setExportTransparency] = useState(true);
  const [toast, setToast] = useState('Ready with a blank 1920 × 1080 canvas. Start editing or create a new canvas.');

  const setDocumentDirty = (value: boolean) => { dirtyRef.current = value; setDirty(value); };
  const bumpDocument = (markDirty = true) => {
    const layers = layersRef.current.map((layer) => ({ ...layer }));
    setDocumentView((current) => ({ layers, version: current.version + 1 }));
    if (markDirty) setDocumentDirty(true);
  };
  const bumpHistory = () => {
    const canUndo = undoRef.current.length > 0;
    const canRedo = redoRef.current.length > 0;
    setHistoryView((current) => ({ version: current.version + 1, canUndo, canRedo }));
  };
  const bumpMatrixDraft = () => {
    const pixels = matrixDraftRef.current;
    setMatrixDraftView((current) => ({ pixels, version: current.version + 1 }));
  };
  const { layers: layerList, version: docVersion } = documentView;
  const activeLayer = layerList.find((layer) => layer.id === activeLayerId) ?? layerList[0];
  const getActiveLayer = () => layersRef.current.find((layer) => layer.id === activeLayerId) ?? layersRef.current[0];
  const selectedSet = useMemo(() => new Set(selectedLayerIds), [selectedLayerIds]);
  const compositeData = useMemo(() => compositeLayers(layerList, width, height), [layerList, height, width]);
  const composite = compositeData.pixels;
  const compositeResolved = compositeData.resolved;
  const whitePixels = useMemo(() => { let count = 0; for (const value of composite) count += value; return count; }, [composite]);
  const cursorIndex = cursor.y * width + cursor.x;
  const currentValue = compositeResolved[cursorIndex] ? composite[cursorIndex] : 'null';
  const physicalWidth = ((width / dpi) * 25.4).toFixed(2);
  const physicalHeight = ((height / dpi) * 25.4).toFixed(2);
  const canvasResolutionLabel = canvasPixelSizeUnit ? 'Pixel size' : 'DPI';
  const canvasResolutionValue = canvasPixelSizeUnit ? formatPixelSize(PIXEL_SIDE_UNITS_PER_INCH[canvasPixelSizeUnit] / dpi) : dpi.toFixed(2);
  const canvasResolutionUnit = canvasPixelSizeUnit === 'um' ? 'μm' : canvasPixelSizeUnit ?? 'DPI';
  const resolvedTriangleHeight = equilateral ? (triangleBase * Math.sqrt(3)) / 2 : triangleHeight;
  const resolvedTriangleProjection = equilateral ? triangleBase / 2 : triangleProjection;
  const geometryKind: ShapeKind = shape === 'text' || shape === 'grating' ? 'rectangle' : shape;
  const sizeX = toPixels(shape === 'triangle' ? triangleBase : dimensionX, sizeUnit, dpi);
  const sizeY = toPixels(shape === 'triangle' ? resolvedTriangleHeight : dimensionY, sizeUnit, dpi);
  const projection = toPixels(shape === 'triangle' ? resolvedTriangleProjection : 0, sizeUnit, dpi);
  const textFontSizePixels = toPixels(textFontSize, sizeUnit, dpi);
  const textLetterSpacingPixels = toPixels(textLetterSpacing, sizeUnit, dpi);
  const gratingWidthPixels = toPixels(gratingWidth, sizeUnit, dpi);
  const gratingHeightPixels = toPixels(gratingHeight, sizeUnit, dpi);
  const gratingPeriodPixels = toPixels(gratingPeriod, sizeUnit, dpi);
  const gratingPhasePixels = toPixels(gratingPhase, sizeUnit, dpi);
  const shapeSpec = useMemo<ShapeSpec>(() => ({ kind: geometryKind, centerX, centerY, sizeX, sizeY, projection, rotation }), [centerX, centerY, geometryKind, projection, rotation, sizeX, sizeY]);
  const textSpec = useMemo<TextSpec>(() => ({ content: textContent, centerX, centerY, fontSize: textFontSizePixels, font: textFont, weight: textWeight, lineHeight: textLineHeight, letterSpacing: textLetterSpacingPixels, alignment: textAlignment, rotation }), [centerX, centerY, rotation, textAlignment, textContent, textFont, textFontSizePixels, textLetterSpacingPixels, textLineHeight, textWeight]);
  const gratingSpec = useMemo<GratingSpec>(() => ({ centerX, centerY, width: gratingWidthPixels, height: gratingHeightPixels, period: gratingPeriodPixels, duty: gratingDuty, phase: gratingPhasePixels, rotation }), [centerX, centerY, gratingDuty, gratingHeightPixels, gratingPeriodPixels, gratingPhasePixels, gratingWidthPixels, rotation]);
  const geometryBounds = useMemo(() => shapeBounds(shapeSpec), [shapeSpec]);
  const bounds = useMemo(() => shape === 'text' ? measureTextBounds(textSpec) : shape === 'grating' ? gratingBounds(gratingSpec) : geometryBounds, [geometryBounds, gratingSpec, shape, textSpec]);
  const hasParametricContent = shape === 'text' ? Boolean(textContent.trim()) : shape === 'grating' ? gratingWidthPixels > 0 && gratingHeightPixels > 0 && gratingPeriodPixels > 0 : true;
  const showGratingPreview = tool === 'shape' && shape === 'grating' && hasParametricContent;
  let gratingPreviewReadout = 'Hover over the grating';
  if (showGratingPreview && pointerInCanvas) {
    const line = sampleGratingPixel(cursor.x, cursor.y, gratingSpec);
    if (line === null) gratingPreviewReadout = 'Outside grating';
    else {
      const value = gratingWriteValue(line, gratingWriteMode, gratingPolarity, operation, activeLayer.pixels[cursor.y * width + cursor.x]);
      const label = value === OPAQUE_ONE ? 'White 1' : value === OPAQUE_ZERO ? 'Black 0' : 'Unchanged';
      gratingPreviewReadout = `${line ? 'Line' : 'Gap'} · ${label}`;
    }
  }
  const gratingAliased = shape === 'grating' && gratingPeriodPixels < 2;
  const clippedRange = useMemo(() => pixelBounds(bounds, width, height), [bounds, height, width]);
  const partiallyOutside = hasParametricContent && (bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > width || bounds.maxY > height);
  const parametricLabel = shape === 'text' ? 'Text' : shape === 'grating' ? 'Grating' : 'Shape';
  const parametricWarning = !hasParametricContent
    ? (shape === 'text' ? 'Enter text to apply.' : 'Width, height, and period must be greater than 0.')
    : !clippedRange.hasIntersection ? `${parametricLabel} is entirely outside the canvas.`
      : partiallyOutside ? 'Out-of-bounds areas will be clipped when applied.' : '';

  const snapshotCurrent = () => layerHistory.snapshot(layersRef.current, activeLayerId, selectedLayerIds);
  const snapshotBytes = (snapshot: HistorySnapshot) => snapshot.layers.reduce((sum, layer) => sum + layer.pixels.byteLength, 0);
  const pushHistory = () => {
    undoRef.current.push(snapshotCurrent());
    let total = undoRef.current.reduce((sum, snapshot) => sum + snapshotBytes(snapshot), 0);
    while (total > HISTORY_BYTE_LIMIT && undoRef.current.length > 1) total -= snapshotBytes(undoRef.current.shift()!);
    redoRef.current = []; bumpHistory();
  };
  const restoreSnapshot = (snapshot: HistorySnapshot) => {
    layersRef.current = layerHistory.restore(snapshot);
    const restoredActive = layersRef.current.some((layer) => layer.id === snapshot.activeLayerId) ? snapshot.activeLayerId : layersRef.current[0].id;
    setActiveLayerId(restoredActive);
    const validSelected = snapshot.selectedLayerIds.filter((id) => layersRef.current.some((layer) => layer.id === id));
    setSelectedLayerIds(validSelected.length ? validSelected : [restoredActive]);
    bumpDocument(); bumpHistory();
  };
  const undo = () => { const previous = undoRef.current.pop(); if (!previous) return; redoRef.current.push(snapshotCurrent()); restoreSnapshot(previous); };
  const redo = () => { const next = redoRef.current.pop(); if (!next) return; undoRef.current.push(snapshotCurrent()); restoreSnapshot(next); };
  const getEditableLayer = () => {
    const layer = getActiveLayer();
    if (!layer) return null;
    if (!layer.locked) return layer;
    setToast('The current layer is locked. Unlock it first.');
    return null;
  };
  const resetHistory = () => { undoRef.current = []; redoRef.current = []; bumpHistory(); };
  const scheduleDocumentBump = () => {
    if (paintFrameRef.current !== null) return;
    paintFrameRef.current = window.requestAnimationFrame(() => { paintFrameRef.current = null; bumpDocument(); });
  };
  const withProcessing = async (label: string, task: () => void | Promise<void>) => {
    if (processing) return;
    setProcessing(label);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    try { await task(); } finally { setProcessing(''); }
  };
  const prefetchRandomQuote = useCallback(() => {
    if (quoteFetchPendingRef.current || queuedQuoteRef.current) return;
    quoteFetchPendingRef.current = true;
    void fetchRandomQuote().then((onlineQuote) => { if (onlineQuote) queuedQuoteRef.current = onlineQuote; }).finally(() => { quoteFetchPendingRef.current = false; });
  }, []);
  const openInfoWindow = (kind: 'help' | 'about') => {
    setQuote(queuedQuoteRef.current ?? randomBuiltInQuote());
    queuedQuoteRef.current = null;
    if (kind === 'help') setHelpOpen(true); else setAboutOpen(true);
    prefetchRandomQuote();
  };

  useEffect(() => () => { if (paintFrameRef.current !== null) window.cancelAnimationFrame(paintFrameRef.current); }, []);
  useEffect(() => { prefetchRandomQuote(); }, [prefetchRandomQuote]);
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    resizeCanvas(canvas, width, height);
    const context = canvas.getContext('2d'); if (!context) return;
    let image = compositeImageRef.current;
    if (!image || image.width !== width || image.height !== height) {
      image = context.createImageData(width, height);
      compositeImageRef.current = image;
    }
    for (let index = 0; index < composite.length; index += 1) {
      const pixelX = index % width; const pixelY = Math.floor(index / width);
      const checker = (Math.floor(pixelX / 12) + Math.floor(pixelY / 12)) % 2 ? 212 : 239;
      const value = compositeResolved[index] ? (composite[index] ? 255 : 0) : checker; const target = index * 4;
      image.data[target] = value; image.data[target + 1] = value; image.data[target + 2] = value; image.data[target + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [composite, compositeResolved, height, width]);

  const brushCursor = (tool === 'draw' || tool === 'erase') && !pastePreview && !movePreview ? cursor : null;
  useEffect(() => {
    const canvas = overlayRef.current; if (!canvas) return;
    resizeCanvas(canvas, width, height);
    const context = canvas.getContext('2d'); if (!context) return;
    context.clearRect(0, 0, width, height);
    context.lineWidth = Math.max(1.5, width / 900);
    context.setLineDash([Math.max(5, width / 240), Math.max(4, width / 300)]);
    if (tool === 'shape' && hasParametricContent) {
      const previewScale = Math.max(MIN_ZOOM / 100, zoom / 100);
      context.save(); context.translate(centerX, centerY); context.rotate((-rotation * Math.PI) / 180);
      if (shape === 'text') {
        const layout = measureTextLayout(context, textSpec);
        context.setLineDash([3 / previewScale, 2 / previewScale]);
        context.lineWidth = Math.min(1 / previewScale, textFontSizePixels / 32);
        context.strokeStyle = partiallyOutside ? '#c94b42' : '#316749';
        drawTextLayout(context, layout, 'stroke');
        context.beginPath(); context.rect(layout.bounds.minX, layout.bounds.minY, layout.bounds.maxX - layout.bounds.minX, layout.bounds.maxY - layout.bounds.minY);
        strokeParametricBoundary(context, partiallyOutside, previewScale);
      } else if (shape === 'grating') {
        drawGratingPreview(context, gratingSpec, partiallyOutside, previewScale);
      } else {
        context.beginPath();
        if (shape === 'circle') context.ellipse(0, 0, sizeX / 2, sizeY / 2, 0, 0, Math.PI * 2);
        else if (shape === 'rectangle') context.rect(-sizeX / 2, -sizeY / 2, sizeX, sizeY);
        else { const vertices = triangleVertices(shapeSpec); context.moveTo(vertices[0].x, vertices[0].y); context.lineTo(vertices[1].x, vertices[1].y); context.lineTo(vertices[2].x, vertices[2].y); context.closePath(); }
        strokeParametricBoundary(context, partiallyOutside, previewScale);
      }
      context.restore();
    }
    const activeSelection = selectionDraft ?? selection;
    if (activeSelection) {
      context.save(); context.fillStyle = 'rgba(20,37,31,.13)';
      context.fillRect(0, 0, width, activeSelection.y);
      context.fillRect(0, activeSelection.y + activeSelection.height, width, height - activeSelection.y - activeSelection.height);
      context.fillRect(0, activeSelection.y, activeSelection.x, activeSelection.height);
      context.fillRect(activeSelection.x + activeSelection.width, activeSelection.y, width - activeSelection.x - activeSelection.width, activeSelection.height);
      context.strokeStyle = '#c7ff3d'; context.fillStyle = 'rgba(199,255,61,.06)';
      context.fillRect(activeSelection.x, activeSelection.y, activeSelection.width, activeSelection.height);
      context.strokeRect(activeSelection.x, activeSelection.y, activeSelection.width, activeSelection.height); context.restore();
    }
    if (pastePreview) renderBlockPreview(context, pastePreview, 190);
    if (movePreview) renderBlockPreview(context, movePreview, 220);
    if (brushCursor) {
      const radius = Math.max(.5, brushSize / 2);
      context.save(); context.setLineDash([]); context.lineWidth = Math.max(1, width / 1200);
      context.beginPath(); context.arc(brushCursor.x + .5, brushCursor.y + .5, radius, 0, Math.PI * 2); context.strokeStyle = '#fff'; context.stroke();
      context.lineWidth *= 2.6; context.globalCompositeOperation = 'destination-over'; context.strokeStyle = '#111'; context.stroke(); context.globalCompositeOperation = 'source-over';
      context.beginPath(); context.arc(brushCursor.x + .5, brushCursor.y + .5, Math.max(1.5, Math.min(radius * .32, width / 220)), 0, Math.PI * 2);
      context.fillStyle = tool === 'erase' ? 'rgba(255,255,255,.78)' : paintValue ? '#fff' : '#000'; context.fill(); context.strokeStyle = tool === 'erase' ? '#d6574d' : paintValue ? '#111' : '#fff'; context.lineWidth = Math.max(1, width / 1500); context.stroke();
      if (tool === 'erase') { context.beginPath(); context.moveTo(brushCursor.x - radius * .34, brushCursor.y + radius * .34); context.lineTo(brushCursor.x + radius * .34, brushCursor.y - radius * .34); context.strokeStyle = '#d6574d'; context.stroke(); }
      context.restore();
    }
  }, [brushCursor, brushSize, centerX, centerY, gratingSpec, hasParametricContent, height, movePreview, paintValue, partiallyOutside, pastePreview, renderBlockPreview, rotation, selection, selectionDraft, shape, shapeSpec, sizeX, sizeY, textFontSizePixels, textSpec, tool, width, zoom]);

  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(''), 3200); return () => window.clearTimeout(timeout); }, [toast]);
  useEffect(() => {
    const stage = stageRef.current; if (!stage) return;
    const calculate = () => {
      const availableWidth = Math.max(180, stage.clientWidth - 116); const availableHeight = Math.max(180, stage.clientHeight - 108);
      const nextFitScale = Math.max(0.02, Math.min(1, availableWidth / width, availableHeight / height));
      setFitScale(nextFitScale);
      if (appliedAutoFitRequestRef.current !== autoFitRequest) {
        appliedAutoFitRequestRef.current = autoFitRequest;
        const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(nextFitScale * 100)));
        setZoom(nextZoom);
      }
    };
    calculate(); const observer = new ResizeObserver(calculate); observer.observe(stage); return () => observer.disconnect();
  }, [autoFitRequest, height, width]);
  const displayWidth = Math.max(1, width * (zoom / 100));
  const displayHeight = Math.max(1, height * (zoom / 100));
  useEffect(() => {
    const anchor = pendingZoomAnchorRef.current; const stage = stageRef.current; const frame = canvasFrameRef.current;
    if (!anchor || !stage || !frame) return;
    const rect = frame.getBoundingClientRect();
    stage.scrollLeft += rect.left + anchor.x * rect.width - anchor.clientX;
    stage.scrollTop += rect.top + anchor.y * rect.height - anchor.clientY;
    pendingZoomAnchorRef.current = null;
  }, [displayHeight, displayWidth, zoom]);

  const pointerToPixel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(width - 1, Math.floor(((event.clientX - rect.left) / rect.width) * width))), y: Math.max(0, Math.min(height - 1, Math.floor(((event.clientY - rect.top) / rect.height) * height))) };
  };
  const paintPoint = (pixels: Uint8Array, x: number, y: number) => {
    const radius = Math.max(0.5, brushSize / 2);
    const minX = Math.max(0, Math.floor(x - radius)); const maxX = Math.min(width - 1, Math.ceil(x + radius));
    const minY = Math.max(0, Math.floor(y - radius)); const maxY = Math.min(height - 1, Math.ceil(y + radius));
    for (let py = minY; py <= maxY; py += 1) for (let px = minX; px <= maxX; px += 1) {
      if ((px - x) ** 2 + (py - y) ** 2 > radius ** 2) continue;
      if (selection && (px < selection.x || px >= selection.x + selection.width || py < selection.y || py >= selection.y + selection.height)) continue;
      pixels[py * width + px] = tool === 'erase' ? TRANSPARENT : paintValue ? OPAQUE_ONE : OPAQUE_ZERO;
    }
  };
  const paintSegment = (from: Point, to: Point) => {
    const pixels = layerHistory.writablePixels(getActiveLayer());
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1);
    for (let step = 0; step <= steps; step += 1) paintPoint(pixels, Math.round(from.x + ((to.x - from.x) * step) / steps), Math.round(from.y + ((to.y - from.y) * step) / steps));
    scheduleDocumentBump();
  };
  const selectionFromPoints = (start: Point, end: Point): Selection => ({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x) + 1, height: Math.abs(start.y - end.y) + 1 });

  const selectAll = () => { setSelection({ x: 0, y: 0, width, height }); setTool('select'); };
  const deselect = () => { setSelection(null); setSelectionDraft(null); setMovePreview(null); };
  const clearSelection = () => {
    if (!selection) return;
    const layer = getEditableLayer();
    if (!layer) return;
    pushHistory();
    clearPixelRegion(layerHistory.writablePixels(layer), width, selection);
    bumpDocument(); setToast('The selection in the current layer has been cleared to transparent.');
  };
  const beginMove = () => {
    if (!selection) { setToast('Create a rectangular selection first.'); return; }
    const layer = getEditableLayer();
    if (!layer) return;
    const pixels = new Uint8Array(selection.width * selection.height);
    for (let y = 0; y < selection.height; y += 1) pixels.set(layer.pixels.subarray((selection.y + y) * width + selection.x, (selection.y + y) * width + selection.x + selection.width), y * selection.width);
    setMovePreview({ ...selection, source: selection, pixels }); setPastePreview(null); setTool('move');
  };
  const confirmMove = () => {
    if (!movePreview) return false;
    const layer = getEditableLayer();
    if (!layer) return false;
    pushHistory();
    const pixels = layerHistory.writablePixels(layer);
    clearPixelRegion(pixels, width, movePreview.source);
    const clipped = clipPixelBlock(movePreview, width, height);
    if (clipped) writeClippedBlock(pixels, width, movePreview, clipped);
    setSelection(null);
    setMovePreview(null); bumpDocument(); setToast('The selection has been moved within the current layer. Out-of-bounds areas were clipped.');
    return true;
  };

  const activateTool = (nextTool: Tool) => {
    // Finish a move and release its selection before painting.
    if (movePreview && !confirmMove()) return;
    setPastePreview(null);
    setMovePreview(null);
    selectionStartRef.current = null;
    setSelectionDraft(null);
    drawingRef.current = false;
    lastPointRef.current = null;
    setTool(nextTool);
  };

  const confirmPaste = () => {
    if (!pastePreview) return;
    const layer = getEditableLayer();
    if (!layer) return;
    const clipped = clipPixelBlock(pastePreview, width, height);
    if (!clipped) { setToast('The pasted block is entirely outside the canvas and cannot be placed.'); return; }
    pushHistory();
    writeClippedBlock(layerHistory.writablePixels(layer), width, pastePreview, clipped);
    setSelection(null);
    setPastePreview(null); bumpDocument(); setToast('The matrix block has been written over the current layer.');
  };
  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pointerToPixel(event); setCursor(point);
    if (event.button === 1 || spacePressedRef.current) {
      const stage = stageRef.current; if (!stage) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      panRef.current = { clientX: event.clientX, clientY: event.clientY, scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop };
      return;
    }
    if (pastePreview) return;
    if (movePreview) return;
    if (tool === 'shape' || tool === 'move') return;
    if (tool === 'select') { event.currentTarget.setPointerCapture(event.pointerId); selectionStartRef.current = point; setSelectionDraft({ x: point.x, y: point.y, width: 1, height: 1 }); return; }
    if (!getEditableLayer()) return;
    event.currentTarget.setPointerCapture(event.pointerId); pushHistory(); drawingRef.current = true; lastPointRef.current = point; paintSegment(point, point);
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pointerToPixel(event); setCursor(point);
    if (panRef.current) {
      const stage = stageRef.current; if (!stage) return;
      stage.scrollLeft = panRef.current.scrollLeft - (event.clientX - panRef.current.clientX);
      stage.scrollTop = panRef.current.scrollTop - (event.clientY - panRef.current.clientY);
      return;
    }
    if (pastePreview) { setPastePreview((preview) => preview ? { ...preview, x: point.x, y: point.y } : null); return; }
    if (movePreview) { setMovePreview((preview) => preview ? { ...preview, x: point.x, y: point.y } : null); return; }
    if (selectionStartRef.current) { setSelectionDraft(selectionFromPoints(selectionStartRef.current, point)); return; }
    if (!drawingRef.current || !lastPointRef.current) return;
    paintSegment(lastPointRef.current, point); lastPointRef.current = point;
  };
  const stopPointerAction = () => { panRef.current = null; drawingRef.current = false; lastPointRef.current = null; if (selectionStartRef.current && selectionDraft) setSelection(selectionDraft); selectionStartRef.current = null; setSelectionDraft(null); };
  const copySelection = () => {
    if (!selection) { setToast('Create a rectangular selection first.'); return; }
    const pixels = new Uint8Array(selection.width * selection.height);
    for (let y = 0; y < selection.height; y += 1) for (let x = 0; x < selection.width; x += 1) {
      const sourceIndex = (selection.y + y) * width + selection.x + x;
      pixels[y * selection.width + x] = compositeResolved[sourceIndex] ? (composite[sourceIndex] ? OPAQUE_ONE : OPAQUE_ZERO) : TRANSPARENT;
    }
    setBinaryClipboard({ width: selection.width, height: selection.height, pixels }); setToast(`Copied the final visible three-state content for a ${selection.width} × ${selection.height}.`);
  };
  const beginPaste = () => { if (!binaryClipboard) { setToast('There is no matrix block to paste.'); return; } if (!getEditableLayer()) return; setPastePreview({ ...binaryClipboard, x: cursor.x, y: cursor.y }); setTool('select'); };
  const applyShape = () => {
    if (!validateNumericInputs(shapeFieldsRef.current)) return;
    if (!hasParametricContent) { setToast(shape === 'text' ? 'Enter the text to apply.' : 'Grating width, height, and period must be greater than 0.'); return; }
    if (!clippedRange.hasIntersection) { setToast(`${parametricLabel} is entirely outside the canvas. There are no pixels to write.`); return; }
    const layer = getEditableLayer();
    if (!layer) return;
    if (shape === 'text') {
      void withProcessing('Rasterizing text', () => {
        pushHistory();
        const touched = writeText(layerHistory.writablePixels(layer), width, height, textSpec, operation);
        if (!touched) { undoRef.current.pop(); bumpHistory(); setToast('The text does not cover any pixels after binarization.'); return; }
        bumpDocument(); setToast(partiallyOutside ? 'The text has been clipped and written within the canvas.' : 'The text has been rasterized into the current layer.');
      });
      return;
    }
    if (shape === 'grating') {
      void withProcessing('Generating grating', () => {
        pushHistory();
        const touched = writeGrating(layerHistory.writablePixels(layer), width, height, gratingSpec, gratingWriteMode, gratingPolarity, operation);
        if (!touched) { undoRef.current.pop(); bumpHistory(); setToast(gratingDuty <= 0 && gratingWriteMode === 'lines' ? 'The duty cycle is 0%. There are no grating lines to write.' : 'The grating does not cover any sampled pixels.'); return; }
        bumpDocument(); setToast(partiallyOutside ? 'The grating has been clipped and written within the canvas.' : 'The one-dimensional linear grating has been written to the current layer.');
      });
      return;
    }
    pushHistory();
    const touched = writeShape(layerHistory.writablePixels(layer), width, height, shapeSpec, operation);
    if (!touched) { undoRef.current.pop(); bumpHistory(); setToast('The current parameters do not cover any pixel centers.'); return; }
    bumpDocument(); setToast(partiallyOutside ? 'The shape has been clipped and written within the canvas.' : 'The parametric shape has been written to the current layer.');
  };
  const invertActiveLayer = () => {
    const layer = getEditableLayer();
    if (!layer) return;
    pushHistory();
    const pixels = layerHistory.writablePixels(layer);
    for (let index = 0; index < pixels.length; index += 1) {
      if (pixels[index] === OPAQUE_ONE) pixels[index] = OPAQUE_ZERO;
      else if (pixels[index] === OPAQUE_ZERO) pixels[index] = OPAQUE_ONE;
    }
    bumpDocument(); setToast('The current layer\'s 0 and 1 values have been inverted. Transparent pixels are unchanged.');
  };
  const clearActiveLayer = () => { const layer = getEditableLayer(); if (!layer) return; pushHistory(); layerHistory.writablePixels(layer).fill(TRANSPARENT); bumpDocument(); setToast('The current layer has been cleared to transparent.'); };
  const clearAllLayers = () => { if (layersRef.current.some((layer) => layer.locked)) { setToast('Some layers are locked. Unlock them before clearing all layers.'); return; } if (!window.confirm('Clear the contents of all layers? You can undo this action.')) return; pushHistory(); layersRef.current.forEach((layer) => layerHistory.writablePixels(layer).fill(TRANSPARENT)); bumpDocument(); setToast('All layers have been cleared to transparent.'); };

  const addLayer = (fill: LayerFill) => {
    pushHistory();
    const sequence = layersRef.current.length + 1;
    const name = fill === OPAQUE_ZERO ? `Black 0 Layer ${sequence}` : fill === OPAQUE_ONE ? `White 1 Layer ${sequence}` : `Layer ${sequence}`;
    const layer = createLayer(width, height, name, fill);
    const activeIndex = layersRef.current.findIndex((item) => item.id === activeLayerId);
    layersRef.current.splice(Math.max(0, activeIndex), 0, layer);
    setActiveLayerId(layer.id); setSelectedLayerIds([layer.id]); bumpDocument();
    setToast(fill === OPAQUE_ZERO ? 'Created a black 0 layer covering the entire canvas.' : fill === OPAQUE_ONE ? 'Created a white 1 layer covering the entire canvas.' : 'Created a transparent layer.');
  };
  const duplicateSelectedLayers = () => {
    const selected = layersRef.current.filter((layer) => selectedSet.has(layer.id)); if (!selected.length) return; pushHistory();
    const topIndex = Math.min(...selected.map((layer) => layersRef.current.indexOf(layer)));
    const copies = selected.map((layer) => ({ ...cloneLayer(layer), id: makeId(), name: `${layer.name} Copy`, locked: false }));
    layersRef.current.splice(topIndex, 0, ...copies); setActiveLayerId(copies[0].id); setSelectedLayerIds(copies.map((layer) => layer.id)); bumpDocument();
  };
  const deleteLayer = (id: string) => {
    const index = layersRef.current.findIndex((layer) => layer.id === id); const layer = layersRef.current[index];
    if (!layer) return;
    if (layer.locked) { setToast('This layer is locked. Unlock it before deleting it.'); return; }
    pushHistory(); layersRef.current.splice(index, 1);
    if (!layersRef.current.length) layersRef.current = [createLayer(width, height, 'Layer 1')];
    const remainingSelection = selectedLayerIds.filter((selectedId) => layersRef.current.some((item) => item.id === selectedId));
    const nextActiveId = layersRef.current.some((item) => item.id === activeLayerId) ? activeLayerId : remainingSelection[0] ?? layersRef.current[Math.min(index, layersRef.current.length - 1)].id;
    setActiveLayerId(nextActiveId); setSelectedLayerIds(remainingSelection.length ? remainingSelection : [nextActiveId]); bumpDocument();
  };
  const mergeSelectedLayers = () => void withProcessing('Merging layers', async () => {
    const selected = layersRef.current.filter((layer) => selectedSet.has(layer.id)); if (selected.length < 2) return;
    if (selected.some((layer) => layer.locked)) { setToast('Some selected layers are locked. Unlock them first.'); return; }
    pushHistory(); const existingMerged = layersRef.current.filter((layer) => layer.name.startsWith('Merged Layer')).length;
    const merged = createLayer(width, height, existingMerged ? `Merged Layer ${existingMerged + 1}` : 'Merged Layer');
    for (let index = 0; index < merged.pixels.length; index += 1) {
      let hasZero = false; let hasOne = false;
      for (const layer of selected) { if (layer.pixels[index] === OPAQUE_ONE) hasOne = true; else if (layer.pixels[index] === OPAQUE_ZERO) hasZero = true; }
      merged.pixels[index] = hasOne ? OPAQUE_ONE : hasZero ? OPAQUE_ZERO : TRANSPARENT;
    }
    const insertionIndex = Math.min(...selected.map((layer) => layersRef.current.indexOf(layer)));
    layersRef.current = layersRef.current.filter((layer) => !selectedSet.has(layer.id)); layersRef.current.splice(insertionIndex, 0, merged);
    setActiveLayerId(merged.id); setSelectedLayerIds([merged.id]); bumpDocument(); setToast('Selected layers have been merged with priority 1 > 0 > transparent.');
  });
  const toggleLayerVisibility = (id: string) => { const layer = layersRef.current.find((item) => item.id === id); if (!layer) return; pushHistory(); layer.visible = !layer.visible; bumpDocument(); };
  const toggleLayerLock = (id: string) => { const layer = layersRef.current.find((item) => item.id === id); if (!layer) return; pushHistory(); layer.locked = !layer.locked; bumpDocument(); };
  const renameLayer = (id: string) => { const layer = layersRef.current.find((item) => item.id === id); if (!layer) return; if (layer.locked) { setToast('This layer is locked. Unlock it before renaming it.'); return; } const name = window.prompt('Enter a new layer name:', layer.name)?.trim(); if (!name || name === layer.name) return; pushHistory(); layer.name = name; bumpDocument(); };
  const selectLayer = (event: React.MouseEvent, id: string) => {
    const index = layersRef.current.findIndex((layer) => layer.id === id); const activeIndex = layersRef.current.findIndex((layer) => layer.id === activeLayerId);
    if (event.shiftKey && activeIndex >= 0) { const start = Math.min(index, activeIndex); const end = Math.max(index, activeIndex); setSelectedLayerIds(layersRef.current.slice(start, end + 1).map((layer) => layer.id)); }
    else if (event.ctrlKey || event.metaKey) {
      if (selectedLayerIds.includes(id)) {
        if (selectedLayerIds.length === 1) return;
        const nextSelection = selectedLayerIds.filter((item) => item !== id);
        setSelectedLayerIds(nextSelection);
        if (activeLayerId === id) setActiveLayerId(nextSelection[0]);
        return;
      }
      setSelectedLayerIds([...selectedLayerIds, id]);
    }
    else setSelectedLayerIds([id]);
    setActiveLayerId(id);
  };
  const moveLayer = (id: string, direction: -1 | 1) => {
    const index = layersRef.current.findIndex((layer) => layer.id === id);
    const layer = layersRef.current[index]; const nextIndex = index + direction;
    if (!layer || layer.locked || nextIndex < 0 || nextIndex >= layersRef.current.length) return;
    pushHistory(); layersRef.current.splice(index, 1); layersRef.current.splice(nextIndex, 0, layer);
    setActiveLayerId(id); setSelectedLayerIds([id]); bumpDocument();
  };
  const dropLayer = (targetId: string) => { if (!dragLayerId || dragLayerId === targetId) return; const sourceIndex = layersRef.current.findIndex((layer) => layer.id === dragLayerId); const source = layersRef.current[sourceIndex]; if (!source || source.locked) return; let targetIndex = layersRef.current.findIndex((layer) => layer.id === targetId); pushHistory(); layersRef.current.splice(sourceIndex, 1); if (sourceIndex < targetIndex) targetIndex -= 1; layersRef.current.splice(targetIndex, 0, source); setDragLayerId(null); bumpDocument(); };

  const openMatrixEditor = () => {
    const layer = getActiveLayer();
    void withProcessing('Opening matrix', async () => {
      matrixDraftRef.current = new Uint8Array(layer.pixels); setMatrixText(''); setMatrixView('cells'); setMatrixScope('layer');
      setMatrixStartX(Math.max(0, Math.min(width - MATRIX_COLUMNS, cursor.x - Math.floor(MATRIX_COLUMNS / 2))));
      setMatrixStartY(Math.max(0, Math.min(height - MATRIX_ROWS, cursor.y - Math.floor(MATRIX_ROWS / 2))));
      bumpMatrixDraft(); setMatrixOpen(true);
    });
  };
  const matrixRegion: Selection = matrixScope === 'selection' && selection ? selection : { x: 0, y: 0, width, height };
  const setMatrixCell = (x: number, y: number, value?: number) => { const draft = matrixDraftRef.current; if (!draft || getActiveLayer().locked || x < matrixRegion.x || x >= matrixRegion.x + matrixRegion.width || y < matrixRegion.y || y >= matrixRegion.y + matrixRegion.height) return; const index = y * width + x; draft[index] = value ?? (draft[index] === TRANSPARENT ? OPAQUE_ZERO : draft[index] === OPAQUE_ZERO ? OPAQUE_ONE : TRANSPARENT); bumpMatrixDraft(); };
  const changeMatrixScope = (scope: MatrixScope) => {
    if (scope === 'selection' && !selection) return;
    const region = scope === 'selection' && selection ? selection : { x: 0, y: 0, width, height };
    setMatrixScope(scope); setMatrixText(''); setMatrixStartX(region.x); setMatrixStartY(region.y);
  };
  const loadMatrixText = () => { if (!matrixDraftRef.current) return; if (matrixRegion.width * matrixRegion.height > 300000 && !window.confirm('This is a large area. Converting it to text may take a while. Continue?')) return; setMatrixText(regionToText(matrixDraftRef.current, width, matrixRegion)); };
  const applyMatrixEditor = () => void withProcessing('Applying matrix', async () => {
    if (!validateNumericInputs(matrixFieldsRef.current)) return;
    const layer = getEditableLayer();
    if (!layer) return;
    try {
      if (matrixView === 'text') {
        const rows = parseMatrixText(matrixText);
        if (rows.length !== matrixRegion.height || rows[0].length !== matrixRegion.width) throw new Error(`The current editing area is ${matrixRegion.width} × ${matrixRegion.height}. The input matrix must match it exactly.`);
        const draft = matrixDraftRef.current ?? new Uint8Array(layer.pixels);
        rows.forEach((row, y) => row.forEach((value, x) => { draft[(matrixRegion.y + y) * width + matrixRegion.x + x] = value; })); matrixDraftRef.current = draft;
      }
      if (!matrixDraftRef.current) return; pushHistory(); layer.pixels = new Uint8Array(matrixDraftRef.current); setMatrixOpen(false); bumpDocument(); setToast('The current layer\'s matrix has been updated.');
    } catch (error) { setToast(error instanceof Error ? error.message : 'Unrecognized matrix format.'); }
  });

  const addImportedLayer = (pixels: Uint8Array, name: string) => { pushHistory(); const layer: Layer = { id: makeId(), name, pixels, visible: true, locked: false }; const activeIndex = layersRef.current.findIndex((item) => item.id === activeLayerId); layersRef.current.splice(Math.max(0, activeIndex), 0, layer); setActiveLayerId(layer.id); setSelectedLayerIds([layer.id]); bumpDocument(); };
  const importFile = async (file: File) => {
    try {
      const isPng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
      const pixels = isPng ? await readPngLayer(file, width, height) : readMatrixLayer(await file.text(), width, height);
      addImportedLayer(pixels, file.name.replace(/\.[^.]+$/, '') || 'Imported Layer'); setToast('The file has been imported as a new layer aligned to the top-left corner. Out-of-bounds areas were clipped.');
    } catch (error) { setToast(error instanceof Error ? error.message : 'File import failed.'); }
  };
  const safeExportBaseName = (exportBaseName.trim().replace(/\.(png|csv|txt|bmask)$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '') || `binary-mask-${width}x${height}`);
  const saveProject = () => void withProcessing('Saving project', async () => {
    const project = serializeProject({ width, height, dpi, pixelSizeUnit: canvasPixelSizeUnit, activeLayerId, layers: layersRef.current });
    downloadBlob(new Blob([project], { type: 'application/json' }), `${safeExportBaseName}.bmask`); setDocumentDirty(false); setToast('The layered project has been saved as a .bmask file.');
  });
  const openProject = async (file: File) => {
    try {
      const project = deserializeProject(await file.text(), makeId);
      layersRef.current = project.layers; setWidth(project.width); setHeight(project.height); setDpi(project.dpi);
      setCanvasPixelSizeUnit(project.pixelSizeUnit);
      setActiveLayerId(project.activeLayerId); setSelectedLayerIds([project.activeLayerId]); setCenterX(project.width / 2); setCenterY(project.height / 2); setCursor({ x: 0, y: 0 }); setSelection(null); setPastePreview(null); setMovePreview(null); setExportBaseName(file.name.replace(/\.bmask$/i, '') || `binary-mask-${project.width}x${project.height}`); resetHistory(); bumpDocument(false); setDocumentDirty(false); setAutoFitRequest((value) => value + 1); setToast('Opened the .bmask layered project.');
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not open the project file.'); }
  };
  const createNewCanvas = () => {
    if (!validateNumericInputs(newCanvasFieldsRef.current)) return;
    const nextWidth = Math.round(newWidth); const nextHeight = Math.round(newHeight); const nextDpi = newDpi;
    if (nextWidth < 1 || nextHeight < 1 || nextWidth > MAX_DIMENSION || nextHeight > MAX_DIMENSION) { setToast(`Width and height must be between 1 and ${MAX_DIMENSION}.`); return; }
    if (!isSupportedDpi(nextDpi)) { setToast('The canvas resolution is outside the supported range.'); return; }
    if (dirtyRef.current && !window.confirm('This project has unsaved changes. Create a new canvas and discard them?')) return;
    setCanvasPixelSizeUnit(newResolutionMode === 'pixel' ? newPixelSideUnit : null);
    const layer = createLayer(nextWidth, nextHeight, 'Layer 1'); layersRef.current = [layer]; setWidth(nextWidth); setHeight(nextHeight); setDpi(nextDpi); setActiveLayerId(layer.id); setSelectedLayerIds([layer.id]); setCenterX(nextWidth / 2); setCenterY(nextHeight / 2); setCursor({ x: 0, y: 0 }); setSelection(null); setBinaryClipboard(null); setPastePreview(null); setMovePreview(null); setExportBaseName(`binary-mask-${nextWidth}x${nextHeight}`); resetHistory(); bumpDocument(false); setDocumentDirty(false); setNewCanvasOpen(false); setAutoFitRequest((value) => value + 1); setToast(`Created a ${nextWidth} × ${nextHeight} canvas. Its parameters are now locked.`);
  };
  const exportPng = () => void withProcessing('Exporting PNG', async () => {
    try {
      downloadBlob(await encodeMaskPng(compositeData, width, height, dpi, exportTransparency), `${safeExportBaseName}.png`);
      setToast('Exported the mask as PNG.');
    } catch { setToast('This browser could not encode the mask as PNG.'); }
  });
  const exportMatrix = (format: 'csv' | 'txt') => void withProcessing(`Exporting ${format.toUpperCase()}`, async () => {
    const separator = format === 'csv' ? ',' : ' ';
    const parts = Array.from(compositeTextChunks(compositeData, width, height, separator, exportTransparency));
    downloadBlob(new Blob(parts, { type: 'text/plain;charset=utf-8' }), `${safeExportBaseName}.${format}`);
    setToast(`Exported a ${format.toUpperCase()} mask matrix.`);
  });
  const changeUnit = (nextUnit: SizeUnit) => { if (nextUnit === sizeUnit) return; const convert = (value: number) => fromPixels(toPixels(value, sizeUnit, dpi), nextUnit, dpi); setDimensionX(convert(dimensionX)); setDimensionY(convert(dimensionY)); setTriangleBase(convert(triangleBase)); setTriangleHeight(convert(triangleHeight)); setTriangleProjection(convert(triangleProjection)); setTextFontSize(convert(textFontSize)); setTextLetterSpacing(convert(textLetterSpacing)); setGratingWidth(convert(gratingWidth)); setGratingHeight(convert(gratingHeight)); setGratingPeriod(convert(gratingPeriod)); setGratingPhase(convert(gratingPhase)); setSizeUnit(nextUnit); };
  const setZoomValue = (next: number) => { const normalized = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(next))); setZoom(normalized); };
  const fitCanvas = () => setZoomValue(Math.floor(fitScale * 100));
  const actualSize = () => setZoomValue(100);
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => { event.preventDefault(); const frame = canvasFrameRef.current; if (!frame) return; const rect = frame.getBoundingClientRect(); pendingZoomAnchorRef.current = { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)), clientX: event.clientX, clientY: event.clientY }; setZoomValue(zoom + (event.deltaY < 0 ? 10 : -10)); };
  const refreshFromLogo = () => { if (!dirtyRef.current || window.confirm('This project has unsaved changes. Refresh the page and discard them?')) window.location.reload(); };
  const requestOpenProject = () => { if (!dirtyRef.current || window.confirm('This project has unsaved changes. Open another project and discard them?')) projectInputRef.current?.click(); };

  const runShortcut = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (event.code === 'Space' && !target?.matches('input, textarea, select, [contenteditable="true"]')) { event.preventDefault(); spacePressedRef.current = true; setSpacePressed(true); return; }
    if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
    if (helpOpen || aboutOpen || matrixOpen || newCanvasOpen) {
      if (event.key === 'Escape') { setHelpOpen(false); setAboutOpen(false); setMatrixOpen(false); setNewCanvasOpen(false); }
      return;
    }
    const command = event.ctrlKey || event.metaKey; const key = event.key.toLowerCase();
    if (command && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (command && key === 'y') { event.preventDefault(); redo(); return; }
    if (command && key === 's') { event.preventDefault(); saveProject(); return; }
    if (command && key === 'o') { event.preventDefault(); requestOpenProject(); return; }
    if (command && key === 'a') { event.preventDefault(); selectAll(); return; }
    if (command && key === 'd') { event.preventDefault(); deselect(); return; }
    if (command && key === 'c') { event.preventDefault(); copySelection(); return; }
    if (command && key === 'v') { event.preventDefault(); beginPaste(); return; }
    if (command && key === '0') { event.preventDefault(); fitCanvas(); return; }
    if (command && key === '1') { event.preventDefault(); actualSize(); return; }
    if (pastePreview || movePreview) {
      if (event.key === 'Escape') { event.preventDefault(); setPastePreview(null); setMovePreview(null); return; }
      if (event.key === 'Enter') { event.preventDefault(); if (pastePreview) confirmPaste(); else confirmMove(); return; }
      if (event.key.startsWith('Arrow')) {
        event.preventDefault(); const step = event.shiftKey ? 10 : 1;
        if (pastePreview) setPastePreview((preview) => { if (!preview) return null; if (event.key === 'ArrowLeft') return { ...preview, x: preview.x - step }; if (event.key === 'ArrowRight') return { ...preview, x: preview.x + step }; if (event.key === 'ArrowUp') return { ...preview, y: preview.y - step }; return { ...preview, y: preview.y + step }; });
        else setMovePreview((preview) => { if (!preview) return null; if (event.key === 'ArrowLeft') return { ...preview, x: preview.x - step }; if (event.key === 'ArrowRight') return { ...preview, x: preview.x + step }; if (event.key === 'ArrowUp') return { ...preview, y: preview.y - step }; return { ...preview, y: preview.y + step }; });
        return;
      }
    }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); clearSelection(); return; }
    if (key === 'b') { activateTool('draw'); return; }
    if (key === 'e') { activateTool('erase'); return; }
    if (key === 'm') { activateTool('select'); return; }
    if (key === 'v') { beginMove(); return; }
    if (event.key === '[') { setBrushSize((value) => Math.max(1, value - 1)); return; }
    if (event.key === ']') { setBrushSize((value) => Math.min(128, value + 1)); }
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => runShortcut(event);
    const handleKeyUp = (event: KeyboardEvent) => { if (event.code === 'Space') { spacePressedRef.current = false; setSpacePressed(false); } };
    const handleBlur = () => { spacePressedRef.current = false; setSpacePressed(false); };
    window.addEventListener('keydown', handleKeyDown); window.addEventListener('keyup', handleKeyUp); window.addEventListener('blur', handleBlur);
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp); window.removeEventListener('blur', handleBlur); };
  }, []);

  const selectionLabel = selection ? `X ${selection.x}–${selection.x + selection.width - 1} · Y ${selection.y}–${selection.y + selection.height - 1} · ${selection.width}×${selection.height} px` : '';
  // Keep the existing gesture-driven cursor style without putting pointer coordinates in state.
  // eslint-disable-next-line react-hooks/refs
  const isPanning = Boolean(panRef.current);

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" aria-label={dirty ? 'Refresh page; unsaved changes' : 'Refresh page'} onClick={refreshFromLogo}><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><span><strong>Binary Mask Studio{dirty ? <i className="dirty-dot" title="Unsaved changes" /> : null}</strong><small>PIXEL-PRECISE EDITING</small></span></button>
        <div className="topbar-actions"><button type="button" aria-label="Help" title="Help" onClick={() => void openInfoWindow('help')}>?</button><button type="button" aria-label="Application information" title="Application information" onClick={() => void openInfoWindow('about')}>!</button></div>
      </header>
      <section className="workspace" ref={workspaceRef} style={workspaceStyle}>
        <aside className="left-sidebar" id="settings-column" ref={leftRef}>
          <section className="panel settings-panel" id="canvas-settings">
          <SectionHeading number="01" title="Canvas" />
          <div className="canvas-parameter-stack">
            <div className="field-grid two-columns compact-fields"><label>Width<div className="input-shell"><input type="number" value={width} disabled /><FieldSuffix>px</FieldSuffix></div></label><label>Height<div className="input-shell"><input type="number" value={height} disabled /><FieldSuffix>px</FieldSuffix></div></label></div>
            <div className="dpi-row"><label>{canvasResolutionLabel}<div className="input-shell"><input type="text" value={canvasResolutionValue} disabled /><FieldSuffix>{canvasResolutionUnit}</FieldSuffix></div></label><button type="button" onClick={() => { setNewWidth(width); setNewHeight(height); setNewDpi(dpi); setNewPixelSideUnit('um'); setNewCanvasOpen(true); }}>New Canvas</button></div>
            <div className="physical-size"><span>Physical size</span><strong>{physicalWidth} × {physicalHeight} mm</strong></div>
          </div>
          </section>
          <PanelSplitter orientation="horizontal" label="Resize Canvas and Parametric Shapes" controls="canvas-settings parametric-shapes" {...canvasSplitter} />
          <section ref={shapeFieldsRef} className="panel settings-panel" id="parametric-shapes" onFocusCapture={() => setTool('shape')}>
          <SectionHeading number="02" title="Parametric Shapes" />
          <label>Shape type<select value={shape} onChange={(event) => setShape(event.target.value as ParametricKind)}><option value="circle">Circle</option><option value="triangle">Triangle</option><option value="rectangle">Rectangle</option><option value="text">Text</option><option value="grating">Grating</option></select></label>
          <div className="field-grid two-columns"><label>Center X<NumericInput className="number-input" step="0.5" value={centerX} onValueChange={(value) => setCenterX(value)} /></label><label>Center Y<NumericInput className="number-input" step="0.5" value={centerY} onValueChange={(value) => setCenterY(value)} /></label></div>
          {shape === 'text' ? <>
            <label>Text content<textarea className="text-content-input" rows={3} value={textContent} onChange={(event) => setTextContent(event.target.value)} spellCheck={false} placeholder="Enter one or more lines of text" /></label>
            <div className="field-grid two-columns"><label>Font size<NumericInput className="number-input" min="0.5" step="0.5" value={Number(textFontSize.toFixed(4))} onValueChange={(value) => setTextFontSize(Math.max(0.5, value || 0.5))} /></label><label>Letter spacing<NumericInput className="number-input" step="0.5" value={Number(textLetterSpacing.toFixed(4))} onValueChange={(value) => setTextLetterSpacing(value || 0)} /></label></div>
            <div className="field-grid two-columns"><label>Font family<select value={textFont} onChange={(event) => setTextFont(event.target.value as TextFont)}><option value="sans">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select></label><label>Font weight<select value={textWeight} onChange={(event) => setTextWeight(event.target.value as TextWeight)}><option value="400">Regular</option><option value="700">Bold</option></select></label></div>
            <div className="field-grid two-columns"><label>Line height<NumericInput className="number-input" min="0.1" step="0.1" value={textLineHeight} onValueChange={(value) => setTextLineHeight(Math.max(0.1, value || 0.1))} /></label><label>Text alignment<select value={textAlignment} onChange={(event) => setTextAlignment(event.target.value as TextAlignment)}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label></div>
          </> : shape === 'grating' ? <>
            <div className="linked-dimensions">
              <label>Area width<NumericInput className="number-input" min="0.01" step="0.5" value={Number(gratingWidth.toFixed(4))} onValueChange={(value) => updateGratingWidth(value)} /></label>
              <button className={gratingAspectLinked ? 'link-button active' : 'link-button'} type="button" aria-label={gratingAspectLinked ? 'Unlock area aspect ratio' : 'Lock current area aspect ratio'} aria-pressed={gratingAspectLinked} onClick={toggleGratingAspect}><LinkIcon /></button>
              <label>Area height<NumericInput className="number-input" min="0.01" step="0.5" value={Number(gratingHeight.toFixed(4))} onValueChange={(value) => updateGratingHeight(value)} /></label>
            </div>
            <div className="field-grid two-columns"><label>Period<NumericInput className="number-input" min="0.01" step="0.5" value={Number(gratingPeriod.toFixed(4))} onValueChange={(value) => setGratingPeriod(Math.max(0.01, value || 0.01))} /></label><label>Duty cycle<div className="input-shell"><NumericInput className="number-input" min="0" max="100" step="0.1" value={gratingDuty} onValueChange={(value) => setGratingDuty(Math.max(0, Math.min(100, value || 0)))} /><FieldSuffix>%</FieldSuffix></div></label></div>
            <label>Phase offset<NumericInput className="number-input" step="0.5" value={Number(gratingPhase.toFixed(4))} onValueChange={(value) => setGratingPhase(value || 0)} /></label>
          </> : shape !== 'triangle' ? <div className="linked-dimensions">
            <label>{shape === 'circle' ? 'Diameter X' : 'Width X'}<NumericInput className="number-input" min="0.01" step="0.5" value={Number(dimensionX.toFixed(4))} onValueChange={(value) => updateDimensionX(value)} /></label>
            <button className={aspectLinked ? 'link-button active' : 'link-button'} type="button" aria-label={aspectLinked ? 'Unlock aspect ratio' : 'Lock current aspect ratio'} aria-pressed={aspectLinked} onClick={toggleAspect}><LinkIcon /></button>
            <label>{shape === 'circle' ? 'Diameter Y' : 'Height Y'}<NumericInput className="number-input" min="0.01" step="0.5" value={Number(dimensionY.toFixed(4))} onValueChange={(value) => updateDimensionY(value)} /></label>
          </div> : <>
            <label>Base length<NumericInput className="number-input" min="0.01" step="0.5" value={Number(triangleBase.toFixed(4))} onValueChange={(value) => setTriangleBase(Math.max(0.01, value || 0.01))} /></label>
            <div className="field-grid two-columns"><label>Triangle height<NumericInput className="number-input" min="0.01" step="0.5" disabled={equilateral} value={Number(resolvedTriangleHeight.toFixed(4))} onValueChange={(value) => setTriangleHeight(Math.max(0.01, value || 0.01))} /></label><label>Apex projection<NumericInput className="number-input" step="0.5" disabled={equilateral} value={Number(resolvedTriangleProjection.toFixed(4))} onValueChange={(value) => setTriangleProjection(value || 0)} /></label></div>
            <label className="checkbox-row"><input type="checkbox" checked={equilateral} onChange={(event) => { const checked = event.target.checked; if (!checked) { setTriangleHeight((triangleBase * Math.sqrt(3)) / 2); setTriangleProjection(triangleBase / 2); } setEquilateral(checked); }} /><span>Equilateral triangle</span></label>
          </>}
          <div className="shape-unit-row"><label>Units<select value={sizeUnit} onChange={(event) => changeUnit(event.target.value as SizeUnit)}><option value="px">px</option><option value="mm">mm</option></select></label><label>Rotation<div className="input-shell"><NumericInput className="number-input" step="1" value={rotation} onValueChange={(value) => setRotation(value || 0)} /><FieldSuffix>°</FieldSuffix></div></label></div>
          {shape === 'grating' ? <><label>Write mode<select value={gratingWriteMode} onChange={(event) => setGratingWriteMode(event.target.value as GratingWriteMode)}><option value="cover">Full coverage</option><option value="lines">Lines only</option></select></label>{gratingWriteMode === 'cover' ? <label>Polarity<select value={gratingPolarity} onChange={(event) => setGratingPolarity(event.target.value as GratingPolarity)}><option value="line1">Lines 1 · Gaps 0</option><option value="line0">Lines 0 · Gaps 1</option></select></label> : <label>Line operation<select value={operation} onChange={(event) => setOperation(event.target.value as BooleanOperation)}><option value="set1">Set 1</option><option value="set0">Set 0</option><option value="xor">XOR</option></select></label>}</> : <label>Boolean operation<select value={operation} onChange={(event) => setOperation(event.target.value as BooleanOperation)}><option value="set1">Set 1</option><option value="set0">Set 0</option><option value="xor">XOR</option></select></label>}
          {parametricWarning && <p className="shape-warning">{parametricWarning}</p>}
          {hasParametricContent && clippedRange.hasIntersection && gratingAliased && <p className="shape-warning">Period below 2 px may cause aliasing.</p>}
          <button className="primary-button" type="button" disabled={!hasParametricContent || !clippedRange.hasIntersection || activeLayer.locked || Boolean(processing)} onClick={applyShape}>Apply {parametricLabel} to Layer <span>↗</span></button>
          </section>
        </aside>

        <PanelSplitter orientation="vertical" label="Resize settings and image columns" controls="settings-column image-column" {...leftSplitter} />
        <section className="canvas-column" id="image-column">
          <div className={`toolstrip ${tool === 'draw' || tool === 'erase' ? 'brush-open' : ''}`} aria-label="Drawing tools">
            <div className="tool-group">
              <div className="tool-popover-anchor"><button className={tool === 'draw' ? 'active' : ''} type="button" onClick={() => activateTool('draw')}><span>✎</span>Draw</button>{tool === 'draw' && <div className="brush-popover"><div className="range-wrap"><input aria-label="Brush size" type="range" min="1" max="128" value={brushSize} onPointerDown={() => setBrushDragging(true)} onPointerUp={() => setBrushDragging(false)} onPointerCancel={() => setBrushDragging(false)} onChange={(event) => setBrushSize(Number(event.target.value))} />{brushDragging && <b style={{ left: `${((brushSize - 1) / 127) * 100}%` }}>{brushSize}px</b>}</div><div className="paint-toggle" role="group" aria-label="Paint value"><button className={paintValue === 0 ? 'selected black' : 'black'} type="button" aria-label="Paint black 0" title="Black 0" onClick={() => setPaintValue(0)} /><button className={paintValue === 1 ? 'selected white' : 'white'} type="button" aria-label="Paint white 1" title="White 1" onClick={() => setPaintValue(1)} /></div></div>}</div>
              <div className="tool-popover-anchor"><button className={tool === 'erase' ? 'active' : ''} type="button" onClick={() => activateTool('erase')}><span className="tool-icon" aria-hidden="true"><EraserIcon /></span>Erase</button>{tool === 'erase' && <div className="brush-popover erase-popover"><div className="range-wrap"><input aria-label="Eraser size" type="range" min="1" max="128" value={brushSize} onPointerDown={() => setBrushDragging(true)} onPointerUp={() => setBrushDragging(false)} onPointerCancel={() => setBrushDragging(false)} onChange={(event) => setBrushSize(Number(event.target.value))} />{brushDragging && <b style={{ left: `${((brushSize - 1) / 127) * 100}%` }}>{brushSize}px</b>}</div></div>}</div>
              <button className={tool === 'select' ? 'active' : ''} type="button" onClick={() => activateTool('select')}><span>▧</span>Select</button>
              <button className={tool === 'move' ? 'active' : ''} type="button" disabled={!selection || activeLayer.locked} onClick={beginMove}><span>✥</span>Move</button>
            </div>
            <div className="tool-divider" /><div className="tool-group"><button type="button" disabled={!selection} onClick={copySelection}>Copy</button><button type="button" disabled={!binaryClipboard} onClick={beginPaste}>Paste</button></div>
            <div className="tool-divider" /><div className="tool-group"><button type="button" disabled={!historyView.canUndo} onClick={undo}>Undo</button><button type="button" disabled={!historyView.canRedo} onClick={redo}>Redo</button><button type="button" onClick={invertActiveLayer}>Invert</button><button type="button" onClick={clearActiveLayer}>Clear</button></div>
            <div className="tool-divider" /><div className="tool-group">
              <input ref={fileInputRef} aria-label="Import image or matrix file" className="visually-hidden" type="file" accept=".png,.txt,.csv,text/plain,image/png" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.currentTarget.value = ''; }} />
              <input ref={projectInputRef} aria-label="Open project file" className="visually-hidden" type="file" accept=".bmask,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void openProject(file); event.currentTarget.value = ''; }} />
              <button type="button" disabled={Boolean(processing)} onClick={() => fileInputRef.current?.click()}>Import</button><button type="button" disabled={Boolean(processing)} onClick={openMatrixEditor}>Matrix</button><button type="button" disabled={Boolean(processing)} onClick={requestOpenProject}>Open</button><button type="button" disabled={Boolean(processing)} onClick={saveProject}>Save</button>
            </div>
            {selectionLabel && <span className="selection-chip">{selectionLabel}<button type="button" aria-label="Deselect" title="Deselect" onClick={deselect}>×</button></span>}
            {processing && <span className="processing-chip"><i />{processing}</span>}
            <div className="zoom-tools"><button type="button" aria-label="Fit to Window" title="Fit to Window Ctrl+0" onClick={fitCanvas}><FitIcon /></button><label className="zoom-control" aria-label="Canvas zoom"><NumericInput value={zoom} suffix="%" min={MIN_ZOOM} max={MAX_ZOOM} onValueChange={setZoomValue} /></label></div>
          </div>
          <div ref={stageRef} className={`stage ${spacePressed ? 'pan-ready' : ''} ${isPanning ? 'panning' : ''}`} onWheel={handleWheel}><div className="stage-inner" style={{ minWidth: `${displayWidth + 112}px`, minHeight: `${displayHeight + 104}px` }}><div className="canvas-shell" style={{ width: `${displayWidth}px`, height: `${displayHeight}px`, '--grid-size': `${Math.max(8, 24 * (zoom / 100))}px` } as CSSProperties}>
            <div className="ruler ruler-x"><span /><span>{width / 2}</span><span>{width}</span></div><div className="ruler ruler-y"><span /><span>{height / 2}</span><span>{height}</span></div>
            <div ref={canvasFrameRef} className="canvas-frame"><canvas ref={canvasRef} aria-label="Binary image canvas" /><canvas ref={overlayRef} className={`drawing-layer tool-${tool}`} onPointerEnter={(event) => { setCursor(pointerToPixel(event)); setPointerInCanvas(true); }} onPointerLeave={() => setPointerInCanvas(false)} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={stopPointerAction} onPointerCancel={stopPointerAction} onDoubleClick={(event) => { if (event.button !== 0) return; if (pastePreview) { event.preventDefault(); confirmPaste(); } else if (movePreview) { event.preventDefault(); confirmMove(); } }} aria-label="Drawing interaction layer" /><span className="axis axis-x" /><span className="axis axis-y" /><span className="origin-dot" /><span className="origin-label">(0, 0)</span></div>
          </div></div></div>
        </section>

        <PanelSplitter orientation="vertical" className="right-column-splitter" label="Resize image and inspector columns" controls="image-column inspector-column" {...rightSplitter} />
        <aside className="right-sidebar" id="inspector-column" ref={rightRef}>
          <LayersPanel width={width} height={height} docVersion={docVersion} layerList={layerList} selectedSet={selectedSet} selectedCount={selectedLayerIds.length} activeLayerId={activeLayerId}
            onAddLayer={addLayer} duplicateSelectedLayers={duplicateSelectedLayers} mergeSelectedLayers={mergeSelectedLayers} setDragLayerId={setDragLayerId}
            dropLayer={dropLayer} selectLayer={selectLayer} renameLayer={renameLayer} toggleLayerVisibility={toggleLayerVisibility}
            toggleLayerLock={toggleLayerLock} deleteLayer={deleteLayer} moveLayer={moveLayer} clearAllLayers={clearAllLayers} />
          <PanelSplitter orientation="horizontal" label="Resize Layers and Pixel Inspector" controls="layers-panel pixel-inspector" {...layersSplitter} />
          <PixelInspector cursor={cursor} currentValue={currentValue} showGratingPreview={showGratingPreview} gratingPreviewReadout={gratingPreviewReadout}
            whitePixels={whitePixels} width={width} height={height} exportBaseName={exportBaseName} safeExportBaseName={safeExportBaseName}
            setExportBaseName={setExportBaseName} exportTransparency={exportTransparency} setExportTransparency={setExportTransparency}
            processing={processing} exportPng={exportPng} exportMatrix={exportMatrix} />
        </aside>
      </section>

      {newCanvasOpen && <NewCanvasDialog newCanvasFieldsRef={newCanvasFieldsRef} newWidth={newWidth} newHeight={newHeight} newDpi={newDpi}
        newResolutionMode={newResolutionMode} newPixelSideUnit={newPixelSideUnit} setNewWidth={setNewWidth} setNewHeight={setNewHeight}
        setNewDpi={setNewDpi} setNewResolutionMode={setNewResolutionMode} setNewPixelSideUnit={setNewPixelSideUnit}
        createNewCanvas={createNewCanvas} onClose={() => setNewCanvasOpen(false)} />}

      {matrixOpen && <MatrixEditorDialog matrixFieldsRef={matrixFieldsRef} activeLayerName={activeLayer.name} locked={activeLayer.locked}
        width={width} selection={selection} matrixRegion={matrixRegion} matrixScope={matrixScope} matrixView={matrixView}
        matrixStartX={matrixStartX} matrixStartY={matrixStartY} matrixDraft={matrixDraftView.pixels} matrixDraftVersion={matrixDraftView.version}
        matrixText={matrixText} changeMatrixScope={changeMatrixScope} setMatrixView={setMatrixView} setMatrixStartX={setMatrixStartX}
        setMatrixStartY={setMatrixStartY} setMatrixText={setMatrixText} setMatrixCell={setMatrixCell} loadMatrixText={loadMatrixText}
        applyMatrixEditor={applyMatrixEditor} onClose={() => setMatrixOpen(false)} />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} quote={quote} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} quote={quote} />}
      {pastePreview && <div className="paste-hint">Pointer sets top-left corner · Enter / double-click to place · Esc to cancel · Arrow keys to adjust</div>}
      {movePreview && <div className="move-hint"><strong>ΔX {movePreview.x - movePreview.source.x >= 0 ? '+' : ''}{movePreview.x - movePreview.source.x} · ΔY {movePreview.y - movePreview.source.y >= 0 ? '+' : ''}{movePreview.y - movePreview.source.y}</strong><span>X {movePreview.x} · Y {movePreview.y}</span><small>Pointer sets top-left corner · Enter / double-click to place · Esc to cancel · Arrow keys to adjust</small></div>}
      {toast && <div className="toast" role="status"><span />{toast}</div>}
      <span className="history-sentinel" data-history-version={historyView.version} />
    </main>
  );
}

'use client';

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

const STORAGE_KEY = 'binary-mask-panel-layout-v1';
const SPLITTER_SIZE = 12;
const MIN_LEFT_WIDTH = 260;
const MIN_RIGHT_WIDTH = 274;
const MIN_CANVAS_WIDTH = 400;
const MAX_SIDEBAR_WIDTH = 600;
const MIN_CANVAS_PANEL = 160;
const MIN_SHAPE_PANEL = 224;
const MIN_LAYER_PANEL = 170;
const MIN_INSPECTOR_PANEL = 160;
const DEFAULT_CANVAS_PANEL = 250;
const DEFAULT_INSPECTOR_PANEL = 310;

type PanelSizes = Partial<Record<'leftWidth' | 'rightWidth' | 'canvasHeight' | 'inspectorHeight', number>>;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readSizes(): PanelSizes {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    const validSize = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
    return {
      leftWidth: validSize(saved?.leftWidth),
      rightWidth: validSize(saved?.rightWidth),
      canvasHeight: validSize(saved?.canvasHeight),
      inspectorHeight: validSize(saved?.inspectorHeight),
    };
  } catch {
    return {};
  }
}

export function usePanelLayout() {
  const workspaceRef = useRef<HTMLElement>(null);
  const leftRef = useRef<HTMLElement>(null);
  const rightRef = useRef<HTMLElement>(null);
  const [sizes, setSizes] = useState<PanelSizes | null>(null);
  const [available, setAvailable] = useState({ viewport: 1440, width: 1420, leftHeight: 760, rightHeight: 760 });

  useEffect(() => {
    const workspace = workspaceRef.current;
    const left = leftRef.current;
    const right = rightRef.current;
    if (!workspace || !left || !right) return;
    const measure = () => {
      const style = getComputedStyle(workspace);
      const viewport = window.innerWidth;
      const width = workspace.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const leftHeight = left.clientHeight;
      const rightHeight = right.clientHeight;
      setAvailable(previous => previous.viewport === viewport && previous.width === width &&
        previous.leftHeight === leftHeight && previous.rightHeight === rightHeight
        ? previous : { viewport, width, leftHeight, rightHeight });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    observer.observe(left);
    observer.observe(right);
    window.addEventListener('resize', measure);
    measure();
    setSizes(readSizes());
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(() => {
    if (!sizes) return;
    const save = () => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes)); } catch { /* Storage may be disabled. */ }
    };
    const timer = window.setTimeout(save, 200);
    window.addEventListener('pagehide', save);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pagehide', save);
    };
  }, [sizes]);

  const update = (key: keyof PanelSizes, value: number | undefined) => {
    setSizes(previous => previous?.[key] === value ? previous : { ...previous, [key]: value });
  };
  const desktop = available.viewport > 1020;
  const defaultLeft = desktop ? (available.viewport > 1280 ? 300 : 278) : 280;
  const defaultRight = available.viewport > 1280 ? 320 : 294;
  const paneWidth = available.width - SPLITTER_SIZE * (desktop ? 2 : 1);
  const leftLimit = Math.max(MIN_LEFT_WIDTH, Math.min(MAX_SIDEBAR_WIDTH,
    paneWidth - MIN_CANVAS_WIDTH - (desktop ? MIN_RIGHT_WIDTH : 0)));
  const leftWidth = clamp(sizes?.leftWidth ?? defaultLeft, MIN_LEFT_WIDTH, leftLimit);
  const rightLimit = Math.max(MIN_RIGHT_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, paneWidth - leftWidth - MIN_CANVAS_WIDTH));
  const rightWidth = clamp(sizes?.rightWidth ?? defaultRight, MIN_RIGHT_WIDTH, rightLimit);
  const leftMax = Math.max(MIN_LEFT_WIDTH, Math.min(MAX_SIDEBAR_WIDTH,
    paneWidth - MIN_CANVAS_WIDTH - (desktop ? rightWidth : 0)));

  const canvasMax = Math.max(MIN_CANVAS_PANEL, available.leftHeight - SPLITTER_SIZE - MIN_SHAPE_PANEL);
  const canvasHeight = clamp(sizes?.canvasHeight ?? DEFAULT_CANVAS_PANEL, MIN_CANVAS_PANEL, canvasMax);
  const rightHeight = Math.max(available.rightHeight - SPLITTER_SIZE, MIN_LAYER_PANEL + MIN_INSPECTOR_PANEL);
  const layerMax = rightHeight - MIN_INSPECTOR_PANEL;
  const inspectorHeight = clamp(sizes?.inspectorHeight ?? DEFAULT_INSPECTOR_PANEL, MIN_INSPECTOR_PANEL, rightHeight - MIN_LAYER_PANEL);
  const layerHeight = rightHeight - inspectorHeight;
  const centerAndRightWidth = paneWidth - leftWidth;

  const style = {
    '--left-panel-width': `${leftWidth}px`,
    '--right-panel-width': `${rightWidth}px`,
    '--canvas-panel-height': `${canvasHeight}px`,
    '--inspector-panel-height': `${inspectorHeight}px`,
    '--splitter-size': `${SPLITTER_SIZE}px`,
    '--min-shape-panel-height': `${MIN_SHAPE_PANEL}px`,
    '--min-layer-panel-height': `${MIN_LAYER_PANEL}px`,
  } as CSSProperties;

  return {
    workspaceRef, leftRef, rightRef, style,
    left: { value: leftWidth, min: MIN_LEFT_WIDTH, max: leftMax, onChange: (value: number) => update('leftWidth', value), onReset: () => update('leftWidth', undefined) },
    right: { value: centerAndRightWidth - rightWidth, min: centerAndRightWidth - rightLimit, max: centerAndRightWidth - MIN_RIGHT_WIDTH,
      onChange: (value: number) => update('rightWidth', centerAndRightWidth - value), onReset: () => update('rightWidth', undefined) },
    canvas: { value: canvasHeight, min: MIN_CANVAS_PANEL, max: canvasMax, onChange: (value: number) => update('canvasHeight', value), onReset: () => update('canvasHeight', undefined) },
    layers: { value: layerHeight, min: MIN_LAYER_PANEL, max: layerMax,
      onChange: (value: number) => update('inspectorHeight', rightHeight - value), onReset: () => update('inspectorHeight', undefined) },
  };
}

type SplitterProps = {
  orientation: 'vertical' | 'horizontal';
  label: string;
  controls: string;
  className?: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onReset: () => void;
};

export function PanelSplitter({ orientation, label, controls, className, value, min, max, onChange, onReset }: SplitterProps) {
  const drag = useRef<{ pointerId: number; start: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const vertical = orientation === 'vertical';
  const position = (event: PointerEvent<HTMLDivElement>) => vertical ? event.clientX : event.clientY;
  const stop = () => { drag.current = null; setDragging(false); };

  useEffect(() => {
    if (!dragging) return;
    const bodyClass = `resizing-panels-${orientation}`;
    document.body.classList.add(bodyClass);
    window.addEventListener('blur', stop);
    return () => {
      document.body.classList.remove(bodyClass);
      window.removeEventListener('blur', stop);
    };
  }, [dragging, orientation]);

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const delta = position(event) - current.start;
    if (delta || value !== current.value) onChange(clamp(current.value + delta, min, max));
  };

  return <div className={className ? `panel-splitter ${className}` : 'panel-splitter'} role="separator" tabIndex={0}
    aria-label={label} aria-orientation={orientation} aria-controls={controls}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${value} pixels`}
    data-dragging={dragging || undefined}
    title="Drag to resize. Double-click or press Enter to reset. Use arrow keys to adjust."
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      drag.current = { pointerId: event.pointerId, start: position(event), value };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }}
    onPointerMove={move}
    onPointerUp={event => {
      if (drag.current?.pointerId !== event.pointerId) return;
      move(event);
      stop();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={stop}
    onLostPointerCapture={stop}
    onDoubleClick={onReset}
    onKeyDown={event => {
      const negative = vertical ? 'ArrowLeft' : 'ArrowUp';
      const positive = vertical ? 'ArrowRight' : 'ArrowDown';
      if (event.key === negative || event.key === positive) {
        const step = event.shiftKey ? 50 : 16;
        onChange(clamp(value + (event.key === positive ? step : -step), min, max));
      } else if (event.key === 'Home' || event.key === 'End') {
        onChange(event.key === 'Home' ? min : max);
      } else if (event.key === 'Enter') {
        onReset();
      } else if (event.key === 'Escape' && drag.current) {
        const { pointerId, value: startValue } = drag.current;
        onChange(startValue);
        stop();
        if (event.currentTarget.hasPointerCapture(pointerId)) event.currentTarget.releasePointerCapture(pointerId);
      } else return;
      event.preventDefault();
      event.stopPropagation();
    }} />;
}

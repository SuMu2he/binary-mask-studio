import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { OPAQUE_ONE, OPAQUE_ZERO, TRANSPARENT, type Layer, type LayerFill } from '../mask-model';
import { SectionHeading } from './editor-primitives';

function EyeIcon({ open }: { open: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={open ? 'M2.6 12s3.5-6 9.4-6 9.4 6 9.4 6-3.5 6-9.4 6-9.4-6-9.4-6Z' : 'M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5.9 0 9.4 6 9.4 6a15.7 15.7 0 0 1-2.2 2.9M6.2 6.2C3.9 8 2.6 12 2.6 12s3.5 6 9.4 6c1.4 0 2.6-.3 3.7-.8'} /><circle cx="12" cy="12" r="2.5" /></svg>;
}

function LockIcon({ locked }: { locked: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2" /><path d={locked ? 'M8 10V7a4 4 0 0 1 8 0v3' : 'M16 10V7a4 4 0 0 0-7.7-1.5'} /></svg>;
}

function LayerThumbnail({ layer, width, height, version }: { layer: Layer; width: number; height: number; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const context = canvas.getContext('2d'); if (!context) return;
    const image = context.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x / canvas.width) * width));
      const sourceY = Math.min(height - 1, Math.floor((y / canvas.height) * height));
      const state = layer.pixels[sourceY * width + sourceX];
      const index = (y * canvas.width + x) * 4;
      const checker = (Math.floor(x / 5) + Math.floor(y / 5)) % 2 ? 222 : 244;
      const value = state === OPAQUE_ONE ? 255 : state === OPAQUE_ZERO ? 0 : checker;
      image.data[index] = value; image.data[index + 1] = value; image.data[index + 2] = value; image.data[index + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [height, layer, version, width]);
  return <canvas ref={ref} width={54} height={32} aria-hidden="true" />;
}

type LayersPanelProps = {
  width: number;
  height: number;
  docVersion: number;
  layerList: Layer[];
  selectedSet: ReadonlySet<string>;
  selectedCount: number;
  activeLayerId: string;
  onAddLayer: (fill: LayerFill) => void;
  duplicateSelectedLayers: () => void;
  mergeSelectedLayers: () => void;
  setDragLayerId: (id: string) => void;
  dropLayer: (id: string) => void;
  selectLayer: (event: MouseEvent, id: string) => void;
  renameLayer: (id: string) => void;
  toggleLayerVisibility: (id: string) => void;
  toggleLayerLock: (id: string) => void;
  deleteLayer: (id: string) => void;
  moveLayer: (id: string, direction: -1 | 1) => void;
  clearAllLayers: () => void;
};

export function LayersPanel({
  width, height, docVersion, layerList, selectedSet, selectedCount, activeLayerId, onAddLayer,
  duplicateSelectedLayers, mergeSelectedLayers, setDragLayerId, dropLayer, selectLayer, renameLayer,
  toggleLayerVisibility, toggleLayerLock, deleteLayer, moveLayer, clearAllLayers,
}: LayersPanelProps) {
  const layerCreateRef = useRef<HTMLDivElement>(null);
  const [layerCreateMenuOpen, setLayerCreateMenuOpen] = useState(false);
  const addLayer = (fill: LayerFill) => {
    onAddLayer(fill);
    setLayerCreateMenuOpen(false);
  };
  useEffect(() => {
    if (!layerCreateMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => { if (!layerCreateRef.current?.contains(event.target as Node)) setLayerCreateMenuOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setLayerCreateMenuOpen(false); };
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => { window.removeEventListener('pointerdown', closeOnOutsidePointer, true); window.removeEventListener('keydown', closeOnEscape); };
  }, [layerCreateMenuOpen]);

  return (
    <section className="panel layer-panel" id="layers-panel"><SectionHeading number="03" title="Layers" />
      <div className="layer-actions primary-actions"><div className="layer-create-control" ref={layerCreateRef}><button type="button" aria-haspopup="menu" aria-expanded={layerCreateMenuOpen} onClick={() => setLayerCreateMenuOpen((open) => !open)}>New</button>{layerCreateMenuOpen && <div className="layer-create-menu" role="menu" aria-label="New layer type"><button type="button" role="menuitem" onClick={() => addLayer(TRANSPARENT)}><i className="layer-fill-swatch transparent" aria-hidden="true" /><span>Transparent Layer</span></button><button type="button" role="menuitem" onClick={() => addLayer(OPAQUE_ZERO)}><i className="layer-fill-swatch zero" aria-hidden="true" /><span>Black 0 Layer</span></button><button type="button" role="menuitem" onClick={() => addLayer(OPAQUE_ONE)}><i className="layer-fill-swatch one" aria-hidden="true" /><span>White 1 Layer</span></button></div>}</div><button type="button" onClick={duplicateSelectedLayers}>Duplicate</button><button type="button" disabled={selectedCount < 2} onClick={mergeSelectedLayers}>Merge Selected</button></div>
      <div className="layer-list" aria-label="Layer list">{layerList.map((layer, index) => {
        const selected = selectedSet.has(layer.id); const active = layer.id === activeLayerId;
        return <div key={layer.id} className={`layer-row ${selected ? 'selected' : ''} ${active ? 'active' : ''} ${layer.locked ? 'locked' : ''}`} draggable={!layer.locked} onDragStart={() => setDragLayerId(layer.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropLayer(layer.id)} onClick={(event) => selectLayer(event, layer.id)} onDoubleClick={() => renameLayer(layer.id)}>
          <button type="button" className="icon-button" aria-label={layer.visible ? 'Hide layer' : 'Show layer'} title={layer.visible ? 'Hide layer' : 'Show layer'} onClick={(event) => { event.stopPropagation(); toggleLayerVisibility(layer.id); }}><EyeIcon open={layer.visible} /></button><LayerThumbnail layer={layer} width={width} height={height} version={docVersion} /><span className="layer-name"><strong>{layer.name}</strong><small>{layer.visible ? 'Visible' : 'Hidden'} · {layer.locked ? 'Locked' : 'Editable'}</small></span><button type="button" className="icon-button lock-button" aria-label={layer.locked ? 'Unlock layer' : 'Lock layer'} title={layer.locked ? 'Unlock layer' : 'Lock layer'} onClick={(event) => { event.stopPropagation(); toggleLayerLock(layer.id); }}><LockIcon locked={layer.locked} /></button><button type="button" className="icon-button delete-layer-button" aria-label={`Delete layer ${layer.name}`} title="Delete layer" disabled={layer.locked} onClick={(event) => { event.stopPropagation(); deleteLayer(layer.id); }} onDoubleClick={(event) => event.stopPropagation()}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></svg></button><div className="layer-order-controls" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
            <button type="button" className="icon-button layer-order-button" aria-label={`Move layer up: ${layer.name}`} title="Move layer up" disabled={index === 0 || layer.locked} onClick={() => moveLayer(layer.id, -1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button>
            <span className="drag-handle" aria-hidden="true"><i /><i /><i /></span>
            <button type="button" className="icon-button layer-order-button" aria-label={`Move layer down: ${layer.name}`} title="Move layer down" disabled={index === layerList.length - 1 || layer.locked} onClick={() => moveLayer(layer.id, 1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>
          </div>
        </div>;
      })}</div>
      <button className="clear-all-button" type="button" onClick={clearAllLayers}>Clear All Layers</button>
    </section>
  );
}

import type { RefObject } from 'react';
import { formatPixelSize, PIXEL_SIDE_UNITS_PER_INCH, type ResolutionMode } from '../canvas-calibration';
import { MAX_DIMENSION, MAX_DPI, MIN_DPI, type PixelSideUnit } from '../mask-model';
import NumericInput from '../numeric-input';
import { FieldSuffix } from './editor-primitives';

type NewCanvasDialogProps = {
  newCanvasFieldsRef: RefObject<HTMLElement | null>;
  newWidth: number;
  newHeight: number;
  newDpi: number;
  newResolutionMode: ResolutionMode;
  newPixelSideUnit: PixelSideUnit;
  setNewWidth: (value: number) => void;
  setNewHeight: (value: number) => void;
  setNewDpi: (value: number) => void;
  setNewResolutionMode: (mode: ResolutionMode) => void;
  setNewPixelSideUnit: (unit: PixelSideUnit) => void;
  createNewCanvas: () => void;
  onClose: () => void;
};

export function NewCanvasDialog({
  newCanvasFieldsRef, newWidth, newHeight, newDpi, newResolutionMode, newPixelSideUnit,
  setNewWidth, setNewHeight, setNewDpi, setNewResolutionMode, setNewPixelSideUnit, createNewCanvas, onClose,
}: NewCanvasDialogProps) {
  const unitsPerInch = PIXEL_SIDE_UNITS_PER_INCH[newPixelSideUnit];
  const minPixelSide = unitsPerInch / MAX_DPI;
  const maxPixelSide = unitsPerInch / MIN_DPI;
  const displayedNewDpi = newDpi.toFixed(2);
  const newPixelSide = Math.min(maxPixelSide, Math.max(minPixelSide, unitsPerInch / newDpi));

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={newCanvasFieldsRef} className="dialog-card new-canvas-dialog" role="dialog" aria-modal="true" aria-labelledby="new-canvas-title">
      <div className="modal-header"><div><small>NEW BINARY DOCUMENT</small><h2 id="new-canvas-title">New Canvas</h2></div><button type="button" aria-label="Close" onClick={onClose}>×</button></div><p>Width, height, and DPI are locked after creation. Every layer uses the same canvas dimensions.</p>
      <div className="field-grid two-columns"><label>Width<div className="input-shell"><NumericInput className="number-input" min="1" max={MAX_DIMENSION} value={newWidth} onValueChange={(value) => setNewWidth(value)} /><FieldSuffix>px</FieldSuffix></div></label><label>Height<div className="input-shell"><NumericInput className="number-input" min="1" max={MAX_DIMENSION} value={newHeight} onValueChange={(value) => setNewHeight(value)} /><FieldSuffix>px</FieldSuffix></div></label></div>
      <fieldset className="canvas-resolution">
        <legend>Set resolution by</legend>
        <div className="field-grid two-columns">
          <div>
            <label className="resolution-choice"><input type="radio" name="canvas-resolution" checked={newResolutionMode === 'dpi'} onChange={() => setNewResolutionMode('dpi')} />DPI</label>
            <div className="input-shell">
              {newResolutionMode === 'dpi'
                ? <NumericInput aria-label="DPI value" className="number-input" min={MIN_DPI} max={MAX_DPI} strictRange formatValue={(value) => value.toFixed(2)} value={newDpi} onValueChange={(value) => setNewDpi(Number(value.toFixed(2)))} />
                : <input aria-label="DPI value" className="number-input" value={displayedNewDpi} readOnly />}
              <FieldSuffix>DPI</FieldSuffix>
            </div>
          </div>
          <div>
            <label className="resolution-choice"><input type="radio" name="canvas-resolution" checked={newResolutionMode === 'pixel'} onChange={() => setNewResolutionMode('pixel')} />Pixel size</label>
            <div className="pixel-side-row">
              {newResolutionMode === 'pixel'
                ? <NumericInput key={newPixelSideUnit} aria-label="Pixel size value" className="number-input" min={minPixelSide} max={maxPixelSide} step={newPixelSideUnit === 'um' ? 0.1 : 0.0001} strictRange formatValue={formatPixelSize} value={newPixelSide}
                    onValueChange={(value) => setNewDpi(Math.min(MAX_DPI, Math.max(MIN_DPI, unitsPerInch / value)))} />
                : <input aria-label="Pixel size value" className="number-input" value={formatPixelSize(newPixelSide)} readOnly />}
              <select aria-label="Pixel size unit" value={newPixelSideUnit} onChange={(event) => setNewPixelSideUnit(event.target.value as PixelSideUnit)}><option value="um">μm</option><option value="mm">mm</option></select>
            </div>
          </div>
        </div>
      </fieldset>
      <div className="physical-size"><span>Physical size</span><strong>{((Math.round(newWidth) / newDpi) * 25.4).toFixed(2)} × {((Math.round(newHeight) / newDpi) * 25.4).toFixed(2)} mm</strong></div>
      <div className="modal-footer"><button type="button" onClick={onClose}>Cancel</button><button className="modal-primary" type="button" onClick={createNewCanvas}>Create &amp; Lock</button></div>
    </section></div>
  );
}

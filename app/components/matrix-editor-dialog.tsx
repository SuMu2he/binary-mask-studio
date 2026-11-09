import type { RefObject } from 'react';
import { OPAQUE_ONE, OPAQUE_ZERO, TRANSPARENT, type Selection } from '../mask-model';
import NumericInput from '../numeric-input';

export type MatrixView = 'cells' | 'text';
export type MatrixScope = 'layer' | 'selection';
export const MATRIX_COLUMNS = 16;
export const MATRIX_ROWS = 10;

type MatrixEditorDialogProps = {
  matrixFieldsRef: RefObject<HTMLElement | null>;
  activeLayerName: string;
  locked: boolean;
  width: number;
  selection: Selection | null;
  matrixRegion: Selection;
  matrixScope: MatrixScope;
  matrixView: MatrixView;
  matrixStartX: number;
  matrixStartY: number;
  matrixDraft: Uint8Array | null;
  matrixDraftVersion: number;
  matrixText: string;
  changeMatrixScope: (scope: MatrixScope) => void;
  setMatrixView: (view: MatrixView) => void;
  setMatrixStartX: (x: number) => void;
  setMatrixStartY: (y: number) => void;
  setMatrixText: (text: string) => void;
  setMatrixCell: (x: number, y: number, value?: number) => void;
  loadMatrixText: () => void;
  applyMatrixEditor: () => void;
  onClose: () => void;
};

export function MatrixEditorDialog({
  matrixFieldsRef, activeLayerName, locked, width, selection, matrixRegion, matrixScope, matrixView, matrixStartX, matrixStartY,
  matrixDraft, matrixDraftVersion, matrixText, changeMatrixScope, setMatrixView, setMatrixStartX, setMatrixStartY, setMatrixText,
  setMatrixCell, loadMatrixText, applyMatrixEditor, onClose,
}: MatrixEditorDialogProps) {
  const matrixGridColumns = Array.from({ length: Math.min(MATRIX_COLUMNS, matrixRegion.x + matrixRegion.width - matrixStartX) }, (_, index) => matrixStartX + index);
  const matrixGridRows = Array.from({ length: Math.min(MATRIX_ROWS, matrixRegion.y + matrixRegion.height - matrixStartY) }, (_, index) => matrixStartY + index);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={matrixFieldsRef} className="dialog-card matrix-modal" role="dialog" aria-modal="true" aria-labelledby="matrix-title">
      <div className="modal-header"><div><small>CURRENT LAYER MATRIX</small><h2 id="matrix-title">Edit Current Layer · {activeLayerName}</h2></div><button type="button" aria-label="Close" onClick={onClose}>×</button></div>
      <div className="matrix-legend"><span><i className="transparent-swatch">·</i>Transparent</span><span><i className="zero-swatch">0</i>Black</span><span><i className="one-swatch">1</i>White</span><b>{matrixRegion.width} × {matrixRegion.height}</b></div>
      <div className="matrix-scope" role="group" aria-label="Matrix editing area"><button className={matrixScope === 'layer' ? 'active' : ''} type="button" onClick={() => changeMatrixScope('layer')}>Entire Layer</button><button className={matrixScope === 'selection' ? 'active' : ''} type="button" disabled={!selection} onClick={() => changeMatrixScope('selection')}>Current Selection</button><span>{matrixScope === 'selection' ? `X ${matrixRegion.x}–${matrixRegion.x + matrixRegion.width - 1} · Y ${matrixRegion.y}–${matrixRegion.y + matrixRegion.height - 1}` : 'Editing the entire layer matrix'}</span></div>
      <div className="modal-tabs"><button className={matrixView === 'cells' ? 'active' : ''} type="button" onClick={() => setMatrixView('cells')}>Cell Editor</button><button className={matrixView === 'text' ? 'active' : ''} type="button" onClick={() => setMatrixView('text')}>Text Input</button></div>
      {matrixView === 'cells' ? <div className="cell-editor">
        <div className="matrix-navigation"><label>Start X<NumericInput className="number-input" min={matrixRegion.x} max={matrixRegion.x + matrixRegion.width - 1} value={matrixStartX} onValueChange={(value) => setMatrixStartX(Math.max(matrixRegion.x, Math.min(matrixRegion.x + matrixRegion.width - 1, value || matrixRegion.x)))} /></label><label>Start Y<NumericInput className="number-input" min={matrixRegion.y} max={matrixRegion.y + matrixRegion.height - 1} value={matrixStartY} onValueChange={(value) => setMatrixStartY(Math.max(matrixRegion.y, Math.min(matrixRegion.y + matrixRegion.height - 1, value || matrixRegion.y)))} /></label><button type="button" onClick={() => setMatrixStartX(Math.max(matrixRegion.x, matrixStartX - MATRIX_COLUMNS))}>←</button><button type="button" onClick={() => setMatrixStartX(Math.min(matrixRegion.x + matrixRegion.width - 1, matrixStartX + MATRIX_COLUMNS))}>→</button><button type="button" onClick={() => setMatrixStartY(Math.max(matrixRegion.y, matrixStartY - MATRIX_ROWS))}>↑</button><button type="button" onClick={() => setMatrixStartY(Math.min(matrixRegion.y + matrixRegion.height - 1, matrixStartY + MATRIX_ROWS))}>↓</button></div>
        <div className="matrix-grid-wrap"><div className="matrix-grid" style={{ gridTemplateColumns: `46px repeat(${matrixGridColumns.length}, 34px)` }} data-version={matrixDraftVersion}><span className="corner-cell">Y / X</span>{matrixGridColumns.map((x) => <span className="axis-cell" key={`x-${x}`}>{x}</span>)}{matrixGridRows.flatMap((y) => [<span className="axis-cell row-axis" key={`y-${y}`}>{y}</span>, ...matrixGridColumns.map((x) => { const value = matrixDraft?.[y * width + x] ?? TRANSPARENT; return <button type="button" key={`${x}-${y}`} className={`matrix-cell state-${value}`} aria-label={`X ${x}, Y ${y}, ${value === OPAQUE_ONE ? '1 White' : value === OPAQUE_ZERO ? '0 Black' : 'Transparent'}`} onClick={() => setMatrixCell(x, y)} onKeyDown={(event) => { if (event.key === '0') setMatrixCell(x, y, OPAQUE_ZERO); else if (event.key === '1') setMatrixCell(x, y, OPAQUE_ONE); else if (event.key === 'Delete' || event.key === 'Backspace') setMatrixCell(x, y, TRANSPARENT); }}>{value === OPAQUE_ONE ? '1' : value === OPAQUE_ZERO ? '0' : '·'}</button>; })])}</div></div>
        <p>Click to cycle through transparent → 0 → 1. Press 0 or 1 to set a value, or Delete/Backspace to make it transparent.</p>
      </div> : <div className="text-matrix-editor"><p>The first row corresponds to the top of the editing area. Input dimensions must match the {matrixScope === 'selection' ? 'current selection' : 'entire layer'} exactly. Use 0 for black, 1 for white, and null or · for transparency. Spaces, commas, line breaks, and MATLAB semicolons are supported.</p><button type="button" onClick={loadMatrixText}>Load {matrixScope === 'selection' ? 'Selection' : 'Layer'} Text</button><textarea value={matrixText} onChange={(event) => setMatrixText(event.target.value)} spellCheck={false} placeholder={'· · · · ·\n· 0 1 0 ·\n· 1 1 1 ·\n· · · · ·'} /></div>}
      <div className="modal-footer"><span>All changes are saved as one undo step when you confirm.</span><button type="button" onClick={onClose}>Cancel</button><button className="modal-primary" type="button" disabled={locked} onClick={applyMatrixEditor}>Apply to Current Layer</button></div>
    </section></div>
  );
}

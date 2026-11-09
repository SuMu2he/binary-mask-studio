import { SectionHeading } from './editor-primitives';

type PixelInspectorProps = {
  cursor: { x: number; y: number };
  currentValue: number | 'null';
  showGratingPreview: boolean;
  gratingPreviewReadout: string;
  whitePixels: number;
  width: number;
  height: number;
  exportBaseName: string;
  safeExportBaseName: string;
  setExportBaseName: (name: string) => void;
  exportTransparency: boolean;
  setExportTransparency: (value: boolean) => void;
  processing: string;
  exportPng: () => void;
  exportMatrix: (format: 'csv' | 'txt') => void;
};

export function PixelInspector({
  cursor, currentValue, showGratingPreview, gratingPreviewReadout, whitePixels, width, height,
  exportBaseName, safeExportBaseName, setExportBaseName, exportTransparency, setExportTransparency,
  processing, exportPng, exportMatrix,
}: PixelInspectorProps) {
  return (
    <section className="panel inspector-panel" id="pixel-inspector"><SectionHeading number="04" title="Pixel Inspector" />
      <div className="coordinate-card"><small>Current pixel · Top-left origin</small><div><span>X</span><strong>{cursor.x}</strong><span>Y</span><strong>{cursor.y}</strong></div><p>Pixel value <b>{currentValue}</b></p>{showGratingPreview && <p>Grating preview (current layer) <b>{gratingPreviewReadout}</b></p>}</div>
      <div className="metric-list"><div><span>White pixels</span><strong>{whitePixels.toLocaleString('en-US')} ({((whitePixels / (width * height)) * 100).toFixed(4)}%)</strong></div><div><span>Total pixels</span><strong>{(width * height).toLocaleString('en-US')}</strong></div></div>
      <label className="export-name">Export file name<input value={exportBaseName} onChange={(event) => setExportBaseName(event.target.value)} onBlur={() => setExportBaseName(safeExportBaseName)} /></label>
      <div className="export-transparency">
        <label><input type="checkbox" checked={exportTransparency} onChange={(event) => setExportTransparency(event.target.checked)}
          aria-describedby={exportTransparency ? undefined : 'export-transparency-warning'} />Export transparency</label>
        {!exportTransparency && <span id="export-transparency-warning" className="export-transparency-warning" role="status">
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <circle cx="8" cy="8" r="6.5" />
            <path d="M8 4.8v3.7" />
            <circle cx="8" cy="11" r=".8" fill="currentColor" stroke="none" />
          </svg>
          <span>Transparent pixels will export as BLACK (0).</span>
        </span>}
      </div>
      <div className="download-row"><button type="button" disabled={Boolean(processing)} onClick={exportPng}>Export PNG</button><button type="button" disabled={Boolean(processing)} onClick={() => exportMatrix('csv')}>Export CSV</button><button type="button" disabled={Boolean(processing)} onClick={() => exportMatrix('txt')}>Export TXT</button></div>
    </section>
  );
}

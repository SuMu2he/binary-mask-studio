import { MAX_DIMENSION, OPAQUE_ONE, isSupportedDpi, type Layer, type PixelSideUnit } from '../mask-model.ts';

type MaskProject = {
  width: number;
  height: number;
  dpi: number;
  pixelSizeUnit: PixelSideUnit | null;
  activeLayerId: string;
  layers: Layer[];
};

type ProjectPayload = {
  format: 'binary-mask-studio';
  version: 1;
  width: number;
  height: number;
  dpi: number;
  activeLayerId: string;
  pixelSizeUnit?: PixelSideUnit;
  layers: Array<Omit<Layer, 'pixels'> & { pixels: string }>;
};

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function serializeProject({ width, height, dpi, pixelSizeUnit, activeLayerId, layers }: MaskProject) {
  const payload: ProjectPayload = {
    format: 'binary-mask-studio',
    version: 1,
    width,
    height,
    dpi,
    pixelSizeUnit: pixelSizeUnit ?? undefined,
    activeLayerId,
    layers: layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      locked: layer.locked,
      pixels: bytesToBase64(layer.pixels),
    })),
  };
  return JSON.stringify(payload);
}

export function deserializeProject(text: string, makeLayerId: () => string): MaskProject {
  const payload = JSON.parse(text) as ProjectPayload;
  if (payload.format !== 'binary-mask-studio' || payload.version !== 1) throw new Error('This is not a supported .bmask project file.');
  const { width, height, dpi } = payload;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error('The project\'s canvas dimensions are invalid.');
  }
  if (!isSupportedDpi(dpi)) throw new Error('The project\'s DPI is invalid.');
  if (!Array.isArray(payload.layers) || !payload.layers.length) throw new Error('The project contains no layers.');
  const expectedLength = width * height;
  const layers = payload.layers.map((item, index) => {
    const pixels = base64ToBytes(item.pixels);
    if (pixels.length !== expectedLength || pixels.some((value) => value > OPAQUE_ONE)) {
      throw new Error(`Layer ${index + 1} has corrupted data.`);
    }
    return {
      id: item.id || makeLayerId(),
      name: item.name || `Layer ${index + 1}`,
      visible: Boolean(item.visible),
      locked: Boolean(item.locked),
      pixels,
    };
  });
  const pixelSizeUnit = payload.pixelSizeUnit === 'um' || payload.pixelSizeUnit === 'mm' ? payload.pixelSizeUnit : null;
  const activeLayerId = layers.some((layer) => layer.id === payload.activeLayerId) ? payload.activeLayerId : layers[0].id;
  return { width, height, dpi, pixelSizeUnit, activeLayerId, layers };
}

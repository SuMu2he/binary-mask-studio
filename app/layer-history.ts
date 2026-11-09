import type { Layer } from './mask-model.ts';

export type HistorySnapshot = {
  layers: Layer[];
  activeLayerId: string;
  selectedLayerIds: string[];
};

// Snapshot metadata by value. Share pixel buffers until the next write to that layer.
export function createLayerHistory() {
  const shared = new WeakSet<Uint8Array>();

  return {
    snapshot(layers: Layer[], activeLayerId: string, selectedLayerIds: string[]): HistorySnapshot {
      return {
        layers: layers.map((layer) => {
          shared.add(layer.pixels);
          return { ...layer };
        }),
        activeLayerId,
        selectedLayerIds: [...selectedLayerIds],
      };
    },
    writablePixels(layer: Layer) {
      if (shared.has(layer.pixels)) layer.pixels = layer.pixels.slice();
      return layer.pixels;
    },
    restore(snapshot: HistorySnapshot) {
      return snapshot.layers.map((layer) => ({ ...layer }));
    },
  };
}

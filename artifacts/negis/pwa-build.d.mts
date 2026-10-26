export function buildServiceWorker(source: string, files: Map<string, string | Uint8Array>, options?: { legacySource?: boolean }): {
  readonly buildId: string;
  readonly precache: readonly string[];
  readonly script: string;
};

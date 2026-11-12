import { createHash } from 'node:crypto';

const assetMarker = '/* __SHELL_ASSETS__ */ ["/manifest.webmanifest"]';
const staticNames = new Set(['index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'icon-maskable-512.png', 'apple-touch-icon.png', 'fonts/inter/inter-latin.woff2',
  'fonts/inter/inter-cyrillic.woff2', 'fonts/inter/inter-cyrillic-ext.woff2']);

// Build-time only: explicit public files, never an arbitrary directory or URL.
export function buildServiceWorker(source, files, { legacySource = false } = {}) {
  if (typeof source !== 'string' || source.split('__BUILD_ID__').length !== 2 || !(files instanceof Map)) throw Error('Invalid PWA build input');
  if ((!legacySource && source.split(assetMarker).length !== 2) || (legacySource && source.includes(assetMarker))) throw Error('Invalid PWA asset marker');
  if (!files.has('index.html') || !files.has('manifest.webmanifest')) throw Error('Missing PWA shell entry');
  const names = [...files.keys()].sort();
  if (!names.some(name => /^assets\/.+\.[cm]?js$/.test(name)) || !names.some(name => /^assets\/.+\.css$/.test(name))) throw Error('Missing PWA built graph');
  const digest = createHash('sha256').update('medina-public-shell-v1\0').update(source);
  for (const name of names) {
    if (typeof name !== 'string' || (!staticNames.has(name) && !/^assets\/[\w.-]+[.-][\w-]{8,}\.(?:js|css|woff2?|png|jpg|svg)$/.test(name))
      || name.split('/').some(part => part === '.' || part === '..')) throw Error('PWA input is not an explicit public shell asset');
    const value = files.get(name);
    if (typeof value !== 'string' && !(value instanceof Uint8Array)) throw Error('Invalid PWA asset bytes');
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    digest.update(name).update('\0').update(String(bytes.byteLength)).update('\0').update(bytes).update('\0');
  }
  const buildId = digest.digest('hex').slice(0, 12);
  const precache = Object.freeze(names.filter(name => name !== 'index.html').map(name => '/' + name));
  let script = source.replace('__BUILD_ID__', buildId);
  if (!legacySource) script = script.replace(assetMarker, JSON.stringify(precache));
  return Object.freeze({ buildId, precache, script });
}

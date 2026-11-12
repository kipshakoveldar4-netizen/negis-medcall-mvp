// ESM preview entry; server code loads the CommonJS module directly.
import renderer from './render.cjs';
export const { escapeHtml, createPages, createSitemap } = renderer;

// ESM preview entry; server code loads the CommonJS module directly.
import renderer from './content.cjs';
export const { crmOrigin, services, articles } = renderer;

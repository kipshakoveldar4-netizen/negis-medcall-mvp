import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPages } from './render.mjs';
import { readFormSettings } from './settings.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export const output = path.join(root, 'dist');
export async function buildSite(intake = readFormSettings()) {
  const pages = createPages(intake);
  for (const [url, html] of pages) {
    const target = path.join(output, url.endsWith('/') ? `${url}index.html` : url);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, html, 'utf8');
  }
  await mkdir(path.join(output, 'assets'), { recursive: true });
  await copyFile(path.join(root, '../negis/public/icon-512.png'), path.join(output, 'assets/brand.png'));
  await copyFile(path.join(root, 'site.css'), path.join(output, 'site.css'));
  await copyFile(path.join(root, 'form.js'), path.join(output, 'form.js'));
  await writeFile(path.join(output, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  return pages;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Built ${(await buildSite()).size} preview pages. Indexing remains disabled.`);
}

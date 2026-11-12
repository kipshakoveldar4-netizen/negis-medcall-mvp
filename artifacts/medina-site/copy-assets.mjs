import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, '../negis/dist/public/medina-site');
await mkdir(path.join(output, 'assets'), { recursive: true });
await copyFile(path.join(root, 'site.css'), path.join(output, 'site.css'));
await copyFile(path.join(root, 'form.js'), path.join(output, 'form.js'));
await copyFile(path.join(root, '../negis/public/icon-512.png'), path.join(output, 'assets/brand.png'));

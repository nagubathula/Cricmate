// Copies browser builds of dependencies into public/vendor so the game can be served
// (and cached for offline play) without a CDN. Runs automatically after `npm install`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'public', 'vendor');
fs.mkdirSync(out, { recursive: true });
for (const f of ['three.module.js', 'three.core.js']) {
  fs.copyFileSync(path.join(root, 'node_modules', 'three', 'build', f), path.join(out, f));
}
fs.copyFileSync(path.join(root, 'node_modules', 'three', 'LICENSE'), path.join(out, 'three.LICENSE'));
console.log('vendored three.js →', path.relative(root, out));

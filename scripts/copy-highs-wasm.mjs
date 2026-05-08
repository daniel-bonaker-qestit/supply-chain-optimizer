import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', 'node_modules', 'highs', 'build', 'highs.wasm');
const destDir = resolve(here, '..', 'public');
const dest = resolve(destDir, 'highs.wasm');

if (!existsSync(src)) {
  throw new Error(`highs.wasm not found at ${src} — did you run npm install?`);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`Copied ${src} -> ${dest}`);

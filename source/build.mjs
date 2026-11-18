// Adapted from the build script of Abyssal Garden (https://github.com/Noniv/abyssal-garden), MIT, (c) 2026 Maksymilian Dendura
// Bundles src/*.js into the single self-contained ../index.html. No dependencies.
//   node build.mjs          readable output
//   node build.mjs --min    also squeezes the WGSL and, if esbuild is installed, minifies the JS
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// concatenation order matters: every file shares one scope
const FILES = ['quality.js', 'math.js', 'data.js', 'world.js', 'shaders.js', 'renderer.js', 'audio.js', 'main.js'];
const min = process.argv.includes('--min');

let js = FILES.map((f) => readFileSync(path.join(here, 'src', f), 'utf8')).join('\n');
const tpl = readFileSync(path.join(here, 'template.html'), 'utf8');
// everything runs inside one async function; startup errors are shown on screen
const wrap = (body) => `(async()=>{${body}\n})().catch(e=>{console.error(e);document.body.className='l e';document.getElementById('s').textContent=(e.cause?'':'Failed to start: ')+e.message});`;

if (min) {
  const minWgsl = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').replace(/ ?([{}()\[\];,:=+\-*\/<>&|!%@]) ?/g, '$1').trim();
  js = js.replace(/\/\*wgsl\*\/`([^`]*)`/g, (_, w) => '/*wgsl*/`' + minWgsl(w) + '`');
}
let code = wrap(js);
if (min) {
  try {
    const { transformSync } = await import('esbuild');
    code = transformSync(code, { minify: true, target: 'es2022', legalComments: 'none' }).code.trim();
  } catch {
    console.log('(esbuild not installed: JS left unminified)');
  }
}
const html = tpl.replace('/*SCRIPT*/', () => code);
writeFileSync(path.join(here, '..', 'index.html'), html);
const gz = gzipSync(Buffer.from(html), { level: 9 }).length;
console.log(`index.html: ${(html.length / 1024).toFixed(1)} kB, ${(gz / 1024).toFixed(1)} kB gzipped`);

import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import tailwindConfig from '../../apps/web/tailwind.config.js';

// Build in memory so the component test needs no generated files or live API.
const js = await build({
  entryPoints: ['tests/browser/memory.tsx'], bundle: true, write: false,
  format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' },
  define: { 'import.meta.env': '{}' },
  alias: { '@app': resolve('apps/web/src'), '@xbam/shared/contracts': resolve('packages/shared/src/contracts/index.ts') },
});
const css = await postcss([tailwind({ ...tailwindConfig, content: ['./apps/web/src/**/*.{ts,tsx}'] })])
  .process(await readFile('apps/web/src/styles.css', 'utf8'), { from: undefined });
const fonts = (await readFile('apps/web/index.html', 'utf8')).match(/<link\s+href="https:\/\/fonts.googleapis.com[^>]+>/)?.[0] ?? '';
const html = (await readFile('tests/browser/memory.html', 'utf8')).replace('./memory.tsx', '/memory.js').replace('</head>', `${fonts}<link rel="stylesheet" href="/memory.css"></head>`);
createServer((req, res) => {
  const file = req.url === '/memory.js' ? ['text/javascript', js.outputFiles[0].text]
    : req.url === '/memory.css' ? ['text/css', css.css] : ['text/html', html];
  res.writeHead(200, { 'content-type': file[0] }); res.end(file[1]);
}).listen(5178, '127.0.0.1');

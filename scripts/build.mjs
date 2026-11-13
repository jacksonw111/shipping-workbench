import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(root, 'lib');

fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.resolve(root, 'src/index.js')],
  outfile: path.resolve(outDir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['@deepseek-ai/cordis'],
  banner: {
    js: [
      '// shipping-workbench — generated bundle. Edit src/ instead.',
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});

fs.copyFileSync(path.resolve(root, 'client-src/client.js'), path.resolve(outDir, 'client.js'));

// pdfjs 的 fake worker 是独立文件:装进 DSH 后插件目录没有 node_modules,必须一起带上。
const workerSource = path.resolve(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs');
const workerTarget = path.resolve(outDir, 'pdf.worker.mjs');
if (fs.existsSync(workerSource)) {
  fs.copyFileSync(workerSource, workerTarget);
} else {
  throw new Error('缺少 pdfjs-dist 的 pdf.worker.min.mjs,先 npm install');
}

console.log('built lib/index.js, lib/client.js and lib/pdf.worker.mjs');

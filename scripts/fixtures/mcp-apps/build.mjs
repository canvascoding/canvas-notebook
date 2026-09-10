import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'dist');
await mkdir(output, { recursive: true });
for (const name of ['table-app', 'chart-app']) {
  const result = await build({
    entryPoints: [join(root, `${name}.ts`)], bundle: true, format: 'iife',
    platform: 'browser', write: false, minify: true,
  });
  await writeFile(join(output, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title><style>body{margin:0;background:#f8fafc;color:#172033;font:14px system-ui,sans-serif}main{padding:16px;display:grid;gap:12px}h1{font-size:16px;margin:0}label{display:flex;gap:8px;align-items:center}input{border:1px solid #cbd5e1;border-radius:6px;padding:6px}button{width:max-content;border:0;border-radius:6px;padding:7px 10px;background:#2563eb;color:#fff;font-weight:600}table{border-collapse:collapse;background:#fff;border:1px solid #e2e8f0}th,td{padding:7px 9px;text-align:left;border-bottom:1px solid #e2e8f0}.chart{display:grid;gap:8px}.bar-row{display:grid;grid-template-columns:90px 1fr;gap:8px;align-items:center}.bar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar-track{height:22px;background:#dbeafe;border-radius:5px;overflow:hidden}.bar{height:100%;display:block;box-sizing:border-box;min-width:28px;padding:3px 6px;background:#2563eb;color:#fff;border-radius:5px;font-size:12px}output{min-height:1em;color:#475569}</style></head><body><script>${result.outputFiles[0].text}</script></body></html>`);
}

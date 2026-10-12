import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'public/_canvas-tool-apps');
await mkdir(output, { recursive: true });
const result = await build({ entryPoints: [path.join(root, 'app/tool-widgets/mobile-mcp-host.ts')], bundle: true,
  format: 'iife', platform: 'browser', write: false, minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
const script = result.outputFiles[0].text;
if (Buffer.byteLength(script, 'utf8') > 1024 * 1024) throw new Error('Trusted mobile MCP host exceeds its bundle bound.');
await writeFile(path.join(output, 'mobile-mcp-host-v1.js'), script);
console.log(`Built trusted mobile MCP host (${Math.ceil(Buffer.byteLength(script) / 1024)} KiB).`);

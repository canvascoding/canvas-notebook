import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '..');
const routePath = 'server/app/api/files/collaboration/checkpoint/route.js';

if (!process.argv.includes('--probe')) {
  const browser = buildSync({
    stdin: { contents: 'export { Doc, XmlText } from "yjs";', resolveDir: root },
    bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true,
  });
  assert.deepEqual(Object.keys(browser.metafile.inputs)
    .filter(file => /\/yjs\/dist\/yjs\.(?:cjs|mjs)$/.test(file)),
  ['node_modules/yjs/dist/yjs.mjs'], 'the Node export must preserve the browser ESM entry');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-built-collaboration-'));
  const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG']
    .flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  Object.assign(env, { DATA: data, NEXT_PHASE: 'phase-production-build', NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1', BASE_URL: 'http://localhost:3100', CANVAS_MCP_DIRECT_ENABLED: 'false' });
  try {
    const result = spawnSync(process.execPath, ['--conditions', 'react-server', filename, '--probe'], {
      cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    assert.equal(result.status, 0, result.error?.message ?? 'The built collaboration runtime failed');
    assert.deepEqual(fs.readdirSync(data), [], 'loading the build must not create runtime database files');
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
} else {
  const require = createRequire(import.meta.url);
  const entryPath = path.join(root, '.next', routePath);
  assert(fs.existsSync(entryPath), 'Run npm run build before checking production collaboration modules');
  const loadedYjs = new Set();
  const duplicateWarnings = [];
  const originalError = console.error;
  console.error = (...args) => {
    if (String(args[0]).includes('Yjs was already imported')) duplicateWarnings.push(String(args[0]));
    originalError(...args);
  };
  const hooks = registerHooks({ load(url, context, nextLoad) {
    if (/\/yjs\/dist\/yjs\.(?:cjs|mjs)$/.test(url)) {
      loadedYjs.add(url);
    }
    return nextLoad(url, context);
  } });
  const documents = [];
  let unregisterTs;
  try {
    const route = await require(entryPath);
    await route.routeModule.ensureUserland();
    assert.equal(typeof route.routeModule?.userland.POST, 'function');
    const runtime = require(path.join(root, '.next/server/chunks/[turbopack]_runtime.js'))(routePath);
    // Next 16.4 mangles export names. Use server source maps only to locate the
    // original declaration, then execute its actual production module factory.
    const builtExports = async (name) => {
      const { SourceMapConsumer } = require('next/dist/compiled/source-map');
      const matches = [];
      for (const [file, module] of Object.entries(require.cache)) {
        if (!file.startsWith(path.join(root, '.next/server/chunks') + path.sep) || !Array.isArray(module.exports)) continue;
        if (!fs.existsSync(`${file}.map`)) continue;
        const map = new SourceMapConsumer(JSON.parse(fs.readFileSync(`${file}.map`, 'utf8')));
        for (const source of map.sources.filter(value => value.endsWith('/collaboration/markdown-state.ts'))) {
          const original = map.sourceContentFor(source);
          const declaration = new RegExp(`export function ${name}\\b`).exec(original);
          assert(declaration, `The production source map must contain ${name}`);
          const before = original.slice(0, declaration.index + 'export function '.length);
          const position = map.generatedPositionFor({
            source, line: before.split('\n').length, column: before.length - before.lastIndexOf('\n') - 1,
          });
          assert(position.line !== null && position.column !== null, `${name} must have a generated location`);
          const code = fs.readFileSync(file, 'utf8');
          const offset = code.split('\n').slice(0, position.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + position.column;
          for (let i = 1; i < module.exports.length; i++) {
            const factory = module.exports[i];
            if (typeof factory !== 'function') continue;
            const factorySource = factory.toString();
            const start = code.indexOf(factorySource);
            if (start < 0 || offset < start || offset >= start + factorySource.length) continue;
            const id = module.exports[i - 1];
            assert(typeof id === 'number' || typeof id === 'string', 'The built factory must retain its module ID');
            const exported = await runtime.m(id).exports;
            for (const value of Object.values(exported)) {
              if (typeof value !== 'function') continue;
              const compiled = value.toString();
              const functionStart = code.indexOf(compiled, start);
              if (functionStart >= start && offset >= functionStart && offset < functionStart + compiled.length) {
                matches.push(value);
              }
            }
          }
        }
      }
      assert.equal(matches.length, 1, `Expected one built function for ${name}; adapt the probe if the build format changed`);
      return { [name]: matches[0] };
    };
    const { validateRichMarkdownYDoc } = await builtExports('validateRichMarkdownYDoc');
    // The custom WebSocket host and the Next server route use the shared CJS
    // runtime from server-runtime.ts. Build fixtures through that host's source
    // entry points and validate them through the production-compiled endpoint.
    unregisterTs = require('tsx/cjs/api').register();
    const markdown = require('../app/lib/collaboration/markdown-state.ts');
    const { CollaborationBlockTree } = require('../app/lib/collaboration/block-tree.ts');
    const { getSchema } = require('@tiptap/core');
    const schema = getSchema(markdown.richMarkdownSchemaExtensions());
    const Y = require('yjs');
    const xml = markdown.createRichMarkdownYDoc('# Title\n\nAlpha\n\nBeta'); documents.push(xml);
    assert(xml instanceof Y.Doc, 'the built transformer and endpoint must share Yjs constructors');
    const initialValidation = validateRichMarkdownYDoc(xml);
    assert.equal(initialValidation.valid, true, `built XML conversion retains text and structure: ${JSON.stringify(initialValidation)}; modules=${[...loadedYjs].join(', ')}`);
    const left = markdown.convertRichMarkdownYDoc(xml, 'tiptap_blocks'); documents.push(left);
    const right = new Y.Doc(); documents.push(right); Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    const a = new CollaborationBlockTree(left, schema);
    const b = new CollaborationBlockTree(right, schema);
    const id = a.read().child(1).attrs.id;
    a.move({ blockId: id, parentId: null, beforeId: null, operationId: 'production-move' }, 'local');
    right.transact(() => b.content(id).get(0).insert(5, ' Peer'), 'peer');
    const ownUpdate = Y.encodeStateAsUpdate(left);
    const peerUpdate = Y.encodeStateAsUpdate(right);
    Y.applyUpdate(left, peerUpdate, 'peer'); Y.applyUpdate(right, ownUpdate, 'peer');
    assert.deepEqual(a.read().toJSON(), b.read().toJSON());
    assert.equal(a.read().child(2).attrs.id, id);
    assert.equal(a.read().child(2).textContent, 'Alpha Peer');
    const before = Y.encodeStateAsUpdate(left);
    const validation = validateRichMarkdownYDoc(left);
    assert.equal(validation.valid, true);
    assert.equal(validation.markdown, '# Title\n\nBeta\n\nAlpha Peer');
    assert.deepEqual(Y.encodeStateAsUpdate(left), before, 'the built validator never rewrites document contents');
    const restored = new Y.Doc(); documents.push(restored); Y.applyUpdate(restored, before);
    assert.deepEqual(validateRichMarkdownYDoc(restored), validation);
    assert.deepEqual(new CollaborationBlockTree(restored, schema).read().toJSON(), a.read().toJSON());
    for (const body of [
      '- Item\n\n  ![Alt](image.png)\n\nTAIL',
      '- [x] Task\n\n  > [!note] **Title**\n  > **Body** and `code`\n\nTAIL',
      '<details>\n<summary>Outer</summary>\n\n<details open>\n<summary>Inner</summary>\n\n````txt\n</details>\n```\n<details>\n````\n\n</details>\n\n</details>\n\nTAIL',
      '> [!note] Empty body\n\nTAIL',
      '***\n\nTAIL',
      '- Outer\n  - [x] Task\n\n    Tail\n\n  After\n\nTAIL',
    ]) {
      const fixture = markdown.createRichMarkdownYDoc(body, 'tiptap_blocks'); documents.push(fixture);
      const saved = Y.encodeStateAsUpdate(fixture);
      assert.equal(validateRichMarkdownYDoc(fixture).valid, true, 'the built checkpoint accepts preserved nested block structures');
      assert.deepEqual(Y.encodeStateAsUpdate(fixture), saved, 'nested block validation is read-only');
    }
    assert.deepEqual([...loadedYjs], [pathToFileURL(require.resolve('yjs')).href],
      `The production CJS graph must load exactly its shared Yjs module: ${[...loadedYjs].join(', ')}`);
    assert.deepEqual(duplicateWarnings, []);
    console.log('Browser ESM is preserved. Node and built checkpoint modules share one Yjs instance; XML/block validation, concurrent move/text editing and binary reload preserve identity and content.');
  } finally {
    for (const doc of documents) doc.destroy();
    unregisterTs?.();
    hooks.deregister(); console.error = originalError;
  }
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
    if (/\/yjs\/dist\/yjs\.(?:cjs|mjs)$/.test(url)) loadedYjs.add(url);
    return nextLoad(url, context);
  } });
  const documents = [];
  let unregisterTs;
  try {
    const route = await require(entryPath);
    assert.equal(typeof route.routeModule?.userland.POST, 'function');
    const runtime = require(path.join(root, '.next/server/chunks/[turbopack]_runtime.js'))(routePath);
    // Use the actual helpers registered by the built endpoint, not a second
    // tsx compilation. Turbopack stores chunk factories as [id, factory, ...].
    // Fail explicitly if that build format changes instead of silently testing
    // the source tree and missing a production-only module identity failure.
    const builtExports = async (name, companion) => {
      const ids = new Set();
      for (const [file, module] of Object.entries(require.cache)) {
        if (!file.startsWith(path.join(root, '.next/server/chunks') + path.sep) || !Array.isArray(module.exports)) continue;
        for (let i = 1; i < module.exports.length; i++) {
          const factory = module.exports[i];
          if (typeof factory === 'function' && factory.toString().includes(JSON.stringify(name))
            && (!companion || factory.toString().includes(JSON.stringify(companion)))) {
            const id = module.exports[i - 1];
            if (typeof id === 'number' || typeof id === 'string') ids.add(id);
          }
        }
      }
      const matches = [];
      for (const id of ids) {
        const exported = await runtime.m(id).exports;
        if (typeof exported[name] === 'function' && (!companion || typeof exported[companion] === 'function')) matches.push(exported);
      }
      assert.equal(matches.length, 1, `Expected one built module exporting ${name}; adapt the probe if the build format changed`);
      return matches[0];
    };
    const { validateRichMarkdownYDoc } = await builtExports('validateRichMarkdownYDoc');
    // The custom WebSocket host loads TypeScript/CJS while Next can use native
    // ESM externals. Build fixtures through that host's source entry points and
    // validate them through the already loaded, production-compiled endpoint.
    unregisterTs = require('tsx/cjs/api').register();
    const markdown = require('../app/lib/collaboration/markdown-state.ts');
    const { CollaborationBlockTree } = require('../app/lib/collaboration/block-tree.ts');
    const { getSchema } = require('@tiptap/core');
    const schema = getSchema(markdown.richMarkdownSchemaExtensions());
    const Y = require('yjs');
    const esmY = await import('yjs');
    for (const name of ['Doc', 'AbstractType', 'XmlElement', 'XmlText', 'Map', 'Array']) {
      assert.equal(esmY[name], Y[name], `Node ESM/CJS must share Yjs.${name}`);
    }
    const xml = markdown.createRichMarkdownYDoc('# Title\n\nAlpha\n\nBeta'); documents.push(xml);
    assert(xml instanceof Y.Doc, 'the built transformer and endpoint must share Yjs constructors');
    assert.deepEqual((await import('@tiptap/y-tiptap')).yXmlFragmentToProsemirrorJSON(xml.getXmlFragment('body')),
      require('@tiptap/y-tiptap').yXmlFragmentToProsemirrorJSON(xml.getXmlFragment('body')),
      'native ESM and CJS adapters must read the same XML objects');
    assert.equal(validateRichMarkdownYDoc(xml).valid, true, 'built XML conversion retains text and structure');
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
    ]) {
      const fixture = markdown.createRichMarkdownYDoc(body, 'tiptap_blocks'); documents.push(fixture);
      const saved = Y.encodeStateAsUpdate(fixture);
      assert.equal(validateRichMarkdownYDoc(fixture).valid, true, 'the built checkpoint accepts preserved nested block structures');
      assert.deepEqual(Y.encodeStateAsUpdate(fixture), saved, 'nested block validation is read-only');
    }
    assert.equal(loadedYjs.size, 1, `Production loaded multiple Yjs modules: ${[...loadedYjs].join(', ')}`);
    assert.deepEqual(duplicateWarnings, []);
    console.log('Browser ESM is preserved. Node and built checkpoint modules share one Yjs instance; XML/block validation, concurrent move/text editing and binary reload preserve identity and content.');
  } finally {
    for (const doc of documents) doc.destroy();
    unregisterTs?.();
    hooks.deregister(); console.error = originalError;
  }
}

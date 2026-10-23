import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { EXCALIDRAW_FILE_SOURCE } from '../app/lib/excalidraw-file';
import { EXCALIDRAW_PORTABLE_MAX_BYTES } from '../app/lib/excalidraw-collaboration/limits';
import { ExcalidrawPortableSerializationError, serializePortableExcalidrawSceneFromReadonlyAssets as serialize,
  type PortableExcalidrawSceneSource as Source, type PortableExcalidrawAssetBytes as Asset,
} from '../app/lib/excalidraw-collaboration/portable-serialization';
import { canonicalSceneHash, validateExcalidrawElements } from '../app/lib/excalidraw-collaboration/scene';
import type { ExcalidrawElementRecord } from '../app/lib/excalidraw-collaboration/protocol';

// Pure values and owned typed arrays only. No SQL, filesystem, asset loader or
// publication capability is substituted or claimed by these codec tests.
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const element = (extra: Record<string, unknown> = {}): ExcalidrawElementRecord => ({
  id: 'rectangle', type: 'rectangle', version: 1, versionNonce: 9, isDeleted: false, ...extra,
});
function portableSource(elements: ExcalidrawElementRecord[], assets: readonly Asset[] = []): Source {
  validateExcalidrawElements(elements, 'scene');
  const appState = {}, metadata = assets.map(asset => asset.metadata);
  return { elements, appState, assets: metadata, canonicalHash: canonicalSceneHash({ elements, appState, assets: metadata }) };
}
function asset(fileId: string, bytes: Uint8Array, mimeType = 'image/png'): Asset {
  return { metadata: { fileId, contentHash: hash(bytes), mimeType, sizeBytes: bytes.byteLength,
    createdAt: 123, version: 2 }, bytes };
}
/** The old checkpoint's JSON.stringify envelope, using explicit test bytes in
 * place of its IO loader. Deliberately does not call the new serializer. */
function legacyPortable(source: Source, assets: readonly Asset[]): string {
  const files: Record<string, unknown> = {};
  for (const metadata of source.assets) {
    const supplied = assets.find(value => value.metadata.fileId === metadata.fileId); assert(supplied);
    files[metadata.fileId] = { id: metadata.fileId, mimeType: metadata.mimeType,
      dataURL: `data:${metadata.mimeType};base64,${Buffer.from(supplied.bytes).toString('base64')}`,
      created: metadata.createdAt, lastRetrieved: metadata.createdAt, version: metadata.version };
  }
  return JSON.stringify({ type: 'excalidraw', version: 2, source: EXCALIDRAW_FILE_SOURCE,
    elements: source.elements, appState: source.appState, files }, null, 2);
}
/** Independent traversal of the actual test data: one JSON value is one node;
 * object keys are not values. It does not use any production size counter. */
function countJsonNodes(value: unknown): number {
  let nodes = 0; const pending: unknown[] = [value];
  while (pending.length) {
    const next = pending.pop(); nodes++;
    if (Array.isArray(next)) { for (const child of next) pending.push(child); }
    else if (next && typeof next === 'object') { for (const child of Object.values(next)) pending.push(child); }
  }
  return nodes;
}
function boundarySource(nodeLimit: number): Source {
  const rows: number[][] = [], elements = [element({ customData: { rows } })];
  const skeleton = { elements, appState: {}, assets: [], canonicalHash: '' };
  let remaining = nodeLimit - countJsonNodes(skeleton);
  while (remaining > 0) {
    const size = Math.min(99_999, remaining - 1); rows.push(Array<number>(size).fill(0)); remaining -= size + 1;
  }
  assert(rows.every(row => row.length < 100_000));
  const source = portableSource(elements); assert.equal(countJsonNodes(source), nodeLimit); return source;
}
const serializationFailure = (error: unknown) => error instanceof ExcalidrawPortableSerializationError
  && error.code === 'EXCALIDRAW_PORTABLE_TOO_LARGE' && error.status === 413;

/** Guards prevent the forbidden allocations even on the old implementation.
 * All assertions run after restoration, so a regression is reported normally. */
function observePreflight(t: TestContext, action: () => unknown, mode: 'encoded' | 'output') {
  const calls = { forbiddenStringify: 0, byteCopy: 0, base64: 0, clone: 0 };
  const stringify = JSON.stringify, toString = Buffer.prototype.toString;
  let error: unknown;
  try {
    t.mock.method(JSON, 'stringify', (...args: unknown[]) => {
      if (args[2] === 2 || mode === 'encoded' && args[0] !== null && typeof args[0] === 'object') {
        calls.forbiddenStringify++; throw new Error('Portable preflight must precede this JSON allocation.');
      }
      return Reflect.apply(stringify, JSON, args);
    });
    t.mock.method(Uint8Array.prototype, 'set', () => { calls.byteCopy++; throw new Error('Unexpected asset byte copy.'); });
    t.mock.method(Buffer.prototype, 'toString', function (this: Buffer, ...args: unknown[]) {
      if (args[0] === 'base64') { calls.base64++; throw new Error('Unexpected asset base64 allocation.'); }
      return Reflect.apply(toString, this, args);
    });
    if (mode === 'encoded') t.mock.method(globalThis, 'structuredClone', () => {
      calls.clone++; throw new Error('Encoded budget must be checked before scene clone.');
    });
    action();
  } catch (caught) { error = caught; }
  finally { t.mock.restoreAll(); }
  return { error, calls };
}

test('portable output preserves legacy bytes, element/key order, Unicode/escapes and metadata asset order', () => {
  const png = asset('z_png', new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')));
  const svg = asset('a_svg', new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'image/svg+xml');
  const values: unknown[] = ['äö — 日本 🦊 𝄞 \u2028\u2029', '\0\u0001\b\t\n\f\r"\\', '\ud800X\udfff',
    { z: [[], {}, [null, true, false, -0, 1.5]], a: { empty: {} } }];
  for (const value of values) {
    const source = portableSource([element({ customData: { z: value, a: [] } }),
      element({ id: 'image_z', type: 'image', fileId: png.metadata.fileId }),
      element({ id: 'image_a', type: 'image', fileId: svg.metadata.fileId })], [png, svg]);
    const supplied = [svg, png], expected = legacyPortable(source, supplied), actual = serialize(source, supplied);
    assert.equal(actual, expected); assert.deepEqual(Buffer.from(actual), Buffer.from(expected));
    const parsed = JSON.parse(actual) as { files: Record<string, unknown>; elements: ExcalidrawElementRecord[] };
    assert.deepEqual(Object.keys(parsed.files), ['z_png', 'a_svg']);
    assert.deepEqual(parsed.elements.map(record => record.id), ['rectangle', 'image_z', 'image_a']);
    assert.deepEqual(Object.keys(parsed.elements[0].customData as object), ['z', 'a']);
  }
});

test('9 MiB of NUL exceeds the encoded budget before scene clone, object stringify or asset byte copy', t => {
  const bytes = asset('small_asset', new Uint8Array([1])), nul = '\0'.repeat(9 * 1024 * 1024);
  // A proof cannot be reached for an oversized input. Use a structurally valid
  // digest and require the budget to win before hashing or copying the scene.
  const source: Source = { elements: [element({ customData: { nul } })], appState: {},
    assets: [bytes.metadata], canonicalHash: '0'.repeat(64) };
  assert(Buffer.byteLength(nul) < EXCALIDRAW_PORTABLE_MAX_BYTES);
  assert(nul.length * Buffer.byteLength('\\u0000') > EXCALIDRAW_PORTABLE_MAX_BYTES);
  const result = observePreflight(t, () => serialize(source, [bytes]), 'encoded');
  assert(serializationFailure(result.error));
  assert.deepEqual(result.calls, { forbiddenStringify: 0, byteCopy: 0, base64: 0, clone: 0 });
});

test('pretty indentation and base64 overflow are rejected before reading or copying supplied asset bytes', t => {
  const small = asset('small_asset', new Uint8Array([1]));
  const nestedRows = (width: number) => {
    let value: Record<string, unknown> = { rows: Array.from({ length: 10 }, () => Array<number>(width).fill(0)) };
    for (let depth = 0; depth < 26; depth++) value = { next: value };
    return value;
  };
  // Measure actual legacy JSON at widths 1/2/3. Each additional numeric value
  // adds the same newline/indent/comma bytes, without constructing >50 MiB JSON.
  const smallSizes = [1, 2, 3].map(width => Buffer.byteLength(legacyPortable(
    portableSource([element({ customData: nestedRows(width) })], [small]), [small])));
  assert.equal(smallSizes[2] - smallSizes[1], smallSizes[1] - smallSizes[0]);
  const width = 90_000, expectedPrettyBytes = smallSizes[0] + (width - 1) * (smallSizes[1] - smallSizes[0]);
  const source = portableSource([element({ customData: nestedRows(width) })], [small]);
  assert(countJsonNodes(source) < 2_000_000);
  assert(Buffer.byteLength(JSON.stringify(source)) < EXCALIDRAW_PORTABLE_MAX_BYTES);
  assert(expectedPrettyBytes > EXCALIDRAW_PORTABLE_MAX_BYTES);
  const pretty = observePreflight(t, () => serialize(source, [small]), 'output');
  assert(serializationFailure(pretty.error));
  assert.deepEqual(pretty.calls, { forbiddenStringify: 0, byteCopy: 0, base64: 0, clone: 0 });

  // Two legitimate 20 MiB asset references share a real owned zero buffer.
  // Their metadata hashes are correct; only the portable base64 budget fails.
  const zeros = new Uint8Array(20 * 1024 * 1024), first = asset('first', zeros), second = asset('second', zeros);
  const assets = [first, second], imageSource = portableSource(assets.map((value, index) =>
    element({ id: `image_${index}`, type: 'image', fileId: value.metadata.fileId })), assets);
  assert(assets.reduce((total, value) => total + Math.ceil(value.metadata.sizeBytes / 3) * 4, 0) > EXCALIDRAW_PORTABLE_MAX_BYTES);
  const base64 = observePreflight(t, () => serialize(imageSource, assets), 'output');
  assert(serializationFailure(base64.error));
  assert.deepEqual(base64.calls, { forbiddenStringify: 0, byteCopy: 0, base64: 0, clone: 0 });
});

test('a valid source at exactly 2,000,000 JSON nodes remains valid when the portable envelope adds two nodes', () => {
  const source = boundarySource(2_000_000), sourceNodes = countJsonNodes(source);
  const envelope = { type: 'excalidraw', version: 2, source: EXCALIDRAW_FILE_SOURCE,
    elements: source.elements, appState: source.appState, files: {} };
  assert.equal(countJsonNodes(envelope), sourceNodes + 2);
  const output = serialize(source, []);
  assert(Buffer.byteLength(output) < EXCALIDRAW_PORTABLE_MAX_BYTES);
  assert.equal(countJsonNodes(JSON.parse(output)), sourceNodes + 2);
});

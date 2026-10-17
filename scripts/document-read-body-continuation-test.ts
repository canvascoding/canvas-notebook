import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { authoritativeNativeCollaborationSnapshot, inspectNativeDocument } from '../app/lib/collaboration/document-snapshot';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { NativeDocumentReadObservation } from '../app/lib/collaboration/native-document-read';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { DocumentReadError } from '../app/lib/documents/contracts';
import { encodeDocumentReadBodyV1, MAX_DOCUMENT_READ_BODY_BYTES } from '../app/lib/documents/read-body';
import { decodeDocumentReadContinuationV1, encodeDocumentReadContinuationV1,
  type DocumentReadContinuationBindingV1 } from '../app/lib/documents/read-continuation';
import { documentMetadataVersionV1, documentVersionV1 } from '../app/lib/documents/read-version';
import { sliceDocumentUtf8PageV1 } from '../app/lib/documents/utf8-page';

function observationFor(doc: Y.Doc, representation: PersistedCollaborationState['representation'], durableDoc = doc): NativeDocumentReadObservation {
  const state: PersistedCollaborationState = {
    documentId: 'body-document', workspaceId: 'body-workspace', organizationId: null, path: 'native.bin',
    representation, lifecycleGeneration: 1, schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(durableDoc), stateVector: Y.encodeStateVector(durableDoc),
    documentSequence: 7, checkpointSequence: 0, persistedAt: 100, checkpointedAt: null,
    canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active',
  };
  const { version, content: _content, source: _source, ...snapshot } = authoritativeNativeCollaborationSnapshot(state);
  const observed = inspectNativeDocument(doc, representation);
  const durable = observed.version.stateProof === version.stateProof;
  return {
    identity: { documentId: state.documentId, lineageId: 'body-lineage', workspaceId: state.workspaceId,
      organizationId: null, path: state.path, lifecycleGeneration: 1, representation, schemaVersion: 1 },
    native: { ...snapshot, source: durable ? 'persisted_yjs' : 'live_yjs',
      observed: { ...observed.version, content: observed.content, durable }, durable: version },
    metadata: { title: null, revision: null },
  };
}

function code(expected: string): (error: unknown) => boolean {
  return error => error instanceof DocumentReadError && error.code === expected;
}

const decodeBytes = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

function bindingFor(observation: NativeDocumentReadObservation, format: DocumentReadContinuationBindingV1['format']): DocumentReadContinuationBindingV1 {
  const identity = { workspaceId: observation.identity.workspaceId, organizationId: observation.identity.organizationId,
    documentId: observation.identity.documentId, lineageId: observation.identity.lineageId,
    lifecycleGeneration: observation.identity.lifecycleGeneration, representation: observation.identity.representation,
    schemaVersion: observation.identity.schemaVersion };
  const body = encodeDocumentReadBodyV1(observation, format);
  return { authorityScopeSha256: digest('actual test origin comparison scope'), identitySha256: digest(JSON.stringify(identity)),
    lifecycleGeneration: identity.lifecycleGeneration, contentVersion: documentVersionV1(identity, observation.native.observed.stateProof),
    metadataVersion: documentMetadataVersionV1(identity, { path: observation.identity.path, title: 'Native', metadataRevision: null }),
    format, totalBytes: body.totalBytes, bodySha256: body.bodySha256 };
}

test('all body formats read the observed live plain text rather than the older durable body', () => {
  const durable = createPlainTextYDoc('older durable text');
  const live = new Y.Doc();
  try {
    Y.applyUpdate(live, Y.encodeStateAsUpdate(durable));
    live.getText('content').insert(live.getText('content').length, ' + current 🦊');
    const observation = observationFor(live, 'plain_text', durable);
    const before = JSON.stringify(observation);
    assert.equal(observation.native.source, 'live_yjs');
    for (const format of ['native', 'text', 'markdown'] as const) {
      const body = encodeDocumentReadBodyV1(observation, format);
      const serialized = decodeBytes(body.bytes);
      assert.equal(body.totalBytes, Buffer.byteLength(serialized));
      assert.equal(body.bodySha256, digest(body.bytes));
      if (format === 'native') assert.deepEqual(JSON.parse(serialized), { bodyVersion: 1, representation: 'plain_text',
        content: { kind: 'plain_text', text: 'older durable text + current 🦊' } });
      else assert.equal(serialized, 'older durable text + current 🦊');
    }
    assert.equal(JSON.stringify(observation), before);
  } finally { live.destroy(); durable.destroy(); }
});

test('rich native and semantic reads survive explicitly unavailable lossless Markdown export', () => {
  const doc = createRichMarkdownYDoc('| Keep |\n| --- |\n| [Target](target.md) |', 'tiptap_blocks');
  try {
    const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
    for (const record of tree.records.values()) {
      if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
        (record.get('attributes') as Y.Map<unknown>).set('colwidth', [120]);
      }
    }
    tree.read().check();
    assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
    const observation = observationFor(doc, 'tiptap_blocks');
    const before = JSON.stringify(observation);
    const native = JSON.parse(decodeBytes(encodeDocumentReadBodyV1(observation, 'native').bytes));
    assert.equal(native.representation, 'tiptap_blocks');
    assert.match(JSON.stringify(native.content.document), /"colwidth":\[120\]/u);
    assert.match(decodeBytes(encodeDocumentReadBodyV1(observation, 'text').bytes), /Keep[\s\S]*Target/u);
    assert.throws(() => encodeDocumentReadBodyV1(observation, 'markdown'), code('DOCUMENT_FORMAT_UNAVAILABLE'));
    assert.equal(JSON.stringify(observation), before);
    assert.match(decodeBytes(encodeDocumentReadBodyV1(observation, 'text').bytes), /Target/u);
  } finally { doc.destroy(); }
});

test('explicit rich Markdown export preserves frontmatter and original final line endings', () => {
  for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
    const doc = createRichMarkdownYDoc('---\ntitle: Beispiel\n---\n# Heading\n\nText **bold**.\r\n\r\n', representation);
    try {
      const observation = observationFor(doc, representation);
      const markdown = decodeBytes(encodeDocumentReadBodyV1(observation, 'markdown').bytes);
      assert.ok(markdown.startsWith('---\ntitle: Beispiel\n---\n# Heading'));
      assert.ok(markdown.endsWith('\r\n\r\n'));
      assert.match(markdown, /Text \*\*bold\*\*\./u);
      assert.match(decodeBytes(encodeDocumentReadBodyV1(observation, 'text').bytes), /Heading[\s\S]*Text bold\./u);
    } finally { doc.destroy(); }
  }
});

test('large observed content stays complete across UTF-8 pages and comparison cursors', () => {
  const text = '\uFEFFÜberblick 🦊 日本語 e\u0301\r\n'.repeat(32_000);
  const doc = createPlainTextYDoc(text);
  try {
    const observation = observationFor(doc, 'plain_text');
    for (const format of ['native', 'text', 'markdown'] as const) {
      const body = encodeDocumentReadBodyV1(observation, format);
      const binding = bindingFor(observation, format);
      const fragments: string[] = [];
      let cursor: string | undefined;
      do {
        const offset = cursor ? decodeDocumentReadContinuationV1(cursor, binding) : 0;
        const page = sliceDocumentUtf8PageV1(body.bytes, offset, 65_537);
        fragments.push(page.fragment);
        cursor = page.nextOffset === null ? undefined : encodeDocumentReadContinuationV1(binding, page.nextOffset);
        if (page.complete) break;
      } while (cursor);
      const complete = fragments.join('');
      assert.equal(complete, decodeBytes(body.bytes));
      if (format === 'native') assert.equal(JSON.parse(complete).content.text, text);
      else assert.equal(complete, text);
    }
  } finally { doc.destroy(); }
});

test('body budget rejects oversized text explicitly before allocating its UTF-8 buffer', () => {
  const doc = createPlainTextYDoc('short');
  try {
    const observation = observationFor(doc, 'plain_text');
    const oversized = { ...observation, native: { ...observation.native, observed: { ...observation.native.observed,
      content: { kind: 'plain_text' as const, text: 'a'.repeat(MAX_DOCUMENT_READ_BODY_BYTES + 1) } } } };
    assert.throws(() => encodeDocumentReadBodyV1(oversized, 'text'), code('DOCUMENT_TOO_LARGE'));
  } finally { doc.destroy(); }
});

test('native JSON retains isolated UTF-16 units and text exports refuse silent replacement', () => {
  const doc = createPlainTextYDoc('short');
  try {
    const observation = observationFor(doc, 'plain_text');
    const withSurrogate = { ...observation, native: { ...observation.native, observed: { ...observation.native.observed,
      content: { kind: 'plain_text' as const, text: 'A\ud800B' } } } };
    assert.equal(JSON.parse(decodeBytes(encodeDocumentReadBodyV1(withSurrogate, 'native').bytes)).content.text, 'A\ud800B');
    assert.throws(() => encodeDocumentReadBodyV1(withSurrogate, 'text'), code('DOCUMENT_FORMAT_UNAVAILABLE'));
    assert.throws(() => encodeDocumentReadBodyV1(withSurrogate, 'markdown'), code('DOCUMENT_FORMAT_UNAVAILABLE'));
  } finally { doc.destroy(); }
});

test('cursor binding distinguishes genuine origin/identity drift from content and format drift', () => {
  const doc = createPlainTextYDoc('enough bytes for another page 🦊');
  try {
    const binding = bindingFor(observationFor(doc, 'plain_text'), 'text');
    const cursor = encodeDocumentReadContinuationV1(binding, 4);
    assert.equal(decodeDocumentReadContinuationV1(cursor, binding), 4);
    for (const change of [{ authorityScopeSha256: digest('other origin') }, { identitySha256: digest('other document or lineage') },
      { lifecycleGeneration: 2 }]) {
      assert.throws(() => decodeDocumentReadContinuationV1(cursor, { ...binding, ...change }), code('DOCUMENT_SCOPE_CHANGED'));
    }
    for (const change of [{ contentVersion: `canvas-document-v1:${'b'.repeat(64)}` },
      { metadataVersion: `canvas-document-metadata-v1:${'b'.repeat(64)}` }, { format: 'native' as const },
      { totalBytes: binding.totalBytes + 1 }, { bodySha256: digest('same length but changed encoded body') }]) {
      assert.throws(() => decodeDocumentReadContinuationV1(cursor, { ...binding, ...change }), code('DOCUMENT_VERSION_CONFLICT'));
    }
  } finally { doc.destroy(); }
});

test('cursor inputs reject getters, prototypes, unexpected fields and invalid hashes without getter execution', () => {
  const doc = createPlainTextYDoc('continuation text');
  try {
    const binding = bindingFor(observationFor(doc, 'plain_text'), 'text');
    let getterCalls = 0;
    const getter = { ...binding };
    Object.defineProperty(getter, 'contentVersion', { enumerable: true, get() { getterCalls++; return binding.contentVersion; } });
    for (const value of [getter, Object.assign(Object.create({}), binding), Object.assign(Object.create(null), binding),
      { ...binding, unexpected: true }, { ...binding, [Symbol('extra')]: true }, { ...binding, identitySha256: 'not a hash' }]) {
      assert.throws(() => encodeDocumentReadContinuationV1(value, 4), code('INVALID_REQUEST'));
    }
    assert.equal(getterCalls, 0);
    for (const offset of [0, -1, 1.5, binding.totalBytes, binding.totalBytes + 1]) {
      assert.throws(() => encodeDocumentReadContinuationV1(binding, offset), code('INVALID_REQUEST'));
    }
  } finally { doc.destroy(); }
});

test('cursor decoding enforces canonical base64url, exact JSON purpose/version/keys and bounds', () => {
  const doc = createPlainTextYDoc('continuation text');
  try {
    const binding = bindingFor(observationFor(doc, 'plain_text'), 'text');
    const cursor = encodeDocumentReadContinuationV1(binding, 4);
    const original = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(original) as Record<string, unknown>;
    const wire = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const value of ['', cursor + '=', ' ' + cursor, 'x'.repeat(4097),
      Buffer.from(' ' + original).toString('base64url'),
      Buffer.from(original.replace('"cursorVersion":1', '"cursorVersion":1,"cursorVersion":1')).toString('base64url'),
      wire({ ...parsed, purpose: 'canvas.search.v1' }), wire({ ...parsed, cursorVersion: 2 }),
      wire({ ...parsed, unexpected: true }), wire({ ...parsed, byteOffset: 0 }),
      wire({ ...parsed, byteOffset: binding.totalBytes }), wire({ ...parsed, byteOffset: 1.5 }),
      wire({ ...parsed, identitySha256: null })]) {
      assert.throws(() => decodeDocumentReadContinuationV1(value, binding), code('INVALID_REQUEST'));
    }
  } finally { doc.destroy(); }
});

test('a comparison cursor cannot bypass the UTF-8 codepoint guard used by the service', () => {
  const doc = createPlainTextYDoc('😀A');
  try {
    const observation = observationFor(doc, 'plain_text');
    const body = encodeDocumentReadBodyV1(observation, 'text');
    const binding = bindingFor(observation, 'text');
    const cursor = encodeDocumentReadContinuationV1(binding, 1);
    const offset = decodeDocumentReadContinuationV1(cursor, binding);
    assert.throws(() => sliceDocumentUtf8PageV1(body.bytes, offset, 4), code('INVALID_REQUEST'));
  } finally { doc.destroy(); }
});

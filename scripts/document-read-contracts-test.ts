import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { decodeDocumentReadRequestV1, DocumentReadError, isDocumentVersionTokenV1,
  MAX_DOCUMENT_READ_PAGE_BYTES } from '../app/lib/documents/contracts';
import { documentMetadataVersionV1, documentVersionV1, type DocumentVersionIdentityV1 } from '../app/lib/documents/read-version';
import { sliceDocumentUtf8PageV1 } from '../app/lib/documents/utf8-page';

const identity: DocumentVersionIdentityV1 = {
  workspaceId: 'workspace-one', organizationId: null, documentId: 'document-one', lineageId: 'lineage-one',
  lifecycleGeneration: 1, representation: 'plain_text', schemaVersion: 1,
};
const proof = `yjs-snapshot-sha256-v1:${'a'.repeat(64)}`;
const request = { apiVersion: 1, workspaceId: identity.workspaceId, documentId: identity.documentId };
const invalidRequest = (error: unknown): boolean => error instanceof DocumentReadError
  && error.code === 'INVALID_REQUEST' && error.status === 400;

test('read selection defaults are immutable and explicit versions/formats survive exactly', () => {
  const decoded = decodeDocumentReadRequestV1(request);
  assert.deepEqual(decoded, { ...request, format: 'native', maxBytes: 64 * 1024 });
  assert.equal(Object.isFrozen(decoded), true);
  const expectedVersion = documentVersionV1(identity, proof);
  for (const format of ['native', 'text', 'markdown']) {
    assert.deepEqual(decodeDocumentReadRequestV1({ ...request, format, expectedVersion, maxBytes: 4, cursor: 'opaque-cursor' }),
      { ...request, format, expectedVersion, maxBytes: 4, cursor: 'opaque-cursor' });
  }
  assert.deepEqual(request, { apiVersion: 1, workspaceId: 'workspace-one', documentId: 'document-one' });
});

test('read decoder refuses getters, inherited identities, symbols, hidden and extra fields without reading getters', () => {
  let getterCalls = 0;
  const inherited = Object.create({ get documentId() { getterCalls++; return identity.documentId; } });
  Object.assign(inherited, { apiVersion: 1, workspaceId: identity.workspaceId });
  const getter = { ...request };
  Object.defineProperty(getter, 'documentId', { enumerable: true, get() { getterCalls++; return identity.documentId; } });
  const extraGetter = { ...request };
  Object.defineProperty(extraGetter, 'unexpected', { enumerable: true, get() { getterCalls++; return true; } });
  const hidden = { ...request };
  Object.defineProperty(hidden, 'documentId', { value: identity.documentId, enumerable: false });
  for (const value of [getter, extraGetter, inherited, hidden, Object.assign(Object.create(null), request),
    { ...request, [Symbol('private')]: true }, { ...request, unexpected: true }, [], null, () => request]) {
    assert.throws(() => decodeDocumentReadRequestV1(value), invalidRequest);
  }
  assert.equal(getterCalls, 0);
});

test('read decoder rejects invalid IDs, versions, cursors, formats and byte budgets', () => {
  for (const change of [{ apiVersion: 2 }, { documentId: ' document-one' }, { documentId: '' }, { workspaceId: 'x\0y' },
    { documentId: 'x'.repeat(257) }, { format: 'html' }, { format: undefined }, { maxBytes: 3 },
    { maxBytes: MAX_DOCUMENT_READ_PAGE_BYTES + 1 }, { maxBytes: 4.5 }, { maxBytes: NaN }, { maxBytes: undefined },
    { expectedVersion: proof }, { expectedVersion: undefined }, { cursor: '' }, { cursor: undefined },
    { cursor: 'cursor\n' }, { cursor: 'x'.repeat(4097) }]) {
    assert.throws(() => decodeDocumentReadRequestV1({ ...request, ...change }), invalidRequest);
  }
});

test('actual Yjs deletion changes the content version while its state vector stays equal', () => {
  const doc = new Y.Doc();
  try {
    doc.getText('content').insert(0, 'Keep A and B');
    const beforeVector = Y.encodeStateVector(doc);
    const beforeProof = collaborationStateProof(doc, Y);
    assert.ok(beforeProof);
    const before = documentVersionV1(identity, beforeProof);
    doc.getText('content').delete(5, 2);
    const afterProof = collaborationStateProof(doc, Y);
    assert.ok(afterProof);
    assert.deepEqual(Y.encodeStateVector(doc), beforeVector);
    assert.notEqual(afterProof, beforeProof);
    assert.notEqual(documentVersionV1(identity, afterProof), before);
    assert.equal(isDocumentVersionTokenV1(before), true);
  } finally { doc.destroy(); }
});

test('content versions bind workspace, organization, document, lineage, generation, representation and schema', () => {
  const original = documentVersionV1(identity, proof);
  for (const change of [{ workspaceId: 'workspace-two' }, { organizationId: 'organization-two' },
    { documentId: 'document-two' }, { lineageId: 'lineage-two' }, { lifecycleGeneration: 2 },
    { representation: 'tiptap_xml' as const }, { schemaVersion: 2 }]) {
    assert.notEqual(documentVersionV1({ ...identity, ...change }, proof), original);
  }
  for (const change of [{ documentId: '' }, { lineageId: ' lineage-one' }, { organizationId: undefined },
    { lifecycleGeneration: 0 }, { schemaVersion: 0 }, { representation: 'unknown' }]) {
    assert.throws(() => documentVersionV1({ ...identity, ...change } as DocumentVersionIdentityV1, proof), invalidRequest);
  }
  for (const value of ['', 'AA==', `yjs-snapshot-sha256-v1:${'a'.repeat(63)}`, `yjs-snapshot-sha256-v1:${'A'.repeat(64)}`]) {
    assert.throws(() => documentVersionV1(identity, value), invalidRequest);
  }
});

test('rename and shared title revisions change metadata evidence independently of content', () => {
  const contentVersion = documentVersionV1(identity, proof);
  const original = { path: 'notes/first.md', title: 'First title', metadataRevision: 100 };
  const metadataVersion = documentMetadataVersionV1(identity, original);
  for (const change of [{ path: 'renamed/native.bin' }, { title: 'Neuer Titel' }, { metadataRevision: 101 },
    { metadataRevision: null }]) {
    assert.notEqual(documentMetadataVersionV1(identity, { ...original, ...change }), metadataVersion);
    assert.equal(documentVersionV1(identity, proof), contentVersion);
  }
  assert.notEqual(documentMetadataVersionV1({ ...identity, documentId: 'replacement-at-old-path' }, original), metadataVersion);
  assert.notEqual(documentMetadataVersionV1({ ...identity, lineageId: 'new-lineage' }, original), metadataVersion);
  for (const change of [{ path: '../escaped.md' }, { path: '/absolute.md' }, { metadataRevision: -1 },
    { metadataRevision: 1.5 }, { metadataRevision: undefined }]) {
    assert.throws(() => documentMetadataVersionV1(identity, { ...original, ...change } as typeof original), invalidRequest);
  }
});

test('version inputs reject accessor and prototype substitutions without getter execution', () => {
  let getterCalls = 0;
  const getterIdentity = { ...identity };
  Object.defineProperty(getterIdentity, 'documentId', { enumerable: true, get() { getterCalls++; return identity.documentId; } });
  assert.throws(() => documentVersionV1(getterIdentity, proof), invalidRequest);
  assert.throws(() => documentVersionV1(Object.assign(Object.create({}), identity), proof), invalidRequest);
  const metadata = { path: 'note.md', title: 'Title', metadataRevision: 100 };
  Object.defineProperty(metadata, 'title', { enumerable: true, get() { getterCalls++; return 'Title'; } });
  assert.throws(() => documentMetadataVersionV1(identity, metadata), invalidRequest);
  assert.equal(getterCalls, 0);
});

test('large Unicode and native JSON pages reassemble completely with exact UTF-8 offsets', () => {
  const text = '\uFEFFFrühstück 🦊 / 日本語 / e\u0301 / \r\n'.repeat(40_000);
  for (const input of [text, JSON.stringify({ kind: 'plain_text', text })]) {
    const bytes = new TextEncoder().encode(input);
    const fragments: string[] = [];
    let offset = 0;
    do {
      const page = sliceDocumentUtf8PageV1(bytes, offset, 65_537);
      assert.equal(page.byteOffset, offset);
      assert.equal(page.totalBytes, bytes.byteLength);
      assert.equal(new TextEncoder().encode(page.fragment).byteLength, page.byteLength);
      assert.ok(page.byteLength <= 65_537);
      fragments.push(page.fragment);
      offset += page.byteLength;
      assert.equal(page.nextOffset, page.complete ? null : offset);
      if (page.complete) break;
      assert.ok(page.byteLength > 0);
    } while (offset < bytes.byteLength);
    assert.equal(offset, bytes.byteLength);
    assert.equal(fragments.join(''), input);
  }
});

test('tiny pages preserve four-byte characters and reject offsets inside any codepoint', () => {
  const bytes = new TextEncoder().encode('A😀ä中Z');
  const expectedOffsets = [0, 1, 5, 7, 10, 11];
  for (let offset = 0; offset <= bytes.byteLength; offset++) {
    if (!expectedOffsets.includes(offset)) {
      assert.throws(() => sliceDocumentUtf8PageV1(bytes, offset, 4), invalidRequest);
    } else {
      const page = sliceDocumentUtf8PageV1(bytes, offset, 4);
      assert.equal(page.byteOffset, offset);
      assert.ok(expectedOffsets.includes(offset + page.byteLength));
      assert.equal(new TextEncoder().encode(page.fragment).byteLength, page.byteLength);
    }
  }
  assert.deepEqual(sliceDocumentUtf8PageV1(new Uint8Array()),
    { fragment: '', byteOffset: 0, byteLength: 0, totalBytes: 0, nextOffset: null, complete: true });
  assert.deepEqual(sliceDocumentUtf8PageV1(bytes, bytes.byteLength, 4),
    { fragment: '', byteOffset: bytes.byteLength, byteLength: 0, totalBytes: bytes.byteLength, nextOffset: null, complete: true });
  assert.throws(() => sliceDocumentUtf8PageV1(bytes, -1), invalidRequest);
  assert.throws(() => sliceDocumentUtf8PageV1(bytes, bytes.byteLength + 1), invalidRequest);
  assert.throws(() => sliceDocumentUtf8PageV1(bytes, 0.5), invalidRequest);
  assert.throws(() => sliceDocumentUtf8PageV1(bytes, 0, 3), invalidRequest);
  assert.throws(() => sliceDocumentUtf8PageV1(bytes, 0, MAX_DOCUMENT_READ_PAGE_BYTES + 1), invalidRequest);
  assert.throws(() => sliceDocumentUtf8PageV1(new Uint8Array([0xff])), invalidRequest);
  assert.throws(() => sliceDocumentUtf8PageV1(new Uint8Array([0xf0, 0x9f])), invalidRequest);
  assert.throws(() => sliceDocumentUtf8PageV1(new Uint8Array([0xf0, 0x80, 0x80, 0x80, 0x80]), 0, 4), invalidRequest);
});

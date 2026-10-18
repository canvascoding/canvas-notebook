import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getSchema, type JSONContent } from '@tiptap/core';
import type * as YTypes from 'yjs';
import { Y } from '../app/lib/collaboration/server-runtime';
import { CollaborationBlockTree, BLOCK_TREE_KEY } from '../app/lib/collaboration/block-tree';
import { readAgentBlockStructure } from '../app/lib/collaboration/agent-block-structure';
import type { BlockPlacementOperation } from '../app/lib/collaboration/block-tree-placement';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions,
  validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { authoritativeNativeCollaborationSnapshot, inspectNativeDocument } from '../app/lib/collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { NativeDocumentReadObservation } from '../app/lib/collaboration/native-document-read';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { assertNativeDocumentWithinReadBudget } from '../app/lib/collaboration/native-search-budget';
import { assertNativeDocumentEditTargetStorageBudget, captureNativeDocumentEditTargets,
  nativeDocumentEditTargetsReadBudget, MAX_NATIVE_DOCUMENT_EDIT_TARGETS,
  MAX_NATIVE_DOCUMENT_EDIT_TARGET_BYTES } from '../app/lib/collaboration/native-document-edit-targets';
import { decodeDocumentReadRequestV1, DocumentReadError } from '../app/lib/documents/contracts';
import { encodeDocumentReadBodyV1 } from '../app/lib/documents/read-body';
import { documentMetadataVersionV1, documentVersionV1 } from '../app/lib/documents/read-version';
import { encodeDocumentReadContinuationV1, decodeDocumentReadContinuationV1,
  type DocumentReadContinuationBindingV1 } from '../app/lib/documents/read-continuation';
import { sliceDocumentUtf8PageV1 } from '../app/lib/documents/utf8-page';
import { decodePiDocumentReadSelection, piDocumentReadParameters } from '../app/lib/pi/document-read-tool-contract';
import { decodeDirectMcpDocumentReadSelection, DIRECT_MCP_NATIVE_DOCUMENT_READ_PROPERTIES } from '../app/lib/mcp/server/document-read-tool-contract';
import { nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';

// Pure native fixture, byte encoder, guard and transport-selection regressions.
// There is no Principal, DB, room server, disk projection or confirmed mutation
// status here. The persisted metadata below only arranges the pure read encoder.
const schema = getSchema(richMarkdownSchemaExtensions());
const selection = { apiVersion: 1, workspaceId: 'targets-workspace', documentId: 'targets-document' } as const;
const piSelection = { workspaceId: selection.workspaceId, documentId: selection.documentId };
const mcpSelection = { workspace_id: selection.workspaceId, document_id: selection.documentId };
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown): boolean => {
  assert(error instanceof DocumentReadError); assert.equal(error.code, expected); return true;
};
let groups = 0;
function check(name: string, action: () => void): void {
  action(); groups++; console.log('PASS native document edit targets:', name);
}
function blockDoc(content: JSONContent[]): YTypes.Doc {
  const doc = new Y.Doc({ gc: false });
  try { CollaborationBlockTree.create(doc, schema.nodeFromJSON({ type: 'doc', content })); return doc; }
  catch (error) { doc.destroy(); throw error; }
}
function paragraph(id: string, text = ''): JSONContent {
  return { type: 'paragraph', attrs: { id }, ...(text ? { content: [{ type: 'text', text }] } : {}) };
}
function inspect(doc: YTypes.Doc) { return inspectNativeDocument(doc, 'tiptap_blocks'); }
function sourceReceipt(doc: YTypes.Doc) {
  const root = doc.getMap(BLOCK_TREE_KEY);
  return { update: Y.encodeStateAsUpdate(doc), vector: Y.encodeStateVector(doc), proof: collaborationStateProof(doc, Y),
    roots: Array.from(doc.share.entries()), rootEntries: Array.from(root.entries()),
    records: root.get('records'), operations: root.get('operations'), receipts: root.get('receipts') };
}
function assertSource(doc: YTypes.Doc, before: ReturnType<typeof sourceReceipt>): void {
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before.update);
  assert.deepEqual(Y.encodeStateVector(doc), before.vector);
  assert.equal(collaborationStateProof(doc, Y), before.proof);
  assert.deepEqual(Array.from(doc.share.keys()), before.roots.map(([key]) => key));
  for (const [key, value] of before.roots) assert.equal(doc.share.get(key), value, `root ${key} retains its actual type reference`);
  const root = doc.getMap(BLOCK_TREE_KEY);
  assert.deepEqual(Array.from(root.keys()), before.rootEntries.map(([key]) => key));
  for (const [key, value] of before.rootEntries) assert.equal(root.get(key), value);
  assert.equal(root.get('records'), before.records); assert.equal(root.get('operations'), before.operations);
  assert.equal(root.get('receipts'), before.receipts);
}
function unchanged<T>(doc: YTypes.Doc, operation: () => T): T {
  const before = sourceReceipt(doc); let updates = 0;
  const changed = () => { updates++; }; doc.on('update', changed);
  try { return operation(); }
  finally { doc.off('update', changed); assert.equal(updates, 0); assertSource(doc, before); }
}
function capture(doc: YTypes.Doc) {
  const current = inspect(doc);
  return unchanged(doc, () => captureNativeDocumentEditTargets(doc, current.content, current.version.stateProof));
}
function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert(Object.isFrozen(value)); for (const child of Object.values(value)) frozen(child);
}
function observation(doc: YTypes.Doc, representation: PersistedCollaborationState['representation'] = 'tiptap_blocks',
  durableDoc = doc): NativeDocumentReadObservation {
  const state: PersistedCollaborationState = { documentId: selection.documentId, workspaceId: selection.workspaceId,
    organizationId: null, path: 'native-only.bin', representation, lifecycleGeneration: 3, schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(durableDoc), stateVector: Y.encodeStateVector(durableDoc), documentSequence: 4,
    checkpointSequence: 0, checkpointedAt: null, persistedAt: 100, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
  const { version, content: _content, source: _source, ...snapshot } = authoritativeNativeCollaborationSnapshot(state);
  const current = inspectNativeDocument(doc, representation), durable = current.version.stateProof === version.stateProof;
  return { identity: { documentId: state.documentId, workspaceId: state.workspaceId, organizationId: null,
    lineageId: 'targets-lineage', path: state.path, representation, lifecycleGeneration: 3, schemaVersion: 1 },
    native: { ...snapshot, source: durable ? 'persisted_yjs' : 'live_yjs',
      observed: { ...current.version, content: current.content, durable }, durable: version }, metadata: { title: null, revision: null } };
}
function binding(observed: NativeDocumentReadObservation): DocumentReadContinuationBindingV1 {
  // Use the exact existing version builders, with no authority inference from
  // these fixture IDs or hashes. Real origin/corpus checks belong in PG tests.
  const nativeIdentity = { workspaceId: observed.identity.workspaceId, organizationId: observed.identity.organizationId,
    documentId: observed.identity.documentId, lineageId: observed.identity.lineageId, lifecycleGeneration: 3,
    representation: observed.identity.representation, schemaVersion: 1 };
  const body = encodeDocumentReadBodyV1(observed, 'native');
  return { authorityScopeSha256: digest('mechanical read fixture scope'), identitySha256: digest(JSON.stringify(nativeIdentity)),
    lifecycleGeneration: 3, contentVersion: documentVersionV1(nativeIdentity, observed.native.observed.stateProof),
    metadataVersion: documentMetadataVersionV1(nativeIdentity, { path: observed.identity.path, title: 'Native', metadataRevision: null }),
    format: 'native', totalBytes: body.totalBytes, bodySha256: body.bodySha256 };
}

check('strict shared PI and MCP opt-in selection never falls back to legacy', () => {
  assert.equal(decodeDocumentReadRequestV1(selection).includeEditTargets, undefined);
  assert.equal(decodeDocumentReadRequestV1({ ...selection, includeEditTargets: false }).includeEditTargets, false);
  assert.equal(decodePiDocumentReadSelection({ ...piSelection, includeEditTargets: true }).includeEditTargets, true);
  assert.equal(decodeDirectMcpDocumentReadSelection({ ...mcpSelection, include_edit_targets: true })?.includeEditTargets, true);
  assert.equal(piDocumentReadParameters.properties.includeEditTargets.type, 'boolean');
  assert.equal(DIRECT_MCP_NATIVE_DOCUMENT_READ_PROPERTIES.include_edit_targets.type, 'boolean');
  for (const value of [undefined, null, 0, 1, 'true', [], {}]) {
    assert.throws(() => decodeDocumentReadRequestV1({ ...selection, includeEditTargets: value }), code('INVALID_REQUEST'));
    assert.throws(() => decodePiDocumentReadSelection({ ...piSelection, includeEditTargets: value }), code('INVALID_REQUEST'));
    assert.throws(() => decodeDirectMcpDocumentReadSelection({ ...mcpSelection, include_edit_targets: value }), code('INVALID_REQUEST'));
    assert.throws(() => decodeDirectMcpDocumentReadSelection({ workspace_id: selection.workspaceId,
      path: 'legacy.md', include_edit_targets: value }), code('INVALID_REQUEST'));
  }
  for (const format of ['text', 'markdown']) for (const flag of [true, false]) {
    assert.throws(() => decodeDocumentReadRequestV1({ ...selection, format, includeEditTargets: flag }), code('INVALID_REQUEST'));
    assert.throws(() => decodePiDocumentReadSelection({ ...piSelection, format, includeEditTargets: flag }), code('INVALID_REQUEST'));
    assert.throws(() => decodeDirectMcpDocumentReadSelection({ ...mcpSelection, format, include_edit_targets: flag }), code('INVALID_REQUEST'));
  }
  let getterReads = 0;
  for (const [base, field, decode] of [
    [selection, 'includeEditTargets', decodeDocumentReadRequestV1],
    [piSelection, 'includeEditTargets', decodePiDocumentReadSelection],
    [mcpSelection, 'include_edit_targets', decodeDirectMcpDocumentReadSelection],
  ] as const) {
    const raw = { ...base }; Object.defineProperty(raw, field, { enumerable: true, get() { getterReads++; return true; } });
    assert.throws(() => decode(raw), code('INVALID_REQUEST'));
  }
  assert.equal(getterReads, 0);
  assert.equal(decodeDirectMcpDocumentReadSelection({ workspace_id: selection.workspaceId, path: 'legacy.md' }), null);
});

check('default and false preserve exact old native-body bytes for all representations', () => {
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    const doc = representation === 'plain_text' ? createPlainTextYDoc('Original 🦊') : createRichMarkdownYDoc('Original 🦊', representation);
    try {
      const observed = observation(doc, representation), expected = Buffer.from(JSON.stringify({ bodyVersion: 1,
        representation, content: observed.native.observed.content }));
      for (const request of [selection, { ...selection, includeEditTargets: false }]) {
        const decoded = decodeDocumentReadRequestV1(request); assert.notEqual(decoded.includeEditTargets, true);
        const body = encodeDocumentReadBodyV1(observed, decoded.format);
        assert.deepEqual(Buffer.from(body.bytes), expected); assert.equal(body.bodySha256, digest(expected));
        assert.deepEqual(Object.keys(JSON.parse(Buffer.from(body.bytes).toString('utf8'))).sort(), ['bodyVersion', 'content', 'representation']);
      }
    } finally { doc.destroy(); }
  }
});

check('same-proof detached guards match actual block/table reader without source or text leaks', () => {
  const doc = nativeTableWidthFixture('tiptap_blocks', 'InlineTextMustNotBeDuplicated');
  try {
    assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
    const current = inspect(doc), expected = readAgentBlockStructure(doc).map(({ text: _text, ...target }) => target);
    const targets = unchanged(doc, () => captureNativeDocumentEditTargets(doc, current.content, current.version.stateProof));
    assert.deepEqual(targets, expected); frozen(targets);
    for (const target of targets) {
      assert.deepEqual(Object.keys(target).sort(), ['id', 'type', 'parentId', 'beforeId', 'attrs', 'subtreeHash', 'placementHash',
        ...(target.tableOperationTarget ? ['tableOperationTarget'] : [])].sort());
      assert(!Object.hasOwn(target, 'text')); assert(!Object.hasOwn(target, 'operations')); assert(!Object.hasOwn(target, 'initial'));
    }
    assert(!JSON.stringify(targets).includes('InlineTextMustNotBeDuplicated'));
    const table = targets.find(target => target.type === 'table'); assert(table);
    const cell = targets.find(target => target.type === 'tableCell'); assert(cell?.tableOperationTarget);
    assert.equal(cell.tableOperationTarget.cellId, cell.id);
    assert.equal(cell.tableOperationTarget.subtreeHash, table.subtreeHash);
    assert.notEqual(cell.tableOperationTarget.subtreeHash, cell.subtreeHash);
    assert.deepEqual(cell.attrs.colwidth, [120]);
    assert.throws(() => { (cell.attrs.colwidth as number[])[0] = 999; }, TypeError);
    assert.deepEqual(readAgentBlockStructure(doc).find(target => target.id === cell.id)?.attrs.colwidth, [120]);
    unchanged(doc, () => assert.throws(() => captureNativeDocumentEditTargets(doc, current.content,
      `yjs-snapshot-sha256-v1:${'0'.repeat(64)}`), code('DOCUMENT_STATE_INVALID')));
    const observed = observation(doc), encoded = encodeDocumentReadBodyV1({ ...observed, editTargets: targets }, 'native');
    const body = JSON.parse(Buffer.from(encoded.bytes).toString('utf8'));
    assert.equal(body.bodyVersion, 1); assert.deepEqual(body.editTargets, targets);
    // JSON transport preserves authored values, not ProseMirror's internal
    // null-prototype attribute objects. Compare the actual wire JSON exactly.
    assert.equal(JSON.stringify(body.content), JSON.stringify(current.content));
  } finally { doc.destroy(); }
});

check('private placement history and continued target bytes stay bound to actual full version', () => {
  const doc = blockDoc([paragraph('a', 'AAA'), paragraph('b', 'BBB'), paragraph('c', 'CCC')]);
  const durable = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(durable, Y.encodeStateAsUpdate(doc));
    const original = inspect(doc), before = capture(doc), tree = new CollaborationBlockTree(doc, schema);
    tree.move({ blockId: 'b', parentId: null, beforeId: 'a', operationId: 'away' }, 'mechanical-fixture');
    tree.move({ blockId: 'b', parentId: null, beforeId: 'c', operationId: 'back' }, 'mechanical-fixture');
    const current = inspect(doc), targets = capture(doc);
    assert.deepEqual(current.content, original.content, 'The visible JSON returns to the same layout.');
    assert.notEqual(current.version.stateProof, original.version.stateProof);
    assert.notEqual(targets.find(row => row.id === 'b')?.placementHash, before.find(row => row.id === 'b')?.placementHash);
    const observed = observation(doc, 'tiptap_blocks', durable);
    assert.equal(observed.native.source, 'live_yjs'); assert.equal(observed.native.observed.durable, false);
    const targetObservation = { ...observed, editTargets: targets }, body = encodeDocumentReadBodyV1(targetObservation, 'native');
    const fullBinding = binding(targetObservation), first = sliceDocumentUtf8PageV1(body.bytes, 0, 97);
    assert.notEqual(first.nextOffset, null);
    const cursor = encodeDocumentReadContinuationV1(fullBinding, first.nextOffset!);
    assert.equal(decodeDocumentReadContinuationV1(cursor, fullBinding), first.nextOffset);
    assert.throws(() => decodeDocumentReadContinuationV1(cursor, binding(observed)), code('DOCUMENT_VERSION_CONFLICT'));
    let offset = 0, reconstructed = '';
    do { const page = sliceDocumentUtf8PageV1(body.bytes, offset, 97); reconstructed += page.fragment;
      offset = page.nextOffset ?? body.totalBytes; } while (offset < body.totalBytes);
    assert.deepEqual(JSON.parse(reconstructed).editTargets, targets);
    assert.equal(Buffer.byteLength(reconstructed), body.totalBytes);
  } finally { durable.destroy(); doc.destroy(); }
});

check('512 native nodes and exact encoded-source bytes have real adjacent boundaries', () => {
  for (const textNodes of [510, 511]) {
    const doc = blockDoc([{ type: 'paragraph', attrs: { id: 'p' }, content: Array.from({ length: textNodes }, (_, index) =>
      ({ type: 'text', text: 'x', ...(index % 2 ? { marks: [{ type: 'bold' }] } : {}) })) }]);
    try {
      const current = inspect(doc), contents = current.content; assert.equal(contents.kind, 'rich_text');
      assert(Buffer.byteLength(JSON.stringify(contents)) < MAX_NATIVE_DOCUMENT_EDIT_TARGET_BYTES);
      if (textNodes + 2 === MAX_NATIVE_DOCUMENT_EDIT_TARGETS) assert.equal(capture(doc).length, 1);
      else unchanged(doc, () => assert.throws(() => captureNativeDocumentEditTargets(doc, contents,
        current.version.stateProof), code('DOCUMENT_TOO_LARGE')));
    } finally { doc.destroy(); }
  }
  const seed = blockDoc([paragraph('p', 'x')]); let overhead: number;
  try { overhead = Buffer.byteLength(JSON.stringify(inspect(seed).content)) - 1; } finally { seed.destroy(); }
  for (const extra of [0, 1]) {
    const doc = blockDoc([paragraph('p', 'x'.repeat(MAX_NATIVE_DOCUMENT_EDIT_TARGET_BYTES - overhead + extra))]);
    try {
      const current = inspect(doc); assert.equal(Buffer.byteLength(JSON.stringify(current.content)), MAX_NATIVE_DOCUMENT_EDIT_TARGET_BYTES + extra);
      if (!extra) assert.equal(capture(doc).length, 1);
      else unchanged(doc, () => assert.throws(() => captureNativeDocumentEditTargets(doc, current.content,
        current.version.stateProof), code('DOCUMENT_TOO_LARGE')));
    } finally { doc.destroy(); }
  }
  for (const text of ['\u0000'.repeat(11_000), '\\'.repeat(33_000), '😀'.repeat(17_000)]) {
    const doc = blockDoc([paragraph('p', text)]);
    try { const current = inspect(doc); assert(Buffer.byteLength(JSON.stringify(current.content)) > MAX_NATIVE_DOCUMENT_EDIT_TARGET_BYTES);
      unchanged(doc, () => assert.throws(() => captureNativeDocumentEditTargets(doc, current.content,
        current.version.stateProof), code('DOCUMENT_TOO_LARGE'))); } finally { doc.destroy(); }
  }
});

check('final guard JSON independently refuses large IDs while native content remains small', () => {
  const doc = blockDoc(Array.from({ length: 200 }, (_, index) => paragraph(`p${index}-${'i'.repeat(80)}`)));
  try {
    const current = inspect(doc), all = readAgentBlockStructure(doc).map(({ text: _text, ...target }) => target);
    assert.equal(all.length, 200); assert(Buffer.byteLength(JSON.stringify(current.content)) < MAX_NATIVE_DOCUMENT_EDIT_TARGET_BYTES);
    assert(Buffer.byteLength(JSON.stringify(all)) > MAX_NATIVE_DOCUMENT_EDIT_TARGET_BYTES);
    unchanged(doc, () => assert.throws(() => captureNativeDocumentEditTargets(doc, current.content,
      current.version.stateProof), code('DOCUMENT_TOO_LARGE')));
    assert(encodeDocumentReadBodyV1(observation(doc), 'native').totalBytes > 0, 'Default native encoding remains available.');
  } finally { doc.destroy(); }
});

check('retained private records operations and receipts are counted beyond visible nodes', () => {
  const doc = blockDoc([{ type: 'blockquote', attrs: { id: 'deleted-parent' }, content:
    Array.from({ length: 2045 }, (_, index) => paragraph(`hidden-${index}`)) }, paragraph('keep', 'Keep')]);
  try {
    const tree = new CollaborationBlockTree(doc, schema); assert.equal(tree.records.size, 2047);
    tree.delete('deleted-parent', 'delete-private-tree', 'mechanical-fixture');
    assert.deepEqual(readAgentBlockStructure(doc).map(target => target.id), ['keep']);
    assert.equal(tree.records.size + tree.operations.size, 2048);
    unchanged(doc, () => assertNativeDocumentEditTargetStorageBudget(doc));
    tree.move({ blockId: 'keep', parentId: null, beforeId: null, operationId: 'one-more' }, 'mechanical-fixture');
    assert.equal(tree.records.size + tree.operations.size, 2049);
    unchanged(doc, () => assert.throws(() => assertNativeDocumentEditTargetStorageBudget(doc), code('DOCUMENT_TOO_LARGE')));
  } finally { doc.destroy(); }
  const receiptsDoc = blockDoc([paragraph('p', 'Keep')]);
  try {
    const tree = new CollaborationBlockTree(receiptsDoc, schema);
    tree.move({ blockId: 'p', parentId: null, beforeId: null, operationId: 'receipt-seed' }, 'mechanical-fixture');
    const seed = tree.receipts.get('receipt-seed'); assert(seed);
    // Exact counter fixtures, using a real placement-helper-produced shape.
    // They are not Owner-issued operations, database receipts or auth grants.
    receiptsDoc.transact(() => {
      tree.operations.delete('receipt-seed'); tree.receipts.delete('receipt-seed');
      for (let index = 0; index < 2048; index++) {
        const id = `retained-${index}`; tree.receipts.set(id, { ...seed, id, transactionId: id, clock: index + 1 });
      }
    }, 'mechanical-receipt-counter-fixture');
    unchanged(receiptsDoc, () => assertNativeDocumentEditTargetStorageBudget(receiptsDoc));
    tree.receipts.set('overflow', { ...seed, id: 'overflow', transactionId: 'overflow', clock: 2049 });
    unchanged(receiptsDoc, () => assert.throws(() => assertNativeDocumentEditTargetStorageBudget(receiptsDoc), code('DOCUMENT_TOO_LARGE')));
  } finally { receiptsDoc.destroy(); }
});

check('raw-store budgets only tighten and reject giant operation arrays before target extraction', () => {
  const limit = nativeDocumentEditTargetsReadBudget(); assert(Object.isFrozen(limit));
  assert.equal(limit.maxStateBytes, 2 * 1024 * 1024); assert.equal(limit.maxStringBytes, 64 * 1024);
  assert.deepEqual(nativeDocumentEditTargetsReadBudget({ ...limit, maxStateBytes: 64 * 1024 * 1024,
    maxStringBytes: 64 * 1024 * 1024 }), limit);
  const lower = { ...limit, maxStateBytes: 1024, maxStringBytes: 1024, maxNodes: 1024 };
  assert.deepEqual(nativeDocumentEditTargetsReadBudget(lower), lower);
  assert.throws(() => nativeDocumentEditTargetsReadBudget({ ...limit, maxStateBytes: 0 }), code('INVALID_REQUEST'));
  const doc = blockDoc([paragraph('keep', 'Keep')]);
  try {
    const tree = new CollaborationBlockTree(doc, schema);
    const huge: BlockPlacementOperation = { id: 'large-delete', clock: 1, actor: doc.clientID,
      transactionId: 'large-delete', ordinal: 0, kind: 'delete', blockIds: Array.from({ length: 65_536 }, () => 'absent-history-id') };
    doc.transact(() => { tree.operations.set(huge.id, huge); tree.receipts.set(huge.id, huge); }, 'mechanical-raw-history-fixture');
    assert.equal(tree.records.size + tree.operations.size, 2, 'A map-entry cap alone would miss this raw array.');
    unchanged(doc, () => assertNativeDocumentEditTargetStorageBudget(doc));
    unchanged(doc, () => assert.throws(() => assertNativeDocumentWithinReadBudget(doc, limit), code('DOCUMENT_TOO_LARGE')));
  } finally { doc.destroy(); }
});

assert.equal(groups, 8);
console.log('Native document edit targets tests passed: 8/8. Pure helpers/selectors only; no auth, room, SQL or durable outcome asserted.');

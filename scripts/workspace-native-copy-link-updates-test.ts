import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { NativeCopyDocumentReceipt } from '../app/lib/collaboration/native-copy-persistence';
import { cloneNativeCollaborationDocument, type NativeRecoveryRecord } from '../app/lib/collaboration/native-document-recovery';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { NativeLinkMutationRecipe, NativeWorkspaceLinkSnapshot } from '../app/lib/markdown/workspace-link-contract-v2';
import { NativeCopyLinkBindingError, prepareNativeCopyLinkUpdates } from '../app/lib/markdown/workspace-native-copy-link-updates';
import { createWorkspaceNativeFileOperationPlan } from '../app/lib/markdown/workspace-native-file-operation-planner';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';

type Representation = PersistedCollaborationState['representation'];
function state(text: string, representation: Representation, path = 'folder/note.md'): PersistedCollaborationState {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
  try {
    return { documentId: `source:${path}`, workspaceId: 'workspace', organizationId: null, path, representation,
      lifecycleGeneration: 3, schemaVersion: 1, documentSequence: 7, persistedAt: 100, checkpointSequence: 0,
      checkpointedAt: null, canonicalHash: null, serializedHash: null, newlineStyle: 'crlf', hasBom: true,
      degraded: false, status: 'active', yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
  } finally { doc.destroy(); }
}
function fixture(representation: Representation = 'tiptap_blocks', text =
  '[Target](target.md#Heading) [[target#Heading|Alias]] [Web](https://example.test/a)\n\n![Image](img.png)\n\nIndependent',
  changeSource?: (state: PersistedCollaborationState) => void): {
  sourceScope: { workspaceId: string; organizationId: string | null };
  destinationScope: { workspaceId: string; organizationId: string | null };
  source: NativeRecoveryRecord; clone: NativeRecoveryRecord; receipt: NativeCopyDocumentReceipt;
  recipes: NativeLinkMutationRecipe[]; operationId: string;
} {
  const original = state(text, representation);
  changeSource?.(original);
  const source: NativeRecoveryRecord = { lineageId: 'source-lineage', state: original };
  const target = state('# Heading', representation, 'folder/target.md');
  const documents = [original, target].map(inspectPersistedDocumentLinks);
  const body: Omit<NativeWorkspaceLinkSnapshot, 'snapshotProof'> = { contractVersion: 2, workspaceId: 'workspace', documents,
    namespace: [...[original, target].map(value => ({ workspaceId: value.workspaceId, path: value.path, kind: 'file' as const,
      identity: `document:${value.documentId}:3`, documentId: value.documentId, lifecycleGeneration: 3, filesystemIdentity: null })),
      ...['folder', 'elsewhere', 'folder/img.png'].map(path => ({ workspaceId: 'workspace', path,
        kind: path.endsWith('.png') ? 'file' as const : 'directory' as const, identity: `physical:${path}`,
        documentId: null, lifecycleGeneration: null, filesystemIdentity: `physical:${path}` }))],
    coverage: { complete: true, gaps: [] } };
  const snapshot = { ...body, snapshotProof: nativeLinkJsonProof(body) };
  const plan = createWorkspaceNativeFileOperationPlan({ kind: 'copy', sourceWorkspaceId: 'workspace', destinationWorkspaceId: 'workspace',
    selections: [{ sourcePath: 'folder/note.md', destinationPath: 'elsewhere/copied.md' }], snapshots: [snapshot] });
  assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues));
  const cloned = cloneNativeCollaborationDocument(original);
  try {
    const cloneState = { ...structuredClone(original), documentId: 'new-document', path: 'elsewhere/copied.md', lifecycleGeneration: 1,
      documentSequence: 0, yjsState: Y.encodeStateAsUpdate(cloned.doc), stateVector: Y.encodeStateVector(cloned.doc) };
    const before = authoritativeNativeCollaborationSnapshot(original), after = authoritativeNativeCollaborationSnapshot(cloneState);
    return { sourceScope: { workspaceId: 'workspace', organizationId: null }, destinationScope: { workspaceId: 'workspace', organizationId: null },
      source, clone: { lineageId: 'new-lineage', state: cloneState }, operationId: 'copy-operation', recipes: plan.mutations,
      receipt: { version: 1, source: { documentId: before.documentId, lifecycleGeneration: before.lifecycleGeneration,
        stateProof: before.version.stateProof, documentSequence: before.version.documentSequence }, clone: {
        documentId: after.documentId, lineageId: 'new-lineage', path: after.path, lifecycleGeneration: 1,
        stateProof: after.version.stateProof, initialSequence: 0 }, blockIdMapping: { ...cloned.blockIdMapping } } };
  } finally { cloned.doc.destroy(); }
}
function apply(input: ReturnType<typeof fixture>, update: Uint8Array): PersistedCollaborationState {
  const doc = new Y.Doc();
  try { Y.applyUpdate(doc, input.clone.state.yjsState); Y.applyUpdate(doc, update);
    return { ...input.clone.state, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
  } finally { doc.destroy(); }
}
const conflict = (error: unknown) => error instanceof NativeCopyLinkBindingError && error.status === 409;

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${representation}: genuine planner recipes update only a fresh clone using its own anchors`, () => {
    const input = fixture(representation), before = structuredClone(input);
    const result = prepareNativeCopyLinkUpdates(input);
    assert(result.prepared); assert.equal(result.recipes.length, input.recipes.length);
    const initial = inspectPersistedDocumentLinks(input.clone.state);
    assert.deepEqual(result.linkBindings.map(binding => binding.cloneLinkId), initial.links.map(link => link.id));
    for (const [index, recipe] of result.recipes.entries()) {
      assert.equal(recipe.source.documentId, 'new-document'); assert.equal(recipe.source.path, 'elsewhere/copied.md');
      assert.equal(recipe.cloneSelection, null); assert.equal(recipe.sourceVersion.documentSequence, 0);
      assert.deepEqual(recipe.reference, initial.links.find(link => link.id === recipe.linkId)!.ref);
      assert.notDeepEqual(recipe.reference, input.recipes[index].reference);
      assert.equal(recipe.nextValue, input.recipes[index].nextValue);
      assert.equal(recipe.expectedTargetIdentity, input.recipes[index].expectedTargetIdentity);
    }
    const after = inspectPersistedDocumentLinks(apply(input, result.prepared.update));
    for (const recipe of result.recipes) {
      assert(after.links.some(link => String(link.ref.kind === 'link-mark' ? link.ref.expected.href : link.ref.expected) === recipe.nextValue));
    }
    assert.deepEqual(input, before); assert.notEqual(result.prepared.after.stateProof, input.receipt.clone.stateProof);
    assert.equal(result.prepared.before.stateProof, input.receipt.clone.stateProof);
    assert.equal(result.prepared.source.documentId, 'new-document');
    assert.match(JSON.stringify(authoritativeNativeCollaborationSnapshot(apply(input, result.prepared.update)).content), /Independent/u);
  });
  test(`${representation}: linkless and sequence-zero empty clones need no fabricated update`, () => {
    for (const text of ['', 'Independent']) {
      const input = fixture(representation, text), before = structuredClone(input);
      const result = prepareNativeCopyLinkUpdates(input);
      assert.deepEqual(result, { recipes: [], linkBindings: [], prepared: null }); assert.deepEqual(input, before);
    }
  });
  test(`${representation}: later source/clone identity and sequence changes conflict before any mutation`, () => {
    for (const side of ['source', 'clone'] as const) for (const change of [
      { documentId: 'foreign' }, { workspaceId: 'foreign' }, { organizationId: 'foreign' }, { path: 'foreign.md' },
      { lifecycleGeneration: 9 }, { documentSequence: 9 }, { newlineStyle: 'lf' as const }, { hasBom: false },
    ]) {
      const input = fixture(representation); Object.assign(input[side].state, change);
      const before = structuredClone(input); assert.throws(() => prepareNativeCopyLinkUpdates(input), conflict, `${side}:${JSON.stringify(change)}`);
      assert.deepEqual(input, before);
    }
  });
}

test('receipt pins and original recipe proofs cannot be forged, dropped or redirected', () => {
  const mutations: Array<(input: ReturnType<typeof fixture>) => void> = [
    input => { input.receipt.version = 2 as 1; }, input => { input.receipt.source.stateProof = 'bad'; },
    input => { input.receipt.source.documentSequence++; }, input => { input.receipt.clone.stateProof = 'bad'; },
    input => { input.receipt.clone.lineageId = 'different'; }, input => { input.clone.lineageId = input.source.lineageId; },
    input => { input.receipt.clone.initialSequence = 1 as 0; }, input => { input.receipt.clone.lifecycleGeneration = 2 as 1; },
    input => { input.recipes.push(structuredClone(input.recipes[0])); }, input => { input.recipes[0].cloneSelection = null; },
    input => { input.recipes[0].cloneSelection = 'another'; }, input => { input.recipes[0].sourcePathAfter = 'foreign.md'; },
    input => { input.recipes[0].destinationWorkspaceId = 'foreign'; }, input => { input.recipes[0].sourceVersion.stateVector = 'bad'; },
    input => { input.recipes[0].reference = structuredClone(input.recipes[1].reference); },
    input => { input.recipes[0].action = 'unlink'; input.recipes[0].nextValue = null; },
    input => { input.recipes[0].linkId = 'missing'; }, input => { input.operationId = ''; },
    input => { const key = Object.keys(input.receipt.blockIdMapping)[0]; delete input.receipt.blockIdMapping[key]; },
    input => { input.receipt.blockIdMapping.extra = '12345678-1234-1234-1234-123456789abc'; },
    input => { const [key, next] = Object.entries(input.receipt.blockIdMapping)[0]; input.receipt.blockIdMapping[key] = key;
      assert.notEqual(key, next); },
    input => { const [a, b] = Object.keys(input.receipt.blockIdMapping); input.receipt.blockIdMapping[b] = input.receipt.blockIdMapping[a]; },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); const before = structuredClone(input);
    assert.throws(() => prepareNativeCopyLinkUpdates(input), conflict); assert.deepEqual(input, before); }
});

test('whole semantic clone check rejects changed unlinked content even with a matching replaced receipt proof', () => {
  const input = fixture('plain_text');
  const doc = new Y.Doc();
  try { Y.applyUpdate(doc, input.clone.state.yjsState); doc.getText('content').insert(doc.getText('content').length, ' changed');
    input.clone.state.yjsState = Y.encodeStateAsUpdate(doc); input.clone.state.stateVector = Y.encodeStateVector(doc);
    input.receipt.clone.stateProof = authoritativeNativeCollaborationSnapshot(input.clone.state).version.stateProof;
    assert.throws(() => prepareNativeCopyLinkUpdates(input), conflict);
  } finally { doc.destroy(); }
});

test('reusing original Yjs history is rejected even when relabelled with fresh document and lineage IDs', () => {
  const input = fixture('plain_text'); input.clone.state.yjsState = input.source.state.yjsState;
  input.clone.state.stateVector = input.source.state.stateVector;
  input.receipt.clone.stateProof = input.receipt.source.stateProof;
  assert.throws(() => prepareNativeCopyLinkUpdates(input), conflict);
});

test('cross-workspace destination uses its genuine new identity and organization', () => {
  const input = fixture(); input.clone.state.workspaceId = 'destination'; input.clone.state.organizationId = 'destination-org';
  input.destinationScope = { workspaceId: 'destination', organizationId: 'destination-org' };
  for (const recipe of input.recipes) recipe.destinationWorkspaceId = 'destination';
  const result = prepareNativeCopyLinkUpdates(input); assert(result.prepared);
  assert.equal(result.prepared.source.workspaceId, 'destination'); assert.equal(result.prepared.source.organizationId, 'destination-org');
});

test('historical recipe/receipt JSON binds without depending on JavaScript object prototypes', () => {
  const input = fixture(); input.recipes = JSON.parse(JSON.stringify(input.recipes));
  input.receipt = JSON.parse(JSON.stringify(input.receipt));
  assert(prepareNativeCopyLinkUpdates(input).prepared);
});

test('original reserved and long block IDs are safe opaque own mapping keys', () => {
  for (const id of ['constructor', 'prototype', '__proto__', 'x'.repeat(300)]) {
    const input = fixture('tiptap_xml', '[Target](target.md#Heading)\n\nIndependent', value => {
      const doc = new Y.Doc();
      try { Y.applyUpdate(doc, value.yjsState); (doc.getXmlFragment('body').toArray()[0] as Y.XmlElement).setAttribute('id', id);
        value.yjsState = Y.encodeStateAsUpdate(doc); value.stateVector = Y.encodeStateVector(doc);
      } finally { doc.destroy(); }
    });
    assert(Object.hasOwn(input.receipt.blockIdMapping, id));
    input.receipt = JSON.parse(JSON.stringify(input.receipt));
    const result = prepareNativeCopyLinkUpdates(input); assert(result.prepared);
    assert.equal(inspectPersistedDocumentLinks(apply(input, result.prepared.update)).links[0].literal, '../folder/target.md#Heading');
    let reads = 0; Object.defineProperty(input.receipt.blockIdMapping, id, { enumerable: true, get() { reads++; return 'bad'; } });
    assert.throws(() => prepareNativeCopyLinkUpdates(input), conflict); assert.equal(reads, 0);
  }
});

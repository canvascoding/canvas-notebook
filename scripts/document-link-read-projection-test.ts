import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { Y } from '../app/lib/collaboration/server-runtime';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { inspectPersistedDocumentLinks } from '../app/lib/markdown/workspace-native-link-inventory';
import { readNativeDocumentLinkProjection, withFreshDocumentLinkReadProjection,
  documentLinkReadProjectionStatistics } from '../app/lib/markdown/document-link-read-projection';
import { buildWorkspaceDocumentLinkIndexFromStage } from '../app/lib/markdown/workspace-document-link-index';
import type { NativeDocumentLinkInventory } from '../app/lib/markdown/workspace-link-contract-v2';
import type { WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';

function state(content: string, representation: PersistedCollaborationState['representation'] = 'plain_text'): PersistedCollaborationState {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(content) : createRichMarkdownYDoc(content, representation);
  try { return { documentId: randomUUID(), workspaceId: 'read-projection-fixture', organizationId: null, path: 'source.md',
    representation, lifecycleGeneration: 1, schemaVersion: 1, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
    documentSequence: 7, persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' }; } finally { doc.destroy(); }
}
function index(inventories: NativeDocumentLinkInventory[]) {
  const stage: WorkspaceSourceAuthorityStage = { stageVersion: 1, workspaceId: 'read-projection-fixture', organizationId: null,
    catalogueProof: 'semantic-fixture-only', stageProof: 'semantic-fixture-only', readiness: 'blocked', executionReady: false,
    scope: { kind: 'document-index', excludedPaths: [] }, coverage: { complete: true, gaps: [] },
    sources: inventories.map(inventory => ({ kind: 'native', inventory })),
    namespace: inventories.map(inventory => ({ workspaceId: inventory.document.workspaceId, kind: 'file', path: inventory.document.path,
      documentId: inventory.document.documentId, lifecycleGeneration: inventory.document.lifecycleGeneration,
      identity: 'semantic-fixture-only', filesystemIdentity: null })) };
  return buildWorkspaceDocumentLinkIndexFromStage(stage, new Date('2026-10-26T00:00:00Z'));
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${representation}: cold, reused and forced-fresh projections are identical and cannot be poisoned by a caller`, async () => {
    const selected = state('---\naliases: [Source]\n---\n\n# Source\n\n[Target](target.md) [[Other]]', representation);
    const before = documentLinkReadProjectionStatistics(), expected = inspectPersistedDocumentLinks(selected);
    const first = await readNativeDocumentLinkProjection(selected);
    assert.deepEqual(first, expected);
    const reused = await readNativeDocumentLinkProjection(selected); assert.deepEqual(reused, expected);
    reused.metadata.aliases.push('poison'); reused.links[0].targetPathText = 'poison';
    assert.deepEqual(await readNativeDocumentLinkProjection(selected), expected);
    const after = documentLinkReadProjectionStatistics();
    assert.equal(after.inspections - before.inspections, 1); assert.equal(after.hits - before.hits, 2);
    assert.deepEqual(await withFreshDocumentLinkReadProjection(() => readNativeDocumentLinkProjection(selected)), expected);
    assert.equal(documentLinkReadProjectionStatistics().inspections - before.inspections, 2);
  });
}

test('changed native bytes invalidate reuse even when every persisted clock and the state vector stay identical', async () => {
  const selected = state('unused');
  const encoded = (text: string) => {
    const doc = new Y.Doc(); doc.clientID = 4219; doc.getText('content').insert(0, text);
    try { return { update: Y.encodeStateAsUpdate(doc), vector: Y.encodeStateVector(doc) }; } finally { doc.destroy(); }
  };
  const first = encoded('[[First]]'), second = encoded('[[Other]]');
  assert.deepEqual(first.vector, second.vector); assert.notDeepEqual(first.update, second.update);
  selected.yjsState = first.update; selected.stateVector = first.vector;
  const before = documentLinkReadProjectionStatistics();
  assert.equal((await readNativeDocumentLinkProjection(selected)).links[0].targetPathText, 'First');
  selected.yjsState = second.update;
  assert.equal((await readNativeDocumentLinkProjection(selected)).links[0].targetPathText, 'Other');
  assert.equal(documentLinkReadProjectionStatistics().inspections - before.inspections, 2);
});

test('identity, generation, path, version and quarantine changes never reuse the older inspection', async () => {
  const selected = state('[[Target]]'); await readNativeDocumentLinkProjection(selected);
  for (const change of [{ path: 'moved.md' }, { lifecycleGeneration: 2 }, { documentSequence: 8 }, { organizationId: 'another-org' }]) {
    const current = { ...selected, ...change };
    assert.deepEqual(await readNativeDocumentLinkProjection(current), inspectPersistedDocumentLinks(current));
  }
  for (const change of [{ degraded: true }, { schemaVersion: 99 }, { status: 'archived' as const },
    { stateVector: new Uint8Array([0]) }, { yjsState: new Uint8Array([...selected.yjsState, 0xff]) }]) {
    await assert.rejects(readNativeDocumentLinkProjection({ ...selected, ...change }));
  }
  assert.deepEqual(await readNativeDocumentLinkProjection(selected), inspectPersistedDocumentLinks(selected));
});

test('new, ambiguous, renamed and removed targets are resolved against the current namespace after a source reuse', async () => {
  const source = state('[[Target]]'), target = { ...state('---\naliases: [Target]\n---\n\n# One'), path: 'one.md' };
  const cachedSource = () => readNativeDocumentLinkProjection(source);
  assert.equal(index([await cachedSource()]).edges[0].status, 'missing');
  const firstTarget = await readNativeDocumentLinkProjection(target);
  assert.equal(index([await cachedSource(), firstTarget]).edges[0].targetPath, 'one.md');
  const duplicate = await readNativeDocumentLinkProjection({ ...target, documentId: randomUUID(), path: 'two.md' });
  assert.equal(index([await cachedSource(), firstTarget, duplicate]).edges[0].status, 'ambiguous');
  const moved = await readNativeDocumentLinkProjection({ ...target, path: 'moved.md' });
  assert.equal(index([await cachedSource(), moved]).edges[0].targetPath, 'moved.md');
  assert.equal(index([await cachedSource()]).edges[0].status, 'missing');
});

test('only the latest retained version of a document consumes bounded cache memory', async () => {
  const selected = state('[[Target]]'), before = documentLinkReadProjectionStatistics();
  for (let sequence = 8; sequence < 28; sequence++) await readNativeDocumentLinkProjection({ ...selected, documentSequence: sequence });
  const after = documentLinkReadProjectionStatistics();
  assert.equal(after.entries - before.entries, 1);
  assert(after.entries <= after.maxEntries); assert(after.retainedBytes <= after.maxBytes);
  assert.deepEqual(await withFreshDocumentLinkReadProjection(() => readNativeDocumentLinkProjection(selected)), inspectPersistedDocumentLinks(selected));
});

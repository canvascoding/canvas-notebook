import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { inspectOriginalPhysicalLinks } from '../app/lib/markdown/workspace-physical-link-inventory';
import { compileWorkspaceMixedReadBatchV3, compileWorkspaceNativeMixedBatch,
  type NativeMixedBatchRequest } from '../app/lib/markdown/workspace-native-mixed-batch-compiler';
import type { NativeNamespaceEntry } from '../app/lib/markdown/workspace-link-contract-v2';
import type { PhysicalReadLinkInventory, WorkspaceMixedReadLinkSnapshotV3 } from '../app/lib/markdown/workspace-link-contract-v3';

const workspaceId = 'mixed-read-v3';
function mixedReadState(content: string, filePath: string,
  representation: PersistedCollaborationState['representation'] = 'plain_text'): PersistedCollaborationState {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(content) : createRichMarkdownYDoc(content, representation);
  try {
    return { documentId: `document:${filePath}`, workspaceId, organizationId: null, path: filePath, lifecycleGeneration: 1,
      representation, schemaVersion: 1, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
      documentSequence: 7, persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null,
      serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
  } finally { doc.destroy(); }
}
function mixedReadPhysical(content: string, filePath = 'raw.md'): PhysicalReadLinkInventory {
  const { originalBytes: _private, ...inventory } = inspectOriginalPhysicalLinks({ workspaceId, organizationId: null, path: filePath,
    authority: { kind: 'unregistered', catalogueProof: 'a'.repeat(64) }, bytes: Buffer.from(content),
    filesystemIdentity: `physical-fixture:${filePath}:${Buffer.byteLength(content)}` });
  assert(inventory.coverage.complete); return inventory;
}
function mixedReadSnapshot(states: PersistedCollaborationState[], physicalSources: PhysicalReadLinkInventory[]): WorkspaceMixedReadLinkSnapshotV3 {
  const documents = states.map(inspectPersistedDocumentLinks);
  const namespace: NativeNamespaceEntry[] = documents.map(({ document }) => ({ workspaceId, path: document.path, kind: 'file',
    identity: `registry:${document.documentId}:1`, documentId: document.documentId, lifecycleGeneration: 1, filesystemIdentity: null }));
  namespace.push(...physicalSources.map(source => ({ workspaceId, path: source.path, kind: 'file' as const,
    identity: source.physical.filesystemIdentity, documentId: null, lifecycleGeneration: null,
    filesystemIdentity: source.physical.filesystemIdentity })));
  for (const file of [...namespace]) {
    const parts = file.path.split('/'); parts.pop();
    while (parts.length) {
      const parent = parts.join('/');
      if (!namespace.some(entry => entry.path === parent)) namespace.push({ workspaceId, path: parent, kind: 'directory',
        identity: `directory:${parent}`, documentId: null, lifecycleGeneration: null, filesystemIdentity: `directory:${parent}` });
      parts.pop();
    }
  }
  const gaps = documents.flatMap(document => document.coverage.gaps);
  const body = { contractVersion: 3 as const, workspaceId, namespace, documents, physicalSources,
    coverage: { complete: !gaps.length, gaps } };
  return { ...body, snapshotProof: nativeLinkJsonProof(body) };
}
function mixedReadRequest(kind: NativeMixedBatchRequest['kind'], sourcePath: string, destinationPath?: string): NativeMixedBatchRequest {
  return { kind, sourceWorkspaceId: workspaceId, destinationWorkspaceId: workspaceId,
    selections: [{ sourcePath, ...(kind !== 'delete' && destinationPath ? { destinationPath } : {}) }] };
}

test('V3 retains a zero-link physical source while rehearsing genuine native backlink changes', () => {
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    const states = [mixedReadState('# Target', 'target.md', representation), mixedReadState('[Target](target.md)', 'incoming.md', representation)];
    const snapshot = mixedReadSnapshot(states, [mixedReadPhysical('# Independent\n\nKeep ä 😀')]);
    const before = structuredClone({ states, snapshot });
    const plan = compileWorkspaceMixedReadBatchV3({ states, snapshots: [snapshot], requests: [mixedReadRequest('move', 'target.md', 'moved.md')] });
    assert.equal(plan.contractVersion, 3); assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues));
    assert.equal(plan.executionReady, false); assert.equal(plan.cloneRequirements.length, 0);
    assert.equal(plan.steps[0].linkIntents.length, 1); assert.equal(plan.steps[0].linkIntents[0].nextValue, 'moved.md');
    const physical = plan.finalNamespace.find(entry => entry.path === 'raw.md'); assert(physical);
    assert.deepEqual(physical.physicalReadSource, { physicalSourceProof: snapshot.physicalSources[0].physicalSourceProof });
    assert.equal(physical.binding.kind, 'existing'); assert(!('documentId' in physical));
    assert.equal(physical.binding.kind === 'existing' && physical.binding.documentEvidenceKey, null);
    assert.deepEqual({ states, snapshot }, before);
  }
});

test('all physical aliases participate in a selected native outgoing Wiki resolution', () => {
  const states = [mixedReadState('[[Original Alias]]', 'note.md')];
  const snapshot = mixedReadSnapshot(states, [mixedReadPhysical('---\naliases: [Original Alias]\n---\n# Raw')]);
  const plan = compileWorkspaceMixedReadBatchV3({ states, snapshots: [snapshot], requests: [mixedReadRequest('rename', 'note.md', 'renamed.md')] });
  assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues));
  const raw = plan.finalNamespace.find(entity => entity.path === 'raw.md'); assert(raw);
  assert.equal(plan.finalEdges.length, 1); assert.equal(plan.finalEdges[0].resolution.targetEntityKey, raw.entityKey);
  assert.equal(plan.documentEvidence.length, 1); assert.equal(plan.documentEvidence[0].inventory.document.documentId, states[0].documentId);
});

test('a physical Wiki alias remains a READ source when its native target moves without changing resolution', () => {
  const states = [mixedReadState('---\naliases: [Target Alias]\n---\n# Target', 'target.md')];
  const source = mixedReadPhysical('[[Target Alias]]'); const snapshot = mixedReadSnapshot(states, [source]);
  const plan = compileWorkspaceMixedReadBatchV3({ states, snapshots: [snapshot], requests: [mixedReadRequest('move', 'target.md', 'moved.md')] });
  assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues));
  assert.equal(plan.steps[0].linkIntents.length, 0); assert.equal(plan.finalEdges.length, 1);
  assert.equal(plan.finalEdges[0].physicalReadSource, true); assert.equal(plan.finalEdges[0].literal, 'Target Alias');
  assert.equal(plan.finalEdges[0].resolution.targetEntityKey, plan.finalNamespace.find(entity => entity.path === 'moved.md')!.entityKey);
  assert(!('reference' in plan.finalEdges[0])); assert(!('sourceVersion' in plan.finalEdges[0]));
});

test('exact physical incoming rewrite and unlink require import before the batch can become ready', () => {
  const states = [mixedReadState('# Target', 'target.md')];
  const snapshot = mixedReadSnapshot(states, [mixedReadPhysical('[Target](target.md)')]);
  for (const kind of ['move', 'delete'] as const) {
    const plan = compileWorkspaceMixedReadBatchV3({ states, snapshots: [snapshot], requests: [mixedReadRequest(kind, 'target.md', 'moved.md')] });
    assert.equal(plan.readiness, 'blocked'); assert.equal(plan.finalGraphProof, null);
    assert(plan.issues.some(issue => issue.code === 'physical-source-import-required' && issue.path === 'raw.md'));
    assert.deepEqual(plan.finalNamespace, []); assert.deepEqual(plan.cloneRequirements, []);
  }
});

test('physical missing-link capture is detected even when the source was not selected', () => {
  const states = [mixedReadState('# Target', 'target.md')];
  const snapshot = mixedReadSnapshot(states, [mixedReadPhysical('[Future](future.md)')]);
  const plan = compileWorkspaceMixedReadBatchV3({ states, snapshots: [snapshot], requests: [mixedReadRequest('rename', 'target.md', 'future.md')] });
  assert.equal(plan.readiness, 'blocked'); assert.equal(plan.finalGraphProof, null);
  assert(plan.issues.some(issue => issue.code === 'physical-source-import-required' && issue.path === 'raw.md'));
});

test('selected physical Markdown and selected directories containing it require import without fake clones', () => {
  const states = [mixedReadState('# Target', 'target.md')];
  for (const [rawPath, selected] of [['raw.md', 'raw.md'], ['folder/raw.md', 'folder']]) {
    const snapshot = mixedReadSnapshot(states, [mixedReadPhysical('# Raw', rawPath)]);
    for (const kind of ['move', 'copy', 'delete'] as const) {
      const plan = compileWorkspaceMixedReadBatchV3({ states, snapshots: [snapshot], requests: [mixedReadRequest(kind, selected, 'destination')] });
      assert.equal(plan.readiness, 'blocked'); assert.equal(plan.finalGraphProof, null);
      assert(plan.issues.some(issue => issue.code === 'physical-source-import-required' && issue.path === rawPath));
      assert.deepEqual(plan.cloneRequirements, []); assert.equal(plan.steps.length, 0);
    }
  }
});

test('each ordered transition checks physical links instead of hiding an intermediate break behind the final path', () => {
  const states = [mixedReadState('# Target', 'target.md')];
  const snapshot = mixedReadSnapshot(states, [mixedReadPhysical('[Target](target.md)')]);
  const plan = compileWorkspaceMixedReadBatchV3({ states, snapshots: [snapshot], requests: [
    mixedReadRequest('move', 'target.md', 'moved.md'), mixedReadRequest('move', 'moved.md', 'target.md')] });
  assert.equal(plan.readiness, 'blocked'); assert.equal(plan.finalGraphProof, null);
  assert(plan.issues.some(issue => issue.requestIndex === 0 && issue.code === 'physical-source-import-required'));
});

test('full physical evidence changes the final graph even when the changed text contains no link', () => {
  const states = [mixedReadState('# Target', 'target.md')];
  const requests = [mixedReadRequest('move', 'target.md', 'moved.md')];
  const one = compileWorkspaceMixedReadBatchV3({ states, snapshots: [mixedReadSnapshot(states, [mixedReadPhysical('# Raw\nOne')])], requests });
  const two = compileWorkspaceMixedReadBatchV3({ states, snapshots: [mixedReadSnapshot(states, [mixedReadPhysical('# Raw\nTwo')])], requests });
  assert.equal(one.readiness, 'ready'); assert.equal(two.readiness, 'ready');
  assert.notEqual(one.planId, two.planId); assert.notEqual(one.finalGraphProof, two.finalGraphProof);
});

test('rehashing the outer snapshot cannot hide a broken physical byte, proof or link-span envelope', () => {
  const states = [mixedReadState('# Target', 'target.md'), mixedReadState('# Keep', 'keep.md')];
  const original = mixedReadSnapshot(states, [mixedReadPhysical('[Keep](keep.md)')]);
  for (const tamper of ['byte-hash', 'physical-proof', 'link-span'] as const) {
    const snapshot = structuredClone(original), raw = snapshot.physicalSources[0];
    if (tamper === 'byte-hash') raw.physical.byteHash = 'b'.repeat(64);
    else if (tamper === 'physical-proof') raw.physicalSourceProof = 'c'.repeat(64);
    else raw.links[0].targetRange.startUtf16++;
    const { snapshotProof: _old, ...body } = snapshot; snapshot.snapshotProof = nativeLinkJsonProof(body);
    const plan = compileWorkspaceMixedReadBatchV3({ states, snapshots: [snapshot], requests: [mixedReadRequest('move', 'target.md', 'moved.md')] });
    assert.equal(plan.readiness, 'blocked', tamper); assert.equal(plan.finalGraphProof, null);
    assert(plan.issues.some(issue => issue.code === 'invalid-physical-read-source' && issue.path === 'raw.md'), tamper);
    assert.equal(plan.steps.length, 0);
  }
});

test('the historical V2 entry never interprets a physical MD source as a native inventory', () => {
  const states = [mixedReadState('# Target', 'target.md')];
  const { physicalSources: _physical, snapshotProof: _proof, ...full } = mixedReadSnapshot(states, [mixedReadPhysical('# Raw')]);
  const body = { ...full, contractVersion: 2 as const,
    coverage: { complete: full.coverage.complete, gaps: full.documents.flatMap(inventory => inventory.coverage.gaps) } };
  const plan = compileWorkspaceNativeMixedBatch({ states, snapshots: [{ ...body, snapshotProof: nativeLinkJsonProof(body) }],
    requests: [mixedReadRequest('move', 'target.md', 'moved.md')] });
  assert.equal(plan.contractVersion, 2); assert.equal(plan.readiness, 'blocked');
  assert(plan.issues.some(issue => issue.code === 'uninspected-source' && issue.path === 'raw.md'));
});

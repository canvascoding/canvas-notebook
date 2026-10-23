import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { Y } from '../app/lib/collaboration/server-runtime';
import { COLLABORATION_SCHEMA_VERSION } from '../app/lib/collaboration/types';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { inspectOriginalPhysicalLinks } from '../app/lib/markdown/workspace-physical-link-inventory';
import { buildWorkspaceMixedReadLinkGraphV3, buildWorkspaceNativeLinkGraph } from '../app/lib/markdown/workspace-native-link-graph';
import { createWorkspaceMixedReadFileOperationPlanV3, createWorkspaceNativeFileOperationPlan } from '../app/lib/markdown/workspace-native-file-operation-planner';
import type { NativeDocumentLinkInventory, NativeNamespaceEntry, NativeWorkspaceLinkSnapshot } from '../app/lib/markdown/workspace-link-contract-v2';
import type { PhysicalReadLinkInventory, WorkspaceMixedReadLinkSnapshotV3 } from '../app/lib/markdown/workspace-link-contract-v3';

// Pure semantic fixtures, not PG/ACL/freshness/physical-read authority proofs.
function nativeInventory(text: string, filePath: string, workspaceId = 'mixed-read',
  representation: PersistedCollaborationState['representation'] = 'tiptap_blocks'): NativeDocumentLinkInventory {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
  try {
    return inspectPersistedDocumentLinks({ documentId: `${workspaceId}:${filePath}`, workspaceId, organizationId: null,
      path: filePath, representation, lifecycleGeneration: 1, schemaVersion: COLLABORATION_SCHEMA_VERSION,
      yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 2,
      checkpointSequence: 0, persistedAt: 100, checkpointedAt: null, canonicalHash: null, serializedHash: null,
      newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' });
  } finally { doc.destroy(); }
}

function physicalInventory(text: string, filePath = 'raw.md', workspaceId = 'mixed-read'): PhysicalReadLinkInventory {
  const { originalBytes: _privateBytes, ...read } = inspectOriginalPhysicalLinks({ workspaceId, organizationId: null,
    path: filePath, authority: { kind: 'unregistered', catalogueProof: '0'.repeat(64) }, bytes: Buffer.from(text),
    filesystemIdentity: `physical-fixture:${workspaceId}:${filePath}` });
  return read;
}

function mixedSnapshot(documents: NativeDocumentLinkInventory[], physicalSources: PhysicalReadLinkInventory[] = [],
  workspaceId = 'mixed-read', extra: NativeNamespaceEntry[] = []): WorkspaceMixedReadLinkSnapshotV3 {
  const namespace: NativeNamespaceEntry[] = [...documents.map(({ document }) => ({ workspaceId, path: document.path, kind: 'file' as const,
    identity: `native:${document.documentId}:${document.lifecycleGeneration}`, documentId: document.documentId,
    lifecycleGeneration: document.lifecycleGeneration, filesystemIdentity: null })),
  ...physicalSources.map(inventory => ({ workspaceId, path: inventory.path, kind: 'file' as const,
    identity: inventory.physical.filesystemIdentity, documentId: null, lifecycleGeneration: null,
    filesystemIdentity: inventory.physical.filesystemIdentity })), ...extra];
  for (const entry of [...namespace]) {
    const segments = entry.path.split('/');
    for (let length = 1; length < segments.length; length++) {
      const parent = segments.slice(0, length).join('/');
      if (!namespace.some(candidate => candidate.path === parent)) namespace.push({ workspaceId, path: parent, kind: 'directory',
        identity: `directory-fixture:${workspaceId}:${parent}`, documentId: null, lifecycleGeneration: null, filesystemIdentity: null });
    }
  }
  const gaps = [...documents.flatMap(inventory => inventory.coverage.gaps), ...physicalSources.flatMap(inventory => inventory.coverage.gaps)];
  const body = { contractVersion: 3 as const, workspaceId, namespace, documents, physicalSources, coverage: { complete: !gaps.length, gaps } };
  return { ...body, snapshotProof: nativeLinkJsonProof(body) };
}

function operation(snapshots: WorkspaceMixedReadLinkSnapshotV3[], kind: 'rename' | 'move' | 'copy' | 'delete',
  sourcePath: string, destinationPath = 'moved.md', destinationWorkspaceId = snapshots[0].workspaceId) {
  return createWorkspaceMixedReadFileOperationPlanV3({ kind, sourceWorkspaceId: snapshots[0].workspaceId, destinationWorkspaceId,
    selections: kind === 'delete' ? [{ sourcePath }] : [{ sourcePath, destinationPath }], snapshots });
}

test('V2 retains native graph shape, version, proof body, deterministic output and input bytes', () => {
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    const mixed = mixedSnapshot([nativeInventory('[target](target.md)', 'source.md', 'mixed-read', representation),
      nativeInventory('Target', 'target.md', 'mixed-read', representation)]);
    const { physicalSources: _physical, snapshotProof: _proof, ...mixedBody } = mixed;
    const body = { ...mixedBody, contractVersion: 2 as const,
      coverage: { complete: mixedBody.coverage.complete, gaps: mixedBody.documents.flatMap(inventory => inventory.coverage.gaps) } };
    const snapshot: NativeWorkspaceLinkSnapshot = { ...body, snapshotProof: nativeLinkJsonProof(body) };
    const frozen = JSON.stringify(snapshot), graph = buildWorkspaceNativeLinkGraph(snapshot), target = snapshot.namespace[1];
    assert.equal(graph.contractVersion, 2); assert.equal(Object.hasOwn(graph, 'physicalSources'), false);
    assert.deepEqual(graph.edges, [{ ...snapshot.documents[0].links[0], source: snapshot.documents[0].document,
      resolution: { status: 'resolved', target, candidates: [target] } }]);
    assert.equal(graph.snapshotProof, nativeLinkJsonProof({ base: snapshot.snapshotProof, edges: graph.edges, coverage: graph.coverage }));
    for (const kind of ['rename', 'move', 'copy', 'delete'] as const) {
      const request = { kind, sourceWorkspaceId: snapshot.workspaceId, destinationWorkspaceId: snapshot.workspaceId,
        selections: kind === 'delete' ? [{ sourcePath: 'target.md' }] : [{ sourcePath: 'target.md', destinationPath: 'moved.md' }], snapshots: [snapshot] };
      const plan = createWorkspaceNativeFileOperationPlan(request), { planId, ...planBody } = plan;
      assert.equal(plan.contractVersion, 2); assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues));
      assert.equal(planId, nativeLinkJsonProof(planBody));
      assert.equal(JSON.stringify(createWorkspaceNativeFileOperationPlan(request)), JSON.stringify(plan));
      assert.equal(Object.hasOwn(plan, 'physicalSources'), false);
    }
    assert.equal(JSON.stringify(snapshot), frozen);
    const damaged = structuredClone(snapshot); Reflect.set(damaged, 'contractVersion', 3);
    const damagedGraph = buildWorkspaceNativeLinkGraph(damaged);
    assert.equal(damagedGraph.contractVersion, 2); assert.deepEqual(damagedGraph.edges, graph.edges);
    for (const rehash of [false, true]) {
      if (rehash) { const { snapshotProof: _damagedProof, ...damagedBody } = damaged; damaged.snapshotProof = nativeLinkJsonProof(damagedBody); }
      const blocked = createWorkspaceNativeFileOperationPlan({ kind: 'delete', sourceWorkspaceId: snapshot.workspaceId,
        destinationWorkspaceId: snapshot.workspaceId, selections: [{ sourcePath: 'target.md' }], snapshots: [damaged] });
      assert.equal(blocked.contractVersion, 2); assert.equal(blocked.readiness, 'blocked');
      assert.equal(blocked.issues[0].code, 'snapshot-proof-mismatch');
    }
  }
});

test('unselected complete zero-link raw Markdown permits all native operations with immutable inputs', () => {
  const snapshot = mixedSnapshot([nativeInventory('Target', 'target.md'), nativeInventory('[target](target.md)', 'incoming.md')],
    [physicalInventory('# Unrelated raw\r\n\r\nUnicode äöü 😀\r\n')]);
  const frozen = JSON.stringify(snapshot);
  for (const kind of ['rename', 'move', 'copy', 'delete'] as const) {
    const plan = operation([snapshot], kind, 'target.md');
    assert.equal(plan.contractVersion, 3); assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues));
    assert(plan.mutations.every(recipe => recipe.source.path !== 'raw.md'));
  }
  assert.equal(JSON.stringify(snapshot), frozen);
});

test('physical edges retain actual parser IDs/literals/identity and never obtain native write references', () => {
  const physical = physicalInventory('[[Shared]] [exact](/notebook?path=%20target.md)');
  const snapshot = mixedSnapshot([nativeInventory('---\naliases: [Shared]\n---\nNative', 'target.bin'), nativeInventory('Space', ' target.md')], [physical]);
  const edges = buildWorkspaceMixedReadLinkGraphV3(snapshot).edges.filter(edge => edge.sourceKind === 'physical-read');
  assert.equal(edges.length, 2);
  assert.deepEqual(edges.map(edge => edge.resolution.target?.path), ['target.bin', ' target.md']);
  for (const [index, edge] of edges.entries()) {
    assert.equal(edge.id, physical.links[index].physicalLinkId); assert.equal(edge.literal, physical.links[index].targetLiteral);
    assert.equal(edge.sourceKind, 'physical-read'); assert.equal(Object.hasOwn(edge, 'ref'), false); assert.equal(Object.hasOwn(edge, 'cloneLocator'), false);
    assert.equal(Object.hasOwn(edge.source, 'documentId'), false); assert.equal(Object.hasOwn(edge.source, 'lifecycleGeneration'), false);
    if (edge.sourceKind === 'physical-read') assert.deepEqual(edge.source.physicalSourceIdentity, physical.physical);
  }
});

test('native links resolve aliases of raw Markdown without pretending the target is initialized', () => {
  const snapshot = mixedSnapshot([nativeInventory('[[RawAlias]]', 'native.md')], [physicalInventory('---\naliases: [RawAlias]\n---\nRaw')]);
  const graph = buildWorkspaceMixedReadLinkGraphV3(snapshot), edge = graph.edges[0];
  assert.equal(edge.resolution.status, 'resolved'); assert.equal(edge.resolution.target?.path, 'raw.md');
  assert.equal(edge.resolution.target?.documentId, null);
  const plan = operation([snapshot], 'move', 'native.md', 'folder/native.md');
  assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues)); assert.equal(plan.mutations.length, 1);
  assert.equal(plan.mutations[0].expectedTargetIdentity, snapshot.physicalSources[0].physical.filesystemIdentity);
});

test('selected physical source and selected directory containing one demand explicit import in every operation', () => {
  const snapshot = mixedSnapshot([nativeInventory('Native', 'native.md')], [physicalInventory('Raw', 'folder/raw.md')]);
  for (const sourcePath of ['folder/raw.md', 'folder']) for (const kind of ['rename', 'move', 'copy', 'delete'] as const) {
    const plan = operation([snapshot], kind, sourcePath, 'other');
    assert.equal(plan.readiness, 'blocked'); assert(plan.issues.some(issue => issue.code === 'physical-source-import-required' && issue.path === 'folder/raw.md'));
    assert.equal(plan.mutations.some(recipe => recipe.source.path === 'folder/raw.md'), false);
  }
});

test('necessary physical incoming rewrite or unlink demands import and retains the changed-resolution failure', () => {
  const snapshot = mixedSnapshot([nativeInventory('Target', 'target.md')], [physicalInventory('[Target](target.md)')]);
  for (const kind of ['rename', 'move', 'delete'] as const) {
    const plan = operation([snapshot], kind, 'target.md');
    assert.equal(plan.readiness, 'blocked');
    assert(plan.issues.some(issue => issue.code === 'physical-source-import-required' && issue.path === 'raw.md'));
    assert(plan.issues.some(issue => issue.code === 'resolution-changed' && issue.path === 'raw.md'));
    assert.equal(plan.mutations.length, 0);
  }
  assert.equal(operation([snapshot], 'copy', 'target.md').readiness, 'ready');
});

test('unchanged physical Wiki alias identity needs only reading when the native target moves', () => {
  const snapshot = mixedSnapshot([nativeInventory('---\naliases: [Shared]\n---\nTarget', 'target.md')], [physicalInventory('[[Shared]]')]);
  for (const kind of ['rename', 'move'] as const) {
    const plan = operation([snapshot], kind, 'target.md', 'folder/target.md');
    assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues)); assert.equal(plan.mutations.length, 0);
  }
});

test('copy alias capture blocks untouched physical and native links including missing and ambiguous candidates', () => {
  for (const physical of [false, true]) {
    const link = '[[Shared]]';
    const snapshot = mixedSnapshot([nativeInventory('---\naliases: [Shared]\n---\nOne', 'one.md'),
      ...(physical ? [] : [nativeInventory(link, 'reader.md')])], physical ? [physicalInventory(link)] : []);
    const plan = operation([snapshot], 'copy', 'one.md', 'clone.md');
    assert.equal(plan.readiness, 'blocked'); assert(plan.issues.some(issue => issue.code === 'resolution-changed'));
  }
  const missing = mixedSnapshot([nativeInventory('Target', 'target.md')], [physicalInventory('[missing](clone.md)')]);
  assert(operation([missing], 'copy', 'target.md', 'clone.md').issues.some(issue => issue.code === 'resolution-changed' && issue.path === 'raw.md'));
  const ambiguous = mixedSnapshot([nativeInventory('---\naliases: [Shared]\n---\nOne', 'one.md'), nativeInventory('---\naliases: [Shared]\n---\nTwo', 'two.md')],
    [physicalInventory('[[Shared]]')]);
  const graph = buildWorkspaceMixedReadLinkGraphV3(ambiguous);
  assert.equal(graph.edges[0].resolution.status, 'ambiguous'); assert.equal(graph.edges[0].resolution.candidates.length, 2);
  assert(operation([ambiguous], 'delete', 'one.md').issues.some(issue => issue.code === 'resolution-changed'));
});

test('cross-workspace copy never captures an uncopied raw target or destination physical reader', () => {
  const source = mixedSnapshot([nativeInventory('[[RawAlias]]', 'source.md')], [physicalInventory('---\naliases: [RawAlias]\n---\nRaw')]);
  const destination = mixedSnapshot([], [physicalInventory('---\naliases: [RawAlias]\n---\nOther', 'raw.md', 'destination')], 'destination');
  const plan = operation([source, destination], 'copy', 'source.md', 'source.md', 'destination');
  assert.equal(plan.readiness, 'blocked'); assert(plan.issues.some(issue => issue.code === 'uncopied-cross-workspace-target'));
  const aliased = mixedSnapshot([nativeInventory('---\naliases: [NewAlias]\n---\nSource', 'source.md')]);
  const readers = mixedSnapshot([], [physicalInventory('[[NewAlias]]', 'reader.md', 'destination')], 'destination');
  assert(operation([aliased, readers], 'copy', 'source.md', 'source.md', 'destination').issues.some(issue => issue.code === 'resolution-changed' && issue.workspaceId === 'destination'));
});

test('physical proof/parser/namespace/coverage tampering stays blocked even with a recomputed outer snapshot proof', () => {
  const original = mixedSnapshot([nativeInventory('Native', 'native.md')], [physicalInventory('Raw')]);
  for (const mutation of ['byte-hash', 'parser', 'namespace', 'coverage'] as const) {
    const snapshot = structuredClone(original);
    if (mutation === 'byte-hash') snapshot.physicalSources[0].physical.byteHash = '1'.repeat(64);
    if (mutation === 'parser') delete snapshot.physicalSources[0].parserVersion;
    if (mutation === 'namespace') snapshot.namespace.find(entry => entry.path === 'raw.md')!.documentId = 'invented-native';
    if (mutation === 'coverage') snapshot.physicalSources[0].coverage.complete = false;
    const { snapshotProof: _old, ...body } = snapshot; snapshot.snapshotProof = nativeLinkJsonProof(body);
    const plan = operation([snapshot], 'delete', 'native.md');
    assert.equal(plan.readiness, 'blocked'); assert(plan.issues.some(issue => issue.code === 'physical-source-proof-mismatch'));
  }
});

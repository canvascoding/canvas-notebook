import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions,
  validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { authoritativeNativeCollaborationSnapshot, inspectPersistedNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { inspectNativeDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { prepareNativeLinkMutations } from '../app/lib/markdown/workspace-native-link-mutations';
import { workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { NativeNamespaceEntry } from '../app/lib/markdown/workspace-link-contract-v2';
import type { NativeMixedBatchPlan } from '../app/lib/markdown/workspace-native-mixed-batch-compiler';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';
import type { WorkspaceOperationBatchAction, WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import { createWorkspaceOperationNativeMoveBatchPlan, decodeWorkspaceOperationNativeMoveBatchPlan,
  assertWorkspaceOperationNativeMoveBatchPlanCurrent, computeWorkspaceOperationNativeMoveBatchPlanId,
  getWorkspaceOperationNativeMoveLinkRecipes, WorkspaceOperationNativeMovePlanError } from '../app/lib/files/workspace-operation-native-move-plan';

// These are pure producer/codec/compiler tests. Registry and lineage rows are
// declared fixture observations; they prove neither SQL ownership nor rights.
// Every native document is real Yjs and destroyed after its bytes are captured.
const scope: WorkspaceOperationBatchScope = { workspace: { workspaceId: 'native-move-workspace', rootPath: '/fixture/workspace',
  rootRelativePath: 'users/fixture/workspace', workspaceType: 'personal', organizationId: null, ownerUserId: 'fixture-user', legacy: false,
  status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
    canManageWorkspace: true, canCreatePublicLinks: false } }, fileOptions: {} };
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
type Representation = PersistedCollaborationState['representation'];
type ExtraPath = { path: string; kind?: NativeNamespaceEntry['kind']; identity?: string | null };
function state(filePath: string, text = 'Original', representation: Representation = 'tiptap_blocks',
  prepare?: (doc: Y.Doc) => void): PersistedCollaborationState {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
  try {
    prepare?.(doc);
    return { documentId: `document:${filePath}`, workspaceId: scope.workspace.workspaceId, organizationId: null,
      path: filePath, representation, lifecycleGeneration: 1, schemaVersion: 1, documentSequence: text ? 7 : 0, persistedAt: 100,
      checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null, newlineStyle: 'crlf', hasBom: true,
      degraded: false, status: 'active', yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
  } finally { doc.destroy(); }
}
function observation(states: PersistedCollaborationState[], extras: ExtraPath[] = [],
  projection: string | null = null): WorkspaceLinkSourceAuthorityObservation {
  const inventories = states.map(value => inspectPersistedNativeCollaborationSnapshot(value, inspectNativeDocumentLinks));
  const nativeBindings: WorkspaceNativeSourceBinding[] = states.map((value, index) => ({
    expected: { documentId: value.documentId, lineageId: `lineage:${value.path}`, workspaceId: value.workspaceId,
      organizationId: value.organizationId, path: value.path, representation: value.representation, schemaVersion: value.schemaVersion,
      lifecycleGeneration: value.lifecycleGeneration, registryStateVersion: value.documentSequence, documentSequence: value.documentSequence,
      persistedAt: value.persistedAt, binaryHash: sha(value.yjsState), vectorHash: sha(value.stateVector), stateProof: inventories[index].version.stateProof },
    registry: { documentId: value.documentId, lineageId: `lineage:${value.path}`, workspaceId: value.workspaceId,
      workspaceType: 'personal', organizationId: null, customerId: null, projectId: null, path: value.path,
      provider: 'yjs', stateLifecycle: 'initialized', stateVersion: value.documentSequence, status: 'active' },
    lineage: { lineageId: `lineage:${value.path}`, workspaceId: value.workspaceId, workspaceType: 'personal', organizationId: null,
      customerId: null, projectId: null, path: value.path, status: 'active', archivedAt: null, trashEntryId: null },
    byteProfile: { newlineStyle: value.newlineStyle, hasBom: value.hasBom }, inventoryProof: nativeLinkJsonProof(inventories[index]),
  }));
  const namespace: NativeNamespaceEntry[] = states.map(value => ({ workspaceId: value.workspaceId, path: value.path, kind: 'file',
    identity: `registry:${value.documentId}:${value.lifecycleGeneration}`, filesystemIdentity: projection,
    documentId: value.documentId, lifecycleGeneration: value.lifecycleGeneration }));
  for (const [index, extra] of extras.entries()) {
    const filesystemIdentity = extra.identity === undefined ? `1:${100 + index}:0:100:100` : extra.identity;
    namespace.push({ workspaceId: scope.workspace.workspaceId, path: extra.path, kind: extra.kind ?? 'directory',
      identity: filesystemIdentity ?? `registry-directory:${extra.path}`, filesystemIdentity,
      documentId: null, lifecycleGeneration: null });
  }
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: scope.workspace.workspaceId,
    organizationId: null, catalogueProof: nativeLinkJsonProof(nativeBindings.map(binding => binding.registry)), namespace,
    sources: inventories.map(inventory => ({ kind: 'native', inventory })), scope: { kind: 'visible-workspace', excludedPaths: [] },
    coverage: { complete: true, gaps: [] }, readiness: 'native-coordinator-required', executionReady: false };
  return { stage: { ...body, stageProof: workspaceSourceAuthorityStageProof(body) }, nativeBindings, privateNativeStates: states };
}
function action(sourcePath: string, destinationPath: string, kind: 'move' | 'rename' = 'move'): WorkspaceOperationBatchAction {
  return { reviewId: 'native_move_action', kind, selections: [{ sourcePath, destinationPath }] };
}
function build(observed: WorkspaceLinkSourceAuthorityObservation, selected = action('target.md', 'moved.md')) {
  return createWorkspaceOperationNativeMoveBatchPlan({ scope, actions: [selected], observation: observed });
}
type Plan = ReturnType<typeof build>;
type Mutable<T> = T extends unknown ? { -readonly [Key in keyof T]: T[Key] } : never;
type MutablePlan = Mutable<Plan>;
function resign(plan: MutablePlan): Plan {
  const { planId: _id, ...body } = plan;
  plan.planId = computeWorkspaceOperationNativeMoveBatchPlanId(body); return plan;
}
function resignPathPlan(plan: MutablePlan): Plan {
  const { planId: _id, ...body } = plan.nativePathPlan;
  plan.nativePathPlan.planId = nativeLinkJsonProof(body); return resign(plan);
}
function current(plan: Plan, observed: WorkspaceLinkSourceAuthorityObservation) {
  return assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan, observed, captureWorkspaceOperationJobScope(scope.workspace));
}
function nativeInventory(observed: WorkspaceLinkSourceAuthorityObservation, index: number) {
  const source = observed.stage.sources[index]; assert(source?.kind === 'native'); return source.inventory;
}
function moveError(code: WorkspaceOperationNativeMovePlanError['code']) {
  return (error: unknown) => error instanceof WorkspaceOperationNativeMovePlanError && error.code === code;
}
function assertGraphTarget(graph: NativeMixedBatchPlan, originEvidenceLinkId: string,
  sourcePath: string, literal: string, targetPath: string): void {
  const source = graph.finalNamespace.find(entry => entry.path === sourcePath)!;
  const target = graph.finalNamespace.find(entry => entry.path === targetPath)!;
  assert(source, `Missing final source ${sourcePath}`); assert(target, `Missing final target ${targetPath}`);
  const edges = graph.finalEdges.filter(edge => edge.originEvidenceLinkId === originEvidenceLinkId);
  assert.equal(edges.length, 1, 'Exactly one final edge retains the genuine original native link identity.');
  assert.equal(edges[0].sourceEntityKey, source.entityKey); assert.equal(edges[0].literal, literal);
  assert.deepEqual(edges[0].resolution, { status: 'resolved', targetEntityKey: target.entityKey, candidateEntityKeys: [target.entityKey] });
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) for (const text of ['', 'Original']) {
  test(`native ${representation} ${text ? 'nonempty' : 'sequence-zero empty'} path plans retain exact native evidence`, () => {
    const original = state('target.md', text, representation), observed = observation([original]);
    const before = structuredClone(observed), plan = build(observed);
    assert.equal(plan.version, 3); assert.equal(plan.kind, 'native-path-change'); assert.equal(plan.readiness, 'ready');
    assert.equal(plan.executionReady, false); assert.equal(plan.workspaceId, scope.workspace.workspaceId);
    assert.deepEqual(plan.actions, [action('target.md', 'moved.md')]);
    assert.equal(plan.sourceEvidence.nativeBindings[0].expected.binaryHash, sha(original.yjsState));
    assert.equal(plan.sourceEvidence.nativeBindings[0].expected.vectorHash, sha(original.stateVector));
    assert.equal(plan.sourceEvidence.nativeBindings[0].expected.documentSequence, original.documentSequence);
    assert.deepEqual(plan.sourceEvidence.nativeBindings[0].byteProfile, { newlineStyle: 'crlf', hasBom: true });
    assert.equal(plan.nativePathPlan.readiness, 'ready'); assert.equal(plan.nativePathPlan.pathMappings.length, 1);
    assert.equal(plan.nativePathPlan.pathMappings[0].source.documentId, original.documentId);
    assert.equal(plan.nativePathPlan.pathMappings[0].destinationPath, 'moved.md');
    assert.match(plan.compilerPlanProof, /^[a-f0-9]{64}$/u); assert.match(plan.finalGraphProof, /^[a-f0-9]{64}$/u);
    const graph = current(plan, observed);
    assert.equal(graph.planId, plan.compilerPlanProof); assert.equal(graph.finalGraphProof, plan.finalGraphProof);
    assert.equal(graph.executionReady, false); assert.equal(graph.readiness, 'ready');
    assert.equal(graph.finalNamespace[0].path, 'moved.md');
    assert.equal(graph.finalNamespace[0].binding.kind, 'existing');
    assert.deepEqual(getWorkspaceOperationNativeMoveLinkRecipes(plan), []);
    const { planId: _id, ...body } = plan;
    assert.equal(computeWorkspaceOperationNativeMoveBatchPlanId(body), plan.planId);
    assert.deepEqual(decodeWorkspaceOperationNativeMoveBatchPlan(JSON.parse(JSON.stringify(plan))), plan);
    assert.equal(build(observed).planId, plan.planId);
    assert(Object.isFrozen(plan)); assert(Object.isFrozen(plan.actions)); assert(Object.isFrozen(plan.nativePathPlan));
    assert.deepEqual(observed, before, 'Planning does not mutate the observed native bytes or namespace.');
    const json = JSON.stringify(plan);
    for (const field of ['privateNativeStates', 'yjsState', 'finalNamespace', 'finalEdges', 'nativeGraphPlan', 'previewContents']) {
      assert.equal(json.includes(`"${field}"`), false, `${field} must not enter the persisted V3 DTO.`);
    }
  });
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  test(`genuine incoming and outgoing ${representation} links are rewritten with native references`, () => {
    const target = state('target.md', '[Keep](keep.md) [Outside](https://example.test/path)', representation);
    const incoming = state('incoming.md', '[**Target**](target.md) [Keep](keep.md)', representation);
    const observed = observation([target, incoming, state('keep.md', 'Keep', representation)], [{ path: 'folder' }]);
    const plan = build(observed, action('target.md', 'folder/target.md'));
    const recipes = getWorkspaceOperationNativeMoveLinkRecipes(plan), frozen = structuredClone(recipes);
    assert.equal(recipes.length, 2);
    const incomingRecipe = recipes.find(recipe => recipe.source.documentId === incoming.documentId)!;
    const outgoingRecipe = recipes.find(recipe => recipe.source.documentId === target.documentId)!;
    assert.equal(incomingRecipe.action, 'rewrite'); assert.equal(incomingRecipe.nextValue, 'folder/target.md');
    assert.equal(incomingRecipe.sourcePathAfter, 'incoming.md'); assert.equal(incomingRecipe.cloneSelection, null);
    assert.equal(outgoingRecipe.nextValue, '../keep.md'); assert.equal(outgoingRecipe.sourcePathAfter, 'folder/target.md');
    assert.equal(outgoingRecipe.reference.kind, representation === 'plain_text' ? 'plain-target' : 'link-mark');
    assert.equal(incomingRecipe.sourceVersion.stateProof, observed.nativeBindings[1].expected.stateProof);
    const graph = current(plan, observed);
    assert.equal(graph.steps.length, 1); assert.equal(graph.steps[0].linkIntents.length, 2);
    assert.equal(graph.finalEdges.filter(edge => edge.resolution.status === 'resolved').length, 3);
    const incomingInventory = nativeInventory(observed, 1);
    const targetInventory = nativeInventory(observed, 0);
    assertGraphTarget(graph, incomingRecipe.linkId, 'incoming.md', 'folder/target.md', 'folder/target.md');
    assertGraphTarget(graph, outgoingRecipe.linkId, 'folder/target.md', '../keep.md', 'keep.md');
    const keptLink = incomingInventory.links.find(link => link.targetPathText === 'keep.md')!;
    assertGraphTarget(graph, keptLink.id, 'incoming.md', 'keep.md', 'keep.md');
    const external = targetInventory.links.find(link => link.literal === 'https://example.test/path');
    if (external) {
      const edge = graph.finalEdges.find(edge => edge.originEvidenceLinkId === external.id)!;
      assert.equal(edge.sourceEntityKey, graph.finalNamespace.find(entry => entry.path === 'folder/target.md')!.entityKey);
      assert.equal(edge.literal, external.literal);
      assert.deepEqual(edge.resolution, { status: 'external', targetEntityKey: null, candidateEntityKeys: [] });
    }
    for (const original of [incoming, target]) {
      const selected = frozen.filter(recipe => recipe.source.documentId === original.documentId);
      const prepared = prepareNativeLinkMutations({ state: original, recipes: selected, operationId: `move-plan-${representation}-${original.path}` });
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, original.yjsState); Y.applyUpdate(doc, prepared.update);
        const after = { ...original, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
        const inventory = inspectPersistedNativeCollaborationSnapshot(after, inspectNativeDocumentLinks);
        assert(inventory.links.some(link => link.literal === selected[0].nextValue));
        assert.equal(inventory.coverage.complete, true);
        if (original === target) assert.match(JSON.stringify(authoritativeNativeCollaborationSnapshot(after).content), /https:\/\/example\.test\/path/u);
      } finally { doc.destroy(); }
    }
    recipes[0].nextValue = 'forged.md';
    assert.deepEqual(getWorkspaceOperationNativeMoveLinkRecipes(plan), frozen, 'Each extraction returns fresh recipes.');
  });
}

test('folder move includes native-only descendants and PDF/JPG assets while preserving internal and external targets', () => {
  const observed = observation([
    state('bundle/note.md', '[PDF](paper.pdf) [Keep](../keep.md) [Outside](https://example.test)\n\n![Photo](photo.jpg)'),
    state('incoming.md', '[Note](bundle/note.md) [PDF](bundle/paper.pdf)\n\n![Photo](bundle/photo.jpg)'),
    state('keep.md', 'Keep'),
  ], [{ path: 'bundle' }, { path: 'bundle/paper.pdf', kind: 'file' }, { path: 'bundle/photo.jpg', kind: 'file' }]);
  const plan = build(observed, action('bundle', 'moved'));
  assert.deepEqual(plan.nativePathPlan.pathMappings.map(mapping => mapping.source.path).sort(),
    ['bundle', 'bundle/note.md', 'bundle/paper.pdf', 'bundle/photo.jpg']);
  const recipes = getWorkspaceOperationNativeMoveLinkRecipes(plan);
  assert.equal(recipes.length, 3, 'Only incoming links change when internal relative targets remain correct.');
  assert.deepEqual(recipes.map(recipe => recipe.nextValue).sort(), ['moved/note.md', 'moved/paper.pdf', 'moved/photo.jpg']);
  const graph = current(plan, observed);
  assert.equal(graph.finalNamespace.some(entry => entry.path === 'bundle' || entry.path.startsWith('bundle/')), false);
  assert(graph.finalNamespace.some(entry => entry.path === 'moved/paper.pdf'));
  assert.equal(graph.finalEdges.filter(edge => edge.resolution.status === 'resolved').length, 6);
  for (const source of observed.stage.sources) {
    assert(source.kind === 'native');
    for (const link of source.inventory.links.filter(link => link.classification === 'local')) {
      const incoming = source.inventory.document.path === 'incoming.md';
      const sourcePath = incoming ? 'incoming.md' : 'moved/note.md';
      const targetPath = incoming ? link.targetPathText.replace(/^bundle\//u, 'moved/')
        : link.targetPathText.startsWith('../') ? 'keep.md' : `moved/${link.targetPathText}`;
      assertGraphTarget(graph, link.id, sourcePath, incoming ? targetPath : link.literal, targetPath);
    }
  }
});

test('a selected PDF with incoming native links requires no fabricated native identity on the asset', () => {
  const observed = observation([state('note.md', '[PDF](report.pdf) [Keep](keep.md)'), state('keep.md', 'Keep')],
    [{ path: 'report.pdf', kind: 'file' }, { path: 'assets' }]);
  const plan = build(observed, action('report.pdf', 'assets/report.pdf'));
  assert.equal(plan.nativePathPlan.pathMappings[0].source.documentId, null);
  assert.equal(plan.nativePathPlan.pathMappings[0].source.lifecycleGeneration, null);
  assert.equal(getWorkspaceOperationNativeMoveLinkRecipes(plan)[0].nextValue, 'assets/report.pdf');
  const graph = current(plan, observed);
  assert.equal(graph.finalNamespace.find(entry => entry.path === 'assets/report.pdf')!.binding.kind, 'existing');
  assertGraphTarget(graph, getWorkspaceOperationNativeMoveLinkRecipes(plan)[0].linkId, 'note.md', 'assets/report.pdf', 'assets/report.pdf');
});

test('one action may move several independent selections against one complete native namespace', () => {
  const observed = observation([state('a.md', '[B](b.md)'), state('b.md', 'B'), state('incoming.md', '[A](a.md) [B](b.md)')], [{ path: 'folder' }]);
  const selected = action('a.md', 'folder/a.md'); selected.selections.push({ sourcePath: 'b.md', destinationPath: 'folder/b.md' });
  const plan = build(observed, selected), graph = current(plan, observed);
  assert.equal(plan.nativePathPlan.pathMappings.length, 2); assert.equal(graph.steps.length, 1);
  assert.deepEqual(getWorkspaceOperationNativeMoveLinkRecipes(plan).map(recipe => recipe.nextValue).sort(), ['folder/a.md', 'folder/b.md']);
  assertGraphTarget(graph, nativeInventory(observed, 0).links[0].id, 'folder/a.md', 'b.md', 'folder/b.md');
  for (const link of nativeInventory(observed, 2).links) {
    assertGraphTarget(graph, link.id, 'incoming.md', `folder/${link.targetPathText}`, `folder/${link.targetPathText}`);
  }
  assert.deepEqual(plan.actions[0].selections, selected.selections);
});

test('rename retains whitespace spelling and native identity without requiring a Markdown projection', () => {
  const observed = observation([state(' note .md', 'Original'), state('incoming.md', '[Target](%20note%20.md)')]);
  const plan = build(observed, action(' note .md', ' renamed .md', 'rename'));
  assert.equal(plan.nativePathPlan.kind, 'rename'); assert.equal(plan.nativePathPlan.pathMappings[0].source.path, ' note .md');
  assert.equal(getWorkspaceOperationNativeMoveLinkRecipes(plan)[0].nextValue, '%20renamed%20.md');
  const graph = current(plan, observed);
  assert.equal(graph.finalNamespace.find(entry => entry.path === ' renamed .md')!.binding.kind, 'existing');
});

test('a native-only unexportable rich table can move and retain targeted link recipes', () => {
  const rich = state('target.md', '| Keep |\n| --- |\n| [Keep](keep.md) |', 'tiptap_blocks', doc => {
    const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
    for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
      (record.get('attributes') as Y.Map<unknown>).set('colwidth', [120]);
    }
    assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
  });
  const observed = observation([rich, state('keep.md', 'Keep')], [{ path: 'folder' }]);
  const plan = build(observed, action('target.md', 'folder/target.md'));
  assert.equal(plan.sourceEvidence.stage.namespace[0].filesystemIdentity, null);
  assert.equal(getWorkspaceOperationNativeMoveLinkRecipes(plan)[0].nextValue, '../keep.md');
  assert.equal(current(plan, observed).readiness, 'ready');
});

test('collisions, ambiguous basename capture and overlapping selections never produce ready plans', () => {
  assert.throws(() => build(observation([state('target.md'), state('moved.md')])));
  const ambiguity = observation([state('note.md', '[[Target]]'), state('one/Target.md'), state('other.md')],
    [{ path: 'one' }, { path: 'two' }]);
  assert.throws(() => build(ambiguity, action('other.md', 'two/Target.md')));
  const observed = observation([state('bundle/note.md')], [{ path: 'bundle' }]);
  const overlap = action('bundle', 'moved'); overlap.selections.push({ sourcePath: 'bundle/note.md', destinationPath: 'other.md' });
  assert.throws(() => build(observed, overlap));
});

test('unchanged, cyclic, missing and file-parent paths are rejected before a native Move plan is returned', () => {
  const observed = observation([state('target.md'), state('bundle/note.md')], [{ path: 'bundle' }]);
  for (const selected of [action('target.md', 'target.md'), action('bundle', 'bundle/child'),
    action('missing.md', 'moved.md'), action('target.md', 'bundle/note.md/child.md'),
    action('target.md', '../escape.md'), action('target.md', 'invalid\ud800.md')]) {
    assert.throws(() => build(observed, selected));
  }
});

test('action contract rejects unsupported kinds, extra actions and zero or excessive selections', () => {
  const observed = observation([state('target.md')]);
  const invalid: WorkspaceOperationBatchAction[][] = [[], [action('target.md', 'moved.md'), action('target.md', 'other.md')],
    [{ reviewId: 'delete', kind: 'delete', selections: [{ sourcePath: 'target.md' }] }],
    [{ ...action('target.md', 'moved.md'), ignoreMissing: true }], [{ ...action('target.md', 'moved.md'), selections: [] }],
    [{ ...action('target.md', 'moved.md'), selections: Array.from({ length: 1001 }, () => ({ sourcePath: 'target.md', destinationPath: 'moved.md' })) }]];
  for (const actions of invalid) assert.throws(() => createWorkspaceOperationNativeMoveBatchPlan({ scope, actions, observation: observed }));
});

test('the exact 1000-selection contract accepts 1000 genuine independent physical assets', () => {
  const extras: ExtraPath[] = Array.from({ length: 1000 }, (_, index) => ({ path: `asset-${index}.bin`, kind: 'file' }));
  const observed = observation([state('keep.md', 'Unchanged native document')], extras);
  const selected: WorkspaceOperationBatchAction = { reviewId: 'asset_move_limit', kind: 'move',
    selections: extras.map(extra => ({ sourcePath: extra.path, destinationPath: `moved-${extra.path}` })) };
  const plan = build(observed, selected), graph = current(plan, observed);
  assert.equal(plan.actions[0].selections.length, 1000); assert.equal(plan.nativePathPlan.pathMappings.length, 1000);
  assert.equal(graph.finalNamespace.length, 1001); assert.equal(graph.finalEdges.length, 0);
  assert(graph.finalNamespace.some(entry => entry.path === 'keep.md'));
  for (const extra of extras) {
    const moved = graph.finalNamespace.find(entry => entry.path === `moved-${extra.path}`)!;
    assert(moved); assert.equal(moved.binding.kind, 'existing');
    if (moved.binding.kind === 'existing') assert.equal(moved.binding.namespaceEvidence.path, extra.path);
  }
});

test('valid selected folder roots cannot overflow the derived descendant path length or depth', () => {
  const observed = observation([state('a/note.md')], [{ path: 'a' }, { path: 'a/f.bin', kind: 'file' }]);
  const validRootButLongChild = action('a', 'd'.repeat(4096));
  const validRootButDeepChild = action('a', Array.from({ length: 33 }, () => 'd').join('/'));
  assert.throws(() => build(observed, validRootButLongChild), moveError('NATIVE_MOVE_PLAN_UNSUPPORTED'));
  assert.throws(() => build(observed, validRootButDeepChild), moveError('NATIVE_MOVE_PLAN_UNSUPPORTED'));
  for (const destination of ['d'.repeat(4096 - '/note.md'.length), Array.from({ length: 32 }, () => 'd').join('/')]) {
    const plan = build(observed, action('a', destination));
    assert.equal(plan.nativePathPlan.pathMappings.find(mapping => mapping.source.path === 'a/note.md')!.destinationPath, `${destination}/note.md`);
    assert.equal(current(plan, observed).readiness, 'ready');
  }
});

test('producer action capture refuses accessors without executing them', () => {
  const observed = observation([state('target.md')]), selected = action('target.md', 'moved.md'); let getters = 0;
  Object.defineProperty(selected, 'selections', { enumerable: true, get() { getters++; return [{ sourcePath: 'target.md', destinationPath: 'moved.md' }]; } });
  assert.throws(() => build(observed, selected)); assert.equal(getters, 0);
});

test('producer captures top-level inputs and scope workspace as own data without calling accessors', () => {
  const observed = observation([state('target.md')]), selected = action('target.md', 'moved.md'); let getters = 0;
  for (const key of ['scope', 'actions', 'observation'] as const) {
    const request = { scope, actions: [selected], observation: observed }, value = request[key];
    Object.defineProperty(request, key, { enumerable: true, get() { getters++; return value; } });
    assert.throws(() => createWorkspaceOperationNativeMoveBatchPlan(request));
  }
  const accessorScope = { ...scope };
  Object.defineProperty(accessorScope, 'workspace', { enumerable: true, get() { getters++; return scope.workspace; } });
  assert.throws(() => createWorkspaceOperationNativeMoveBatchPlan({ scope: accessorScope, actions: [selected], observation: observed }));
  assert.equal(getters, 0);
});

test('historical decoder rejects envelope version, shape, self-hash and embedded binary or compiler graph fields', () => {
  const plan = build(observation([state('target.md')]));
  for (const change of [{ version: 1 }, { version: 2 }, { kind: 'native-original-delete' }, { readiness: 'blocked' },
    { executionReady: true }, { actions: null }, { nativePathPlan: null }, { planId: '0'.repeat(64) },
    { compilerPlanProof: 'invalid' }, { finalGraphProof: null }, { nativeGraphPlan: {} }, { privateNativeStates: [] }, { yjsState: new Uint8Array([1]) }]) {
    assert.throws(() => decodeWorkspaceOperationNativeMoveBatchPlan({ ...plan, ...change }));
  }
});

test('derived native path recipes cannot be hidden or forged even after both self-hashes are renewed', () => {
  const observed = observation([state('target.md'), state('incoming.md', '[Target](target.md)')]), plan = build(observed);
  const attacks: Array<(value: MutablePlan) => void> = [
    value => { value.nativePathPlan.mutations = []; },
    value => { value.nativePathPlan.mutations[0].nextValue = 'wrong.md'; },
    value => { value.nativePathPlan.mutations[0].sourcePathAfter = 'wrong.md'; },
    value => { value.nativePathPlan.mutations[0].expectedTargetIdentity = 'forged-target'; },
    value => { value.nativePathPlan.mutations[0].sourceVersion.documentSequence++; },
    value => { value.nativePathPlan.pathMappings[0].source.identity = 'forged-source'; },
    value => { value.nativePathPlan.pathMappings[0].destinationPath = 'wrong.md'; },
    value => { value.nativePathPlan.snapshotProofs[0].proof = '0'.repeat(64); },
  ];
  for (const attack of attacks) {
    const forged: MutablePlan = structuredClone(plan); attack(forged); resignPathPlan(forged);
    assert.throws(() => decodeWorkspaceOperationNativeMoveBatchPlan(forged));
  }
});

for (const field of ['compilerPlanProof', 'finalGraphProof'] as const) {
  test(`historical decode of a rehashed opaque ${field} is never current compiler authority`, () => {
    const observed = observation([state('target.md'), state('incoming.md', '[Target](target.md)')]), plan = build(observed);
    const forged: MutablePlan = structuredClone(plan); forged[field] = `${forged[field][0] === '0' ? '1' : '0'}${forged[field].slice(1)}`; resign(forged);
    const historical = decodeWorkspaceOperationNativeMoveBatchPlan(forged);
    assert.equal(historical[field], forged[field], 'The historical decoder checks syntax without private native binaries.');
    assert.throws(() => current(historical, observed), moveError('NATIVE_MOVE_PLAN_CHANGED'));
    const genuine = current(plan, observed);
    assert.equal(genuine.planId, plan.compilerPlanProof); assert.equal(genuine.finalGraphProof, plan.finalGraphProof);
  });
}

test('strict data capture rejects getters, symbols, cycles, sparse arrays and custom prototypes without executing code', () => {
  const plan = build(observation([state('target.md')])); let getters = 0;
  const accessor = { ...plan };
  Object.defineProperty(accessor, 'nativePathPlan', { enumerable: true, get() { getters++; return plan.nativePathPlan; } });
  assert.throws(() => decodeWorkspaceOperationNativeMoveBatchPlan(accessor));
  const arrayAccessor = structuredClone(plan);
  Object.defineProperty(arrayAccessor.actions, '0', { enumerable: true, get() { getters++; return plan.actions[0]; } });
  assert.throws(() => decodeWorkspaceOperationNativeMoveBatchPlan(arrayAccessor)); assert.equal(getters, 0);
  const cyclic = { ...plan, cycle: null as unknown }; cyclic.cycle = cyclic;
  assert.throws(() => decodeWorkspaceOperationNativeMoveBatchPlan(cyclic));
  const sparse = structuredClone(plan); Reflect.deleteProperty(sparse.actions, '0');
  assert.throws(() => decodeWorkspaceOperationNativeMoveBatchPlan(sparse));
  assert.throws(() => decodeWorkspaceOperationNativeMoveBatchPlan({ ...plan, [Symbol('hidden')]: true }));
  assert.throws(() => decodeWorkspaceOperationNativeMoveBatchPlan(Object.assign(Object.create({ inherited: true }), plan)));
});

test('bounded historical capture reports an explicit size error before accepting an oversized payload', () => {
  const plan = build(observation([state('target.md')]));
  assert.throws(() => decodeWorkspaceOperationNativeMoveBatchPlan({ ...plan, oversized: 'x'.repeat(16 * 1024 * 1024 + 1) }),
    moveError('NATIVE_MOVE_PLAN_TOO_LARGE'));
});

test('projection replacement and directory timestamp drift are allowed while original graph proofs remain exact', () => {
  const observed = observation([state('target.md'), state('incoming.md', '[Target](target.md)')], [{ path: 'folder', identity: '1:2:0:100:100' }]);
  const plan = build(observed, action('target.md', 'folder/target.md')), changed = structuredClone(observed);
  changed.stage.namespace[0].filesystemIdentity = '1:3:200:300:400';
  const directory = changed.stage.namespace.find(entry => entry.path === 'folder')!;
  directory.identity = '1:2:0:900:901'; directory.filesystemIdentity = directory.identity;
  changed.stage.stageProof = workspaceSourceAuthorityStageProof(changed.stage);
  const graph = current(plan, changed);
  assert.equal(graph.planId, plan.compilerPlanProof); assert.equal(graph.finalGraphProof, plan.finalGraphProof);
  directory.identity = '1:9:0:900:901'; directory.filesystemIdentity = directory.identity;
  changed.stage.stageProof = workspaceSourceAuthorityStageProof(changed.stage);
  assert.throws(() => current(plan, changed));
});

test('current validation rejects peer state, generation, byte profile, scope and selected asset drift', () => {
  const original = state('target.md'), observed = observation([original], [{ path: 'report.pdf', kind: 'file' }]), plan = build(observed);
  for (const modified of [state('target.md', 'Peer edit'), { ...original, lifecycleGeneration: 2 },
    { ...original, newlineStyle: 'lf' as const }, { ...original, hasBom: false }]) {
    assert.throws(() => current(plan, observation([modified], [{ path: 'report.pdf', kind: 'file' }])));
  }
  assert.throws(() => assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan, observed,
    { ...captureWorkspaceOperationJobScope(scope.workspace), rootPath: '/other' }));
  const assetPlan = build(observed, action('report.pdf', 'renamed.pdf')), changed = structuredClone(observed);
  changed.stage.namespace[1].identity = '1:101:3:200:200'; changed.stage.namespace[1].filesystemIdentity = '1:101:3:200:200';
  changed.stage.stageProof = workspaceSourceAuthorityStageProof(changed.stage);
  assert.throws(() => current(assetPlan, changed));
});

test('incomplete coverage and physical Markdown sources are never filtered into a ready native Move plan', () => {
  const incomplete = observation([state('target.md')]);
  incomplete.stage.coverage = { complete: false, gaps: [{ code: 'unreadable-source', path: 'incoming.md' }] };
  incomplete.stage.stageProof = workspaceSourceAuthorityStageProof(incomplete.stage);
  assert.throws(() => build(incomplete));
  const physical = observation([state('target.md')]); physical.stage.sources.push({ kind: 'physical', inventory: {} as never });
  assert.throws(() => build(physical));
});

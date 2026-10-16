import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Module, { createRequire } from 'node:module';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';
import { PGlite } from '@electric-sql/pglite';
import type { SqlConnection } from '../app/lib/db';
import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions,
  validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { authoritativeNativeCollaborationSnapshot, inspectPersistedNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { inspectNativeDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { prepareNativeLinkMutations } from '../app/lib/markdown/workspace-native-link-mutations';
import { compileWorkspaceNativeMixedBatch } from '../app/lib/markdown/workspace-native-mixed-batch-compiler';
import { captureWorkspaceOperationNativeSourceEvidence, WorkspaceOperationNativeSourceEvidenceError } from '../app/lib/files/workspace-operation-native-source-evidence';
import { inspectOriginalPhysicalLinks, workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import { createWorkspaceOperationNativeDeleteBatchPlan, decodeWorkspaceOperationNativeDeleteBatchPlan,
  assertWorkspaceOperationNativeDeleteBatchPlanCurrent, computeWorkspaceOperationNativeDeleteBatchPlanId,
  getWorkspaceOperationNativeDeleteLinkRecipes } from '../app/lib/files/workspace-operation-native-delete-plan';
import { createWorkspaceOperationBatchPlan, computeWorkspaceOperationBatchPlanId,
  buildWorkspaceOperationBatchPlan, workspaceOperationBatchPublicPreview } from '../app/lib/files/workspace-operation-batch-plan';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { WorkspaceOperationBatchStore } from '../app/lib/files/workspace-operation-batch-store';

// Pure producer/codec/compiler fixtures using real Yjs. Registry/L1 facts below
// are declared fixture observations, not SQL, current rights or owner proof.
const scope: WorkspaceOperationBatchScope = { workspace: { workspaceId: 'native-plan-workspace', rootPath: '/fixture/workspace',
  rootRelativePath: 'users/fixture/workspace', workspaceType: 'personal', organizationId: null, ownerUserId: 'fixture-user', legacy: false,
  status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
    canManageWorkspace: true, canCreatePublicLinks: false } }, fileOptions: {} };
const actions = [{ reviewId: 'native_delete_action', kind: 'delete' as const, selections: [{ sourcePath: ' note .md' }] }];
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function state(representation: PersistedCollaborationState['representation'] = 'tiptap_blocks', text = 'Original',
  filePath = ' note .md', prepare?: (doc: Y.Doc) => void): PersistedCollaborationState {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
  try { prepare?.(doc); return { documentId: `document:${filePath}`, workspaceId: scope.workspace.workspaceId, organizationId: null,
    path: filePath, representation, lifecycleGeneration: 1, schemaVersion: 1, documentSequence: text ? 7 : 0, persistedAt: 100,
    checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null, newlineStyle: 'crlf', hasBom: true,
    degraded: false, status: 'active', yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
  } finally { doc.destroy(); }
}
function observation(states: PersistedCollaborationState[], projection: string | null = null): WorkspaceLinkSourceAuthorityObservation {
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
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: scope.workspace.workspaceId,
    organizationId: null, catalogueProof: nativeLinkJsonProof(nativeBindings.map(binding => binding.registry)),
    namespace: states.map(value => ({ workspaceId: value.workspaceId, path: value.path, kind: 'file',
      identity: `registry:${value.documentId}:${value.lifecycleGeneration}`, filesystemIdentity: projection,
      documentId: value.documentId, lifecycleGeneration: value.lifecycleGeneration })),
    sources: inventories.map(inventory => ({ kind: 'native', inventory })), scope: { kind: 'visible-workspace', excludedPaths: [] },
    coverage: { complete: true, gaps: [] }, readiness: 'native-coordinator-required', executionReady: false };
  return { stage: { ...body, stageProof: workspaceSourceAuthorityStageProof(body) }, nativeBindings, privateNativeStates: states };
}
const build = (observed: WorkspaceLinkSourceAuthorityObservation) => createWorkspaceOperationNativeDeleteBatchPlan({ scope, actions, observation: observed });

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) for (const text of ['', 'Original']) {
  test(`native ${representation} ${text ? 'nonempty' : 'seq0 empty'} plans retain exact binary/clock/byte-profile facts`, () => {
    const original = state(representation, text), observed = observation([original]), plan = build(observed);
    assert.equal(plan.version, 2); assert.equal(plan.kind, 'native-original-delete'); assert.equal(plan.readiness, 'ready');
    assert.equal(plan.nativeTarget.binaryHash, sha(original.yjsState)); assert.equal(plan.nativeTarget.vectorHash, sha(original.stateVector));
    assert.equal(plan.nativeTarget.documentSequence, original.documentSequence); assert.equal(plan.nativeTarget.path, ' note .md');
    assert.deepEqual(plan.sourceEvidence.nativeBindings[0].byteProfile, { newlineStyle: 'crlf', hasBom: true });
    assert.equal(plan.nativeGraphPlan.readiness, 'ready'); assert.equal(plan.nativeGraphPlan.steps[0].linkIntents.length, 0);
    assert.equal(plan.nativeGraphPlan.executionReady, false); assert.equal(plan.pathSteps.length, 1);
    assert.equal(plan.deletedPaths[0].identity, `native:${plan.nativeTarget.stateProof}`);
    assert.equal(plan.expectedPathState[0].identity, null); assert.equal(plan.expectedPathState[0].contentHash, null);
    assert(!Object.hasOwn(plan, 'linkPlan')); assert.deepEqual(plan.originalDocuments, []); assert.deepEqual(plan.deletedDocuments, []);
    assert.deepEqual(plan.previewContents, []); assert.deepEqual(plan.linkEdits, []); assert.deepEqual(plan.pathMappings, []);
    assert.equal(computeWorkspaceOperationBatchPlanId(plan), plan.planId);
    const { planId: _id, ...body } = plan; assert.equal(computeWorkspaceOperationNativeDeleteBatchPlanId(body), plan.planId);
    assert.deepEqual(decodeWorkspaceOperationNativeDeleteBatchPlan(JSON.parse(JSON.stringify(plan))), plan);
    assert(Object.isFrozen(plan)); assert(Object.isFrozen(plan.nativeTarget));
    assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, observed, captureWorkspaceOperationJobScope(scope.workspace));
  });
}
test('actual unexportable .md native content is ready without Markdown serialization or fabricated path hash', () => {
  const original = state('tiptap_blocks', '| Keep |\n| --- |\n| native |', undefined, doc => {
    const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
    for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
      (record.get('attributes') as Y.Map<unknown>).set('colwidth', [120]);
    }
    assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
  });
  const plan = build(observation([original])); assert.equal(plan.readiness, 'ready'); assert.equal(plan.expectedPathState[0].contentHash, null);
  assert.equal(plan.nativeTarget.binaryHash, sha(original.yjsState)); assert.equal(plan.sourceEvidence.stage.coverage.complete, true);
});
for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) test(`genuine incoming ${representation} links produce exact original-source unlink recipes and deterministic native graph`, () => {
  const target = state(), incoming = state(representation,
    '# [Target](%20note%20.md)\n\n[Keep](keep.md) [External](https://example.test)', 'incoming.md');
  const observed = observation([target, incoming, state('tiptap_blocks', 'Keep', 'keep.md')]), plan = build(observed);
  const recipes = getWorkspaceOperationNativeDeleteLinkRecipes(plan);
  assert.equal(plan.version, 2); assert.equal(plan.readiness, 'ready'); assert.equal(plan.nativeGraphPlan.executionReady, false);
  assert.equal(recipes.length, 1); assert.equal(plan.nativeGraphPlan.steps[0].linkIntents.length, 1);
  assert.deepEqual(plan.linkEdits, []); assert.deepEqual(plan.previewContents, []); assert.deepEqual(plan.originalDocuments, []);
  assert.equal(recipes[0].source.documentId, incoming.documentId); assert.equal(recipes[0].source.path, incoming.path);
  assert.equal(recipes[0].action, 'unlink'); assert.equal(recipes[0].nextValue, null); assert.equal(recipes[0].cloneSelection, null);
  assert.equal(recipes[0].sourcePathAfter, incoming.path); assert.equal(recipes[0].destinationWorkspaceId, incoming.workspaceId);
  assert.equal(recipes[0].sourceVersion.stateProof, observed.nativeBindings[1].expected.stateProof);
  assert.equal(recipes[0].expectedTargetIdentity, observed.stage.namespace[0].identity);
  const original = structuredClone(recipes); recipes[0].action = 'rewrite';
  assert.deepEqual(getWorkspaceOperationNativeDeleteLinkRecipes(plan), original, 'Every call derives fresh recipes from original source evidence.');
  // Real native preparation on disposable Yjs bytes proves the recipe preserves
  // the authored label and the unrelated links. This is not a durable write.
  const prepared = prepareNativeLinkMutations({ state: incoming, recipes: original, operationId: 'native-delete-plan-forward-test' });
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, incoming.yjsState); Y.applyUpdate(doc, prepared.update);
    const after = { ...incoming, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
    const links = inspectPersistedNativeCollaborationSnapshot(after, inspectNativeDocumentLinks).links;
    assert.equal(links.some(link => link.targetPathText === ' note .md'), false);
    assert.equal(links.some(link => link.targetPathText === 'keep.md'), true);
    assert.match(JSON.stringify(authoritativeNativeCollaborationSnapshot(after).content), /Target/u);
    assert.equal(prepared.inverseRecipes.length, 1);
  } finally { doc.destroy(); }
  assert.deepEqual(decodeWorkspaceOperationNativeDeleteBatchPlan(JSON.parse(JSON.stringify(plan))), plan);
  assert.deepEqual(build(observed).nativeGraphPlan, plan.nativeGraphPlan, 'Two genuine compilations expose identical complete public compiler results.');
  assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, observed, captureWorkspaceOperationJobScope(scope.workspace));
});
test('several incoming sources/links preserve the compiler intent order and retain all independent graph edges', () => {
  const observed = observation([state(), state('tiptap_blocks', '[[/ note .md|Alias]] [Target](%20note%20.md)', 'a.md'),
    state('plain_text', '[Second](%20note%20.md)\n[Keep](keep.md)', 'b.md'), state('tiptap_xml', 'Keep', 'keep.md')]);
  const plan = build(observed), recipes = getWorkspaceOperationNativeDeleteLinkRecipes(plan);
  assert.equal(recipes.length, 3); assert.equal(plan.nativeGraphPlan.steps[0].linkIntents.length, 3);
  assert.equal(plan.nativeGraphPlan.finalEdges.length, 1); assert.equal(plan.nativeGraphPlan.finalEdges[0].targetPathText, 'keep.md');
  assert.equal(plan.nativeGraphPlan.finalEdges[0].resolution.status, 'resolved');
  assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, observed, captureWorkspaceOperationJobScope(scope.workspace));
});
test('links originating inside the deleted target require no surviving-source mutation', () => {
  const observed = observation([state('tiptap_blocks', '[Self](%20note%20.md) [Keep](keep.md)'), state('tiptap_xml', 'Keep', 'keep.md')]);
  const plan = build(observed); assert.deepEqual(getWorkspaceOperationNativeDeleteLinkRecipes(plan), []);
  assert.deepEqual(plan.nativeGraphPlan.steps[0].linkIntents, []); assert.deepEqual(plan.nativeGraphPlan.finalEdges, []);
  assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, observed, captureWorkspaceOperationJobScope(scope.workspace));
});
test('unsupported reference-style unlink remains blocked and physical Markdown never becomes a native recipe', () => {
  assert.throws(() => build(observation([state(), state('plain_text', '[Target][ref]\n\n[ref]: %20note%20.md', 'incoming.md')])));
  const observed = observation([state()]); observed.stage.sources.push({ kind: 'physical', inventory: {} as never });
  assert.throws(() => build(observed));
});
test('historical decoder independently rejects real incoming links hidden by renewed mixed-graph and plan self-hashes', () => {
  const target = state(), observed = observation([target, state('tiptap_blocks', '[Target](%20note%20.md)', 'incoming.md')]);
  const sourceEvidence = captureWorkspaceOperationNativeSourceEvidence(captureWorkspaceOperationJobScope(scope.workspace), observed);
  const snapshotBody = { contractVersion: 2 as const, workspaceId: scope.workspace.workspaceId, namespace: observed.stage.namespace,
    documents: observed.stage.sources.flatMap(source => source.kind === 'native' ? [source.inventory] : []), coverage: { complete: true, gaps: [] } };
  const graph = compileWorkspaceNativeMixedBatch({ snapshots: [{ ...snapshotBody, snapshotProof: nativeLinkJsonProof(snapshotBody) }],
    states: observed.privateNativeStates, requests: [{ kind: 'delete', sourceWorkspaceId: scope.workspace.workspaceId,
      destinationWorkspaceId: scope.workspace.workspaceId, selections: actions[0].selections }] });
  assert.equal(graph.readiness, 'ready'); assert.equal(graph.steps[0].linkIntents.length, 1);
  const { planId: _graphId, ...graphBody } = graph;
  const forgedGraphBody = { ...graphBody, steps: graphBody.steps.map(step => ({ ...step, linkIntents: [] })) };
  const base = build(observation([target])); const { planId: _planId, ...baseBody } = base;
  const body = { ...baseBody, sourceEvidence, nativeGraphPlan: { ...forgedGraphBody, planId: nativeLinkJsonProof(forgedGraphBody) } };
  const forged = { ...body, planId: computeWorkspaceOperationNativeDeleteBatchPlanId(body) };
  assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlan(forged), error => error instanceof Error
    && error.message === 'NATIVE_DELETE_PLAN_UNSUPPORTED');
});
function resignGraphAndPlan(plan: ReturnType<typeof build>, finalGraph = true): ReturnType<typeof build> {
  if (finalGraph) {
    plan.nativeGraphPlan.finalGraphProof = nativeLinkJsonProof({ namespace: plan.nativeGraphPlan.finalNamespace, edges: plan.nativeGraphPlan.finalEdges });
    plan.nativeGraphPlan.steps[0].afterGraphProof = plan.nativeGraphPlan.finalGraphProof;
  }
  const { planId: _graphId, ...graphBody } = plan.nativeGraphPlan;
  plan.nativeGraphPlan.planId = nativeLinkJsonProof(graphBody);
  plan.planId = computeWorkspaceOperationNativeDeleteBatchPlanId(plan); return plan;
}
test('renewed graph and envelope self-hashes cannot fabricate or hide incoming unlink intents, bindings or final edges', () => {
  const observed = observation([state(), state('tiptap_blocks', '[Target](%20note%20.md) [Keep](keep.md)', 'incoming.md'), state('tiptap_xml', 'Keep', 'keep.md')]);
  const plan = build(observed);
  const attacks: Array<(value: ReturnType<typeof build>) => void> = [
    value => { value.nativeGraphPlan.steps[0].linkIntents = []; },
    value => { value.nativeGraphPlan.steps[0].linkIntents[0].originEvidenceLinkId = 'forged-original-link'; },
    value => { value.nativeGraphPlan.steps[0].linkIntents[0].expectedValue = 'other.md'; },
    value => { value.nativeGraphPlan.steps[0].linkIntents[0].expectedTargetEntityKey = '0'.repeat(64); },
    value => { value.nativeGraphPlan.steps[0].linkIntents[0].entityKey = '0'.repeat(64); },
    value => { value.nativeGraphPlan.steps[0].linkIntents[0].action = 'rewrite'; },
    value => { value.nativeGraphPlan.steps[0].linkIntents[0].targetEntityKeyAfter = '0'.repeat(64); },
    value => { value.nativeGraphPlan.steps[0].linkIntents.push(structuredClone(value.nativeGraphPlan.steps[0].linkIntents[0])); },
    value => { value.nativeGraphPlan.steps[0].namespaceEffects[0].sourceEntityKey = '0'.repeat(64); },
    value => { value.nativeGraphPlan.steps[0].namespaceEffects[0].destinationWorkspaceId = 'foreign-workspace'; },
    value => { value.nativeGraphPlan.steps[0].requestIndex = 1; },
    value => { value.nativeGraphPlan.requests[0].kind = 'copy'; },
    value => { value.nativeGraphPlan.documentEvidence[0].evidenceKey = '0'.repeat(64); },
    value => { value.nativeGraphPlan.snapshotProofs[0].proof = '0'.repeat(64); },
    value => { value.nativeGraphPlan.finalNamespace[0].binding = { kind: 'unbound-copy', sourceEntityKey: 'forged-copy', createdAtRequest: 0 }; },
    value => { value.nativeGraphPlan.finalNamespace[0].path = 'forged-survivor.md'; },
    value => { value.nativeGraphPlan.finalNamespace.push(structuredClone(value.nativeGraphPlan.finalNamespace[0])); },
    value => { value.nativeGraphPlan.finalEdges = []; },
    value => { value.nativeGraphPlan.finalEdges[0].resolution.targetEntityKey = '0'.repeat(64); },
    value => { value.nativeGraphPlan.finalEdges[0].originEvidenceLinkId = 'forged-retained-link'; },
    value => { Reflect.set(value.nativeGraphPlan, 'requiredCoordinatorBindings', []); },
    value => { Reflect.set(value.nativeGraphPlan, 'arbitraryAuthority', true); },
  ];
  for (const attack of attacks) {
    const forged = structuredClone(plan); attack(forged); resignGraphAndPlan(forged);
    assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlan(forged));
    assert.throws(() => getWorkspaceOperationNativeDeleteLinkRecipes(forged));
  }
  const graphProof = structuredClone(plan); graphProof.nativeGraphPlan.finalGraphProof = '0'.repeat(64); resignGraphAndPlan(graphProof, false);
  assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlan(graphProof));
  const afterProof = structuredClone(plan); afterProof.nativeGraphPlan.steps[0].afterGraphProof = '0'.repeat(64); resignGraphAndPlan(afterProof, false);
  assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlan(afterProof));
});
for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) test(`opaque ${representation} semantic/self-hash forgery is rejected by current actual compiler bytes`, () => {
  const observed = observation([state(), state(representation, '# [Target](%20note%20.md)', 'incoming.md')]), plan = build(observed);
  const attacks: Array<(value: ReturnType<typeof build>) => void> = [
    value => { value.nativeGraphPlan.finalNamespace[0].contentBasisProof = '0'.repeat(64); },
    value => { value.nativeGraphPlan.steps[0].beforeGraphProof = '0'.repeat(64); },
    value => { value.nativeGraphPlan.finalNamespace[0].metadata!.headings[0].text = 'Forged heading';
      value.nativeGraphPlan.finalNamespace[0].metadata!.title = 'Forged heading'; },
  ];
  for (const attack of attacks) {
    const forged = structuredClone(plan); attack(forged); resignGraphAndPlan(forged);
    // A historical DTO cannot derive the native content hash or heading text
    // without private states. It still yields only the same genuine recipes.
    const decoded = decodeWorkspaceOperationNativeDeleteBatchPlan(forged);
    assert.deepEqual(getWorkspaceOperationNativeDeleteLinkRecipes(decoded), getWorkspaceOperationNativeDeleteLinkRecipes(plan));
    assert.throws(() => assertWorkspaceOperationNativeDeleteBatchPlanCurrent(decoded, observed, captureWorkspaceOperationJobScope(scope.workspace)), error =>
      error instanceof Error && error.message === 'NATIVE_DELETE_PLAN_CHANGED');
  }
});
test('incoming-link plans remain current across projection replacement but reject the incoming native peer state', () => {
  const observed = observation([state(), state('tiptap_blocks', '[Target](%20note%20.md)', 'incoming.md')]), plan = build(observed);
  const current = structuredClone(observed);
  for (const [index, entry] of current.stage.namespace.entries()) entry.filesystemIdentity = `1:${index+2}:200:300:400`;
  current.stage.stageProof = workspaceSourceAuthorityStageProof(current.stage);
  assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, current, captureWorkspaceOperationJobScope(scope.workspace));
  const peer = observation([observed.privateNativeStates[0], state('tiptap_blocks', 'Peer changed [Target](%20note%20.md)', 'incoming.md')]);
  assert.throws(() => assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, peer, captureWorkspaceOperationJobScope(scope.workspace)));
});
test('malformed native structure has a stable invalid code while source-import and size diagnostics survive', () => {
  const plan = build(observation([state()]));
  for (const change of [{ actions: null }, { nativeGraphPlan: null }, { nativeGraphPlan: { ...plan.nativeGraphPlan, steps: [null] } }]) {
    assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlan({ ...plan, ...change }), error => error instanceof Error
      && error.message === 'NATIVE_DELETE_PLAN_INVALID');
  }
  const source = plan.sourceEvidence.stage.sources[0];
  assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlan({ ...plan, sourceEvidence: { ...plan.sourceEvidence,
    stage: { ...plan.sourceEvidence.stage, sources: [{ ...source, kind: 'physical' }] } } }), error =>
    error instanceof WorkspaceOperationNativeSourceEvidenceError && error.code === 'NATIVE_SOURCE_IMPORT_REQUIRED');
  assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlan({ ...plan, sourceEvidence: { ...plan.sourceEvidence,
    stage: { ...plan.sourceEvidence.stage, scope: { kind: 'visible-workspace', excludedPaths: ['x'.repeat(8*1024*1024)] } } } }), error =>
    error instanceof WorkspaceOperationNativeSourceEvidenceError && error.code === 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
});
test('physical or incomplete source coverage is never filtered into a ready native plan', () => {
  const observed = observation([state()]); observed.stage.coverage = { complete: false, gaps: [{ code: 'unreadable-source', path: 'incoming.md' }] };
  assert.throws(() => build(observed));
  const physical = observation([state()]); physical.stage.sources.push({ kind: 'physical', inventory: {} as never });
  assert.throws(() => build(physical));
});
test('projection creation/replacement and directory mtime changes do not falsify current native semantic evidence', () => {
  const original = state(), observed = observation([original]);
  observed.stage.namespace.push({ workspaceId: scope.workspace.workspaceId, path: 'assets', kind: 'directory',
    identity: '1:2:0:100:100', filesystemIdentity: '1:2:0:100:100', documentId: null, lifecycleGeneration: null });
  observed.stage.stageProof = workspaceSourceAuthorityStageProof(observed.stage);
  const plan = build(observed), current = structuredClone(observed);
  current.stage.namespace[0].filesystemIdentity = '1:3:200:300:400';
  current.stage.namespace[1].identity = '1:2:0:900:900'; current.stage.namespace[1].filesystemIdentity = '1:2:0:900:900';
  current.stage.stageProof = workspaceSourceAuthorityStageProof(current.stage);
  assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, current, captureWorkspaceOperationJobScope(scope.workspace));
  current.stage.namespace[1].identity = '1:9:0:900:900'; current.stage.namespace[1].filesystemIdentity = '1:9:0:900:900';
  current.stage.stageProof = workspaceSourceAuthorityStageProof(current.stage);
  assert.throws(() => assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, current, captureWorkspaceOperationJobScope(scope.workspace)));
});
test('native peer, generation, scope and asset drift reject rather than rebuilding from projection bytes', () => {
  const plan = build(observation([state()]));
  for (const changed of [observation([state('tiptap_blocks', 'Peer edit')]), observation([{ ...state(), lifecycleGeneration: 2 }])]) {
    assert.throws(() => assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, changed, captureWorkspaceOperationJobScope(scope.workspace)));
  }
  assert.throws(() => assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, observation([state()]),
    { ...captureWorkspaceOperationJobScope(scope.workspace), rootPath: '/other' }));
});
test('strict bounded codec binds all private evidence/graph and rejects executable getters or fake V1 payloads', () => {
  const plan = build(observation([state()]));
  for (const change of [{ version: 1 }, { linkPlan: {} }, { surprise: true }, { nativeTarget: { ...plan.nativeTarget, documentSequence: 8 } },
    { nativeGraphPlan: { ...plan.nativeGraphPlan, planId: '0'.repeat(64) } }, { planId: '0'.repeat(64) }, { deletedDocuments: [{ content: 'fake' }] }]) {
    assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlan({ ...plan, ...change }));
  }
  let getters = 0; const accessor = { ...plan }; Object.defineProperty(accessor, 'nativeTarget', { enumerable: true, get() { getters++; return plan.nativeTarget; } });
  assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlan(accessor)); assert.equal(getters, 0);
  assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlan({ ...plan, giant: 'x'.repeat(16*1024*1024+1) }));
});
test('native public preview never serializes state proofs/vectors/anchors or private native source fields', () => {
  const plan = build(observation([state()])), preview = workspaceOperationBatchPublicPreview(plan), json = JSON.stringify(preview);
  assert.equal(preview.version, 2); assert.equal(preview.deletedPaths[0].path, ' note .md');
  assert.match(preview.deletedPaths[0].identity, /^native-preview:[a-f0-9]{64}$/u); assert.deepEqual(preview.expectedPathState, []);
  for (const secret of [plan.nativeTarget.stateProof, plan.nativeTarget.binaryHash, plan.nativeTarget.vectorHash,
    plan.sourceEvidence.stage.sources[0].inventory.version.stateVector, 'nativeTarget', 'nativeGraphPlan', 'sourceEvidence']) assert(!json.includes(secret));
});
test('injected legacy snapshot and existing V1 hash remain exactly unchanged', async () => {
  const snapshot = { workspaceId: scope.workspace.workspaceId, entries: [{ path: ' note .md', kind: 'file' as const,
    identity: 'physical:original', markdownContent: 'Original' }] };
  const expected = createWorkspaceOperationBatchPlan({ snapshot, actions });
  const actual = await buildWorkspaceOperationBatchPlan({ scope, actions }, { buildSnapshot: async () => snapshot });
  assert.deepEqual(actual, expected); assert.equal(actual.version, 1); assert('linkPlan' in actual);
  const hashBody = { version: expected.version, workspaceId: expected.workspaceId, actions: expected.actions,
    pathMappings: expected.pathMappings, deletedPaths: expected.deletedPaths, pathSteps: expected.pathSteps, linkEdits: expected.linkEdits,
    originalDocuments: expected.originalDocuments, previewContents: expected.previewContents, deletedDocuments: expected.deletedDocuments,
    expectedPathState: expected.expectedPathState };
  assert.equal(expected.planId, createHash('sha256').update(JSON.stringify(hashBody)).digest('hex'));
});
test('default dispatch keeps proven pristine physical Markdown in V1 and denies incomplete authority', async () => {
  // Pure dispatcher seam only. The observation/legacy snapshot are explicit
  // fixture facts; genuine SQL/FS collection is tested in the collector suite.
  const require = createRequire(import.meta.url), modulePath = require.resolve('../app/lib/files/workspace-operation-batch-plan');
  const cached = require.cache[modulePath];
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const load = loader._load;
  const identity = '1:2:8:100:100', filePath = actions[0].selections[0].sourcePath;
  const inventory = inspectOriginalPhysicalLinks({ workspaceId: scope.workspace.workspaceId, organizationId: null, path: filePath,
    authority: { kind: 'registered-never-initialized', catalogueProof: 'a'.repeat(64), registeredDocumentId: 'pristine-document', lineageId: null },
    bytes: Buffer.from('Original'), filesystemIdentity: identity, maxLinks: 10 });
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: scope.workspace.workspaceId,
    organizationId: null, catalogueProof: 'a'.repeat(64), namespace: [{ workspaceId: scope.workspace.workspaceId, path: filePath,
      kind: 'file', identity: 'registry:pristine-document:never_initialized', filesystemIdentity: identity,
      documentId: 'pristine-document', lifecycleGeneration: null }], sources: [{ kind: 'physical', inventory }],
    scope: { kind: 'visible-workspace', excludedPaths: [] }, coverage: { complete: true, gaps: [] },
    readiness: 'requires-import-and-rebinding', executionReady: false };
  const observed: WorkspaceLinkSourceAuthorityObservation = { stage: { ...body, stageProof: workspaceSourceAuthorityStageProof(body) },
    nativeBindings: [], privateNativeStates: [] };
  const legacySnapshot = { workspaceId: scope.workspace.workspaceId, entries: [{ path: filePath, kind: 'file' as const,
    identity, markdownContent: 'Original' }] };
  let stageReads = 0, legacyReads = 0;
  loader._load = function(name, parent, main) {
    if (name.endsWith('/workspace-source-authority-stage')) return { stageWorkspaceLinkSourceAuthorityObservation: async () => { stageReads++; return observed; } };
    if (name.endsWith('/workspace-authoritative-planner-snapshot')) return { buildWorkspaceAuthoritativePlannerSnapshot: async () => { legacyReads++; return legacySnapshot; } };
    return load.call(this, name, parent, main);
  };
  delete require.cache[modulePath];
  try {
    const planner = require(modulePath) as typeof import('../app/lib/files/workspace-operation-batch-plan');
    const plan = await planner.buildWorkspaceOperationBatchPlan({ scope, actions });
    assert.equal(plan.version, 1); assert.equal(stageReads, 1); assert.equal(legacyReads, 1);
    assert.deepEqual(plan, createWorkspaceOperationBatchPlan({ snapshot: legacySnapshot, actions }));
    observed.stage.coverage = { complete: false, gaps: [{ code: 'missing-native-state', path: filePath }] };
    await assert.rejects(planner.buildWorkspaceOperationBatchPlan({ scope, actions }), error => error instanceof Error
      && error.message === 'NATIVE_DELETE_PLAN_UNSUPPORTED');
    assert.equal(stageReads, 2); assert.equal(legacyReads, 1, 'unknown/missing native authority cannot fall through to legacy disk planning');
  } finally {
    loader._load = load;
    if (cached) require.cache[modulePath] = cached; else delete require.cache[modulePath];
  }
});
test('embedded store strictly decodes V2 before minting a claim and captures its full job scope before checkout', async () => {
  const sql = new PGlite(); let opens = 0, closes = 0;
  const connect = async (): Promise<SqlConnection> => { opens++; return {
    get: async (statement, values) => (await sql.query(statement, values)).rows[0],
    all: async (statement, values) => (await sql.query(statement, values)).rows,
    run: async (statement, values) => ({ changes: (await sql.query(statement, values)).affectedRows ?? 0 }),
    close: async () => { closes++; },
  }; };
  try {
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await sql.exec(statement);
    const store = new WorkspaceOperationBatchStore(connect), plan = build(observation([state()]));
    const auth = { mode: 'direct' as const, actorUserId: 'fixture-user', actorId: 'fixture-user', actorDisplayName: 'Fixture',
      actorType: 'user' as const, requestHash: 'a'.repeat(64), jobScope: captureWorkspaceOperationJobScope(scope.workspace) };
    const mutable = structuredClone(plan), batchId = 'native_store_fixture_1234567890';
    const pending = store.createDirect({ batchId, plan: mutable, authorization: auth });
    mutable.nativeTarget = { ...mutable.nativeTarget, path: 'changed-after-checkout.md' }; mutable.nativeGraphPlan.planId = '0'.repeat(64);
    const created = await pending; assert.deepEqual(created.plan, plan); assert.deepEqual((await store.get(batchId))?.plan, plan);
    assert(Object.isFrozen(created.plan));
    const before = opens;
    await assert.rejects(store.createDirect({ batchId: 'native_invalid_scope_1234567890', plan,
      authorization: { ...auth, jobScope: { ...auth.jobScope, rootPath: '/other' } } }), error =>
      error instanceof Error && 'code' in error && error.code === 'BATCH_INVALID_AUTHORIZATION');
    assert.equal(opens, before, 'scope mismatch rejects before SQL checkout');
    for (const version of [1, 3, '2']) {
      await assert.rejects(store.createDirect({ batchId: 'native_invalid_envelope_1234567890',
        plan: { ...plan, version } as never, authorization: auth }), error =>
        error instanceof Error && 'code' in error && error.code === 'BATCH_INVALID_PLAN');
    }
    assert.equal(opens, before, 'a downgraded or unknown native envelope never reaches SQL or the legacy public preview');
    const { kind: _kind, sourceEvidence: _evidence, nativeTarget: _target, nativeGraphPlan: _graph, ...stripped } = plan;
    const strippedV1 = { ...stripped, version: 1 as const };
    strippedV1.planId = computeWorkspaceOperationBatchPlanId(strippedV1);
    await assert.rejects(store.createDirect({ batchId: 'native_stripped_envelope_1234567890', plan: strippedV1 as never, authorization: auth }),
      error => error instanceof Error && 'code' in error && error.code === 'BATCH_INVALID_PLAN');
    assert.equal(opens, before, 'removing every V2 marker does not manufacture a legitimate V1 plan');
    const legacy = createWorkspaceOperationBatchPlan({ snapshot: { workspaceId: scope.workspace.workspaceId,
      entries: [{ path: ' note .md', kind: 'file', identity: 'fixture:original', markdownContent: 'Original' }] }, actions });
    for (const fields of [{ contractVersion: 2 }, { recoveryReady: 'false' }, { coverage: { complete: 'true' } }, { kind: {} }]) {
      await assert.rejects(store.createDirect({ batchId: 'legacy_invalid_shape_1234567890',
        plan: { ...legacy, linkPlan: { ...legacy.linkPlan, ...fields } } as never, authorization: auth }), error =>
        error instanceof Error && 'code' in error && error.code === 'BATCH_INVALID_PLAN');
    }
    let getterCalls = 0;
    const getterLinkPlan = { ...legacy.linkPlan }; Object.defineProperty(getterLinkPlan, 'planId', {
      enumerable: true, get() { getterCalls++; return legacy.linkPlan.planId; },
    });
    await assert.rejects(store.createDirect({ batchId: 'legacy_accessor_shape_1234567890',
      plan: { ...legacy, linkPlan: getterLinkPlan }, authorization: auth }));
    assert.equal(getterCalls, 0); assert.equal(opens, before, 'legacy discriminator/scalar shape rejects before evaluating getters or opening SQL');
    await sql.query('UPDATE workspace_file_operation_batches SET plan_json=$1 WHERE batch_id=$2',
      [JSON.stringify({ ...plan, nativeTarget: { ...plan.nativeTarget, documentSequence: 8 } }), batchId]);
    await assert.rejects(store.get(batchId));
    await assert.rejects(store.claim('native-store-worker'), error => error instanceof Error && error.message === 'NATIVE_DELETE_PLAN_INVALID');
    assert.equal(opens, closes, 'every actual embedded SQL checkout is released, including invalid claim decoding');
  } finally { await sql.close(); }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { authoritativeNativeCollaborationSnapshot, inspectPersistedNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { NativeNamespaceEntry } from '../app/lib/markdown/workspace-link-contract-v2';
import type { NativeMixedBatchPlan } from '../app/lib/markdown/workspace-native-mixed-batch-compiler';
import { inspectNativeDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import { createWorkspaceOperationNativeCopyPlan, decodeWorkspaceOperationNativeCopyPlan,
  assertWorkspaceOperationNativeCopyPlanCurrent, computeWorkspaceOperationNativeCopyPlanId,
  WorkspaceOperationNativeCopyPlanError, type WorkspaceOperationNativeCopyPlan,
  type WorkspaceOperationNativeCopySelection } from '../app/lib/files/workspace-operation-native-copy-plan';

// Pure producer/codec/current-byte tests: SQL rows and filesystem identities
// below are declared observations, never real ownership or admission proof.
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function scope(workspaceId = 'source-workspace'): WorkspaceOperationBatchScope {
  return { workspace: { workspaceId, rootPath: `/fixture/${workspaceId}`, rootRelativePath: `users/fixture/${workspaceId}`,
    workspaceType: 'personal', organizationId: null, ownerUserId: 'fixture-user', legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true,
      canCreatePublicLinks: false } }, fileOptions: {} };
}
const sourceScope = scope(), destinationScope = scope('destination-workspace');
type Representation = PersistedCollaborationState['representation'];
function state(filePath: string, text = 'Original', representation: Representation = 'tiptap_blocks',
  boundScope = sourceScope): PersistedCollaborationState {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
  try {
    return { documentId: `document:${boundScope.workspace.workspaceId}:${filePath}`, workspaceId: boundScope.workspace.workspaceId,
      organizationId: null, path: filePath, representation, lifecycleGeneration: 1, schemaVersion: 1, documentSequence: text ? 7 : 0,
      persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
      newlineStyle: 'crlf', hasBom: true, degraded: false, status: 'active', yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
  } finally { doc.destroy(); }
}
type Extra = { path: string; kind?: NativeNamespaceEntry['kind']; identity?: string };
function observation(states: PersistedCollaborationState[], extras: Extra[] = [], boundScope = sourceScope,
  projection: string | null = null): WorkspaceLinkSourceAuthorityObservation {
  const workspaceId = boundScope.workspace.workspaceId;
  const inventories = states.map(value => inspectPersistedNativeCollaborationSnapshot(value, inspectNativeDocumentLinks));
  const nativeBindings: WorkspaceNativeSourceBinding[] = states.map((value, index) => ({
    expected: { documentId: value.documentId, lineageId: `lineage:${workspaceId}:${value.path}`, workspaceId,
      organizationId: null, path: value.path, representation: value.representation, schemaVersion: value.schemaVersion,
      lifecycleGeneration: value.lifecycleGeneration, registryStateVersion: value.documentSequence, documentSequence: value.documentSequence,
      persistedAt: value.persistedAt, binaryHash: sha(value.yjsState), vectorHash: sha(value.stateVector), stateProof: inventories[index].version.stateProof },
    registry: { documentId: value.documentId, lineageId: `lineage:${workspaceId}:${value.path}`, workspaceId, workspaceType: 'personal',
      organizationId: null, customerId: null, projectId: null, path: value.path, provider: 'yjs', stateLifecycle: 'initialized',
      stateVersion: value.documentSequence, status: 'active' },
    lineage: { lineageId: `lineage:${workspaceId}:${value.path}`, workspaceId, workspaceType: 'personal', organizationId: null,
      customerId: null, projectId: null, path: value.path, status: 'active', archivedAt: null, trashEntryId: null },
    byteProfile: { newlineStyle: value.newlineStyle, hasBom: value.hasBom }, inventoryProof: nativeLinkJsonProof(inventories[index]),
  }));
  const namespace: NativeNamespaceEntry[] = states.map(value => ({ workspaceId, path: value.path, kind: 'file',
    identity: `registry:${value.documentId}:${value.lifecycleGeneration}`, filesystemIdentity: projection,
    documentId: value.documentId, lifecycleGeneration: value.lifecycleGeneration }));
  for (const [index, extra] of extras.entries()) {
    const identity = extra.identity ?? `1:${100 + index}:0:100:100`;
    namespace.push({ workspaceId, path: extra.path, kind: extra.kind ?? 'directory', identity, filesystemIdentity: identity,
      documentId: null, lifecycleGeneration: null });
  }
  for (const value of states) {
    const segments = value.path.split('/'); segments.pop();
    while (segments.length) {
      const filePath = segments.join('/');
      if (!namespace.some(entry => entry.path === filePath)) namespace.push({ workspaceId, path: filePath, kind: 'directory',
        identity: `registry-directory:${nativeLinkJsonProof({ workspaceId, path: filePath })}`,
        filesystemIdentity: null, documentId: null, lifecycleGeneration: null });
      segments.pop();
    }
  }
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId, organizationId: null,
    catalogueProof: nativeLinkJsonProof(nativeBindings.map(binding => binding.registry)), namespace,
    sources: inventories.map(inventory => ({ kind: 'native', inventory })), scope: { kind: 'visible-workspace', excludedPaths: [] },
    coverage: { complete: true, gaps: [] }, readiness: 'native-coordinator-required', executionReady: false };
  return { stage: { ...body, stageProof: workspaceSourceAuthorityStageProof(body) }, nativeBindings, privateNativeStates: states };
}
const selected = (sourcePath = 'target.md', destinationPath = 'copy.md') => ({ sourcePath, destinationPath });
function build(source: WorkspaceLinkSourceAuthorityObservation, selections: readonly WorkspaceOperationNativeCopySelection[] = [selected()],
  destination = source, targetScope = sourceScope) {
  return createWorkspaceOperationNativeCopyPlan({ sourceScope, destinationScope: targetScope, selections,
    sourceObservation: source, destinationObservation: destination });
}
function current(plan: WorkspaceOperationNativeCopyPlan, source: WorkspaceLinkSourceAuthorityObservation,
  destination = source, targetScope = sourceScope) {
  return assertWorkspaceOperationNativeCopyPlanCurrent(plan, { sourceScope: captureWorkspaceOperationJobScope(sourceScope.workspace),
    destinationScope: captureWorkspaceOperationJobScope(targetScope.workspace), sourceObservation: source, destinationObservation: destination });
}
type MutableData<T> = T extends readonly (infer Item)[] ? MutableData<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: MutableData<T[Key]> } : T;
type MutablePlan = MutableData<WorkspaceOperationNativeCopyPlan>;
function mutablePlan(plan: WorkspaceOperationNativeCopyPlan): MutablePlan {
  return structuredClone(plan) as MutablePlan;
}
function resign(plan: MutablePlan): WorkspaceOperationNativeCopyPlan {
  plan.planId = computeWorkspaceOperationNativeCopyPlanId(plan); return plan;
}
function copyError(code?: WorkspaceOperationNativeCopyPlanError['code']) {
  return (error: unknown) => error instanceof WorkspaceOperationNativeCopyPlanError && (!code || error.code === code);
}
function entity(graph: NativeMixedBatchPlan, filePath: string, workspaceId = sourceScope.workspace.workspaceId) {
  const result = graph.finalNamespace.find(value => value.path === filePath && value.workspaceId === workspaceId);
  assert(result, `Missing entity ${workspaceId}:${filePath}`); return result;
}
function edgeTo(graph: NativeMixedBatchPlan, from: string, to: string, workspaceId = sourceScope.workspace.workspaceId) {
  const source = entity(graph, from, workspaceId), target = entity(graph, to, workspaceId);
  const result = graph.finalEdges.find(value => value.sourceEntityKey === source.entityKey && value.resolution.targetEntityKey === target.entityKey);
  assert(result, `Missing edge ${from} -> ${to}`); return result;
}
function frozen(value: unknown): void {
  if (value && typeof value === 'object') { assert(Object.isFrozen(value)); for (const child of Object.values(value)) frozen(child); }
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) for (const text of ['', '# Original']) {
  test(`${representation} ${text ? 'nonempty' : 'sequence-zero empty'} keeps original evidence and requires a fresh clone`, () => {
    const original = state('target.md', text, representation), observed = observation([original]);
    const before = structuredClone(observed), plan = build(observed), compiled = current(plan, observed);
    assert.equal(plan.version, 1); assert.equal(plan.kind, 'native-copy'); assert.equal(plan.executionReady, false);
    assert.equal(plan.readiness, 'requires-clone-rebinding'); assert.equal(plan.cloneRequirements.length, 1);
    assert.equal(plan.sourceEvidence.nativeBindings[0].expected.binaryHash, sha(original.yjsState));
    assert.equal(plan.sourceEvidence.nativeBindings[0].expected.vectorHash, sha(original.stateVector));
    assert.equal(plan.sourceEvidence.nativeBindings[0].expected.documentSequence, original.documentSequence);
    assert.deepEqual(plan.sourceEvidence.nativeBindings[0].byteProfile, { newlineStyle: 'crlf', hasBom: true });
    assert.deepEqual(plan.sourceEvidence, plan.destinationEvidence); assert.deepEqual(plan.sourceScope, plan.destinationScope);
    assert.equal(compiled.planId, plan.compilerPlanProof); assert.equal(compiled.finalGraphProof, plan.finalGraphProof);
    assert.deepEqual(compiled.cloneRequirements, plan.cloneRequirements); assert.equal(compiled.executionReady, false);
    assert.equal(entity(compiled, 'target.md').binding.kind, 'existing');
    assert.equal(entity(compiled, 'copy.md').binding.kind, 'unbound-copy');
    assert.notEqual(entity(compiled, 'copy.md').entityKey, entity(compiled, 'target.md').entityKey);
    assert.equal(plan.cloneRequirements[0].applicability, 'requires-fresh-clone-receipt-and-inventory');
    assert.deepEqual(decodeWorkspaceOperationNativeCopyPlan(JSON.parse(JSON.stringify(plan))), plan);
    assert.equal(build(observed).planId, plan.planId); assert.deepEqual(observed, before); frozen(plan); frozen(compiled);
    const json = JSON.stringify(plan);
    for (const field of ['yjsState', 'privateNativeStates', 'previewContents', 'originalDocuments', 'cloneDocumentId', 'finalNamespace', 'finalEdges']) {
      assert.equal(json.includes(`"${field}"`), false, field);
    }
  });
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${representation} multiple roots preserve originals, outside targets, fragments and external backlinks`, () => {
    const observed = observation([state('folder/note.md', '[Target](target.md#Heading) [Other](../second.md) [Keep](../keep.md) [Web](https://example.test/a)', representation),
      state('folder/target.md', '# Heading', representation), state('second.md', '# Second', representation),
      state('keep.md', '# Keep', representation), state('incoming.md', '[Original](folder/target.md#Heading)', representation)]);
    const before = structuredClone(observed);
    const plan = build(observed, [selected('folder', 'copied'), selected('second.md', 'second-copy.md')]);
    const compiled = current(plan, observed);
    assert.equal(plan.cloneRequirements.length, 3);
    edgeTo(compiled, 'folder/note.md', 'folder/target.md'); edgeTo(compiled, 'incoming.md', 'folder/target.md');
    assert.equal(edgeTo(compiled, 'copied/note.md', 'copied/target.md').literal, 'target.md#Heading');
    edgeTo(compiled, 'copied/note.md', 'second-copy.md'); edgeTo(compiled, 'copied/note.md', 'keep.md');
    const web = compiled.finalEdges.filter(value => value.resolution.status === 'external');
    // Plain inventories index local links only. Its complete expected semantic
    // content proves the external literal survives the virtual native rewrite.
    if (representation === 'plain_text') {
      assert.equal(web.length, 0);
      const expected = state('expected.md', '[Target](target.md#Heading) [Other](../second-copy.md) [Keep](../keep.md) [Web](https://example.test/a)', representation);
      assert.equal(entity(compiled, 'copied/note.md').contentBasisProof, nativeLinkJsonProof(authoritativeNativeCollaborationSnapshot(expected).content));
    } else {
      assert.equal(web.length, 2); assert(web.every(value => value.literal === 'https://example.test/a'));
    }
    assert(compiled.steps[0].linkIntents.every(value => compiled.cloneRequirements.some(clone => clone.entityKey === value.entityKey)));
    for (const requirement of plan.cloneRequirements) {
      const inventory = plan.sourceEvidence.stage.sources.find(value => value.inventory.document.path === requirement.sourcePath)!.inventory;
      assert.deepEqual(requirement.linkBindings.map(value => value.originEvidenceLinkId), inventory.links.map(value => value.id));
    }
    assert.deepEqual(observed, before);
  });
  test(`${representation} display aliases and heading fragments keep native link meaning`, () => {
    const observed = observation([state('folder/note.md', '[[target#Heading|Visible label]]', representation), state('folder/target.md', '# Heading', representation)]);
    const plan = build(observed, [selected('folder', 'copied')]), compiled = current(plan, observed);
    const link = edgeTo(compiled, 'copied/note.md', 'copied/target.md');
    assert(link.literal.includes('#Heading'));
    const inventory = plan.sourceEvidence.stage.sources.find(value => value.inventory.document.path === 'folder/note.md')!.inventory;
    assert.equal(inventory.links[0].alias, 'Visible label'); assert.equal(inventory.links[0].fragment, 'Heading');
    assert.equal(plan.nativePathPlan.mutations[0].cloneSelection, 'folder');
  });
}

test('cross-workspace copy binds independent destination native states without retargeting either workspace backlinks', () => {
  const source = observation([state('folder/note.md', '[Target](target.md#Heading)'), state('folder/target.md', '# Heading'),
    state('incoming.md', '[Original](folder/target.md)')]);
  const destination = observation([state('target.md', '# Independent', 'plain_text', destinationScope),
    state('incoming.md', '[Independent](target.md)', 'tiptap_xml', destinationScope)], [], destinationScope);
  const plan = build(source, [selected('folder', 'copied')], destination, destinationScope);
  const compiled = current(plan, source, destination, destinationScope), targetWorkspace = destinationScope.workspace.workspaceId;
  assert.notEqual(plan.sourceEvidence.evidenceProof, plan.destinationEvidence.evidenceProof);
  assert.equal(plan.destinationEvidence.nativeBindings.length, 2);
  edgeTo(compiled, 'incoming.md', 'folder/target.md'); edgeTo(compiled, 'incoming.md', 'target.md', targetWorkspace);
  edgeTo(compiled, 'copied/note.md', 'copied/target.md', targetWorkspace);
  assert.equal(compiled.finalNamespace.filter(value => value.binding.kind === 'unbound-copy').length, 3);
  assert.equal(entity(compiled, 'folder/target.md').binding.kind, 'existing');
});

test('cross-workspace copy refuses an uncopied local target even if the destination has a coincidental same path', () => {
  const source = observation([state('note.md', '[Original](target.md)'), state('target.md')]);
  const destination = observation([state('target.md', '# Different identity', 'tiptap_blocks', destinationScope)], [], destinationScope);
  assert.throws(() => build(source, [selected('note.md', 'note.md')], destination, destinationScope), copyError('NATIVE_COPY_PLAN_UNSUPPORTED'));
});

test('same path spelling is valid across independent workspaces, but never overwrites a destination', () => {
  const source = observation([state('target.md')]), destination = observation([], [], destinationScope);
  const plan = build(source, [selected('target.md', 'target.md')], destination, destinationScope);
  assert.equal(current(plan, source, destination, destinationScope).cloneRequirements.length, 1);
  assert.throws(() => build(source, [selected('target.md', 'target.md')]), copyError('NATIVE_COPY_PLAN_UNSUPPORTED'));
  assert.throws(() => build(source, [selected('target.md', 'target.md')],
    observation([state('target.md', 'Occupied', 'plain_text', destinationScope)], [], destinationScope), destinationScope), copyError('NATIVE_COPY_PLAN_UNSUPPORTED'));
});

test('assets, populated and empty folders, and projection-absent native documents retain separate copy requirements', () => {
  const observed = observation([state('folder/note.md', '[PDF](manual.pdf)')], [{ path: 'folder' },
    { path: 'folder/manual.pdf', kind: 'file' }, { path: 'folder/empty' }]);
  const plan = build(observed, [selected('folder', 'copied')]), compiled = current(plan, observed);
  assert.equal(plan.nativePathPlan.pathMappings.length, 4); assert.equal(plan.cloneRequirements.length, 1);
  assert(plan.sourceEvidence.stage.namespace.filter(value => value.documentId).every(value => value.filesystemIdentity === null));
  edgeTo(compiled, 'copied/note.md', 'copied/manual.pdf'); assert.equal(entity(compiled, 'copied/empty').kind, 'directory');
  const assets = observation([], [{ path: 'manual.pdf', kind: 'file' }, { path: 'empty' }]);
  const emptyDestination = observation([], [], destinationScope);
  const assetPlan = build(assets, [selected('manual.pdf', 'manual.pdf'), selected('empty', 'empty')], emptyDestination, destinationScope);
  assert.equal(assetPlan.readiness, 'ready'); assert.equal(assetPlan.executionReady, false); assert.deepEqual(assetPlan.cloneRequirements, []);
  assert.equal(current(assetPlan, assets, emptyDestination, destinationScope).finalNamespace.length, 4);
});

test('basename/metadata-alias capture of untouched backlinks is blocked instead of silently reinterpreted', () => {
  const observed = observation([state('incoming.md', '[[Shared]]'), state('folder/target.md', '---\naliases: [Shared]\n---\n\n# Heading')]);
  assert.throws(() => build(observed, [selected('folder', 'copied')]), copyError('NATIVE_COPY_PLAN_UNSUPPORTED'));
});

test('same-workspace source and destination scopes and observations must be the same original facts', () => {
  const source = observation([state('target.md')]), other = observation([state('target.md', 'Different')]);
  assert.throws(() => build(source, [selected()], other), copyError());
  const mismatch = structuredClone(sourceScope); mismatch.workspace.rootPath = '/fixture/other-root';
  assert.throws(() => createWorkspaceOperationNativeCopyPlan({ sourceScope, destinationScope: mismatch, selections: [selected()],
    sourceObservation: source, destinationObservation: source }), copyError());
});

test('independent destination bytes, namespace and all scope fields are checked again by Current', () => {
  const source = observation([state('target.md')]);
  const destination = observation([state('other.md', 'Before', 'plain_text', destinationScope)], [], destinationScope);
  const plan = build(source, [selected()], destination, destinationScope);
  const changed = observation([state('other.md', 'After', 'plain_text', destinationScope)], [], destinationScope);
  assert.throws(() => current(plan, source, changed, destinationScope), copyError('NATIVE_COPY_PLAN_CHANGED'));
  const occupied = observation([...destination.privateNativeStates, state('copy.md', 'Occupied', 'plain_text', destinationScope)], [], destinationScope);
  assert.throws(() => current(plan, source, occupied, destinationScope), copyError('NATIVE_COPY_PLAN_CHANGED'));
  const wrong = structuredClone(destinationScope); wrong.workspace.ownerUserId = 'another-owner';
  assert.throws(() => current(plan, source, destination, wrong), copyError('NATIVE_COPY_PLAN_CHANGED'));
  assert.throws(() => build(source, [selected()], destination, sourceScope), copyError('NATIVE_COPY_PLAN_INVALID'));
});

test('Current allows replaceable projections and directory timestamps while replaying the original namespace proofs', () => {
  const states = [state('folder/target.md')];
  const original = observation(states, [{ path: 'folder', identity: '1:100:0:100:100' }]);
  const plan = build(original, [selected('folder', 'copied')]);
  const updated = observation(states, [{ path: 'folder', identity: '1:100:4096:300:301' }], sourceScope, '2:200:123:400:401');
  assert.equal(current(plan, updated).planId, plan.compilerPlanProof);
  const replaced = observation(states, [{ path: 'folder', identity: '1:999:4096:300:301' }]);
  assert.throws(() => current(plan, replaced), copyError('NATIVE_COPY_PLAN_CHANGED'));
});

test('rehashing path mappings, clone bindings, source scopes or extra authority fields cannot forge a decoded plan', () => {
  const observed = observation([state('target.md', '[Target](target.md)')]), plan = build(observed);
  const changes: Array<(value: MutablePlan) => void> = [
    value => { value.nativePathPlan.pathMappings[0].destinationPath = 'forged.md'; },
    value => { value.nativePathPlan.mutations[0].cloneSelection = null; },
    value => { value.cloneRequirements[0].entityKey = 'f'.repeat(64); },
    value => { value.cloneRequirements[0].sourceEntityKey = 'f'.repeat(64); },
    value => { value.cloneRequirements[0].linkBindings[0].originEvidenceLinkId = 'forged-link'; },
    value => { value.cloneRequirements[0].linkBindings[0].virtualLinkKey = 'f'.repeat(64); },
    value => { value.cloneRequirements[0].requestIndex = 1; },
    value => { value.cloneRequirements[0].applicability = 'ready' as never; },
    value => { value.sourceScope = { ...value.sourceScope, rootPath: '/forged/root' }; },
    value => { value.kind = 'native-path-change' as never; },
    value => { value.executionReady = true as never; },
    value => { Object.assign(value, { cloneDocumentId: 'invented-durable-id' }); },
  ];
  for (const mutate of changes) {
    const forged = mutablePlan(plan); mutate(forged);
    const { planId: _pathId, ...pathBody } = forged.nativePathPlan;
    forged.nativePathPlan.planId = nativeLinkJsonProof(pathBody);
    assert.throws(() => decodeWorkspaceOperationNativeCopyPlan(resign(forged)), copyError());
  }
});

test('opaque compiler/content/final hashes are historical data; current native-byte replay rejects rehashed forgery', () => {
  const observed = observation([state('target.md')]), plan = build(observed);
  for (const name of ['compilerPlanProof', 'finalGraphProof', 'sourceContentBasisProof'] as const) {
    const forged = mutablePlan(plan);
    if (name === 'sourceContentBasisProof') forged.cloneRequirements[0][name] = 'f'.repeat(64);
    else forged[name] = 'f'.repeat(64);
    const historical = decodeWorkspaceOperationNativeCopyPlan(resign(forged));
    assert.equal(historical.executionReady, false);
    assert.throws(() => current(historical, observed), copyError('NATIVE_COPY_PLAN_CHANGED'));
  }
});

test('wrong native bytes, vectors and evidence cannot pass capture or Current even with matching path names', () => {
  const observed = observation([state('target.md')]), plan = build(observed);
  const mismatched = structuredClone(observed);
  mismatched.privateNativeStates[0].yjsState = state('target.md', 'Different').yjsState;
  assert.throws(() => build(mismatched), copyError('NATIVE_COPY_PLAN_INVALID'));
  assert.throws(() => current(plan, mismatched), copyError('NATIVE_COPY_PLAN_INVALID'));
  const vector = structuredClone(observed); vector.privateNativeStates[0].stateVector = Uint8Array.of(0);
  assert.throws(() => current(plan, vector), copyError('NATIVE_COPY_PLAN_INVALID'));
  assert.throws(() => current(plan, observation([state('target.md', 'Different')])), copyError('NATIVE_COPY_PLAN_CHANGED'));
});

test('creation captures immutable original selections, evidence and detached actual state bytes', () => {
  const observed = observation([state('target.md')]), selections = [selected()], plan = build(observed, selections);
  const json = JSON.stringify(plan), planId = plan.planId;
  selections[0].destinationPath = 'later.md';
  Object.assign(observed.nativeBindings[0].expected, { path: 'later.md' });
  observed.privateNativeStates[0].yjsState.fill(0); observed.stage.namespace[0].path = 'later.md';
  assert.equal(JSON.stringify(plan), json); assert.equal(plan.planId, planId); assert.equal(plan.selections[0].destinationPath, 'copy.md');
  assert.throws(() => { plan.nativePathPlan.pathMappings[0].destinationPath = 'later.md'; }, TypeError);
  frozen(plan);
});

test('strict JSON capture refuses accessors, sparse arrays, cycles, symbols, custom objects and unsupported fields', () => {
  const observed = observation([state('target.md')]), plan = build(observed); let called = 0;
  const getter = { ...plan }; Object.defineProperty(getter, 'kind', { enumerable: true, get() { called++; return 'native-copy'; } });
  assert.throws(() => decodeWorkspaceOperationNativeCopyPlan(getter), copyError()); assert.equal(called, 0);
  const malicious = { sourceScope, destinationScope: sourceScope, selections: [selected()], sourceObservation: observed,
    get destinationObservation() { called++; return observed; } };
  assert.throws(() => createWorkspaceOperationNativeCopyPlan(malicious), copyError()); assert.equal(called, 0);
  const sparse = mutablePlan(plan); sparse.cloneRequirements = new Array(1);
  assert.throws(() => decodeWorkspaceOperationNativeCopyPlan(sparse), copyError());
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const invalid of [{ ...plan, extra: new Date() }, { ...plan, [Symbol('hidden')]: true }, { ...plan, extra: cycle },
    { ...plan, previewContents: {} }, Object.assign(Object.create({}), plan)]) {
    assert.throws(() => decodeWorkspaceOperationNativeCopyPlan(invalid), copyError());
  }
});

test('selections, paths, bytes and native-state bounds fail closed before producing a plan', () => {
  const observed = observation([state('target.md')]);
  for (const choices of [[], Array.from({ length: 1001 }, () => selected()), [selected('../target.md', 'copy.md')],
    [selected('target.md', 'x'.repeat(4097))], [selected('target.md', Array(34).fill('x').join('/'))],
    [selected('target.md', 'bad\uD800.md')], [selected('target.md', 'folder\\copy.md')]]) {
    assert.throws(() => build(observed, choices), copyError('NATIVE_COPY_PLAN_UNSUPPORTED'));
  }
  assert.throws(() => decodeWorkspaceOperationNativeCopyPlan({ extra: 'x'.repeat(16 * 1024 * 1024 + 1) }), copyError('NATIVE_COPY_PLAN_TOO_LARGE'));
  const oversized = structuredClone(observed); oversized.privateNativeStates[0].yjsState = new Uint8Array(16 * 1024 * 1024 + 1);
  assert.throws(() => build(oversized), copyError('NATIVE_COPY_PLAN_TOO_LARGE'));
});

test('overlapping roots, directory self-copy, file parents and incomplete/import-required evidence remain blocked', () => {
  const observed = observation([state('folder/target.md')], [{ path: 'folder' }, { path: 'parent.pdf', kind: 'file' }]);
  for (const choices of [[selected('folder', 'copy'), selected('folder/target.md', 'other.md')], [selected('folder', 'folder/inside')],
    [selected('folder/target.md', 'parent.pdf/copy.md')], [selected('missing.md', 'copy.md')]]) {
    assert.throws(() => build(observed, choices), copyError('NATIVE_COPY_PLAN_UNSUPPORTED'));
  }
  const incomplete = structuredClone(observed); incomplete.stage.coverage.complete = false;
  assert.throws(() => build(incomplete, [selected('folder', 'copy')]), copyError());
  const uninspected = observation([], [{ path: 'raw.md', kind: 'file' }]);
  assert.throws(() => build(uninspected, [selected('raw.md', 'copy.md')]), copyError('NATIVE_COPY_PLAN_UNSUPPORTED'));
});

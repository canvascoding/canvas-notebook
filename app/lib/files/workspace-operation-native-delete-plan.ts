import 'server-only';

import { isDeepStrictEqual } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { NativeDocumentLinkInventory, NativeLinkMutationRecipe, NativeNamespaceEntry, NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
import { compileWorkspaceNativeMixedBatch, type NativeMixedBatchPlan } from '../markdown/workspace-native-mixed-batch-compiler';
import { buildWorkspaceNativeLinkGraph } from '../markdown/workspace-native-link-graph';
import { createWorkspaceNativeFileOperationPlan } from '../markdown/workspace-native-file-operation-planner';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { assertWorkspaceOperationNativeSourceEvidenceCurrent, captureWorkspaceOperationNativeSourceEvidence,
  decodeWorkspaceOperationNativeSourceEvidence, WorkspaceOperationNativeSourceEvidenceError } from './workspace-operation-native-source-evidence';
import type { WorkspaceOperationBatchAction, WorkspaceOperationBatchScope, WorkspaceOperationJobScope,
  WorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-batch-contract';

const MAX_PLAN_BYTES = 16 * 1024 * 1024;
const keys = ['version', 'kind', 'workspaceId', 'planId', 'readiness', 'actions', 'pathMappings', 'deletedPaths', 'pathSteps',
  'linkEdits', 'originalDocuments', 'deletedDocuments', 'previewContents', 'expectedPathState', 'coverage', 'linkAssessment',
  'issues', 'sourceEvidence', 'nativeTarget', 'nativeGraphPlan'];
export class WorkspaceOperationNativeDeletePlanError extends Error {
  readonly status = 409;
  constructor(readonly code: 'NATIVE_DELETE_PLAN_INVALID' | 'NATIVE_DELETE_PLAN_TOO_LARGE' | 'NATIVE_DELETE_PLAN_UNSUPPORTED'
    | 'NATIVE_DELETE_PLAN_CHANGED') { super(code); this.name = 'WorkspaceOperationNativeDeletePlanError'; }
}
function fail(code: WorkspaceOperationNativeDeletePlanError['code'] = 'NATIVE_DELETE_PLAN_INVALID'): never {
  throw new WorkspaceOperationNativeDeletePlanError(code);
}
function capture(input: unknown): unknown {
  let nodes = 0, bytes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 400_000 || depth > 40) fail('NATIVE_DELETE_PLAN_TOO_LARGE');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return value; }
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); if (bytes > MAX_PLAN_BYTES) fail('NATIVE_DELETE_PLAN_TOO_LARGE'); return value; }
    if (!value || typeof value !== 'object' || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) fail();
    if (Array.isArray(value)) {
      if (value.length > 100_000 || Reflect.ownKeys(value).length !== value.length + 1) fail();
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
        return visit(descriptor.value, depth + 1);
      });
    }
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key)
        || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      bytes += Buffer.byteLength(key); if (bytes > MAX_PLAN_BYTES) fail('NATIVE_DELETE_PLAN_TOO_LARGE');
      result[key] = visit(descriptor.value, depth + 1);
    }
    return result;
  };
  const value = visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PLAN_BYTES) fail('NATIVE_DELETE_PLAN_TOO_LARGE');
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function snapshot(observation: Pick<WorkspaceLinkSourceAuthorityObservation, 'stage'>): NativeWorkspaceLinkSnapshot {
  const { stage } = observation;
  if (!stage.coverage.complete || stage.coverage.gaps.length || stage.sources.some(source => source.kind !== 'native')) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  const body = { contractVersion: 2 as const, workspaceId: stage.workspaceId, namespace: stage.namespace,
    documents: stage.sources.flatMap(source => source.kind === 'native' ? [source.inventory] : []), coverage: { complete: true, gaps: [] } };
  return { ...body, snapshotProof: nativeLinkJsonProof(body) };
}
function action(input: readonly WorkspaceOperationBatchAction[]): WorkspaceOperationBatchAction {
  if (input.length !== 1) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  const selected = input[0];
  if (!selected || selected.kind !== 'delete' || typeof selected.reviewId !== 'string' || !selected.reviewId || selected.reviewId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(selected.reviewId)
    || selected.ignoreMissing !== undefined && typeof selected.ignoreMissing !== 'boolean' || selected.selections?.length !== 1
    || !isCanonicalAdmissionPath(selected.selections[0].sourcePath) || selected.selections[0].destinationPath !== undefined
    || Object.keys(selected).some(key => !['reviewId', 'kind', 'ignoreMissing', 'selections'].includes(key))
    || Object.keys(selected.selections[0]).some(key => key !== 'sourcePath')) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  return selected;
}
const graphKeys = ['contractVersion', 'compilerVersion', 'planId', 'readiness', 'executionReady', 'requests', 'snapshotProofs',
  'documentEvidence', 'steps', 'cloneRequirements', 'finalNamespace', 'finalEdges', 'finalGraphProof', 'issues', 'requiredCoordinatorBindings'];
const coordinatorBindings: NativeMixedBatchPlan['requiredCoordinatorBindings'] = [
  'actor-session-request-review-and-current-authority', 'complete-current-namespace-and-native-graph',
  'kernel-lifecycle-fence-and-exact-registry-path-receipts', 'fresh-durable-native-states-and-targeted-inverse-receipts',
  'fresh-copy-identities-block-id-map-and-link-rebinding',
];
const proofString = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function exactKeys(value: unknown, expected: readonly string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}
const entityKey = (entry: NativeNamespaceEntry) => nativeLinkJsonProof({ workspaceId: entry.workspaceId, identity: entry.identity });
const evidenceKey = (document: NativeDocumentLinkInventory['document']) => nativeLinkJsonProof({ workspaceId: document.workspaceId,
  documentId: document.documentId, lifecycleGeneration: document.lifecycleGeneration });
function deleteLinkRecipes(nativeSnapshot: NativeWorkspaceLinkSnapshot, source: NativeNamespaceEntry): NativeLinkMutationRecipe[] {
  const deletePlan = createWorkspaceNativeFileOperationPlan({ kind: 'delete', sourceWorkspaceId: nativeSnapshot.workspaceId,
    destinationWorkspaceId: nativeSnapshot.workspaceId, selections: [{ sourcePath: source.path }], snapshots: [nativeSnapshot] });
  if (deletePlan.readiness !== 'ready' || deletePlan.issues.length
    || !isDeepStrictEqual(deletePlan.pathMappings, [{ source, destinationPath: '', destinationWorkspaceId: nativeSnapshot.workspaceId }])) {
    fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  }
  // A single file Delete may change only surviving, genuinely native sources.
  // No copy rebinding, destination move or legacy Markdown span is admitted.
  if (deletePlan.mutations.some(recipe => recipe.action !== 'unlink' || recipe.nextValue !== null || recipe.cloneSelection !== null
    || recipe.source.workspaceId !== nativeSnapshot.workspaceId || recipe.destinationWorkspaceId !== nativeSnapshot.workspaceId
    || recipe.source.path === source.path || recipe.sourcePathAfter !== recipe.source.path || recipe.expectedTargetIdentity !== source.identity
    || !nativeSnapshot.documents.some(inventory => isDeepStrictEqual(inventory.document, recipe.source)
      && isDeepStrictEqual(inventory.version, recipe.sourceVersion) && inventory.links.some(link => link.id === recipe.linkId
        && isDeepStrictEqual(link.ref, recipe.reference))))) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  return deletePlan.mutations;
}
function finalMetadata(value: unknown, inventory: NativeDocumentLinkInventory, changed: boolean): boolean {
  if (!changed) return isDeepStrictEqual(value, inventory.metadata);
  if (!exactKeys(value, ['path', 'aliases', 'tags', 'title', 'hasExplicitTitle', 'headings', 'blockIds'])) return false;
  const metadata = value as NativeDocumentLinkInventory['metadata'];
  if (metadata.path !== inventory.document.path || typeof metadata.title !== 'string' || typeof metadata.hasExplicitTitle !== 'boolean'
    || ![metadata.aliases, metadata.tags, metadata.blockIds].every(items => Array.isArray(items) && items.every(item => typeof item === 'string'))
    || !Array.isArray(metadata.headings) || metadata.headings.some(heading => !exactKeys(heading, ['depth', 'text'])
      || !Number.isSafeInteger(heading.depth) || heading.depth < 1 || heading.depth > 6 || typeof heading.text !== 'string')) return false;
  // Rich unlink adapters edit the body only. Heading text/title can change when
  // an embedded image disappears; frontmatter and block-ID metadata cannot.
  return inventory.document.representation === 'plain_text' || ['aliases', 'tags', 'hasExplicitTitle', 'blockIds'].every(key =>
    isDeepStrictEqual(Reflect.get(metadata, key), Reflect.get(inventory.metadata, key)))
    && (!metadata.hasExplicitTitle || metadata.title === inventory.metadata.title);
}
function validateGraph(graph: NativeMixedBatchPlan, nativeSnapshot: NativeWorkspaceLinkSnapshot, source: NativeNamespaceEntry): void {
  if (!exactKeys(graph, graphKeys) || ['issues', 'cloneRequirements', 'steps', 'requests', 'snapshotProofs', 'documentEvidence',
    'finalNamespace', 'finalEdges', 'requiredCoordinatorBindings'].some(key => !Array.isArray(Reflect.get(graph, key)))) fail();
  if (graph.steps.length === 1 && !exactKeys(graph.steps[0], ['requestIndex', 'request', 'beforeGraphProof', 'afterGraphProof', 'namespaceEffects', 'linkIntents'])) fail();
  const { planId, ...body } = graph;
  if (graph.contractVersion !== 2 || graph.compilerVersion !== 1 || graph.readiness !== 'ready' || graph.executionReady !== false
    || graph.issues.length || graph.cloneRequirements.length || graph.steps.length !== 1 || graph.requests.length !== 1
    || nativeLinkJsonProof(body) !== planId) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  const workspaceId = nativeSnapshot.workspaceId, sourcePath = source.path;
  const request = { kind: 'delete' as const, sourceWorkspaceId: workspaceId, destinationWorkspaceId: workspaceId, selections: [{ sourcePath }] };
  const step = graph.steps[0], targetEntityKey = entityKey(source);
  if (!exactKeys(step, ['requestIndex', 'request', 'beforeGraphProof', 'afterGraphProof', 'namespaceEffects', 'linkIntents'])
    || step.requestIndex !== 0 || !Array.isArray(step.linkIntents) || !proofString(step.beforeGraphProof)
    || !isDeepStrictEqual(graph.requests, [request]) || !isDeepStrictEqual(step.request, request)
    || !isDeepStrictEqual(step.namespaceEffects, [{ entityKey: targetEntityKey, sourceEntityKey: targetEntityKey,
      sourceWorkspaceId: workspaceId, sourcePath, destinationWorkspaceId: workspaceId, destinationPath: null }])
    || !isDeepStrictEqual(graph.requiredCoordinatorBindings, coordinatorBindings)
    || !isDeepStrictEqual(graph.snapshotProofs, [{ workspaceId, proof: nativeSnapshot.snapshotProof }])
    || !isDeepStrictEqual(graph.documentEvidence, nativeSnapshot.documents.map(inventory => ({ evidenceKey: evidenceKey(inventory.document), inventory }))
      .sort((a, b) => a.evidenceKey.localeCompare(b.evidenceKey)))) fail();
  const recipes = deleteLinkRecipes(nativeSnapshot, source);
  const expectedIntents = recipes.map(recipe => {
    const entry = nativeSnapshot.namespace.find(candidate => candidate.documentId === recipe.source.documentId)!;
    const owner = entityKey(entry);
    return { virtualLinkKey: nativeLinkJsonProof({ entityKey: owner, linkId: recipe.linkId }), entityKey: owner,
      originEvidenceLinkId: recipe.linkId, action: 'unlink',
      expectedValue: String(recipe.reference.kind === 'link-mark' ? recipe.reference.expected.href : recipe.reference.expected),
      nextValue: null, expectedTargetEntityKey: targetEntityKey, targetEntityKeyAfter: null, adapterCheck: 'native-forward-and-targeted-inverse' };
  }).sort((a, b) => a.virtualLinkKey.localeCompare(b.virtualLinkKey));
  // Intent order is the compiler's sorted virtual-edge order, independently
  // derived from actual source inventories rather than the submitted graph.
  if (!isDeepStrictEqual(step.linkIntents, expectedIntents)) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  const survivors = nativeSnapshot.namespace.filter(entry => entry.path !== sourcePath).sort((a, b) => entityKey(a).localeCompare(entityKey(b)));
  if (graph.finalNamespace.length !== survivors.length) fail();
  for (const [index, entry] of survivors.entries()) {
    const actual = graph.finalNamespace[index], inventory = nativeSnapshot.documents.find(value => value.document.path === entry.path);
    if (!exactKeys(actual, ['entityKey', 'workspaceId', 'path', 'kind', 'binding', 'contentBasisProof', 'metadata'])
      || actual.entityKey !== entityKey(entry) || actual.workspaceId !== workspaceId || actual.path !== entry.path || actual.kind !== entry.kind
      || !isDeepStrictEqual(actual.binding, { kind: 'existing', namespaceEvidence: entry, documentEvidenceKey: inventory ? evidenceKey(inventory.document) : null })
      || (inventory ? !proofString(actual.contentBasisProof) || !finalMetadata(actual.metadata, inventory,
        recipes.some(recipe => recipe.source.documentId === inventory.document.documentId)) : actual.contentBasisProof !== null || actual.metadata !== null)) fail();
  }
  const finalSnapshot: NativeWorkspaceLinkSnapshot = { ...nativeSnapshot, namespace: survivors,
    documents: nativeSnapshot.documents.filter(inventory => inventory.document.path !== sourcePath).map(inventory => ({ ...inventory,
      links: inventory.links.filter(link => !recipes.some(recipe => recipe.source.documentId === inventory.document.documentId && recipe.linkId === link.id)) })) };
  const finalEdges = buildWorkspaceNativeLinkGraph(finalSnapshot).edges.map(edge => {
    const owner = entityKey(survivors.find(entry => entry.documentId === edge.source.documentId)!);
    return { virtualLinkKey: nativeLinkJsonProof({ entityKey: owner, linkId: edge.id }), sourceEntityKey: owner,
      originEvidenceLinkId: edge.id, literal: edge.literal, targetPathText: edge.targetPathText,
      resolution: { status: edge.resolution.status, targetEntityKey: edge.resolution.target ? entityKey(edge.resolution.target) : null,
        candidateEntityKeys: edge.resolution.candidates.map(entityKey).sort() } };
  }).sort((a, b) => a.virtualLinkKey.localeCompare(b.virtualLinkKey));
  if (!isDeepStrictEqual(graph.finalEdges, finalEdges) || !proofString(graph.finalGraphProof)
    || graph.finalGraphProof !== nativeLinkJsonProof({ namespace: graph.finalNamespace, edges: finalEdges })
    || step.afterGraphProof !== graph.finalGraphProof) fail();
  // The historical DTO has no private bytes with which to derive native content
  // hashes or changed heading metadata. Current validation below reruns the real
  // compiler with proven current bytes and requires the complete original graph.
}
function compatibility(nativeSnapshot: NativeWorkspaceLinkSnapshot): Pick<WorkspaceOperationNativeDeleteBatchPlan, 'coverage' | 'linkAssessment'> {
  const graph = buildWorkspaceNativeLinkGraph(nativeSnapshot);
  return { coverage: { complete: true, omittedSources: [], unresolvedLinks: graph.edges.filter(edge => edge.resolution.status !== 'resolved')
    .map(edge => ({ sourcePath: edge.source.path, targetLiteral: edge.literal,
      status: edge.resolution.status as Exclude<typeof edge.resolution.status, 'resolved'> })) },
  linkAssessment: { version: 1, complete: true, warnings: [], blockers: [] } };
}
/** V2 identity binds the complete private evidence and genuine compiler result.
 * This is historical data integrity, never a mutation capability. */
export function computeWorkspaceOperationNativeDeleteBatchPlanId(plan: Omit<WorkspaceOperationNativeDeleteBatchPlan, 'planId'>): string {
  const { planId: _historical, ...body } = plan as WorkspaceOperationNativeDeleteBatchPlan;
  return nativeLinkJsonProof(body);
}
export function decodeWorkspaceOperationNativeDeleteBatchPlan(input: unknown): WorkspaceOperationNativeDeleteBatchPlan {
  try {
    const value = capture(input) as WorkspaceOperationNativeDeleteBatchPlan;
    if (!value || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
      || value.version !== 2 || value.kind !== 'native-original-delete' || value.readiness !== 'ready') fail();
    const evidence = decodeWorkspaceOperationNativeSourceEvidence(value.sourceEvidence);
    const scope = parseWorkspaceOperationJobScope(evidence.workspaceScope), selected = action(value.actions);
    if (value.workspaceId !== scope.workspaceId || value.workspaceId !== evidence.stage.workspaceId) fail();
    const binding = evidence.nativeBindings.find(item => item.expected.path === selected.selections[0].sourcePath);
    if (!binding || !isDeepStrictEqual(binding.expected, value.nativeTarget)) fail();
    const source = evidence.stage.namespace.find(entry => entry.path === binding.expected.path);
    if (!source || source.kind !== 'file' || source.documentId !== binding.expected.documentId) fail();
    for (const key of ['pathMappings', 'linkEdits', 'originalDocuments', 'deletedDocuments', 'previewContents', 'issues'] as const) {
      if (!Array.isArray(value[key]) || value[key]!.length) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
    }
    if (!isDeepStrictEqual(value.pathSteps, [{ reviewId: selected.reviewId, kind: 'delete', sourcePath: source.path }])
      || !isDeepStrictEqual(value.deletedPaths, [{ path: source.path, kind: 'file', identity: source.filesystemIdentity ?? `native:${binding.expected.stateProof}` }])
      || !isDeepStrictEqual(value.expectedPathState, [{ workspaceId: value.workspaceId, path: source.path, identity: source.filesystemIdentity, contentHash: null }])) fail();
    const originalSnapshot = snapshot(evidence);
    validateGraph(value.nativeGraphPlan, originalSnapshot, source);
    const diagnostic = compatibility(originalSnapshot);
    if (!isDeepStrictEqual(value.coverage, diagnostic.coverage) || !isDeepStrictEqual(value.linkAssessment, diagnostic.linkAssessment)) fail();
    const { planId, ...body } = value;
    if (computeWorkspaceOperationNativeDeleteBatchPlanId(body) !== planId) fail();
    return freeze(value);
  } catch (error) {
    if (error instanceof WorkspaceOperationNativeDeletePlanError || error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error;
    return fail();
  }
}
export function createWorkspaceOperationNativeDeleteBatchPlan(input: {
  scope: WorkspaceOperationBatchScope; actions: WorkspaceOperationBatchAction[]; observation: WorkspaceLinkSourceAuthorityObservation;
}): WorkspaceOperationNativeDeleteBatchPlan {
  const selected = action(capture(input.actions) as WorkspaceOperationBatchAction[]);
  const sourceEvidence = captureWorkspaceOperationNativeSourceEvidence(captureWorkspaceOperationJobScope(input.scope.workspace), input.observation);
  const source = sourceEvidence.stage.namespace.find(entry => entry.path === selected.selections[0].sourcePath);
  const binding = sourceEvidence.nativeBindings.find(entry => entry.expected.path === selected.selections[0].sourcePath);
  if (!source || source.kind !== 'file' || !binding) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  const nativeSnapshot = snapshot(input.observation);
  const nativeGraphPlan = compileWorkspaceNativeMixedBatch({ snapshots: [nativeSnapshot], states: input.observation.privateNativeStates,
    requests: [{ kind: 'delete', sourceWorkspaceId: sourceEvidence.stage.workspaceId, destinationWorkspaceId: sourceEvidence.stage.workspaceId,
      selections: [{ sourcePath: source.path }] }] });
  validateGraph(nativeGraphPlan, nativeSnapshot, source);
  const body: Omit<WorkspaceOperationNativeDeleteBatchPlan, 'planId'> = { version: 2, kind: 'native-original-delete',
    workspaceId: input.scope.workspace.workspaceId, readiness: 'ready', actions: [selected], pathMappings: [],
    deletedPaths: [{ path: source.path, kind: 'file', identity: source.filesystemIdentity ?? `native:${binding.expected.stateProof}` }],
    pathSteps: [{ reviewId: selected.reviewId, kind: 'delete', sourcePath: source.path }], linkEdits: [], originalDocuments: [],
    deletedDocuments: [], previewContents: [], expectedPathState: [{ workspaceId: input.scope.workspace.workspaceId, path: source.path,
      identity: source.filesystemIdentity, contentHash: null }], ...compatibility(nativeSnapshot),
    issues: [], sourceEvidence, nativeTarget: binding.expected, nativeGraphPlan };
  return decodeWorkspaceOperationNativeDeleteBatchPlan({ ...body, planId: computeWorkspaceOperationNativeDeleteBatchPlanId(body) });
}
/** Caller must already hold genuine current rights and the mutation fence.
 * Other projections and our own path-stage effects may change; native+asset
 * semantics may not. The runner separately checks the initial target FS pin. */
export function assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan: WorkspaceOperationNativeDeleteBatchPlan,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): void {
  const original = decodeWorkspaceOperationNativeDeleteBatchPlan(plan);
  assertWorkspaceOperationNativeSourceEvidenceCurrent(original.sourceEvidence, observation, scopeSnapshot);
  const binding = observation.nativeBindings.find(item => item.expected.documentId === original.nativeTarget.documentId);
  if (!binding || !isDeepStrictEqual(binding.expected, original.nativeTarget)) fail('NATIVE_DELETE_PLAN_CHANGED');
  // Current evidence permits replaceable projections and directory mtimes to
  // differ. Replay the ORIGINAL namespace with the newly proven native bytes:
  // every compiler field must still equal the historical genuine result.
  const originalSnapshot = snapshot(original.sourceEvidence);
  const graph = compileWorkspaceNativeMixedBatch({ snapshots: [originalSnapshot], states: observation.privateNativeStates,
    requests: original.nativeGraphPlan.requests });
  const source = originalSnapshot.namespace.find(entry => entry.path === original.nativeTarget.path)!;
  validateGraph(graph, originalSnapshot, source);
  if (!isDeepStrictEqual(graph, original.nativeGraphPlan)) fail('NATIVE_DELETE_PLAN_CHANGED');
}

/** Actual original-source recipes only. A decoded historical graph is evidence,
 * never native mutation authority; callers must prove current rights/fences and
 * prepare exact deltas from the matching private durable states separately. */
export function getWorkspaceOperationNativeDeleteLinkRecipes(plan: WorkspaceOperationNativeDeleteBatchPlan): NativeLinkMutationRecipe[] {
  const original = decodeWorkspaceOperationNativeDeleteBatchPlan(plan), originalSnapshot = snapshot(original.sourceEvidence);
  const source = originalSnapshot.namespace.find(entry => entry.path === original.nativeTarget.path)!;
  return structuredClone(deleteLinkRecipes(originalSnapshot, source));
}

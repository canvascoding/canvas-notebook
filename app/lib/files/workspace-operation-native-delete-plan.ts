import 'server-only';

import { isDeepStrictEqual, types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import type { NativeDocumentLinkInventory, NativeLinkMutationRecipe, NativeNamespaceEntry, NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
import type { WorkspaceMixedReadLinkSnapshotV3 } from '../markdown/workspace-link-contract-v3';
import { compileWorkspaceMixedReadBatchV3, compileWorkspaceNativeMixedBatch, type NativeMixedBatchPlan,
  type NativeMixedReadBatchPlanV3 } from '../markdown/workspace-native-mixed-batch-compiler';
import { buildWorkspaceMixedReadLinkGraphV3, buildWorkspaceNativeLinkGraph } from '../markdown/workspace-native-link-graph';
import { createWorkspaceMixedReadFileOperationPlanV3, createWorkspaceNativeFileOperationPlan } from '../markdown/workspace-native-file-operation-planner';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { assertWorkspaceOperationNativeSourceEvidenceCurrent, captureWorkspaceOperationNativeSourceEvidence,
  captureWorkspaceOperationNativeSourceEvidenceV2, decodeWorkspaceOperationNativeSourceEvidence,
  WorkspaceOperationNativeSourceEvidenceError, type WorkspaceOperationNativeSourceEvidenceV2 } from './workspace-operation-native-source-evidence';
import { captureWorkspaceOperationNativeSourceEvidenceV3, decodeWorkspaceOperationNativeSourceEvidenceV3,
  type WorkspaceOperationNativeSourceEvidenceV3 } from './workspace-operation-native-source-evidence-v3';
import { workspaceOperationMixedSourceSnapshot } from './workspace-operation-mixed-source-evidence';
import { captureWorkspaceOperationNativePlanData, workspaceOperationNativePlanSnapshot } from './workspace-operation-native-plan-data';
import type { WorkspaceOperationBatchAction, WorkspaceOperationBatchScope, WorkspaceOperationJobScope,
  WorkspaceOperationNativeDeleteBatchPlan, WorkspaceOperationNativeDeleteBatchPlanLegacy,
  WorkspaceOperationNativeDeleteBatchPlanV2, WorkspaceOperationNativeDeleteBatchPlanV3 } from './workspace-operation-batch-contract';

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
  return captureWorkspaceOperationNativePlanData(input, reason => fail(reason === 'too-large'
    ? 'NATIVE_DELETE_PLAN_TOO_LARGE' : 'NATIVE_DELETE_PLAN_INVALID'));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function snapshot(observation: Pick<WorkspaceLinkSourceAuthorityObservation, 'stage'>): NativeWorkspaceLinkSnapshot {
  return workspaceOperationNativePlanSnapshot(observation, () => fail('NATIVE_DELETE_PLAN_UNSUPPORTED'));
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
/** Only immediately own-data-captured local values enter these synchronous
 * hash helpers. No plan, proof, current result or authority is cached. */
function nativeDeletePlanIdFromCapturedData(plan: WorkspaceOperationNativeDeleteBatchPlan): string {
  const { planId: _historical, ...body } = plan;
  if (body.planIdentityVersion === 3) return nativeLinkJsonProof({ version: body.version, kind: body.kind,
    planIdentityVersion: 3, workspaceId: body.workspaceId, readiness: body.readiness, actions: body.actions,
    workspaceScope: body.sourceEvidence.workspaceScope, sourceSemanticProof: body.sourceEvidence.semanticProof });
  if (body.planIdentityVersion === 2) return nativeLinkJsonProof({ version: body.version, kind: body.kind,
    planIdentityVersion: 2, workspaceId: body.workspaceId, readiness: body.readiness, actions: body.actions,
    sourceSemanticProof: body.sourceEvidence.semanticProof });
  return nativeLinkJsonProof(body);
}
/** Original raw identity remains unchanged. The explicit new arm identifies
 * semantics while its separate integrity proof binds every historical fact. */
export function computeWorkspaceOperationNativeDeleteBatchPlanId(plan: Omit<WorkspaceOperationNativeDeleteBatchPlan, 'planId'>): string {
  const mixed = plan && typeof plan === 'object' && !types.isProxy(plan)
    && Object.getOwnPropertyDescriptor(plan, 'planIdentityVersion')?.value === 3;
  return nativeDeletePlanIdFromCapturedData((mixed ? captureDeleteV3(plan) : capture(plan)) as WorkspaceOperationNativeDeleteBatchPlan);
}
/** Historical integrity only; neither this proof nor a semantic ID is current
 * actor authority, original-target ownership or an execution capability. */
export function computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProof(
  plan: Omit<WorkspaceOperationNativeDeleteBatchPlanV2, 'integrityProof'> | Omit<WorkspaceOperationNativeDeleteBatchPlanV3, 'integrityProof'>): string {
  const mixed = plan && typeof plan === 'object' && !types.isProxy(plan)
    && Object.getOwnPropertyDescriptor(plan, 'planIdentityVersion')?.value === 3;
  return nativeDeletePlanIntegrityProofFromCapturedData((mixed ? captureDeleteV3(plan) : capture(plan)) as WorkspaceOperationNativeDeleteBatchPlanV2 | WorkspaceOperationNativeDeleteBatchPlanV3);
}
function nativeDeletePlanIntegrityProofFromCapturedData(
  plan: WorkspaceOperationNativeDeleteBatchPlanV2 | WorkspaceOperationNativeDeleteBatchPlanV3,
): string {
  const { integrityProof: _historical, ...body } = plan;
  if (body.planIdentityVersion === 3) return nativeLinkJsonProof({ integrityVersion: 3, plan: body });
  return nativeLinkJsonProof({ integrityVersion: 2, plan: body });
}
export function decodeWorkspaceOperationNativeDeleteBatchPlan(input: unknown): WorkspaceOperationNativeDeleteBatchPlan {
  try {
    const mixed = input && typeof input === 'object' && !types.isProxy(input)
      && Object.getOwnPropertyDescriptor(input, 'planIdentityVersion')?.value === 3;
    const value = (mixed ? captureDeleteV3(input) : capture(input)) as WorkspaceOperationNativeDeleteBatchPlan;
    const semantic = value && Object.hasOwn(value, 'planIdentityVersion');
    const expectedKeys = semantic ? [...keys, 'planIdentityVersion', 'integrityProof'] : keys;
    if (!value || !exactKeys(value, expectedKeys) || semantic && value.planIdentityVersion !== 2 && value.planIdentityVersion !== 3
      || value.version !== 2 || value.kind !== 'native-original-delete' || value.readiness !== 'ready') fail();
    if (semantic && (!proofString(value.integrityProof)
      || nativeDeletePlanIntegrityProofFromCapturedData(value as WorkspaceOperationNativeDeleteBatchPlanV2 | WorkspaceOperationNativeDeleteBatchPlanV3) !== value.integrityProof)) fail();
    if (value.planIdentityVersion === 3) {
      const evidence = decodeWorkspaceOperationNativeSourceEvidenceV3(value.sourceEvidence);
      const scope = parseWorkspaceOperationJobScope(evidence.workspaceScope), selected = action(value.actions);
      if (scope.legacy || value.workspaceId !== scope.workspaceId) fail();
      const originalSnapshot = workspaceOperationMixedSourceSnapshot(evidence);
      const source = originalSnapshot.namespace.find(entry => entry.path === selected.selections[0].sourcePath);
      const binding = evidence.nativeComponent.nativeBindings.find(item => item.expected.path === source?.path);
      if (!source || source.kind !== 'file' || !binding || source.documentId !== binding.expected.documentId
        || !isDeepStrictEqual(binding.expected, value.nativeTarget)) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
      for (const key of ['pathMappings', 'linkEdits', 'originalDocuments', 'deletedDocuments', 'previewContents', 'issues'] as const) {
        if (!Array.isArray(value[key]) || value[key]!.length) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
      }
      if (!isDeepStrictEqual(value.pathSteps, [{ reviewId: selected.reviewId, kind: 'delete', sourcePath: source.path }])
        || !isDeepStrictEqual(value.deletedPaths, [{ path: source.path, kind: 'file', identity: source.filesystemIdentity ?? `native:${binding.expected.stateProof}` }])
        || !isDeepStrictEqual(value.expectedPathState, [{ workspaceId: value.workspaceId, path: source.path, identity: source.filesystemIdentity, contentHash: null }])) fail();
      validateDeleteGraphV3(value.nativeGraphPlan, originalSnapshot, source);
      const diagnostic = deleteCompatibilityV3(originalSnapshot);
      if (!isDeepStrictEqual(value.coverage, diagnostic.coverage) || !isDeepStrictEqual(value.linkAssessment, diagnostic.linkAssessment)
        || nativeDeletePlanIdFromCapturedData(value) !== value.planId) fail();
      return freeze(value);
    }
    const evidence = decodeWorkspaceOperationNativeSourceEvidence(value.sourceEvidence);
    if (semantic && evidence.evidenceVersion !== 2) fail();
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
    if (nativeDeletePlanIdFromCapturedData(body as WorkspaceOperationNativeDeleteBatchPlan) !== planId) fail();
    return freeze(value);
  } catch (error) {
    if (error instanceof WorkspaceOperationNativeDeletePlanError || error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error;
    return fail();
  }
}
type NativeDeletePlanInput = {
  scope: WorkspaceOperationBatchScope; actions: WorkspaceOperationBatchAction[]; observation: WorkspaceLinkSourceAuthorityObservation;
};
/** No observation getter is evaluated to select a version or obtain bytes after
 * evidence capture. The evidence validator bounds the complete private input. */
function observationData(input: WorkspaceLinkSourceAuthorityObservation, name: 'privateCatalogue' | 'privateNativeStates'): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) fail();
  const property = Object.getOwnPropertyDescriptor(input, name);
  if (property && (!property.enumerable || !Object.hasOwn(property, 'value'))) fail();
  return property?.value;
}
function createPlan(input: NativeDeletePlanInput, identityVersion: 1 | 2): WorkspaceOperationNativeDeleteBatchPlanLegacy | WorkspaceOperationNativeDeleteBatchPlanV2 {
  const selected = action(capture(input.actions) as WorkspaceOperationBatchAction[]);
  const scope = captureWorkspaceOperationJobScope(input.scope.workspace);
  const sourceEvidence = identityVersion === 2 ? captureWorkspaceOperationNativeSourceEvidenceV2(scope, input.observation)
    : captureWorkspaceOperationNativeSourceEvidence(scope, input.observation);
  const source = sourceEvidence.stage.namespace.find(entry => entry.path === selected.selections[0].sourcePath);
  const binding = sourceEvidence.nativeBindings.find(entry => entry.expected.path === selected.selections[0].sourcePath);
  if (!source || source.kind !== 'file' || !binding) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  const nativeSnapshot = snapshot(sourceEvidence);
  const states = structuredClone(observationData(input.observation, 'privateNativeStates')) as WorkspaceLinkSourceAuthorityObservation['privateNativeStates'];
  const nativeGraphPlan = compileWorkspaceNativeMixedBatch({ snapshots: [nativeSnapshot], states,
    requests: [{ kind: 'delete', sourceWorkspaceId: sourceEvidence.stage.workspaceId, destinationWorkspaceId: sourceEvidence.stage.workspaceId,
      selections: [{ sourcePath: source.path }] }] });
  validateGraph(nativeGraphPlan, nativeSnapshot, source);
  const body = { version: 2 as const, kind: 'native-original-delete' as const,
    workspaceId: input.scope.workspace.workspaceId, readiness: 'ready', actions: [selected], pathMappings: [],
    deletedPaths: [{ path: source.path, kind: 'file', identity: source.filesystemIdentity ?? `native:${binding.expected.stateProof}` }],
    pathSteps: [{ reviewId: selected.reviewId, kind: 'delete', sourcePath: source.path }], linkEdits: [], originalDocuments: [],
    deletedDocuments: [], previewContents: [], expectedPathState: [{ workspaceId: input.scope.workspace.workspaceId, path: source.path,
      identity: source.filesystemIdentity, contentHash: null }], ...compatibility(nativeSnapshot),
    issues: [], sourceEvidence, nativeTarget: binding.expected, nativeGraphPlan };
  const identified = identityVersion === 2 ? { ...body, planIdentityVersion: 2 as const } : body;
  const planned = { ...identified, planId: computeWorkspaceOperationNativeDeleteBatchPlanId(
    identified as Omit<WorkspaceOperationNativeDeleteBatchPlan, 'planId'>) };
  return decodeWorkspaceOperationNativeDeleteBatchPlan(identityVersion === 1 ? planned : { ...planned,
    integrityProof: computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProof(
      planned as Omit<WorkspaceOperationNativeDeleteBatchPlanV2, 'integrityProof'>) }) as WorkspaceOperationNativeDeleteBatchPlanLegacy | WorkspaceOperationNativeDeleteBatchPlanV2;
}
/** Production observations include a complete catalogue. Present malformed or
 * undefined witness data selects V2 and fails rather than falling back. */
export function createWorkspaceOperationNativeDeleteBatchPlan(input: NativeDeletePlanInput): WorkspaceOperationNativeDeleteBatchPlanLegacy | WorkspaceOperationNativeDeleteBatchPlanV2 {
  // Reject exotic observations and accessors before choosing a version.
  observationData(input.observation, 'privateCatalogue');
  return createPlan(input, Object.hasOwn(input.observation, 'privateCatalogue') ? 2 : 1);
}
/** Explicit historical construction retains the original exact raw formula. */
export function createWorkspaceOperationNativeDeleteBatchPlanLegacy(input: NativeDeletePlanInput): WorkspaceOperationNativeDeleteBatchPlanLegacy {
  return createPlan(input, 1) as WorkspaceOperationNativeDeleteBatchPlanLegacy;
}
/** Explicit new construction requires its own complete transient catalogue. */
export function createWorkspaceOperationNativeDeleteBatchPlanV2(input: NativeDeletePlanInput): WorkspaceOperationNativeDeleteBatchPlanV2 {
  return createPlan(input, 2) as WorkspaceOperationNativeDeleteBatchPlanV2;
}
/** Fresh factual evidence only. Requires caller-held current rights and fences;
 * no catalogue-less historical replay can acquire projection tolerance here. */
export function captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(plan: WorkspaceOperationNativeDeleteBatchPlanV2,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): WorkspaceOperationNativeSourceEvidenceV2;
export function captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(plan: WorkspaceOperationNativeDeleteBatchPlanV3,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): WorkspaceOperationNativeSourceEvidenceV3;
export function captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(plan: WorkspaceOperationNativeDeleteBatchPlanV2 | WorkspaceOperationNativeDeleteBatchPlanV3,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): WorkspaceOperationNativeSourceEvidenceV2 | WorkspaceOperationNativeSourceEvidenceV3;
export function captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(plan: WorkspaceOperationNativeDeleteBatchPlanV2 | WorkspaceOperationNativeDeleteBatchPlanV3,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): WorkspaceOperationNativeSourceEvidenceV2 | WorkspaceOperationNativeSourceEvidenceV3 {
  const original = decodeWorkspaceOperationNativeDeleteBatchPlan(plan);
  return captureNativeDeleteCurrentWitnessFromDecodedPlan(original, observation, scopeSnapshot);
}
/** Only the immediate strict decoder result enters here. Fresh observation,
 * catalogue, private-byte and compiler checks remain inside this call. */
function captureNativeDeleteCurrentWitnessFromDecodedPlan(original: WorkspaceOperationNativeDeleteBatchPlan,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): WorkspaceOperationNativeSourceEvidenceV2 | WorkspaceOperationNativeSourceEvidenceV3 {
  if (original.planIdentityVersion === 3) return replayDeleteCurrentV3(original, observation, scopeSnapshot);
  if (original.planIdentityVersion !== 2) fail();
  const witness = captureWorkspaceOperationNativeSourceEvidenceV2(scopeSnapshot, observation);
  if (witness.semanticProof !== original.sourceEvidence.semanticProof) {
    throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_CHANGED');
  }
  // Semantic equivalence has already proven the complete current catalogue,
  // every native binding and actual private bytes. Keep the original namespace
  // for graph replay so replaceable projections never become compiler identity.
  const originalSnapshot = snapshot(original.sourceEvidence);
  const states = structuredClone(observationData(observation, 'privateNativeStates')) as WorkspaceLinkSourceAuthorityObservation['privateNativeStates'];
  const graph = compileWorkspaceNativeMixedBatch({ snapshots: [originalSnapshot], states,
    requests: original.nativeGraphPlan.requests });
  const source = originalSnapshot.namespace.find(entry => entry.path === original.nativeTarget.path)!;
  validateGraph(graph, originalSnapshot, source);
  if (!isDeepStrictEqual(graph, original.nativeGraphPlan)) fail('NATIVE_DELETE_PLAN_CHANGED');
  return witness;
}
/** Caller must already hold genuine current rights and the mutation fence.
 * Other projections and our own path-stage effects may change; native+asset
 * semantics may not. The runner separately checks the initial target FS pin. */
export function assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan: WorkspaceOperationNativeDeleteBatchPlan,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): void {
  const original = decodeWorkspaceOperationNativeDeleteBatchPlan(plan);
  if (original.planIdentityVersion === 3) {
    captureNativeDeleteCurrentWitnessFromDecodedPlan(original, observation, scopeSnapshot);
    return;
  }
  if (original.planIdentityVersion === 2) {
    captureNativeDeleteCurrentWitnessFromDecodedPlan(original, observation, scopeSnapshot);
    return;
  }
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
  const original = decodeWorkspaceOperationNativeDeleteBatchPlan(plan);
  if (original.planIdentityVersion === 3) {
    const originalSnapshot = workspaceOperationMixedSourceSnapshot(original.sourceEvidence);
    const source = originalSnapshot.namespace.find(entry => entry.path === original.nativeTarget.path)!;
    return structuredClone(deleteLinkRecipesV3(originalSnapshot, source));
  }
  const originalSnapshot = snapshot(original.sourceEvidence);
  const source = originalSnapshot.namespace.find(entry => entry.path === original.nativeTarget.path)!;
  return structuredClone(deleteLinkRecipes(originalSnapshot, source));
}

/** V3 bounds the escaped persisted envelope before allocating its serialization. */
function captureDeleteV3(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => fail(reason === 'too-large'
    ? 'NATIVE_DELETE_PLAN_TOO_LARGE' : 'NATIVE_DELETE_PLAN_INVALID'), 16 * 1024 * 1024);
}

function deleteV3Field(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) fail();
  const property = Object.getOwnPropertyDescriptor(input, key);
  if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail();
  return property.value;
}

/** Reuse the full mixed resolver/planner. Every physical source is retained;
 * selection or necessary unlink of one is rejected before producing recipes. */
function deleteLinkRecipesV3(originalSnapshot: WorkspaceMixedReadLinkSnapshotV3, source: NativeNamespaceEntry): NativeLinkMutationRecipe[] {
  const planned = createWorkspaceMixedReadFileOperationPlanV3({ kind: 'delete', sourceWorkspaceId: originalSnapshot.workspaceId,
    destinationWorkspaceId: originalSnapshot.workspaceId, selections: [{ sourcePath: source.path }], snapshots: [originalSnapshot] });
  if (planned.readiness !== 'ready' || planned.issues.length
    || !isDeepStrictEqual(planned.pathMappings, [{ source, destinationPath: '', destinationWorkspaceId: originalSnapshot.workspaceId }])
    || planned.mutations.some(recipe => recipe.action !== 'unlink' || recipe.nextValue !== null || recipe.cloneSelection !== null
      || recipe.source.workspaceId !== originalSnapshot.workspaceId || recipe.destinationWorkspaceId !== originalSnapshot.workspaceId
      || recipe.source.path === source.path || recipe.sourcePathAfter !== recipe.source.path || recipe.expectedTargetIdentity !== source.identity
      || !originalSnapshot.documents.some(inventory => isDeepStrictEqual(inventory.document, recipe.source)
        && isDeepStrictEqual(inventory.version, recipe.sourceVersion) && inventory.links.some(link => link.id === recipe.linkId
          && isDeepStrictEqual(link.ref, recipe.reference))))) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  return planned.mutations;
}

/** Historical structural check only. Without private native bytes, native
 * content hashes and changed body metadata remain assertions, not permission.
 * Current replay below proves the complete compiler output before mutation. */
function validateDeleteGraphV3(graph: NativeMixedReadBatchPlanV3, originalSnapshot: WorkspaceMixedReadLinkSnapshotV3,
  source: NativeNamespaceEntry): void {
  if (!exactKeys(graph, graphKeys) || ['issues', 'cloneRequirements', 'steps', 'requests', 'snapshotProofs', 'documentEvidence',
    'finalNamespace', 'finalEdges', 'requiredCoordinatorBindings'].some(key => !Array.isArray(Reflect.get(graph, key)))) fail();
  const { planId, ...body } = graph;
  if (graph.contractVersion !== 3 || graph.compilerVersion !== 1 || graph.readiness !== 'ready' || graph.executionReady !== false
    || graph.issues.length || graph.cloneRequirements.length || graph.steps.length !== 1 || graph.requests.length !== 1
    || nativeLinkJsonProof(body) !== planId) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  const workspaceId = originalSnapshot.workspaceId, sourcePath = source.path, targetEntityKey = entityKey(source);
  const request = { kind: 'delete' as const, sourceWorkspaceId: workspaceId, destinationWorkspaceId: workspaceId, selections: [{ sourcePath }] };
  const step = graph.steps[0];
  if (!exactKeys(step, ['requestIndex', 'request', 'beforeGraphProof', 'afterGraphProof', 'namespaceEffects', 'linkIntents'])
    || step.requestIndex !== 0 || !Array.isArray(step.linkIntents) || !proofString(step.beforeGraphProof)
    || !isDeepStrictEqual(graph.requests, [request]) || !isDeepStrictEqual(step.request, request)
    || !isDeepStrictEqual(step.namespaceEffects, [{ entityKey: targetEntityKey, sourceEntityKey: targetEntityKey,
      sourceWorkspaceId: workspaceId, sourcePath, destinationWorkspaceId: workspaceId, destinationPath: null }])
    || !isDeepStrictEqual(graph.requiredCoordinatorBindings, coordinatorBindings)
    || !isDeepStrictEqual(graph.snapshotProofs, [{ workspaceId, proof: originalSnapshot.snapshotProof }])
    || !isDeepStrictEqual(graph.documentEvidence, originalSnapshot.documents.map(inventory => ({ evidenceKey: evidenceKey(inventory.document), inventory }))
      .sort((a, b) => a.evidenceKey.localeCompare(b.evidenceKey)))) fail();
  const recipes = deleteLinkRecipesV3(originalSnapshot, source);
  const expectedIntents = recipes.map(recipe => {
    const owner = entityKey(originalSnapshot.namespace.find(entry => entry.documentId === recipe.source.documentId)!);
    return { virtualLinkKey: nativeLinkJsonProof({ entityKey: owner, linkId: recipe.linkId }), entityKey: owner,
      originEvidenceLinkId: recipe.linkId, action: 'unlink',
      expectedValue: String(recipe.reference.kind === 'link-mark' ? recipe.reference.expected.href : recipe.reference.expected),
      nextValue: null, expectedTargetEntityKey: targetEntityKey, targetEntityKeyAfter: null, adapterCheck: 'native-forward-and-targeted-inverse' };
  }).sort((a, b) => a.virtualLinkKey.localeCompare(b.virtualLinkKey));
  if (!isDeepStrictEqual(step.linkIntents, expectedIntents)) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  const survivors = originalSnapshot.namespace.filter(entry => entry.path !== sourcePath).sort((a, b) => entityKey(a).localeCompare(entityKey(b)));
  if (graph.finalNamespace.length !== survivors.length) fail();
  for (const [index, entry] of survivors.entries()) {
    const actual = graph.finalNamespace[index], inventory = originalSnapshot.documents.find(item => item.document.path === entry.path);
    const physical = originalSnapshot.physicalSources.find(item => item.path === entry.path);
    if (!exactKeys(actual, ['entityKey', 'workspaceId', 'path', 'kind', 'binding', 'contentBasisProof', 'metadata',
      ...(physical ? ['physicalReadSource'] : [])])
      || actual.entityKey !== entityKey(entry) || actual.workspaceId !== workspaceId || actual.path !== entry.path || actual.kind !== entry.kind
      || !isDeepStrictEqual(actual.binding, { kind: 'existing', namespaceEvidence: entry, documentEvidenceKey: inventory ? evidenceKey(inventory.document) : null })) fail();
    if (physical) {
      if (actual.contentBasisProof !== null || !isDeepStrictEqual(actual.physicalReadSource, { physicalSourceProof: physical.physicalSourceProof })
        || !isDeepStrictEqual(actual.metadata, physical.metadata)) fail();
    } else if (inventory ? !proofString(actual.contentBasisProof) || !finalMetadata(actual.metadata, inventory,
      recipes.some(recipe => recipe.source.documentId === inventory.document.documentId)) : actual.contentBasisProof !== null || actual.metadata !== null) fail();
  }
  const finalSnapshot: WorkspaceMixedReadLinkSnapshotV3 = { ...originalSnapshot, namespace: survivors,
    documents: originalSnapshot.documents.filter(inventory => inventory.document.path !== sourcePath).map(inventory => ({ ...inventory,
      metadata: graph.finalNamespace.find(entry => entry.path === inventory.document.path)!.metadata!,
      links: inventory.links.filter(link => !recipes.some(recipe => recipe.source.documentId === inventory.document.documentId && recipe.linkId === link.id)) })) };
  const finalEdges = buildWorkspaceMixedReadLinkGraphV3(finalSnapshot).edges.map(edge => {
    const owner = entityKey(survivors.find(entry => entry.path === edge.source.path)!);
    return { virtualLinkKey: nativeLinkJsonProof(edge.sourceKind === 'physical-read'
      ? { entityKey: owner, physicalLinkId: edge.id } : { entityKey: owner, linkId: edge.id }), sourceEntityKey: owner,
    originEvidenceLinkId: edge.id, literal: edge.literal, targetPathText: edge.targetPathText,
    resolution: { status: edge.resolution.status, targetEntityKey: edge.resolution.target ? entityKey(edge.resolution.target) : null,
      candidateEntityKeys: edge.resolution.candidates.map(entityKey).sort() },
    ...(edge.sourceKind === 'physical-read' ? { physicalReadSource: true as const } : {}) };
  }).sort((a, b) => a.virtualLinkKey.localeCompare(b.virtualLinkKey));
  if (!isDeepStrictEqual(graph.finalEdges, finalEdges) || !proofString(graph.finalGraphProof)
    || graph.finalGraphProof !== nativeLinkJsonProof({ namespace: graph.finalNamespace, edges: finalEdges })
    || step.afterGraphProof !== graph.finalGraphProof) fail();
}

function deleteCompatibilityV3(originalSnapshot: WorkspaceMixedReadLinkSnapshotV3): Pick<WorkspaceOperationNativeDeleteBatchPlanV3, 'coverage' | 'linkAssessment'> {
  const graph = buildWorkspaceMixedReadLinkGraphV3(originalSnapshot);
  return { coverage: { complete: true, omittedSources: [], unresolvedLinks: graph.edges.filter(edge => edge.resolution.status !== 'resolved')
    .map(edge => ({ sourcePath: edge.source.path, targetLiteral: edge.literal,
      status: edge.resolution.status as Exclude<typeof edge.resolution.status, 'resolved'> })) },
  linkAssessment: { version: 1, complete: true, warnings: [], blockers: [] } };
}

function compileDeleteV3(originalSnapshot: WorkspaceMixedReadLinkSnapshotV3, source: NativeNamespaceEntry,
  states: PersistedCollaborationState[]): NativeMixedReadBatchPlanV3 {
  const compiled = compileWorkspaceMixedReadBatchV3({ snapshots: [originalSnapshot], states,
    requests: [{ kind: 'delete', sourceWorkspaceId: originalSnapshot.workspaceId, destinationWorkspaceId: originalSnapshot.workspaceId,
      selections: [{ sourcePath: source.path }] }] });
  validateDeleteGraphV3(compiled, originalSnapshot, source);
  return compiled;
}

/** Explicit new factory only. Auto/Legacy/V2 creation keeps its historical
 * selection, exact shape, hash formulas and original graph validator. */
export function createWorkspaceOperationNativeDeleteBatchPlanV3(input: NativeDeletePlanInput): WorkspaceOperationNativeDeleteBatchPlanV3 {
  try {
    const selected = action(captureDeleteV3(deleteV3Field(input, 'actions')) as WorkspaceOperationBatchAction[]);
    const workspace = deleteV3Field(deleteV3Field(input, 'scope'), 'workspace') as WorkspaceOperationBatchScope['workspace'];
    if (types.isProxy(workspace)) fail();
    const observation = deleteV3Field(input, 'observation') as WorkspaceLinkSourceAuthorityObservation;
    const sourceEvidence = captureWorkspaceOperationNativeSourceEvidenceV3(captureWorkspaceOperationJobScope(workspace), observation);
    const originalSnapshot = workspaceOperationMixedSourceSnapshot(sourceEvidence);
    const source = originalSnapshot.namespace.find(entry => entry.path === selected.selections[0].sourcePath);
    const binding = sourceEvidence.nativeComponent.nativeBindings.find(item => item.expected.path === source?.path);
    if (!source || source.kind !== 'file' || !binding || source.documentId !== binding.expected.documentId) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
    const states = structuredClone(deleteV3Field(observation, 'privateNativeStates')) as PersistedCollaborationState[];
    const nativeGraphPlan = compileDeleteV3(originalSnapshot, source, states);
    const body = { version: 2 as const, kind: 'native-original-delete' as const, planIdentityVersion: 3 as const,
      workspaceId: originalSnapshot.workspaceId, readiness: 'ready' as const, actions: [selected], pathMappings: [],
      deletedPaths: [{ path: source.path, kind: 'file' as const, identity: source.filesystemIdentity ?? `native:${binding.expected.stateProof}` }],
      pathSteps: [{ reviewId: selected.reviewId, kind: 'delete' as const, sourcePath: source.path }], linkEdits: [], originalDocuments: [],
      deletedDocuments: [], previewContents: [], expectedPathState: [{ workspaceId: originalSnapshot.workspaceId, path: source.path,
        identity: source.filesystemIdentity, contentHash: null }], ...deleteCompatibilityV3(originalSnapshot),
      issues: [], sourceEvidence, nativeTarget: binding.expected, nativeGraphPlan };
    const planned = { ...body, planId: computeWorkspaceOperationNativeDeleteBatchPlanId(body) };
    const decoded = decodeWorkspaceOperationNativeDeleteBatchPlan({ ...planned,
      integrityProof: computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProof(planned) });
    if (decoded.planIdentityVersion !== 3) fail();
    return decoded;
  } catch (error) {
    if (error instanceof WorkspaceOperationNativeDeletePlanError || error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error;
    return fail();
  }
}

function replayDeleteCurrentV3(original: WorkspaceOperationNativeDeleteBatchPlanV3,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): WorkspaceOperationNativeSourceEvidenceV3 {
  const witness = captureWorkspaceOperationNativeSourceEvidenceV3(scopeSnapshot, observation);
  if (!isDeepStrictEqual(witness.workspaceScope, original.sourceEvidence.workspaceScope)
    || witness.semanticProof !== original.sourceEvidence.semanticProof) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_CHANGED');
  // Full original namespace, aliases and physical IDs remain compiler inputs.
  // The freshly captured witness separately proves actual catalogue, bytes,
  // identities and semantics, allowing only verified projection/registry clocks.
  const originalSnapshot = workspaceOperationMixedSourceSnapshot(original.sourceEvidence);
  const states = structuredClone(deleteV3Field(observation, 'privateNativeStates')) as PersistedCollaborationState[];
  const source = originalSnapshot.namespace.find(entry => entry.path === original.nativeTarget.path)!;
  const compiled = compileDeleteV3(originalSnapshot, source, states);
  if (!isDeepStrictEqual(compiled, original.nativeGraphPlan)) fail('NATIVE_DELETE_PLAN_CHANGED');
  return witness;
}

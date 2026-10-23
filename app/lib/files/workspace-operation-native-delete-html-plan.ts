import 'server-only';

import { isDeepStrictEqual, types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import { getNativeInspectionSchema } from '../collaboration/native-inspection-schema';
import type { NativeLinkMutationRecipe, NativeNamespaceEntry } from '../markdown/workspace-link-contract-v2';
import type { FilePlanV5 } from '../markdown/workspace-link-contract-v5';
import { nativeLinkJsonProof, type NativeDocumentLinkInventoryV4 } from '../markdown/workspace-native-link-inventory';
import { createWorkspaceMixedHtmlFileOperationPlanV5 } from '../markdown/workspace-native-file-operation-planner';
import { buildWorkspaceMixedHtmlLinkGraphV5 } from '../markdown/workspace-native-link-graph';
import { compileWorkspaceMixedHtmlBatchV5, type NativeMixedHtmlBatchPlanV5 } from '../markdown/workspace-native-mixed-batch-compiler';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationBatchAction, WorkspaceOperationBatchScope, WorkspaceOperationJobScope,
  WorkspaceOperationNativeDeleteBatchPlanV4 } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { WorkspaceOperationNativeSourceEvidenceError } from './workspace-operation-native-source-evidence';
import { captureWorkspaceOperationMixedSourceEvidenceV5, decodeWorkspaceOperationMixedSourceEvidenceV5,
  workspaceOperationMixedSourceSnapshotV5, type WorkspaceOperationMixedSourceEvidenceV5,
  type WorkspaceOperationMixedSourceSnapshotV5 } from './workspace-operation-mixed-source-evidence-v5';

// Separate additive profile. The historical Delete decoder is deliberately not
// imported at runtime: its dispatcher may call this module without a cycle.
type Code = 'NATIVE_DELETE_PLAN_INVALID' | 'NATIVE_DELETE_PLAN_TOO_LARGE'
  | 'NATIVE_DELETE_PLAN_UNSUPPORTED' | 'NATIVE_DELETE_PLAN_CHANGED';
export class WorkspaceOperationNativeDeleteHtmlPlanError extends Error {
  readonly status = 409;
  constructor(readonly code: Code) { super(code); this.name = 'WorkspaceOperationNativeDeleteHtmlPlanError'; }
}
function fail(code: Code = 'NATIVE_DELETE_PLAN_INVALID'): never { throw new WorkspaceOperationNativeDeleteHtmlPlanError(code); }
function guarded<T>(operation: () => T): T {
  try { return operation(); } catch (error) {
    if (error instanceof WorkspaceOperationNativeDeleteHtmlPlanError || error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error;
    return fail();
  }
}
function capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => fail(reason === 'too-large'
    ? 'NATIVE_DELETE_PLAN_TOO_LARGE' : 'NATIVE_DELETE_PLAN_INVALID'), 16 * 1024 * 1024);
}
function field(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) fail();
  const property = Object.getOwnPropertyDescriptor(input, key);
  if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail();
  return property.value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const proofString = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function exactKeys(value: unknown, expected: readonly string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}
function action(input: readonly WorkspaceOperationBatchAction[]): WorkspaceOperationBatchAction {
  if (!Array.isArray(input) || input.length !== 1) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  const selected = input[0];
  if (!selected || selected.kind !== 'delete' || typeof selected.reviewId !== 'string' || !selected.reviewId || selected.reviewId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(selected.reviewId)
    || selected.ignoreMissing !== undefined && typeof selected.ignoreMissing !== 'boolean'
    || !Array.isArray(selected.selections) || selected.selections.length !== 1
    || !isCanonicalAdmissionPath(selected.selections[0].sourcePath) || !/\.(?:md|markdown)$/iu.test(selected.selections[0].sourcePath)
    || selected.selections[0].destinationPath !== undefined
    || Object.keys(selected).some(key => !['reviewId', 'kind', 'ignoreMissing', 'selections'].includes(key))
    || Object.keys(selected.selections[0]).some(key => key !== 'sourcePath')) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  return selected;
}
const keys = ['version', 'kind', 'workspaceId', 'planId', 'readiness', 'actions', 'pathMappings', 'deletedPaths', 'pathSteps',
  'linkEdits', 'originalDocuments', 'deletedDocuments', 'previewContents', 'expectedPathState', 'coverage', 'linkAssessment',
  'issues', 'sourceEvidence', 'nativeTarget', 'nativeGraphPlan', 'planIdentityVersion', 'integrityProof'];
const graphKeys = ['contractVersion', 'compilerVersion', 'planId', 'readiness', 'executionReady', 'requests', 'snapshotProofs',
  'documentEvidence', 'steps', 'cloneRequirements', 'finalNamespace', 'finalEdges', 'finalGraphProof', 'issues', 'requiredCoordinatorBindings',
  'htmlAssessment', 'htmlAssessmentProof', 'sourceCoverage'];
const coordinatorBindings: NativeMixedHtmlBatchPlanV5['requiredCoordinatorBindings'] = [
  'actor-session-request-review-and-current-authority', 'complete-current-namespace-and-native-graph',
  'kernel-lifecycle-fence-and-exact-registry-path-receipts', 'fresh-durable-native-states-and-targeted-inverse-receipts',
  'fresh-copy-identities-block-id-map-and-link-rebinding',
];
const entityKey = (entry: NativeNamespaceEntry) => nativeLinkJsonProof({ workspaceId: entry.workspaceId, identity: entry.identity });
const evidenceKey = (document: NativeDocumentLinkInventoryV4['document']) => nativeLinkJsonProof({ workspaceId: document.workspaceId,
  documentId: document.documentId, lifecycleGeneration: document.lifecycleGeneration });

function target(evidence: WorkspaceOperationMixedSourceEvidenceV5, selected: WorkspaceOperationBatchAction,
  snapshot: WorkspaceOperationMixedSourceSnapshotV5) {
  const source = snapshot.namespace.find(entry => entry.path === selected.selections[0].sourcePath);
  const binding = evidence.nativeComponent.nativeBindings.find(item => item.expected.path === source?.path);
  if (!source || source.kind !== 'file' || source.provider !== undefined || !binding || source.documentId !== binding.expected.documentId
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(binding.expected.representation)) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  return { snapshot, source, binding };
}
function pathPlan(evidence: WorkspaceOperationMixedSourceEvidenceV5, source: NativeNamespaceEntry,
  snapshot: WorkspaceOperationMixedSourceSnapshotV5): FilePlanV5 {
  const planned = createWorkspaceMixedHtmlFileOperationPlanV5({ kind: 'delete', sourceWorkspaceId: evidence.workspaceScope.workspaceId,
    destinationWorkspaceId: evidence.workspaceScope.workspaceId, selections: [{ sourcePath: source.path }], sourceEvidence: evidence });
  if (planned.readiness !== 'ready' || planned.issues.length || !planned.htmlAssessment.complete || planned.htmlAssessment.blockers.length
    || !isDeepStrictEqual(planned.pathMappings, [{ source, destinationPath: '', destinationWorkspaceId: snapshot.workspaceId }])
    || planned.mutations.some(recipe => recipe.action !== 'unlink' || recipe.nextValue !== null || recipe.cloneSelection !== null
      || recipe.source.workspaceId !== snapshot.workspaceId || recipe.destinationWorkspaceId !== snapshot.workspaceId
      || recipe.source.path === source.path || recipe.sourcePathAfter !== recipe.source.path || recipe.expectedTargetIdentity !== source.identity
      || !snapshot.documents.some(inventory => isDeepStrictEqual(inventory.document, recipe.source)
        && isDeepStrictEqual(inventory.version, recipe.sourceVersion) && inventory.links.some(link => link.id === recipe.linkId
          && isDeepStrictEqual(link.ref, recipe.reference))))) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  return planned;
}

function finalMetadata(value: unknown, inventory: NativeDocumentLinkInventoryV4, changed: boolean): boolean {
  if (!changed) return isDeepStrictEqual(value, inventory.metadata);
  if (!exactKeys(value, ['path', 'aliases', 'tags', 'title', 'hasExplicitTitle', 'headings', 'blockIds'])) return false;
  const metadata = value as NativeDocumentLinkInventoryV4['metadata'];
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

function validateGraph(graph: NativeMixedHtmlBatchPlanV5, originalSnapshot: WorkspaceOperationMixedSourceSnapshotV5,
  source: NativeNamespaceEntry, planned: FilePlanV5): void {
  if (!isDeepStrictEqual(graph.htmlAssessment, planned.htmlAssessment)
    || graph.htmlAssessmentProof !== planned.htmlAssessmentProof
    || !isDeepStrictEqual(graph.sourceCoverage, planned.sourceCoverage)) fail();
  if (!exactKeys(graph, graphKeys) || ['issues', 'cloneRequirements', 'steps', 'requests', 'snapshotProofs', 'documentEvidence',
    'finalNamespace', 'finalEdges', 'requiredCoordinatorBindings'].some(key => !Array.isArray(Reflect.get(graph, key)))) fail();
  const { planId, ...body } = graph;
  if (graph.contractVersion !== 5 || graph.compilerVersion !== 1 || graph.readiness !== 'ready' || graph.executionReady !== false
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
  const recipes = planned.mutations;
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
  const finalSnapshot: WorkspaceOperationMixedSourceSnapshotV5 = { ...originalSnapshot, namespace: survivors,
    documents: originalSnapshot.documents.filter(inventory => inventory.document.path !== sourcePath).map(inventory => ({ ...inventory,
      metadata: graph.finalNamespace.find(entry => entry.path === inventory.document.path)!.metadata!,
      links: inventory.links.filter(link => !recipes.some(recipe => recipe.source.documentId === inventory.document.documentId && recipe.linkId === link.id)) })) };
  const finalEdges = buildWorkspaceMixedHtmlLinkGraphV5(finalSnapshot).edges.map(edge => {
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


function compatibility(evidence: WorkspaceOperationMixedSourceEvidenceV5, planned: FilePlanV5,
  snapshot: WorkspaceOperationMixedSourceSnapshotV5) {
  const graph = buildWorkspaceMixedHtmlLinkGraphV5(snapshot);
  return { coverage: { complete: evidence.coverage.complete, omittedSources: [],
    unresolvedLinks: graph.edges.filter(edge => edge.resolution.status !== 'resolved').map(edge => ({ sourcePath: edge.source.path,
      targetLiteral: edge.literal, status: edge.resolution.status as Exclude<typeof edge.resolution.status, 'resolved'> })) },
  linkAssessment: structuredClone(planned.htmlAssessment) };
}

/** The new semantic identity binds E5 semantics, exact scope and the operation's
 * separate HTML assessment. Original gaps are never upgraded to complete.
 * Hashing facts grants no current authority and does not replace full decode. */
function nativeDeleteHtmlPlanIdFromCapturedData(value: WorkspaceOperationNativeDeleteBatchPlanV4): string {
  return nativeLinkJsonProof({ version: value.version, kind: value.kind, planIdentityVersion: 4,
    workspaceId: value.workspaceId, readiness: value.readiness, actions: value.actions,
    workspaceScope: value.sourceEvidence.workspaceScope, sourceSemanticProof: value.sourceEvidence.semanticProof,
    htmlAssessmentProof: nativeLinkJsonProof(value.linkAssessment) });
}
function nativeDeleteHtmlPlanIntegrityFromCapturedData(value: WorkspaceOperationNativeDeleteBatchPlanV4): string {
  const { integrityProof: _historical, ...body } = value;
  return nativeLinkJsonProof({ integrityVersion: 4, plan: body });
}
export function computeWorkspaceOperationNativeDeleteBatchPlanIdV4(plan: unknown): string {
  return guarded(() => {
    const value = capture(plan) as WorkspaceOperationNativeDeleteBatchPlanV4;
    const expected = keys.filter(key => !['planId', 'integrityProof'].includes(key)
      || Object.hasOwn(value, key));
    if (!exactKeys(value, expected) || value.version !== 2 || value.kind !== 'native-original-delete'
      || value.planIdentityVersion !== 4 || value.readiness !== 'ready') fail();
    return nativeDeleteHtmlPlanIdFromCapturedData(value);
  });
}
export function computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProofV4(plan: unknown): string {
  return guarded(() => {
    const value = capture(plan) as WorkspaceOperationNativeDeleteBatchPlanV4;
    const expected = keys.filter(key => key !== 'integrityProof' || Object.hasOwn(value, key));
    if (!exactKeys(value, expected) || value.version !== 2 || value.kind !== 'native-original-delete'
      || value.planIdentityVersion !== 4 || value.readiness !== 'ready' || !proofString(value.planId)) fail();
    return nativeDeleteHtmlPlanIntegrityFromCapturedData(value);
  });
}

type NativeDeleteHtmlHistoricalDetails = Readonly<{
  snapshot: WorkspaceOperationMixedSourceSnapshotV5;
  source: NativeNamespaceEntry;
  planned: FilePlanV5;
  usedRichLinkAttributeKeys: readonly string[];
}>;
const historicalDetails = new WeakMap<object, NativeDeleteHtmlHistoricalDetails>();

/** Eligibility is checked only AFTER the unchanged complete strict capture.
 * Cache keys are exact immutable input references, never identities or hashes. */
function isRecursivelyFrozenPlanData(input: unknown): input is object {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return true;
    if (types.isProxy(value) || Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)
      || !Object.isFrozen(value)) return false;
    if (seen.has(value)) return true;
    seen.add(value);
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor =>
      Object.hasOwn(descriptor, 'value') && visit(descriptor.value));
  };
  return !!input && typeof input === 'object' && visit(input);
}

function usedRichLinkAttributeKeys(plan: WorkspaceOperationNativeDeleteBatchPlanV4): readonly string[] {
  const keys = new Set<string>();
  const inventories = [
    ...plan.sourceEvidence.nativeComponent.stage.sources.map(source => source.inventory),
    ...plan.sourceEvidence.nativeOrdinarySources4.map(source => source.inventory),
  ];
  for (const inventory of inventories) for (const link of inventory.links) {
    if (link.ref.kind === 'link-mark') for (const key of Object.keys(link.ref.expected)) keys.add(key);
  }
  return [...keys].sort();
}

/** Historical Rich inventory decoding also checks the current inspection
 * grammar's lifetime and accepted attribute names. Keep that dependency fresh.
 * A miss/error continues through the original strict decoder and error mapping. */
function historicalRichLinkAttributesCurrent(details: NativeDeleteHtmlHistoricalDetails): boolean {
  if (!details.usedRichLinkAttributeKeys.length) return true;
  try {
    const current = Object.keys(getNativeInspectionSchema().marks.link.spec.attrs ?? {});
    return details.usedRichLinkAttributeKeys.every(key => current.includes(key));
  } catch { return false; }
}

/** A successful immutable original may share only derived historical facts.
 * Capture/budgets and detached plan outputs repeat on every invocation; current
 * observations, bytes, compilation and all execution authority stay fresh. */
function decodeNativeDeleteHtmlPlanDetails(input: unknown) {
  return guarded(() => {
    const value = capture(input) as WorkspaceOperationNativeDeleteBatchPlanV4;
    const cacheable = !!input && typeof input === 'object'
      && (historicalDetails.has(input) || isRecursivelyFrozenPlanData(input));
    const cached = cacheable ? historicalDetails.get(input) : undefined;
    if (cached && historicalRichLinkAttributesCurrent(cached)) {
      const plan = freeze(value);
      historicalDetails.set(plan, cached);
      return { plan, snapshot: cached.snapshot, source: cached.source, planned: cached.planned };
    }
    if (!exactKeys(value, keys) || value.version !== 2 || value.kind !== 'native-original-delete'
      || value.planIdentityVersion !== 4 || value.readiness !== 'ready' || !proofString(value.planId)
      || !proofString(value.integrityProof) || nativeDeleteHtmlPlanIntegrityFromCapturedData(value) !== value.integrityProof) fail();
    const evidence = decodeWorkspaceOperationMixedSourceEvidenceV5(value.sourceEvidence);
    const scope = parseWorkspaceOperationJobScope(evidence.workspaceScope), selected = action(value.actions);
    if (scope.legacy || value.workspaceId !== scope.workspaceId) fail();
    const snapshot = workspaceOperationMixedSourceSnapshotV5(evidence);
    const { source, binding } = target(evidence, selected, snapshot);
    if (!isDeepStrictEqual(value.nativeTarget, binding.expected)) fail();
    for (const key of ['pathMappings', 'linkEdits', 'originalDocuments', 'deletedDocuments', 'previewContents', 'issues'] as const) {
      if (!Array.isArray(value[key]) || value[key]!.length) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
    }
    if (!isDeepStrictEqual(value.pathSteps, [{ reviewId: selected.reviewId, kind: 'delete', sourcePath: source.path }])
      || !isDeepStrictEqual(value.deletedPaths, [{ path: source.path, kind: 'file', identity: source.filesystemIdentity ?? `native:${binding.expected.stateProof}` }])
      || !isDeepStrictEqual(value.expectedPathState, [{ workspaceId: value.workspaceId, path: source.path,
        identity: source.filesystemIdentity, contentHash: null }])) fail();
    const planned = pathPlan(evidence, source, snapshot);
    validateGraph(value.nativeGraphPlan, snapshot, source, planned);
    const diagnostics = compatibility(evidence, planned, snapshot);
    if (!isDeepStrictEqual(value.coverage, diagnostics.coverage) || !isDeepStrictEqual(value.linkAssessment, diagnostics.linkAssessment)
      || nativeDeleteHtmlPlanIdFromCapturedData(value) !== value.planId) fail();
    const plan = freeze(value);
    const details = freeze({ snapshot, source, planned, usedRichLinkAttributeKeys: usedRichLinkAttributeKeys(value) });
    if (cacheable) historicalDetails.set(input, details);
    historicalDetails.set(plan, details);
    return { plan, snapshot, source, planned };
  });
}

export function decodeWorkspaceOperationNativeDeleteBatchPlanV4(input: unknown): WorkspaceOperationNativeDeleteBatchPlanV4 {
  return decodeNativeDeleteHtmlPlanDetails(input).plan;
}

function compile(evidence: WorkspaceOperationMixedSourceEvidenceV5,
  states: PersistedCollaborationState[], snapshot: WorkspaceOperationMixedSourceSnapshotV5,
  source: NativeNamespaceEntry, planned: FilePlanV5): NativeMixedHtmlBatchPlanV5 {
  const compiled = compileWorkspaceMixedHtmlBatchV5({ sourceEvidence: evidence, states,
    requests: [{ kind: 'delete', sourceWorkspaceId: snapshot.workspaceId, destinationWorkspaceId: snapshot.workspaceId,
      selections: [{ sourcePath: source.path }] }] });
  validateGraph(compiled, snapshot, source, planned);
  return compiled;
}
export function createWorkspaceOperationNativeDeleteBatchPlanV4(input: { scope: WorkspaceOperationBatchScope;
  actions: readonly WorkspaceOperationBatchAction[]; observation: WorkspaceLinkSourceAuthorityObservation }): WorkspaceOperationNativeDeleteBatchPlanV4 {
  return guarded(() => {
    const selected = action(capture(field(input, 'actions')) as WorkspaceOperationBatchAction[]);
    const workspace = field(field(input, 'scope'), 'workspace') as WorkspaceOperationBatchScope['workspace'];
    if (types.isProxy(workspace)) fail();
    const observation = field(input, 'observation') as WorkspaceLinkSourceAuthorityObservation;
    const sourceEvidence = captureWorkspaceOperationMixedSourceEvidenceV5(captureWorkspaceOperationJobScope(workspace), observation);
    const snapshot = workspaceOperationMixedSourceSnapshotV5(sourceEvidence);
    const { source, binding } = target(sourceEvidence, selected, snapshot), planned = pathPlan(sourceEvidence, source, snapshot);
    const states = structuredClone(field(observation, 'privateNativeStates')) as PersistedCollaborationState[];
    const nativeGraphPlan = compile(sourceEvidence, states, snapshot, source, planned);
    const body = { version: 2 as const, kind: 'native-original-delete' as const, planIdentityVersion: 4 as const,
      workspaceId: snapshot.workspaceId, readiness: 'ready' as const, actions: [selected], pathMappings: [],
      deletedPaths: [{ path: source.path, kind: 'file' as const, identity: source.filesystemIdentity ?? `native:${binding.expected.stateProof}` }],
      pathSteps: [{ reviewId: selected.reviewId, kind: 'delete' as const, sourcePath: source.path }], linkEdits: [], originalDocuments: [],
      deletedDocuments: [], previewContents: [], expectedPathState: [{ workspaceId: snapshot.workspaceId, path: source.path,
        identity: source.filesystemIdentity, contentHash: null }], ...compatibility(sourceEvidence, planned, snapshot),
      issues: [], sourceEvidence, nativeTarget: binding.expected, nativeGraphPlan };
    const withId = { ...body, planId: computeWorkspaceOperationNativeDeleteBatchPlanIdV4(body) };
    return decodeWorkspaceOperationNativeDeleteBatchPlanV4({ ...withId,
      integrityProof: computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProofV4(withId) });
  });
}

/** This returns current facts, never a claim, room owner or write capability.
 * Current scope/catalogue/bytes/HTML semantics must equal the saved original.
 * Rehearsal then uses the ORIGINAL E5 snapshot and actual newly proven bytes. */
export function captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitnessV4(plan: WorkspaceOperationNativeDeleteBatchPlanV4,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): WorkspaceOperationMixedSourceEvidenceV5 {
  return guarded(() => {
    const { plan: original, snapshot, source, planned } = decodeNativeDeleteHtmlPlanDetails(plan);
    const witness = captureWorkspaceOperationMixedSourceEvidenceV5(scopeSnapshot, observation);
    if (!isDeepStrictEqual(witness.workspaceScope, original.sourceEvidence.workspaceScope)
      || witness.semanticProof !== original.sourceEvidence.semanticProof) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_CHANGED');
    const states = structuredClone(field(observation, 'privateNativeStates')) as PersistedCollaborationState[];
    const compiled = compile(original.sourceEvidence, states, snapshot, source, planned);
    if (!isDeepStrictEqual(compiled, original.nativeGraphPlan)) fail('NATIVE_DELETE_PLAN_CHANGED');
    return witness;
  });
}
export function assertWorkspaceOperationNativeDeleteBatchPlanCurrentV4(plan: WorkspaceOperationNativeDeleteBatchPlanV4,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): void {
  captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitnessV4(plan, observation, scopeSnapshot);
}
/** Recipes are actual native4 original-source unlink facts. Current fences and
 * actual durable deltas remain mandatory at the execution boundary. */
export function getWorkspaceOperationNativeDeleteLinkRecipesV4(plan: WorkspaceOperationNativeDeleteBatchPlanV4): NativeLinkMutationRecipe[] {
  const { planned } = decodeNativeDeleteHtmlPlanDetails(plan);
  return structuredClone(planned.mutations);
}

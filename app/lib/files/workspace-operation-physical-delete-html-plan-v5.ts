import { getNativeInspectionSchema } from '../collaboration/native-inspection-schema';
import 'server-only';

import { isDeepStrictEqual, types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import type { NativeLinkMutationRecipe, NativeNamespaceEntry } from '../markdown/workspace-link-contract-v2';
import type { FilePlanV5 } from '../markdown/workspace-link-contract-v5';
import { nativeLinkJsonProof, type NativeDocumentLinkInventoryV4 } from '../markdown/workspace-native-link-inventory';
import { createWorkspaceMixedHtmlFileOperationPlanV5 } from '../markdown/workspace-native-file-operation-planner';
import { buildWorkspaceMixedHtmlLinkGraphV5 } from '../markdown/workspace-native-link-graph';
import { compileWorkspaceMixedHtmlBatchV5, type NativeMixedHtmlBatchPlanV5 } from '../markdown/workspace-native-mixed-batch-compiler';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationBatchAction, WorkspaceOperationBatchScope, WorkspaceOperationJobScope,
  WorkspaceOperationLegacyBatchPlan } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { isNativeSourceFilesystemFingerprint, WorkspaceOperationNativeSourceEvidenceError } from './workspace-operation-native-source-evidence';
import { captureWorkspaceOperationMixedSourceEvidenceV5, decodeWorkspaceOperationMixedSourceEvidenceV5,
  workspaceOperationMixedSourceSnapshotV5, type WorkspaceOperationMixedSourceEvidenceV5,
  type WorkspaceOperationMixedSourceSnapshotV5 } from './workspace-operation-mixed-source-evidence-v5';

/** The target is a real E5 filesystem entry, never a native archive identity.
 * Pristine registry/catalogue rows may exist at this path; only an initialized
 * native target or a raw Markdown/HTML read source is outside this profile. */
export type WorkspaceOperationPhysicalDeleteBatchPlanV5 = Omit<WorkspaceOperationLegacyBatchPlan, 'version' | 'linkPlan'> & {
  version: 5;
  kind: 'physical-original-delete';
  planIdentityVersion: 5;
  targetAuthority: 'filesystem';
  physicalTarget: NativeNamespaceEntry & { kind: 'file'; filesystemIdentity: string;
    documentId: null; lifecycleGeneration: null; provider?: never };
  nativeTarget?: never;
  linkPlan?: never;
  integrityProof: string;
  sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5;
  nativeGraphPlan: NativeMixedHtmlBatchPlanV5;
};

// Additive physical-target arm. Historical native Delete contracts, E5 facts,
// compiler5 and HTML assessment are consumed unchanged, never relabelled.
type Code = 'PHYSICAL_DELETE_PLAN_INVALID' | 'PHYSICAL_DELETE_PLAN_TOO_LARGE'
  | 'PHYSICAL_DELETE_PLAN_UNSUPPORTED' | 'PHYSICAL_DELETE_PLAN_CHANGED';
export class WorkspaceOperationPhysicalDeleteHtmlPlanError extends Error {
  readonly status = 409;
  constructor(readonly code: Code) { super(code); this.name = 'WorkspaceOperationPhysicalDeleteHtmlPlanError'; }
}
function failPhysicalDelete(code: Code = 'PHYSICAL_DELETE_PLAN_INVALID'): never { throw new WorkspaceOperationPhysicalDeleteHtmlPlanError(code); }
function guardedPhysicalDelete<T>(operation: () => T): T {
  try { return operation(); } catch (error) {
    if (error instanceof WorkspaceOperationPhysicalDeleteHtmlPlanError || error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error;
    return failPhysicalDelete();
  }
}
function capturePhysicalDeleteData(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => failPhysicalDelete(reason === 'too-large'
    ? 'PHYSICAL_DELETE_PLAN_TOO_LARGE' : 'PHYSICAL_DELETE_PLAN_INVALID'), 16 * 1024 * 1024);
}
function physicalDeleteOwnField(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) failPhysicalDelete();
  const property = Object.getOwnPropertyDescriptor(input, key);
  if (!property?.enumerable || !Object.hasOwn(property, 'value')) failPhysicalDelete();
  return property.value;
}
function freezePhysicalDeleteData<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezePhysicalDeleteData(child); Object.freeze(value); }
  return value;
}
const physicalDeleteProofString = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function physicalDeleteExactKeys(value: unknown, expected: readonly string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}
function physicalDeleteAction(input: readonly WorkspaceOperationBatchAction[]): WorkspaceOperationBatchAction {
  if (!Array.isArray(input) || input.length !== 1) failPhysicalDelete('PHYSICAL_DELETE_PLAN_UNSUPPORTED');
  const selected = input[0];
  if (!selected || !physicalDeleteExactKeys(selected, ['reviewId', 'kind', 'selections'])
    || selected.kind !== 'delete' || typeof selected.reviewId !== 'string' || !selected.reviewId || selected.reviewId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(selected.reviewId)
    || !Array.isArray(selected.selections) || selected.selections.length !== 1
    || !physicalDeleteExactKeys(selected.selections[0], ['sourcePath'])
    || !isCanonicalAdmissionPath(selected.selections[0].sourcePath)) failPhysicalDelete('PHYSICAL_DELETE_PLAN_UNSUPPORTED');
  return selected;
}
const keys = ['version', 'kind', 'workspaceId', 'planId', 'readiness', 'actions', 'pathMappings', 'deletedPaths', 'pathSteps',
  'linkEdits', 'originalDocuments', 'deletedDocuments', 'previewContents', 'expectedPathState', 'coverage', 'linkAssessment',
  'issues', 'sourceEvidence', 'targetAuthority', 'physicalTarget', 'nativeGraphPlan', 'planIdentityVersion', 'integrityProof'];
const graphKeys = ['contractVersion', 'compilerVersion', 'planId', 'readiness', 'executionReady', 'requests', 'snapshotProofs',
  'documentEvidence', 'steps', 'cloneRequirements', 'finalNamespace', 'finalEdges', 'finalGraphProof', 'issues', 'requiredCoordinatorBindings',
  'htmlAssessment', 'htmlAssessmentProof', 'sourceCoverage'];
const coordinatorBindings: NativeMixedHtmlBatchPlanV5['requiredCoordinatorBindings'] = [
  'actor-session-request-review-and-current-authority', 'complete-current-namespace-and-native-graph',
  'kernel-lifecycle-fence-and-exact-registry-path-receipts', 'fresh-durable-native-states-and-targeted-inverse-receipts',
  'fresh-copy-identities-block-id-map-and-link-rebinding',
];
const physicalDeleteEntityKey = (entry: NativeNamespaceEntry) => nativeLinkJsonProof({ workspaceId: entry.workspaceId, identity: entry.identity });
const physicalDeleteEvidenceKey = (document: NativeDocumentLinkInventoryV4['document']) => nativeLinkJsonProof({ workspaceId: document.workspaceId,
  documentId: document.documentId, lifecycleGeneration: document.lifecycleGeneration });

function physicalDeleteTarget(evidence: WorkspaceOperationMixedSourceEvidenceV5, selected: WorkspaceOperationBatchAction) {
  const snapshot = workspaceOperationMixedSourceSnapshotV5(evidence);
  const source = snapshot.namespace.find(entry => entry.path === selected.selections[0].sourcePath);
  if (!source || source.kind !== 'file' || source.provider !== undefined || source.documentId !== null
    || source.lifecycleGeneration !== null || !isNativeSourceFilesystemFingerprint(source.filesystemIdentity)
    || source.identity !== source.filesystemIdentity
    || /\.(?:md|markdown|mdx|html?|excalidraw)$/iu.test(source.path)
    || [...evidence.physicalSources4, ...evidence.physicalHtmlSources4].some(item => item.path === source.path)
    || evidence.nativeComponent.nativeBindings.some(item => item.expected.path === source.path)
    || snapshot.documents.some(item => item.document.path === source.path)
    || snapshot.namespace.some(entry => entry.path.startsWith(`${source.path}/`))) failPhysicalDelete('PHYSICAL_DELETE_PLAN_UNSUPPORTED');
  return { snapshot, source: source as WorkspaceOperationPhysicalDeleteBatchPlanV5['physicalTarget'] };
}
function physicalDeletePathPlan(evidence: WorkspaceOperationMixedSourceEvidenceV5, source: NativeNamespaceEntry): FilePlanV5 {
  const planned = createWorkspaceMixedHtmlFileOperationPlanV5({ kind: 'delete', sourceWorkspaceId: evidence.workspaceScope.workspaceId,
    destinationWorkspaceId: evidence.workspaceScope.workspaceId, selections: [{ sourcePath: source.path }], sourceEvidence: evidence });
  const snapshot = workspaceOperationMixedSourceSnapshotV5(evidence);
  if (planned.readiness !== 'ready' || planned.issues.length || !planned.htmlAssessment.complete || planned.htmlAssessment.blockers.length
    || !isDeepStrictEqual(planned.pathMappings, [{ source, destinationPath: '', destinationWorkspaceId: snapshot.workspaceId }])
    || planned.mutations.some(recipe => recipe.action !== 'unlink' || recipe.nextValue !== null || recipe.cloneSelection !== null
      || recipe.source.workspaceId !== snapshot.workspaceId || recipe.destinationWorkspaceId !== snapshot.workspaceId
      || recipe.source.path === source.path || recipe.sourcePathAfter !== recipe.source.path || recipe.expectedTargetIdentity !== source.identity
      || !snapshot.documents.some(inventory => isDeepStrictEqual(inventory.document, recipe.source)
        && isDeepStrictEqual(inventory.version, recipe.sourceVersion) && inventory.links.some(link => link.id === recipe.linkId
          && isDeepStrictEqual(link.ref, recipe.reference))))) failPhysicalDelete('PHYSICAL_DELETE_PLAN_UNSUPPORTED');
  return planned;
}

function physicalDeleteFinalMetadata(value: unknown, inventory: NativeDocumentLinkInventoryV4, changed: boolean): boolean {
  if (!changed) return isDeepStrictEqual(value, inventory.metadata);
  if (!physicalDeleteExactKeys(value, ['path', 'aliases', 'tags', 'title', 'hasExplicitTitle', 'headings', 'blockIds'])) return false;
  const metadata = value as NativeDocumentLinkInventoryV4['metadata'];
  if (metadata.path !== inventory.document.path || typeof metadata.title !== 'string' || typeof metadata.hasExplicitTitle !== 'boolean'
    || ![metadata.aliases, metadata.tags, metadata.blockIds].every(items => Array.isArray(items) && items.every(item => typeof item === 'string'))
    || !Array.isArray(metadata.headings) || metadata.headings.some(heading => !physicalDeleteExactKeys(heading, ['depth', 'text'])
      || !Number.isSafeInteger(heading.depth) || heading.depth < 1 || heading.depth > 6 || typeof heading.text !== 'string')) return false;
  // Rich unlink adapters edit the body only. Heading text/title can change when
  // an embedded image disappears; frontmatter and block-ID metadata cannot.
  return inventory.document.representation === 'plain_text' || ['aliases', 'tags', 'hasExplicitTitle', 'blockIds'].every(key =>
    isDeepStrictEqual(Reflect.get(metadata, key), Reflect.get(inventory.metadata, key)))
    && (!metadata.hasExplicitTitle || metadata.title === inventory.metadata.title);
}

function physicalDeleteVirtualEdges(snapshot: WorkspaceOperationMixedSourceSnapshotV5): NativeMixedHtmlBatchPlanV5['finalEdges'] {
  return buildWorkspaceMixedHtmlLinkGraphV5(snapshot).edges.map(edge => {
    const owner = physicalDeleteEntityKey(snapshot.namespace.find(entry => entry.path === edge.source.path)!);
    return { virtualLinkKey: nativeLinkJsonProof(edge.sourceKind === 'physical-read'
      ? { entityKey: owner, physicalLinkId: edge.id } : { entityKey: owner, linkId: edge.id }), sourceEntityKey: owner,
    originEvidenceLinkId: edge.id, literal: edge.literal, targetPathText: edge.targetPathText,
    resolution: { status: edge.resolution.status, targetEntityKey: edge.resolution.target ? physicalDeleteEntityKey(edge.resolution.target) : null,
      candidateEntityKeys: edge.resolution.candidates.map(physicalDeleteEntityKey).sort() },
    ...(edge.sourceKind === 'physical-read' ? { physicalReadSource: true as const } : {}) };
  }).sort((a, b) => a.virtualLinkKey.localeCompare(b.virtualLinkKey));
}

function validatePhysicalDeleteGraph(graph: NativeMixedHtmlBatchPlanV5, originalSnapshot: WorkspaceOperationMixedSourceSnapshotV5,
  source: NativeNamespaceEntry, planned: FilePlanV5): void {
  if (!isDeepStrictEqual(graph.htmlAssessment, planned.htmlAssessment)
    || graph.htmlAssessmentProof !== planned.htmlAssessmentProof
    || !isDeepStrictEqual(graph.sourceCoverage, planned.sourceCoverage)) failPhysicalDelete();
  if (!physicalDeleteExactKeys(graph, graphKeys) || ['issues', 'cloneRequirements', 'steps', 'requests', 'snapshotProofs', 'documentEvidence',
    'finalNamespace', 'finalEdges', 'requiredCoordinatorBindings'].some(key => !Array.isArray(Reflect.get(graph, key)))) failPhysicalDelete();
  const { planId, ...body } = graph;
  if (graph.contractVersion !== 5 || graph.compilerVersion !== 1 || graph.readiness !== 'ready' || graph.executionReady !== false
    || graph.issues.length || graph.cloneRequirements.length || graph.steps.length !== 1 || graph.requests.length !== 1
    || nativeLinkJsonProof(body) !== planId) failPhysicalDelete('PHYSICAL_DELETE_PLAN_UNSUPPORTED');
  const workspaceId = originalSnapshot.workspaceId, sourcePath = source.path, targetEntityKey = physicalDeleteEntityKey(source);
  const request = { kind: 'delete' as const, sourceWorkspaceId: workspaceId, destinationWorkspaceId: workspaceId, selections: [{ sourcePath }] };
  const step = graph.steps[0];
  if (!physicalDeleteExactKeys(step, ['requestIndex', 'request', 'beforeGraphProof', 'afterGraphProof', 'namespaceEffects', 'linkIntents'])
    || step.requestIndex !== 0 || !Array.isArray(step.linkIntents) || !physicalDeleteProofString(step.beforeGraphProof)
    || !isDeepStrictEqual(graph.requests, [request]) || !isDeepStrictEqual(step.request, request)
    || !isDeepStrictEqual(step.namespaceEffects, [{ entityKey: targetEntityKey, sourceEntityKey: targetEntityKey,
      sourceWorkspaceId: workspaceId, sourcePath, destinationWorkspaceId: workspaceId, destinationPath: null }])
    || !isDeepStrictEqual(graph.requiredCoordinatorBindings, coordinatorBindings)
    || !isDeepStrictEqual(graph.snapshotProofs, [{ workspaceId, proof: originalSnapshot.snapshotProof }])
    || !isDeepStrictEqual(graph.documentEvidence, originalSnapshot.documents.map(inventory => ({ evidenceKey: physicalDeleteEvidenceKey(inventory.document), inventory }))
      .sort((a, b) => a.evidenceKey.localeCompare(b.evidenceKey)))) failPhysicalDelete();
  const recipes = planned.mutations;
  const expectedIntents = recipes.map(recipe => {
    const owner = physicalDeleteEntityKey(originalSnapshot.namespace.find(entry => entry.documentId === recipe.source.documentId)!);
    return { virtualLinkKey: nativeLinkJsonProof({ entityKey: owner, linkId: recipe.linkId }), entityKey: owner,
      originEvidenceLinkId: recipe.linkId, action: 'unlink',
      expectedValue: String(recipe.reference.kind === 'link-mark' ? recipe.reference.expected.href : recipe.reference.expected),
      nextValue: null, expectedTargetEntityKey: targetEntityKey, targetEntityKeyAfter: null, adapterCheck: 'native-forward-and-targeted-inverse' };
  }).sort((a, b) => a.virtualLinkKey.localeCompare(b.virtualLinkKey));
  if (!isDeepStrictEqual(step.linkIntents, expectedIntents)) failPhysicalDelete('PHYSICAL_DELETE_PLAN_UNSUPPORTED');
  const survivors = originalSnapshot.namespace.filter(entry => entry.path !== sourcePath).sort((a, b) => physicalDeleteEntityKey(a).localeCompare(physicalDeleteEntityKey(b)));
  if (graph.finalNamespace.length !== survivors.length) failPhysicalDelete();
  for (const [index, entry] of survivors.entries()) {
    const actual = graph.finalNamespace[index], inventory = originalSnapshot.documents.find(item => item.document.path === entry.path);
    const physical = originalSnapshot.physicalSources.find(item => item.path === entry.path);
    if (!physicalDeleteExactKeys(actual, ['entityKey', 'workspaceId', 'path', 'kind', 'binding', 'contentBasisProof', 'metadata',
      ...(physical ? ['physicalReadSource'] : [])])
      || actual.entityKey !== physicalDeleteEntityKey(entry) || actual.workspaceId !== workspaceId || actual.path !== entry.path || actual.kind !== entry.kind
      || !isDeepStrictEqual(actual.binding, { kind: 'existing', namespaceEvidence: entry, documentEvidenceKey: inventory ? physicalDeleteEvidenceKey(inventory.document) : null })) failPhysicalDelete();
    if (physical) {
      if (actual.contentBasisProof !== null || !isDeepStrictEqual(actual.physicalReadSource, { physicalSourceProof: physical.physicalSourceProof })
        || !isDeepStrictEqual(actual.metadata, physical.metadata)) failPhysicalDelete();
    } else if (inventory ? !physicalDeleteProofString(actual.contentBasisProof) || !physicalDeleteFinalMetadata(actual.metadata, inventory,
      recipes.some(recipe => recipe.source.documentId === inventory.document.documentId)) : actual.contentBasisProof !== null || actual.metadata !== null) failPhysicalDelete();
  }
  const finalSnapshot: WorkspaceOperationMixedSourceSnapshotV5 = { ...originalSnapshot, namespace: survivors,
    documents: originalSnapshot.documents.filter(inventory => inventory.document.path !== sourcePath).map(inventory => ({ ...inventory,
      metadata: graph.finalNamespace.find(entry => entry.path === inventory.document.path)!.metadata!,
      links: inventory.links.filter(link => !recipes.some(recipe => recipe.source.documentId === inventory.document.documentId && recipe.linkId === link.id)) })) };
  const finalEdges = physicalDeleteVirtualEdges(finalSnapshot);
  const originalEdges = physicalDeleteVirtualEdges(originalSnapshot);
  const unlinked = new Set(expectedIntents.map(intent => intent.virtualLinkKey));
  const unchangedEdges = originalEdges.filter(edge => !unlinked.has(edge.virtualLinkKey));
  // The compiler accepts only exact unlink plus unchanged resolution for every
  // surviving edge. Rehashing a forged after-namespace cannot relax this rule.
  if (finalEdges.length !== unchangedEdges.length || unchangedEdges.some(edge => {
    const actual = finalEdges.find(candidate => candidate.virtualLinkKey === edge.virtualLinkKey);
    return !actual || !isDeepStrictEqual(actual, edge);
  })) failPhysicalDelete();
  if (!recipes.length) {
    // No native body was changed. The before graph is then reconstructible from
    // the unchanged surviving entities and the actual physical target itself.
    const initialNamespace = [...graph.finalNamespace, { entityKey: targetEntityKey, workspaceId, path: sourcePath, kind: source.kind,
      binding: { kind: 'existing' as const, namespaceEvidence: source, documentEvidenceKey: null },
      contentBasisProof: null, metadata: null }].sort((a, b) => a.entityKey.localeCompare(b.entityKey));
    if (step.beforeGraphProof !== nativeLinkJsonProof({ namespace: initialNamespace, edges: originalEdges })) failPhysicalDelete();
  }
  if (!isDeepStrictEqual(graph.finalEdges, finalEdges) || !physicalDeleteProofString(graph.finalGraphProof)
    || graph.finalGraphProof !== nativeLinkJsonProof({ namespace: graph.finalNamespace, edges: finalEdges })
    || step.afterGraphProof !== graph.finalGraphProof) failPhysicalDelete();
}

function physicalDeleteCompatibility(evidence: WorkspaceOperationMixedSourceEvidenceV5, planned: FilePlanV5) {
  const graph = buildWorkspaceMixedHtmlLinkGraphV5(workspaceOperationMixedSourceSnapshotV5(evidence));
  return { coverage: { complete: evidence.coverage.complete, omittedSources: [],
    unresolvedLinks: graph.edges.filter(edge => edge.resolution.status !== 'resolved').map(edge => ({ sourcePath: edge.source.path,
      targetLiteral: edge.literal, status: edge.resolution.status as Exclude<typeof edge.resolution.status, 'resolved'> })) },
  linkAssessment: structuredClone(planned.htmlAssessment) };
}

/** The new semantic identity binds E5 semantics, exact scope and the operation's
 * separate HTML assessment. Original gaps are never upgraded to complete.
 * Hashing facts grants no current authority and does not replace full decode. */
export function computeWorkspaceOperationPhysicalDeleteBatchPlanIdV5(plan: unknown): string {
  return guardedPhysicalDelete(() => {
    const value = capturePhysicalDeleteData(plan) as WorkspaceOperationPhysicalDeleteBatchPlanV5;
    const expected = keys.filter(key => !['planId', 'integrityProof'].includes(key)
      || Object.hasOwn(value, key));
    if (!physicalDeleteExactKeys(value, expected) || value.version !== 5 || value.kind !== 'physical-original-delete'
      || value.planIdentityVersion !== 5 || value.targetAuthority !== 'filesystem' || value.readiness !== 'ready') failPhysicalDelete();
    return nativeLinkJsonProof({ version: value.version, kind: value.kind, planIdentityVersion: 5,
      targetAuthority: value.targetAuthority, physicalTarget: value.physicalTarget,
      workspaceId: value.workspaceId, readiness: value.readiness, actions: value.actions,
      workspaceScope: value.sourceEvidence.workspaceScope, sourceSemanticProof: value.sourceEvidence.semanticProof,
      htmlAssessmentProof: nativeLinkJsonProof(value.linkAssessment) });
  });
}
export function computeWorkspaceOperationPhysicalDeleteBatchPlanIntegrityProofV5(plan: unknown): string {
  return guardedPhysicalDelete(() => {
    const value = capturePhysicalDeleteData(plan) as WorkspaceOperationPhysicalDeleteBatchPlanV5;
    const expected = keys.filter(key => key !== 'integrityProof' || Object.hasOwn(value, key));
    if (!physicalDeleteExactKeys(value, expected) || value.version !== 5 || value.kind !== 'physical-original-delete'
      || value.planIdentityVersion !== 5 || value.targetAuthority !== 'filesystem' || value.readiness !== 'ready' || !physicalDeleteProofString(value.planId)) failPhysicalDelete();
    const { integrityProof: _historical, ...body } = value;
    return nativeLinkJsonProof({ integrityVersion: 5, plan: body });
  });
}

type PhysicalDeleteHistoricalDetails = Readonly<{
  snapshot: WorkspaceOperationMixedSourceSnapshotV5;
  source: NativeNamespaceEntry;
  planned: FilePlanV5;
  usedRichLinkAttributeKeys: readonly string[];
}>;
const physicalDeleteHistoricalDetails = new WeakMap<object, PhysicalDeleteHistoricalDetails>();

/** Eligibility is checked only AFTER the unchanged complete strict capture.
 * Cache keys are exact immutable input references, never identities or hashes. */
function isRecursivelyFrozenPhysicalDeletePlanData(input: unknown): input is object {
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

function physicalDeleteUsedRichLinkAttributeKeys(plan: WorkspaceOperationPhysicalDeleteBatchPlanV5): readonly string[] {
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
function physicalDeleteHistoricalRichLinkAttributesCurrent(details: PhysicalDeleteHistoricalDetails): boolean {
  if (!details.usedRichLinkAttributeKeys.length) return true;
  try {
    const current = Object.keys(getNativeInspectionSchema().marks.link.spec.attrs ?? {});
    return details.usedRichLinkAttributeKeys.every(key => current.includes(key));
  } catch { return false; }
}

/** A successful immutable original may share only derived historical facts.
 * Capture/budgets and detached plan outputs repeat on every invocation; current
 * observations, bytes, compilation and all execution authority stay fresh. */
function decodePhysicalDeletePlanDetails(input: unknown) {
  return guardedPhysicalDelete(() => {
    const value = capturePhysicalDeleteData(input) as WorkspaceOperationPhysicalDeleteBatchPlanV5;
    const cacheable = !!input && typeof input === 'object'
      && (physicalDeleteHistoricalDetails.has(input) || isRecursivelyFrozenPhysicalDeletePlanData(input));
    const cached = cacheable ? physicalDeleteHistoricalDetails.get(input) : undefined;
    if (cached && physicalDeleteHistoricalRichLinkAttributesCurrent(cached)) {
      const plan = freezePhysicalDeleteData(value);
      physicalDeleteHistoricalDetails.set(plan, cached);
      return { plan, snapshot: cached.snapshot, source: cached.source, planned: cached.planned };
    }
    if (!physicalDeleteExactKeys(value, keys) || value.version !== 5 || value.kind !== 'physical-original-delete'
      || value.planIdentityVersion !== 5 || value.targetAuthority !== 'filesystem' || value.readiness !== 'ready' || !physicalDeleteProofString(value.planId)
      || !physicalDeleteProofString(value.integrityProof) || computeWorkspaceOperationPhysicalDeleteBatchPlanIntegrityProofV5(value) !== value.integrityProof) failPhysicalDelete();
    const evidence = decodeWorkspaceOperationMixedSourceEvidenceV5(value.sourceEvidence);
    const scope = parseWorkspaceOperationJobScope(evidence.workspaceScope), selected = physicalDeleteAction(value.actions);
    if (scope.legacy || value.workspaceId !== scope.workspaceId) failPhysicalDelete();
    const { snapshot, source } = physicalDeleteTarget(evidence, selected);
    if (value.targetAuthority !== 'filesystem' || !isDeepStrictEqual(value.physicalTarget, source)) failPhysicalDelete();
    for (const key of ['pathMappings', 'linkEdits', 'originalDocuments', 'deletedDocuments', 'previewContents', 'issues'] as const) {
      if (!Array.isArray(value[key]) || value[key]!.length) failPhysicalDelete('PHYSICAL_DELETE_PLAN_UNSUPPORTED');
    }
    if (!isDeepStrictEqual(value.pathSteps, [{ reviewId: selected.reviewId, kind: 'delete', sourcePath: source.path }])
      || !isDeepStrictEqual(value.deletedPaths, [{ path: source.path, kind: 'file', identity: source.filesystemIdentity }])
      || !isDeepStrictEqual(value.expectedPathState, [{ workspaceId: value.workspaceId, path: source.path,
        identity: source.filesystemIdentity, contentHash: null }])) failPhysicalDelete();
    const planned = physicalDeletePathPlan(evidence, source);
    validatePhysicalDeleteGraph(value.nativeGraphPlan, snapshot, source, planned);
    const diagnostics = physicalDeleteCompatibility(evidence, planned);
    if (!isDeepStrictEqual(value.coverage, diagnostics.coverage) || !isDeepStrictEqual(value.linkAssessment, diagnostics.linkAssessment)
      || computeWorkspaceOperationPhysicalDeleteBatchPlanIdV5(value) !== value.planId) failPhysicalDelete();
    const plan = freezePhysicalDeleteData(value);
    const details = freezePhysicalDeleteData({ snapshot, source, planned,
      usedRichLinkAttributeKeys: physicalDeleteUsedRichLinkAttributeKeys(value) });
    if (cacheable) physicalDeleteHistoricalDetails.set(input, details);
    physicalDeleteHistoricalDetails.set(plan, details);
    return { plan, snapshot, source, planned };
  });
}

export function decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(input: unknown): WorkspaceOperationPhysicalDeleteBatchPlanV5 {
  return decodePhysicalDeletePlanDetails(input).plan;
}

function compilePhysicalDelete(evidence: WorkspaceOperationMixedSourceEvidenceV5, selected: WorkspaceOperationBatchAction,
  states: PersistedCollaborationState[]): NativeMixedHtmlBatchPlanV5 {
  const { snapshot, source } = physicalDeleteTarget(evidence, selected), planned = physicalDeletePathPlan(evidence, source);
  const compiled = compileWorkspaceMixedHtmlBatchV5({ sourceEvidence: evidence, states,
    requests: [{ kind: 'delete', sourceWorkspaceId: snapshot.workspaceId, destinationWorkspaceId: snapshot.workspaceId,
      selections: [{ sourcePath: source.path }] }] });
  validatePhysicalDeleteGraph(compiled, snapshot, source, planned);
  return compiled;
}
export function createWorkspaceOperationPhysicalDeleteBatchPlanV5(input: { scope: WorkspaceOperationBatchScope;
  actions: readonly WorkspaceOperationBatchAction[]; observation: WorkspaceLinkSourceAuthorityObservation }): WorkspaceOperationPhysicalDeleteBatchPlanV5 {
  return guardedPhysicalDelete(() => {
    const selected = physicalDeleteAction(capturePhysicalDeleteData(physicalDeleteOwnField(input, 'actions')) as WorkspaceOperationBatchAction[]);
    const workspace = physicalDeleteOwnField(physicalDeleteOwnField(input, 'scope'), 'workspace') as WorkspaceOperationBatchScope['workspace'];
    if (types.isProxy(workspace)) failPhysicalDelete();
    const observation = physicalDeleteOwnField(input, 'observation') as WorkspaceLinkSourceAuthorityObservation;
    const sourceEvidence = captureWorkspaceOperationMixedSourceEvidenceV5(captureWorkspaceOperationJobScope(workspace), observation);
    const { snapshot, source } = physicalDeleteTarget(sourceEvidence, selected), planned = physicalDeletePathPlan(sourceEvidence, source);
    const states = structuredClone(physicalDeleteOwnField(observation, 'privateNativeStates')) as PersistedCollaborationState[];
    const nativeGraphPlan = compilePhysicalDelete(sourceEvidence, selected, states);
    const body = { version: 5 as const, kind: 'physical-original-delete' as const, planIdentityVersion: 5 as const,
      workspaceId: snapshot.workspaceId, readiness: 'ready' as const, actions: [selected], pathMappings: [],
      deletedPaths: [{ path: source.path, kind: 'file' as const, identity: source.filesystemIdentity }],
      pathSteps: [{ reviewId: selected.reviewId, kind: 'delete' as const, sourcePath: source.path }], linkEdits: [], originalDocuments: [],
      deletedDocuments: [], previewContents: [], expectedPathState: [{ workspaceId: snapshot.workspaceId, path: source.path,
        identity: source.filesystemIdentity, contentHash: null }], ...physicalDeleteCompatibility(sourceEvidence, planned),
      issues: [], sourceEvidence, targetAuthority: 'filesystem' as const, physicalTarget: source, nativeGraphPlan };
    const withId = { ...body, planId: computeWorkspaceOperationPhysicalDeleteBatchPlanIdV5(body) };
    return decodeWorkspaceOperationPhysicalDeleteBatchPlanV5({ ...withId,
      integrityProof: computeWorkspaceOperationPhysicalDeleteBatchPlanIntegrityProofV5(withId) });
  });
}

/** SOURCE-PRESENT only. This returns current facts, never a claim, room owner or write capability.
 * Current scope/catalogue/bytes/HTML semantics must equal the saved original.
 * Rehearsal then uses the ORIGINAL E5 snapshot and actual newly proven bytes. */
export function captureWorkspaceOperationPhysicalDeleteCurrentWitnessV5(plan: WorkspaceOperationPhysicalDeleteBatchPlanV5,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): WorkspaceOperationMixedSourceEvidenceV5 {
  return guardedPhysicalDelete(() => {
    const original = decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(plan);
    const witness = captureWorkspaceOperationMixedSourceEvidenceV5(scopeSnapshot, observation);
    const current = physicalDeleteTarget(witness, original.actions[0]);
    if (!isDeepStrictEqual(current.source, original.physicalTarget)) failPhysicalDelete('PHYSICAL_DELETE_PLAN_CHANGED');
    if (!isDeepStrictEqual(witness.workspaceScope, original.sourceEvidence.workspaceScope)
      || witness.semanticProof !== original.sourceEvidence.semanticProof) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_CHANGED');
    const states = structuredClone(physicalDeleteOwnField(observation, 'privateNativeStates')) as PersistedCollaborationState[];
    const compiled = compilePhysicalDelete(original.sourceEvidence, original.actions[0], states);
    if (!isDeepStrictEqual(compiled, original.nativeGraphPlan)) failPhysicalDelete('PHYSICAL_DELETE_PLAN_CHANGED');
    return witness;
  });
}
export function assertWorkspaceOperationPhysicalDeleteCurrentV5(plan: WorkspaceOperationPhysicalDeleteBatchPlanV5,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): void {
  captureWorkspaceOperationPhysicalDeleteCurrentWitnessV5(plan, observation, scopeSnapshot);
}
/** Recipes are actual native4 original-source unlink facts. Current fences and
 * actual durable deltas remain mandatory at the execution boundary. The physical
 * target never receives an invented native document or lineage identity. */
export function getWorkspaceOperationPhysicalDeleteLinkRecipesV5(plan: WorkspaceOperationPhysicalDeleteBatchPlanV5): NativeLinkMutationRecipe[] {
  const { planned } = decodePhysicalDeletePlanDetails(plan);
  return structuredClone(planned.mutations);
}

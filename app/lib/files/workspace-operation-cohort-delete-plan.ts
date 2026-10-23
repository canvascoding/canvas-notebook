import 'server-only';

import { isDeepStrictEqual as equal, types } from 'node:util';
import { getNativeInspectionSchema } from '../collaboration/native-inspection-schema';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { NativeNamespaceEntry, NativeLinkMutationRecipe } from '../markdown/workspace-link-contract-v2';
import type { FilePlanV5 } from '../markdown/workspace-link-contract-v5';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { createWorkspaceMixedHtmlFileOperationPlanV5 } from '../markdown/workspace-native-file-operation-planner';
import { compileWorkspaceMixedHtmlBatchV5, type NativeMixedHtmlBatchPlanV5 } from '../markdown/workspace-native-mixed-batch-compiler';
import { buildWorkspaceMixedHtmlLinkGraphV5 } from '../markdown/workspace-native-link-graph';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationBatchAction, WorkspaceOperationBatchScope, WorkspaceOperationJobScope,
  WorkspaceOperationLegacyBatchPlan } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { captureWorkspaceOperationMixedSourceEvidenceV5, decodeWorkspaceOperationMixedSourceEvidenceV5,
  workspaceOperationMixedSourceSnapshotV5, type WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';

/** A bounded forward Delete cohort. These are original facts, never authority.
 * Existing singleton envelopes and compiler/source-evidence versions stay intact. */
export type WorkspaceOperationCohortDeletePlan = Omit<WorkspaceOperationLegacyBatchPlan, 'version' | 'linkPlan'> & {
  version: 6; kind: 'native-cohort-delete'; integrityProof: string;
  sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5;
  targets: NativeNamespaceEntry[];
  nativeGraphPlan: NativeMixedHtmlBatchPlanV5;
};
export class WorkspaceOperationCohortDeleteError extends Error {
  readonly status = 409;
  constructor(readonly code: 'COHORT_DELETE_INVALID' | 'COHORT_DELETE_UNSUPPORTED' | 'COHORT_DELETE_CHANGED'
    | 'COHORT_DELETE_TOO_LARGE' | 'COHORT_DELETE_UNPROVEN' | 'COHORT_DELETE_POSTCONDITION') {
    super(code); this.name = 'WorkspaceOperationCohortDeleteError';
  }
}
export function failCohortDelete(code: WorkspaceOperationCohortDeleteError['code'] = 'COHORT_DELETE_INVALID'): never {
  throw new WorkspaceOperationCohortDeleteError(code);
}
export const cohortWithin = (file: string, root: string) => file === root || file.startsWith(root + '/');
export function captureCohortDeleteData<T>(input: unknown, maximum = 16 * 1024 * 1024): T {
  return captureWorkspaceOperationNativePlanData(input, reason => failCohortDelete(reason === 'too-large'
    ? 'COHORT_DELETE_TOO_LARGE' : 'COHORT_DELETE_INVALID'), maximum) as T;
}
export function freezeCohortDelete<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeCohortDelete(child); Object.freeze(value); }
  return value;
}
function keys(value: unknown, expected: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !equal(Object.keys(value).sort(), [...expected].sort())) failCohortDelete();
}
function action(input: readonly WorkspaceOperationBatchAction[]): WorkspaceOperationBatchAction {
  const actions = captureCohortDeleteData<WorkspaceOperationBatchAction[]>(input);
  if (!Array.isArray(actions) || actions.length !== 1) failCohortDelete('COHORT_DELETE_UNSUPPORTED');
  const selected = actions[0];
  keys(selected, ['reviewId','kind','selections', ...(Object.hasOwn(selected, 'ignoreMissing') ? ['ignoreMissing'] : [])]);
  if (selected.kind !== 'delete' || typeof selected.reviewId !== 'string' || !selected.reviewId || selected.reviewId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(selected.reviewId) || selected.ignoreMissing !== undefined && selected.ignoreMissing !== false
    || !Array.isArray(selected.selections) || !selected.selections.length || selected.selections.length > 1000) failCohortDelete('COHORT_DELETE_UNSUPPORTED');
  for (const item of selected.selections) { keys(item, ['sourcePath']); if (!isCanonicalAdmissionPath(item.sourcePath)) failCohortDelete(); }
  for (let index = 0; index < selected.selections.length; index++) if (selected.selections.some((item, other) => other !== index
    && cohortWithin(item.sourcePath, selected.selections[index].sourcePath))) failCohortDelete('COHORT_DELETE_UNSUPPORTED');
  return selected;
}
export function cohortDeleteSelectionIssues(evidence: WorkspaceOperationMixedSourceEvidenceV5, selected: WorkspaceOperationBatchAction) {
  const deleted = (file: string) => selected.selections.some(root => cohortWithin(file, root.sourcePath));
  const issues: Array<{ code: string; workspaceId: string; path: string }> = [];
  const roots = selected.selections.map(root => evidence.namespace.find(entry => entry.path === root.sourcePath));
  for (const [index, root] of roots.entries()) if (!root) issues.push({ code: 'missing-source', workspaceId: evidence.workspaceScope.workspaceId,
    path: selected.selections[index].sourcePath });
  const targets = evidence.namespace.filter(entry => deleted(entry.path));
  // A single file keeps its established arm. Multiple ordinary assets and
  // recursive folders share this exact cohort; no native identity is invented.
  if (selected.selections.length===1 && !roots.some(entry => entry?.kind==='directory')) issues.push({
    code: 'unsupported-cohort-delete-selection', workspaceId: evidence.workspaceScope.workspaceId, path: selected.selections[0].sourcePath });
  if (targets.length > 10_000) failCohortDelete('COHORT_DELETE_TOO_LARGE');
  for (const target of targets) {
    const native = evidence.nativeComponent.nativeBindings.find(item => item.expected.path === target.path);
    if (target.kind === 'directory') continue;
    if (native ? native.expected.documentId !== target.documentId || native.expected.lifecycleGeneration !== target.lifecycleGeneration
      || !/\.(?:md|markdown)$/iu.test(target.path)
      : target.documentId !== null || target.lifecycleGeneration !== null || !target.filesystemIdentity || target.provider !== undefined
        || /\.(?:md|markdown|mdx|html?|excalidraw)$/iu.test(target.path)
        || [...evidence.physicalSources4, ...evidence.physicalHtmlSources4].some(source => source.path === target.path)) {
      issues.push({ code: 'unsupported-cohort-delete-source', workspaceId: evidence.workspaceScope.workspaceId, path: target.path });
    }
  }
  return { issues, targets, deleted };
}
export function cohortDeletePathPlan(evidence: WorkspaceOperationMixedSourceEvidenceV5,
  selected: WorkspaceOperationBatchAction): FilePlanV5 {
  return createWorkspaceMixedHtmlFileOperationPlanV5({ kind: 'delete', sourceWorkspaceId: evidence.workspaceScope.workspaceId,
    destinationWorkspaceId: evidence.workspaceScope.workspaceId, selections: selected.selections.map(item => ({ ...item })), sourceEvidence: evidence });
}
function graphFacts(evidence: WorkspaceOperationMixedSourceEvidenceV5, selected: WorkspaceOperationBatchAction) {
  const facts = cohortDeleteSelectionIssues(evidence, selected), planned = cohortDeletePathPlan(evidence, selected);
  if (facts.issues.length || planned.readiness !== 'ready' || planned.issues.length || !planned.htmlAssessment.complete
    || planned.htmlAssessment.blockers.length) failCohortDelete('COHORT_DELETE_UNSUPPORTED');
  const snapshot = workspaceOperationMixedSourceSnapshotV5(evidence);
  if (planned.pathMappings.length !== facts.targets.length || planned.pathMappings.some(mapping => !facts.targets.some(target => equal(target, mapping.source))
    || mapping.destinationWorkspaceId !== snapshot.workspaceId || mapping.destinationPath !== '')
    || planned.mutations.some(recipe => recipe.action !== 'unlink' || recipe.nextValue !== null || recipe.cloneSelection !== null
      || recipe.source.workspaceId !== snapshot.workspaceId || recipe.destinationWorkspaceId !== snapshot.workspaceId
      || facts.deleted(recipe.source.path) || recipe.sourcePathAfter !== recipe.source.path
      || !facts.targets.some(target => target.identity === recipe.expectedTargetIdentity)
      || !snapshot.documents.some(inventory => equal(inventory.document, recipe.source) && equal(inventory.version, recipe.sourceVersion)
        && inventory.links.some(link => link.id === recipe.linkId && equal(link.ref, recipe.reference))))) failCohortDelete('COHORT_DELETE_UNSUPPORTED');
  return { ...facts, planned, snapshot };
}
const bodyKeys = ['version','kind','workspaceId','readiness','actions','pathMappings','deletedPaths','pathSteps','linkEdits','originalDocuments',
  'deletedDocuments','previewContents','expectedPathState','coverage','linkAssessment','issues','sourceEvidence','targets','nativeGraphPlan'];
function semanticId(value: Omit<WorkspaceOperationCohortDeletePlan,'planId'|'integrityProof'>): string {
  return proof({ kind: value.kind, version: 6, workspaceId: value.workspaceId, actions: value.actions,
    sourceSemanticProof: value.sourceEvidence.semanticProof, workspaceScope: value.sourceEvidence.workspaceScope,
    targets: value.targets, htmlAssessmentProof: proof(value.linkAssessment) });
}
export function computeWorkspaceOperationCohortDeletePlanId(input: unknown): string {
  const value = captureCohortDeleteData<WorkspaceOperationCohortDeletePlan>(input);
  keys(value, [...bodyKeys, ...(Object.hasOwn(value,'planId') ? ['planId'] : []), ...(Object.hasOwn(value,'integrityProof') ? ['integrityProof'] : [])]);
  if (value.version !== 6 || value.kind !== 'native-cohort-delete') failCohortDelete();
  return semanticId(value);
}
type CohortDeleteHistoricalDetails = Readonly<{
  planned: FilePlanV5;
  usedRichLinkAttributeKeys: readonly string[];
}>;
const cohortDeleteHistoricalDetails = new WeakMap<object, CohortDeleteHistoricalDetails>();

/** Only genuine immutable own-data references can retain derived original facts.
 * The complete strict capture and byte budget still precede every lookup. */
function isRecursivelyFrozenCohortDeletePlanData(input: unknown): input is object {
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
function cohortDeleteUsedRichLinkAttributeKeys(plan: WorkspaceOperationCohortDeletePlan): readonly string[] {
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
function cohortDeleteHistoricalRichLinkAttributesCurrent(details: CohortDeleteHistoricalDetails): boolean {
  if (!details.usedRichLinkAttributeKeys.length) return true;
  try {
    const current = Object.keys(getNativeInspectionSchema().marks.link.spec.attrs ?? {});
    return details.usedRichLinkAttributeKeys.every(key => current.includes(key));
  } catch { return false; }
}

/** Historical data only, following the existing Physical5 decoder. Every result
 * remains detached/frozen; actual observations, compilation and authority repeat. */
function decodeCohortDeletePlanDetails(input: unknown) {
  const value = captureCohortDeleteData<WorkspaceOperationCohortDeletePlan>(input);
  const cacheable = !!input && typeof input === 'object'
    && (cohortDeleteHistoricalDetails.has(input) || isRecursivelyFrozenCohortDeletePlanData(input));
  const cached = cacheable ? cohortDeleteHistoricalDetails.get(input) : undefined;
  if (cached && cohortDeleteHistoricalRichLinkAttributesCurrent(cached)) {
    const plan = freezeCohortDelete(value);
    cohortDeleteHistoricalDetails.set(plan, cached);
    return { plan, planned: cached.planned };
  }
  keys(value, [...bodyKeys,'planId','integrityProof']);
  if (value.version !== 6 || value.kind !== 'native-cohort-delete' || value.readiness !== 'ready') failCohortDelete();
  const { integrityProof, ...withId } = value;
  if (integrityProof !== proof({ kind: 'native-cohort-delete-integrity', plan: withId })) failCohortDelete();
  const evidence = decodeWorkspaceOperationMixedSourceEvidenceV5(value.sourceEvidence), selected = action(value.actions);
  if (evidence.workspaceScope.legacy || value.workspaceId !== evidence.workspaceScope.workspaceId) failCohortDelete();
  const facts = graphFacts(evidence, selected), graph = value.nativeGraphPlan, request = { kind: 'delete',
    sourceWorkspaceId: value.workspaceId, destinationWorkspaceId: value.workspaceId, selections: selected.selections };
  if (!equal(value.targets, facts.targets) || graph.contractVersion !== 5 || graph.compilerVersion !== 1
    || graph.executionReady !== false || graph.readiness !== 'ready' || graph.issues.length || graph.cloneRequirements.length
    || graph.steps.length !== 1 || !equal(graph.requests,[request]) || !equal(graph.steps[0].request,request)
    || graph.planId !== proof(Object.fromEntries(Object.entries(graph).filter(([key]) => key !== 'planId')))
    || !equal(graph.htmlAssessment, facts.planned.htmlAssessment) || graph.htmlAssessmentProof !== facts.planned.htmlAssessmentProof
    || !equal(graph.sourceCoverage,facts.planned.sourceCoverage)) failCohortDelete();
  const actualIntents = graph.steps[0].linkIntents;
  if (actualIntents.length !== facts.planned.mutations.length || new Set(actualIntents.map(item => item.virtualLinkKey)).size !== actualIntents.length
    || actualIntents.some(intent => !facts.planned.mutations.some(recipe => intent.originEvidenceLinkId === recipe.linkId
      && intent.action === 'unlink' && intent.nextValue === null && intent.targetEntityKeyAfter === null
      && intent.entityKey === proof({workspaceId:value.workspaceId,identity:facts.snapshot.namespace.find(entry => entry.path === recipe.source.path)!.identity})
      && intent.expectedTargetEntityKey === proof({workspaceId:value.workspaceId,identity:recipe.expectedTargetIdentity})
      && intent.expectedValue === String(recipe.reference.kind === 'link-mark' ? recipe.reference.expected.href : recipe.reference.expected)))) failCohortDelete();
  if (graph.finalNamespace.some(entity => facts.deleted(entity.path)) || graph.finalNamespace.length !== facts.snapshot.namespace.length - facts.targets.length
    || new Set(graph.finalNamespace.map(entity => entity.path)).size !== graph.finalNamespace.length
    || graph.finalNamespace.some(entity => entity.binding.kind !== 'existing' || !facts.snapshot.namespace.some(entry => equal(entry,entity.binding.kind === 'existing' && entity.binding.namespaceEvidence)))
    || graph.finalGraphProof !== proof({namespace:graph.finalNamespace,edges:graph.finalEdges}) || graph.steps[0].afterGraphProof !== graph.finalGraphProof) failCohortDelete();
  for (const key of ['pathMappings','linkEdits','originalDocuments','deletedDocuments','previewContents','issues'] as const)
    if (!Array.isArray(value[key]) || value[key]!.length) failCohortDelete();
  if (!equal(value.pathSteps, selected.selections.map(selection => ({ reviewId:selected.reviewId,kind:'delete',sourcePath:selection.sourcePath })))
    || !equal(value.deletedPaths, facts.targets.map(target => ({path:target.path,kind:target.kind,identity:target.identity})))
    || !equal(value.expectedPathState,facts.targets.map(target => ({workspaceId:value.workspaceId,path:target.path,identity:target.filesystemIdentity,contentHash:null})))
    || !equal(value.coverage,{complete:evidence.coverage.complete,omittedSources:[],unresolvedLinks:buildWorkspaceMixedHtmlLinkGraphV5(facts.snapshot).edges.filter(edge=>edge.resolution.status!=='resolved').map(edge=>({sourcePath:edge.source.path,targetLiteral:edge.literal,status:edge.resolution.status}))})
    || !equal(value.linkAssessment,facts.planned.htmlAssessment) || value.planId !== semanticId(value)) failCohortDelete();
  const plan = freezeCohortDelete(value);
  const details = freezeCohortDelete({ planned: facts.planned,
    usedRichLinkAttributeKeys: cohortDeleteUsedRichLinkAttributeKeys(value) });
  if (cacheable) cohortDeleteHistoricalDetails.set(input, details);
  cohortDeleteHistoricalDetails.set(plan, details);
  return { plan, planned: details.planned };
}
export function decodeWorkspaceOperationCohortDeletePlan(input: unknown): WorkspaceOperationCohortDeletePlan {
  return decodeCohortDeletePlanDetails(input).plan;
}
export function createWorkspaceOperationCohortDeletePlan(input: {scope:WorkspaceOperationBatchScope;actions:readonly WorkspaceOperationBatchAction[];
  observation:WorkspaceLinkSourceAuthorityObservation}): WorkspaceOperationCohortDeletePlan {
  const selected=action(input.actions),sourceEvidence=captureWorkspaceOperationMixedSourceEvidenceV5(captureWorkspaceOperationJobScope(input.scope.workspace),input.observation);
  const facts=graphFacts(sourceEvidence,selected),nativeGraphPlan=compileWorkspaceMixedHtmlBatchV5({sourceEvidence,
    states:structuredClone(input.observation.privateNativeStates) as PersistedCollaborationState[],requests:[{kind:'delete',sourceWorkspaceId:sourceEvidence.workspaceScope.workspaceId,
      destinationWorkspaceId:sourceEvidence.workspaceScope.workspaceId,selections:selected.selections}]});
  const body={version:6 as const,kind:'native-cohort-delete' as const,workspaceId:sourceEvidence.workspaceScope.workspaceId,readiness:'ready' as const,
    actions:[selected],pathMappings:[],deletedPaths:facts.targets.map(target=>({path:target.path,kind:target.kind,identity:target.identity})),
    pathSteps:selected.selections.map(selection=>({reviewId:selected.reviewId,kind:'delete' as const,sourcePath:selection.sourcePath})),linkEdits:[],originalDocuments:[],deletedDocuments:[],previewContents:[],
    expectedPathState:facts.targets.map(target=>({workspaceId:sourceEvidence.workspaceScope.workspaceId,path:target.path,identity:target.filesystemIdentity,contentHash:null})),
    coverage:{complete:sourceEvidence.coverage.complete,omittedSources:[],unresolvedLinks:buildWorkspaceMixedHtmlLinkGraphV5(facts.snapshot).edges.filter(edge=>edge.resolution.status!=='resolved').map(edge=>({sourcePath:edge.source.path,targetLiteral:edge.literal,status:edge.resolution.status as 'missing'|'ambiguous'}))},
    linkAssessment:facts.planned.htmlAssessment,issues:[],sourceEvidence,targets:facts.targets,nativeGraphPlan};
  const withId={...body,planId:semanticId(body)};
  return decodeWorkspaceOperationCohortDeletePlan({...withId,integrityProof:proof({kind:'native-cohort-delete-integrity',plan:withId})});
}
export function captureWorkspaceOperationCohortDeleteCurrent(plan:WorkspaceOperationCohortDeletePlan,
  observation:WorkspaceLinkSourceAuthorityObservation,scope:WorkspaceOperationJobScope):WorkspaceOperationMixedSourceEvidenceV5 {
  const original=decodeWorkspaceOperationCohortDeletePlan(plan),witness=captureWorkspaceOperationMixedSourceEvidenceV5(scope,observation);
  if (!equal(scope,original.sourceEvidence.workspaceScope)||witness.semanticProof!==original.sourceEvidence.semanticProof) failCohortDelete('COHORT_DELETE_CHANGED');
  const compiled=compileWorkspaceMixedHtmlBatchV5({sourceEvidence:original.sourceEvidence,states:structuredClone(observation.privateNativeStates) as PersistedCollaborationState[],
    requests:[{kind:'delete',sourceWorkspaceId:plan.workspaceId,destinationWorkspaceId:plan.workspaceId,selections:plan.actions[0].selections}]});
  if (!equal(compiled,original.nativeGraphPlan)) failCohortDelete('COHORT_DELETE_CHANGED');
  return witness;
}
export function getWorkspaceOperationCohortDeleteRecipes(plan:WorkspaceOperationCohortDeletePlan):NativeLinkMutationRecipe[] {
  return structuredClone(decodeCohortDeletePlanDetails(plan).planned.mutations);
}

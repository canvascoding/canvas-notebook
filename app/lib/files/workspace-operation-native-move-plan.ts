import 'server-only';

import { isDeepStrictEqual, types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import type { NativeLinkMutationRecipe, NativeWorkspaceFileOperationPlan, NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
import type { FilePlanV3, WorkspaceMixedReadLinkSnapshotV3 } from '../markdown/workspace-link-contract-v3';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import { createWorkspaceMixedReadFileOperationPlanV3, createWorkspaceNativeFileOperationPlan } from '../markdown/workspace-native-file-operation-planner';
import { buildWorkspaceMixedReadLinkGraphV3, buildWorkspaceNativeLinkGraph } from '../markdown/workspace-native-link-graph';
import { compileWorkspaceMixedReadBatchV3, compileWorkspaceNativeMixedBatch, type NativeMixedReadBatchPlanV3,
  type NativeMixedBatchPlan, type NativeMixedBatchRequest } from '../markdown/workspace-native-mixed-batch-compiler';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationBatchAction, WorkspaceOperationBatchScope, WorkspaceOperationJobScope,
  WorkspaceOperationLegacyBatchPlan } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData, workspaceOperationNativePlanSnapshot } from './workspace-operation-native-plan-data';
import { assertWorkspaceOperationNativeSourceEvidenceCurrent, captureWorkspaceOperationNativeSourceEvidence,
  captureWorkspaceOperationNativeSourceEvidenceV2, decodeWorkspaceOperationNativeSourceEvidence,
  WorkspaceOperationNativeSourceEvidenceError, type WorkspaceOperationNativeSourceEvidence,
  type WorkspaceOperationNativeSourceEvidenceV2 } from './workspace-operation-native-source-evidence';
import { captureWorkspaceOperationNativeCatalogueWitness } from './workspace-operation-native-catalogue-witness';
import { captureWorkspaceOperationNativeSourceEvidenceV3, decodeWorkspaceOperationNativeSourceEvidenceV3,
  type WorkspaceOperationNativeSourceEvidenceV3 } from './workspace-operation-native-source-evidence-v3';
import { workspaceOperationMixedSourceSnapshot } from './workspace-operation-mixed-source-evidence';

type MoveAction = WorkspaceOperationBatchAction & { kind: 'move' | 'rename' };
type Compatibility = Pick<WorkspaceOperationLegacyBatchPlan, 'pathMappings' | 'deletedPaths' | 'pathSteps' | 'linkEdits'
  | 'expectedPathState' | 'coverage' | 'linkAssessment' | 'issues'>;
/** Private native planning data with strictly derived batch presentation fields.
 * Neither this envelope nor its hashes confer claim/room/SQL authority.
 * Compiler bodies/bytes are not duplicated in persisted JSON. Before execution
 * the current gate MUST reproduce both proofs using actual proven native bytes. */
type NativeMovePlanFields = Readonly<Compatibility & {
  version: 3;
  kind: 'native-path-change';
  workspaceId: string;
  planId: string;
  readiness: 'ready';
  executionReady: false;
  actions: [MoveAction];
  nativePathPlan: NativeWorkspaceFileOperationPlan;
  compilerPlanProof: string;
  finalGraphProof: string;
}>;
/** The historical outer-V3 arm also accepted EvidenceV2. Its raw identity and
 * exact persisted shape stay unchanged; evidenceVersion is not an ID switch. */
export type WorkspaceOperationNativeMoveBatchPlanV1 = NativeMovePlanFields & Readonly<{
  sourceEvidence: WorkspaceOperationNativeSourceEvidence;
  planIdentityVersion?: never;
  integrityProof?: never;
}>;
export type WorkspaceOperationNativeMoveBatchPlanV2 = NativeMovePlanFields & Readonly<{
  planIdentityVersion: 2;
  sourceEvidence: WorkspaceOperationNativeSourceEvidenceV2;
  integrityProof: string;
}>;
export type WorkspaceOperationNativeMoveBatchPlanV3 = Omit<NativeMovePlanFields, 'nativePathPlan'> & Readonly<{
  planIdentityVersion: 3;
  sourceEvidence: WorkspaceOperationNativeSourceEvidenceV3;
  nativePathPlan: FilePlanV3;
  integrityProof: string;
}>;
export type WorkspaceOperationNativeMoveBatchPlan = WorkspaceOperationNativeMoveBatchPlanV1 | WorkspaceOperationNativeMoveBatchPlanV2
  | WorkspaceOperationNativeMoveBatchPlanV3;
const keys = ['version', 'kind', 'workspaceId', 'planId', 'readiness', 'executionReady', 'actions',
  'sourceEvidence', 'nativePathPlan', 'compilerPlanProof', 'finalGraphProof', 'pathMappings', 'deletedPaths', 'pathSteps',
  'linkEdits', 'expectedPathState', 'coverage', 'linkAssessment', 'issues'];
type Code = 'NATIVE_MOVE_PLAN_INVALID' | 'NATIVE_MOVE_PLAN_TOO_LARGE' | 'NATIVE_MOVE_PLAN_UNSUPPORTED' | 'NATIVE_MOVE_PLAN_CHANGED';
export class WorkspaceOperationNativeMovePlanError extends Error {
  readonly status = 409;
  constructor(readonly code: Code) { super(code); this.name = 'WorkspaceOperationNativeMovePlanError'; }
}
function fail(code: Code = 'NATIVE_MOVE_PLAN_INVALID'): never { throw new WorkspaceOperationNativeMovePlanError(code); }
const proof = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => fail(reason === 'too-large'
    ? 'NATIVE_MOVE_PLAN_TOO_LARGE' : 'NATIVE_MOVE_PLAN_INVALID'));
}
function field(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) fail();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  return descriptor.value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function guarded<T>(callback: () => T): T {
  try { return callback(); } catch (error) {
    if (error instanceof WorkspaceOperationNativeMovePlanError) throw error;
    if (error instanceof WorkspaceOperationNativeSourceEvidenceError) {
      if (error.code === 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE') fail('NATIVE_MOVE_PLAN_TOO_LARGE');
      if (error.code === 'NATIVE_SOURCE_EVIDENCE_CHANGED') fail('NATIVE_MOVE_PLAN_CHANGED');
      if (error.code === 'NATIVE_SOURCE_IMPORT_REQUIRED') fail('NATIVE_MOVE_PLAN_UNSUPPORTED');
    }
    return fail();
  }
}
function observed(scope: WorkspaceOperationJobScope, observation: WorkspaceLinkSourceAuthorityObservation,
  evidenceVersion: 1 | 2, requireWitness = false): {
    evidence: WorkspaceOperationNativeSourceEvidence; observation: WorkspaceLinkSourceAuthorityObservation;
  } {
  if (!observation || typeof observation !== 'object' || types.isProxy(observation)) fail();
  const withCatalogue = evidenceVersion === 2 && Object.hasOwn(observation, 'privateCatalogue');
  const evidence = requireWitness || withCatalogue ? captureWorkspaceOperationNativeSourceEvidenceV2(scope, observation)
    : captureWorkspaceOperationNativeSourceEvidence(scope, observation);
  // Capture validates every private state descriptor before these bytes are
  // detached. The compiler must never reread caller-owned native state.
  const states = structuredClone(field(observation, 'privateNativeStates')) as PersistedCollaborationState[];
  const replay = { stage: evidence.stage, nativeBindings: evidence.nativeBindings, privateNativeStates: states };
  const detached: WorkspaceLinkSourceAuthorityObservation = requireWitness || withCatalogue ? { ...replay,
    privateCatalogue: captureWorkspaceOperationNativeCatalogueWitness(field(observation, 'privateCatalogue'), evidence.workspaceScope,
      evidence.stage.catalogueProof!, evidence.nativeBindings, reason => fail(reason === 'too-large'
        ? 'NATIVE_MOVE_PLAN_TOO_LARGE' : 'NATIVE_MOVE_PLAN_INVALID')).entries } : replay;
  captureWorkspaceOperationNativeSourceEvidence(scope, replay);
  return { evidence, observation: detached };
}
function action(input: unknown): MoveAction {
  if (!Array.isArray(input) || input.length !== 1) fail('NATIVE_MOVE_PLAN_UNSUPPORTED');
  const selected = input[0] as MoveAction;
  if (!selected || typeof selected !== 'object' || !['move', 'rename'].includes(selected.kind)
    || typeof selected.reviewId !== 'string' || !selected.reviewId || selected.reviewId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(selected.reviewId) || !Array.isArray(selected.selections)
    || !selected.selections.length || selected.selections.length > 1000
    || Object.keys(selected).length !== 3 || Object.keys(selected).some(key => !['reviewId', 'kind', 'selections'].includes(key))) {
    fail('NATIVE_MOVE_PLAN_UNSUPPORTED');
  }
  for (const selection of selected.selections) {
    if (!selection || typeof selection !== 'object' || Object.keys(selection).length !== 2
      || Object.keys(selection).some(key => !['sourcePath', 'destinationPath'].includes(key))
      || !isCanonicalAdmissionPath(selection.sourcePath) || !isCanonicalAdmissionPath(selection.destinationPath)
      || selection.sourcePath === selection.destinationPath) fail('NATIVE_MOVE_PLAN_UNSUPPORTED');
  }
  return selected;
}
function request(workspaceId: string, selected: MoveAction): NativeMixedBatchRequest {
  return { kind: selected.kind, sourceWorkspaceId: workspaceId, destinationWorkspaceId: workspaceId,
    selections: selected.selections.map(selection => ({ ...selection })) };
}
function pathPlan(snapshot: NativeWorkspaceLinkSnapshot, selected: MoveAction): NativeWorkspaceFileOperationPlan {
  const planned = createWorkspaceNativeFileOperationPlan({ ...request(snapshot.workspaceId, selected), snapshots: [snapshot] });
  if (planned.readiness !== 'ready' || planned.issues.length || !planned.pathMappings.length
    || planned.pathMappings.some(mapping => !isCanonicalAdmissionPath(mapping.destinationPath)
      || mapping.destinationPath.split('/').length > 33)
    || planned.mutations.some(recipe => recipe.action !== 'rewrite' || recipe.nextValue === null
      || recipe.cloneSelection !== null || recipe.source.workspaceId !== snapshot.workspaceId
      || recipe.destinationWorkspaceId !== snapshot.workspaceId)) fail('NATIVE_MOVE_PLAN_UNSUPPORTED');
  return planned;
}
function compile(snapshot: NativeWorkspaceLinkSnapshot, selected: MoveAction,
  observation: WorkspaceLinkSourceAuthorityObservation): NativeMixedBatchPlan {
  const compiled = compileWorkspaceNativeMixedBatch({ snapshots: [snapshot], states: observation.privateNativeStates,
    requests: [request(snapshot.workspaceId, selected)] });
  if (compiled.readiness !== 'ready' || compiled.executionReady !== false || compiled.issues.length
    || compiled.cloneRequirements.length || !proof(compiled.planId) || !proof(compiled.finalGraphProof)) {
    fail('NATIVE_MOVE_PLAN_UNSUPPORTED');
  }
  return compiled;
}
/** These fields support the existing job/presentation envelope. Native bytes,
 * original namespace and recipes remain in their native contracts; no legacy
 * Markdown spans or mutable projection bytes become execution evidence. */
function compatibility(snapshot: NativeWorkspaceLinkSnapshot, selected: MoveAction,
  nativePathPlan: NativeWorkspaceFileOperationPlan): Compatibility {
  const graph = buildWorkspaceNativeLinkGraph(snapshot);
  return {
    pathMappings: nativePathPlan.pathMappings.map(mapping => ({ sourceWorkspaceId: snapshot.workspaceId,
      sourcePath: mapping.source.path, destinationWorkspaceId: snapshot.workspaceId, destinationPath: mapping.destinationPath,
      sourceIdentity: mapping.source.identity, sourceKind: mapping.source.kind })),
    deletedPaths: [], pathSteps: selected.selections.map(selection => ({ reviewId: selected.reviewId, kind: selected.kind,
      sourcePath: selection.sourcePath, destinationPath: selection.destinationPath })),
    linkEdits: [], expectedPathState: [],
    coverage: { complete: true, omittedSources: [], unresolvedLinks: graph.edges.filter(edge => edge.resolution.status !== 'resolved')
      .map(edge => ({ sourcePath: edge.source.path, targetLiteral: edge.literal,
        status: edge.resolution.status as Exclude<typeof edge.resolution.status, 'resolved'> })) },
    linkAssessment: { version: 1, complete: true, warnings: [], blockers: [] }, issues: [],
  };
}
export function computeWorkspaceOperationNativeMoveBatchPlanId(plan: Omit<WorkspaceOperationNativeMoveBatchPlan, 'planId'>): string {
  const { planId: _historical, ...body } = capture(plan) as WorkspaceOperationNativeMoveBatchPlan;
  if (body.planIdentityVersion === 3) return nativeLinkJsonProof({ version: 3, planIdentityVersion: 3,
    kind: body.kind, workspaceId: body.workspaceId, readiness: body.readiness, executionReady: body.executionReady,
    actions: body.actions, workspaceScope: body.sourceEvidence.workspaceScope, sourceSemanticProof: body.sourceEvidence.semanticProof });
  if (body.planIdentityVersion === 2) return nativeLinkJsonProof({ version: 3, planIdentityVersion: 2,
    kind: body.kind, workspaceId: body.workspaceId, readiness: body.readiness, executionReady: body.executionReady,
    actions: body.actions, workspaceScope: body.sourceEvidence.workspaceScope, sourceSemanticProof: body.sourceEvidence.semanticProof });
  return nativeLinkJsonProof(body);
}
/** Separate historical integrity binds every raw field, including the semantic
 * public ID and compiler assertions. Neither proof grants execution authority. */
export function computeWorkspaceOperationNativeMoveBatchPlanIntegrityProof(
  plan: Omit<WorkspaceOperationNativeMoveBatchPlanV2, 'integrityProof'> | Omit<WorkspaceOperationNativeMoveBatchPlanV3, 'integrityProof'>): string {
  const { integrityProof: _historical, ...body } = capture(plan) as WorkspaceOperationNativeMoveBatchPlanV2 | WorkspaceOperationNativeMoveBatchPlanV3;
  if (body.planIdentityVersion === 3) return nativeLinkJsonProof({ integrityVersion: 3, plan: body });
  return nativeLinkJsonProof({ integrityVersion: 2, plan: body });
}
/** Historical JSON integrity only. Path mappings and all recipes are rederived
 * independently. Opaque compiler hashes are syntax/integrity data until the
 * current-byte replay below; a forged hash can never authorize execution. */
export function decodeWorkspaceOperationNativeMoveBatchPlan(input: unknown): WorkspaceOperationNativeMoveBatchPlan {
  return guarded(() => {
    const value = capture(input) as WorkspaceOperationNativeMoveBatchPlan;
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    const expectedKeys = value.planIdentityVersion === 2 || value.planIdentityVersion === 3 ? [...keys, 'planIdentityVersion', 'integrityProof'] : keys;
    if (Object.keys(value).length !== expectedKeys.length
      || Object.keys(value).some(key => !expectedKeys.includes(key)) || value.version !== 3 || value.kind !== 'native-path-change'
      || value.readiness !== 'ready' || value.executionReady !== false || !proof(value.compilerPlanProof)
      || !proof(value.finalGraphProof) || !proof(value.planId)) fail();
    if ((value.planIdentityVersion === 2 || value.planIdentityVersion === 3) && (!proof(value.integrityProof)
      || computeWorkspaceOperationNativeMoveBatchPlanIntegrityProof(value) !== value.integrityProof)) fail();
    if (value.planIdentityVersion === 3) {
      const sourceEvidence = decodeWorkspaceOperationNativeSourceEvidenceV3(value.sourceEvidence);
      const scope = parseWorkspaceOperationJobScope(sourceEvidence.workspaceScope), selected = action(value.actions);
      if (scope.legacy || value.workspaceId !== scope.workspaceId) fail();
      const snapshot = workspaceOperationMixedSourceSnapshot(sourceEvidence), nativePathPlan = pathPlanV3(snapshot, selected);
      if (!isDeepStrictEqual(value.nativePathPlan, nativePathPlan)) fail();
      for (const [name, expected] of Object.entries(compatibilityV3(snapshot, selected, nativePathPlan))) {
        if (!isDeepStrictEqual(Reflect.get(value, name), expected)) fail();
      }
      if (computeWorkspaceOperationNativeMoveBatchPlanId(value) !== value.planId) fail();
      return freeze(value);
    }
    const sourceEvidence = decodeWorkspaceOperationNativeSourceEvidence(value.sourceEvidence);
    if (value.planIdentityVersion === 2 && sourceEvidence.evidenceVersion !== 2) fail();
    const scope = parseWorkspaceOperationJobScope(sourceEvidence.workspaceScope), selected = action(value.actions);
    if (scope.legacy || value.workspaceId !== scope.workspaceId || value.workspaceId !== sourceEvidence.stage.workspaceId) fail();
    const snapshot = workspaceOperationNativePlanSnapshot(sourceEvidence, () => fail('NATIVE_MOVE_PLAN_UNSUPPORTED'));
    const nativePathPlan = pathPlan(snapshot, selected);
    if (!isDeepStrictEqual(value.nativePathPlan, nativePathPlan)) fail();
    for (const [name, expected] of Object.entries(compatibility(snapshot, selected, nativePathPlan))) {
      if (!isDeepStrictEqual(Reflect.get(value, name), expected)) fail();
    }
    if (computeWorkspaceOperationNativeMoveBatchPlanId(value) !== value.planId) fail();
    return freeze(value);
  });
}
type NativeMovePlanInput = {
  scope: WorkspaceOperationBatchScope; actions: WorkspaceOperationBatchAction[]; observation: WorkspaceLinkSourceAuthorityObservation;
};
function createPlan(input: NativeMovePlanInput, identityVersion: 1 | 2): WorkspaceOperationNativeMoveBatchPlanV1 | WorkspaceOperationNativeMoveBatchPlanV2 {
  return guarded(() => {
    const selected = action(capture(field(input, 'actions')));
    const workspace = field(field(input, 'scope'), 'workspace') as WorkspaceOperationBatchScope['workspace'];
    const observation = field(input, 'observation') as WorkspaceLinkSourceAuthorityObservation;
    if (types.isProxy(workspace)) fail();
    const current = observed(captureWorkspaceOperationJobScope(workspace), observation, identityVersion, identityVersion === 2);
    const sourceEvidence = current.evidence;
    const snapshot = workspaceOperationNativePlanSnapshot(sourceEvidence, () => fail('NATIVE_MOVE_PLAN_UNSUPPORTED'));
    const nativePathPlan = pathPlan(snapshot, selected), compiled = compile(snapshot, selected, current.observation);
    const body = { version: 3 as const, kind: 'native-path-change' as const,
      workspaceId: snapshot.workspaceId, readiness: 'ready', executionReady: false, actions: [selected],
      sourceEvidence, nativePathPlan, compilerPlanProof: compiled.planId, finalGraphProof: compiled.finalGraphProof!,
      ...compatibility(snapshot, selected, nativePathPlan), ...(identityVersion === 2 ? { planIdentityVersion: 2 as const } : {})
    } as Omit<WorkspaceOperationNativeMoveBatchPlan, 'planId'>;
    const planned = { ...body, planId: computeWorkspaceOperationNativeMoveBatchPlanId(body) };
    const decoded = decodeWorkspaceOperationNativeMoveBatchPlan(identityVersion === 1 ? planned : { ...planned,
      integrityProof: computeWorkspaceOperationNativeMoveBatchPlanIntegrityProof(planned as Omit<WorkspaceOperationNativeMoveBatchPlanV2, 'integrityProof'>) });
    if (decoded.planIdentityVersion === 3) fail();
    return decoded;
  });
}
/** An own catalogue field chooses V2, including malformed fields which must
 * fail the full witness contract instead of falling back to historical V1. */
export function createWorkspaceOperationNativeMoveBatchPlan(input: NativeMovePlanInput): WorkspaceOperationNativeMoveBatchPlanV1 | WorkspaceOperationNativeMoveBatchPlanV2 {
  return guarded(() => {
    const observation = field(input, 'observation');
    if (!observation || typeof observation !== 'object' || types.isProxy(observation)) fail();
    return createPlan(input, Object.hasOwn(observation, 'privateCatalogue') ? 2 : 1);
  });
}
export function createWorkspaceOperationNativeMoveBatchPlanV1(input: NativeMovePlanInput): WorkspaceOperationNativeMoveBatchPlanV1 {
  return createPlan(input, 1) as WorkspaceOperationNativeMoveBatchPlanV1;
}
export function createWorkspaceOperationNativeMoveBatchPlanV2(input: NativeMovePlanInput): WorkspaceOperationNativeMoveBatchPlanV2 {
  return createPlan(input, 2) as WorkspaceOperationNativeMoveBatchPlanV2;
}
function replayCurrent(original: WorkspaceOperationNativeMoveBatchPlanV1 | WorkspaceOperationNativeMoveBatchPlanV2, observation: WorkspaceLinkSourceAuthorityObservation,
  scope: WorkspaceOperationJobScope): NativeMixedBatchPlan {
  assertWorkspaceOperationNativeSourceEvidenceCurrent(original.sourceEvidence, observation, scope);
  const snapshot = workspaceOperationNativePlanSnapshot(original.sourceEvidence, () => fail('NATIVE_MOVE_PLAN_UNSUPPORTED'));
  const compiled = compile(snapshot, original.actions[0], observation);
  if (compiled.planId !== original.compilerPlanProof || compiled.finalGraphProof !== original.finalGraphProof) fail('NATIVE_MOVE_PLAN_CHANGED');
  return freeze(compiled);
}
/** Requires the caller's genuine current authority/fence. Replaceable native
 * projections and directory mtimes may differ. Replay the ORIGINAL namespace
 * with freshly proven bytes, so our own later path stage cannot rewrite what
 * the original request meant. Returned compiler data is still not authority. */
export function assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan: WorkspaceOperationNativeMoveBatchPlanV1 | WorkspaceOperationNativeMoveBatchPlanV2,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): NativeMixedBatchPlan;
export function assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan: WorkspaceOperationNativeMoveBatchPlanV3,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): NativeMixedReadBatchPlanV3;
export function assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan: WorkspaceOperationNativeMoveBatchPlan,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): NativeMixedBatchPlan | NativeMixedReadBatchPlanV3;
export function assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan: WorkspaceOperationNativeMoveBatchPlan,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): NativeMixedBatchPlan | NativeMixedReadBatchPlanV3 {
  return guarded(() => {
    const original = decodeWorkspaceOperationNativeMoveBatchPlan(plan);
    if (original.planIdentityVersion === 3) return replayCurrentV3(original, observedV3(scopeSnapshot, observation));
    const current = observed(scopeSnapshot, observation, original.sourceEvidence.evidenceVersion);
    return replayCurrent(original, current.observation, scopeSnapshot);
  });
}
/** Strict fresh B1 data for the caller's genuine owner/fence. Unlike historical
 * Current replay, this never accepts an absent catalogue witness. The frozen
 * evidence is data only, not a principal, lock, connection or mutation token. */
export function captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan: WorkspaceOperationNativeMoveBatchPlanV2,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): WorkspaceOperationNativeSourceEvidenceV2;
export function captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan: WorkspaceOperationNativeMoveBatchPlanV3,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): WorkspaceOperationNativeSourceEvidenceV3;
export function captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan: WorkspaceOperationNativeMoveBatchPlanV2 | WorkspaceOperationNativeMoveBatchPlanV3,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): WorkspaceOperationNativeSourceEvidenceV2 | WorkspaceOperationNativeSourceEvidenceV3;
export function captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan: WorkspaceOperationNativeMoveBatchPlanV2 | WorkspaceOperationNativeMoveBatchPlanV3,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): WorkspaceOperationNativeSourceEvidenceV2 | WorkspaceOperationNativeSourceEvidenceV3 {
  return guarded(() => {
    const original = decodeWorkspaceOperationNativeMoveBatchPlan(plan);
    if (original.planIdentityVersion === 3) {
      const current = observedV3(scopeSnapshot, observation);
      replayCurrentV3(original, current);
      return freeze(current.evidence);
    }
    if (original.planIdentityVersion !== 2) fail();
    const current = observed(scopeSnapshot, observation, 2, true);
    replayCurrent(original, current.observation, scopeSnapshot);
    if (current.evidence.evidenceVersion !== 2) fail();
    return freeze(current.evidence);
  });
}
/** Fresh recipes bound to original document IDs, generations and references;
 * not clone anchors, Markdown spans, prepared updates or mutation permission. */
export function getWorkspaceOperationNativeMoveLinkRecipes(plan: WorkspaceOperationNativeMoveBatchPlan): NativeLinkMutationRecipe[] {
  return structuredClone(decodeWorkspaceOperationNativeMoveBatchPlan(plan).nativePathPlan.mutations);
}

function observedV3(scope: WorkspaceOperationJobScope, observation: WorkspaceLinkSourceAuthorityObservation) {
  const evidence = captureWorkspaceOperationNativeSourceEvidenceV3(scope, observation);
  // V3 capture already validated every state descriptor, original physical byte
  // and the complete catalogue before this detach. Only actual native states
  // go into the pure compiler; physical inventories remain read evidence.
  const states = structuredClone(field(observation, 'privateNativeStates')) as PersistedCollaborationState[];
  return { evidence, states };
}

function pathPlanV3(snapshot: WorkspaceMixedReadLinkSnapshotV3, selected: MoveAction): FilePlanV3 {
  const planned = createWorkspaceMixedReadFileOperationPlanV3({ ...request(snapshot.workspaceId, selected), snapshots: [snapshot] });
  if (planned.readiness !== 'ready' || planned.issues.length || !planned.pathMappings.length
    || planned.pathMappings.some(mapping => !isCanonicalAdmissionPath(mapping.destinationPath)
      || mapping.destinationPath.split('/').length > 33)
    || planned.mutations.some(recipe => recipe.action !== 'rewrite' || recipe.nextValue === null
      || recipe.cloneSelection !== null || recipe.source.workspaceId !== snapshot.workspaceId
      || recipe.destinationWorkspaceId !== snapshot.workspaceId)) fail('NATIVE_MOVE_PLAN_UNSUPPORTED');
  return planned;
}

function compileV3(snapshot: WorkspaceMixedReadLinkSnapshotV3, selected: MoveAction,
  states: PersistedCollaborationState[]): NativeMixedReadBatchPlanV3 {
  const compiled = compileWorkspaceMixedReadBatchV3({ snapshots: [snapshot], states,
    requests: [request(snapshot.workspaceId, selected)] });
  if (compiled.readiness !== 'ready' || compiled.executionReady !== false || compiled.issues.length
    || compiled.cloneRequirements.length || !proof(compiled.planId) || !proof(compiled.finalGraphProof)) fail('NATIVE_MOVE_PLAN_UNSUPPORTED');
  return compiled;
}

function compatibilityV3(snapshot: WorkspaceMixedReadLinkSnapshotV3, selected: MoveAction, nativePathPlan: FilePlanV3): Compatibility {
  const graph = buildWorkspaceMixedReadLinkGraphV3(snapshot);
  return {
    pathMappings: nativePathPlan.pathMappings.map(mapping => ({ sourceWorkspaceId: snapshot.workspaceId,
      sourcePath: mapping.source.path, destinationWorkspaceId: snapshot.workspaceId, destinationPath: mapping.destinationPath,
      sourceIdentity: mapping.source.identity, sourceKind: mapping.source.kind })),
    deletedPaths: [], pathSteps: selected.selections.map(selection => ({ reviewId: selected.reviewId, kind: selected.kind,
      sourcePath: selection.sourcePath, destinationPath: selection.destinationPath })),
    linkEdits: [], expectedPathState: [],
    coverage: { complete: true, omittedSources: [], unresolvedLinks: graph.edges.filter(edge => edge.resolution.status !== 'resolved')
      .map(edge => ({ sourcePath: edge.source.path, targetLiteral: edge.literal,
        status: edge.resolution.status as Exclude<typeof edge.resolution.status, 'resolved'> })) },
    linkAssessment: { version: 1, complete: true, warnings: [], blockers: [] }, issues: [],
  };
}

function createPlanV3(input: NativeMovePlanInput): WorkspaceOperationNativeMoveBatchPlanV3 {
  return guarded(() => {
    const selected = action(capture(field(input, 'actions')));
    const workspace = field(field(input, 'scope'), 'workspace') as WorkspaceOperationBatchScope['workspace'];
    if (types.isProxy(workspace)) fail();
    const current = observedV3(captureWorkspaceOperationJobScope(workspace), field(input, 'observation') as WorkspaceLinkSourceAuthorityObservation);
    const sourceEvidence = current.evidence, snapshot = workspaceOperationMixedSourceSnapshot(sourceEvidence);
    const nativePathPlan = pathPlanV3(snapshot, selected), compiled = compileV3(snapshot, selected, current.states);
    const body = { version: 3 as const, kind: 'native-path-change' as const, planIdentityVersion: 3 as const,
      workspaceId: snapshot.workspaceId, readiness: 'ready' as const, executionReady: false as const, actions: [selected] as [MoveAction],
      sourceEvidence, nativePathPlan, compilerPlanProof: compiled.planId, finalGraphProof: compiled.finalGraphProof!,
      ...compatibilityV3(snapshot, selected, nativePathPlan), integrityProof: '0'.repeat(64) };
    const planned = { ...body, planId: computeWorkspaceOperationNativeMoveBatchPlanId(body) };
    const decoded = decodeWorkspaceOperationNativeMoveBatchPlan({ ...planned,
      integrityProof: computeWorkspaceOperationNativeMoveBatchPlanIntegrityProof(planned) });
    if (decoded.planIdentityVersion !== 3) fail();
    return decoded;
  });
}

/** Explicit new creation only. Historical auto/V1/V2 factories keep their
 * existing selection, shapes and identity semantics. */
export function createWorkspaceOperationNativeMoveBatchPlanV3(input: NativeMovePlanInput): WorkspaceOperationNativeMoveBatchPlanV3 {
  return createPlanV3(input);
}

function replayCurrentV3(original: WorkspaceOperationNativeMoveBatchPlanV3,
  current: ReturnType<typeof observedV3>): NativeMixedReadBatchPlanV3 {
  if (!isDeepStrictEqual(original.sourceEvidence.workspaceScope, current.evidence.workspaceScope)
    || original.sourceEvidence.semanticProof !== current.evidence.semanticProof) fail('NATIVE_MOVE_PLAN_CHANGED');
  // Rehearse the ORIGINAL full namespace and physical read inventory. A new
  // checkpoint may change raw catalogue-derived physical IDs without changing
  // proven semantic facts; it must not silently change the original compiler.
  const snapshot = workspaceOperationMixedSourceSnapshot(original.sourceEvidence);
  const compiled = compileV3(snapshot, original.actions[0], current.states);
  if (compiled.planId !== original.compilerPlanProof || compiled.finalGraphProof !== original.finalGraphProof) fail('NATIVE_MOVE_PLAN_CHANGED');
  return freeze(compiled);
}

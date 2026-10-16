import 'server-only';

import { isDeepStrictEqual } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { NativeLinkMutationRecipe, NativeWorkspaceFileOperationPlan, NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import { createWorkspaceNativeFileOperationPlan } from '../markdown/workspace-native-file-operation-planner';
import { compileWorkspaceNativeMixedBatch, type NativeMixedBatchPlan, type NativeMixedBatchRequest } from '../markdown/workspace-native-mixed-batch-compiler';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationBatchAction, WorkspaceOperationBatchScope, WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData, workspaceOperationNativePlanSnapshot } from './workspace-operation-native-plan-data';
import { assertWorkspaceOperationNativeSourceEvidenceCurrent, captureWorkspaceOperationNativeSourceEvidence,
  decodeWorkspaceOperationNativeSourceEvidence, type WorkspaceOperationNativeSourceEvidence } from './workspace-operation-native-source-evidence';

type MoveAction = WorkspaceOperationBatchAction & { kind: 'move' | 'rename' };
/** Private planning data, intentionally separate from the executable V1/V2 job
 * union. Neither this envelope nor its hashes confer claim/room/SQL authority.
 * Compiler bodies/bytes are not duplicated in persisted JSON. Before execution
 * the current gate MUST reproduce both proofs using actual proven native bytes. */
export type WorkspaceOperationNativeMoveBatchPlan = Readonly<{
  version: 3;
  kind: 'native-path-change';
  workspaceId: string;
  planId: string;
  readiness: 'ready';
  executionReady: false;
  actions: [MoveAction];
  sourceEvidence: WorkspaceOperationNativeSourceEvidence;
  nativePathPlan: NativeWorkspaceFileOperationPlan;
  compilerPlanProof: string;
  finalGraphProof: string;
}>;
const keys = ['version', 'kind', 'workspaceId', 'planId', 'readiness', 'executionReady', 'actions',
  'sourceEvidence', 'nativePathPlan', 'compilerPlanProof', 'finalGraphProof'];
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
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) fail();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  return descriptor.value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
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
export function computeWorkspaceOperationNativeMoveBatchPlanId(plan: Omit<WorkspaceOperationNativeMoveBatchPlan, 'planId'>): string {
  const { planId: _historical, ...body } = plan as WorkspaceOperationNativeMoveBatchPlan;
  return nativeLinkJsonProof(body);
}
/** Historical JSON integrity only. Path mappings and all recipes are rederived
 * independently. Opaque compiler hashes are syntax/integrity data until the
 * current-byte replay below; a forged hash can never authorize execution. */
export function decodeWorkspaceOperationNativeMoveBatchPlan(input: unknown): WorkspaceOperationNativeMoveBatchPlan {
  const value = capture(input) as WorkspaceOperationNativeMoveBatchPlan;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || Object.keys(value).some(key => !keys.includes(key)) || value.version !== 3 || value.kind !== 'native-path-change'
    || value.readiness !== 'ready' || value.executionReady !== false || !proof(value.compilerPlanProof)
    || !proof(value.finalGraphProof) || !proof(value.planId)) fail();
  const sourceEvidence = decodeWorkspaceOperationNativeSourceEvidence(value.sourceEvidence);
  const scope = parseWorkspaceOperationJobScope(sourceEvidence.workspaceScope), selected = action(value.actions);
  if (scope.legacy || value.workspaceId !== scope.workspaceId || value.workspaceId !== sourceEvidence.stage.workspaceId) fail();
  const snapshot = workspaceOperationNativePlanSnapshot(sourceEvidence, () => fail('NATIVE_MOVE_PLAN_UNSUPPORTED'));
  if (!isDeepStrictEqual(value.nativePathPlan, pathPlan(snapshot, selected))) fail();
  if (computeWorkspaceOperationNativeMoveBatchPlanId(value) !== value.planId) fail();
  return freeze(value);
}
export function createWorkspaceOperationNativeMoveBatchPlan(input: {
  scope: WorkspaceOperationBatchScope; actions: WorkspaceOperationBatchAction[]; observation: WorkspaceLinkSourceAuthorityObservation;
}): WorkspaceOperationNativeMoveBatchPlan {
  const selected = action(capture(field(input, 'actions')));
  const workspace = field(field(input, 'scope'), 'workspace') as WorkspaceOperationBatchScope['workspace'];
  const observation = field(input, 'observation') as WorkspaceLinkSourceAuthorityObservation;
  const sourceEvidence = captureWorkspaceOperationNativeSourceEvidence(captureWorkspaceOperationJobScope(workspace), observation);
  const snapshot = workspaceOperationNativePlanSnapshot(sourceEvidence, () => fail('NATIVE_MOVE_PLAN_UNSUPPORTED'));
  const nativePathPlan = pathPlan(snapshot, selected), compiled = compile(snapshot, selected, observation);
  const body: Omit<WorkspaceOperationNativeMoveBatchPlan, 'planId'> = { version: 3, kind: 'native-path-change',
    workspaceId: snapshot.workspaceId, readiness: 'ready', executionReady: false, actions: [selected],
    sourceEvidence, nativePathPlan, compilerPlanProof: compiled.planId, finalGraphProof: compiled.finalGraphProof! };
  return decodeWorkspaceOperationNativeMoveBatchPlan({ ...body, planId: computeWorkspaceOperationNativeMoveBatchPlanId(body) });
}
/** Requires the caller's genuine current authority/fence. Replaceable native
 * projections and directory mtimes may differ. Replay the ORIGINAL namespace
 * with freshly proven bytes, so our own later path stage cannot rewrite what
 * the original request meant. Returned compiler data is still not authority. */
export function assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan: WorkspaceOperationNativeMoveBatchPlan,
  observation: WorkspaceLinkSourceAuthorityObservation, scopeSnapshot: WorkspaceOperationJobScope): NativeMixedBatchPlan {
  const original = decodeWorkspaceOperationNativeMoveBatchPlan(plan);
  assertWorkspaceOperationNativeSourceEvidenceCurrent(original.sourceEvidence, observation, scopeSnapshot);
  const snapshot = workspaceOperationNativePlanSnapshot(original.sourceEvidence, () => fail('NATIVE_MOVE_PLAN_UNSUPPORTED'));
  const compiled = compile(snapshot, original.actions[0], observation);
  if (compiled.planId !== original.compilerPlanProof || compiled.finalGraphProof !== original.finalGraphProof) fail('NATIVE_MOVE_PLAN_CHANGED');
  return freeze(compiled);
}
/** Fresh recipes bound to original document IDs, generations and references;
 * not clone anchors, Markdown spans, prepared updates or mutation permission. */
export function getWorkspaceOperationNativeMoveLinkRecipes(plan: WorkspaceOperationNativeMoveBatchPlan): NativeLinkMutationRecipe[] {
  return structuredClone(decodeWorkspaceOperationNativeMoveBatchPlan(plan).nativePathPlan.mutations);
}

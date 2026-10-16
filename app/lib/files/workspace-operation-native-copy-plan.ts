import 'server-only';

import { isDeepStrictEqual } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import type { NativeWorkspaceFileOperationPlan, NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import { createWorkspaceNativeFileOperationPlan } from '../markdown/workspace-native-file-operation-planner';
import { compileWorkspaceNativeMixedBatch, type NativeMixedBatchPlan, type NativeMixedBatchRequest } from '../markdown/workspace-native-mixed-batch-compiler';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationBatchScope, WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData, workspaceOperationNativePlanSnapshot } from './workspace-operation-native-plan-data';
import { assertWorkspaceOperationNativeSourceEvidenceCurrent, captureWorkspaceOperationNativeSourceEvidence,
  decodeWorkspaceOperationNativeSourceEvidence, WorkspaceOperationNativeSourceEvidenceError,
  type WorkspaceOperationNativeSourceEvidence } from './workspace-operation-native-source-evidence';

export type WorkspaceOperationNativeCopySelection = Readonly<{ sourcePath: string; destinationPath: string }>;
/** Historical private planning data for the existing Copy coordinator. Virtual
 * clone requirements confer neither durable clone identities nor permission.
 * No native bytes, Markdown projections or executable clone references persist. */
export type WorkspaceOperationNativeCopyPlan = Readonly<{
  version: 1;
  kind: 'native-copy';
  planId: string;
  readiness: 'ready' | 'requires-clone-rebinding';
  executionReady: false;
  sourceScope: WorkspaceOperationJobScope;
  destinationScope: WorkspaceOperationJobScope;
  selections: readonly WorkspaceOperationNativeCopySelection[];
  sourceEvidence: WorkspaceOperationNativeSourceEvidence;
  destinationEvidence: WorkspaceOperationNativeSourceEvidence;
  nativePathPlan: NativeWorkspaceFileOperationPlan;
  compilerPlanProof: string;
  finalGraphProof: string;
  cloneRequirements: NativeMixedBatchPlan['cloneRequirements'];
}>;
type Code = 'NATIVE_COPY_PLAN_INVALID' | 'NATIVE_COPY_PLAN_TOO_LARGE' | 'NATIVE_COPY_PLAN_UNSUPPORTED' | 'NATIVE_COPY_PLAN_CHANGED';
export class WorkspaceOperationNativeCopyPlanError extends Error {
  readonly status = 409;
  constructor(readonly code: Code) { super(code); this.name = 'WorkspaceOperationNativeCopyPlanError'; }
}
const keys = ['version', 'kind', 'planId', 'readiness', 'executionReady', 'sourceScope', 'destinationScope', 'selections',
  'sourceEvidence', 'destinationEvidence', 'nativePathPlan', 'compilerPlanProof', 'finalGraphProof', 'cloneRequirements'];
function fail(code: Code = 'NATIVE_COPY_PLAN_INVALID'): never { throw new WorkspaceOperationNativeCopyPlanError(code); }
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => fail(reason === 'too-large'
    ? 'NATIVE_COPY_PLAN_TOO_LARGE' : 'NATIVE_COPY_PLAN_INVALID'));
}
function field(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) fail();
  const property = Object.getOwnPropertyDescriptor(input, key);
  if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail();
  return property.value;
}
function exact(input: unknown, expected: readonly string[]): void {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== expected.length || expected.some(key => !Object.hasOwn(input, key))) fail();
  for (const key of expected) field(input, key);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function guarded<T>(callback: () => T): T {
  try { return callback(); } catch (error) {
    if (error instanceof WorkspaceOperationNativeCopyPlanError) throw error;
    if (error instanceof WorkspaceOperationNativeSourceEvidenceError) {
      if (error.code === 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE') fail('NATIVE_COPY_PLAN_TOO_LARGE');
      if (error.code === 'NATIVE_SOURCE_EVIDENCE_CHANGED') fail('NATIVE_COPY_PLAN_CHANGED');
      if (error.code === 'NATIVE_SOURCE_IMPORT_REQUIRED') fail('NATIVE_COPY_PLAN_UNSUPPORTED');
    }
    return fail();
  }
}
function selections(input: unknown): WorkspaceOperationNativeCopySelection[] {
  if (!Array.isArray(input) || !input.length || input.length > 1000) fail('NATIVE_COPY_PLAN_UNSUPPORTED');
  for (const item of input) {
    exact(item, ['sourcePath', 'destinationPath']);
    if (![item.sourcePath, item.destinationPath].every(value => typeof value === 'string'
      && Buffer.byteLength(value) <= 4096 && isCanonicalAdmissionPath(value) && value.split('/').length <= 33)) {
      fail('NATIVE_COPY_PLAN_UNSUPPORTED');
    }
  }
  return input;
}
function request(source: WorkspaceOperationJobScope, destination: WorkspaceOperationJobScope,
  selected: readonly WorkspaceOperationNativeCopySelection[]): NativeMixedBatchRequest {
  return { kind: 'copy', sourceWorkspaceId: source.workspaceId, destinationWorkspaceId: destination.workspaceId,
    selections: selected.map(item => ({ ...item })) };
}
function snapshots(source: WorkspaceOperationNativeSourceEvidence,
  destination: WorkspaceOperationNativeSourceEvidence): NativeWorkspaceLinkSnapshot[] {
  if (source.workspaceScope.workspaceId === destination.workspaceScope.workspaceId && !isDeepStrictEqual(source, destination)) fail();
  return (source.workspaceScope.workspaceId === destination.workspaceScope.workspaceId ? [source] : [source, destination])
    .map(evidence => workspaceOperationNativePlanSnapshot(evidence, () => fail('NATIVE_COPY_PLAN_UNSUPPORTED')));
}
function pathPlan(source: WorkspaceOperationJobScope, destination: WorkspaceOperationJobScope,
  selected: readonly WorkspaceOperationNativeCopySelection[], original: NativeWorkspaceLinkSnapshot[]): NativeWorkspaceFileOperationPlan {
  const planned = createWorkspaceNativeFileOperationPlan({ ...request(source, destination, selected), snapshots: original });
  if (planned.readiness !== 'ready' || planned.issues.length || !planned.pathMappings.length
    || planned.pathMappings.some(mapping => !isCanonicalAdmissionPath(mapping.destinationPath)
      || Buffer.byteLength(mapping.destinationPath) > 4096 || mapping.destinationPath.split('/').length > 33)
    || planned.mutations.some(recipe => recipe.action !== 'rewrite' || recipe.nextValue === null || recipe.cloneSelection === null
      || recipe.source.workspaceId !== source.workspaceId || recipe.destinationWorkspaceId !== destination.workspaceId)) {
    fail('NATIVE_COPY_PLAN_UNSUPPORTED');
  }
  return planned;
}
/** Reproduce the compiler's virtual binding contract from original inventories.
 * Content hashes cannot be reconstructed from link inventories; they remain
 * opaque here and MUST be reproduced by the current-byte compiler gate. */
function cloneRequirements(original: NativeWorkspaceLinkSnapshot, destination: WorkspaceOperationJobScope,
  selected: readonly WorkspaceOperationNativeCopySelection[], planned: NativeWorkspaceFileOperationPlan,
  supplied: NativeMixedBatchPlan['cloneRequirements']): NativeMixedBatchPlan['cloneRequirements'] {
  if (!Array.isArray(supplied)) fail();
  const result: NativeMixedBatchPlan['cloneRequirements'] = [];
  const mapped = new Map(planned.pathMappings.map(mapping => [mapping.source.path, mapping]));
  const inventories = new Map(original.documents.map(inventory => [inventory.document.path, inventory]));
  for (const selection of selected) for (const entry of original.namespace) {
    if (entry.path !== selection.sourcePath && !entry.path.startsWith(`${selection.sourcePath}/`)) continue;
    const inventory = inventories.get(entry.path), mapping = mapped.get(entry.path);
    if (!inventory || !mapping) continue;
    const suppliedRow = supplied[result.length];
    if (!suppliedRow || !digest(suppliedRow.sourceContentBasisProof)) fail();
    const sourceEntityKey = nativeLinkJsonProof({ workspaceId: original.workspaceId, identity: entry.identity });
    const entityKey = nativeLinkJsonProof({ requestIndex: 0, sourceEntityKey,
      destinationWorkspaceId: destination.workspaceId, destinationPath: mapping.destinationPath });
    result.push({ entityKey, sourceEntityKey, requestIndex: 0, sourceWorkspaceId: original.workspaceId, sourcePath: entry.path,
      sourceContentBasisProof: suppliedRow.sourceContentBasisProof, applicability: 'requires-fresh-clone-receipt-and-inventory',
      linkBindings: inventory.links.map(link => {
        const sourceVirtualLinkKey = nativeLinkJsonProof({ entityKey: sourceEntityKey, linkId: link.id });
        return { virtualLinkKey: nativeLinkJsonProof({ entityKey, sourceVirtualLinkKey }), sourceVirtualLinkKey, originEvidenceLinkId: link.id };
      }) });
  }
  if (!isDeepStrictEqual(result, supplied)) fail();
  return result;
}
type CapturedObservation = { evidence: WorkspaceOperationNativeSourceEvidence; observation: WorkspaceLinkSourceAuthorityObservation };
function observed(scope: WorkspaceOperationJobScope, observation: WorkspaceLinkSourceAuthorityObservation): CapturedObservation {
  const evidence = captureWorkspaceOperationNativeSourceEvidence(scope, observation);
  // Evidence capture validates all state descriptors/typed-array bounds before
  // cloning. Compile only these detached bytes, never a later caller read.
  const states = structuredClone(field(observation, 'privateNativeStates')) as PersistedCollaborationState[];
  const detached = { stage: evidence.stage, nativeBindings: evidence.nativeBindings, privateNativeStates: states };
  captureWorkspaceOperationNativeSourceEvidence(scope, detached);
  return { evidence, observation: detached };
}
function compile(source: WorkspaceOperationJobScope, destination: WorkspaceOperationJobScope,
  selected: readonly WorkspaceOperationNativeCopySelection[], original: NativeWorkspaceLinkSnapshot[],
  sourceObservation: WorkspaceLinkSourceAuthorityObservation, destinationObservation: WorkspaceLinkSourceAuthorityObservation): NativeMixedBatchPlan {
  const compiled = compileWorkspaceNativeMixedBatch({ snapshots: original, requests: [request(source, destination, selected)],
    states: source.workspaceId === destination.workspaceId ? sourceObservation.privateNativeStates
      : [...sourceObservation.privateNativeStates, ...destinationObservation.privateNativeStates] });
  if (compiled.issues.length || compiled.executionReady !== false || !digest(compiled.planId) || !digest(compiled.finalGraphProof)
    || compiled.readiness !== (compiled.cloneRequirements.length ? 'requires-clone-rebinding' : 'ready')) fail('NATIVE_COPY_PLAN_UNSUPPORTED');
  return compiled;
}
export function computeWorkspaceOperationNativeCopyPlanId(plan: Omit<WorkspaceOperationNativeCopyPlan, 'planId'>): string {
  const { planId: _historical, ...body } = capture(plan) as WorkspaceOperationNativeCopyPlan;
  return nativeLinkJsonProof(body);
}
/** Bounded historical integrity only. Rehashing compiler/content/final hashes
 * does not make them current or confer execution admission. */
export function decodeWorkspaceOperationNativeCopyPlan(input: unknown): WorkspaceOperationNativeCopyPlan {
  return guarded(() => {
    const value = capture(input) as WorkspaceOperationNativeCopyPlan;
    exact(value, keys);
    if (value.version !== 1 || value.kind !== 'native-copy' || value.executionReady !== false
      || !digest(value.planId) || !digest(value.compilerPlanProof) || !digest(value.finalGraphProof)) fail();
    const sourceScope = parseWorkspaceOperationJobScope(value.sourceScope), destinationScope = parseWorkspaceOperationJobScope(value.destinationScope);
    const source = decodeWorkspaceOperationNativeSourceEvidence(value.sourceEvidence);
    const destination = decodeWorkspaceOperationNativeSourceEvidence(value.destinationEvidence);
    if (!isDeepStrictEqual(sourceScope, source.workspaceScope) || !isDeepStrictEqual(destinationScope, destination.workspaceScope)) fail();
    const selected = selections(value.selections), original = snapshots(source, destination);
    const planned = pathPlan(sourceScope, destinationScope, selected, original);
    if (!isDeepStrictEqual(value.nativePathPlan, planned)) fail();
    const clones = cloneRequirements(original[0], destinationScope, selected, planned, value.cloneRequirements);
    if (value.readiness !== (clones.length ? 'requires-clone-rebinding' : 'ready')
      || computeWorkspaceOperationNativeCopyPlanId(value) !== value.planId) fail();
    return freeze(value);
  });
}
export function createWorkspaceOperationNativeCopyPlan(input: {
  sourceScope: WorkspaceOperationBatchScope; destinationScope: WorkspaceOperationBatchScope;
  selections: readonly WorkspaceOperationNativeCopySelection[];
  sourceObservation: WorkspaceLinkSourceAuthorityObservation; destinationObservation: WorkspaceLinkSourceAuthorityObservation;
}): WorkspaceOperationNativeCopyPlan {
  return guarded(() => {
    exact(input, ['sourceScope', 'destinationScope', 'selections', 'sourceObservation', 'destinationObservation']);
    const selected = selections(capture(field(input, 'selections')));
    const sourceScope = captureWorkspaceOperationJobScope(field(field(input, 'sourceScope'), 'workspace') as WorkspaceOperationBatchScope['workspace']);
    const destinationScope = captureWorkspaceOperationJobScope(field(field(input, 'destinationScope'), 'workspace') as WorkspaceOperationBatchScope['workspace']);
    const source = observed(sourceScope, field(input, 'sourceObservation') as WorkspaceLinkSourceAuthorityObservation);
    const destination = observed(destinationScope, field(input, 'destinationObservation') as WorkspaceLinkSourceAuthorityObservation);
    const original = snapshots(source.evidence, destination.evidence);
    const nativePathPlan = pathPlan(sourceScope, destinationScope, selected, original);
    const compiled = compile(sourceScope, destinationScope, selected, original, source.observation, destination.observation);
    const body: Omit<WorkspaceOperationNativeCopyPlan, 'planId'> = { version: 1, kind: 'native-copy', readiness: compiled.readiness as WorkspaceOperationNativeCopyPlan['readiness'],
      executionReady: false, sourceScope, destinationScope, selections: selected, sourceEvidence: source.evidence,
      destinationEvidence: destination.evidence, nativePathPlan, compilerPlanProof: compiled.planId,
      finalGraphProof: compiled.finalGraphProof!, cloneRequirements: compiled.cloneRequirements };
    return decodeWorkspaceOperationNativeCopyPlan({ ...body, planId: computeWorkspaceOperationNativeCopyPlanId(body) });
  });
}
/** Requires genuine caller-held authority/fences. Replays the original complete
 * namespace against freshly verified source AND destination native bytes.
 * Even the returned compiler data remains executionReady:false. */
export function assertWorkspaceOperationNativeCopyPlanCurrent(plan: WorkspaceOperationNativeCopyPlan, input: {
  sourceScope: WorkspaceOperationJobScope; destinationScope: WorkspaceOperationJobScope;
  sourceObservation: WorkspaceLinkSourceAuthorityObservation; destinationObservation: WorkspaceLinkSourceAuthorityObservation;
}): NativeMixedBatchPlan {
  return guarded(() => {
    const original = decodeWorkspaceOperationNativeCopyPlan(plan);
    exact(input, ['sourceScope', 'destinationScope', 'sourceObservation', 'destinationObservation']);
    const sourceScope = parseWorkspaceOperationJobScope(field(input, 'sourceScope'));
    const destinationScope = parseWorkspaceOperationJobScope(field(input, 'destinationScope'));
    if (!isDeepStrictEqual(sourceScope, original.sourceScope) || !isDeepStrictEqual(destinationScope, original.destinationScope)) fail('NATIVE_COPY_PLAN_CHANGED');
    const source = observed(sourceScope, field(input, 'sourceObservation') as WorkspaceLinkSourceAuthorityObservation);
    const destination = observed(destinationScope, field(input, 'destinationObservation') as WorkspaceLinkSourceAuthorityObservation);
    assertWorkspaceOperationNativeSourceEvidenceCurrent(original.sourceEvidence, source.observation, sourceScope);
    assertWorkspaceOperationNativeSourceEvidenceCurrent(original.destinationEvidence, destination.observation, destinationScope);
    snapshots(source.evidence, destination.evidence);
    const compiled = compile(sourceScope, destinationScope, original.selections,
      snapshots(original.sourceEvidence, original.destinationEvidence), source.observation, destination.observation);
    if (compiled.planId !== original.compilerPlanProof || compiled.finalGraphProof !== original.finalGraphProof
      || !isDeepStrictEqual(compiled.cloneRequirements, original.cloneRequirements)) fail('NATIVE_COPY_PLAN_CHANGED');
    return freeze(compiled);
  });
}

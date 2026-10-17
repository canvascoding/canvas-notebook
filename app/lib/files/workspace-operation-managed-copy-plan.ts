import 'server-only';

import { isDeepStrictEqual, types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { NativeWorkspaceFileOperationPlan, NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { createWorkspaceNativeFileOperationPlan } from '../markdown/workspace-native-file-operation-planner';
import { compileWorkspaceNativeMixedBatch, type NativeMixedBatchPlan } from '../markdown/workspace-native-mixed-batch-compiler';
import type { WorkspaceOperationBatchScope, WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData, workspaceOperationNativePlanSnapshot } from './workspace-operation-native-plan-data';
import { assertNativeCopyCloneRequirements, type WorkspaceOperationNativeCopySelection } from './workspace-operation-native-copy-plan';
import { captureWorkspaceOperationCopySourceEvidenceV3, decodeWorkspaceOperationCopySourceEvidenceV3,
  type WorkspaceOperationCopySourceEvidenceV3 } from './workspace-operation-copy-source-evidence';

export type WorkspaceSceneCopyRequirement = Readonly<{
  sourceWorkspaceId: string; sourcePath: string; sourceDocumentId: string; sourceLineageId: string;
  sourceGeneration: number; sourceSceneSequence: number; sourceCanonicalHash: string; sourceContentProof: string;
  destinationWorkspaceId: string; destinationPath: string;
}>;
export type WorkspaceOperationManagedCopyPlan = Readonly<{
  version: 3; kind: 'native-copy'; executionReady: false;
  readiness: 'ready' | 'requires-provider-publication';
  sourceScope: WorkspaceOperationJobScope; destinationScope: WorkspaceOperationJobScope;
  selections: readonly WorkspaceOperationNativeCopySelection[];
  sourceEvidence: WorkspaceOperationCopySourceEvidenceV3; destinationEvidence: WorkspaceOperationCopySourceEvidenceV3;
  nativePathPlan: NativeWorkspaceFileOperationPlan; compilerPlanProof: string; finalGraphProof: string;
  cloneRequirements: NativeMixedBatchPlan['cloneRequirements']; sceneCopyRequirements: readonly WorkspaceSceneCopyRequirement[];
  planId: string; integrityProof: string;
}>;
export class WorkspaceOperationManagedCopyPlanError extends Error {
  readonly status = 409;
  constructor(readonly code: 'MANAGED_COPY_PLAN_INVALID' | 'MANAGED_COPY_PLAN_CHANGED' | 'MANAGED_COPY_PLAN_UNSUPPORTED') {
    super(code); this.name = 'WorkspaceOperationManagedCopyPlanError';
  }
}
const fail = (code: WorkspaceOperationManagedCopyPlanError['code'] = 'MANAGED_COPY_PLAN_INVALID'): never => {
  throw new WorkspaceOperationManagedCopyPlanError(code);
};
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function capture(input: unknown): unknown { return captureWorkspaceOperationNativePlanData(input, () => fail()); }
function field(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return fail();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail(); return descriptor.value;
}
function exact(input: unknown, keys: readonly string[]): void {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length) return fail();
  for (const key of keys) field(input, key);
}
function freeze<T>(input: T): T {
  if (input && typeof input === 'object') { for (const child of Object.values(input)) freeze(child); Object.freeze(input); } return input;
}
function selected(input: unknown): readonly WorkspaceOperationNativeCopySelection[] {
  const rows = capture(input);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 1000) return fail();
  for (const row of rows) {
    exact(row, ['sourcePath', 'destinationPath']);
    if (![row.sourcePath, row.destinationPath].every(value => isCanonicalAdmissionPath(value)
      && Buffer.byteLength(value) <= 4096 && value.split('/').length <= 33)) return fail();
  }
  return rows;
}
function snapshots(source: WorkspaceOperationCopySourceEvidenceV3, destination: WorkspaceOperationCopySourceEvidenceV3): NativeWorkspaceLinkSnapshot[] {
  if (source.workspaceScope.workspaceId === destination.workspaceScope.workspaceId && !isDeepStrictEqual(source, destination)) return fail();
  return (source.workspaceScope.workspaceId === destination.workspaceScope.workspaceId ? [source] : [source, destination])
    .map(evidence => workspaceOperationNativePlanSnapshot(evidence, () => fail('MANAGED_COPY_PLAN_UNSUPPORTED')));
}
function request(source: WorkspaceOperationJobScope, destination: WorkspaceOperationJobScope, selections: readonly WorkspaceOperationNativeCopySelection[]) {
  return { kind: 'copy' as const, sourceWorkspaceId: source.workspaceId, destinationWorkspaceId: destination.workspaceId,
    selections: selections.map(selection => ({ ...selection })) };
}
function pathPlan(source: WorkspaceOperationJobScope, destination: WorkspaceOperationJobScope,
  selections: readonly WorkspaceOperationNativeCopySelection[], originals: NativeWorkspaceLinkSnapshot[]): NativeWorkspaceFileOperationPlan {
  const plan = createWorkspaceNativeFileOperationPlan({ ...request(source, destination, selections), snapshots: originals });
  if (plan.readiness !== 'ready' || plan.issues.length || !plan.pathMappings.length
    || plan.pathMappings.some(mapping => !isCanonicalAdmissionPath(mapping.destinationPath)
      || Buffer.byteLength(mapping.destinationPath) > 4096 || mapping.destinationPath.split('/').length > 33)
    || plan.mutations.some(recipe => recipe.action !== 'rewrite' || recipe.nextValue === null || recipe.cloneSelection === null
      || recipe.source.workspaceId !== source.workspaceId || recipe.destinationWorkspaceId !== destination.workspaceId)) return fail('MANAGED_COPY_PLAN_UNSUPPORTED');
  return plan;
}
function sceneRequirements(source: WorkspaceOperationCopySourceEvidenceV3, destination: WorkspaceOperationJobScope,
  paths: NativeWorkspaceFileOperationPlan): WorkspaceSceneCopyRequirement[] {
  const scenes = new Map(source.sceneBindings.map(binding => [binding.header.path, binding]));
  return paths.pathMappings.flatMap(mapping => {
    const binding = scenes.get(mapping.source.path);
    if (!binding) { if (mapping.source.provider === 'excalidraw') return fail(); return []; }
    if (mapping.source.provider !== 'excalidraw' || mapping.source.documentId !== null
      || !mapping.destinationPath.toLowerCase().endsWith('.excalidraw')
      || mapping.destinationPath.split('/').pop()?.toLowerCase() === '.excalidraw') return fail('MANAGED_COPY_PLAN_UNSUPPORTED');
    const header = binding.header;
    return [{ sourceWorkspaceId: source.workspaceScope.workspaceId, sourcePath: header.path,
      sourceDocumentId: header.id, sourceLineageId: header.lineage_id, sourceGeneration: header.lifecycle_generation!,
      sourceSceneSequence: header.scene_sequence!, sourceCanonicalHash: header.canonical_hash!, sourceContentProof: binding.contentProof,
      destinationWorkspaceId: destination.workspaceId, destinationPath: mapping.destinationPath }];
  });
}
function planId(value: Pick<WorkspaceOperationManagedCopyPlan, 'sourceScope' | 'destinationScope' | 'selections' | 'sourceEvidence' | 'destinationEvidence'>): string {
  return proof({ version: 3, kind: 'native-copy', sourceScope: value.sourceScope, destinationScope: value.destinationScope,
    selections: value.selections, sourceSemanticProof: value.sourceEvidence.semanticProof, destinationSemanticProof: value.destinationEvidence.semanticProof });
}
function compiler(source: WorkspaceOperationJobScope, destination: WorkspaceOperationJobScope,
  selections: readonly WorkspaceOperationNativeCopySelection[], originals: NativeWorkspaceLinkSnapshot[],
  sourceObservation: WorkspaceLinkSourceAuthorityObservation, destinationObservation: WorkspaceLinkSourceAuthorityObservation): NativeMixedBatchPlan {
  const compiled = compileWorkspaceNativeMixedBatch({ snapshots: originals, requests: [request(source, destination, selections)],
    states: source.workspaceId === destination.workspaceId ? sourceObservation.privateNativeStates
      : [...sourceObservation.privateNativeStates, ...destinationObservation.privateNativeStates] });
  if (compiled.issues.length || compiled.executionReady !== false || !hash(compiled.planId) || !hash(compiled.finalGraphProof)
    || compiled.readiness !== (compiled.cloneRequirements.length ? 'requires-clone-rebinding' : 'ready')) return fail('MANAGED_COPY_PLAN_UNSUPPORTED');
  return compiled;
}

/** Pure, bounded historical integrity. Current same-connection observations and
 * the original owner are required for every write; this decoder grants neither. */
export function decodeWorkspaceOperationManagedCopyPlan(input: unknown): WorkspaceOperationManagedCopyPlan {
  const value = capture(input) as WorkspaceOperationManagedCopyPlan;
  exact(value, ['version', 'kind', 'executionReady', 'readiness', 'sourceScope', 'destinationScope', 'selections',
    'sourceEvidence', 'destinationEvidence', 'nativePathPlan', 'compilerPlanProof', 'finalGraphProof',
    'cloneRequirements', 'sceneCopyRequirements', 'planId', 'integrityProof']);
  if (value.version !== 3 || value.kind !== 'native-copy' || value.executionReady !== false
    || ![value.planId, value.integrityProof, value.compilerPlanProof, value.finalGraphProof].every(hash)) return fail();
  const source = decodeWorkspaceOperationCopySourceEvidenceV3(value.sourceEvidence), destination = decodeWorkspaceOperationCopySourceEvidenceV3(value.destinationEvidence);
  if (!isDeepStrictEqual(source.workspaceScope, parseWorkspaceOperationJobScope(value.sourceScope))
    || !isDeepStrictEqual(destination.workspaceScope, parseWorkspaceOperationJobScope(value.destinationScope))) return fail();
  const selections = selected(value.selections), originals = snapshots(source, destination);
  const paths = pathPlan(value.sourceScope, value.destinationScope, selections, originals);
  if (!isDeepStrictEqual(paths, value.nativePathPlan)) return fail();
  const clones = assertNativeCopyCloneRequirements(originals[0], value.destinationScope, selections, paths, value.cloneRequirements);
  const scenes = sceneRequirements(source, value.destinationScope, paths);
  if (!isDeepStrictEqual(scenes, value.sceneCopyRequirements) || value.readiness !== (clones.length || scenes.length ? 'requires-provider-publication' : 'ready')
    || planId(value) !== value.planId) return fail();
  const { integrityProof, ...body } = value;
  if (proof(body) !== integrityProof) return fail();
  return freeze(value);
}
export type WorkspaceManagedCopyPlanInput = {
  sourceScope: WorkspaceOperationBatchScope; destinationScope: WorkspaceOperationBatchScope;
  selections: readonly WorkspaceOperationNativeCopySelection[];
  sourceObservation: WorkspaceLinkSourceAuthorityObservation; destinationObservation: WorkspaceLinkSourceAuthorityObservation;
};
/** Same shared path/link compiler as Yjs Copy, with explicit Scene identities
 * kept out of Yjs clone requirements. No Scene birth/publication occurs here. */
export function createWorkspaceOperationManagedCopyPlan(input: WorkspaceManagedCopyPlanInput): WorkspaceOperationManagedCopyPlan {
  exact(input, ['sourceScope', 'destinationScope', 'selections', 'sourceObservation', 'destinationObservation']);
  const sourceWorkspace = field(field(input, 'sourceScope'), 'workspace'), destinationWorkspace = field(field(input, 'destinationScope'), 'workspace');
  if (types.isProxy(sourceWorkspace) || types.isProxy(destinationWorkspace)) return fail();
  const sourceScope = captureWorkspaceOperationJobScope(sourceWorkspace as WorkspaceOperationBatchScope['workspace']);
  const destinationScope = captureWorkspaceOperationJobScope(destinationWorkspace as WorkspaceOperationBatchScope['workspace']);
  const selections = selected(field(input, 'selections'));
  const sourceObservation = field(input, 'sourceObservation') as WorkspaceLinkSourceAuthorityObservation;
  const destinationObservation = field(input, 'destinationObservation') as WorkspaceLinkSourceAuthorityObservation;
  const source = captureWorkspaceOperationCopySourceEvidenceV3(sourceScope, sourceObservation), destination = captureWorkspaceOperationCopySourceEvidenceV3(destinationScope, destinationObservation);
  const originals = snapshots(source, destination), paths = pathPlan(sourceScope, destinationScope, selections, originals);
  const compiled = compiler(sourceScope, destinationScope, selections, originals, sourceObservation, destinationObservation);
  const scenes = sceneRequirements(source, destinationScope, paths);
  const body = { version: 3 as const, kind: 'native-copy' as const, executionReady: false as const,
    readiness: compiled.cloneRequirements.length || scenes.length ? 'requires-provider-publication' as const : 'ready' as const,
    sourceScope, destinationScope, selections, sourceEvidence: source, destinationEvidence: destination,
    nativePathPlan: paths, compilerPlanProof: compiled.planId, finalGraphProof: compiled.finalGraphProof!,
    cloneRequirements: compiled.cloneRequirements, sceneCopyRequirements: scenes };
  const planned = { ...body, planId: planId(body) };
  return decodeWorkspaceOperationManagedCopyPlan({ ...planned, integrityProof: proof(planned) });
}

/** Recompile original graph against fresh provider facts. Projection and
 * checkpoint advances may differ; identities, content and Scene sequence may not. */
export function assertWorkspaceOperationManagedCopyPlanCurrent(plan: WorkspaceOperationManagedCopyPlan, input: {
  sourceScope: WorkspaceOperationJobScope; destinationScope: WorkspaceOperationJobScope;
  sourceObservation: WorkspaceLinkSourceAuthorityObservation; destinationObservation: WorkspaceLinkSourceAuthorityObservation;
}): NativeMixedBatchPlan {
  const original = decodeWorkspaceOperationManagedCopyPlan(plan);
  exact(input, ['sourceScope', 'destinationScope', 'sourceObservation', 'destinationObservation']);
  const sourceScope = parseWorkspaceOperationJobScope(capture(input.sourceScope)), destinationScope = parseWorkspaceOperationJobScope(capture(input.destinationScope));
  if (!isDeepStrictEqual(sourceScope, original.sourceScope) || !isDeepStrictEqual(destinationScope, original.destinationScope)) return fail('MANAGED_COPY_PLAN_CHANGED');
  const source = captureWorkspaceOperationCopySourceEvidenceV3(sourceScope, input.sourceObservation), destination = captureWorkspaceOperationCopySourceEvidenceV3(destinationScope, input.destinationObservation);
  if (source.semanticProof !== original.sourceEvidence.semanticProof || destination.semanticProof !== original.destinationEvidence.semanticProof) return fail('MANAGED_COPY_PLAN_CHANGED');
  const compiled = compiler(sourceScope, destinationScope, original.selections, snapshots(original.sourceEvidence, original.destinationEvidence), input.sourceObservation, input.destinationObservation);
  if (compiled.planId !== original.compilerPlanProof || compiled.finalGraphProof !== original.finalGraphProof
    || !isDeepStrictEqual(compiled.cloneRequirements, original.cloneRequirements)) return fail('MANAGED_COPY_PLAN_CHANGED');
  return freeze(compiled);
}

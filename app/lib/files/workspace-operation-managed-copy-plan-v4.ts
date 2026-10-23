import 'server-only';

import { isDeepStrictEqual as equal, types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { FilePlanV3, WorkspaceMixedReadLinkSnapshotV3 } from '../markdown/workspace-link-contract-v3';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { createWorkspaceMixedReadFileOperationPlanV3 } from '../markdown/workspace-native-file-operation-planner';
import { compileWorkspaceMixedReadBatchV3, type NativeMixedReadBatchPlanV3 } from '../markdown/workspace-native-mixed-batch-compiler';
import type { WorkspaceOperationBatchScope, WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { assertNativeCopyCloneRequirements, type WorkspaceOperationNativeCopySelection } from './workspace-operation-native-copy-plan';
import { decodeWorkspaceOperationManagedCopyPlan, type WorkspaceOperationManagedCopyPlan,
  type WorkspaceSceneCopyRequirement } from './workspace-operation-managed-copy-plan';
import { captureWorkspaceOperationCopySourceEvidenceV4, decodeWorkspaceOperationCopySourceEvidenceV4,
  workspaceOperationMixedCopySourceSnapshot, type WorkspaceOperationCopySourceEvidenceV4 } from './workspace-operation-copy-source-evidence-v4';

/** Additive mixed READ plan. Physical sources remain immutable and cannot be
 * selected until a separate genuine destination-import protocol exists. */
export type WorkspaceOperationManagedCopyPlanV4 = Readonly<{
  version: 4; kind: 'native-copy'; executionReady: false;
  readiness: 'ready' | 'requires-provider-publication';
  sourceScope: WorkspaceOperationJobScope; destinationScope: WorkspaceOperationJobScope;
  selections: readonly WorkspaceOperationNativeCopySelection[];
  sourceEvidence: WorkspaceOperationCopySourceEvidenceV4; destinationEvidence: WorkspaceOperationCopySourceEvidenceV4;
  nativePathPlan: FilePlanV3; compilerPlanProof: string; finalGraphProof: string;
  cloneRequirements: NativeMixedReadBatchPlanV3['cloneRequirements']; sceneCopyRequirements: readonly WorkspaceSceneCopyRequirement[];
  planId: string; integrityProof: string;
}>;
export type WorkspaceOperationAnyManagedCopyPlan = WorkspaceOperationManagedCopyPlan | WorkspaceOperationManagedCopyPlanV4;
export class WorkspaceOperationManagedCopyPlanV4Error extends Error {
  readonly status = 409;
  constructor(readonly code: 'MANAGED_COPY_PLAN_INVALID' | 'MANAGED_COPY_PLAN_CHANGED' | 'MANAGED_COPY_PLAN_UNSUPPORTED'
    | 'MANAGED_COPY_PLAN_IMPORT_REQUIRED') {
    super(code === 'MANAGED_COPY_PLAN_IMPORT_REQUIRED'
      ? 'This Markdown file needs to be imported into the notebook before it can be copied.' : code);
    this.name = 'WorkspaceOperationManagedCopyPlanV4Error';
  }
}
function rejectManagedCopyV4Plan(code: WorkspaceOperationManagedCopyPlanV4Error['code'] = 'MANAGED_COPY_PLAN_INVALID'): never {
  throw new WorkspaceOperationManagedCopyPlanV4Error(code);
}
function managedCopyV4Digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function managedCopyV4Capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, () => rejectManagedCopyV4Plan(), 16 * 1024 * 1024);
}
function managedCopyV4Field(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return rejectManagedCopyV4Plan();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return rejectManagedCopyV4Plan();
  return descriptor.value;
}
function managedCopyV4Exact(input: unknown, keys: readonly string[]): void {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length) return rejectManagedCopyV4Plan();
  for (const key of keys) managedCopyV4Field(input, key);
}
function freezeManagedCopyV4Plan<T>(input: T): T {
  if (input && typeof input === 'object') {
    for (const child of Object.values(input)) freezeManagedCopyV4Plan(child);
    Object.freeze(input);
  }
  return input;
}
function managedCopyV4Selections(input: unknown): readonly WorkspaceOperationNativeCopySelection[] {
  const rows = managedCopyV4Capture(input);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 1000) return rejectManagedCopyV4Plan();
  for (const row of rows) {
    managedCopyV4Exact(row, ['sourcePath', 'destinationPath']);
    if (![row.sourcePath, row.destinationPath].every(value => isCanonicalAdmissionPath(value)
      && Buffer.byteLength(value) <= 4096 && value.split('/').length <= 33)) return rejectManagedCopyV4Plan();
  }
  return rows;
}
function managedCopyV4Snapshots(source: WorkspaceOperationCopySourceEvidenceV4,
  destination: WorkspaceOperationCopySourceEvidenceV4): WorkspaceMixedReadLinkSnapshotV3[] {
  if (source.workspaceScope.workspaceId === destination.workspaceScope.workspaceId && !equal(source, destination)) return rejectManagedCopyV4Plan();
  return (source.workspaceScope.workspaceId === destination.workspaceScope.workspaceId ? [source] : [source, destination])
    .map(evidence => workspaceOperationMixedCopySourceSnapshot(evidence));
}
function managedCopyV4Request(source: WorkspaceOperationJobScope, destination: WorkspaceOperationJobScope,
  selections: readonly WorkspaceOperationNativeCopySelection[]) {
  return { kind: 'copy' as const, sourceWorkspaceId: source.workspaceId, destinationWorkspaceId: destination.workspaceId,
    selections: selections.map(selection => ({ ...selection })) };
}
function managedCopyV4PathPlan(source: WorkspaceOperationJobScope, destination: WorkspaceOperationJobScope,
  selections: readonly WorkspaceOperationNativeCopySelection[], originals: WorkspaceMixedReadLinkSnapshotV3[]): FilePlanV3 {
  const plan = createWorkspaceMixedReadFileOperationPlanV3({ ...managedCopyV4Request(source, destination, selections), snapshots: originals });
  if (plan.issues.some(issue => issue.code === 'physical-source-import-required')) return rejectManagedCopyV4Plan('MANAGED_COPY_PLAN_IMPORT_REQUIRED');
  if (plan.readiness !== 'ready' || plan.issues.length || !plan.pathMappings.length
    || plan.pathMappings.some(mapping => !isCanonicalAdmissionPath(mapping.destinationPath)
      || Buffer.byteLength(mapping.destinationPath) > 4096 || mapping.destinationPath.split('/').length > 33)
    || plan.mutations.some(recipe => recipe.action !== 'rewrite' || recipe.nextValue === null || recipe.cloneSelection === null
      || recipe.source.workspaceId !== source.workspaceId || recipe.destinationWorkspaceId !== destination.workspaceId)) return rejectManagedCopyV4Plan('MANAGED_COPY_PLAN_UNSUPPORTED');
  return plan;
}
function managedCopyV4SceneRequirements(source: WorkspaceOperationCopySourceEvidenceV4, destination: WorkspaceOperationJobScope,
  paths: FilePlanV3): WorkspaceSceneCopyRequirement[] {
  const scenes = new Map(source.sceneBindings.map(binding => [binding.header.path, binding]));
  return paths.pathMappings.flatMap(mapping => {
    const binding = scenes.get(mapping.source.path);
    if (!binding) { if (mapping.source.provider === 'excalidraw') return rejectManagedCopyV4Plan(); return []; }
    if (mapping.source.provider !== 'excalidraw' || mapping.source.documentId !== null
      || !mapping.destinationPath.toLowerCase().endsWith('.excalidraw')
      || mapping.destinationPath.split('/').pop()?.toLowerCase() === '.excalidraw') return rejectManagedCopyV4Plan('MANAGED_COPY_PLAN_UNSUPPORTED');
    const header = binding.header;
    return [{ sourceWorkspaceId: source.workspaceScope.workspaceId, sourcePath: header.path,
      sourceDocumentId: header.id, sourceLineageId: header.lineage_id, sourceGeneration: header.lifecycle_generation!,
      sourceSceneSequence: header.scene_sequence!, sourceCanonicalHash: header.canonical_hash!, sourceContentProof: binding.contentProof,
      destinationWorkspaceId: destination.workspaceId, destinationPath: mapping.destinationPath }];
  });
}
function managedCopyV4PlanId(value: Pick<WorkspaceOperationManagedCopyPlanV4,
  'sourceScope' | 'destinationScope' | 'selections' | 'sourceEvidence' | 'destinationEvidence'>): string {
  return proof({ version: 4, kind: 'native-copy', sourceScope: value.sourceScope, destinationScope: value.destinationScope,
    selections: value.selections, sourceSemanticProof: value.sourceEvidence.semanticProof, destinationSemanticProof: value.destinationEvidence.semanticProof });
}
function managedCopyV4Compiler(source: WorkspaceOperationJobScope, destination: WorkspaceOperationJobScope,
  selections: readonly WorkspaceOperationNativeCopySelection[], originals: WorkspaceMixedReadLinkSnapshotV3[],
  sourceObservation: WorkspaceLinkSourceAuthorityObservation, destinationObservation: WorkspaceLinkSourceAuthorityObservation): NativeMixedReadBatchPlanV3 {
  const compiled = compileWorkspaceMixedReadBatchV3({ snapshots: originals, requests: [managedCopyV4Request(source, destination, selections)],
    states: source.workspaceId === destination.workspaceId ? sourceObservation.privateNativeStates
      : [...sourceObservation.privateNativeStates, ...destinationObservation.privateNativeStates] });
  if (compiled.issues.some(issue => issue.code === 'physical-source-import-required')) return rejectManagedCopyV4Plan('MANAGED_COPY_PLAN_IMPORT_REQUIRED');
  if (compiled.issues.length || compiled.executionReady !== false || !managedCopyV4Digest(compiled.planId) || !managedCopyV4Digest(compiled.finalGraphProof)
    || compiled.readiness !== (compiled.cloneRequirements.length ? 'requires-clone-rebinding' : 'ready')) return rejectManagedCopyV4Plan('MANAGED_COPY_PLAN_UNSUPPORTED');
  return compiled;
}
/** Pure historical integrity. Fresh facts and actual owner authority remain
 * mandatory before any mutation; opaque compiler content hashes are replayed. */
export function decodeWorkspaceOperationManagedCopyPlanV4(input: unknown): WorkspaceOperationManagedCopyPlanV4 {
  const value = managedCopyV4Capture(input) as WorkspaceOperationManagedCopyPlanV4;
  managedCopyV4Exact(value, ['version', 'kind', 'executionReady', 'readiness', 'sourceScope', 'destinationScope', 'selections',
    'sourceEvidence', 'destinationEvidence', 'nativePathPlan', 'compilerPlanProof', 'finalGraphProof',
    'cloneRequirements', 'sceneCopyRequirements', 'planId', 'integrityProof']);
  if (value.version !== 4 || value.kind !== 'native-copy' || value.executionReady !== false
    || ![value.planId, value.integrityProof, value.compilerPlanProof, value.finalGraphProof].every(managedCopyV4Digest)) return rejectManagedCopyV4Plan();
  const source = decodeWorkspaceOperationCopySourceEvidenceV4(value.sourceEvidence), destination = decodeWorkspaceOperationCopySourceEvidenceV4(value.destinationEvidence);
  if (!equal(source.workspaceScope, parseWorkspaceOperationJobScope(value.sourceScope))
    || !equal(destination.workspaceScope, parseWorkspaceOperationJobScope(value.destinationScope))) return rejectManagedCopyV4Plan();
  const selections = managedCopyV4Selections(value.selections), originals = managedCopyV4Snapshots(source, destination);
  const paths = managedCopyV4PathPlan(value.sourceScope, value.destinationScope, selections, originals);
  if (!equal(paths, value.nativePathPlan)) return rejectManagedCopyV4Plan();
  const clones = assertNativeCopyCloneRequirements(originals[0], value.destinationScope, selections, paths, value.cloneRequirements);
  const scenes = managedCopyV4SceneRequirements(source, value.destinationScope, paths);
  if (!equal(scenes, value.sceneCopyRequirements) || value.readiness !== (clones.length || scenes.length ? 'requires-provider-publication' : 'ready')
    || managedCopyV4PlanId(value) !== value.planId) return rejectManagedCopyV4Plan();
  const { integrityProof, ...body } = value;
  if (proof(body) !== integrityProof) return rejectManagedCopyV4Plan();
  return freezeManagedCopyV4Plan(value);
}
/** Strict additive dispatch. Historical version 3 keeps its original decoder. */
export function decodeWorkspaceOperationAnyManagedCopyPlan(input: unknown): WorkspaceOperationAnyManagedCopyPlan {
  return managedCopyV4Field(input, 'version') === 4 ? decodeWorkspaceOperationManagedCopyPlanV4(input)
    : decodeWorkspaceOperationManagedCopyPlan(input);
}
export type WorkspaceManagedCopyPlanV4Input = {
  sourceScope: WorkspaceOperationBatchScope; destinationScope: WorkspaceOperationBatchScope;
  selections: readonly WorkspaceOperationNativeCopySelection[];
  sourceObservation: WorkspaceLinkSourceAuthorityObservation; destinationObservation: WorkspaceLinkSourceAuthorityObservation;
};
export function createWorkspaceOperationManagedCopyPlanV4(input: WorkspaceManagedCopyPlanV4Input): WorkspaceOperationManagedCopyPlanV4 {
  managedCopyV4Exact(input, ['sourceScope', 'destinationScope', 'selections', 'sourceObservation', 'destinationObservation']);
  const sourceWorkspace = managedCopyV4Field(managedCopyV4Field(input, 'sourceScope'), 'workspace');
  const destinationWorkspace = managedCopyV4Field(managedCopyV4Field(input, 'destinationScope'), 'workspace');
  if (types.isProxy(sourceWorkspace) || types.isProxy(destinationWorkspace)) return rejectManagedCopyV4Plan();
  const sourceScope = captureWorkspaceOperationJobScope(sourceWorkspace as WorkspaceOperationBatchScope['workspace']);
  const destinationScope = captureWorkspaceOperationJobScope(destinationWorkspace as WorkspaceOperationBatchScope['workspace']);
  const selections = managedCopyV4Selections(managedCopyV4Field(input, 'selections'));
  const sourceObservation = managedCopyV4Field(input, 'sourceObservation') as WorkspaceLinkSourceAuthorityObservation;
  const destinationObservation = managedCopyV4Field(input, 'destinationObservation') as WorkspaceLinkSourceAuthorityObservation;
  const source = captureWorkspaceOperationCopySourceEvidenceV4(sourceScope, sourceObservation);
  const destination = captureWorkspaceOperationCopySourceEvidenceV4(destinationScope, destinationObservation);
  const originals = managedCopyV4Snapshots(source, destination), paths = managedCopyV4PathPlan(sourceScope, destinationScope, selections, originals);
  const compiled = managedCopyV4Compiler(sourceScope, destinationScope, selections, originals, sourceObservation, destinationObservation);
  const scenes = managedCopyV4SceneRequirements(source, destinationScope, paths);
  const body = { version: 4 as const, kind: 'native-copy' as const, executionReady: false as const,
    readiness: compiled.cloneRequirements.length || scenes.length ? 'requires-provider-publication' as const : 'ready' as const,
    sourceScope, destinationScope, selections, sourceEvidence: source, destinationEvidence: destination,
    nativePathPlan: paths, compilerPlanProof: compiled.planId, finalGraphProof: compiled.finalGraphProof!,
    cloneRequirements: compiled.cloneRequirements, sceneCopyRequirements: scenes };
  const planned = { ...body, planId: managedCopyV4PlanId(body) };
  return decodeWorkspaceOperationManagedCopyPlanV4({ ...planned, integrityProof: proof(planned) });
}
/** Recompile the complete original graph against fresh provider facts. Native
 * projection/checkpoint clocks may advance; Raw bytes and FSI remain strict. */
export function assertWorkspaceOperationManagedCopyPlanV4Current(plan: WorkspaceOperationManagedCopyPlanV4, input: {
  sourceScope: WorkspaceOperationJobScope; destinationScope: WorkspaceOperationJobScope;
  sourceObservation: WorkspaceLinkSourceAuthorityObservation; destinationObservation: WorkspaceLinkSourceAuthorityObservation;
}): NativeMixedReadBatchPlanV3 {
  const original = decodeWorkspaceOperationManagedCopyPlanV4(plan);
  managedCopyV4Exact(input, ['sourceScope', 'destinationScope', 'sourceObservation', 'destinationObservation']);
  const sourceScope = parseWorkspaceOperationJobScope(managedCopyV4Capture(input.sourceScope));
  const destinationScope = parseWorkspaceOperationJobScope(managedCopyV4Capture(input.destinationScope));
  if (!equal(sourceScope, original.sourceScope) || !equal(destinationScope, original.destinationScope)) return rejectManagedCopyV4Plan('MANAGED_COPY_PLAN_CHANGED');
  const source = captureWorkspaceOperationCopySourceEvidenceV4(sourceScope, input.sourceObservation);
  const destination = captureWorkspaceOperationCopySourceEvidenceV4(destinationScope, input.destinationObservation);
  if (source.semanticProof !== original.sourceEvidence.semanticProof || destination.semanticProof !== original.destinationEvidence.semanticProof) return rejectManagedCopyV4Plan('MANAGED_COPY_PLAN_CHANGED');
  const compiled = managedCopyV4Compiler(sourceScope, destinationScope, original.selections,
    managedCopyV4Snapshots(original.sourceEvidence, original.destinationEvidence), input.sourceObservation, input.destinationObservation);
  if (compiled.planId !== original.compilerPlanProof || compiled.finalGraphProof !== original.finalGraphProof
    || !equal(compiled.cloneRequirements, original.cloneRequirements)) return rejectManagedCopyV4Plan('MANAGED_COPY_PLAN_CHANGED');
  return freezeManagedCopyV4Plan(compiled);
}

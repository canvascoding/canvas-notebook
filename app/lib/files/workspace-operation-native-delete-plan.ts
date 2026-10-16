import 'server-only';

import { isDeepStrictEqual } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
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
function validateGraph(graph: NativeMixedBatchPlan, workspaceId: string, sourcePath: string): void {
  if (!graph || typeof graph !== 'object' || ['issues', 'cloneRequirements', 'steps', 'requests', 'snapshotProofs',
    'documentEvidence', 'finalNamespace', 'finalEdges', 'requiredCoordinatorBindings'].some(key => !Array.isArray(graph[key as keyof NativeMixedBatchPlan]))) fail();
  const { planId, ...body } = graph;
  if (graph.contractVersion !== 2 || graph.compilerVersion !== 1 || graph.readiness !== 'ready' || graph.executionReady !== false
    || graph.issues.length || graph.cloneRequirements.length || graph.steps.length !== 1 || graph.requests.length !== 1
    || graph.steps[0].linkIntents.length || graph.steps[0].namespaceEffects.length !== 1 || !graph.finalGraphProof
    || nativeLinkJsonProof(body) !== planId) fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
  const request = graph.requests[0], effect = graph.steps[0].namespaceEffects[0];
  if (!isDeepStrictEqual(request, { kind: 'delete', sourceWorkspaceId: workspaceId, destinationWorkspaceId: workspaceId,
    selections: [{ sourcePath }] }) || !isDeepStrictEqual(graph.steps[0].request, request)
    || effect.sourceWorkspaceId !== workspaceId || effect.sourcePath !== sourcePath || effect.destinationPath !== null) fail();
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
    validateGraph(value.nativeGraphPlan, value.workspaceId, source.path);
    const originalSnapshot = snapshot(evidence);
    // Historical DTOs must prove their zero-link-effect claim independently of
    // their supplied compiler self-hash. Reuse the actual native graph planner.
    const deletePlan = createWorkspaceNativeFileOperationPlan({ kind: 'delete', sourceWorkspaceId: value.workspaceId,
      destinationWorkspaceId: value.workspaceId, selections: [{ sourcePath: source.path }], snapshots: [originalSnapshot] });
    if (deletePlan.readiness !== 'ready' || deletePlan.issues.length || deletePlan.mutations.length
      || !isDeepStrictEqual(deletePlan.pathMappings, [{ source, destinationPath: '', destinationWorkspaceId: value.workspaceId }])) {
      fail('NATIVE_DELETE_PLAN_UNSUPPORTED');
    }
    const diagnostic = compatibility(originalSnapshot);
    if (!isDeepStrictEqual(value.coverage, diagnostic.coverage) || !isDeepStrictEqual(value.linkAssessment, diagnostic.linkAssessment)) fail();
    if (!isDeepStrictEqual(value.nativeGraphPlan.snapshotProofs, [{ workspaceId: value.workspaceId, proof: originalSnapshot.snapshotProof }])
      || !isDeepStrictEqual(value.nativeGraphPlan.documentEvidence.map(entry => entry.inventory).sort((a,b) => a.document.documentId.localeCompare(b.document.documentId)),
        originalSnapshot.documents.toSorted((a,b) => a.document.documentId.localeCompare(b.document.documentId)))) fail();
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
  validateGraph(nativeGraphPlan, sourceEvidence.stage.workspaceId, source.path);
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
  const graph = compileWorkspaceNativeMixedBatch({ snapshots: [snapshot(observation)], states: observation.privateNativeStates,
    requests: original.nativeGraphPlan.requests });
  validateGraph(graph, original.workspaceId, original.nativeTarget.path);
}

import 'server-only';

import { isDeepStrictEqual as equal, types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { FilePlanV5, WorkspaceMixedHtmlLinkSnapshotV5 } from '../markdown/workspace-link-contract-v5';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { createWorkspaceMixedHtmlFileOperationPlanV5 } from '../markdown/workspace-native-file-operation-planner';
import { compileWorkspaceMixedHtmlBatchV5, type NativeMixedHtmlBatchPlanV5 } from '../markdown/workspace-native-mixed-batch-compiler';
import type { WorkspaceOperationBatchScope, WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { type WorkspaceOperationNativeCopySelection } from './workspace-operation-native-copy-plan';
import type { WorkspaceSceneCopyRequirement } from './workspace-operation-managed-copy-plan';
import { captureWorkspaceOperationMixedSourceEvidenceV5, decodeWorkspaceOperationMixedSourceEvidenceV5,
  workspaceOperationMixedSourceSnapshotV5,
  type WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';

/** Additive Copy HTML-read cohort. E5 and Compiler5 remain genuine facts;
 * selected raw imports and all Scene providers require their own later profile. */
export type WorkspaceOperationManagedCopyPlanV6 = Readonly<{
  version: 6; kind: 'native-copy'; executionReady: false;
  readiness: 'ready' | 'requires-provider-publication';
  sourceScope: WorkspaceOperationJobScope; destinationScope: WorkspaceOperationJobScope;
  selections: readonly WorkspaceOperationNativeCopySelection[];
  sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5; destinationEvidence: WorkspaceOperationMixedSourceEvidenceV5;
  nativePathPlan: FilePlanV5; compilerPlanProof: string; finalGraphProof: string;
  cloneRequirements: NativeMixedHtmlBatchPlanV5['cloneRequirements']; sceneCopyRequirements: readonly WorkspaceSceneCopyRequirement[];
  planId: string; integrityProof: string;
}>;
export class WorkspaceOperationManagedCopyPlanV6Error extends Error {
  readonly status = 409;
  constructor(readonly code: 'MANAGED_COPY_PLAN_INVALID' | 'MANAGED_COPY_PLAN_CHANGED' | 'MANAGED_COPY_PLAN_UNSUPPORTED'
    | 'MANAGED_COPY_PLAN_IMPORT_REQUIRED') {
    super(code === 'MANAGED_COPY_PLAN_IMPORT_REQUIRED'
      ? 'This Markdown file needs to be imported into the notebook before it can be copied.' : code);
    this.name = 'WorkspaceOperationManagedCopyPlanV6Error';
  }
}
function rejectHtmlCopyV6Plan(code: WorkspaceOperationManagedCopyPlanV6Error['code'] = 'MANAGED_COPY_PLAN_INVALID'): never {
  throw new WorkspaceOperationManagedCopyPlanV6Error(code);
}
function htmlCopyV6Digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function htmlCopyV6Capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, () => rejectHtmlCopyV6Plan(), 16 * 1024 * 1024);
}
function htmlCopyV6Field(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return rejectHtmlCopyV6Plan();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return rejectHtmlCopyV6Plan();
  return descriptor.value;
}
function htmlCopyV6Exact(input: unknown, keys: readonly string[]): void {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length) return rejectHtmlCopyV6Plan();
  for (const key of keys) htmlCopyV6Field(input, key);
}
function freezeHtmlCopyV6Plan<T>(input: T): T {
  if (input && typeof input === 'object') {
    for (const child of Object.values(input)) freezeHtmlCopyV6Plan(child);
    Object.freeze(input);
  }
  return input;
}
function htmlCopyV6Selections(input: unknown): readonly WorkspaceOperationNativeCopySelection[] {
  const rows = htmlCopyV6Capture(input);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 1000) return rejectHtmlCopyV6Plan();
  for (const row of rows) {
    htmlCopyV6Exact(row, ['sourcePath', 'destinationPath']);
    if (![row.sourcePath, row.destinationPath].every(value => isCanonicalAdmissionPath(value)
      && Buffer.byteLength(value) <= 4096 && value.split('/').length <= 33)) return rejectHtmlCopyV6Plan();
  }
  return rows;
}
function htmlCopyV6Snapshots(source: WorkspaceOperationMixedSourceEvidenceV5,
  destination: WorkspaceOperationMixedSourceEvidenceV5): WorkspaceMixedHtmlLinkSnapshotV5[] {
  if (source.workspaceScope.workspaceId === destination.workspaceScope.workspaceId && !equal(source, destination)) return rejectHtmlCopyV6Plan();
  return (source.workspaceScope.workspaceId === destination.workspaceScope.workspaceId ? [source] : [source, destination])
    .map(evidence => workspaceOperationMixedSourceSnapshotV5(evidence));
}
function htmlCopyV6Request(source: WorkspaceOperationJobScope, destination: WorkspaceOperationJobScope,
  selections: readonly WorkspaceOperationNativeCopySelection[]) {
  return { kind: 'copy' as const, sourceWorkspaceId: source.workspaceId, destinationWorkspaceId: destination.workspaceId,
    selections: selections.map(selection => ({ ...selection })) };
}
function htmlCopyV6PathPlan(source: WorkspaceOperationJobScope, destination: WorkspaceOperationJobScope,
  selections: readonly WorkspaceOperationNativeCopySelection[], sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5,
  destinationEvidence: WorkspaceOperationMixedSourceEvidenceV5): FilePlanV5 {
  const plan = createWorkspaceMixedHtmlFileOperationPlanV5({ ...htmlCopyV6Request(source, destination, selections), sourceEvidence,
    ...(source.workspaceId === destination.workspaceId ? {} : { destinationEvidence }) });
  if (plan.issues.some(issue => issue.code === 'physical-source-import-required')) return rejectHtmlCopyV6Plan('MANAGED_COPY_PLAN_IMPORT_REQUIRED');
  if (plan.readiness !== 'ready' || plan.issues.length || !plan.pathMappings.length
    || plan.pathMappings.some(mapping => !isCanonicalAdmissionPath(mapping.destinationPath)
      || Buffer.byteLength(mapping.destinationPath) > 4096 || mapping.destinationPath.split('/').length > 33)
    || plan.mutations.some(recipe => recipe.action !== 'rewrite' || recipe.nextValue === null || recipe.cloneSelection === null
      || recipe.source.workspaceId !== source.workspaceId || recipe.destinationWorkspaceId !== destination.workspaceId)) return rejectHtmlCopyV6Plan('MANAGED_COPY_PLAN_UNSUPPORTED');
  return plan;
}
function htmlCopyV6CloneRequirements(original: Pick<WorkspaceMixedHtmlLinkSnapshotV5, 'workspaceId' | 'namespace' | 'documents'>, destination: WorkspaceOperationJobScope,
  selected: readonly WorkspaceOperationNativeCopySelection[], planned: Pick<FilePlanV5, 'pathMappings'>,
  supplied: NativeMixedHtmlBatchPlanV5['cloneRequirements']): NativeMixedHtmlBatchPlanV5['cloneRequirements'] {
  if (!Array.isArray(supplied)) rejectHtmlCopyV6Plan();
  const result: NativeMixedHtmlBatchPlanV5['cloneRequirements'] = [];
  const mapped = new Map(planned.pathMappings.map(mapping => [mapping.source.path, mapping]));
  const inventories = new Map(original.documents.map(inventory => [inventory.document.path, inventory]));
  for (const selection of selected) for (const entry of original.namespace) {
    if (entry.path !== selection.sourcePath && !entry.path.startsWith(`${selection.sourcePath}/`)) continue;
    const inventory = inventories.get(entry.path), mapping = mapped.get(entry.path);
    if (!inventory || !mapping) continue;
    const suppliedRow = supplied[result.length];
    if (!suppliedRow || !htmlCopyV6Digest(suppliedRow.sourceContentBasisProof)) rejectHtmlCopyV6Plan();
    const sourceEntityKey = proof({ workspaceId: original.workspaceId, identity: entry.identity });
    const entityKey = proof({ requestIndex: 0, sourceEntityKey,
      destinationWorkspaceId: destination.workspaceId, destinationPath: mapping.destinationPath });
    result.push({ entityKey, sourceEntityKey, requestIndex: 0, sourceWorkspaceId: original.workspaceId, sourcePath: entry.path,
      sourceContentBasisProof: suppliedRow.sourceContentBasisProof, applicability: 'requires-fresh-clone-receipt-and-inventory',
      linkBindings: inventory.links.map(link => {
        const sourceVirtualLinkKey = proof({ entityKey: sourceEntityKey, linkId: link.id });
        return { virtualLinkKey: proof({ entityKey, sourceVirtualLinkKey }), sourceVirtualLinkKey, originEvidenceLinkId: link.id };
      }) });
  }
  if (!equal(result, supplied)) rejectHtmlCopyV6Plan();
  return result;
}
function htmlCopyV6SceneRequirements(source: WorkspaceOperationMixedSourceEvidenceV5, destination: WorkspaceOperationJobScope,
  paths: FilePlanV5): WorkspaceSceneCopyRequirement[] {
  void destination;
  // Ordinary physical assets need no native clone or import. The actual E5
  // read-source tables distinguish selected raw Markdown/HTML from those
  // assets; directories are checked through every selected descendant mapping.
  // Scene providers and raw-to-native imports remain outside this cohort.
  const rawSources = new Set([...source.physicalSources4, ...source.physicalHtmlSources4].map(entry => entry.path));
  if (source.namespace.some(entry => entry.provider === 'excalidraw')
    || paths.pathMappings.some(mapping => mapping.source.kind === 'file' && rawSources.has(mapping.source.path))) {
    return rejectHtmlCopyV6Plan('MANAGED_COPY_PLAN_UNSUPPORTED');
  }
  return [];
}
function htmlCopyV6PlanId(value: Pick<WorkspaceOperationManagedCopyPlanV6,
  'sourceScope' | 'destinationScope' | 'selections' | 'sourceEvidence' | 'destinationEvidence'>): string {
  return proof({ version: 6, kind: 'native-copy', sourceScope: value.sourceScope, destinationScope: value.destinationScope,
    selections: value.selections, sourceSemanticProof: value.sourceEvidence.semanticProof, destinationSemanticProof: value.destinationEvidence.semanticProof });
}
function htmlCopyV6Compiler(source: WorkspaceOperationJobScope, destination: WorkspaceOperationJobScope,
  selections: readonly WorkspaceOperationNativeCopySelection[], sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5,
  destinationEvidence: WorkspaceOperationMixedSourceEvidenceV5, sourceObservation: WorkspaceLinkSourceAuthorityObservation, destinationObservation: WorkspaceLinkSourceAuthorityObservation): NativeMixedHtmlBatchPlanV5 {
  const compiled = compileWorkspaceMixedHtmlBatchV5({ sourceEvidence,
    ...(source.workspaceId === destination.workspaceId ? {} : { destinationEvidence }), requests: [htmlCopyV6Request(source, destination, selections)],
    states: source.workspaceId === destination.workspaceId ? sourceObservation.privateNativeStates
      : [...sourceObservation.privateNativeStates, ...destinationObservation.privateNativeStates] });
  if (compiled.issues.some(issue => issue.code === 'physical-source-import-required')) return rejectHtmlCopyV6Plan('MANAGED_COPY_PLAN_IMPORT_REQUIRED');
  if (compiled.issues.length || compiled.executionReady !== false || !htmlCopyV6Digest(compiled.planId) || !htmlCopyV6Digest(compiled.finalGraphProof)
    || compiled.readiness !== (compiled.cloneRequirements.length ? 'requires-clone-rebinding' : 'ready')) return rejectHtmlCopyV6Plan('MANAGED_COPY_PLAN_UNSUPPORTED');
  return compiled;
}
/** Pure historical integrity. Fresh facts and actual owner authority remain
 * mandatory before any mutation; opaque compiler content hashes are replayed. */
export function decodeWorkspaceOperationManagedCopyPlanV6(input: unknown): WorkspaceOperationManagedCopyPlanV6 {
  const value = htmlCopyV6Capture(input) as WorkspaceOperationManagedCopyPlanV6;
  htmlCopyV6Exact(value, ['version', 'kind', 'executionReady', 'readiness', 'sourceScope', 'destinationScope', 'selections',
    'sourceEvidence', 'destinationEvidence', 'nativePathPlan', 'compilerPlanProof', 'finalGraphProof',
    'cloneRequirements', 'sceneCopyRequirements', 'planId', 'integrityProof']);
  if (value.version !== 6 || value.kind !== 'native-copy' || value.executionReady !== false
    || ![value.planId, value.integrityProof, value.compilerPlanProof, value.finalGraphProof].every(htmlCopyV6Digest)) return rejectHtmlCopyV6Plan();
  const source = decodeWorkspaceOperationMixedSourceEvidenceV5(value.sourceEvidence), destination = decodeWorkspaceOperationMixedSourceEvidenceV5(value.destinationEvidence);
  if (!equal(source.workspaceScope, parseWorkspaceOperationJobScope(value.sourceScope))
    || !equal(destination.workspaceScope, parseWorkspaceOperationJobScope(value.destinationScope))) return rejectHtmlCopyV6Plan();
  const selections = htmlCopyV6Selections(value.selections), originals = htmlCopyV6Snapshots(source, destination);
  const paths = htmlCopyV6PathPlan(value.sourceScope, value.destinationScope, selections, source, destination);
  if (!equal(paths, value.nativePathPlan)) return rejectHtmlCopyV6Plan();
  const clones = htmlCopyV6CloneRequirements(originals[0], value.destinationScope, selections, paths, value.cloneRequirements);
  const scenes = htmlCopyV6SceneRequirements(source, value.destinationScope, paths);
  if (destination.namespace.some(entry => entry.provider === 'excalidraw')) return rejectHtmlCopyV6Plan('MANAGED_COPY_PLAN_UNSUPPORTED');
  if (!equal(scenes, value.sceneCopyRequirements) || value.readiness !== (clones.length || scenes.length ? 'requires-provider-publication' : 'ready')
    || htmlCopyV6PlanId(value) !== value.planId) return rejectHtmlCopyV6Plan();
  const { integrityProof, ...body } = value;
  if (proof(body) !== integrityProof) return rejectHtmlCopyV6Plan();
  return freezeHtmlCopyV6Plan(value);
}
export type WorkspaceManagedCopyPlanV6Input = {
  sourceScope: WorkspaceOperationBatchScope; destinationScope: WorkspaceOperationBatchScope;
  selections: readonly WorkspaceOperationNativeCopySelection[];
  sourceObservation: WorkspaceLinkSourceAuthorityObservation; destinationObservation: WorkspaceLinkSourceAuthorityObservation;
};
export function createWorkspaceOperationManagedCopyPlanV6(input: WorkspaceManagedCopyPlanV6Input): WorkspaceOperationManagedCopyPlanV6 {
  htmlCopyV6Exact(input, ['sourceScope', 'destinationScope', 'selections', 'sourceObservation', 'destinationObservation']);
  const sourceWorkspace = htmlCopyV6Field(htmlCopyV6Field(input, 'sourceScope'), 'workspace');
  const destinationWorkspace = htmlCopyV6Field(htmlCopyV6Field(input, 'destinationScope'), 'workspace');
  if (types.isProxy(sourceWorkspace) || types.isProxy(destinationWorkspace)) return rejectHtmlCopyV6Plan();
  const sourceScope = captureWorkspaceOperationJobScope(sourceWorkspace as WorkspaceOperationBatchScope['workspace']);
  const destinationScope = captureWorkspaceOperationJobScope(destinationWorkspace as WorkspaceOperationBatchScope['workspace']);
  const selections = htmlCopyV6Selections(htmlCopyV6Field(input, 'selections'));
  const sourceObservation = htmlCopyV6Field(input, 'sourceObservation') as WorkspaceLinkSourceAuthorityObservation;
  const destinationObservation = htmlCopyV6Field(input, 'destinationObservation') as WorkspaceLinkSourceAuthorityObservation;
  const source = captureWorkspaceOperationMixedSourceEvidenceV5(sourceScope, sourceObservation);
  const destination = captureWorkspaceOperationMixedSourceEvidenceV5(destinationScope, destinationObservation);
  htmlCopyV6Snapshots(source, destination);
  const paths = htmlCopyV6PathPlan(sourceScope, destinationScope, selections, source, destination);
  const compiled = htmlCopyV6Compiler(sourceScope, destinationScope, selections, source, destination, sourceObservation, destinationObservation);
  const scenes = htmlCopyV6SceneRequirements(source, destinationScope, paths);
  if (destination.namespace.some(entry => entry.provider === 'excalidraw')) return rejectHtmlCopyV6Plan('MANAGED_COPY_PLAN_UNSUPPORTED');
  const body = { version: 6 as const, kind: 'native-copy' as const, executionReady: false as const,
    readiness: compiled.cloneRequirements.length || scenes.length ? 'requires-provider-publication' as const : 'ready' as const,
    sourceScope, destinationScope, selections, sourceEvidence: source, destinationEvidence: destination,
    nativePathPlan: paths, compilerPlanProof: compiled.planId, finalGraphProof: compiled.finalGraphProof!,
    cloneRequirements: compiled.cloneRequirements, sceneCopyRequirements: scenes };
  const planned = { ...body, planId: htmlCopyV6PlanId(body) };
  return decodeWorkspaceOperationManagedCopyPlanV6({ ...planned, integrityProof: proof(planned) });
}
/** Recompile the complete original graph against fresh provider facts. Native
 * projection/checkpoint clocks may advance; Raw bytes and FSI remain strict. */
export function assertWorkspaceOperationManagedCopyPlanV6Current(plan: WorkspaceOperationManagedCopyPlanV6, input: {
  sourceScope: WorkspaceOperationJobScope; destinationScope: WorkspaceOperationJobScope;
  sourceObservation: WorkspaceLinkSourceAuthorityObservation; destinationObservation: WorkspaceLinkSourceAuthorityObservation;
}): NativeMixedHtmlBatchPlanV5 {
  const original = decodeWorkspaceOperationManagedCopyPlanV6(plan);
  htmlCopyV6Exact(input, ['sourceScope', 'destinationScope', 'sourceObservation', 'destinationObservation']);
  const sourceScope = parseWorkspaceOperationJobScope(htmlCopyV6Capture(input.sourceScope));
  const destinationScope = parseWorkspaceOperationJobScope(htmlCopyV6Capture(input.destinationScope));
  if (!equal(sourceScope, original.sourceScope) || !equal(destinationScope, original.destinationScope)) return rejectHtmlCopyV6Plan('MANAGED_COPY_PLAN_CHANGED');
  const source = captureWorkspaceOperationMixedSourceEvidenceV5(sourceScope, input.sourceObservation);
  const destination = captureWorkspaceOperationMixedSourceEvidenceV5(destinationScope, input.destinationObservation);
  if (source.semanticProof !== original.sourceEvidence.semanticProof || destination.semanticProof !== original.destinationEvidence.semanticProof) return rejectHtmlCopyV6Plan('MANAGED_COPY_PLAN_CHANGED');
  const compiled = htmlCopyV6Compiler(sourceScope, destinationScope, original.selections,
    original.sourceEvidence, original.destinationEvidence, input.sourceObservation, input.destinationObservation);
  if (compiled.planId !== original.compilerPlanProof || compiled.finalGraphProof !== original.finalGraphProof
    || !equal(compiled.cloneRequirements, original.cloneRequirements)) return rejectHtmlCopyV6Plan('MANAGED_COPY_PLAN_CHANGED');
  return freezeHtmlCopyV6Plan(compiled);
}

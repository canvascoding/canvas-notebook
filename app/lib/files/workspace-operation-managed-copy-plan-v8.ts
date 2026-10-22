import 'server-only';
import { decodeWorkspaceOperationManagedCopyPlanV7, type WorkspaceOperationManagedCopyPlanV7 } from './workspace-operation-managed-copy-plan-v7';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { prepareMarkdownFileImport } from '../collaboration/markdown-file-import';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { buildWorkspaceMixedHtmlLinkGraphV5 } from '../markdown/workspace-native-link-graph';
import { compileWorkspaceMixedSelectedHtmlImportCopyBatchV6, type NativeMixedHtmlImportCopyBatchPlanV6,
  type NativeMixedRawImportRequirementV6 } from '../markdown/workspace-native-mixed-batch-compiler';
import { createWorkspaceMixedHtmlFileOperationPlanV5, createWorkspaceMixedHtmlImportCopyFileOperationPlanV6, type WorkspaceMixedHtmlImportCopyFilePlanV6 } from '../markdown/workspace-native-file-operation-planner';
import { captureWorkspaceOperationMixedSourceEvidenceV5, decodeWorkspaceOperationMixedSourceEvidenceV5,
  workspaceOperationMixedSourceSnapshotV5, type WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';
import { captureRawHtmlSourceBindingV2, decodeRawHtmlSourceBindingV2, type RawHtmlSourceBindingV2 } from '../markdown/workspace-raw-html-source-binding-v2';
import type { OriginalPhysicalLinkInventory } from '../markdown/workspace-physical-link-inventory';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import type { WorkspaceOperationBatchScope, WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import type { FilePlanV5, WorkspaceMixedHtmlLinkSnapshotV5 } from '../markdown/workspace-link-contract-v5';
import type { WorkspaceSceneCopyRequirement } from './workspace-operation-managed-copy-plan';
import { type WorkspaceOperationNativeCopySelection } from './workspace-operation-native-copy-plan';

export type RawCopyImportPreparationV1 = Readonly<{ version: 1;
  representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks'; newlineStyle: 'lf' | 'crlf'; hasBom: boolean;
  sourceHash: string; sourceBytes: number; canonicalHash: string }>;
export type ManagedCopyRawImportRequirementV8 = NativeMixedRawImportRequirementV6 & Readonly<{ preparation: RawCopyImportPreparationV1; sourceBinding: RawHtmlSourceBindingV2;
  ordinaryRequirement: NativeMixedHtmlImportCopyBatchPlanV6['rawImportRequirements'][number] }>;
export type WorkspaceOperationManagedCopyPlanV8 = Readonly<{
  version: 8; kind: 'native-copy'; executionReady: false; readiness: 'ready' | 'requires-provider-publication';
  sourceScope: WorkspaceOperationJobScope; destinationScope: WorkspaceOperationJobScope;
  selections: readonly WorkspaceOperationNativeCopySelection[];
  sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5; destinationEvidence: WorkspaceOperationMixedSourceEvidenceV5;
  nativePathPlan: WorkspaceMixedHtmlImportCopyFilePlanV6;
  compilation: NativeMixedHtmlImportCopyBatchPlanV6; compilerPlanProof: string; finalGraphProof: string;
  cloneRequirements: NativeMixedHtmlImportCopyBatchPlanV6['cloneRequirements'];
  rawImportRequirements: readonly ManagedCopyRawImportRequirementV8[];
  sceneCopyRequirements: readonly WorkspaceSceneCopyRequirement[]; planId: string; integrityProof: string;
}>;
export class WorkspaceOperationManagedCopyPlanV8Error extends Error {
  readonly status: 409 | 413;
  constructor(readonly code: 'MANAGED_COPY_PLAN_INVALID' | 'MANAGED_COPY_PLAN_CHANGED' | 'MANAGED_COPY_PLAN_UNSUPPORTED' | 'MANAGED_COPY_PLAN_TOO_LARGE') {
    super(code); this.name = 'WorkspaceOperationManagedCopyPlanV8Error'; this.status = code === 'MANAGED_COPY_PLAN_TOO_LARGE' ? 413 : 409;
  }
}
const rawCopyV8Fail = (code: WorkspaceOperationManagedCopyPlanV8Error['code'] = 'MANAGED_COPY_PLAN_INVALID'): never => {
  throw new WorkspaceOperationManagedCopyPlanV8Error(code);
};
function rawCopyV8Capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => rawCopyV8Fail(reason === 'too-large'
    ? 'MANAGED_COPY_PLAN_TOO_LARGE' : 'MANAGED_COPY_PLAN_INVALID'), 16 * 1024 * 1024);
}
function rawCopyV8Field(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return rawCopyV8Fail();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return rawCopyV8Fail(); return descriptor.value;
}
function rawCopyV8Exact(input: unknown, keys: readonly string[]): void {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Reflect.ownKeys(input).length !== keys.length) return rawCopyV8Fail();
  for (const key of keys) rawCopyV8Field(input, key);
}
function rawCopyV8Freeze<T>(input: T): T {
  if (input && typeof input === 'object') { for (const child of Object.values(input)) rawCopyV8Freeze(child); Object.freeze(input); } return input;
}
function rawCopyV8Digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function rawCopyV8PlanId(value: Pick<WorkspaceOperationManagedCopyPlanV8,
  'sourceScope' | 'destinationScope' | 'selections' | 'sourceEvidence' | 'destinationEvidence' | 'rawImportRequirements'>): string {
  return proof({ version: 8, kind: 'native-copy', sourceScope: value.sourceScope, destinationScope: value.destinationScope,
    selections: value.selections, sourceSemanticProof: value.sourceEvidence.semanticProof,
    destinationSemanticProof: value.destinationEvidence.semanticProof, rawImportRequirements: value.rawImportRequirements });
}
function rawCopyV8Clones(original: Pick<WorkspaceMixedHtmlLinkSnapshotV5, 'workspaceId' | 'namespace' | 'documents'>, destination: WorkspaceOperationJobScope,
  selected: readonly WorkspaceOperationNativeCopySelection[], planned: Pick<FilePlanV5, 'pathMappings'>,
  supplied: NativeMixedHtmlImportCopyBatchPlanV6['cloneRequirements']): NativeMixedHtmlImportCopyBatchPlanV6['cloneRequirements'] {
  if (!Array.isArray(supplied)) rawCopyV8Fail();
  const result: NativeMixedHtmlImportCopyBatchPlanV6['cloneRequirements'] = [];
  const mapped = new Map(planned.pathMappings.map(mapping => [mapping.source.path, mapping]));
  const inventories = new Map(original.documents.map(inventory => [inventory.document.path, inventory]));
  for (const selection of selected) for (const entry of original.namespace) {
    if (entry.path !== selection.sourcePath && !entry.path.startsWith(`${selection.sourcePath}/`)) continue;
    const inventory = inventories.get(entry.path), mapping = mapped.get(entry.path);
    if (!inventory || !mapping) continue;
    const suppliedRow = supplied[result.length];
    if (!suppliedRow || !rawCopyV8Digest(suppliedRow.sourceContentBasisProof)) rawCopyV8Fail();
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
  if (!equal(result, supplied)) rawCopyV8Fail();
  return result;
}

function rawCopyV8Scenes(source: WorkspaceOperationMixedSourceEvidenceV5, destination: WorkspaceOperationJobScope,
  paths: WorkspaceMixedHtmlImportCopyFilePlanV6): WorkspaceSceneCopyRequirement[] {
  void destination; void paths;
  if (source.namespace.some(entry => entry.provider === 'excalidraw')) return rawCopyV8Fail('MANAGED_COPY_PLAN_UNSUPPORTED');
  return [];
}
/** No fake identity is needed to compute the actual import policy. Scratch Yjs
 * clocks are deliberately excluded; Stage9 must repeat this over original bytes. */
function rawCopyV8PrepareRequirements(compilation: NativeMixedHtmlImportCopyBatchPlanV6, sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5,
  observation: WorkspaceLinkSourceAuthorityObservation): ManagedCopyRawImportRequirementV8[] {
  const sources = rawCopyV8Field(rawCopyV8Field(observation, 'stage'), 'sources');
  if (types.isProxy(sources) || !Array.isArray(sources)) return rawCopyV8Fail();
  return compilation.rawImportRequirements.map(requirement => {
    const source = sources.find(value => rawCopyV8Field(value, 'kind') === 'physical'
      && rawCopyV8Field(rawCopyV8Field(value, 'inventory'), 'path') === requirement.sourcePath);
    const inventory = rawCopyV8Field(source, 'inventory'), bytes = rawCopyV8Field(inventory, 'originalBytes');
    const typed = Object.getPrototypeOf(Uint8Array.prototype), getLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
    if (!bytes || typeof bytes !== 'object' || types.isProxy(bytes) || !ArrayBuffer.isView(bytes)
      || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(bytes))) return rawCopyV8Fail();
    const length = getLength.call(bytes) as number;
    if (length !== requirement.physical.byteLength || length > 4 * 1024 * 1024) return rawCopyV8Fail('MANAGED_COPY_PLAN_TOO_LARGE');
    const copy = Buffer.alloc(length); Uint8Array.prototype.set.call(copy, bytes as Uint8Array);
    const source4 = sourceEvidence.physicalSources4.find(value => value.path === requirement.sourcePath);
    if (!source4) return rawCopyV8Fail();
    const sourceBinding = captureRawHtmlSourceBindingV2({ original: inventory as OriginalPhysicalLinkInventory, source4 });
    const prepared = prepareMarkdownFileImport(copy, { representation: 'auto' });
    if (prepared.sourceHash !== requirement.physical.byteHash || prepared.sourceBytes !== length) return rawCopyV8Fail('MANAGED_COPY_PLAN_CHANGED');
    return { ...requirement, physicalSourceProof: sourceBinding.original4.physicalSourceProof,
      importPolicy: { version: 1 as const, initialRepresentation: 'auto' as const, parserVersion: 4 as const },
      ordinaryRequirement: requirement, sourceBinding, preparation: { version: 1, representation: prepared.representation, newlineStyle: prepared.newlineStyle,
      hasBom: prepared.hasBom, sourceHash: prepared.sourceHash, sourceBytes: prepared.sourceBytes,
      canonicalHash: createHash('sha256').update(prepared.canonical, 'utf8').digest('hex') } };
  });
}
/** Historical data validation. Compiler native-content proofs remain opaque
 * without Stage records, exactly as prior profiles; before execution Stage9 MUST replay
 * the entire compiler with original native records and reparse every raw byte. */
function rawCopyV8Historical(value: WorkspaceOperationManagedCopyPlanV8): WorkspaceOperationManagedCopyPlanV8 {
  rawCopyV8Exact(value, ['version', 'kind', 'executionReady', 'readiness', 'sourceScope', 'destinationScope', 'selections', 'sourceEvidence',
    'destinationEvidence', 'nativePathPlan', 'compilation', 'compilerPlanProof', 'finalGraphProof', 'cloneRequirements', 'rawImportRequirements',
    'sceneCopyRequirements', 'planId', 'integrityProof']);
  if (value.version !== 8 || value.kind !== 'native-copy' || value.executionReady !== false) return rawCopyV8Fail();
  const source = decodeWorkspaceOperationMixedSourceEvidenceV5(value.sourceEvidence), destination = decodeWorkspaceOperationMixedSourceEvidenceV5(value.destinationEvidence);
  if (!equal(parseWorkspaceOperationJobScope(value.sourceScope), source.workspaceScope)
    || !equal(parseWorkspaceOperationJobScope(value.destinationScope), destination.workspaceScope)
    || value.sourceScope.workspaceId === value.destinationScope.workspaceId && !equal(source, destination)
    || !Array.isArray(value.selections) || !value.selections.length || value.selections.length > 1000) return rawCopyV8Fail();
  for (const selected of value.selections) {
    rawCopyV8Exact(selected, ['sourcePath', 'destinationPath']);
    if (![selected.sourcePath, selected.destinationPath].every(path => isCanonicalAdmissionPath(path)
      && Buffer.byteLength(path) <= 4096 && path.split('/').length <= 33)) return rawCopyV8Fail();
  }
  // The first real C2 profile is one physical Markdown file in one workspace.
  // Other operation families need their own concrete assessment and dispatch.
  const selectedSource = source.physicalSources4.find(row => row.path === value.selections[0]?.sourcePath);
  if (value.sourceScope.workspaceId !== value.destinationScope.workspaceId || value.selections.length !== 1
    || source.namespace.find(row => row.path === value.selections[0].sourcePath)?.kind !== 'file'
    || !selectedSource || !selectedSource.htmlInspection.occurrences.length) return rawCopyV8Fail('MANAGED_COPY_PLAN_UNSUPPORTED');
  const compiled = value.compilation;
  rawCopyV8Exact(compiled, ['contractVersion', 'compilerVersion', 'readiness', 'executionReady', 'requests', 'snapshotProofs', 'documentEvidence',
    'steps', 'cloneRequirements', 'rawImportRequirements', 'htmlAssessment', 'htmlAssessmentProof', 'sourceCoverage', 'finalNamespace', 'finalEdges', 'finalGraphProof', 'issues', 'requiredCoordinatorBindings', 'planId']);
  const { planId: compilerId, ...compilerBody } = compiled;
  if (compiled.contractVersion !== 6 || compiled.compilerVersion !== 1 || compiled.executionReady !== false || compiled.issues.length
    || !compiled.htmlAssessment.complete || compiled.htmlAssessment.blockers.length
    || !/^[a-f0-9]{64}$/u.test(compiled.htmlAssessmentProof) || !equal(compiled.sourceCoverage,
      (value.sourceScope.workspaceId === value.destinationScope.workspaceId ? [source] : [source, destination]).map(value => ({ workspaceId: value.workspaceScope.workspaceId, coverage: value.coverage })).sort((a,b) => a.workspaceId.localeCompare(b.workspaceId)))
    || compiled.requests.length !== 1 || compiled.steps.length !== 1 || proof(compilerBody) !== compilerId
    || compilerId !== value.compilerPlanProof || compiled.finalGraphProof !== value.finalGraphProof
    || ![value.compilerPlanProof, value.finalGraphProof, value.planId, value.integrityProof].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash))
    || !equal(compiled.requests[0], { kind: 'copy', sourceWorkspaceId: value.sourceScope.workspaceId,
      destinationWorkspaceId: value.destinationScope.workspaceId, selections: value.selections })
    || !equal(compiled.steps[0].request, compiled.requests[0]) || compiled.steps[0].requestIndex !== 0) return rawCopyV8Fail();
  rawCopyV8Exact(compiled.steps[0], ['requestIndex', 'request', 'beforeGraphProof', 'afterGraphProof', 'namespaceEffects', 'linkIntents', 'physicalLinkIntents']);
  if (!equal(compiled.requiredCoordinatorBindings, ['actor-session-request-review-and-current-authority', 'complete-current-namespace-and-native-graph',
    'kernel-lifecycle-fence-and-exact-registry-path-receipts', 'fresh-durable-native-states-and-targeted-inverse-receipts',
    'fresh-copy-identities-block-id-map-and-link-rebinding'])
    || compiled.readiness !== (compiled.rawImportRequirements.length ? 'requires-import-rebinding' : compiled.cloneRequirements.length ? 'requires-clone-rebinding' : 'ready')) return rawCopyV8Fail();
  for (const pin of compiled.snapshotProofs) rawCopyV8Exact(pin, ['workspaceId', 'proof']);
  for (const inventory of compiled.documentEvidence) rawCopyV8Exact(inventory, ['evidenceKey', 'inventory']);
  for (const effect of compiled.steps[0].namespaceEffects) rawCopyV8Exact(effect,
    ['entityKey', 'sourceEntityKey', 'sourceWorkspaceId', 'sourcePath', 'destinationWorkspaceId', 'destinationPath']);
  for (const intent of compiled.steps[0].linkIntents) rawCopyV8Exact(intent, ['virtualLinkKey', 'entityKey', 'originEvidenceLinkId', 'action',
    'expectedValue', 'nextValue', 'expectedTargetEntityKey', 'targetEntityKeyAfter', 'adapterCheck']);
  for (const intent of compiled.steps[0].physicalLinkIntents) rawCopyV8Exact(intent, ['virtualLinkKey', 'entityKey', 'physicalSourceProof',
    'physicalLinkId', 'action', 'expectedSourceLiteral', 'expectedTargetPathText', 'expectedTargetEntityKey', 'targetEntityKeyAfter',
    'targetPathAfter', 'fragment', 'alias', 'embed', 'adapterCheck']);
  for (const clone of compiled.cloneRequirements) {
    rawCopyV8Exact(clone, ['entityKey', 'sourceEntityKey', 'requestIndex', 'sourceWorkspaceId', 'sourcePath', 'sourceContentBasisProof', 'linkBindings', 'applicability']);
    for (const link of clone.linkBindings) rawCopyV8Exact(link, ['virtualLinkKey', 'sourceVirtualLinkKey', 'originEvidenceLinkId']);
  }
  for (const entity of compiled.finalNamespace) {
    rawCopyV8Exact(entity, ['entityKey', 'workspaceId', 'path', 'kind', 'binding', 'contentBasisProof', 'metadata',
      ...(Object.hasOwn(entity, 'physicalReadSource') ? ['physicalReadSource'] : [])]);
    if (entity.binding.kind === 'existing') rawCopyV8Exact(entity.binding, ['kind', 'namespaceEvidence', 'documentEvidenceKey']);
    else { rawCopyV8Exact(entity.binding, ['kind', 'sourceEntityKey', 'createdAtRequest']);
      if (!['unbound-copy', 'unbound-import'].includes(entity.binding.kind)) return rawCopyV8Fail(); }
    if (Object.hasOwn(entity, 'physicalReadSource')) rawCopyV8Exact(entity.physicalReadSource, ['physicalSourceProof']);
  }
  for (const edge of compiled.finalEdges) {
    rawCopyV8Exact(edge, ['virtualLinkKey', 'sourceEntityKey', 'originEvidenceLinkId', 'literal', 'targetPathText', 'resolution',
      ...(Object.hasOwn(edge, 'physicalReadSource') ? ['physicalReadSource'] : [])]);
    rawCopyV8Exact(edge.resolution, ['status', 'targetEntityKey', 'candidateEntityKeys']);
    if (Object.hasOwn(edge, 'physicalReadSource') && edge.physicalReadSource !== true) return rawCopyV8Fail();
  }
  const snapshots = (value.sourceScope.workspaceId === value.destinationScope.workspaceId ? [source] : [source, destination]).map(workspaceOperationMixedSourceSnapshotV5);
  const html = createWorkspaceMixedHtmlFileOperationPlanV5({ ...compiled.requests[0], sourceEvidence: source,
    ...(source.workspaceScope.workspaceId === destination.workspaceScope.workspaceId ? {} : { destinationEvidence: destination }) });
  if (!equal(compiled.htmlAssessment, html.htmlAssessment) || compiled.htmlAssessmentProof !== html.htmlAssessmentProof
    || !equal(compiled.sourceCoverage, html.sourceCoverage)) return rawCopyV8Fail();
  const paths = createWorkspaceMixedHtmlImportCopyFileOperationPlanV6({ snapshots, compilation: compiled });
  const expectedMappings = value.selections.flatMap(selected => source.namespace
    .filter(entry => entry.path === selected.sourcePath || entry.path.startsWith(selected.sourcePath + '/'))
    .map(entry => ({ source: entry, destinationPath: selected.destinationPath + entry.path.slice(selected.sourcePath.length),
      destinationWorkspaceId: value.destinationScope.workspaceId })))
    .sort((left, right) => left.source.path.localeCompare(right.source.path));
  const nativeEvidence = snapshots.flatMap(snapshot => snapshot.documents.map(inventory => ({ inventory,
    evidenceKey: proof({ workspaceId: inventory.document.workspaceId, documentId: inventory.document.documentId,
      lifecycleGeneration: inventory.document.lifecycleGeneration }) }))).sort((left, right) => left.evidenceKey.localeCompare(right.evidenceKey));
  if (!equal(paths, value.nativePathPlan) || paths.readiness !== 'ready' || !paths.pathMappings.length
    || !equal(paths.pathMappings, expectedMappings) || new Set(expectedMappings.map(mapping => mapping.source.path)).size !== expectedMappings.length
    || new Set(expectedMappings.map(mapping => mapping.destinationPath)).size !== expectedMappings.length
    || expectedMappings.some(mapping => !isCanonicalAdmissionPath(mapping.destinationPath) || Buffer.byteLength(mapping.destinationPath) > 4096
      || mapping.destinationPath.split('/').length > 33 || destination.namespace.some(entry => entry.path === mapping.destinationPath
        || entry.kind === 'file' && mapping.destinationPath.startsWith(entry.path + '/')))
    || !equal(nativeEvidence, compiled.documentEvidence)
    || proof({ namespace: compiled.finalNamespace, edges: compiled.finalEdges }) !== compiled.finalGraphProof
    || compiled.steps[0].afterGraphProof !== compiled.finalGraphProof
    || !equal(rawCopyV8Clones(snapshots[0], value.destinationScope, value.selections, paths, compiled.cloneRequirements), value.cloneRequirements)
    || !equal(rawCopyV8Scenes(source, value.destinationScope, paths), value.sceneCopyRequirements)) return rawCopyV8Fail();
  const physical = new Map(source.physicalSources4.map(item => [item.path, item]));
  const required = paths.pathMappings.filter(mapping => physical.has(mapping.source.path));
  if (required.length !== value.rawImportRequirements.length || required.length !== compiled.rawImportRequirements.length) return rawCopyV8Fail();
  const seen = new Set<string>();
  for (const requirement of value.rawImportRequirements) {
    rawCopyV8Exact(requirement, ['entityKey', 'sourceEntityKey', 'requestIndex', 'sourceWorkspaceId', 'sourcePath', 'destinationWorkspaceId', 'destinationPath',
      'physicalSourceProof', 'physical', 'importPolicy', 'linkBindings', 'applicability', 'preparation', 'sourceBinding', 'ordinaryRequirement']);
    const { preparation, sourceBinding, ordinaryRequirement, ...raw } = requirement, source4 = physical.get(raw.sourcePath), mapping = required.find(item => item.source.path === raw.sourcePath);
    if (!source4) return rawCopyV8Fail();
    const certified = decodeRawHtmlSourceBindingV2(sourceBinding, source4), original = certified.original4;
    if (!equal(ordinaryRequirement, { ...raw, physicalSourceProof: source4.physicalSourceProof,
      importPolicy: { version: 1, initialRepresentation: 'auto', parserVersion: 4 } })) return rawCopyV8Fail();
    rawCopyV8Exact(preparation, ['version', 'representation', 'newlineStyle', 'hasBom', 'sourceHash', 'sourceBytes', 'canonicalHash']);
    if (!original || !mapping || seen.has(raw.entityKey) || raw.requestIndex !== 0 || raw.sourceWorkspaceId !== value.sourceScope.workspaceId
      || raw.destinationWorkspaceId !== value.destinationScope.workspaceId || raw.destinationPath !== mapping.destinationPath
      || !/\.(?:md|markdown)$/iu.test(raw.destinationPath) || !equal(raw.physical, original.physical)
      || raw.physicalSourceProof !== original.physicalSourceProof || raw.sourceEntityKey !== proof({ workspaceId: raw.sourceWorkspaceId, identity: mapping.source.identity })
      || raw.entityKey !== proof({ requestIndex: 0, sourceEntityKey: raw.sourceEntityKey, destinationWorkspaceId: raw.destinationWorkspaceId, destinationPath: raw.destinationPath })
      || raw.applicability !== 'requires-fresh-destination-import-and-occurrence-binding'
      || !equal(raw.importPolicy, { version: 1, initialRepresentation: 'auto', parserVersion: original.parserVersion ?? 2 })
      || preparation.version !== 1 || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(preparation.representation)
      || preparation.sourceHash !== original.physical.byteHash || preparation.sourceBytes !== original.physical.byteLength
      || !['none', 'lf', 'crlf'].includes(original.lineEndings.style) || preparation.newlineStyle !== (original.lineEndings.style === 'crlf' ? 'crlf' : 'lf')
      || preparation.hasBom !== original.hasBom || !/^[a-f0-9]{64}$/u.test(preparation.canonicalHash)
      || !equal(raw.linkBindings, original.links.map(link => ({ physicalLinkId: link.physicalLinkId,
        sourceVirtualLinkKey: proof({ entityKey: raw.sourceEntityKey, physicalLinkId: link.physicalLinkId }),
        virtualLinkKey: proof({ entityKey: raw.entityKey, physicalLinkId: link.physicalLinkId }) })))) return rawCopyV8Fail();
    seen.add(raw.entityKey);
  }
  if (!equal(value.rawImportRequirements.map(requirement => requirement.ordinaryRequirement), compiled.rawImportRequirements)
    || value.readiness !== (value.cloneRequirements.length || value.rawImportRequirements.length || value.sceneCopyRequirements.length ? 'requires-provider-publication' : 'ready')
    || rawCopyV8PlanId(value) !== value.planId) return rawCopyV8Fail();
  const originals = buildWorkspaceMixedHtmlLinkGraphV5(snapshots[0]);
  const expectedPhysicalIntents = originals.edges.flatMap(edge => {
    if (edge.sourceKind !== 'physical-read') return [];
    const requirement = value.rawImportRequirements.find(raw => raw.sourcePath === edge.source.path);
    if (!requirement) return [];
    if (edge.resolution.status !== 'resolved' || !edge.resolution.target) return rawCopyV8Fail();
    const mappedTarget = paths.pathMappings.find(mapping => mapping.source.path === edge.resolution.target!.path);
    if (!mappedTarget && value.sourceScope.workspaceId !== value.destinationScope.workspaceId) return rawCopyV8Fail();
    const expectedTargetEntityKey = proof({ workspaceId: edge.source.workspaceId, identity: edge.resolution.target.identity });
    return [{ virtualLinkKey: proof({ entityKey: requirement.entityKey, physicalLinkId: edge.id }), entityKey: requirement.entityKey,
      physicalSourceProof: requirement.ordinaryRequirement.physicalSourceProof, physicalLinkId: edge.id, action: 'rewrite' as const,
      expectedSourceLiteral: edge.literal, expectedTargetPathText: edge.targetPathText, expectedTargetEntityKey,
      targetEntityKeyAfter: mappedTarget ? proof({ requestIndex: 0, sourceEntityKey: expectedTargetEntityKey,
        destinationWorkspaceId: value.destinationScope.workspaceId, destinationPath: mappedTarget.destinationPath }) : expectedTargetEntityKey,
      targetPathAfter: mappedTarget?.destinationPath ?? edge.resolution.target.path, fragment: edge.fragment, alias: edge.alias, embed: edge.embed,
      adapterCheck: 'physical-occurrence-to-native-forward-and-targeted-inverse' as const }];
  });
  if (!equal([...expectedPhysicalIntents].sort((left, right) => left.virtualLinkKey.localeCompare(right.virtualLinkKey)),
    [...compiled.steps[0].physicalLinkIntents].sort((left, right) => left.virtualLinkKey.localeCompare(right.virtualLinkKey)))) return rawCopyV8Fail();
  const { integrityProof, ...body } = value;
  if (proof(body) !== integrityProof) return rawCopyV8Fail(); return rawCopyV8Freeze(value);
}
export function decodeWorkspaceOperationManagedCopyPlanV8(input: unknown): WorkspaceOperationManagedCopyPlanV8 {
  try { return rawCopyV8Historical(rawCopyV8Capture(input) as WorkspaceOperationManagedCopyPlanV8); }
  catch (error) { if (error instanceof WorkspaceOperationManagedCopyPlanV8Error) throw error; return rawCopyV8Fail(); }
}
type RawCopyV8Input = { sourceScope: WorkspaceOperationBatchScope; destinationScope: WorkspaceOperationBatchScope;
  selections: readonly WorkspaceOperationNativeCopySelection[];
  sourceObservation: WorkspaceLinkSourceAuthorityObservation; destinationObservation: WorkspaceLinkSourceAuthorityObservation };
function rawCopyV8Compiler(source: WorkspaceOperationMixedSourceEvidenceV5, destination: WorkspaceOperationMixedSourceEvidenceV5,
  selections: readonly WorkspaceOperationNativeCopySelection[], states: readonly PersistedCollaborationState[]): NativeMixedHtmlImportCopyBatchPlanV6 {
  const compiled = compileWorkspaceMixedSelectedHtmlImportCopyBatchV6({ sourceEvidence: source,
    ...(source.workspaceScope.workspaceId === destination.workspaceScope.workspaceId ? {} : { destinationEvidence: destination }), states, requests: [{ kind: 'copy',
    sourceWorkspaceId: source.workspaceScope.workspaceId, destinationWorkspaceId: destination.workspaceScope.workspaceId,
    selections: selections.map(selected => ({ ...selected })) }] });
  if (compiled.issues.length || !compiled.finalGraphProof) return rawCopyV8Fail('MANAGED_COPY_PLAN_UNSUPPORTED'); return compiled;
}
function rawCopyV8Build(input: RawCopyV8Input): WorkspaceOperationManagedCopyPlanV8 {
  rawCopyV8Exact(input, ['sourceScope', 'destinationScope', 'selections', 'sourceObservation', 'destinationObservation']);
  const sourceWorkspace = rawCopyV8Field(rawCopyV8Field(input, 'sourceScope'), 'workspace');
  const destinationWorkspace = rawCopyV8Field(rawCopyV8Field(input, 'destinationScope'), 'workspace');
  for (const workspace of [sourceWorkspace, destinationWorkspace]) {
    if (!workspace || typeof workspace !== 'object' || types.isProxy(workspace) || Object.getPrototypeOf(workspace) !== Object.prototype
      || Object.values(Object.getOwnPropertyDescriptors(workspace)).some(descriptor => !Object.hasOwn(descriptor, 'value'))) return rawCopyV8Fail();
  }
  const sourceScope = captureWorkspaceOperationJobScope(sourceWorkspace as WorkspaceOperationBatchScope['workspace']);
  const destinationScope = captureWorkspaceOperationJobScope(destinationWorkspace as WorkspaceOperationBatchScope['workspace']);
  const selections = rawCopyV8Capture(rawCopyV8Field(input, 'selections')) as WorkspaceOperationNativeCopySelection[];
  if (!Array.isArray(selections) || !selections.length || selections.length > 1000) return rawCopyV8Fail();
  for (const selected of selections) { rawCopyV8Exact(selected, ['sourcePath', 'destinationPath']);
    if (![selected.sourcePath, selected.destinationPath].every(path => isCanonicalAdmissionPath(path) && Buffer.byteLength(path) <= 4096 && path.split('/').length <= 33)) return rawCopyV8Fail(); }
  const sourceObservation = rawCopyV8Field(input, 'sourceObservation') as WorkspaceLinkSourceAuthorityObservation;
  const destinationObservation = rawCopyV8Field(input, 'destinationObservation') as WorkspaceLinkSourceAuthorityObservation;
  const sourceEvidence = captureWorkspaceOperationMixedSourceEvidenceV5(sourceScope, sourceObservation);
  const destinationEvidence = captureWorkspaceOperationMixedSourceEvidenceV5(destinationScope, destinationObservation);
  if (sourceScope.workspaceId === destinationScope.workspaceId && !equal(sourceEvidence, destinationEvidence)) return rawCopyV8Fail('MANAGED_COPY_PLAN_CHANGED');
  const states = rawCopyV8Field(sourceObservation, 'privateNativeStates') as readonly PersistedCollaborationState[];
  const destinationStates = rawCopyV8Field(destinationObservation, 'privateNativeStates') as readonly PersistedCollaborationState[];
  const compilation = rawCopyV8Compiler(sourceEvidence, destinationEvidence, selections,
    sourceScope.workspaceId === destinationScope.workspaceId ? states : [...states, ...destinationStates]);
  const rawImportRequirements = rawCopyV8PrepareRequirements(compilation, sourceEvidence, sourceObservation);
  const nativePathPlan = createWorkspaceMixedHtmlImportCopyFileOperationPlanV6({ compilation,
    snapshots: (sourceScope.workspaceId === destinationScope.workspaceId ? [sourceEvidence] : [sourceEvidence, destinationEvidence]).map(workspaceOperationMixedSourceSnapshotV5) });
  const sceneCopyRequirements = rawCopyV8Scenes(sourceEvidence, destinationScope, nativePathPlan);
  const body = { version: 8 as const, kind: 'native-copy' as const, executionReady: false as const,
    readiness: compilation.cloneRequirements.length || rawImportRequirements.length || sceneCopyRequirements.length ? 'requires-provider-publication' as const : 'ready' as const,
    sourceScope, destinationScope, selections, sourceEvidence, destinationEvidence, nativePathPlan, compilation,
    compilerPlanProof: compilation.planId, finalGraphProof: compilation.finalGraphProof!, cloneRequirements: compilation.cloneRequirements,
    rawImportRequirements, sceneCopyRequirements };
  const planned = { ...body, planId: rawCopyV8PlanId(body) };
  return decodeWorkspaceOperationManagedCopyPlanV8({ ...planned, integrityProof: proof(planned) });
}
export function createWorkspaceOperationManagedCopyPlanV8(input: RawCopyV8Input): WorkspaceOperationManagedCopyPlanV8 {
  try { return rawCopyV8Build(input); }
  catch (error) { if (error instanceof WorkspaceOperationManagedCopyPlanV8Error) throw error; return rawCopyV8Fail('MANAGED_COPY_PLAN_UNSUPPORTED'); }
}
export function assertWorkspaceOperationManagedCopyPlanV8Current(plan: WorkspaceOperationManagedCopyPlanV8,
  input: RawCopyV8Input): NativeMixedHtmlImportCopyBatchPlanV6 {
  const original = decodeWorkspaceOperationManagedCopyPlanV8(plan);
  rawCopyV8Exact(input, ['sourceScope', 'destinationScope', 'selections', 'sourceObservation', 'destinationObservation']);
  const sourceWorkspace = rawCopyV8Field(rawCopyV8Field(input, 'sourceScope'), 'workspace');
  const destinationWorkspace = rawCopyV8Field(rawCopyV8Field(input, 'destinationScope'), 'workspace');
  for (const workspace of [sourceWorkspace, destinationWorkspace]) {
    if (!workspace || typeof workspace !== 'object' || types.isProxy(workspace) || Object.getPrototypeOf(workspace) !== Object.prototype
      || Object.values(Object.getOwnPropertyDescriptors(workspace)).some(descriptor => !Object.hasOwn(descriptor, 'value'))) return rawCopyV8Fail();
  }
  const sourceScope = captureWorkspaceOperationJobScope(sourceWorkspace as WorkspaceOperationBatchScope['workspace']);
  const destinationScope = captureWorkspaceOperationJobScope(destinationWorkspace as WorkspaceOperationBatchScope['workspace']);
  const sourceObservation = rawCopyV8Field(input, 'sourceObservation') as WorkspaceLinkSourceAuthorityObservation;
  const destinationObservation = rawCopyV8Field(input, 'destinationObservation') as WorkspaceLinkSourceAuthorityObservation;
  const source = captureWorkspaceOperationMixedSourceEvidenceV5(sourceScope, sourceObservation);
  const destination = captureWorkspaceOperationMixedSourceEvidenceV5(destinationScope, destinationObservation);
  if (!equal(sourceScope, original.sourceScope) || !equal(destinationScope, original.destinationScope)
    || !equal(rawCopyV8Capture(input.selections), original.selections)
    || source.semanticProof !== original.sourceEvidence.semanticProof || destination.semanticProof !== original.destinationEvidence.semanticProof) return rawCopyV8Fail('MANAGED_COPY_PLAN_CHANGED');
  const states = rawCopyV8Field(sourceObservation, 'privateNativeStates') as readonly PersistedCollaborationState[];
  const destinationStates = rawCopyV8Field(destinationObservation, 'privateNativeStates') as readonly PersistedCollaborationState[];
  const compiled = rawCopyV8Compiler(original.sourceEvidence, original.destinationEvidence, original.selections,
    sourceScope.workspaceId === destinationScope.workspaceId ? states : [...states, ...destinationStates]);
  if (compiled.planId !== original.compilerPlanProof || compiled.finalGraphProof !== original.finalGraphProof
    || !equal(rawCopyV8PrepareRequirements(compiled, original.sourceEvidence, sourceObservation), original.rawImportRequirements)) return rawCopyV8Fail('MANAGED_COPY_PLAN_CHANGED');
  return rawCopyV8Freeze(compiled);
}

/** Fixed Plan8 data commitments. The Stage/Owner must repeat the actual E5,
 * original-byte replay and current namespace checks before every real effect. */
export function nativeCopyMarkdownNamespaceAssessmentForPlanV8(input: WorkspaceOperationManagedCopyPlanV8) {
  const plan = decodeWorkspaceOperationManagedCopyPlanV8(input);
  return Object.freeze({ version: 1 as const, kind: 'copy-html-v4-assessment' as const,
    sourceSemanticProof: plan.sourceEvidence.semanticProof, destinationSemanticProof: plan.destinationEvidence.semanticProof,
    requestProof: proof(plan.compilation.requests[0]),
    beforeNamespaceProof: proof((plan.sourceScope.workspaceId === plan.destinationScope.workspaceId
      ? [plan.sourceEvidence] : [plan.sourceEvidence, plan.destinationEvidence]).map(value => ({ workspaceId: value.workspaceScope.workspaceId, namespace: value.namespace }))),
    finalNamespaceProof: proof(plan.compilation.finalNamespace), htmlAssessmentProof: plan.compilation.htmlAssessmentProof });
}

export type WorkspaceOperationManagedRawHtmlCopyPlan = WorkspaceOperationManagedCopyPlanV7 | WorkspaceOperationManagedCopyPlanV8;
/** Closed profile dispatch; a descriptor never grants current execution authority. */
export function decodeWorkspaceOperationManagedRawHtmlCopyPlan(input: unknown): WorkspaceOperationManagedRawHtmlCopyPlan {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return rawCopyV8Fail();
  const version = Object.getOwnPropertyDescriptor(input, 'version');
  if (!version?.enumerable || !Object.hasOwn(version, 'value')) return rawCopyV8Fail();
  if (version.value === 7) return decodeWorkspaceOperationManagedCopyPlanV7(input);
  if (version.value === 8) return decodeWorkspaceOperationManagedCopyPlanV8(input);
  return rawCopyV8Fail();
}

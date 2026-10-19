import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { prepareMarkdownFileImport } from '../collaboration/markdown-file-import';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { buildWorkspaceMixedReadLinkGraphV3 } from '../markdown/workspace-native-link-graph';
import { compileWorkspaceMixedImportCopyBatchV4, type NativeMixedImportCopyBatchPlanV4,
  type NativeMixedRawImportRequirementV4 } from '../markdown/workspace-native-mixed-batch-compiler';
import { createWorkspaceMixedImportCopyFileOperationPlanV4, type WorkspaceMixedImportCopyFilePlanV4 } from '../markdown/workspace-native-file-operation-planner';
import { captureWorkspaceOperationCopySourceEvidenceV4, decodeWorkspaceOperationCopySourceEvidenceV4,
  workspaceOperationMixedCopySourceSnapshot, type WorkspaceOperationCopySourceEvidenceV4 } from './workspace-operation-copy-source-evidence-v4';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import type { WorkspaceOperationBatchScope, WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import type { WorkspaceSceneCopyRequirement } from './workspace-operation-managed-copy-plan';
import { assertNativeCopyCloneRequirements, type WorkspaceOperationNativeCopySelection } from './workspace-operation-native-copy-plan';

export type RawCopyImportPreparationV1 = Readonly<{ version: 1;
  representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks'; newlineStyle: 'lf' | 'crlf'; hasBom: boolean;
  sourceHash: string; sourceBytes: number; canonicalHash: string }>;
export type ManagedCopyRawImportRequirementV5 = NativeMixedRawImportRequirementV4 & Readonly<{ preparation: RawCopyImportPreparationV1 }>;
export type WorkspaceOperationManagedCopyPlanV5 = Readonly<{
  version: 5; kind: 'native-copy'; executionReady: false; readiness: 'ready' | 'requires-provider-publication';
  sourceScope: WorkspaceOperationJobScope; destinationScope: WorkspaceOperationJobScope;
  selections: readonly WorkspaceOperationNativeCopySelection[];
  sourceEvidence: WorkspaceOperationCopySourceEvidenceV4; destinationEvidence: WorkspaceOperationCopySourceEvidenceV4;
  nativePathPlan: WorkspaceMixedImportCopyFilePlanV4;
  compilation: NativeMixedImportCopyBatchPlanV4; compilerPlanProof: string; finalGraphProof: string;
  cloneRequirements: NativeMixedImportCopyBatchPlanV4['cloneRequirements'];
  rawImportRequirements: readonly ManagedCopyRawImportRequirementV5[];
  sceneCopyRequirements: readonly WorkspaceSceneCopyRequirement[]; planId: string; integrityProof: string;
}>;
export class WorkspaceOperationManagedCopyPlanV5Error extends Error {
  readonly status: 409 | 413;
  constructor(readonly code: 'MANAGED_COPY_PLAN_INVALID' | 'MANAGED_COPY_PLAN_CHANGED' | 'MANAGED_COPY_PLAN_UNSUPPORTED' | 'MANAGED_COPY_PLAN_TOO_LARGE') {
    super(code); this.name = 'WorkspaceOperationManagedCopyPlanV5Error'; this.status = code === 'MANAGED_COPY_PLAN_TOO_LARGE' ? 413 : 409;
  }
}
const rawCopyV5Fail = (code: WorkspaceOperationManagedCopyPlanV5Error['code'] = 'MANAGED_COPY_PLAN_INVALID'): never => {
  throw new WorkspaceOperationManagedCopyPlanV5Error(code);
};
function rawCopyV5Capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => rawCopyV5Fail(reason === 'too-large'
    ? 'MANAGED_COPY_PLAN_TOO_LARGE' : 'MANAGED_COPY_PLAN_INVALID'), 16 * 1024 * 1024);
}
function rawCopyV5Field(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return rawCopyV5Fail();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return rawCopyV5Fail(); return descriptor.value;
}
function rawCopyV5Exact(input: unknown, keys: readonly string[]): void {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Reflect.ownKeys(input).length !== keys.length) return rawCopyV5Fail();
  for (const key of keys) rawCopyV5Field(input, key);
}
function rawCopyV5Freeze<T>(input: T): T {
  if (input && typeof input === 'object') { for (const child of Object.values(input)) rawCopyV5Freeze(child); Object.freeze(input); } return input;
}
function rawCopyV5PlanId(value: Pick<WorkspaceOperationManagedCopyPlanV5,
  'sourceScope' | 'destinationScope' | 'selections' | 'sourceEvidence' | 'destinationEvidence' | 'rawImportRequirements'>): string {
  return proof({ version: 5, kind: 'native-copy', sourceScope: value.sourceScope, destinationScope: value.destinationScope,
    selections: value.selections, sourceSemanticProof: value.sourceEvidence.semanticProof,
    destinationSemanticProof: value.destinationEvidence.semanticProof, rawImportRequirements: value.rawImportRequirements });
}
function rawCopyV5Scenes(source: WorkspaceOperationCopySourceEvidenceV4, destination: WorkspaceOperationJobScope,
  paths: WorkspaceMixedImportCopyFilePlanV4): WorkspaceSceneCopyRequirement[] {
  return paths.pathMappings.flatMap(mapping => {
    const binding = source.sceneBindings.find(value => value.header.path === mapping.source.path);
    if (!binding) { if (mapping.source.provider === 'excalidraw') return rawCopyV5Fail(); return []; }
    const header = binding.header;
    if (!mapping.destinationPath.toLowerCase().endsWith('.excalidraw') || mapping.destinationPath.split('/').at(-1)!.toLowerCase() === '.excalidraw') return rawCopyV5Fail('MANAGED_COPY_PLAN_UNSUPPORTED');
    return [{ sourceWorkspaceId: source.workspaceScope.workspaceId, sourcePath: header.path, sourceDocumentId: header.id,
      sourceLineageId: header.lineage_id, sourceGeneration: header.lifecycle_generation!, sourceSceneSequence: header.scene_sequence!,
      sourceCanonicalHash: header.canonical_hash!, sourceContentProof: binding.contentProof,
      destinationWorkspaceId: destination.workspaceId, destinationPath: mapping.destinationPath }];
  });
}
/** No fake identity is needed to compute the actual import policy. Scratch Yjs
 * clocks are deliberately excluded; Stage6 must repeat this over original bytes. */
function rawCopyV5PrepareRequirements(compilation: NativeMixedImportCopyBatchPlanV4,
  observation: WorkspaceLinkSourceAuthorityObservation): ManagedCopyRawImportRequirementV5[] {
  const sources = rawCopyV5Field(rawCopyV5Field(observation, 'stage'), 'sources');
  if (types.isProxy(sources) || !Array.isArray(sources)) return rawCopyV5Fail();
  return compilation.rawImportRequirements.map(requirement => {
    const source = sources.find(value => rawCopyV5Field(value, 'kind') === 'physical'
      && rawCopyV5Field(rawCopyV5Field(value, 'inventory'), 'path') === requirement.sourcePath);
    const inventory = rawCopyV5Field(source, 'inventory'), bytes = rawCopyV5Field(inventory, 'originalBytes');
    const typed = Object.getPrototypeOf(Uint8Array.prototype), getLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
    if (!bytes || typeof bytes !== 'object' || types.isProxy(bytes) || !ArrayBuffer.isView(bytes)
      || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(bytes))) return rawCopyV5Fail();
    const length = getLength.call(bytes) as number;
    if (length !== requirement.physical.byteLength || length > 4 * 1024 * 1024) return rawCopyV5Fail('MANAGED_COPY_PLAN_TOO_LARGE');
    const copy = Buffer.alloc(length); Uint8Array.prototype.set.call(copy, bytes as Uint8Array);
    if (rawCopyV5Field(inventory, 'physicalSourceProof') !== requirement.physicalSourceProof) return rawCopyV5Fail('MANAGED_COPY_PLAN_CHANGED');
    const prepared = prepareMarkdownFileImport(copy, { representation: 'auto' });
    if (prepared.sourceHash !== requirement.physical.byteHash || prepared.sourceBytes !== length) return rawCopyV5Fail('MANAGED_COPY_PLAN_CHANGED');
    return { ...requirement, preparation: { version: 1, representation: prepared.representation, newlineStyle: prepared.newlineStyle,
      hasBom: prepared.hasBom, sourceHash: prepared.sourceHash, sourceBytes: prepared.sourceBytes,
      canonicalHash: createHash('sha256').update(prepared.canonical, 'utf8').digest('hex') } };
  });
}
/** Historical data validation. Compiler native-content proofs remain opaque
 * without Stage records, exactly as Plan4; before execution Stage6 MUST replay
 * the entire compiler with original native records and reparse every raw byte. */
function rawCopyV5Historical(value: WorkspaceOperationManagedCopyPlanV5): WorkspaceOperationManagedCopyPlanV5 {
  rawCopyV5Exact(value, ['version', 'kind', 'executionReady', 'readiness', 'sourceScope', 'destinationScope', 'selections', 'sourceEvidence',
    'destinationEvidence', 'nativePathPlan', 'compilation', 'compilerPlanProof', 'finalGraphProof', 'cloneRequirements', 'rawImportRequirements',
    'sceneCopyRequirements', 'planId', 'integrityProof']);
  if (value.version !== 5 || value.kind !== 'native-copy' || value.executionReady !== false) return rawCopyV5Fail();
  const source = decodeWorkspaceOperationCopySourceEvidenceV4(value.sourceEvidence), destination = decodeWorkspaceOperationCopySourceEvidenceV4(value.destinationEvidence);
  if (!equal(parseWorkspaceOperationJobScope(value.sourceScope), source.workspaceScope)
    || !equal(parseWorkspaceOperationJobScope(value.destinationScope), destination.workspaceScope)
    || value.sourceScope.workspaceId === value.destinationScope.workspaceId && !equal(source, destination)
    || !Array.isArray(value.selections) || !value.selections.length || value.selections.length > 1000) return rawCopyV5Fail();
  for (const selected of value.selections) {
    rawCopyV5Exact(selected, ['sourcePath', 'destinationPath']);
    if (![selected.sourcePath, selected.destinationPath].every(path => isCanonicalAdmissionPath(path)
      && Buffer.byteLength(path) <= 4096 && path.split('/').length <= 33)) return rawCopyV5Fail();
  }
  const compiled = value.compilation;
  rawCopyV5Exact(compiled, ['contractVersion', 'compilerVersion', 'readiness', 'executionReady', 'requests', 'snapshotProofs', 'documentEvidence',
    'steps', 'cloneRequirements', 'rawImportRequirements', 'finalNamespace', 'finalEdges', 'finalGraphProof', 'issues', 'requiredCoordinatorBindings', 'planId']);
  const { planId: compilerId, ...compilerBody } = compiled;
  if (compiled.contractVersion !== 4 || compiled.compilerVersion !== 1 || compiled.executionReady !== false || compiled.issues.length
    || compiled.requests.length !== 1 || compiled.steps.length !== 1 || proof(compilerBody) !== compilerId
    || compilerId !== value.compilerPlanProof || compiled.finalGraphProof !== value.finalGraphProof
    || ![value.compilerPlanProof, value.finalGraphProof, value.planId, value.integrityProof].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash))
    || !equal(compiled.requests[0], { kind: 'copy', sourceWorkspaceId: value.sourceScope.workspaceId,
      destinationWorkspaceId: value.destinationScope.workspaceId, selections: value.selections })
    || !equal(compiled.steps[0].request, compiled.requests[0]) || compiled.steps[0].requestIndex !== 0) return rawCopyV5Fail();
  rawCopyV5Exact(compiled.steps[0], ['requestIndex', 'request', 'beforeGraphProof', 'afterGraphProof', 'namespaceEffects', 'linkIntents', 'physicalLinkIntents']);
  if (!equal(compiled.requiredCoordinatorBindings, ['actor-session-request-review-and-current-authority', 'complete-current-namespace-and-native-graph',
    'kernel-lifecycle-fence-and-exact-registry-path-receipts', 'fresh-durable-native-states-and-targeted-inverse-receipts',
    'fresh-copy-identities-block-id-map-and-link-rebinding'])
    || compiled.readiness !== (compiled.rawImportRequirements.length ? 'requires-import-rebinding' : compiled.cloneRequirements.length ? 'requires-clone-rebinding' : 'ready')) return rawCopyV5Fail();
  for (const pin of compiled.snapshotProofs) rawCopyV5Exact(pin, ['workspaceId', 'proof']);
  for (const inventory of compiled.documentEvidence) rawCopyV5Exact(inventory, ['evidenceKey', 'inventory']);
  for (const effect of compiled.steps[0].namespaceEffects) rawCopyV5Exact(effect,
    ['entityKey', 'sourceEntityKey', 'sourceWorkspaceId', 'sourcePath', 'destinationWorkspaceId', 'destinationPath']);
  for (const intent of compiled.steps[0].linkIntents) rawCopyV5Exact(intent, ['virtualLinkKey', 'entityKey', 'originEvidenceLinkId', 'action',
    'expectedValue', 'nextValue', 'expectedTargetEntityKey', 'targetEntityKeyAfter', 'adapterCheck']);
  for (const intent of compiled.steps[0].physicalLinkIntents) rawCopyV5Exact(intent, ['virtualLinkKey', 'entityKey', 'physicalSourceProof',
    'physicalLinkId', 'action', 'expectedSourceLiteral', 'expectedTargetPathText', 'expectedTargetEntityKey', 'targetEntityKeyAfter',
    'targetPathAfter', 'fragment', 'alias', 'embed', 'adapterCheck']);
  for (const clone of compiled.cloneRequirements) {
    rawCopyV5Exact(clone, ['entityKey', 'sourceEntityKey', 'requestIndex', 'sourceWorkspaceId', 'sourcePath', 'sourceContentBasisProof', 'linkBindings', 'applicability']);
    for (const link of clone.linkBindings) rawCopyV5Exact(link, ['virtualLinkKey', 'sourceVirtualLinkKey', 'originEvidenceLinkId']);
  }
  for (const entity of compiled.finalNamespace) {
    rawCopyV5Exact(entity, ['entityKey', 'workspaceId', 'path', 'kind', 'binding', 'contentBasisProof', 'metadata',
      ...(Object.hasOwn(entity, 'physicalReadSource') ? ['physicalReadSource'] : [])]);
    if (entity.binding.kind === 'existing') rawCopyV5Exact(entity.binding, ['kind', 'namespaceEvidence', 'documentEvidenceKey']);
    else { rawCopyV5Exact(entity.binding, ['kind', 'sourceEntityKey', 'createdAtRequest']);
      if (!['unbound-copy', 'unbound-import'].includes(entity.binding.kind)) return rawCopyV5Fail(); }
    if (Object.hasOwn(entity, 'physicalReadSource')) rawCopyV5Exact(entity.physicalReadSource, ['physicalSourceProof']);
  }
  for (const edge of compiled.finalEdges) {
    rawCopyV5Exact(edge, ['virtualLinkKey', 'sourceEntityKey', 'originEvidenceLinkId', 'literal', 'targetPathText', 'resolution',
      ...(Object.hasOwn(edge, 'physicalReadSource') ? ['physicalReadSource'] : [])]);
    rawCopyV5Exact(edge.resolution, ['status', 'targetEntityKey', 'candidateEntityKeys']);
    if (Object.hasOwn(edge, 'physicalReadSource') && edge.physicalReadSource !== true) return rawCopyV5Fail();
  }
  const snapshots = (value.sourceScope.workspaceId === value.destinationScope.workspaceId ? [source] : [source, destination]).map(workspaceOperationMixedCopySourceSnapshot);
  const paths = createWorkspaceMixedImportCopyFileOperationPlanV4({ snapshots, compilation: compiled });
  const expectedMappings = value.selections.flatMap(selected => source.stage.namespace
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
      || mapping.destinationPath.split('/').length > 33 || destination.stage.namespace.some(entry => entry.path === mapping.destinationPath
        || entry.kind === 'file' && mapping.destinationPath.startsWith(entry.path + '/')))
    || !equal(nativeEvidence, compiled.documentEvidence)
    || proof({ namespace: compiled.finalNamespace, edges: compiled.finalEdges }) !== compiled.finalGraphProof
    || compiled.steps[0].afterGraphProof !== compiled.finalGraphProof
    || !equal(assertNativeCopyCloneRequirements(snapshots[0], value.destinationScope, value.selections, paths, compiled.cloneRequirements), value.cloneRequirements)
    || !equal(rawCopyV5Scenes(source, value.destinationScope, paths), value.sceneCopyRequirements)) return rawCopyV5Fail();
  const physical = new Map(source.nativeComponent.physicalSources.map(item => [item.path, item]));
  const required = paths.pathMappings.filter(mapping => physical.has(mapping.source.path));
  if (required.length !== value.rawImportRequirements.length || required.length !== compiled.rawImportRequirements.length) return rawCopyV5Fail();
  const seen = new Set<string>();
  for (const requirement of value.rawImportRequirements) {
    rawCopyV5Exact(requirement, ['entityKey', 'sourceEntityKey', 'requestIndex', 'sourceWorkspaceId', 'sourcePath', 'destinationWorkspaceId', 'destinationPath',
      'physicalSourceProof', 'physical', 'importPolicy', 'linkBindings', 'applicability', 'preparation']);
    const { preparation, ...raw } = requirement, original = physical.get(raw.sourcePath), mapping = required.find(item => item.source.path === raw.sourcePath);
    rawCopyV5Exact(preparation, ['version', 'representation', 'newlineStyle', 'hasBom', 'sourceHash', 'sourceBytes', 'canonicalHash']);
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
        virtualLinkKey: proof({ entityKey: raw.entityKey, physicalLinkId: link.physicalLinkId }) })))) return rawCopyV5Fail();
    seen.add(raw.entityKey);
  }
  if (!equal(value.rawImportRequirements.map(({ preparation: _private, ...raw }) => raw), compiled.rawImportRequirements)
    || value.readiness !== (value.cloneRequirements.length || value.rawImportRequirements.length || value.sceneCopyRequirements.length ? 'requires-provider-publication' : 'ready')
    || rawCopyV5PlanId(value) !== value.planId) return rawCopyV5Fail();
  const originals = buildWorkspaceMixedReadLinkGraphV3(snapshots[0]);
  const expectedPhysicalIntents = originals.edges.flatMap(edge => {
    if (edge.sourceKind !== 'physical-read') return [];
    const requirement = value.rawImportRequirements.find(raw => raw.sourcePath === edge.source.path);
    if (!requirement) return [];
    if (edge.resolution.status !== 'resolved' || !edge.resolution.target) return rawCopyV5Fail();
    const mappedTarget = paths.pathMappings.find(mapping => mapping.source.path === edge.resolution.target!.path);
    if (!mappedTarget && value.sourceScope.workspaceId !== value.destinationScope.workspaceId) return rawCopyV5Fail();
    const expectedTargetEntityKey = proof({ workspaceId: edge.source.workspaceId, identity: edge.resolution.target.identity });
    return [{ virtualLinkKey: proof({ entityKey: requirement.entityKey, physicalLinkId: edge.id }), entityKey: requirement.entityKey,
      physicalSourceProof: requirement.physicalSourceProof, physicalLinkId: edge.id, action: 'rewrite' as const,
      expectedSourceLiteral: edge.literal, expectedTargetPathText: edge.targetPathText, expectedTargetEntityKey,
      targetEntityKeyAfter: mappedTarget ? proof({ requestIndex: 0, sourceEntityKey: expectedTargetEntityKey,
        destinationWorkspaceId: value.destinationScope.workspaceId, destinationPath: mappedTarget.destinationPath }) : expectedTargetEntityKey,
      targetPathAfter: mappedTarget?.destinationPath ?? edge.resolution.target.path, fragment: edge.fragment, alias: edge.alias, embed: edge.embed,
      adapterCheck: 'physical-occurrence-to-native-forward-and-targeted-inverse' as const }];
  });
  if (!equal([...expectedPhysicalIntents].sort((left, right) => left.virtualLinkKey.localeCompare(right.virtualLinkKey)),
    [...compiled.steps[0].physicalLinkIntents].sort((left, right) => left.virtualLinkKey.localeCompare(right.virtualLinkKey)))) return rawCopyV5Fail();
  const { integrityProof, ...body } = value;
  if (proof(body) !== integrityProof) return rawCopyV5Fail(); return rawCopyV5Freeze(value);
}
export function decodeWorkspaceOperationManagedCopyPlanV5(input: unknown): WorkspaceOperationManagedCopyPlanV5 {
  try { return rawCopyV5Historical(rawCopyV5Capture(input) as WorkspaceOperationManagedCopyPlanV5); }
  catch (error) { if (error instanceof WorkspaceOperationManagedCopyPlanV5Error) throw error; return rawCopyV5Fail(); }
}
type RawCopyV5Input = { sourceScope: WorkspaceOperationBatchScope; destinationScope: WorkspaceOperationBatchScope;
  selections: readonly WorkspaceOperationNativeCopySelection[];
  sourceObservation: WorkspaceLinkSourceAuthorityObservation; destinationObservation: WorkspaceLinkSourceAuthorityObservation };
function rawCopyV5Compiler(source: WorkspaceOperationCopySourceEvidenceV4, destination: WorkspaceOperationCopySourceEvidenceV4,
  selections: readonly WorkspaceOperationNativeCopySelection[], states: readonly PersistedCollaborationState[]): NativeMixedImportCopyBatchPlanV4 {
  const snapshots = (source.workspaceScope.workspaceId === destination.workspaceScope.workspaceId ? [source] : [source, destination]).map(workspaceOperationMixedCopySourceSnapshot);
  const compiled = compileWorkspaceMixedImportCopyBatchV4({ snapshots, states, requests: [{ kind: 'copy',
    sourceWorkspaceId: source.workspaceScope.workspaceId, destinationWorkspaceId: destination.workspaceScope.workspaceId,
    selections: selections.map(selected => ({ ...selected })) }] });
  if (compiled.issues.length || !compiled.finalGraphProof) return rawCopyV5Fail('MANAGED_COPY_PLAN_UNSUPPORTED'); return compiled;
}
function rawCopyV5Build(input: RawCopyV5Input): WorkspaceOperationManagedCopyPlanV5 {
  rawCopyV5Exact(input, ['sourceScope', 'destinationScope', 'selections', 'sourceObservation', 'destinationObservation']);
  const sourceWorkspace = rawCopyV5Field(rawCopyV5Field(input, 'sourceScope'), 'workspace');
  const destinationWorkspace = rawCopyV5Field(rawCopyV5Field(input, 'destinationScope'), 'workspace');
  for (const workspace of [sourceWorkspace, destinationWorkspace]) {
    if (!workspace || typeof workspace !== 'object' || types.isProxy(workspace) || Object.getPrototypeOf(workspace) !== Object.prototype
      || Object.values(Object.getOwnPropertyDescriptors(workspace)).some(descriptor => !Object.hasOwn(descriptor, 'value'))) return rawCopyV5Fail();
  }
  const sourceScope = captureWorkspaceOperationJobScope(sourceWorkspace as WorkspaceOperationBatchScope['workspace']);
  const destinationScope = captureWorkspaceOperationJobScope(destinationWorkspace as WorkspaceOperationBatchScope['workspace']);
  const selections = rawCopyV5Capture(rawCopyV5Field(input, 'selections')) as WorkspaceOperationNativeCopySelection[];
  if (!Array.isArray(selections) || !selections.length || selections.length > 1000) return rawCopyV5Fail();
  for (const selected of selections) { rawCopyV5Exact(selected, ['sourcePath', 'destinationPath']);
    if (![selected.sourcePath, selected.destinationPath].every(path => isCanonicalAdmissionPath(path) && Buffer.byteLength(path) <= 4096 && path.split('/').length <= 33)) return rawCopyV5Fail(); }
  const sourceObservation = rawCopyV5Field(input, 'sourceObservation') as WorkspaceLinkSourceAuthorityObservation;
  const destinationObservation = rawCopyV5Field(input, 'destinationObservation') as WorkspaceLinkSourceAuthorityObservation;
  const sourceEvidence = captureWorkspaceOperationCopySourceEvidenceV4(sourceScope, sourceObservation);
  const destinationEvidence = captureWorkspaceOperationCopySourceEvidenceV4(destinationScope, destinationObservation);
  if (sourceScope.workspaceId === destinationScope.workspaceId && !equal(sourceEvidence, destinationEvidence)) return rawCopyV5Fail('MANAGED_COPY_PLAN_CHANGED');
  const states = rawCopyV5Field(sourceObservation, 'privateNativeStates') as readonly PersistedCollaborationState[];
  const destinationStates = rawCopyV5Field(destinationObservation, 'privateNativeStates') as readonly PersistedCollaborationState[];
  const compilation = rawCopyV5Compiler(sourceEvidence, destinationEvidence, selections,
    sourceScope.workspaceId === destinationScope.workspaceId ? states : [...states, ...destinationStates]);
  const rawImportRequirements = rawCopyV5PrepareRequirements(compilation, sourceObservation);
  const nativePathPlan = createWorkspaceMixedImportCopyFileOperationPlanV4({ compilation,
    snapshots: (sourceScope.workspaceId === destinationScope.workspaceId ? [sourceEvidence] : [sourceEvidence, destinationEvidence]).map(workspaceOperationMixedCopySourceSnapshot) });
  const sceneCopyRequirements = rawCopyV5Scenes(sourceEvidence, destinationScope, nativePathPlan);
  const body = { version: 5 as const, kind: 'native-copy' as const, executionReady: false as const,
    readiness: compilation.cloneRequirements.length || rawImportRequirements.length || sceneCopyRequirements.length ? 'requires-provider-publication' as const : 'ready' as const,
    sourceScope, destinationScope, selections, sourceEvidence, destinationEvidence, nativePathPlan, compilation,
    compilerPlanProof: compilation.planId, finalGraphProof: compilation.finalGraphProof!, cloneRequirements: compilation.cloneRequirements,
    rawImportRequirements, sceneCopyRequirements };
  const planned = { ...body, planId: rawCopyV5PlanId(body) };
  return decodeWorkspaceOperationManagedCopyPlanV5({ ...planned, integrityProof: proof(planned) });
}
export function createWorkspaceOperationManagedCopyPlanV5(input: RawCopyV5Input): WorkspaceOperationManagedCopyPlanV5 {
  try { return rawCopyV5Build(input); }
  catch (error) { if (error instanceof WorkspaceOperationManagedCopyPlanV5Error) throw error; return rawCopyV5Fail('MANAGED_COPY_PLAN_UNSUPPORTED'); }
}
export function assertWorkspaceOperationManagedCopyPlanV5Current(plan: WorkspaceOperationManagedCopyPlanV5,
  input: RawCopyV5Input): NativeMixedImportCopyBatchPlanV4 {
  const original = decodeWorkspaceOperationManagedCopyPlanV5(plan);
  rawCopyV5Exact(input, ['sourceScope', 'destinationScope', 'selections', 'sourceObservation', 'destinationObservation']);
  const sourceWorkspace = rawCopyV5Field(rawCopyV5Field(input, 'sourceScope'), 'workspace');
  const destinationWorkspace = rawCopyV5Field(rawCopyV5Field(input, 'destinationScope'), 'workspace');
  for (const workspace of [sourceWorkspace, destinationWorkspace]) {
    if (!workspace || typeof workspace !== 'object' || types.isProxy(workspace) || Object.getPrototypeOf(workspace) !== Object.prototype
      || Object.values(Object.getOwnPropertyDescriptors(workspace)).some(descriptor => !Object.hasOwn(descriptor, 'value'))) return rawCopyV5Fail();
  }
  const sourceScope = captureWorkspaceOperationJobScope(sourceWorkspace as WorkspaceOperationBatchScope['workspace']);
  const destinationScope = captureWorkspaceOperationJobScope(destinationWorkspace as WorkspaceOperationBatchScope['workspace']);
  const sourceObservation = rawCopyV5Field(input, 'sourceObservation') as WorkspaceLinkSourceAuthorityObservation;
  const destinationObservation = rawCopyV5Field(input, 'destinationObservation') as WorkspaceLinkSourceAuthorityObservation;
  const source = captureWorkspaceOperationCopySourceEvidenceV4(sourceScope, sourceObservation);
  const destination = captureWorkspaceOperationCopySourceEvidenceV4(destinationScope, destinationObservation);
  if (!equal(sourceScope, original.sourceScope) || !equal(destinationScope, original.destinationScope)
    || !equal(rawCopyV5Capture(input.selections), original.selections)
    || source.semanticProof !== original.sourceEvidence.semanticProof || destination.semanticProof !== original.destinationEvidence.semanticProof) return rawCopyV5Fail('MANAGED_COPY_PLAN_CHANGED');
  const states = rawCopyV5Field(sourceObservation, 'privateNativeStates') as readonly PersistedCollaborationState[];
  const destinationStates = rawCopyV5Field(destinationObservation, 'privateNativeStates') as readonly PersistedCollaborationState[];
  const compiled = rawCopyV5Compiler(original.sourceEvidence, original.destinationEvidence, original.selections,
    sourceScope.workspaceId === destinationScope.workspaceId ? states : [...states, ...destinationStates]);
  if (compiled.planId !== original.compilerPlanProof || compiled.finalGraphProof !== original.finalGraphProof
    || !equal(rawCopyV5PrepareRequirements(compiled, sourceObservation), original.rawImportRequirements)) return rawCopyV5Fail('MANAGED_COPY_PLAN_CHANGED');
  return rawCopyV5Freeze(compiled);
}

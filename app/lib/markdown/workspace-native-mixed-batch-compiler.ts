import 'server-only';

import path from 'node:path';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import { Y } from '../collaboration/server-runtime';
import { parseObsidianWikiTarget } from './obsidian-flavored-markdown';
import { getCanvasNotebookExactLinkTarget } from './obsidian-link-resolver';
import { resolveWorkspaceWikiFileLink } from './workspace-link-index-core';
import { resolveExactWorkspaceLink } from './workspace-local-link-parser';
import { inspectPersistedDocumentLinks, inspectPersistedDocumentLinksV4, nativeLinkJsonProof } from './workspace-native-link-inventory';
import { prepareNativeLinkInverse, prepareNativeLinkMutations, prepareNativeLinkInverseV4, prepareNativeLinkMutationsV4, type NativeLinkInverseRecipe } from './workspace-native-link-mutations';
import type { NativeDocumentLink, NativeDocumentLinkInventory, NativeLinkMutationRecipe, NativeNamespaceEntry,
  NativeWorkspaceFileOperationPlan, NativeWorkspaceLinkSnapshot } from './workspace-link-contract-v2';
import type { PhysicalReadLinkInventory, WorkspaceMixedReadLinkSnapshotV3 } from './workspace-link-contract-v3';
import { createWorkspaceMixedHtmlFileOperationPlanV5 } from './workspace-native-file-operation-planner';
import { workspaceMixedHtmlBlockingCoverageV5 } from './workspace-native-link-graph';
import { decodeWorkspaceOperationMixedSourceEvidenceV5, workspaceOperationMixedSourceSnapshotV5, type WorkspaceOperationMixedSourceEvidenceV5, type PhysicalMarkdownSourceEvidenceV5 } from '../files/workspace-operation-mixed-source-evidence-v5';
import type { NativeDocumentLinkInventoryV4 } from './workspace-native-link-inventory';
import type { FilePlanV5, WorkspaceMixedHtmlAssessmentBindingV5, WorkspaceMixedHtmlLinkSnapshotV5 } from './workspace-link-contract-v5';

export type NativeMixedBatchRequest = {
  kind: NativeWorkspaceFileOperationPlan['kind'];
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  selections: Array<{ sourcePath: string; destinationPath?: string }>;
};

export type NativeMixedBatchLinkIntent = {
  virtualLinkKey: string;
  entityKey: string;
  /** This is evidence from the original durable document, never a clone anchor. */
  originEvidenceLinkId: string;
  action: 'rewrite' | 'unlink';
  expectedValue: string;
  nextValue: string | null;
  expectedTargetEntityKey: string;
  targetEntityKeyAfter: string | null;
  adapterCheck: 'native-forward-and-targeted-inverse';
};

export type NativeMixedBatchVirtualEntity = {
  entityKey: string;
  workspaceId: string;
  path: string;
  kind: NativeNamespaceEntry['kind'];
  binding: { kind: 'existing'; namespaceEvidence: NativeNamespaceEntry; documentEvidenceKey: string | null }
    | { kind: 'unbound-copy'; sourceEntityKey: string; createdAtRequest: number };
  /** A semantic native-content hash; this is NOT a binary, vector or durable clock. */
  contentBasisProof: string | null;
  metadata: NativeDocumentLinkInventory['metadata'] | null;
  /** V3 only: observed physical evidence, never a native document identity. */
  physicalReadSource?: { physicalSourceProof: string };
};

export type NativeMixedBatchVirtualEdge = {
  virtualLinkKey: string;
  sourceEntityKey: string;
  originEvidenceLinkId: string;
  literal: string;
  targetPathText: string;
  resolution: { status: string; targetEntityKey: string | null; candidateEntityKeys: string[] };
  /** V3 only: this edge has no native reference or executable recipe. */
  physicalReadSource?: true;
};

export type NativeMixedBatchPlan = {
  contractVersion: 2;
  compilerVersion: 1;
  planId: string;
  readiness: 'ready' | 'requires-clone-rebinding' | 'blocked';
  /** Planability never grants mutation authority or substitutes for a receipt. */
  executionReady: false;
  requests: NativeMixedBatchRequest[];
  snapshotProofs: Array<{ workspaceId: string; proof: string }>;
  documentEvidence: Array<{ evidenceKey: string; inventory: NativeDocumentLinkInventory }>;
  steps: Array<{
    requestIndex: number;
    request: NativeMixedBatchRequest;
    beforeGraphProof: string;
    afterGraphProof: string;
    namespaceEffects: Array<{ entityKey: string; sourceEntityKey: string; sourceWorkspaceId: string;
      sourcePath: string; destinationWorkspaceId: string; destinationPath: string | null }>;
    linkIntents: NativeMixedBatchLinkIntent[];
  }>;
  cloneRequirements: Array<{ entityKey: string; sourceEntityKey: string; requestIndex: number;
    sourceWorkspaceId: string; sourcePath: string; sourceContentBasisProof: string | null;
    linkBindings: Array<{ virtualLinkKey: string; sourceVirtualLinkKey: string; originEvidenceLinkId: string }>;
    applicability: 'requires-fresh-clone-receipt-and-inventory' }>;
  finalNamespace: NativeMixedBatchVirtualEntity[];
  finalEdges: NativeMixedBatchVirtualEdge[];
  /** Null for a blocked plan: a failed rehearsal has no claimed final state. */
  finalGraphProof: string | null;
  issues: Array<{ code: string; requestIndex: number | null; workspaceId: string; path: string; linkId?: string }>;
  requiredCoordinatorBindings: readonly [
    'actor-session-request-review-and-current-authority',
    'complete-current-namespace-and-native-graph',
    'kernel-lifecycle-fence-and-exact-registry-path-receipts',
    'fresh-durable-native-states-and-targeted-inverse-receipts',
    'fresh-copy-identities-block-id-map-and-link-rebinding',
  ];
};

export type NativeMixedReadBatchPlanV3 = Omit<NativeMixedBatchPlan, 'contractVersion'> & { contractVersion: 3 };
export type NativeMixedHtmlBatchPlanV5 = Omit<NativeMixedBatchPlan, 'contractVersion' | 'documentEvidence'> & {
  contractVersion: 5; documentEvidence: Array<{ evidenceKey: string; inventory: NativeDocumentLinkInventoryV4 }>;
} & WorkspaceMixedHtmlAssessmentBindingV5;
type AnyCompilerInventory = NativeDocumentLinkInventory | NativeDocumentLinkInventoryV4;
type AnyCompilerPhysical = PhysicalReadLinkInventory | PhysicalMarkdownSourceEvidenceV5;

/** Logical imports contain physical evidence only. No native source identity,
 * Yjs reference, target ID or persistence confirmation exists at planning time. */
export type NativeMixedRawImportRequirementV4 = {
  entityKey: string; sourceEntityKey: string; requestIndex: number;
  sourceWorkspaceId: string; sourcePath: string; destinationWorkspaceId: string; destinationPath: string;
  physicalSourceProof: string; physical: PhysicalReadLinkInventory['physical'];
  importPolicy: { version: 1; initialRepresentation: 'auto'; parserVersion: 2 | 3 };
  linkBindings: Array<{ virtualLinkKey: string; sourceVirtualLinkKey: string; physicalLinkId: string }>;
  applicability: 'requires-fresh-destination-import-and-occurrence-binding';
};
export type NativeMixedPhysicalLinkIntentV4 = {
  virtualLinkKey: string; entityKey: string; physicalSourceProof: string; physicalLinkId: string;
  action: 'rewrite'; expectedSourceLiteral: string; expectedTargetPathText: string;
  expectedTargetEntityKey: string; targetEntityKeyAfter: string; targetPathAfter: string;
  fragment: string | null; alias: string | null; embed: boolean;
  adapterCheck: 'physical-occurrence-to-native-forward-and-targeted-inverse';
};
type ImportVirtualEntityV4 = Omit<NativeMixedBatchVirtualEntity, 'binding'> & {
  binding: { kind: 'unbound-import'; sourceEntityKey: string; createdAtRequest: number };
};
export type NativeMixedImportCopyBatchPlanV4 = Omit<NativeMixedBatchPlan,
  'contractVersion' | 'readiness' | 'steps' | 'finalNamespace'> & {
  contractVersion: 4; readiness: NativeMixedBatchPlan['readiness'] | 'requires-import-rebinding';
  steps: Array<NativeMixedBatchPlan['steps'][number] & { physicalLinkIntents: NativeMixedPhysicalLinkIntentV4[] }>;
  rawImportRequirements: NativeMixedRawImportRequirementV4[];
  finalNamespace: Array<NativeMixedBatchVirtualEntity | ImportVirtualEntityV4>;
};

/** C1 is an independent HTML-aware raw-copy contract. Actual parser4 facts
 * remain parser4; the durable importer binds its original parser3 separately. */
export type NativeMixedRawImportRequirementV6 = Omit<NativeMixedRawImportRequirementV4, 'importPolicy'> & {
  importPolicy: { version: 1; initialRepresentation: 'auto'; parserVersion: 4 };
};
export type NativeMixedHtmlImportCopyBatchPlanV6 = Omit<NativeMixedImportCopyBatchPlanV4,
  'contractVersion' | 'documentEvidence' | 'rawImportRequirements'> & {
  contractVersion: 6; documentEvidence: Array<{ evidenceKey: string; inventory: NativeDocumentLinkInventoryV4 }>;
  rawImportRequirements: NativeMixedRawImportRequirementV6[];
} & WorkspaceMixedHtmlAssessmentBindingV5;

type LogicalLink = { key: string; originEvidenceLinkId: string; current: NativeDocumentLink };
type Entity = Omit<NativeMixedBatchVirtualEntity, 'metadata' | 'binding'> & {
  binding: NativeMixedBatchVirtualEntity['binding'] | ImportVirtualEntityV4['binding'];
  baseState: PersistedCollaborationState | null;
  doc: InstanceType<typeof Y.Doc> | null;
  inventory: AnyCompilerInventory | null;
  physical: AnyCompilerPhysical | null;
  physicalLinkValues?: Map<string, { literal: string; targetPathText: string }>;
  links: LogicalLink[];
};
type NativeEdge = NativeMixedBatchVirtualEdge & { provider: 'native'; entity: Entity; link: LogicalLink };
type PhysicalEdge = NativeMixedBatchVirtualEdge & { provider: 'physical-read'; entity: Entity;
  link: { current: Pick<NativeDocumentLink, 'kind' | 'syntax' | 'literal' | 'targetPathText' | 'fragment' | 'alias' | 'embed' | 'classification'> } };
type Edge = NativeEdge | PhysicalEdge;
type UndoCheck = { entity: Entity; recipes: NativeLinkInverseRecipe[]; beforeContentProof: string; requestIndex: number };

const proof = nativeLinkJsonProof;
function canonicalPath(value: string): boolean {
  try { encodeURI(value); } catch { return false; }
  return Boolean(value) && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
    && !value.split('/').some((part) => !part || part === '.' || part === '..');
}
function stateKey(state: Pick<PersistedCollaborationState, 'workspaceId' | 'documentId' | 'lifecycleGeneration'>): string {
  return proof({ workspaceId: state.workspaceId, documentId: state.documentId, lifecycleGeneration: state.lifecycleGeneration });
}
function scratchState(entity: Entity): PersistedCollaborationState {
  // The durable identity/clock belongs to baseState alone. New bytes here are
  // private rehearsal values, never returned or submitted to persistence.
  return { ...entity.baseState!, yjsState: Y.encodeStateAsUpdate(entity.doc!), stateVector: Y.encodeStateVector(entity.doc!) };
}
function contentProof(state: PersistedCollaborationState): string {
  return proof(authoritativeNativeCollaborationSnapshot(state).content);
}
function expectedValue(link: NativeDocumentLink): string {
  return String(link.ref.kind === 'link-mark' ? link.ref.expected.href : link.ref.expected);
}
function linkMeaning(link: NativeDocumentLink): unknown {
  return { kind: link.kind, syntax: link.syntax, literal: link.literal, targetPathText: link.targetPathText,
    fragment: link.fragment, alias: link.alias, embed: link.embed, classification: link.classification,
    referenceKind: link.ref.kind, expected: link.ref.expected };
}
function publicEntity(entity: Entity): NativeMixedBatchVirtualEntity | ImportVirtualEntityV4 {
  const metadata = entity.inventory?.metadata ?? entity.physical?.metadata;
  const projected = { entityKey: entity.entityKey, workspaceId: entity.workspaceId, path: entity.path, kind: entity.kind,
    binding: entity.binding, contentBasisProof: entity.contentBasisProof,
    metadata: metadata ? { ...metadata, path: entity.path,
      title: metadata.hasExplicitTitle || metadata.headings.length ? metadata.title : entity.path.split('/').at(-1)!.replace(/\.(?:md|markdown)$/iu, '') } : null,
    ...(entity.physical ? { physicalReadSource: { physicalSourceProof: entity.physical.physicalSourceProof } } : {}) };
  // Preserve the historical property order while narrowing the new binding arm.
  if (projected.binding.kind === 'unbound-import') return { ...projected, binding: projected.binding };
  return { ...projected, binding: projected.binding };
}
function publicEdge(edge: Edge): NativeMixedBatchVirtualEdge {
  return { virtualLinkKey: edge.virtualLinkKey, sourceEntityKey: edge.sourceEntityKey, originEvidenceLinkId: edge.originEvidenceLinkId,
    literal: edge.literal, targetPathText: edge.targetPathText, resolution: edge.resolution,
    ...(edge.provider === 'physical-read' ? { physicalReadSource: true as const } : {}) };
}
function graph(entities: Entity[]): Edge[] {
  const edges: Edge[] = [];
  const workspaces = new Map<string, { byPath: Map<string, Entity>; paths: Set<string>;
    nativeTargetPaths: Set<string>;
    candidates: Array<{ path: string; aliases: string[]; extension: string | undefined; type: 'file' }> }>();
  for (const entity of entities) {
    if (!entity.links.length && !entity.physical?.links.length) continue;
    let workspace = workspaces.get(entity.workspaceId);
    if (!workspace) {
      const files = entities.filter((candidate) => candidate.workspaceId === entity.workspaceId && candidate.kind === 'file');
      const byPath = new Map(files.map((candidate) => [candidate.path, candidate]));
      workspace = { byPath, paths: new Set(byPath.keys()), nativeTargetPaths: new Set(files.filter(candidate => candidate.inventory
        || candidate.binding.kind === 'unbound-import').map(candidate => candidate.path)),
        candidates: files.filter((candidate) => candidate.inventory || candidate.physical).map((candidate) => ({ path: candidate.path,
          aliases: (candidate.inventory?.metadata ?? candidate.physical!.metadata).aliases,
          extension: candidate.path.split('.').at(-1), type: 'file' as const })) };
      workspaces.set(entity.workspaceId, workspace);
    }
    const { byPath, paths, candidates, nativeTargetPaths } = workspace;
    for (const link of entity.links) {
      const value = link.current;
      const resolution = value.classification !== 'local'
        ? { status: value.classification, path: null, candidates: [] as string[] }
        : value.kind === 'wiki'
          ? resolveWorkspaceWikiFileLink({ targetLiteral: value.literal, targetPathText: value.targetPathText }, entity.path, paths, candidates,
            { nativeTargetPaths })
          : resolveExactWorkspaceLink(value.targetPathText, entity.path, paths);
      edges.push({ provider: 'native', virtualLinkKey: link.key, sourceEntityKey: entity.entityKey, originEvidenceLinkId: link.originEvidenceLinkId,
        literal: value.literal, targetPathText: value.targetPathText, entity, link,
        resolution: { status: resolution.status, targetEntityKey: resolution.path ? byPath.get(resolution.path)?.entityKey ?? null : null,
          candidateEntityKeys: resolution.candidates.map((candidate) => byPath.get(candidate)!.entityKey).sort() } });
    }
    for (const link of entity.physical?.links ?? []) {
      const current = entity.physicalLinkValues?.get(link.physicalLinkId);
      const targetLiteral = current?.literal ?? link.targetLiteral, targetPathText = current?.targetPathText ?? link.targetPathText;
      const resolution = link.kind === 'wiki'
        ? resolveWorkspaceWikiFileLink({ targetLiteral, targetPathText }, entity.path,
          paths, candidates, { nativeTargetPaths })
        : resolveExactWorkspaceLink(targetPathText, entity.path, paths);
      edges.push({ provider: 'physical-read', virtualLinkKey: proof({ entityKey: entity.entityKey, physicalLinkId: link.physicalLinkId }),
        sourceEntityKey: entity.entityKey, originEvidenceLinkId: link.physicalLinkId, literal: targetLiteral,
        targetPathText, entity,
        link: { current: { kind: link.kind, syntax: link.syntax, literal: targetLiteral, targetPathText,
          fragment: link.fragment, alias: link.alias, embed: link.embed, classification: 'local' } },
        resolution: { status: resolution.status, targetEntityKey: resolution.path ? byPath.get(resolution.path)?.entityKey ?? null : null,
          candidateEntityKeys: resolution.candidates.map(candidate => byPath.get(candidate)!.entityKey).sort() } });
    }
  }
  return edges.sort((a, b) => a.virtualLinkKey.localeCompare(b.virtualLinkKey));
}
function graphProof(entities: Entity[], edges: Edge[]): string {
  return proof({ namespace: entities.map(publicEntity).sort((a, b) => a.entityKey.localeCompare(b.entityKey)),
    edges: edges.map(publicEdge) });
}
function nextTarget(edge: NativeEdge, targetPath: string, sourcePath: string): string | null {
  return formatNativeLinkTargetForPathChange(edge.link.current, targetPath, sourcePath);
}
/** Same historical formatting formula over genuine inspected native fields.
 * No fake resolved edge, source document ID or physical offset is required. */
export function formatNativeLinkTargetForPathChange(link: Pick<NativeDocumentLink,
  'kind' | 'ref' | 'literal' | 'fragment' | 'targetPathText'>, targetPath: string, sourcePath: string): string | null {
  if (link.kind === 'wiki') {
    if (/[#|\]\\]/u.test(targetPath)) return null;
    const old = parseObsidianWikiTarget(link.ref.kind === 'node-attribute' ? link.ref.expected : link.literal);
    if (!old) return null;
    const file = /\.(?:md|markdown)$/iu.test(old.path) ? targetPath : targetPath.replace(/\.(?:md|markdown)$/iu, '');
    return `/${file}${link.fragment === null ? '' : `#${link.fragment}`}${link.ref.kind === 'node-attribute' && old.alias ? `|${old.alias}` : ''}`;
  }
  if (getCanvasNotebookExactLinkTarget(link.literal)) return null;
  let value = link.targetPathText.startsWith('/') ? `/${targetPath}`
    : path.posix.relative(path.posix.dirname(sourcePath), targetPath) || path.posix.basename(targetPath);
  if (!value.startsWith('/') && /^[a-z][a-z0-9+.-]*:/iu.test(value)) value = `./${value}`;
  value = encodeURI(value).replace(/#/gu, '%23').replace(/\?/gu, '%3F').replace(/\(/gu, '%28').replace(/\)/gu, '%29')
    .replace(/\[/gu, '%5B').replace(/\]/gu, '%5D').replace(/</gu, '%3C').replace(/>/gu, '%3E').replace(/\|/gu, '%7C');
  return `${value}${link.fragment === null ? '' : `#${link.fragment}`}`;
}

/** Pure, private planning foundation. All requests share one evolving virtual
 * graph. Native bytes are inspected and rehearsed locally, with no projection,
 * filesystem, database, room mutation or execution admission. Copy tokens are
 * virtual entities, never NativeLinkDocumentIdentity or executable recipes.
 *
 * Registry-only paths require receipts binding exact before identity/org/path/
 * generation/sequence/proof and observed after identity/path/generation under
 * the real kernel/lifecycle fence. Physical SHA/inode is not a substitute.
 */
export function compileWorkspaceNativeMixedBatch(input: {
  snapshots: readonly NativeWorkspaceLinkSnapshot[];
  states: readonly PersistedCollaborationState[];
  requests: readonly NativeMixedBatchRequest[];
}): NativeMixedBatchPlan {
  return compileMixedBatch(input, 2) as NativeMixedBatchPlan;
}

/** Same rehearsal engine, with explicit immutable physical READ sources. The
 * first V3 arm never imports, edits, copies or moves a physical Markdown source. */
export function compileWorkspaceMixedReadBatchV3(input: {
  snapshots: readonly WorkspaceMixedReadLinkSnapshotV3[];
  states: readonly PersistedCollaborationState[];
  requests: readonly NativeMixedBatchRequest[];
}): NativeMixedReadBatchPlanV3 {
  return compileMixedBatch(input, 3) as NativeMixedReadBatchPlanV3;
}

/** Same full-graph engine. Imports remain logical until actual B1 receipts and
 * physical occurrence bindings exist; there is no simulated native source. */
export function compileWorkspaceMixedImportCopyBatchV4(input: {
  snapshots: readonly WorkspaceMixedReadLinkSnapshotV3[];
  states: readonly PersistedCollaborationState[]; requests: readonly NativeMixedBatchRequest[];
}): NativeMixedImportCopyBatchPlanV4 {
  return compileMixedBatch(input, 4) as NativeMixedImportCopyBatchPlanV4;
}

/** One actual operation per public HTML-aware plan. The same E5 facts drive
 * ordinary planning, exact HTML assessment and native4 rehearsal. The durable
 * owner still has to re-observe bytes, principals and admission before apply. */
export function compileWorkspaceMixedHtmlBatchV5(input: {
  sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5;
  destinationEvidence?: WorkspaceOperationMixedSourceEvidenceV5;
  states: readonly PersistedCollaborationState[];
  requests: readonly NativeMixedBatchRequest[];
}): NativeMixedHtmlBatchPlanV5 {
  if (input.requests.length !== 1) throw new Error('HTML_MIXED_BATCH_SINGLE_REQUEST_REQUIRED');
  const source = decodeWorkspaceOperationMixedSourceEvidenceV5(input.sourceEvidence);
  const destination = input.destinationEvidence === undefined ? source : decodeWorkspaceOperationMixedSourceEvidenceV5(input.destinationEvidence);
  const request = input.requests[0];
  const plan = createWorkspaceMixedHtmlFileOperationPlanV5({ ...request, sourceEvidence: source,
    ...(input.destinationEvidence === undefined ? {} : { destinationEvidence: destination }) });
  const evidence = request.sourceWorkspaceId === request.destinationWorkspaceId ? [source] : [source, destination];
  const snapshots = evidence.map(workspaceOperationMixedSourceSnapshotV5);
  return compileMixedBatch({ snapshots, states: input.states, requests: input.requests }, 5, plan) as NativeMixedHtmlBatchPlanV5;
}

/** Exact C1: selected ordinary raw Markdown is importable, but its own HTML
 * syntax is not. Unrelated HTML is still assessed by the complete E5 planner;
 * no affected/opaque HTML issue is removed or rewritten here. */
export function compileWorkspaceMixedHtmlImportCopyBatchV6(input: {
  sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5;
  destinationEvidence?: WorkspaceOperationMixedSourceEvidenceV5;
  states: readonly PersistedCollaborationState[];
  requests: readonly NativeMixedBatchRequest[];
}): NativeMixedHtmlImportCopyBatchPlanV6 {
  return compileMixedHtmlImportCopyBatchV6(input, 'ordinary');
}

/** Exact C2: one same-workspace physical Markdown file with its own HTML.
 * This is still Compiler6 data rehearsal, never import or mutation authority. */
export function compileWorkspaceMixedSelectedHtmlImportCopyBatchV6(
  input: Parameters<typeof compileWorkspaceMixedHtmlImportCopyBatchV6>[0],
): NativeMixedHtmlImportCopyBatchPlanV6 {
  return compileMixedHtmlImportCopyBatchV6(input, 'selected-own-html');
}

function compileMixedHtmlImportCopyBatchV6(
  input: Parameters<typeof compileWorkspaceMixedHtmlImportCopyBatchV6>[0], profile: 'ordinary' | 'selected-own-html',
): NativeMixedHtmlImportCopyBatchPlanV6 {
  if (input.requests.length !== 1 || input.requests[0]?.kind !== 'copy') throw new Error('HTML_IMPORT_COPY_SINGLE_REQUEST_REQUIRED');
  const source = decodeWorkspaceOperationMixedSourceEvidenceV5(input.sourceEvidence);
  const destination = input.destinationEvidence === undefined ? source : decodeWorkspaceOperationMixedSourceEvidenceV5(input.destinationEvidence);
  const request = input.requests[0], selected = (pathname: string) => request.selections.some(selection =>
    pathname === selection.sourcePath || pathname.startsWith(selection.sourcePath + '/'));
  const supported = new Set(source.physicalSources4.filter(value => selected(value.path)
    && value.htmlInspection.occurrences.length === 0 && value.coverage.complete && value.coverage.gaps.length === 0).map(value => value.path));
  const original = createWorkspaceMixedHtmlFileOperationPlanV5({ ...request, sourceEvidence: source,
    ...(input.destinationEvidence === undefined ? {} : { destinationEvidence: destination }) });
  if (profile === 'selected-own-html') {
    const selection = request.selections[0];
    const entry = selection && source.namespace.find(value => value.path === selection.sourcePath);
    const selectedSource = selection && source.physicalSources4.find(value => value.path === selection.sourcePath);
    if (request.sourceWorkspaceId !== request.destinationWorkspaceId || request.selections.length !== 1
      || !entry || entry.kind !== 'file' || entry.documentId !== null || !selectedSource
      || !/\.(?:md|markdown)$/iu.test(selectedSource.path) || selectedSource.htmlInspection.occurrences.length === 0) {
      throw new Error('HTML_IMPORT_COPY_SELECTED_HTML_PROFILE_REQUIRED');
    }
    // Only this genuine selected Markdown source can enter C2. The full E5
    // assessment ran above; opaque/affected HTML and all original gaps stay facts.
    supported.clear();
    if (original.htmlAssessment.complete
      && selectedSource.htmlInspection.occurrences.every(occurrence => occurrence.fullyInspected === true)
      && selectedSource.coverage.gaps.every(gap => gap.code === 'uninspected-html')
      && (selectedSource.coverage.complete || selectedSource.coverage.gaps.length > 0)) supported.add(selectedSource.path);
  }
  const plan = { ...original, issues: original.issues.filter(issue => !(issue.code === 'physical-source-import-required'
    && issue.workspaceId === source.workspaceScope.workspaceId && supported.has(issue.path))) };
  for (const value of source.physicalSources4) if (selected(value.path) && !supported.has(value.path)) plan.issues.push({
    code: 'raw-markdown-html-copy-unsupported', workspaceId: source.workspaceScope.workspaceId, path: value.path });
  for (const value of source.physicalHtmlSources4) if (selected(value.path)) plan.issues.push({
    code: 'selected-html-copy-unsupported', workspaceId: source.workspaceScope.workspaceId, path: value.path });
  if ([source, destination].some(value => value.namespace.some(entry => entry.provider === 'excalidraw'))) plan.issues.push({
    code: 'scene-copy-profile-required', workspaceId: source.workspaceScope.workspaceId, path: '' });
  const evidence = request.sourceWorkspaceId === request.destinationWorkspaceId ? [source] : [source, destination];
  return compileMixedBatch({ snapshots: evidence.map(workspaceOperationMixedSourceSnapshotV5), states: input.states,
    requests: input.requests }, 6, plan) as NativeMixedHtmlImportCopyBatchPlanV6;
}

function compileMixedBatch(input: {
  snapshots: readonly (NativeWorkspaceLinkSnapshot | WorkspaceMixedReadLinkSnapshotV3 | WorkspaceMixedHtmlLinkSnapshotV5)[];
  states: readonly PersistedCollaborationState[];
  requests: readonly NativeMixedBatchRequest[];
}, contractVersion: 2 | 3 | 4 | 5 | 6, htmlPlan?: FilePlanV5): NativeMixedBatchPlan | NativeMixedReadBatchPlanV3 | NativeMixedImportCopyBatchPlanV4 | NativeMixedHtmlBatchPlanV5 | NativeMixedHtmlImportCopyBatchPlanV6 {
  const issues: NativeMixedBatchPlan['issues'] = [];
  const issue = (code: string, requestIndex: number | null, workspaceId: string, pathValue: string, linkId?: string) =>
    issues.push({ code, requestIndex, workspaceId, path: pathValue, ...(linkId ? { linkId } : {}) });
  const entities: Entity[] = []; const allEntities: Entity[] = []; const evidence: Array<{ evidenceKey: string; inventory: AnyCompilerInventory }> = [];
  if (contractVersion >= 5) {
    if (!htmlPlan || htmlPlan.contractVersion !== 5) throw new Error('HTML_MIXED_BATCH_PLAN_REQUIRED');
    for (const value of htmlPlan.issues) issue(value.code, null, value.workspaceId, value.path, value.linkId);
    if (!htmlPlan.htmlAssessment.complete && !htmlPlan.issues.length) issue('incomplete-html-assessment', null, htmlPlan.sourceWorkspaceId, '');
  }
  const steps: NativeMixedBatchPlan['steps'] = []; const clones: NativeMixedBatchPlan['cloneRequirements'] = [];
  const imports: (NativeMixedRawImportRequirementV4 | NativeMixedRawImportRequirementV6)[] = [];
  const undo: UndoCheck[] = []; const workspaceIds = new Set<string>(); const documentIds = new Set<string>();
  const states = new Map<string, PersistedCollaborationState>(); const usedStates = new Set<string>();
  for (const state of input.states) {
    const key = stateKey(state);
    if (states.has(key)) issue('duplicate-native-state', null, state.workspaceId, state.path);
    states.set(key, state);
  }
  let finalEdges: Edge[] = []; let finalGraphProof = '';
  try {
    for (const snapshot of input.snapshots) {
      if (workspaceIds.has(snapshot.workspaceId)) issue('duplicate-workspace', null, snapshot.workspaceId, '');
      workspaceIds.add(snapshot.workspaceId);
      const { snapshotProof, ...body } = snapshot;
      if (snapshot.contractVersion !== (contractVersion === 6 ? 5 : contractVersion === 4 ? 3 : contractVersion) || proof(body) !== snapshotProof) issue('snapshot-proof-mismatch', null, snapshot.workspaceId, '');
      const blockingGaps = contractVersion >= 5 && snapshot.contractVersion === 5
        ? workspaceMixedHtmlBlockingCoverageV5(snapshot) : snapshot.coverage.gaps;
      if (blockingGaps.length || !snapshot.coverage.complete && !snapshot.coverage.gaps.length) issue('incomplete-coverage', null, snapshot.workspaceId, '');
      for (const gap of blockingGaps) issue(gap.code, null, snapshot.workspaceId, gap.path);
      const paths = new Set<string>(); const identities = new Set<string>(); const inventories = new Map<string, AnyCompilerInventory>();
      const physical = new Map<string, AnyCompilerPhysical>();
      if (contractVersion >= 3 && snapshot.contractVersion === 3 || contractVersion >= 5 && snapshot.contractVersion === 5) for (const source of snapshot.physicalSources) {
        const { physicalSourceProof, ...physicalBody } = source;
        if (physical.has(source.path) || source.workspaceId !== snapshot.workspaceId
          || (contractVersion >= 5 ? source.parserVersion !== 4 : source.parserVersion !== undefined && source.parserVersion !== 2 && source.parserVersion !== 3)
          || source.physicalSourceVersion !== 1 || source.source !== 'original-physical-bytes' || source.encoding !== 'utf8'
          || !/\.(?:md|markdown)$/iu.test(source.path) || source.metadata.path !== source.path
          || (contractVersion >= 5 ? source.coverage.gaps.some(gap => gap.code !== 'uninspected-html')
            || !source.coverage.complete && !source.coverage.gaps.length : !source.coverage.complete || source.coverage.gaps.length) || source.executionReady !== false
          || source.applicability !== 'requires-import-and-rebinding'
          || !/^[a-f0-9]{64}$/u.test(source.physical.byteHash) || !Number.isSafeInteger(source.physical.byteLength) || source.physical.byteLength < 0
          || proof({ ...physicalBody, observedOriginalByteHash: source.physical.byteHash }) !== physicalSourceProof) {
          issue('invalid-physical-read-source', null, snapshot.workspaceId, source.path);
        }
        physical.set(source.path, source);
      }
      const organizations = new Set([...snapshot.documents.map((inventory) => inventory.document.organizationId),
        ...Array.from(physical.values(), source => source.organizationId)]);
      if (organizations.size > 1) issue('organization-conflict', null, snapshot.workspaceId, '');
      for (const inventory of snapshot.documents) {
        if (inventories.has(inventory.document.path) || documentIds.has(inventory.document.documentId)) issue('identity-conflict', null, snapshot.workspaceId, inventory.document.path);
        documentIds.add(inventory.document.documentId); inventories.set(inventory.document.path, inventory);
      }
      for (const entry of snapshot.namespace) {
        const inventory = inventories.get(entry.path);
        const physicalSource = physical.get(entry.path);
        if (!canonicalPath(entry.path) || !entry.identity || paths.has(entry.path) || identities.has(entry.identity) || entry.workspaceId !== snapshot.workspaceId
          || entry.kind === 'directory' && (entry.documentId !== null || entry.lifecycleGeneration !== null)) issue('identity-conflict', null, snapshot.workspaceId, entry.path);
        paths.add(entry.path); identities.add(entry.identity);
        if (entry.kind === 'file' && /\.mdx$/iu.test(entry.path)) issue('unsupported-source', null, snapshot.workspaceId, entry.path);
        if (entry.kind === 'file' && /\.html?$/iu.test(entry.path) && !inventory
          && !(contractVersion >= 5 && snapshot.contractVersion === 5 && snapshot.physicalHtmlSources.some(source => source.path === entry.path))) issue('uninspected-html', null, snapshot.workspaceId, entry.path);
        if (entry.kind === 'file' && (entry.documentId !== null || /\.(?:md|markdown)$/iu.test(entry.path)) && !inventory && !physicalSource) {
          issue('uninspected-source', null, snapshot.workspaceId, entry.path);
        }
        if (physicalSource && (inventory || entry.kind !== 'file' || entry.documentId !== null || entry.lifecycleGeneration !== null
          || entry.filesystemIdentity !== physicalSource.physical.filesystemIdentity || entry.identity !== entry.filesystemIdentity)) {
          issue('identity-conflict', null, snapshot.workspaceId, entry.path);
        }
        const entity: Entity = { entityKey: proof({ workspaceId: snapshot.workspaceId, identity: entry.identity }),
          workspaceId: entry.workspaceId, path: entry.path, kind: entry.kind, binding: { kind: 'existing', namespaceEvidence: structuredClone(entry),
            documentEvidenceKey: inventory ? stateKey(inventory.document) : null }, contentBasisProof: null, baseState: null, doc: null, inventory: null,
          physical: physicalSource ? structuredClone(physicalSource) : null, links: [] };
        entities.push(entity); allEntities.push(entity);
        if (!inventory) continue;
        const key = stateKey(inventory.document); const state = states.get(key); usedStates.add(key);
        if (entry.kind !== 'file' || entry.documentId !== inventory.document.documentId || entry.lifecycleGeneration !== inventory.document.lifecycleGeneration
          || inventory.document.workspaceId !== snapshot.workspaceId || (contractVersion >= 5
            ? inventory.coverage.gaps.some(gap => gap.code !== 'uninspected-html') || !inventory.coverage.complete && !inventory.coverage.gaps.length
            : !inventory.coverage.complete || inventory.coverage.gaps.length)) {
          issue('identity-conflict', null, snapshot.workspaceId, entry.path); continue;
        }
        if (!state) { issue('missing-native-state', null, snapshot.workspaceId, entry.path); continue; }
        try {
          const actual = contractVersion >= 5 ? inspectPersistedDocumentLinksV4(state) : inspectPersistedDocumentLinks(state);
          if (proof(actual) !== proof(inventory) || new Set(actual.links.map((link) => link.id)).size !== actual.links.length) {
            issue('native-state-mismatch', null, snapshot.workspaceId, entry.path); continue;
          }
          entity.baseState = structuredClone(state); entity.inventory = actual; entity.doc = new Y.Doc();
          Y.applyUpdate(entity.doc, state.yjsState); entity.contentBasisProof = contentProof(state);
          entity.links = actual.links.map((link) => ({ key: proof({ entityKey: entity.entityKey, linkId: link.id }), originEvidenceLinkId: link.id, current: link }));
          evidence.push({ evidenceKey: key, inventory: structuredClone(actual) });
        } catch { issue('unreadable-native-state', null, snapshot.workspaceId, entry.path); }
      }
      for (const inventory of snapshot.documents) if (!paths.has(inventory.document.path)) issue('orphan-native-inventory', null, snapshot.workspaceId, inventory.document.path);
      for (const source of physical.values()) if (!paths.has(source.path)) issue('orphan-physical-read-source', null, snapshot.workspaceId, source.path);
      const byPath = new Map(snapshot.namespace.map((entry) => [entry.path, entry]));
      for (const entry of snapshot.namespace) {
        let parentPath = path.posix.dirname(entry.path);
        while (parentPath !== '.' && parentPath !== '/') {
          if (byPath.get(parentPath)?.kind === 'file') issue('parent-is-file', null, snapshot.workspaceId, entry.path);
          parentPath = path.posix.dirname(parentPath);
        }
      }
    }
    for (const [key, state] of states) if (!usedStates.has(key)) issue('unbound-native-state', null, state.workspaceId, state.path);
    if (!input.requests.length) issue('empty-batch', null, '', '');
    if ((contractVersion === 4 || contractVersion === 6) && (input.requests.length !== 1 || input.requests[0]?.kind !== 'copy')) issue('import-copy-only', null, '', '');
    for (const [requestIndex, originalRequest] of input.requests.entries()) {
      if (issues.length) break;
      const request = structuredClone(originalRequest); const beforeEdges = graph(entities); const beforeGraphProof = graphProof(entities, beforeEdges);
      const { kind, sourceWorkspaceId, destinationWorkspaceId } = request;
      if (!['move', 'rename', 'copy', 'delete'].includes(kind)) issue('unsupported-operation', requestIndex, sourceWorkspaceId, '');
      if (!workspaceIds.has(sourceWorkspaceId) || !workspaceIds.has(destinationWorkspaceId)) issue('missing-workspace', requestIndex, sourceWorkspaceId, '');
      if (kind !== 'copy' && sourceWorkspaceId !== destinationWorkspaceId) issue('unsupported-cross-workspace-move', requestIndex, sourceWorkspaceId, '');
      if (!request.selections.length) issue('empty-selection', requestIndex, sourceWorkspaceId, '');
      const mapped = new Map<string, { source: Entity; destinationPath: string | null; copy: Entity | null }>();
      for (const selection of request.selections) {
        if (!canonicalPath(selection.sourcePath) || kind !== 'delete' && !canonicalPath(selection.destinationPath ?? '')) {
          issue('invalid-path', requestIndex, sourceWorkspaceId, selection.sourcePath); continue;
        }
        const selected = entities.filter((entity) => entity.workspaceId === sourceWorkspaceId && (entity.path === selection.sourcePath || entity.path.startsWith(`${selection.sourcePath}/`)));
        if (!selected.some((entity) => entity.path === selection.sourcePath)) issue('missing-source', requestIndex, sourceWorkspaceId, selection.sourcePath);
        if (kind !== 'delete' && kind !== 'copy' && selection.sourcePath === selection.destinationPath) issue('unchanged-source-path', requestIndex, sourceWorkspaceId, selection.sourcePath);
        if (kind !== 'delete' && sourceWorkspaceId === destinationWorkspaceId && selection.destinationPath?.startsWith(`${selection.sourcePath}/`)) issue('destination-inside-source', requestIndex, sourceWorkspaceId, selection.sourcePath);
        for (const entity of selected) {
          if (entity.physical && contractVersion !== 4 && contractVersion !== 6) issue('physical-source-import-required', requestIndex, sourceWorkspaceId, entity.path);
          if (mapped.has(entity.entityKey)) issue('overlapping-selection', requestIndex, sourceWorkspaceId, entity.path);
          mapped.set(entity.entityKey, { source: entity, destinationPath: kind === 'delete' ? null : `${selection.destinationPath}${entity.path.slice(selection.sourcePath.length)}`, copy: null });
        }
      }
      const destinations = new Set<string>();
      for (const mapping of mapped.values()) if (mapping.destinationPath !== null) {
        if (destinations.has(mapping.destinationPath)) issue('duplicate-destination', requestIndex, destinationWorkspaceId, mapping.destinationPath);
        destinations.add(mapping.destinationPath);
        const occupied = entities.find((entity) => entity.workspaceId === destinationWorkspaceId && entity.path === mapping.destinationPath);
        if (occupied && !(kind !== 'copy' && mapped.has(occupied.entityKey))) issue('destination-collision', requestIndex, destinationWorkspaceId, mapping.destinationPath);
        for (const parent of entities) if (parent.workspaceId === destinationWorkspaceId && parent.kind === 'file'
          && !(kind !== 'copy' && mapped.has(parent.entityKey)) && mapping.destinationPath.startsWith(`${parent.path}/`)) issue('destination-parent-is-file', requestIndex, destinationWorkspaceId, mapping.destinationPath);
        for (const other of mapped.values()) if (other.source.kind === 'file' && other.destinationPath && mapping.destinationPath.startsWith(`${other.destinationPath}/`)) issue('destination-parent-is-file', requestIndex, destinationWorkspaceId, mapping.destinationPath);
      }
      if (issues.length) break;
      const namespaceEffects: NativeMixedBatchPlan['steps'][number]['namespaceEffects'] = [];
      for (const mapping of mapped.values()) {
        const source = mapping.source;
        if (kind === 'copy') {
          const entityKey = proof({ requestIndex, sourceEntityKey: source.entityKey, destinationWorkspaceId, destinationPath: mapping.destinationPath });
          const copy: Entity = { ...source, entityKey, workspaceId: destinationWorkspaceId, path: mapping.destinationPath!,
            binding: { kind: (contractVersion === 4 || contractVersion === 6) && source.physical ? 'unbound-import' : 'unbound-copy', sourceEntityKey: source.entityKey, createdAtRequest: requestIndex },
            baseState: source.baseState && scratchState(source), doc: source.doc ? new Y.Doc() : null,
            inventory: source.inventory && structuredClone(source.inventory),
            links: source.links.map((link) => ({ ...link, key: proof({ entityKey, sourceVirtualLinkKey: link.key }), current: structuredClone(link.current) })) };
          if (copy.doc) Y.applyUpdate(copy.doc, copy.baseState!.yjsState);
          mapping.copy = copy; allEntities.push(copy); entities.push(copy);
          if ((contractVersion === 4 || contractVersion === 6) && source.physical) {
            if (!/\.(?:md|markdown)$/iu.test(copy.path)) issue('unsupported-import-destination', requestIndex, destinationWorkspaceId, copy.path);
            imports.push({ entityKey, sourceEntityKey: source.entityKey, requestIndex, sourceWorkspaceId, sourcePath: source.path,
              destinationWorkspaceId, destinationPath: copy.path, physicalSourceProof: source.physical.physicalSourceProof,
              physical: { ...source.physical.physical }, importPolicy: { version: 1, initialRepresentation: 'auto', parserVersion: (source.physical.parserVersion as 2 | 3 | 4 | undefined) ?? 2 },
              linkBindings: source.physical.links.map(link => ({ physicalLinkId: link.physicalLinkId,
                sourceVirtualLinkKey: proof({ entityKey: source.entityKey, physicalLinkId: link.physicalLinkId }),
                virtualLinkKey: proof({ entityKey, physicalLinkId: link.physicalLinkId }) })),
              applicability: 'requires-fresh-destination-import-and-occurrence-binding' } as NativeMixedRawImportRequirementV4 | NativeMixedRawImportRequirementV6);
          }
          if (copy.doc) clones.push({ entityKey, sourceEntityKey: source.entityKey, requestIndex, sourceWorkspaceId, sourcePath: source.path,
            sourceContentBasisProof: source.contentBasisProof, applicability: 'requires-fresh-clone-receipt-and-inventory',
            linkBindings: copy.links.map((link, index) => ({ virtualLinkKey: link.key, sourceVirtualLinkKey: source.links[index].key, originEvidenceLinkId: link.originEvidenceLinkId })) });
        }
        namespaceEffects.push({ entityKey: mapping.copy?.entityKey ?? source.entityKey, sourceEntityKey: source.entityKey,
          sourceWorkspaceId, sourcePath: source.path, destinationWorkspaceId, destinationPath: mapping.destinationPath });
      }
      const intents: NativeMixedBatchLinkIntent[] = [];
      const physicalIntents: NativeMixedPhysicalLinkIntentV4[] = [];
      const grouped = new Map<string, Array<{ logical: LogicalLink; intent: NativeMixedBatchLinkIntent }>>();
      for (const edge of beforeEdges) {
        if (edge.entity.workspaceId !== sourceWorkspaceId) continue;
        const sourceMap = mapped.get(edge.sourceEntityKey); const targetMap = edge.resolution.targetEntityKey ? mapped.get(edge.resolution.targetEntityKey) : undefined;
        if (kind === 'copy' && !sourceMap || kind === 'delete' && sourceMap || edge.link.current.classification !== 'local') continue;
        if (edge.resolution.status !== 'resolved' || !edge.resolution.targetEntityKey) {
          if (sourceMap) issue('unresolved-selected-source-link', requestIndex, sourceWorkspaceId, edge.entity.path, edge.originEvidenceLinkId);
          continue;
        }
        if (kind === 'copy' && sourceWorkspaceId !== destinationWorkspaceId && !targetMap) {
          issue('uncopied-cross-workspace-target', requestIndex, sourceWorkspaceId, edge.entity.path, edge.originEvidenceLinkId); continue;
        }
        if (!sourceMap && !targetMap) continue;
        if (edge.provider === 'physical-read') {
          if ((contractVersion === 4 || contractVersion === 6) && kind === 'copy' && sourceMap?.copy?.binding.kind === 'unbound-import') {
            const owner = sourceMap.copy, target = entities.find(entity => entity.entityKey === edge.resolution.targetEntityKey)!;
            // Native rich clones receive fresh structural block IDs. This
            // first Raw-import contract does not yet bind those fragments to
            // the genuine clone receipt; reject before any B1/FD effects.
            if (edge.link.current.fragment?.startsWith('^') && targetMap?.source.inventory
              && targetMap.source.inventory.document.representation !== 'plain_text') {
              issue('unsupported-import-native-block-fragment', requestIndex, sourceWorkspaceId, edge.entity.path, edge.originEvidenceLinkId);
              continue;
            }
            const targetPathAfter = targetMap?.destinationPath ?? target.path;
            // These are semantic path intents. Actual native syntax/anchors are
            // obtained from the genuine import binding, never invented here.
            const targetPathText = edge.link.current.kind === 'wiki' ? `/${targetPathAfter}`
              : edge.targetPathText.startsWith('/') ? `/${targetPathAfter}`
                : path.posix.relative(path.posix.dirname(owner.path), targetPathAfter) || path.posix.basename(targetPathAfter);
            const literal = `${targetPathText}${edge.link.current.fragment === null ? '' : `#${edge.link.current.fragment}`}`;
            owner.physicalLinkValues ??= new Map();
            owner.physicalLinkValues.set(edge.originEvidenceLinkId, { literal, targetPathText });
            physicalIntents.push({ virtualLinkKey: proof({ entityKey: owner.entityKey, physicalLinkId: edge.originEvidenceLinkId }),
              entityKey: owner.entityKey, physicalSourceProof: edge.entity.physical!.physicalSourceProof, physicalLinkId: edge.originEvidenceLinkId,
              action: 'rewrite', expectedSourceLiteral: edge.literal, expectedTargetPathText: edge.targetPathText,
              expectedTargetEntityKey: edge.resolution.targetEntityKey, targetEntityKeyAfter: targetMap?.copy?.entityKey ?? target.entityKey,
              targetPathAfter, fragment: edge.link.current.fragment, alias: edge.link.current.alias, embed: edge.link.current.embed,
              adapterCheck: 'physical-occurrence-to-native-forward-and-targeted-inverse' });
          }
          // A stable Wiki alias may still resolve to the same moved entity
          // without a byte change. The full after-graph below decides whether
          // this READ source actually requires import and a native rewrite.
          continue;
        }
        const owner = kind === 'copy' ? sourceMap!.copy! : edge.entity;
        const logical = kind === 'copy' ? owner.links.find((link) => link.originEvidenceLinkId === edge.originEvidenceLinkId)! : edge.link;
        const target = entities.find((entity) => entity.entityKey === edge.resolution.targetEntityKey)!;
        const action = kind === 'delete' ? 'unlink' : 'rewrite';
        const nextValue = action === 'unlink' ? null : nextTarget(edge, targetMap?.destinationPath ?? target.path,
          sourceMap?.destinationPath ?? edge.entity.path);
        if (action === 'rewrite' && nextValue === null || action === 'unlink' && logical.current.syntax.startsWith('reference-')) {
          issue('unsupported-target-format', requestIndex, sourceWorkspaceId, edge.entity.path, edge.originEvidenceLinkId); continue;
        }
        if (action === 'rewrite' && expectedValue(logical.current) === nextValue) continue;
        const intent: NativeMixedBatchLinkIntent = { virtualLinkKey: logical.key, entityKey: owner.entityKey,
          originEvidenceLinkId: logical.originEvidenceLinkId, action, expectedValue: expectedValue(logical.current), nextValue,
          expectedTargetEntityKey: edge.resolution.targetEntityKey,
          targetEntityKeyAfter: action === 'unlink' ? null : kind === 'copy' && targetMap ? targetMap.copy!.entityKey : edge.resolution.targetEntityKey,
          adapterCheck: 'native-forward-and-targeted-inverse' };
        intents.push(intent); const values = grouped.get(owner.entityKey) ?? []; values.push({ logical, intent }); grouped.set(owner.entityKey, values);
      }
      if (issues.length) break;
      for (const [entityKey, values] of grouped) {
        const entity = entities.find((candidate) => candidate.entityKey === entityKey)!;
        try {
          const state = scratchState(entity); const inventory = contractVersion >= 5 ? inspectPersistedDocumentLinksV4(state) : inspectPersistedDocumentLinks(state); const beforeContentProof = contentProof(state);
          const recipes: NativeLinkMutationRecipe[] = values.map(({ logical, intent }) => ({ linkId: logical.current.id,
            source: inventory.document, sourceVersion: inventory.version, reference: logical.current.ref,
            destinationWorkspaceId: inventory.document.workspaceId, sourcePathAfter: inventory.document.path, cloneSelection: null,
            action: intent.action, nextValue: intent.nextValue, expectedTargetIdentity: intent.expectedTargetEntityKey }));
          const mutationInput = { state, recipes, operationId: `mixed-batch-rehearsal:${requestIndex}:${entityKey}` };
          const prepared = contractVersion >= 5 ? prepareNativeLinkMutationsV4(mutationInput) : prepareNativeLinkMutations(mutationInput);
          Y.applyUpdate(entity.doc!, prepared.update);
          const afterState = scratchState(entity); const after = contractVersion >= 5 ? inspectPersistedDocumentLinksV4(afterState) : inspectPersistedDocumentLinks(afterState);
          const retained = entity.links.filter((link) => !values.some((value) => value.logical.key === link.key && value.intent.action === 'unlink'));
          if (retained.length !== after.links.length) throw new Error('link-shape-changed');
          for (const [ordinal, link] of retained.entries()) {
            const intent = values.find((value) => value.logical.key === link.key)?.intent; const next = after.links[ordinal];
            if (!intent && proof(linkMeaning(link.current)) !== proof(linkMeaning(next))
              || intent && (next.kind !== link.current.kind || next.syntax !== link.current.syntax || next.embed !== link.current.embed
                || next.alias !== link.current.alias || next.fragment !== link.current.fragment || expectedValue(next) !== intent.nextValue)) throw new Error('link-shape-changed');
            link.current = next;
          }
          entity.links = retained; entity.inventory = after; entity.contentBasisProof = contentProof(afterState);
          // Rehearse the targeted inverse now and the whole ordered chain below.
          const inverseInput = { state: afterState, inverseRecipes: prepared.inverseRecipes, operationId: `mixed-batch-inverse:${requestIndex}:${entityKey}` };
          const inverse = contractVersion >= 5 ? prepareNativeLinkInverseV4(inverseInput) : prepareNativeLinkInverse(inverseInput);
          const check = new Y.Doc();
          try {
            Y.applyUpdate(check, afterState.yjsState); Y.applyUpdate(check, inverse.update);
            if (contentProof({ ...state, yjsState: Y.encodeStateAsUpdate(check), stateVector: Y.encodeStateVector(check) }) !== beforeContentProof) throw new Error('inverse-effect-changed');
          } finally { check.destroy(); }
          undo.push({ entity, recipes: prepared.inverseRecipes, beforeContentProof, requestIndex });
        } catch { issue('native-adapter-or-inverse-unavailable', requestIndex, entity.workspaceId, entity.path); }
      }
      if (issues.length) break;
      for (const mapping of mapped.values()) if (kind !== 'copy') {
        if (kind === 'delete') entities.splice(entities.indexOf(mapping.source), 1);
        else { mapping.source.path = mapping.destinationPath!; mapping.source.workspaceId = destinationWorkspaceId; }
      }
      const afterEdges = graph(entities); const afterByKey = new Map(afterEdges.map((edge) => [edge.virtualLinkKey, edge]));
      for (const edge of beforeEdges) {
        if (kind === 'delete' && mapped.has(edge.sourceEntityKey)) continue;
        if (intents.some((intent) => intent.virtualLinkKey === edge.virtualLinkKey && intent.action === 'unlink')) continue;
        const after = afterByKey.get(edge.virtualLinkKey);
        if (!after || proof(edge.resolution) !== proof(after.resolution)) issue(edge.provider === 'physical-read'
          ? 'physical-source-import-required' : 'resolution-changed', requestIndex, edge.entity.workspaceId, edge.entity.path, edge.originEvidenceLinkId);
      }
      if (kind === 'copy') for (const mapping of mapped.values()) {
        for (const old of beforeEdges.filter((edge) => edge.sourceEntityKey === mapping.source.entityKey)) {
          const copied = mapping.copy!.links.find((link) => link.originEvidenceLinkId === old.originEvidenceLinkId);
          const after = (contractVersion === 4 || contractVersion === 6) && mapping.copy!.binding.kind === 'unbound-import'
            ? afterByKey.get(proof({ entityKey: mapping.copy!.entityKey, physicalLinkId: old.originEvidenceLinkId }))
            : copied && afterByKey.get(copied.key);
          const targetMap = old.resolution.targetEntityKey ? mapped.get(old.resolution.targetEntityKey) : undefined;
          const expected = targetMap ? targetMap.copy!.entityKey : old.resolution.targetEntityKey;
          if (!after || after.resolution.status !== old.resolution.status || old.link.current.classification === 'local'
            && (after.resolution.status !== 'resolved' || after.resolution.targetEntityKey !== expected)) issue('copied-resolution-changed', requestIndex, destinationWorkspaceId, mapping.destinationPath!, old.originEvidenceLinkId);
        }
      }
      steps.push({ requestIndex, request, beforeGraphProof, afterGraphProof: graphProof(entities, afterEdges), namespaceEffects, linkIntents: intents,
        ...((contractVersion === 4 || contractVersion === 6) ? { physicalLinkIntents: physicalIntents } : {}) });
    }
    if (!issues.length) { finalEdges = graph(entities); finalGraphProof = graphProof(entities, finalEdges); }
    if (!issues.length) for (const check of [...undo].reverse()) {
      try {
        const inverseInput = { state: scratchState(check.entity), inverseRecipes: check.recipes,
          operationId: `mixed-batch-chain-inverse:${check.requestIndex}:${check.entity.entityKey}` };
        const inverse = contractVersion >= 5 ? prepareNativeLinkInverseV4(inverseInput) : prepareNativeLinkInverse(inverseInput);
        Y.applyUpdate(check.entity.doc!, inverse.update);
        if (contentProof(scratchState(check.entity)) !== check.beforeContentProof) throw new Error('inverse-effect-changed');
      } catch { issue('batch-inverse-unavailable', check.requestIndex, check.entity.workspaceId, check.entity.path); break; }
    }
    const body = { contractVersion, compilerVersion: 1 as const,
      ...(contractVersion >= 5 ? { htmlAssessment: htmlPlan!.htmlAssessment, htmlAssessmentProof: htmlPlan!.htmlAssessmentProof,
        sourceCoverage: htmlPlan!.sourceCoverage } : {}),
      readiness: issues.length ? 'blocked' as const : imports.length ? 'requires-import-rebinding' as const : clones.length ? 'requires-clone-rebinding' as const : 'ready' as const, executionReady: false as const,
      requests: structuredClone([...input.requests]),
      snapshotProofs: input.snapshots.map((snapshot) => ({ workspaceId: snapshot.workspaceId, proof: snapshot.snapshotProof })).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
      documentEvidence: evidence.sort((a, b) => a.evidenceKey.localeCompare(b.evidenceKey)), steps, cloneRequirements: clones,
      ...((contractVersion === 4 || contractVersion === 6) ? { rawImportRequirements: imports } : {}),
      finalNamespace: issues.length ? [] : entities.map(publicEntity).sort((a, b) => a.entityKey.localeCompare(b.entityKey)),
      finalEdges: issues.length ? [] : finalEdges.map(publicEdge), finalGraphProof: issues.length ? null : finalGraphProof, issues,
      requiredCoordinatorBindings: ['actor-session-request-review-and-current-authority', 'complete-current-namespace-and-native-graph',
        'kernel-lifecycle-fence-and-exact-registry-path-receipts', 'fresh-durable-native-states-and-targeted-inverse-receipts',
        'fresh-copy-identities-block-id-map-and-link-rebinding'] as const };
    return { ...body, planId: proof(body) } as NativeMixedBatchPlan | NativeMixedReadBatchPlanV3 | NativeMixedImportCopyBatchPlanV4 | NativeMixedHtmlBatchPlanV5 | NativeMixedHtmlImportCopyBatchPlanV6;
  } finally { for (const entity of allEntities) entity.doc?.destroy(); }
}

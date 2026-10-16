import 'server-only';

import path from 'node:path';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import { Y } from '../collaboration/server-runtime';
import { parseObsidianWikiTarget } from './obsidian-flavored-markdown';
import { getCanvasNotebookExactLinkTarget } from './obsidian-link-resolver';
import { resolveWorkspaceWikiFileLink } from './workspace-link-index-core';
import { resolveExactWorkspaceLink } from './workspace-local-link-parser';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from './workspace-native-link-inventory';
import { prepareNativeLinkInverse, prepareNativeLinkMutations, type NativeLinkInverseRecipe } from './workspace-native-link-mutations';
import type { NativeDocumentLink, NativeDocumentLinkInventory, NativeLinkMutationRecipe, NativeNamespaceEntry,
  NativeWorkspaceFileOperationPlan, NativeWorkspaceLinkSnapshot } from './workspace-link-contract-v2';

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
};

export type NativeMixedBatchVirtualEdge = {
  virtualLinkKey: string;
  sourceEntityKey: string;
  originEvidenceLinkId: string;
  literal: string;
  targetPathText: string;
  resolution: { status: string; targetEntityKey: string | null; candidateEntityKeys: string[] };
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

type LogicalLink = { key: string; originEvidenceLinkId: string; current: NativeDocumentLink };
type Entity = Omit<NativeMixedBatchVirtualEntity, 'metadata'> & {
  baseState: PersistedCollaborationState | null;
  doc: InstanceType<typeof Y.Doc> | null;
  inventory: NativeDocumentLinkInventory | null;
  links: LogicalLink[];
};
type Edge = NativeMixedBatchVirtualEdge & { entity: Entity; link: LogicalLink };
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
function publicEntity(entity: Entity): NativeMixedBatchVirtualEntity {
  const metadata = entity.inventory?.metadata;
  return { entityKey: entity.entityKey, workspaceId: entity.workspaceId, path: entity.path, kind: entity.kind,
    binding: entity.binding, contentBasisProof: entity.contentBasisProof,
    metadata: metadata ? { ...metadata, path: entity.path,
      title: metadata.hasExplicitTitle || metadata.headings.length ? metadata.title : entity.path.split('/').at(-1)!.replace(/\.(?:md|markdown)$/iu, '') } : null };
}
function publicEdge(edge: Edge): NativeMixedBatchVirtualEdge {
  return { virtualLinkKey: edge.virtualLinkKey, sourceEntityKey: edge.sourceEntityKey, originEvidenceLinkId: edge.originEvidenceLinkId,
    literal: edge.literal, targetPathText: edge.targetPathText, resolution: edge.resolution };
}
function graph(entities: Entity[]): Edge[] {
  const edges: Edge[] = [];
  const workspaces = new Map<string, { byPath: Map<string, Entity>; paths: Set<string>;
    nativeTargetPaths: Set<string>;
    candidates: Array<{ path: string; aliases: string[]; extension: string | undefined; type: 'file' }> }>();
  for (const entity of entities) {
    if (!entity.links.length) continue;
    let workspace = workspaces.get(entity.workspaceId);
    if (!workspace) {
      const files = entities.filter((candidate) => candidate.workspaceId === entity.workspaceId && candidate.kind === 'file');
      const byPath = new Map(files.map((candidate) => [candidate.path, candidate]));
      workspace = { byPath, paths: new Set(byPath.keys()), nativeTargetPaths: new Set(files.filter(candidate => candidate.inventory).map(candidate => candidate.path)),
        candidates: files.filter((candidate) => candidate.inventory).map((candidate) => ({ path: candidate.path,
          aliases: candidate.inventory!.metadata.aliases, extension: candidate.path.split('.').at(-1), type: 'file' as const })) };
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
      edges.push({ virtualLinkKey: link.key, sourceEntityKey: entity.entityKey, originEvidenceLinkId: link.originEvidenceLinkId,
        literal: value.literal, targetPathText: value.targetPathText, entity, link,
        resolution: { status: resolution.status, targetEntityKey: resolution.path ? byPath.get(resolution.path)?.entityKey ?? null : null,
          candidateEntityKeys: resolution.candidates.map((candidate) => byPath.get(candidate)!.entityKey).sort() } });
    }
  }
  return edges.sort((a, b) => a.virtualLinkKey.localeCompare(b.virtualLinkKey));
}
function graphProof(entities: Entity[], edges: Edge[]): string {
  return proof({ namespace: entities.map(publicEntity).sort((a, b) => a.entityKey.localeCompare(b.entityKey)),
    edges: edges.map(publicEdge) });
}
function nextTarget(edge: Edge, targetPath: string, sourcePath: string): string | null {
  const link = edge.link.current;
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
  const issues: NativeMixedBatchPlan['issues'] = [];
  const issue = (code: string, requestIndex: number | null, workspaceId: string, pathValue: string, linkId?: string) =>
    issues.push({ code, requestIndex, workspaceId, path: pathValue, ...(linkId ? { linkId } : {}) });
  const entities: Entity[] = []; const allEntities: Entity[] = []; const evidence: NativeMixedBatchPlan['documentEvidence'] = [];
  const steps: NativeMixedBatchPlan['steps'] = []; const clones: NativeMixedBatchPlan['cloneRequirements'] = [];
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
      if (snapshot.contractVersion !== 2 || proof(body) !== snapshotProof) issue('snapshot-proof-mismatch', null, snapshot.workspaceId, '');
      if (!snapshot.coverage.complete || snapshot.coverage.gaps.length) issue('incomplete-coverage', null, snapshot.workspaceId, '');
      for (const gap of snapshot.coverage.gaps) issue(gap.code, null, snapshot.workspaceId, gap.path);
      const paths = new Set<string>(); const identities = new Set<string>(); const inventories = new Map<string, NativeDocumentLinkInventory>();
      const organizations = new Set(snapshot.documents.map((inventory) => inventory.document.organizationId));
      if (organizations.size > 1) issue('organization-conflict', null, snapshot.workspaceId, '');
      for (const inventory of snapshot.documents) {
        if (inventories.has(inventory.document.path) || documentIds.has(inventory.document.documentId)) issue('identity-conflict', null, snapshot.workspaceId, inventory.document.path);
        documentIds.add(inventory.document.documentId); inventories.set(inventory.document.path, inventory);
      }
      for (const entry of snapshot.namespace) {
        const inventory = inventories.get(entry.path);
        if (!canonicalPath(entry.path) || !entry.identity || paths.has(entry.path) || identities.has(entry.identity) || entry.workspaceId !== snapshot.workspaceId
          || entry.kind === 'directory' && (entry.documentId !== null || entry.lifecycleGeneration !== null)) issue('identity-conflict', null, snapshot.workspaceId, entry.path);
        paths.add(entry.path); identities.add(entry.identity);
        if (entry.kind === 'file' && /\.mdx$/iu.test(entry.path)) issue('unsupported-source', null, snapshot.workspaceId, entry.path);
        if (entry.kind === 'file' && /\.html?$/iu.test(entry.path) && !inventory) issue('uninspected-html', null, snapshot.workspaceId, entry.path);
        if (entry.kind === 'file' && (entry.documentId !== null || /\.(?:md|markdown)$/iu.test(entry.path)) && !inventory) {
          issue('uninspected-source', null, snapshot.workspaceId, entry.path);
        }
        const entity: Entity = { entityKey: proof({ workspaceId: snapshot.workspaceId, identity: entry.identity }),
          workspaceId: entry.workspaceId, path: entry.path, kind: entry.kind, binding: { kind: 'existing', namespaceEvidence: structuredClone(entry),
            documentEvidenceKey: inventory ? stateKey(inventory.document) : null }, contentBasisProof: null, baseState: null, doc: null, inventory: null, links: [] };
        entities.push(entity); allEntities.push(entity);
        if (!inventory) continue;
        const key = stateKey(inventory.document); const state = states.get(key); usedStates.add(key);
        if (entry.kind !== 'file' || entry.documentId !== inventory.document.documentId || entry.lifecycleGeneration !== inventory.document.lifecycleGeneration
          || inventory.document.workspaceId !== snapshot.workspaceId || !inventory.coverage.complete || inventory.coverage.gaps.length) {
          issue('identity-conflict', null, snapshot.workspaceId, entry.path); continue;
        }
        if (!state) { issue('missing-native-state', null, snapshot.workspaceId, entry.path); continue; }
        try {
          const actual = inspectPersistedDocumentLinks(state);
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
            binding: { kind: 'unbound-copy', sourceEntityKey: source.entityKey, createdAtRequest: requestIndex },
            baseState: source.baseState && scratchState(source), doc: source.doc ? new Y.Doc() : null,
            inventory: source.inventory && structuredClone(source.inventory),
            links: source.links.map((link) => ({ ...link, key: proof({ entityKey, sourceVirtualLinkKey: link.key }), current: structuredClone(link.current) })) };
          if (copy.doc) Y.applyUpdate(copy.doc, copy.baseState!.yjsState);
          mapping.copy = copy; allEntities.push(copy); entities.push(copy);
          if (copy.doc) clones.push({ entityKey, sourceEntityKey: source.entityKey, requestIndex, sourceWorkspaceId, sourcePath: source.path,
            sourceContentBasisProof: source.contentBasisProof, applicability: 'requires-fresh-clone-receipt-and-inventory',
            linkBindings: copy.links.map((link, index) => ({ virtualLinkKey: link.key, sourceVirtualLinkKey: source.links[index].key, originEvidenceLinkId: link.originEvidenceLinkId })) });
        }
        namespaceEffects.push({ entityKey: mapping.copy?.entityKey ?? source.entityKey, sourceEntityKey: source.entityKey,
          sourceWorkspaceId, sourcePath: source.path, destinationWorkspaceId, destinationPath: mapping.destinationPath });
      }
      const intents: NativeMixedBatchLinkIntent[] = [];
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
          const state = scratchState(entity); const inventory = inspectPersistedDocumentLinks(state); const beforeContentProof = contentProof(state);
          const recipes: NativeLinkMutationRecipe[] = values.map(({ logical, intent }) => ({ linkId: logical.current.id,
            source: inventory.document, sourceVersion: inventory.version, reference: logical.current.ref,
            destinationWorkspaceId: inventory.document.workspaceId, sourcePathAfter: inventory.document.path, cloneSelection: null,
            action: intent.action, nextValue: intent.nextValue, expectedTargetIdentity: intent.expectedTargetEntityKey }));
          const prepared = prepareNativeLinkMutations({ state, recipes, operationId: `mixed-batch-rehearsal:${requestIndex}:${entityKey}` });
          Y.applyUpdate(entity.doc!, prepared.update);
          const afterState = scratchState(entity); const after = inspectPersistedDocumentLinks(afterState);
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
          const inverse = prepareNativeLinkInverse({ state: afterState, inverseRecipes: prepared.inverseRecipes, operationId: `mixed-batch-inverse:${requestIndex}:${entityKey}` });
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
        if (!after || proof(edge.resolution) !== proof(after.resolution)) issue('resolution-changed', requestIndex, edge.entity.workspaceId, edge.entity.path, edge.originEvidenceLinkId);
      }
      if (kind === 'copy') for (const mapping of mapped.values()) {
        for (const old of beforeEdges.filter((edge) => edge.sourceEntityKey === mapping.source.entityKey)) {
          const copied = mapping.copy!.links.find((link) => link.originEvidenceLinkId === old.originEvidenceLinkId);
          const after = copied && afterByKey.get(copied.key);
          const targetMap = old.resolution.targetEntityKey ? mapped.get(old.resolution.targetEntityKey) : undefined;
          const expected = targetMap ? targetMap.copy!.entityKey : old.resolution.targetEntityKey;
          if (!after || after.resolution.status !== old.resolution.status || old.link.current.classification === 'local'
            && (after.resolution.status !== 'resolved' || after.resolution.targetEntityKey !== expected)) issue('copied-resolution-changed', requestIndex, destinationWorkspaceId, mapping.destinationPath!, old.originEvidenceLinkId);
        }
      }
      steps.push({ requestIndex, request, beforeGraphProof, afterGraphProof: graphProof(entities, afterEdges), namespaceEffects, linkIntents: intents });
    }
    if (!issues.length) { finalEdges = graph(entities); finalGraphProof = graphProof(entities, finalEdges); }
    if (!issues.length) for (const check of [...undo].reverse()) {
      try {
        const inverse = prepareNativeLinkInverse({ state: scratchState(check.entity), inverseRecipes: check.recipes,
          operationId: `mixed-batch-chain-inverse:${check.requestIndex}:${check.entity.entityKey}` });
        Y.applyUpdate(check.entity.doc!, inverse.update);
        if (contentProof(scratchState(check.entity)) !== check.beforeContentProof) throw new Error('inverse-effect-changed');
      } catch { issue('batch-inverse-unavailable', check.requestIndex, check.entity.workspaceId, check.entity.path); break; }
    }
    const body: Omit<NativeMixedBatchPlan, 'planId'> = { contractVersion: 2, compilerVersion: 1,
      readiness: issues.length ? 'blocked' : clones.length ? 'requires-clone-rebinding' : 'ready', executionReady: false,
      requests: structuredClone([...input.requests]),
      snapshotProofs: input.snapshots.map((snapshot) => ({ workspaceId: snapshot.workspaceId, proof: snapshot.snapshotProof })).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
      documentEvidence: evidence.sort((a, b) => a.evidenceKey.localeCompare(b.evidenceKey)), steps, cloneRequirements: clones,
      finalNamespace: issues.length ? [] : entities.map(publicEntity).sort((a, b) => a.entityKey.localeCompare(b.entityKey)),
      finalEdges: issues.length ? [] : finalEdges.map(publicEdge), finalGraphProof: issues.length ? null : finalGraphProof, issues,
      requiredCoordinatorBindings: ['actor-session-request-review-and-current-authority', 'complete-current-namespace-and-native-graph',
        'kernel-lifecycle-fence-and-exact-registry-path-receipts', 'fresh-durable-native-states-and-targeted-inverse-receipts',
        'fresh-copy-identities-block-id-map-and-link-rebinding'] };
    return { ...body, planId: proof(body) };
  } finally { for (const entity of allEntities) entity.doc?.destroy(); }
}

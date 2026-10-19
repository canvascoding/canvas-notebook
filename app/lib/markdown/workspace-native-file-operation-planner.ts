import path from 'node:path';
import { parseObsidianWikiTarget } from './obsidian-flavored-markdown';
import { getCanvasNotebookExactLinkTarget } from './obsidian-link-resolver';
import { buildWorkspaceMixedReadLinkGraphV3, buildWorkspaceNativeLinkGraph } from './workspace-native-link-graph';
import { nativeLinkJsonProof } from './workspace-native-link-inventory';
import type { NativeLinkMutationRecipe,
  NativeResolvedLink, NativeWorkspaceFileOperationPlan, NativeWorkspaceLinkSnapshot } from './workspace-link-contract-v2';
import type { FilePlanV3, MixedReadResolvedLinkV3, WorkspaceMixedReadLinkSnapshotV3 } from './workspace-link-contract-v3';

export type NativeWorkspaceFileOperationRequest = {
  kind: NativeWorkspaceFileOperationPlan['kind'];
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  selections: Array<{ sourcePath: string; destinationPath?: string }>;
  snapshots: NativeWorkspaceLinkSnapshot[];
};

export type WorkspaceMixedReadFileOperationRequestV3 = Omit<NativeWorkspaceFileOperationRequest, 'snapshots'> & {
  snapshots: WorkspaceMixedReadLinkSnapshotV3[];
};

function mixedReadGraph(snapshot: NativeWorkspaceLinkSnapshot | WorkspaceMixedReadLinkSnapshotV3, version: 2 | 3) {
  return version === 3 && snapshot.contractVersion === 3 ? buildWorkspaceMixedReadLinkGraphV3(snapshot)
    // The V2 API keeps its historical graph even for a malformed version;
    // the core separately records that version mismatch as a blocking issue.
    : buildWorkspaceNativeLinkGraph(snapshot as NativeWorkspaceLinkSnapshot);
}

function canonicalPath(value: string): boolean {
  return Boolean(value) && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
    && !value.split('/').some((part) => !part || part === '.' || part === '..');
}

function formatNativeTarget(edge: NativeResolvedLink, targetPath: string, sourcePath: string): string | null {
  if (edge.kind === 'wiki') {
    if (/[#|\]\\]/u.test(targetPath)) return null;
    const old = parseObsidianWikiTarget(edge.ref.kind === 'node-attribute' ? edge.ref.expected : edge.literal);
    if (!old) return null;
    const file = !/\.(?:md|markdown)$/iu.test(old.path) ? targetPath.replace(/\.(?:md|markdown)$/iu, '') : targetPath;
    const fragment = edge.fragment === null ? '' : `#${edge.fragment}`;
    const alias = edge.ref.kind === 'node-attribute' && old.alias ? `|${old.alias}` : '';
    return `/${file}${fragment}${alias}`;
  }
  if (getCanvasNotebookExactLinkTarget(edge.literal)) return null;
  let value = edge.targetPathText.startsWith('/') ? `/${targetPath}`
    : path.posix.relative(path.posix.dirname(sourcePath), targetPath) || path.posix.basename(targetPath);
  if (!value.startsWith('/') && /^[a-z][a-z0-9+.-]*:/iu.test(value)) value = `./${value}`;
  // Native URL attrs and plain Markdown accept this percent-escaped path. This
  // also avoids accidentally creating Markdown delimiters in a plain target.
  value = encodeURI(value).replace(/#/gu, '%23').replace(/\?/gu, '%3F')
    .replace(/\(/gu, '%28').replace(/\)/gu, '%29').replace(/\[/gu, '%5B').replace(/\]/gu, '%5D')
    .replace(/</gu, '%3C').replace(/>/gu, '%3E').replace(/\|/gu, '%7C');
  return `${value}${edge.fragment === null ? '' : `#${edge.fragment}`}`;
}

/** A server constructs this from proven native snapshots. V1 plans remain a
 * distinct contract. This function neither imports source bytes nor edits Yjs. */
export function createWorkspaceNativeFileOperationPlan(request: NativeWorkspaceFileOperationRequest): NativeWorkspaceFileOperationPlan {
  return createWorkspaceFileOperationPlanCore(request, 2);
}

/** Physical inventories are read evidence. This planner never initializes a
 * source or emits a native mutation reference for a physical span. */
export function createWorkspaceMixedReadFileOperationPlanV3(request: WorkspaceMixedReadFileOperationRequestV3): FilePlanV3 {
  return createWorkspaceFileOperationPlanCore(request, 3);
}

function createWorkspaceFileOperationPlanCore(request: NativeWorkspaceFileOperationRequest, version: 2): NativeWorkspaceFileOperationPlan;
function createWorkspaceFileOperationPlanCore(request: WorkspaceMixedReadFileOperationRequestV3, version: 3): FilePlanV3;
function createWorkspaceFileOperationPlanCore(request: NativeWorkspaceFileOperationRequest | WorkspaceMixedReadFileOperationRequestV3,
  version: 2 | 3): NativeWorkspaceFileOperationPlan | FilePlanV3 {
  const issues: NativeWorkspaceFileOperationPlan['issues'] = [];
  const issue = (code: string, workspaceId: string, pathValue: string, linkId?: string) =>
    issues.push({ code, workspaceId, path: pathValue, ...(linkId ? { linkId } : {}) });
  const snapshots = new Map<string, NativeWorkspaceLinkSnapshot | WorkspaceMixedReadLinkSnapshotV3>(request.snapshots.map((snapshot) => [snapshot.workspaceId, snapshot]));
  for (const snapshot of request.snapshots) {
    const { snapshotProof: _proof, ...body } = snapshot;
    if (snapshot.contractVersion !== version || nativeLinkJsonProof(body) !== snapshot.snapshotProof) issue('snapshot-proof-mismatch', snapshot.workspaceId, '');
    if (!snapshot.coverage.complete || snapshot.coverage.gaps.length) {
      issue('incomplete-coverage', snapshot.workspaceId, '');
      for (const gap of snapshot.coverage.gaps) issue(gap.code, snapshot.workspaceId, gap.path);
    }
    const paths = new Set<string>(); const identities = new Set<string>();
    for (const entry of snapshot.namespace) {
      if (!canonicalPath(entry.path) || paths.has(entry.path) || identities.has(entry.identity)
        || entry.workspaceId !== snapshot.workspaceId) issue('identity-conflict', snapshot.workspaceId, entry.path);
      paths.add(entry.path); identities.add(entry.identity);
      if (entry.kind === 'file' && /\.mdx$/iu.test(entry.path)) issue('unsupported-source', snapshot.workspaceId, entry.path);
      if (entry.kind === 'file' && /\.(?:md|markdown)$/iu.test(entry.path)
        && !snapshot.documents.some((inventory) => inventory.document.path === entry.path)
        && !(version === 3 && snapshot.contractVersion === 3 && snapshot.physicalSources.some(inventory => inventory.path === entry.path))) issue('uninspected-source', snapshot.workspaceId, entry.path);
    }
    for (const inventory of snapshot.documents) {
      if (inventory.parserVersion !== 2) issue('stale-source-parser', snapshot.workspaceId, inventory.document.path);
      const registered = snapshot.namespace.find((entry) => entry.path === inventory.document.path);
      if (!registered || registered.documentId !== inventory.document.documentId
        || registered.lifecycleGeneration !== inventory.document.lifecycleGeneration
        || inventory.document.workspaceId !== snapshot.workspaceId || !inventory.coverage.complete
        || inventory.coverage.gaps.length) issue('identity-conflict', snapshot.workspaceId, inventory.document.path);
    }
    if (version === 3 && snapshot.contractVersion === 3) {
      const physicalPaths = new Set<string>();
      for (const inventory of snapshot.physicalSources) {
        const registered = snapshot.namespace.find(entry => entry.path === inventory.path);
        const { physicalSourceProof, ...physicalBody } = inventory;
        if (!canonicalPath(inventory.path) || physicalPaths.has(inventory.path)
          || snapshot.documents.some(document => document.document.path === inventory.path)
          || !registered || registered.kind !== 'file' || registered.documentId !== null || registered.lifecycleGeneration !== null
          || registered.filesystemIdentity !== inventory.physical.filesystemIdentity || registered.identity !== inventory.physical.filesystemIdentity
          || inventory.workspaceId !== snapshot.workspaceId || inventory.metadata.path !== inventory.path
          || inventory.physicalSourceVersion !== 1 || inventory.parserVersion !== 2 || inventory.source !== 'original-physical-bytes'
          || inventory.encoding !== 'utf8' || inventory.executionReady !== false || inventory.applicability !== 'requires-import-and-rebinding'
          || !inventory.coverage.complete || inventory.coverage.gaps.length
          || !/\.(?:md|markdown)$/iu.test(inventory.path)
          || !/^[a-f0-9]{64}$/u.test(inventory.physical.byteHash) || !Number.isSafeInteger(inventory.physical.byteLength) || inventory.physical.byteLength < 0
          || nativeLinkJsonProof({ ...physicalBody, observedOriginalByteHash: inventory.physical.byteHash }) !== physicalSourceProof) {
          issue('physical-source-proof-mismatch', snapshot.workspaceId, inventory.path);
        }
        physicalPaths.add(inventory.path);
      }
    }
  }
  if (snapshots.size !== request.snapshots.length) issue('duplicate-workspace', request.sourceWorkspaceId, '');
  const source = snapshots.get(request.sourceWorkspaceId);
  const destination = snapshots.get(request.destinationWorkspaceId);
  if (!source || !destination) issue('missing-workspace', request.sourceWorkspaceId, '');
  if (request.kind !== 'copy' && request.sourceWorkspaceId !== request.destinationWorkspaceId) issue('unsupported-cross-workspace-move', request.sourceWorkspaceId, '');
  if (!request.selections.length) issue('empty-selection', request.sourceWorkspaceId, '');
  const mapped = new Map<string, NativeWorkspaceFileOperationPlan['pathMappings'][number]>();
  const selectionForPath = new Map<string, string>();
  for (const selection of request.selections) {
    if (!canonicalPath(selection.sourcePath) || request.kind !== 'delete' && !canonicalPath(selection.destinationPath ?? '')) {
      issue('invalid-path', request.sourceWorkspaceId, selection.sourcePath); continue;
    }
    const selected = source?.namespace.filter((entry) => entry.path === selection.sourcePath || entry.path.startsWith(`${selection.sourcePath}/`)) ?? [];
    if (!selected.some((entry) => entry.path === selection.sourcePath)) issue('missing-source', request.sourceWorkspaceId, selection.sourcePath);
    if (request.kind !== 'delete' && request.kind !== 'copy' && selection.sourcePath === selection.destinationPath) issue('unchanged-source-path', request.sourceWorkspaceId, selection.sourcePath);
    if (request.kind !== 'delete' && selection.destinationPath?.startsWith(`${selection.sourcePath}/`)
      && request.sourceWorkspaceId === request.destinationWorkspaceId) issue('destination-inside-source', request.sourceWorkspaceId, selection.sourcePath);
    for (const entry of selected) {
      if (mapped.has(entry.path)) { issue('overlapping-selection', request.sourceWorkspaceId, entry.path); continue; }
      mapped.set(entry.path, { source: entry, destinationPath: request.kind === 'delete' ? ''
        : `${selection.destinationPath}${entry.path.slice(selection.sourcePath.length)}`, destinationWorkspaceId: request.destinationWorkspaceId });
      selectionForPath.set(entry.path, selection.sourcePath);
      if (version === 3 && source?.contractVersion === 3 && source.physicalSources.some(inventory => inventory.path === entry.path)) {
        issue('physical-source-import-required', request.sourceWorkspaceId, entry.path);
      }
    }
  }
  const destinations = new Set<string>();
  for (const mapping of mapped.values()) {
    if (request.kind === 'delete') continue;
    if (destinations.has(mapping.destinationPath)) issue('duplicate-destination', request.destinationWorkspaceId, mapping.destinationPath);
    destinations.add(mapping.destinationPath);
    const occupied = destination?.namespace.find((entry) => entry.path === mapping.destinationPath);
    const vacated = request.kind !== 'copy' && mapped.has(mapping.destinationPath);
    if (occupied && !vacated) issue('destination-collision', request.destinationWorkspaceId, mapping.destinationPath);
    for (const entry of destination?.namespace ?? []) if (entry.kind === 'file' && mapping.destinationPath.startsWith(`${entry.path}/`)) {
      issue('destination-parent-is-file', request.destinationWorkspaceId, mapping.destinationPath);
    }
  }
  const mutations: NativeLinkMutationRecipe[] = [];
  const sourceGraph = source && mixedReadGraph(source, version);
  for (const candidate of sourceGraph?.edges ?? []) {
    if (version === 3 && 'sourceKind' in candidate && candidate.sourceKind === 'physical-read') continue;
    // V2 retains its historical treatment of extra inventory properties. The
    // V3 discriminator above removes every actual physical READ edge.
    const edge = candidate as NativeResolvedLink;
    const sourceMapping = mapped.get(edge.source.path);
    const targetMapping = edge.resolution.target && mapped.get(edge.resolution.target.path);
    if (request.kind === 'copy' && !sourceMapping || request.kind === 'delete' && sourceMapping) continue;
    if (edge.classification !== 'local') continue;
    if (edge.resolution.status !== 'resolved' || !edge.resolution.target) {
      if (sourceMapping) issue('unresolved-selected-source-link', request.sourceWorkspaceId, edge.source.path, edge.id);
      continue;
    }
    if (request.kind === 'copy' && request.sourceWorkspaceId !== request.destinationWorkspaceId && !targetMapping) {
      issue('uncopied-cross-workspace-target', request.destinationWorkspaceId, sourceMapping!.destinationPath, edge.id); continue;
    }
    if (!sourceMapping && !targetMapping) continue;
    const inventory = source!.documents.find((entry) => entry.document.documentId === edge.source.documentId)!;
    const sourcePathAfter = sourceMapping?.destinationPath || edge.source.path;
    const action = request.kind === 'delete' ? 'unlink' : 'rewrite';
    const nextValue = action === 'unlink' ? null : formatNativeTarget(edge, targetMapping?.destinationPath ?? edge.resolution.target.path, sourcePathAfter);
    if (action === 'rewrite' && nextValue === null || action === 'unlink' && edge.syntax.startsWith('reference-')) {
      issue('unsupported-target-format', request.sourceWorkspaceId, edge.source.path, edge.id); continue;
    }
    const previous = edge.ref.kind === 'link-mark' ? edge.ref.expected.href : edge.ref.expected;
    if (action === 'rewrite' && previous === nextValue && !(request.kind === 'copy' && request.sourceWorkspaceId !== request.destinationWorkspaceId)) continue;
    mutations.push({ linkId: edge.id, source: edge.source, sourceVersion: inventory.version, reference: edge.ref,
      destinationWorkspaceId: request.kind === 'copy' ? request.destinationWorkspaceId : request.sourceWorkspaceId,
      sourcePathAfter, cloneSelection: request.kind === 'copy' ? selectionForPath.get(edge.source.path)! : null,
      action, nextValue, expectedTargetIdentity: edge.resolution.target.identity });
  }

  // Resolve the full virtual namespace, including untouched sources in both
  // workspaces. Never let a copied/moved basename silently capture a link.
  const virtual = new Map<string, NativeWorkspaceLinkSnapshot | WorkspaceMixedReadLinkSnapshotV3>();
  for (const snapshot of snapshots.values()) {
    const namespace = snapshot.namespace.filter((entry) => !(snapshot.workspaceId === request.sourceWorkspaceId && request.kind !== 'copy' && mapped.has(entry.path)));
    const documents = snapshot.documents.filter((entry) => !(snapshot.workspaceId === request.sourceWorkspaceId && request.kind !== 'copy' && mapped.has(entry.document.path)));
    if (version === 3 && snapshot.contractVersion === 3) {
      const physicalSources = snapshot.physicalSources.filter(entry => !(snapshot.workspaceId === request.sourceWorkspaceId && request.kind !== 'copy' && mapped.has(entry.path)));
      virtual.set(snapshot.workspaceId, { ...snapshot, namespace: [...namespace], documents: [...documents], physicalSources: [...physicalSources] });
    } else virtual.set(snapshot.workspaceId, { ...snapshot, namespace: [...namespace], documents: [...documents] });
  }
  for (const mapping of mapped.values()) if (request.kind !== 'delete' && destination) {
    const next = virtual.get(request.destinationWorkspaceId)!;
    const identity = request.kind === 'copy' ? `clone:${mapping.source.identity}:${mapping.destinationPath}` : mapping.source.identity;
    next.namespace.push({ ...mapping.source, workspaceId: request.destinationWorkspaceId, path: mapping.destinationPath, identity });
    const inventory = source?.documents.find((entry) => entry.document.path === mapping.source.path);
    if (inventory) next.documents.push({ ...inventory, document: { ...inventory.document, workspaceId: request.destinationWorkspaceId, path: mapping.destinationPath },
      metadata: { ...inventory.metadata, path: mapping.destinationPath }, links: [...inventory.links] });
    if (version === 3 && source?.contractVersion === 3 && next.contractVersion === 3) {
      const physical = source.physicalSources.find(entry => entry.path === mapping.source.path);
      if (physical) next.physicalSources.push({ ...physical, workspaceId: request.destinationWorkspaceId, path: mapping.destinationPath,
        metadata: { ...physical.metadata, path: mapping.destinationPath }, links: [...physical.links] });
    }
  }
  for (const snapshot of virtual.values()) snapshot.documents = snapshot.documents.map((inventory) => ({ ...inventory,
    links: inventory.links.flatMap((link) => {
      const recipe = mutations.find((entry) => entry.linkId === link.id && entry.destinationWorkspaceId === snapshot.workspaceId
        && entry.sourcePathAfter === inventory.document.path);
      if (!recipe) return [link];
      if (recipe.action === 'unlink') return [];
      const old = recipe.nextValue!;
      const parsed = link.kind === 'wiki' ? parseObsidianWikiTarget(old) : null;
      const hash = old.indexOf('#');
      return [{ ...link, literal: parsed?.target ?? old, targetPathText: parsed?.path ?? decodeURIComponent(hash < 0 ? old : old.slice(0, hash)) }];
    }),
  }));
  for (const snapshot of snapshots.values()) {
    const before = mixedReadGraph(snapshot, version);
    for (const edge of before.edges) {
      if (request.kind !== 'copy' && snapshot.workspaceId === request.sourceWorkspaceId && request.kind === 'delete' && mapped.has(edge.source.path)) continue;
      const moved = request.kind !== 'copy' && snapshot.workspaceId === request.sourceWorkspaceId ? mapped.get(edge.source.path) : undefined;
      const afterWorkspace = moved ? request.destinationWorkspaceId : snapshot.workspaceId;
      const after = mixedReadGraph(virtual.get(afterWorkspace)!, version).edges.find((entry) => entry.id === edge.id && entry.source.path === (moved?.destinationPath ?? edge.source.path));
      if (mutations.some((entry) => entry.linkId === edge.id && entry.action === 'unlink' && entry.cloneSelection === null)) continue;
      const identitySet = (link: NativeResolvedLink | MixedReadResolvedLinkV3) => link.resolution.candidates.map((entry) => entry.identity).sort();
      if (!after || edge.resolution.status !== after.resolution.status || nativeLinkJsonProof(identitySet(edge)) !== nativeLinkJsonProof(identitySet(after))) {
        // Physical aliases that still resolve to the same identity need no
        // rewrite. A real incoming rewrite/unlink remains import-only, and its
        // changed full resolution is still reported rather than ignored.
        if (version === 3 && 'sourceKind' in edge && edge.sourceKind === 'physical-read' && edge.resolution.status === 'resolved'
          && edge.resolution.target && snapshot.workspaceId === request.sourceWorkspaceId && request.kind !== 'copy'
          && mapped.has(edge.resolution.target.path)) issue('physical-source-import-required', snapshot.workspaceId, edge.source.path, edge.id);
        issue('resolution-changed', snapshot.workspaceId, edge.source.path, edge.id);
      }
    }
  }
  if (request.kind === 'copy') for (const mapping of mapped.values()) {
    const inventory = source?.documents.find((entry) => entry.document.path === mapping.source.path);
    if (!inventory) continue;
    const after = mixedReadGraph(virtual.get(request.destinationWorkspaceId)!, version).edges.filter((edge) => edge.source.path === mapping.destinationPath);
    for (const edge of sourceGraph?.edges.filter((entry) => entry.source.path === mapping.source.path) ?? []) {
      const targetMap = edge.resolution.target && mapped.get(edge.resolution.target.path);
      const expected = targetMap ? `clone:${targetMap.source.identity}:${targetMap.destinationPath}` : edge.resolution.target?.identity;
      const copied = after.find((entry) => entry.id === edge.id);
      if (edge.classification === 'local' && (!copied || copied.resolution.status !== 'resolved' || copied.resolution.target?.identity !== expected)) {
        issue('copied-resolution-changed', request.destinationWorkspaceId, mapping.destinationPath, edge.id);
      }
    }
  }
  const body = { contractVersion: version, kind: request.kind, sourceWorkspaceId: request.sourceWorkspaceId,
    destinationWorkspaceId: request.destinationWorkspaceId,
    snapshotProofs: request.snapshots.map((entry) => ({ workspaceId: entry.workspaceId, proof: entry.snapshotProof })).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
    pathMappings: [...mapped.values()].sort((a, b) => a.source.path.localeCompare(b.source.path)), mutations,
    readiness: issues.length ? 'blocked' as const : 'ready' as const, issues };
  return { ...body, planId: nativeLinkJsonProof(body) };
}

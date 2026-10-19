import { resolveWorkspaceWikiFileLink } from './workspace-link-index-core';
import { resolveExactWorkspaceLink } from './workspace-local-link-parser';
import { nativeLinkJsonProof } from './workspace-native-link-inventory';
import type { NativeDocumentLink, NativeResolvedLink, NativeWorkspaceLinkGraph, NativeWorkspaceLinkSnapshot } from './workspace-link-contract-v2';
import type { MixedReadResolvedLinkV3, PhysicalReadLinkInventory, WorkspaceMixedReadLinkGraphV3, WorkspaceMixedReadLinkSnapshotV3 } from './workspace-link-contract-v3';
import type { WorkspaceMixedImportFinalLinkGraphV4, WorkspaceMixedImportFinalLinkSnapshotV4 } from './workspace-link-final-contract-v4';

function createWorkspaceLinkResolutionContext(snapshot: NativeWorkspaceLinkSnapshot | WorkspaceMixedReadLinkSnapshotV3 | WorkspaceMixedImportFinalLinkSnapshotV4,
  physicalSources: PhysicalReadLinkInventory[] = []) {
  const entries = new Map(snapshot.namespace.filter((entry) => entry.kind === 'file').map((entry) => [entry.path, entry]));
  const paths = new Set(entries.keys());
  const metadata = [...snapshot.documents.map(inventory => inventory.metadata),
    ...physicalSources.map(inventory => inventory.metadata)];
  const candidates = metadata.map(metadata => ({ path: metadata.path, aliases: metadata.aliases,
    extension: metadata.path.split('.').at(-1), type: 'file' as const }));
  const options = { nativeTargetPaths: new Set(snapshot.documents.map(inventory => inventory.document.path)) };
  return { entries, paths, candidates, options };
}

function resolveWorkspaceLinkGraphTarget(link: Pick<NativeDocumentLink, 'kind' | 'literal' | 'targetPathText' | 'classification'>,
  sourcePath: string, context: ReturnType<typeof createWorkspaceLinkResolutionContext>): NativeResolvedLink['resolution'] {
  if (link.classification !== 'local') return { status: link.classification, target: null, candidates: [] };
  const { entries, paths, candidates, options } = context;
  const resolution = link.kind === 'wiki'
    ? resolveWorkspaceWikiFileLink({ targetLiteral: link.literal, targetPathText: link.targetPathText }, sourcePath, paths, candidates, options)
    : resolveExactWorkspaceLink(link.targetPathText, sourcePath, paths);
  return { status: resolution.status, target: resolution.path ? entries.get(resolution.path) ?? null : null,
    candidates: resolution.candidates.map((candidate) => entries.get(candidate)!).filter(Boolean) };
}

/** Reuses existing path/Wiki/alias resolution; native targets keep their own IDs
 * and references instead of masquerading as serialized Markdown spans. */
export function buildWorkspaceNativeLinkGraph(snapshot: NativeWorkspaceLinkSnapshot): NativeWorkspaceLinkGraph {
  const stale = snapshot.documents.filter(inventory => inventory.parserVersion !== 2)
    .map(inventory => ({ code: 'unsupported-source' as const, path: inventory.document.path, attribute: 'parserVersion' }));
  const coverage = { complete: snapshot.coverage.complete && !stale.length, gaps: [...snapshot.coverage.gaps, ...stale] };
  const context = createWorkspaceLinkResolutionContext(snapshot);
  const edges: NativeResolvedLink[] = [];
  for (const inventory of snapshot.documents) for (const link of inventory.links) {
    edges.push({ ...link, source: inventory.document, resolution: resolveWorkspaceLinkGraphTarget(link, inventory.document.path, context) });
  }
  return { contractVersion: 2, workspaceId: snapshot.workspaceId,
    snapshotProof: nativeLinkJsonProof({ base: snapshot.snapshotProof, edges, coverage }), namespace: snapshot.namespace,
    documents: snapshot.documents, edges, coverage };
}

/** Read-only physical sources participate in the same complete resolver as
 * native sources. No Yjs document identity or mutation anchor is synthesized. */
export function buildWorkspaceMixedReadLinkGraphV3(snapshot: WorkspaceMixedReadLinkSnapshotV3): WorkspaceMixedReadLinkGraphV3 {
  const stale = [...snapshot.documents.filter(inventory => inventory.parserVersion !== 2)
    .map(inventory => ({ code: 'unsupported-source', path: inventory.document.path })),
  ...snapshot.physicalSources.filter(inventory => inventory.parserVersion !== undefined && inventory.parserVersion !== 2 && inventory.parserVersion !== 3)
    .map(inventory => ({ code: 'unsupported-source', path: inventory.path }))];
  const coverage = { complete: snapshot.coverage.complete && !stale.length, gaps: [...snapshot.coverage.gaps, ...stale] };
  const context = createWorkspaceLinkResolutionContext(snapshot, snapshot.physicalSources), edges: MixedReadResolvedLinkV3[] = [];
  for (const inventory of snapshot.documents) for (const link of inventory.links) {
    edges.push({ ...link, sourceKind: 'native', source: inventory.document,
      resolution: resolveWorkspaceLinkGraphTarget(link, inventory.document.path, context) });
  }
  for (const inventory of snapshot.physicalSources) for (const link of inventory.links) {
    // Original parser links have no classification. As in the existing staged
    // preview, exact Markdown/Wiki targets are resolved from targetLiteral.
    const value = { id: link.physicalLinkId, kind: link.kind, syntax: link.syntax, literal: link.targetLiteral,
      targetPathText: link.targetPathText, fragment: link.fragment, alias: link.alias, embed: link.embed, classification: 'local' as const };
    edges.push({ ...value, sourceKind: 'physical-read', source: { workspaceId: inventory.workspaceId,
      organizationId: inventory.organizationId, path: inventory.path, physicalSourceIdentity: inventory.physical },
      physicalSourceProof: inventory.physicalSourceProof,
      resolution: resolveWorkspaceLinkGraphTarget(value, inventory.path, context) });
  }
  return { contractVersion: 3, workspaceId: snapshot.workspaceId,
    snapshotProof: nativeLinkJsonProof({ base: snapshot.snapshotProof, edges, coverage }), namespace: snapshot.namespace,
    documents: snapshot.documents, physicalSources: snapshot.physicalSources, edges, coverage };
}

/** Data-only resolver, not birth certification or current authority. Its fixed
 * caller must first validate the complete RawBirth cohort and actual states.
 * Parser 3 is never relabelled as parser 2; historical builders stay unchanged. */
export function buildWorkspaceMixedImportFinalLinkGraphV4(snapshot: WorkspaceMixedImportFinalLinkSnapshotV4): WorkspaceMixedImportFinalLinkGraphV4 {
  const stale = [...snapshot.documents.filter(inventory => inventory.parserVersion !== 2 && inventory.parserVersion !== 3)
    .map(inventory => ({ code: 'unsupported-source', path: inventory.document.path })),
  ...snapshot.physicalSources.filter(inventory => inventory.parserVersion !== undefined && inventory.parserVersion !== 2 && inventory.parserVersion !== 3)
    .map(inventory => ({ code: 'unsupported-source', path: inventory.path }))];
  const coverage = { complete: snapshot.coverage.complete && !stale.length, gaps: [...snapshot.coverage.gaps, ...stale] };
  const context = createWorkspaceLinkResolutionContext(snapshot, snapshot.physicalSources), edges: MixedReadResolvedLinkV3[] = [];
  for (const inventory of snapshot.documents) for (const link of inventory.links) {
    // Compiler4 raw sources contain physical local occurrences, not external
    // links. Their entire body is independently certified by import/link proofs.
    if (inventory.parserVersion === 3 && link.classification !== 'local' && !(link.classification === 'anchor-only' && link.kind === 'wiki')) continue;
    edges.push({ ...link, sourceKind: 'native', source: inventory.document,
      resolution: resolveWorkspaceLinkGraphTarget(link, inventory.document.path, context) });
  }
  for (const inventory of snapshot.physicalSources) for (const link of inventory.links) {
    const value = { id: link.physicalLinkId, kind: link.kind, syntax: link.syntax, literal: link.targetLiteral,
      targetPathText: link.targetPathText, fragment: link.fragment, alias: link.alias, embed: link.embed, classification: 'local' as const };
    edges.push({ ...value, sourceKind: 'physical-read', source: { workspaceId: inventory.workspaceId,
      organizationId: inventory.organizationId, path: inventory.path, physicalSourceIdentity: inventory.physical },
    physicalSourceProof: inventory.physicalSourceProof,
    resolution: resolveWorkspaceLinkGraphTarget(value, inventory.path, context) });
  }
  return { ...snapshot, snapshotProof: nativeLinkJsonProof({ base: snapshot.snapshotProof, edges, coverage }), edges, coverage };
}

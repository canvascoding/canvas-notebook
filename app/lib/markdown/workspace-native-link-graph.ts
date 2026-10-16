import { resolveWorkspaceWikiFileLink } from './workspace-link-index-core';
import { resolveExactWorkspaceLink } from './workspace-local-link-parser';
import { nativeLinkJsonProof } from './workspace-native-link-inventory';
import type { NativeResolvedLink, NativeWorkspaceLinkGraph, NativeWorkspaceLinkSnapshot } from './workspace-link-contract-v2';

/** Reuses existing path/Wiki/alias resolution; native targets keep their own IDs
 * and references instead of masquerading as serialized Markdown spans. */
export function buildWorkspaceNativeLinkGraph(snapshot: NativeWorkspaceLinkSnapshot): NativeWorkspaceLinkGraph {
  const stale = snapshot.documents.filter(inventory => inventory.parserVersion !== 2)
    .map(inventory => ({ code: 'unsupported-source' as const, path: inventory.document.path, attribute: 'parserVersion' }));
  const coverage = { complete: snapshot.coverage.complete && !stale.length, gaps: [...snapshot.coverage.gaps, ...stale] };
  const entries = new Map(snapshot.namespace.filter((entry) => entry.kind === 'file').map((entry) => [entry.path, entry]));
  const paths = new Set(entries.keys());
  const candidates = snapshot.documents.map(({ metadata }) => ({ path: metadata.path, aliases: metadata.aliases,
    extension: metadata.path.split('.').at(-1), type: 'file' as const }));
  const options = { nativeTargetPaths: new Set(snapshot.documents.map(inventory => inventory.document.path)) };
  const edges: NativeResolvedLink[] = [];
  for (const inventory of snapshot.documents) for (const link of inventory.links) {
    if (link.classification !== 'local') {
      edges.push({ ...link, source: inventory.document, resolution: { status: link.classification, target: null, candidates: [] } });
      continue;
    }
    const resolution = link.kind === 'wiki'
      ? resolveWorkspaceWikiFileLink({ targetLiteral: link.literal, targetPathText: link.targetPathText }, inventory.document.path, paths, candidates, options)
      : resolveExactWorkspaceLink(link.targetPathText, inventory.document.path, paths);
    const target = resolution.path ? entries.get(resolution.path) ?? null : null;
    edges.push({ ...link, source: inventory.document, resolution: { status: resolution.status,
      target, candidates: resolution.candidates.map((candidate) => entries.get(candidate)!).filter(Boolean) } });
  }
  return { contractVersion: 2, workspaceId: snapshot.workspaceId,
    snapshotProof: nativeLinkJsonProof({ base: snapshot.snapshotProof, edges, coverage }), namespace: snapshot.namespace,
    documents: snapshot.documents, edges, coverage };
}

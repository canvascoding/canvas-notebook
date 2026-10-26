import 'server-only';

import type { WorkspaceContext } from '../workspaces/types';
import type { NativeDocumentLink, NativeNamespaceEntry } from './workspace-link-contract-v2';
import { resolveWorkspaceWikiFileLink } from './workspace-link-index-core';
import { resolveExactWorkspaceLink, type WorkspaceExactResolution } from './workspace-local-link-parser';
import type { OriginalPhysicalLink, WorkspaceSourceAuthorityStage } from './workspace-physical-link-inventory';
import { stageWorkspaceLinkSourceAuthorityObservation } from './workspace-source-authority-stage';
import type { WorkspaceDocumentLinkDocument, WorkspaceDocumentLinkIndex, WorkspaceLinkReadEdge } from './workspace-document-link-index-contract';

export type WorkspaceDocumentLinkIndexDependencies = {
  observe?: typeof stageWorkspaceLinkSourceAuthorityObservation;
  now?: () => Date;
};

type Source = WorkspaceSourceAuthorityStage['sources'][number];
type SemanticLink = Pick<NativeDocumentLink, 'kind' | 'syntax' | 'targetPathText' | 'fragment' | 'alias' | 'embed'> & {
  id: string;
  literal: string;
  classification: NativeDocumentLink['classification'];
  sourcePreview?: WorkspaceLinkReadEdge['sourcePreview'];
};
const markdownPath = (value: string): boolean => /\.(?:md|markdown)$/iu.test(value);
const sourcePath = (source: Source): string => source.kind === 'native' ? source.inventory.document.path : source.inventory.path;

function documentMetadata(source: Source): WorkspaceDocumentLinkDocument {
  const metadata = source.inventory.metadata;
  return {
    aliases: [...metadata.aliases], blockIds: [...metadata.blockIds],
    headings: metadata.headings.map(heading => ({ depth: heading.depth, text: heading.text })),
    ...(metadata.hasExplicitTitle !== undefined ? { hasExplicitTitle: metadata.hasExplicitTitle } : {}),
    path: metadata.path, tags: [...metadata.tags], title: metadata.title,
    ...(source.kind === 'native' ? { nativeIdentity: {
      documentId: source.inventory.document.documentId,
      lifecycleGeneration: source.inventory.document.lifecycleGeneration,
    } } : {}),
  };
}

function physicalLink(link: OriginalPhysicalLink): SemanticLink {
  return {
    id: link.physicalLinkId, kind: link.kind, syntax: link.syntax, literal: link.targetLiteral,
    targetPathText: link.targetPathText, fragment: link.fragment, alias: link.alias, embed: link.embed,
    classification: link.targetPathText ? 'local' : 'anchor-only',
    sourcePreview: { kind: 'physical-markdown', focusOffset: link.start },
  };
}

/** Read projection only. Native inventories are never serialized to Markdown,
 * nor are their private relative positions converted to fictitious file spans. */
export function buildWorkspaceDocumentLinkIndexFromStage(
  stage: WorkspaceSourceAuthorityStage,
  now: Date = new Date(),
): WorkspaceDocumentLinkIndex {
  const gaps = new Map<string, { code: string; path: string }>();
  const gap = (code: string, path: string) => gaps.set(`${code}\0${path}`, { code, path });
  for (const entry of stage.coverage.gaps) gap(entry.code, entry.path);
  if (!stage.coverage.complete && !stage.coverage.gaps.length) gap('source-authority-incomplete', '');
  if (stage.stageVersion !== 1) gap('unsupported-source-stage', '');

  const namespace = new Map<string, NativeNamespaceEntry>();
  const conflicts = new Set<string>();
  for (const entry of stage.namespace) {
    if (entry.workspaceId !== stage.workspaceId) { gap('namespace-scope-mismatch', entry.path); conflicts.add(entry.path); continue; }
    const prior = namespace.get(entry.path);
    if (prior && (prior.kind !== entry.kind || prior.documentId !== entry.documentId
      || prior.lifecycleGeneration !== entry.lifecycleGeneration)) {
      gap('namespace-identity-conflict', entry.path); conflicts.add(entry.path);
    }
    namespace.set(entry.path, entry);
  }
  for (const entry of namespace.values()) {
    const parents = entry.path.split('/').slice(0, -1);
    while (parents.length) {
      const parent = parents.join('/');
      if (namespace.get(parent)?.kind === 'file') {
        gap('namespace-parent-is-file', entry.path); conflicts.add(entry.path);
      }
      parents.pop();
    }
  }

  const sources = new Map<string, Source>();
  for (const source of stage.sources) {
    const path = sourcePath(source), entry = namespace.get(path);
    for (const failure of source.inventory.coverage.gaps) gap(failure.code, failure.path);
    if (!source.inventory.coverage.complete && !source.inventory.coverage.gaps.length) gap('source-incomplete', path);
    if (sources.has(path)) { gap('duplicate-source', path); conflicts.add(path); continue; }
    if (!entry || entry.kind !== 'file' || source.inventory.metadata.path !== path
      || (source.kind === 'native' ? source.inventory.document.workspaceId : source.inventory.workspaceId) !== stage.workspaceId) {
      gap('source-identity-conflict', path); conflicts.add(path); continue;
    }
    if (source.inventory.parserVersion !== 2) { gap('unsupported-source-parser', path); conflicts.add(path); continue; }
    if (source.kind === 'native') {
      const document = source.inventory.document;
      if (document.documentId !== entry.documentId || document.lifecycleGeneration !== entry.lifecycleGeneration
        || document.organizationId !== stage.organizationId
        || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(document.representation)) {
        gap('native-source-identity-conflict', path); conflicts.add(path); continue;
      }
      // Native authority supports every inspected representation even when its
      // current filename has a non-Markdown extension.
    } else {
      if (entry.documentId !== null) { gap('physical-source-is-native', path); conflicts.add(path); continue; }
      // A PDF/image is a namespace target, not a Markdown document. Physical
      // HTML/MDX coverage remains explicit in the original Stage gaps.
      if (!markdownPath(path)) continue;
    }
    sources.set(path, source);
  }
  for (const path of conflicts) sources.delete(path);
  for (const entry of namespace.values()) {
    if (entry.kind === 'file' && (entry.documentId !== null || markdownPath(entry.path)) && !sources.has(entry.path)) {
      gap('uninspected-source', entry.path);
    }
  }
  const targetPaths = [...namespace.values()].filter(entry => entry.kind === 'file' && !conflicts.has(entry.path))
    .map(entry => entry.path).sort((a, b) => a.localeCompare(b));
  const paths = new Set(targetPaths);
  const documents = [...sources.values()].map(documentMetadata).sort((a, b) => a.path.localeCompare(b.path));
  const candidates = documents.map(document => ({ path: document.path, aliases: document.aliases,
    extension: document.path.split('.').at(-1)?.toLowerCase(), type: 'file' as const }));
  const nativeTargetPaths = new Set(documents.filter(document => document.nativeIdentity).map(document => document.path));
  const edges: WorkspaceLinkReadEdge[] = [];
  for (const [path, source] of sources) {
    const links: SemanticLink[] = source.kind === 'physical' ? source.inventory.links.map(physicalLink)
      : source.inventory.links.map(link => ({ id: link.id, kind: link.kind, syntax: link.syntax,
        literal: link.literal, targetPathText: link.targetPathText, fragment: link.fragment,
        alias: link.alias, embed: link.embed, classification: link.classification }));
    for (const link of links) {
      const resolution: WorkspaceExactResolution = link.classification !== 'local'
        ? { status: link.classification, path: null, candidates: [] }
        : link.kind === 'wiki'
          ? resolveWorkspaceWikiFileLink({ targetLiteral: link.literal, targetPathText: link.targetPathText },
            path, paths, candidates, { nativeTargetPaths })
          : resolveExactWorkspaceLink(link.targetPathText, path, paths);
      let fragment = link.fragment ?? '';
      try { fragment = decodeURIComponent(fragment); } catch { /* Retain malformed spelling. */ }
      edges.push({
        id: link.id, kind: link.kind, syntax: link.syntax, sourcePath: path,
        targetLiteral: link.literal,
        targetText: link.classification === 'external' ? link.literal
          : link.targetPathText + (link.fragment !== null ? `#${link.fragment}` : ''),
        alias: link.alias, embed: link.embed, heading: fragment && !fragment.startsWith('^') ? fragment : null,
        blockId: fragment.startsWith('^') ? fragment.slice(1) || null : null,
        candidates: [...resolution.candidates], status: resolution.status, targetPath: resolution.path,
        ...(link.sourcePreview ? { sourcePreview: { ...link.sourcePreview } } : {}),
      });
    }
  }
  edges.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.id.localeCompare(b.id));
  const backlinks = Object.fromEntries(targetPaths.map(path => [path, [] as WorkspaceLinkReadEdge[]]));
  for (const edge of edges) if (edge.targetPath) backlinks[edge.targetPath]?.push(edge);
  const unresolved = edges.filter(edge => !['resolved', 'external', 'anchor-only'].includes(edge.status));
  const publicGaps = [...gaps.values()].sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
  const omissions = new Map<string, 'too-large' | 'unreadable'>();
  for (const failure of publicGaps) if (failure.path && namespace.get(failure.path)?.kind === 'file'
    && (markdownPath(failure.path) || namespace.get(failure.path)?.documentId !== null)) {
    const reason = /limit|too-large/iu.test(failure.code) ? 'too-large' : 'unreadable';
    if (reason === 'too-large' || !omissions.has(failure.path)) omissions.set(failure.path, reason);
  }
  const omittedDocuments = [...omissions].map(([path, reason]) => ({ path, reason })).sort((a, b) => a.path.localeCompare(b.path));
  return {
    indexVersion: 2, workspaceId: stage.workspaceId, documents, edges, backlinks, brokenLinks: unresolved,
    targetPaths, generatedAt: now.toISOString(), gaps: publicGaps, omittedDocuments,
    coverage: {
      complete: stage.coverage.complete && publicGaps.length === 0 && unresolved.length === 0,
      omittedSources: omittedDocuments.map(({ path, reason }) => ({ path,
        reason: reason === 'too-large' ? 'source-too-large' : 'source-unreadable' })),
      unresolvedLinks: unresolved.map(edge => ({ sourcePath: edge.sourcePath, targetLiteral: edge.targetLiteral,
        status: edge.status as Exclude<WorkspaceLinkReadEdge['status'], 'resolved'> })),
    },
  };
}

/** The existing observer owns the real read transaction and shared admission
 * fence. Its private state/binary/catalogue evidence never leaves this reader. */
export async function readWorkspaceDocumentLinkIndex(
  workspace: WorkspaceContext,
  dependencies: WorkspaceDocumentLinkIndexDependencies = {},
): Promise<WorkspaceDocumentLinkIndex> {
  if (!workspace.permissions.canRead || workspace.status !== undefined && workspace.status !== 'active') {
    throw Object.assign(new Error('Current workspace read permission is required.'), { status: 403 });
  }
  const observation = await (dependencies.observe ?? stageWorkspaceLinkSourceAuthorityObservation)(workspace, { sourceScope: 'document-index' });
  if (observation.stage.workspaceId !== workspace.workspaceId
    || observation.stage.organizationId !== (workspace.organizationId ?? null)) throw new Error('Document link index scope changed.');
  return buildWorkspaceDocumentLinkIndexFromStage(observation.stage, dependencies.now?.() ?? new Date());
}

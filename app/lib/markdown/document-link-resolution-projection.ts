import 'server-only';

import type { NativeDocumentLink } from './workspace-link-contract-v2';
import type { WorkspaceDocumentLinkDocument, WorkspaceLinkReadEdge } from './workspace-document-link-index-contract';
import { parseObsidianWikiTarget } from './obsidian-flavored-markdown';
import { stripMarkdownExtension } from './obsidian-link-resolver';
import { resolveWorkspaceWikiFileLink } from './workspace-link-index-core';
import { resolveExactWorkspaceLink, type WorkspaceExactResolution } from './workspace-local-link-parser';
import { nativeLinkJsonProof } from './workspace-native-link-inventory';
import { documentLinkReadProjectionRequiresFreshRead } from './document-link-read-projection';

export type WorkspaceDocumentSemanticLink = Pick<NativeDocumentLink,
  'kind' | 'syntax' | 'targetPathText' | 'fragment' | 'alias' | 'embed' | 'classification'> & {
  id: string; literal: string; sourcePreview?: WorkspaceLinkReadEdge['sourcePreview'];
};
type Source = { path: string; version: string; links: WorkspaceDocumentSemanticLink[] };
type Target = { fingerprint: string; dependencies: string[] };
type SourceProjection = { fingerprint: string; dependencies: string[]; resolutions: WorkspaceExactResolution[] };
type Projection = { targets: Map<string, Target>; sources: Map<string, SourceProjection>; bytes: number; links: number };
const MAX_WORKSPACES = 64, MAX_BYTES = 8 * 1024 * 1024, MAX_LINKS = 20_000;
const projections = new Map<string, Projection>();
let retainedBytes = 0, retainedLinks = 0, sourcesReused = 0, sourcesResolved = 0, linksResolved = 0, fullRebuilds = 0;

/** Conservative dependency normalization only. The existing resolvers make
 * every target decision. Extra invalidations are safe; no decision is inferred
 * from a name, alias, cached edge, or caller-provided permission. */
function dependencyPath(value: string): string {
  const segments: string[] = [];
  for (const part of value.replace(/\\/gu, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segments.pop(); else segments.push(part);
  }
  return segments.join('/');
}
const filenameKey = (value: string) => `file:${dependencyPath(value).split('/').at(-1)?.toLocaleLowerCase() ?? ''}`;
const wikiKey = (value: string) => `wiki:${stripMarkdownExtension(dependencyPath(value)).toLocaleLowerCase()}`;

function targetDependencies(path: string, document: WorkspaceDocumentLinkDocument | undefined): string[] {
  const result = new Set([filenameKey(path)]), parts = dependencyPath(path).split('/');
  // Wiki paths also match suffixes. Keep exact and ambiguous/missing name
  // dependencies even when an earlier candidate currently wins.
  for (let index = 0; index < parts.length; index++) result.add(wikiKey(parts.slice(index).join('/')));
  for (const alias of document?.aliases ?? []) result.add(`wiki:${alias.trim().toLocaleLowerCase()}`);
  return [...result];
}

function sourceDependencies(source: Source): string[] {
  const result = new Set<string>();
  for (const link of source.links) {
    if (link.classification !== 'local') continue;
    const relative = link.targetPathText.replace(/\\/gu, '/');
    const parent = source.path.split('/').slice(0, -1).join('/');
    result.add(filenameKey(relative.startsWith('/') ? relative : `${parent}/${relative}`));
    if (link.kind === 'wiki') {
      const target = parseObsidianWikiTarget(link.literal);
      if (target?.path) {
        result.add(wikiKey(target.path));
        result.add(filenameKey(target.path));
      }
    }
  }
  return [...result];
}

function release(key: string): void {
  const previous = projections.get(key);
  if (previous) { retainedBytes -= previous.bytes; retainedLinks -= previous.links; projections.delete(key); }
}

/** Bounded read data only. Fresh source/namespace selection and all rights stay
 * with the collector. Retained values contain no state bytes, native positions,
 * stage, catalogue/binding, Principal, or mutation recipe. Every public edge is
 * rebuilt from this call's current link IDs, literals, fragments and previews. */
export function resolveWorkspaceDocumentReadEdges(input: {
  workspaceId: string; organizationId: string | null; documents: WorkspaceDocumentLinkDocument[];
  targetPaths: string[]; sources: Source[];
}): WorkspaceLinkReadEdge[] {
  const fresh = documentLinkReadProjectionRequiresFreshRead();
  if (fresh) fullRebuilds++;
  const key = nativeLinkJsonProof([input.workspaceId, input.organizationId]);
  const previous = fresh ? undefined : projections.get(key);
  const documents = new Map(input.documents.map(document => [document.path, document]));
  const targets = new Map<string, Target>(), changedDependencies = new Set<string>();
  for (const path of input.targetPaths) {
    const document = documents.get(path);
    const target = { fingerprint: nativeLinkJsonProof({ path, aliases: document?.aliases ?? [],
      title: document?.title ?? null, nativeIdentity: document?.nativeIdentity ?? null }),
      dependencies: targetDependencies(path, document) };
    targets.set(path, target);
    const old = previous?.targets.get(path);
    if (!old || old.fingerprint !== target.fingerprint) {
      for (const dependency of [...(old?.dependencies ?? []), ...target.dependencies]) changedDependencies.add(dependency);
    }
  }
  for (const [path, old] of previous?.targets ?? []) if (!targets.has(path)) {
    for (const dependency of old.dependencies) changedDependencies.add(dependency);
  }
  const paths = new Set(input.targetPaths);
  const candidates = input.documents.map(document => ({ path: document.path, aliases: document.aliases,
    extension: document.path.split('.').at(-1)?.toLowerCase(), type: 'file' as const }));
  const nativeTargetPaths = new Set(input.documents.filter(document => document.nativeIdentity).map(document => document.path));
  const sources = new Map<string, SourceProjection>(), edges: WorkspaceLinkReadEdge[] = [];
  for (const source of input.sources) {
    const fingerprint = nativeLinkJsonProof({ profile: 'document-link-resolution-v1', parserVersion: 2,
      path: source.path, version: source.version,
      links: source.links.map(link => [link.kind, link.literal, link.targetPathText, link.classification]) });
    const old = previous?.sources.get(source.path);
    const reusable = old?.fingerprint === fingerprint
      && !old.dependencies.some(dependency => changedDependencies.has(dependency));
    let resolutions: WorkspaceExactResolution[];
    if (reusable) { sourcesReused++; resolutions = old.resolutions; }
    else {
      sourcesResolved++; linksResolved += source.links.length;
      resolutions = source.links.map(link => link.classification !== 'local'
        ? { status: link.classification, path: null, candidates: [] }
        : link.kind === 'wiki'
          ? resolveWorkspaceWikiFileLink({ targetLiteral: link.literal, targetPathText: link.targetPathText },
            source.path, paths, candidates, { nativeTargetPaths })
          : resolveExactWorkspaceLink(link.targetPathText, source.path, paths));
    }
    sources.set(source.path, { fingerprint,
      dependencies: reusable ? old.dependencies : sourceDependencies(source), resolutions });
    for (const [index, link] of source.links.entries()) {
      const resolution = resolutions[index];
      let fragment = link.fragment ?? '';
      try { fragment = decodeURIComponent(fragment); } catch { /* Retain malformed spelling. */ }
      edges.push({ id: link.id, kind: link.kind, syntax: link.syntax, sourcePath: source.path,
        targetLiteral: link.literal, targetText: link.classification === 'external' ? link.literal
          : link.targetPathText + (link.fragment !== null ? `#${link.fragment}` : ''),
        alias: link.alias, embed: link.embed, heading: fragment && !fragment.startsWith('^') ? fragment : null,
        blockId: fragment.startsWith('^') ? fragment.slice(1) || null : null,
        candidates: [...resolution.candidates], status: resolution.status, targetPath: resolution.path,
        ...(link.sourcePreview ? { sourcePreview: { ...link.sourcePreview } } : {}) });
    }
  }
  if (!fresh) {
    const links = edges.length;
    const bytes = Buffer.byteLength(JSON.stringify({ targets: [...targets], sources: [...sources] }), 'utf8');
    release(key);
    if (bytes <= MAX_BYTES && links <= MAX_LINKS) {
      projections.set(key, { targets, sources, bytes, links }); retainedBytes += bytes; retainedLinks += links;
      while (projections.size > MAX_WORKSPACES || retainedBytes > MAX_BYTES || retainedLinks > MAX_LINKS) {
        release(projections.keys().next().value!);
      }
    }
  }
  return edges;
}

/** Content-free counters. Bypass/restart/eviction always permit a full rebuild. */
export function documentLinkResolutionProjectionStatistics() {
  return Object.freeze({ workspaces: projections.size, retainedBytes, retainedLinks,
    sourcesReused, sourcesResolved, linksResolved, fullRebuilds,
    maxWorkspaces: MAX_WORKSPACES, maxBytes: MAX_BYTES, maxLinks: MAX_LINKS });
}

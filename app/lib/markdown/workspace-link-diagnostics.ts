import { buildWorkspaceLinkIndexFromDocuments, type WorkspaceLinkIndex } from './workspace-link-index-core';
import { parseWorkspaceLocalLinks, resolveExactWorkspaceLink, type ParsedWorkspaceLocalLink } from './workspace-local-link-parser';

export type WorkspaceLinkDiagnostics = {
  contractVersion: 1;
  scope: 'workspace-local';
  basis: 'applied' | 'proposed' | 'current';
  sourcePath: string;
  contentSha256: string;
  status: 'complete' | 'partial' | 'unavailable' | 'not_applicable';
  counts: { checked: number; resolved: number; missing: number; ambiguous: number; unverified: number };
  issues: Array<{
    line: number;
    column: number;
    target: string;
    status: 'missing' | 'ambiguous' | 'outside-workspace' | 'not-evaluated';
    candidates: string[];
    change: 'introduced' | 'existing' | 'unknown';
  }>;
  truncated: boolean;
  notices: string[];
  anchorsChecked: false;
  externalChecked: false;
};

const MAX_ISSUES = 20;
const MAX_TARGET_LENGTH = 300;
const MAX_CANDIDATES = 5;

/** Only explicit root/relative file matches are independent of missing aliases. */
function hasUniqueExactWikiTarget(link: ParsedWorkspaceLocalLink, paths: ReadonlySet<string>): boolean {
  if (!link.targetPathText) return paths.has(link.sourcePath);
  const target = link.targetPathText;
  const extension = target.split('/').pop()?.match(/\.([^.]+)$/u)?.[1];
  const variants = extension ? [target] : [target, `${target}.md`, `${target}.markdown`];
  const matches = new Set<string>();
  for (const variant of variants) {
    const root = resolveExactWorkspaceLink(`/${variant.replace(/^\/+/, '')}`, link.sourcePath, paths);
    const relative = resolveExactWorkspaceLink(variant, link.sourcePath, paths);
    if (root.path) matches.add(root.path);
    if (relative.path) matches.add(relative.path);
  }
  return matches.size === 1;
}

/** Diagnose only this source; unrelated index omissions do not affect its coverage. */
export function diagnoseWorkspaceLinks(input: {
  index: WorkspaceLinkIndex;
  path: string;
  content: string;
  contentSha256: string;
  basis: WorkspaceLinkDiagnostics['basis'];
  beforeContent?: string;
  beforeIndex?: WorkspaceLinkIndex;
}): WorkspaceLinkDiagnostics {
  const result: WorkspaceLinkDiagnostics = {
    contractVersion: 1,
    scope: 'workspace-local',
    basis: input.basis,
    sourcePath: input.path,
    contentSha256: input.contentSha256,
    status: 'complete',
    counts: { checked: 0, resolved: 0, missing: 0, ambiguous: 0, unverified: 0 },
    issues: [],
    truncated: false,
    notices: [],
    anchorsChecked: false,
    externalChecked: false,
  };
  if (!/\.(?:md|markdown)$/iu.test(input.path)) {
    result.status = 'not_applicable';
    result.notices.push('Local link diagnostics support .md and .markdown files.');
    return result;
  }

  const omission = input.index.omittedDocuments.find((entry) => entry.path === input.path)
    ?? input.index.coverage.omittedSources.find((entry) => entry.path === input.path);
  if (omission || !input.index.documents.some((document) => document.path === input.path)) {
    result.status = omission ? 'partial' : 'unavailable';
    result.counts.unverified = 1;
    result.notices.push(omission
      ? `Source was not fully inspected (${omission.reason}). The number of unchecked links is unknown.`
      : 'Source is absent from the link index. The number of unchecked links is unknown.');
    return result;
  }

  const beforeCounts = new Map<string, number>();
  const beforeUncertainKeys = new Set<string>();
  let beforeIndex: WorkspaceLinkIndex | undefined;
  const linkKey = (syntax: string, target: string): string => JSON.stringify([syntax, target]);
  if (input.beforeContent !== undefined || input.beforeIndex) {
    // The resolver uses target paths and aliases, so minimal target documents
    // preserve its exact rules without retaining or reparsing their full text.
    const before = input.beforeIndex ?? buildWorkspaceLinkIndexFromDocuments([
      { path: input.path, content: input.beforeContent! },
      ...input.index.documents.filter((document) => document.path !== input.path).map((document) => ({
        path: document.path,
        content: `---\naliases: ${JSON.stringify(document.aliases)}\n---\n`,
      })),
    ], new Date(input.index.generatedAt), input.index.targetPaths);
    beforeIndex = before;
    const priorAliasesOmitted = before.omittedDocuments.some((entry) => entry.path !== input.path)
      || before.coverage.omittedSources.some((entry) => entry.path !== input.path);
    for (const link of before.edges.filter((edge) => edge.sourcePath === input.path && edge.status !== 'resolved'
      && edge.status !== 'external' && edge.status !== 'anchor-only')) {
      const key = linkKey(link.syntax, link.targetLiteral);
      if (link.kind === 'wiki' && priorAliasesOmitted) beforeUncertainKeys.add(key);
      beforeCounts.set(key, (beforeCounts.get(key) ?? 0) + 1);
    }
    for (const link of before.unevaluatedLinks.filter((entry) => entry.sourcePath === input.path)) {
      const key = linkKey(`unevaluated:${link.reason}`, link.raw);
      beforeCounts.set(key, (beforeCounts.get(key) ?? 0) + 1);
    }
  }
  const beforeSourceUnknown = beforeIndex && (beforeIndex.omittedDocuments.some((entry) => entry.path === input.path)
    || beforeIndex.coverage.omittedSources.some((entry) => entry.path === input.path)
    || !beforeIndex.documents.some((entry) => entry.path === input.path));
  const beforeAliasMetadataIncomplete = beforeIndex && (beforeIndex.omittedDocuments.some((entry) => entry.path !== input.path)
    || beforeIndex.coverage.omittedSources.some((entry) => entry.path !== input.path));
  const beforeTargetPaths = new Set(beforeIndex?.targetPaths);
  const changeFor = (key: string, wikiLink?: ParsedWorkspaceLocalLink): WorkspaceLinkDiagnostics['issues'][number]['change'] => {
    if (input.beforeContent === undefined && !input.beforeIndex) return 'unknown';
    if (beforeSourceUnknown || beforeUncertainKeys.has(key) || (beforeAliasMetadataIncomplete && wikiLink
      && !hasUniqueExactWikiTarget(wikiLink, beforeTargetPaths))) {
      const notice = 'Prior link state was not fully inspected; affected change classifications are unknown.';
      if (!result.notices.includes(notice)) result.notices.push(notice);
      return 'unknown';
    }
    const remaining = beforeCounts.get(key) ?? 0;
    if (!remaining) return 'introduced';
    beforeCounts.set(key, remaining - 1);
    return 'existing';
  };
  const bounded = (value: string): string => {
    if (value.length <= MAX_TARGET_LENGTH) return value;
    result.truncated = true;
    return `${value.slice(0, MAX_TARGET_LENGTH - 1)}…`;
  };
  const addIssue = (offset: number, target: string, status: WorkspaceLinkDiagnostics['issues'][number]['status'],
    candidates: string[], change: WorkspaceLinkDiagnostics['issues'][number]['change']): void => {
    if (result.issues.length >= MAX_ISSUES) { result.truncated = true; return; }
    const prefix = input.content.slice(0, Math.max(0, Math.min(offset, input.content.length)));
    if (candidates.length > MAX_CANDIDATES) result.truncated = true;
    result.issues.push({
      line: prefix.split('\n').length,
      column: prefix.length - prefix.lastIndexOf('\n'),
      target: bounded(target),
      status,
      candidates: candidates.slice(0, MAX_CANDIDATES).map(bounded),
      change,
    });
  };

  const edges = input.index.edges.filter((edge) => edge.sourcePath === input.path);
  const incompleteAliasMetadata = input.index.omittedDocuments.some((entry) => entry.path !== input.path)
    || input.index.coverage.omittedSources.some((entry) => entry.path !== input.path);
  const parsedWikiLinks = incompleteAliasMetadata || beforeAliasMetadataIncomplete
    ? new Map(parseWorkspaceLocalLinks(input.content, input.path).links.filter((link) => link.kind === 'wiki')
      .map((link) => [link.start, link]))
    : new Map<number, ParsedWorkspaceLocalLink>();
  const targetPaths = new Set(input.index.targetPaths);
  for (const edge of edges) {
    if (edge.status === 'external' || edge.status === 'anchor-only') continue;
    result.counts.checked += 1;
    const wikiLink = parsedWikiLinks.get(edge.start);
    if (edge.kind === 'wiki' && incompleteAliasMetadata
      && (edge.status !== 'resolved' || !wikiLink || !hasUniqueExactWikiTarget(wikiLink, targetPaths))) {
      result.counts.unverified += 1;
      addIssue(edge.targetRange.startUtf16, edge.targetLiteral, 'not-evaluated', edge.candidates, 'unknown');
      const notice = 'Wiki name and alias lookup is incomplete because target document metadata was omitted.';
      if (!result.notices.includes(notice)) result.notices.push(notice);
      continue;
    }
    if (edge.status === 'resolved') { result.counts.resolved += 1; continue; }
    const change = changeFor(linkKey(edge.syntax, edge.targetLiteral), wikiLink);
    if (edge.status === 'missing' || edge.status === 'ambiguous') {
      result.counts[edge.status] += 1;
      addIssue(edge.targetRange.startUtf16, edge.targetLiteral, edge.status, edge.candidates, change);
    } else {
      result.counts.unverified += 1;
      addIssue(edge.targetRange.startUtf16, edge.targetLiteral,
        edge.status === 'outside-workspace' ? 'outside-workspace' : 'not-evaluated', edge.candidates, change);
    }
  }
  for (const link of input.index.unevaluatedLinks.filter((entry) => entry.sourcePath === input.path)) {
    result.counts.unverified += 1;
    const change = changeFor(linkKey(`unevaluated:${link.reason}`, link.raw));
    addIssue(link.start, link.raw, 'not-evaluated', [], change);
  }
  if (result.counts.unverified > 0) {
    result.status = 'partial';
    result.notices.push('Some local link syntax could not be verified.');
  }
  return result;
}

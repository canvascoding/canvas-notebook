import {
  createObsidianSyntaxMask,
  parseObsidianBlockIds,
} from './obsidian-flavored-markdown';
import { parseObsidianFrontmatter } from './obsidian-metadata';
import {
  resolveObsidianWikiLink,
  stripMarkdownExtension,
  type ObsidianLinkCandidate,
} from './obsidian-link-resolver';
import {
  parseWorkspaceLocalLinks,
  resolveExactWorkspaceLink,
  type ParsedWorkspaceLocalLink,
  type WorkspaceLinkUnevaluated,
} from './workspace-local-link-parser';
import type {
  WorkspaceLinkCoverageV1,
  WorkspaceLinkResolveStatusV1,
  WorkspaceLinkSyntaxV1,
  WorkspaceLinkTargetRangeV1,
} from './workspace-link-contract-v1';

export type WorkspaceLinkHeading = {
  depth: number;
  text: string;
};

export type WorkspaceLinkDocumentSource = {
  content: string;
  path: string;
};

export type WorkspaceLinkDocument = {
  aliases: string[];
  blockIds: string[];
  headings: WorkspaceLinkHeading[];
  /** Whether the document has a title explicitly set in its frontmatter. */
  hasExplicitTitle?: boolean;
  path: string;
  tags: string[];
  title: string;
};

export type WorkspaceLinkEdge = {
  alias: string | null;
  blockId: string | null;
  candidates: string[];
  embed: boolean;
  end: number;
  heading: string | null;
  id: string;
  kind: 'wiki' | 'markdown';
  syntax: WorkspaceLinkSyntaxV1;
  targetLiteral: string;
  targetRange: WorkspaceLinkTargetRangeV1;
  raw: string;
  sourcePath: string;
  start: number;
  status: WorkspaceLinkResolveStatusV1;
  targetPath: string | null;
  targetText: string;
};

export type WorkspaceLinkIndex = {
  backlinks: Record<string, WorkspaceLinkEdge[]>;
  brokenLinks: WorkspaceLinkEdge[];
  documents: WorkspaceLinkDocument[];
  edges: WorkspaceLinkEdge[];
  generatedAt: string;
  targetPaths: string[];
  unevaluatedLinks: WorkspaceLinkUnevaluated[];
  coverage: WorkspaceLinkCoverageV1;
  omittedDocuments: Array<{
    path: string;
    reason: 'too-large' | 'unreadable';
  }>;
};

function normalizePath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

function basenameWithoutExtension(value: string): string {
  return stripMarkdownExtension(normalizePath(value).split('/').pop() || value);
}

function cleanHeadingText(value: string): string {
  return value
    .replace(/[ \t]+#+[ \t]*$/u, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .trim();
}

export function extractWorkspaceMarkdownHeadings(markdown: string): WorkspaceLinkHeading[] {
  const mask = createObsidianSyntaxMask(markdown);
  const headings: WorkspaceLinkHeading[] = [];
  let lineStart = 0;

  while (lineStart <= markdown.length) {
    const newline = markdown.indexOf('\n', lineStart);
    const lineEnd = newline >= 0 ? newline : markdown.length;
    const maskLine = mask.slice(lineStart, lineEnd).replace(/\r$/u, '');
    const sourceLine = markdown.slice(lineStart, lineEnd).replace(/\r$/u, '');
    const atx = maskLine.match(/^ {0,3}(#{1,6})[ \t]+/u);
    if (atx) {
      const rawText = sourceLine.slice(atx[0].length);
      const text = cleanHeadingText(rawText);
      if (text) headings.push({ depth: atx[1].length, text });
    } else if (sourceLine.trim() && newline >= 0) {
      const nextStart = newline + 1;
      const nextNewline = markdown.indexOf('\n', nextStart);
      const nextEnd = nextNewline >= 0 ? nextNewline : markdown.length;
      const underline = mask.slice(nextStart, nextEnd).replace(/\r$/u, '');
      const setext = underline.match(/^ {0,3}(=+|-+)[ \t]*$/u);
      if (setext) {
        const text = cleanHeadingText(sourceLine);
        if (text) headings.push({ depth: setext[1][0] === '=' ? 1 : 2, text });
      }
    }

    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return headings;
}

function resolveWorkspaceWikiFileLink(
  link: ParsedWorkspaceLocalLink,
  sourcePath: string,
  paths: ReadonlySet<string>,
  markdownCandidates: ObsidianLinkCandidate[],
): { candidates: string[]; path: string | null; status: WorkspaceLinkResolveStatusV1 } {
  const rawTarget = link.targetLiteral;
  const fileName = link.targetPathText.split('/').pop() ?? '';
  const dot = fileName.lastIndexOf('.');
  const explicitExtension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : null;
  const nonMarkdownTarget = explicitExtension && !['md', 'markdown'].includes(explicitExtension);
  const wikiResolution = nonMarkdownTarget
    ? null
    : resolveObsidianWikiLink(rawTarget, markdownCandidates, sourcePath);
  if (wikiResolution?.status === 'resolved' || wikiResolution?.status === 'ambiguous') {
    return wikiResolution;
  }
  const target = link.targetPathText;
  if (!target) return wikiResolution ?? { candidates: [], path: null, status: 'missing' };
  const exact = resolveExactWorkspaceLink(target.startsWith('/') ? target : `/${target}`, sourcePath, paths);
  if (exact.status === 'resolved') return exact;
  const relative = resolveExactWorkspaceLink(target, sourcePath, paths);
  if (relative.status === 'resolved') return relative;
  const base = target.split('/').pop()?.toLocaleLowerCase();
  const candidates = target.includes('/') || !base ? [] : Array.from(paths)
    .filter((path) => path.split('/').pop()?.toLocaleLowerCase() === base)
    .sort((a, b) => a.localeCompare(b));
  return { candidates, path: candidates.length === 1 ? candidates[0] : null,
    status: candidates.length === 1 ? 'resolved' : candidates.length > 1 ? 'ambiguous' : 'missing' };
}

export function buildWorkspaceLinkIndexFromDocuments(
  sources: WorkspaceLinkDocumentSource[],
  now: Date = new Date(),
  targetPaths: Iterable<string> = sources.map((source) => source.path),
  omittedSources: WorkspaceLinkIndex['omittedDocuments'] = [],
): WorkspaceLinkIndex {
  const pathSet = new Set(Array.from(targetPaths, normalizePath));
  for (const source of sources) pathSet.add(normalizePath(source.path));
  const parsedDocuments = sources.map((source) => {
    const frontmatter = parseObsidianFrontmatter(source.content);
    const headings = extractWorkspaceMarkdownHeadings(source.content);
    return {
      content: source.content,
      parsedLinks: parseWorkspaceLocalLinks(source.content, source.path),
      document: {
        aliases: frontmatter?.aliases ?? [],
        blockIds: parseObsidianBlockIds(source.content).map((block) => block.id),
        headings,
        hasExplicitTitle: Boolean(frontmatter?.title),
        path: normalizePath(source.path),
        tags: frontmatter?.tags ?? [],
        title: frontmatter?.title || headings[0]?.text || basenameWithoutExtension(source.path),
      } satisfies WorkspaceLinkDocument,
    };
  });

  const candidates: ObsidianLinkCandidate[] = parsedDocuments.map(({ document }) => ({
    aliases: document.aliases,
    extension: document.path.split('.').pop()?.toLowerCase(),
    path: document.path,
    type: 'file',
  }));
  const edges: WorkspaceLinkEdge[] = [];
  const unevaluatedLinks = parsedDocuments.flatMap((parsed) => parsed.parsedLinks.unevaluated);

  for (const parsed of parsedDocuments) {
    let byteCursor = 0;
    let byteOffset = 0;
    const utf8Offset = (offset: number): number => {
      byteOffset += Buffer.byteLength(parsed.content.slice(byteCursor, offset), 'utf8');
      byteCursor = offset;
      return byteOffset;
    };
    for (const link of parsed.parsedLinks.links) {
      const resolution = link.kind === 'markdown'
        ? resolveExactWorkspaceLink(link.targetPathText, parsed.document.path, pathSet)
        : resolveWorkspaceWikiFileLink(link, parsed.document.path, pathSet, candidates);
      let fragment = link.fragment ?? '';
      try { fragment = decodeURIComponent(fragment); } catch { /* Keep original spelling. */ }
      const targetRange = {
        startUtf16: link.targetStart,
        endUtf16: link.targetEnd,
        startUtf8Byte: utf8Offset(link.targetStart),
        endUtf8Byte: utf8Offset(link.targetEnd),
      };
      edges.push({
        alias: link.alias,
        blockId: fragment.startsWith('^') ? fragment.slice(1) || null : null,
        candidates: resolution.candidates,
        embed: link.embed,
        end: link.end,
        heading: fragment && !fragment.startsWith('^') ? fragment : null,
        id: `${parsed.document.path}:${link.start}`,
        kind: link.kind,
        raw: link.raw,
        sourcePath: parsed.document.path,
        start: link.start,
        status: resolution.status,
        syntax: link.syntax,
        targetPath: resolution.path,
        targetLiteral: link.targetLiteral,
        targetRange,
        targetText: link.targetPathText + (link.fragment !== null ? `#${link.fragment}` : ''),
      });
    }
  }

  const backlinks: Record<string, WorkspaceLinkEdge[]> = {};
  for (const path of pathSet) backlinks[path] = [];
  for (const edge of edges) {
    if (edge.targetPath) backlinks[edge.targetPath]?.push(edge);
  }

  return {
    backlinks,
    brokenLinks: edges.filter((edge) => edge.status !== 'resolved'),
    documents: parsedDocuments.map(({ document }) => document),
    edges,
    generatedAt: now.toISOString(),
    targetPaths: Array.from(pathSet).sort((a, b) => a.localeCompare(b)),
    unevaluatedLinks,
    coverage: {
      complete: omittedSources.length === 0 && unevaluatedLinks.length === 0
        && edges.every((edge) => edge.status === 'resolved'),
      omittedSources: omittedSources.map(({ path, reason }) => ({
        path,
        reason: reason === 'too-large' ? 'source-too-large' as const : 'source-unreadable' as const,
      })),
      unresolvedLinks: [
        ...edges.filter((edge) => edge.status !== 'resolved').map((edge) => ({
          sourcePath: edge.sourcePath, targetLiteral: edge.targetLiteral,
          status: edge.status as Exclude<WorkspaceLinkResolveStatusV1, 'resolved'>,
        })),
        ...unevaluatedLinks.map((link) => ({ sourcePath: link.sourcePath,
          targetLiteral: link.raw, status: 'not-evaluated' as const })),
      ],
    },
    omittedDocuments: omittedSources,
  };
}

function isSameOrDescendant(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

function remapPath(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) return newPath;
  return `${newPath}${path.slice(oldPath.length)}`;
}

export function rewriteWorkspaceWikiLinksForRename(
  content: string,
  edges: WorkspaceLinkEdge[],
  oldPath: string,
  newPath: string,
): { content: string; updatedLinks: number } {
  const normalizedOldPath = normalizePath(oldPath);
  const normalizedNewPath = normalizePath(newPath);
  const replacements = edges
    .filter((edge) => (
      edge.kind === 'wiki'
      && edge.status === 'resolved'
      && edge.targetPath
      && isSameOrDescendant(edge.targetPath, normalizedOldPath)
      && content.slice(edge.start, edge.end) === edge.raw
    ))
    .map((edge) => {
      const remappedTarget = remapPath(edge.targetPath!, normalizedOldPath, normalizedNewPath);
      const fragment = edge.blockId ? `#^${edge.blockId}` : edge.heading ? `#${edge.heading}` : '';
      const alias = edge.alias ? `|${edge.alias}` : '';
      return {
        end: edge.end,
        start: edge.start,
        value: `${edge.embed ? '!' : ''}[[${stripMarkdownExtension(remappedTarget)}${fragment}${alias}]]`,
      };
    })
    .sort((left, right) => right.start - left.start);

  let rewritten = content;
  for (const replacement of replacements) {
    rewritten = `${rewritten.slice(0, replacement.start)}${replacement.value}${rewritten.slice(replacement.end)}`;
  }
  return { content: rewritten, updatedLinks: replacements.length };
}

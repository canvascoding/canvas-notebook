import {
  createObsidianSyntaxMask,
  parseObsidianBlockIds,
  parseObsidianWikiLinks,
} from './obsidian-flavored-markdown';
import { parseObsidianFrontmatter } from './obsidian-metadata';
import {
  resolveObsidianWikiLink,
  stripMarkdownExtension,
  type ObsidianLinkCandidate,
} from './obsidian-link-resolver';

const NON_MARKDOWN_LINK_EXTENSIONS = new Set([
  'avif', 'bmp', 'csv', 'doc', 'docx', 'gif', 'html', 'jpeg', 'jpg', 'json',
  'm4a', 'mov', 'mp3', 'mp4', 'odp', 'ods', 'odt', 'pdf', 'png', 'ppt', 'pptx',
  'svg', 'tif', 'tiff', 'tsv', 'wav', 'webm', 'webp', 'xls', 'xlsx', 'xml', 'zip',
]);

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
  raw: string;
  sourcePath: string;
  start: number;
  status: 'resolved' | 'missing' | 'ambiguous';
  targetPath: string | null;
  targetText: string;
};

export type WorkspaceLinkIndex = {
  backlinks: Record<string, WorkspaceLinkEdge[]>;
  brokenLinks: WorkspaceLinkEdge[];
  documents: WorkspaceLinkDocument[];
  edges: WorkspaceLinkEdge[];
  generatedAt: string;
};

type ParsedLink = {
  alias: string | null;
  blockId: string | null;
  embed: boolean;
  end: number;
  heading: string | null;
  kind: 'wiki' | 'markdown';
  raw: string;
  start: number;
  targetText: string;
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

function getExplicitExtension(value: string): string | null {
  const fileName = value.replace(/\\/g, '/').split('/').pop() || '';
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex > 0 && dotIndex < fileName.length - 1
    ? fileName.slice(dotIndex + 1).toLowerCase()
    : null;
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

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseMarkdownLinks(markdown: string): ParsedLink[] {
  const mask = createObsidianSyntaxMask(markdown);
  const pattern = /(!)?\[([^\]\r\n]*)\]\((<[^>\r\n]+>|[^)\s]+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*\)/g;
  const links: ParsedLink[] = [];

  for (const match of mask.matchAll(pattern)) {
    const fullStart = match.index ?? 0;
    const raw = markdown.slice(fullStart, fullStart + match[0].length);
    const targetOffset = match[0].indexOf(match[3]);
    const rawUrl = markdown.slice(fullStart + targetOffset, fullStart + targetOffset + match[3].length);
    const url = rawUrl.replace(/^<|>$/g, '');
    if (!url || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) continue;

    const hashIndex = url.indexOf('#');
    const path = safeDecodeURIComponent(hashIndex >= 0 ? url.slice(0, hashIndex) : url);
    const fragment = safeDecodeURIComponent(hashIndex >= 0 ? url.slice(hashIndex + 1) : '');
    const extension = getExplicitExtension(path);
    if (extension && NON_MARKDOWN_LINK_EXTENSIONS.has(extension)) {
      continue;
    }

    links.push({
      alias: match[2]?.trim() || null,
      blockId: fragment.startsWith('^') ? fragment.slice(1) || null : null,
      embed: Boolean(match[1]),
      end: fullStart + match[0].length,
      heading: fragment && !fragment.startsWith('^') ? fragment : null,
      kind: 'markdown',
      raw,
      start: fullStart,
      targetText: `${path}${fragment ? `#${fragment}` : ''}`,
    });
  }
  return links;
}

function parseDocumentLinks(markdown: string): ParsedLink[] {
  const wikiLinks: ParsedLink[] = parseObsidianWikiLinks(markdown)
    .filter((link) => {
      const extension = getExplicitExtension(link.path);
      return !extension || !NON_MARKDOWN_LINK_EXTENSIONS.has(extension);
    })
    .map((link) => ({
      alias: link.alias,
      blockId: link.blockId,
      embed: link.embed,
      end: link.end,
      heading: link.heading,
      kind: 'wiki' as const,
      raw: markdown.slice(link.start, link.end),
      start: link.start,
      targetText: link.target,
    }));
  return [...wikiLinks, ...parseMarkdownLinks(markdown)].sort((left, right) => left.start - right.start);
}

export function buildWorkspaceLinkIndexFromDocuments(
  sources: WorkspaceLinkDocumentSource[],
  now: Date = new Date(),
): WorkspaceLinkIndex {
  const parsedDocuments = sources.map((source) => {
    const frontmatter = parseObsidianFrontmatter(source.content);
    const headings = extractWorkspaceMarkdownHeadings(source.content);
    return {
      content: source.content,
      links: parseDocumentLinks(source.content),
      document: {
        aliases: frontmatter?.aliases ?? [],
        blockIds: parseObsidianBlockIds(source.content).map((block) => block.id),
        headings,
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

  const resolveTargetText = (link: ParsedLink, sourcePath: string) => {
    if (link.kind !== 'markdown') return link.targetText;
    const hashIndex = link.targetText.indexOf('#');
    const targetPath = hashIndex >= 0 ? link.targetText.slice(0, hashIndex) : link.targetText;
    const fragment = hashIndex >= 0 ? link.targetText.slice(hashIndex) : '';
    if (!targetPath) return link.targetText;
    const parentPath = normalizePath(sourcePath).split('/').slice(0, -1).join('/');
    const resolvedPath = targetPath.startsWith('/')
      ? normalizePath(targetPath)
      : normalizePath(`${parentPath}/${targetPath}`);
    return `${resolvedPath}${fragment}`;
  };

  for (const parsed of parsedDocuments) {
    for (const link of parsed.links) {
      const resolutionTarget = resolveTargetText(link, parsed.document.path);
      const resolution = resolveObsidianWikiLink(resolutionTarget, candidates, parsed.document.path);
      if (!resolution) continue;
      edges.push({
        alias: link.alias,
        blockId: link.blockId,
        candidates: resolution.candidates,
        embed: link.embed,
        end: link.end,
        heading: link.heading,
        id: `${parsed.document.path}:${link.start}`,
        kind: link.kind,
        raw: link.raw,
        sourcePath: parsed.document.path,
        start: link.start,
        status: resolution.status,
        targetPath: resolution.path,
        targetText: link.targetText,
      });
    }
  }

  const backlinks: Record<string, WorkspaceLinkEdge[]> = {};
  for (const document of parsedDocuments.map(({ document }) => document)) backlinks[document.path] = [];
  for (const edge of edges) {
    if (edge.targetPath) backlinks[edge.targetPath]?.push(edge);
  }

  return {
    backlinks,
    brokenLinks: edges.filter((edge) => edge.status !== 'resolved'),
    documents: parsedDocuments.map(({ document }) => document),
    edges,
    generatedAt: now.toISOString(),
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

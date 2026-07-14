import type { WorkspaceFileReferenceEntry } from '@/app/lib/files/client';

import {
  createObsidianSyntaxMask,
  parseObsidianWikiTarget,
  type ObsidianWikiTarget,
} from './obsidian-flavored-markdown';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

export type ObsidianLinkResolution = {
  blockId: string | null;
  candidates: string[];
  heading: string | null;
  path: string | null;
  status: 'resolved' | 'missing' | 'ambiguous';
  target: ObsidianWikiTarget;
};

export type ObsidianWikiCompletionContext = {
  embed: boolean;
  fragmentQuery: string | null;
  from: number;
  kind: 'document' | 'heading' | 'block';
  pathQuery: string;
  query: string;
  to: number;
};

export type ObsidianLinkCandidate = Pick<
  WorkspaceFileReferenceEntry,
  'extension' | 'path' | 'type'
> & {
  aliases?: string[];
};

function normalizeWorkspacePath(value: string): string {
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

function getParentPath(value: string): string {
  const normalized = normalizeWorkspacePath(value);
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex >= 0 ? normalized.slice(0, slashIndex) : '';
}

function getBasename(value: string): string {
  return normalizeWorkspacePath(value).split('/').pop() || '';
}

export function stripMarkdownExtension(value: string): string {
  return value.replace(/\.(?:md|markdown)$/i, '');
}

export function isMarkdownReferenceEntry(
  entry: Pick<WorkspaceFileReferenceEntry, 'extension' | 'path' | 'type'>,
): boolean {
  if (entry.type !== 'file') return false;
  const extension = entry.extension?.toLowerCase() || entry.path.split('.').pop()?.toLowerCase();
  return Boolean(extension && MARKDOWN_EXTENSIONS.has(extension));
}

function addMarkdownPathVariants(paths: Set<string>, value: string): void {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized) return;
  paths.add(normalized);
  if (!/\.(?:md|markdown)$/i.test(normalized)) {
    paths.add(`${normalized}.md`);
    paths.add(`${normalized}.markdown`);
  }
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function rankResolvedCandidates(
  entries: ObsidianLinkCandidate[],
  targetPath: string,
  sourcePath: string | null,
): string[] {
  const paths = entries.map((entry) => normalizeWorkspacePath(entry.path));
  const exactPaths = new Set<string>();
  addMarkdownPathVariants(exactPaths, targetPath);
  if (sourcePath) {
    addMarkdownPathVariants(exactPaths, `${getParentPath(sourcePath)}/${targetPath}`);
  }

  const exactMatches = paths.filter((path) => exactPaths.has(path));
  if (exactMatches.length > 0) return uniqueSorted(exactMatches);

  const normalizedTarget = normalizeWorkspacePath(targetPath);
  const targetWithoutExtension = stripMarkdownExtension(normalizedTarget).toLocaleLowerCase();
  const targetHasDirectory = targetWithoutExtension.includes('/');

  const pathMatches = uniqueSorted(paths.filter((path) => {
    const pathWithoutExtension = stripMarkdownExtension(path).toLocaleLowerCase();
    if (targetHasDirectory) {
      return pathWithoutExtension === targetWithoutExtension
        || pathWithoutExtension.endsWith(`/${targetWithoutExtension}`);
    }
    return stripMarkdownExtension(getBasename(path)).toLocaleLowerCase() === targetWithoutExtension;
  }));
  if (pathMatches.length > 0) return pathMatches;

  if (targetHasDirectory) return [];
  return uniqueSorted(entries.flatMap((entry) => (
    entry.aliases?.some((alias) => alias.trim().toLocaleLowerCase() === targetWithoutExtension)
      ? [normalizeWorkspacePath(entry.path)]
      : []
  )));
}

export function resolveObsidianWikiLink(
  rawTarget: string,
  entries: ObsidianLinkCandidate[],
  sourcePath?: string | null,
): ObsidianLinkResolution | null {
  const target = parseObsidianWikiTarget(rawTarget);
  if (!target) return null;

  const normalizedSourcePath = sourcePath ? normalizeWorkspacePath(sourcePath) : null;
  const markdownEntries = entries.filter(isMarkdownReferenceEntry);

  let candidates: string[];
  if (!target.path) {
    candidates = normalizedSourcePath ? [normalizedSourcePath] : [];
  } else {
    candidates = rankResolvedCandidates(markdownEntries, target.path, normalizedSourcePath);
  }

  return {
    blockId: target.blockId,
    candidates,
    heading: target.heading,
    path: candidates.length === 1 ? candidates[0] : null,
    status: candidates.length === 1 ? 'resolved' : candidates.length > 1 ? 'ambiguous' : 'missing',
    target,
  };
}

/** Finds an unfinished [[target at the cursor without matching closed links or prior lines. */
export function findObsidianWikiCompletionContext(
  markdown: string,
  cursor: number,
): ObsidianWikiCompletionContext | null {
  const safeCursor = Math.max(0, Math.min(cursor, markdown.length));
  const lineStart = Math.max(markdown.lastIndexOf('\n', safeCursor - 1) + 1, 0);
  const linePrefix = markdown.slice(lineStart, safeCursor);
  const openingIndex = linePrefix.lastIndexOf('[[');
  if (openingIndex < 0) return null;

  const absoluteOpeningIndex = lineStart + openingIndex;
  const syntaxMask = createObsidianSyntaxMask(markdown);
  if (syntaxMask.slice(absoluteOpeningIndex, absoluteOpeningIndex + 2) !== '[[') return null;

  const rawQuery = linePrefix.slice(openingIndex + 2);
  if (rawQuery.includes(']]') || rawQuery.includes('|')) return null;

  const hashIndex = rawQuery.indexOf('#');
  const pathQuery = hashIndex >= 0 ? rawQuery.slice(0, hashIndex) : rawQuery;
  const fragmentQuery = hashIndex >= 0 ? rawQuery.slice(hashIndex + 1) : null;

  const embed = openingIndex > 0 && linePrefix[openingIndex - 1] === '!';
  return {
    embed,
    fragmentQuery,
    from: lineStart + openingIndex + 2,
    kind: fragmentQuery === null ? 'document' : fragmentQuery.startsWith('^') ? 'block' : 'heading',
    pathQuery,
    query: rawQuery,
    to: safeCursor,
  };
}

export function getObsidianWikiCompletionInsertPath(filePath: string): string {
  return stripMarkdownExtension(normalizeWorkspacePath(filePath));
}

function safelyDecodeLinkTarget(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Converts a relative Markdown href into the same target format used by wiki links. */
export function getWorkspaceMarkdownLinkTarget(
  href: string,
  sourcePath?: string | null,
): string | null {
  const trimmed = href.trim();
  if (!trimmed || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(trimmed)) return null;
  if (trimmed.includes('?')) return null;
  if (trimmed.startsWith('#')) {
    return sourcePath ? safelyDecodeLinkTarget(trimmed) : null;
  }

  const hashIndex = trimmed.indexOf('#');
  const path = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const fragment = hashIndex >= 0 ? trimmed.slice(hashIndex) : '';
  const fileName = path.replace(/\\/g, '/').split('/').pop() || '';
  const dotIndex = fileName.lastIndexOf('.');
  const extension = dotIndex > 0 && dotIndex < fileName.length - 1
    ? fileName.slice(dotIndex + 1).toLowerCase()
    : null;
  if (extension && !MARKDOWN_EXTENSIONS.has(extension)) return null;
  if (path.startsWith('/') && !extension) return null;

  return safelyDecodeLinkTarget(`${path}${fragment}`);
}

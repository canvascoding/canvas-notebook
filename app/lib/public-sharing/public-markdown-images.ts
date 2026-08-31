import {
  getObsidianWikiDisplayLabel,
  parseObsidianWikiLinks,
} from '@/app/lib/markdown/obsidian-flavored-markdown';
import { isMarkdownImagePath } from '@/app/lib/markdown/markdown-image-types';

const PRESERVED_URL_PREFIXES = ['/api/', '/public/', '/_next/'];
const EXTERNAL_URL_PATTERN = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;
const INLINE_IMAGE_PATTERN = /(!\[[^\]\n]*\]\(\s*)(<[^>\n]+>|[^\s)\n]+)([^)\n]*\))/g;
const HTML_IMAGE_PATTERN = /(<img\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)(\2)/gi;
const REFERENCE_DEFINITION_PATTERN = /^(\s*\[([^\]\n]+)\]:\s*)(<[^>\n]+>|[^\s\n]+)(.*)$/gm;
const REFERENCE_IMAGE_PATTERN = /!\[([^\]\n]*)\]\[([^\]\n]*)\]/g;
const SHORTCUT_REFERENCE_IMAGE_PATTERN = /!\[([^\]\n]+)\](?![[(])/g;

type SourceMatch = {
  source: string;
  index: number;
};

function splitUrlDecoration(value: string) {
  const queryIndex = value.indexOf('?');
  const hashIndex = value.indexOf('#');
  const indexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  const splitIndex = indexes.length > 0 ? Math.min(...indexes) : -1;

  return splitIndex < 0
    ? { pathname: value, suffix: '' }
    : { pathname: value.slice(0, splitIndex), suffix: value.slice(splitIndex) };
}

function decodePath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeWorkspacePath(value: string): string | null {
  const segments: string[] = [];
  for (const rawSegment of value.replace(/\\/g, '/').split('/')) {
    if (!rawSegment || rawSegment === '.') continue;

    const segment = decodePath(rawSegment);
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.length > 0 ? segments.join('/') : null;
}

function markdownDirectory(markdownWorkspacePath: string) {
  const normalized = normalizeWorkspacePath(markdownWorkspacePath);
  if (!normalized) return '';
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
}

function unwrapMarkdownDestination(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function normalizeReferenceLabel(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isPubliclyServedImagePath(workspacePath: string) {
  return isMarkdownImagePath(workspacePath);
}

function collectInlineAndHtmlImageSources(markdown: string): SourceMatch[] {
  const sources: SourceMatch[] = [];

  for (const match of markdown.matchAll(INLINE_IMAGE_PATTERN)) {
    const source = unwrapMarkdownDestination(match[2] || '');
    if (source) sources.push({ source, index: match.index ?? 0 });
  }

  for (const match of markdown.matchAll(HTML_IMAGE_PATTERN)) {
    const source = match[3] || '';
    if (source) sources.push({ source, index: match.index ?? 0 });
  }

  return sources;
}

function referencedImageLabels(markdown: string) {
  const labels = new Set<string>();

  for (const match of markdown.matchAll(REFERENCE_IMAGE_PATTERN)) {
    const alt = match[1] || '';
    const explicitLabel = match[2] || '';
    const label = normalizeReferenceLabel(explicitLabel || alt);
    if (label) labels.add(label);
  }

  for (const match of markdown.matchAll(SHORTCUT_REFERENCE_IMAGE_PATTERN)) {
    const label = normalizeReferenceLabel(match[1] || '');
    if (label) labels.add(label);
  }

  return labels;
}

function collectReferencedDefinitionSources(markdown: string): SourceMatch[] {
  const labels = referencedImageLabels(markdown);
  if (labels.size === 0) return [];

  const sources: SourceMatch[] = [];
  for (const match of markdown.matchAll(REFERENCE_DEFINITION_PATTERN)) {
    const label = normalizeReferenceLabel(match[2] || '');
    if (!labels.has(label)) continue;

    const source = unwrapMarkdownDestination(match[3] || '');
    if (source) sources.push({ source, index: match.index ?? 0 });
  }

  return sources;
}

function publicMarkdownImageSources(markdown: string): SourceMatch[] {
  return [
    ...collectInlineAndHtmlImageSources(markdown),
    ...collectReferencedDefinitionSources(markdown),
    ...parseObsidianWikiLinks(markdown)
      .filter((link) => link.embed && isMarkdownImagePath(link.path))
      .map((link) => ({ source: link.path, index: link.start })),
  ];
}

export function resolvePublicMarkdownImageWorkspacePath(markdownWorkspacePath: string, source: string): string | null {
  const trimmed = unwrapMarkdownDestination(source);
  if (!trimmed || EXTERNAL_URL_PATTERN.test(trimmed) || PRESERVED_URL_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return null;
  }

  const { pathname } = splitUrlDecoration(trimmed);
  if (!pathname) return null;

  const isWorkspaceAbsolute = pathname.startsWith('/');
  const candidate = isWorkspaceAbsolute
    ? pathname.slice(1)
    : [markdownDirectory(markdownWorkspacePath), pathname].filter(Boolean).join('/');
  const workspacePath = normalizeWorkspacePath(candidate);

  return workspacePath && isPubliclyServedImagePath(workspacePath) ? workspacePath : null;
}

export function collectPublicMarkdownImageWorkspacePaths(markdown: string, markdownWorkspacePath: string): Set<string> {
  const paths = new Set<string>();
  for (const { source } of publicMarkdownImageSources(markdown)) {
    const workspacePath = resolvePublicMarkdownImageWorkspacePath(markdownWorkspacePath, source);
    if (workspacePath) paths.add(workspacePath);
  }
  return paths;
}

export function publicMarkdownImagePath(token: string, workspacePath: string): string {
  const encodedPath = workspacePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `/public/markdown-assets/${encodeURIComponent(token)}/${encodedPath}`;
}

function rewriteImageSource(source: string, markdownWorkspacePath: string, token: string) {
  const workspacePath = resolvePublicMarkdownImageWorkspacePath(markdownWorkspacePath, source);
  if (!workspacePath) return source;

  const { suffix } = splitUrlDecoration(unwrapMarkdownDestination(source));
  const rewritten = `${publicMarkdownImagePath(token, workspacePath)}${suffix}`;
  return source.trim().startsWith('<') && source.trim().endsWith('>') ? `<${rewritten}>` : rewritten;
}

function rewriteObsidianWikiImageSources(markdown: string, markdownWorkspacePath: string, token: string) {
  const replacements = parseObsidianWikiLinks(markdown)
    .filter((link) => link.embed && isMarkdownImagePath(link.path))
    .map((link) => {
      const alt = getObsidianWikiDisplayLabel(link)
        .replace(/\\/gu, '\\\\')
        .replace(/\]/gu, '\\]');
      const source = rewriteImageSource(link.path, markdownWorkspacePath, token);
      return {
        end: link.end,
        start: link.start,
        value: `![${alt}](<${source}>)`,
      };
    })
    .sort((left, right) => right.start - left.start);

  let rewritten = markdown;
  for (const replacement of replacements) {
    rewritten = `${rewritten.slice(0, replacement.start)}${replacement.value}${rewritten.slice(replacement.end)}`;
  }
  return rewritten;
}

export function rewritePublicMarkdownImageSources(markdown: string, markdownWorkspacePath: string, token: string): string {
  const referencedLabels = referencedImageLabels(markdown);
  let rewritten = markdown.replace(INLINE_IMAGE_PATTERN, (match, before: string, source: string, after: string) => (
    `${before}${rewriteImageSource(source, markdownWorkspacePath, token)}${after}`
  ));

  rewritten = rewritten.replace(HTML_IMAGE_PATTERN, (match, before: string, quote: string, source: string, after: string) => (
    `${before}${quote}${rewriteImageSource(source, markdownWorkspacePath, token)}${after}`
  ));

  if (referencedLabels.size > 0) {
    rewritten = rewritten.replace(REFERENCE_DEFINITION_PATTERN, (match, before: string, label: string, source: string, after: string) => {
      if (!referencedLabels.has(normalizeReferenceLabel(label))) return match;
      return `${before}${rewriteImageSource(source, markdownWorkspacePath, token)}${after}`;
    });
  }

  return rewriteObsidianWikiImageSources(rewritten, markdownWorkspacePath, token);
}

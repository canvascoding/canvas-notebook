import { collectMarkdownImageNodes } from './markdown-image-nodes';
import { isMarkdownImagePath } from '@/app/lib/markdown/markdown-image-types';

const PRESERVED_URL_PREFIXES = ['/api/', '/public/', '/_next/'];
const EXTERNAL_URL_PATTERN = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;

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

function isPubliclyServedImagePath(workspacePath: string) {
  return isMarkdownImagePath(workspacePath);
}

function publicMarkdownImageSources(markdown: string) {
  return collectMarkdownImageNodes(markdown);
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

export function rewritePublicMarkdownImageSources(markdown: string, markdownWorkspacePath: string, token: string): string {
  let rewritten = markdown;
  for (const image of publicMarkdownImageSources(markdown).reverse()) {
    const source = rewriteImageSource(image.source, markdownWorkspacePath, token);
    if (source === image.source) continue;
    rewritten = `${rewritten.slice(0, image.index)}${image.replace(source)}${rewritten.slice(image.end)}`;
  }
  return rewritten;
}

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

function internalImageWorkspacePath(source: string, workspaceId?: string | null): string | null {
  // Only known, relative file URLs have workspace semantics. Never infer them
  // from an external origin, upload ID, arbitrary API or another workspace.
  const url = new URL(source, 'https://canvas.invalid');
  const scopes = url.searchParams.getAll('workspaceId');
  if (scopes.length > 1 || (scopes.length === 1 && (!workspaceId || scopes[0] !== workspaceId))) return null;
  let raw: string | null = null;
  if (url.pathname.startsWith('/api/media/') && !url.pathname.startsWith('/api/media/preview/')) {
    raw = url.pathname.slice('/api/media/'.length);
  } else if (url.pathname === '/api/files/preview' && url.searchParams.getAll('path').length === 1) {
    raw = url.searchParams.get('path');
  }
  if (!raw || /%2f|%5c|%00|\\|\u0000/i.test(raw)) return null;
  const path = normalizeWorkspacePath(raw);
  return path && isPubliclyServedImagePath(path) ? path : null;
}

export function resolvePublicMarkdownImageWorkspacePath(markdownWorkspacePath: string, source: string, workspaceId?: string | null): string | null {
  const trimmed = unwrapMarkdownDestination(source);
  if (trimmed.startsWith('/api/')) return internalImageWorkspacePath(trimmed, workspaceId);
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

export function collectPublicMarkdownImageWorkspacePaths(markdown: string, markdownWorkspacePath: string, workspaceId?: string | null): Set<string> {
  const paths = new Set<string>();
  for (const { source } of publicMarkdownImageSources(markdown)) {
    const workspacePath = resolvePublicMarkdownImageWorkspacePath(markdownWorkspacePath, source, workspaceId);
    if (workspacePath) paths.add(workspacePath);
  }
  return paths;
}

export function publicMarkdownImagePath(token: string, workspacePath: string): string {
  const encodedPath = workspacePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `/public/markdown-assets/${encodeURIComponent(token)}/${encodedPath}`;
}

function rewriteImageSource(source: string, markdownWorkspacePath: string, token: string, workspaceId?: string | null) {
  const workspacePath = resolvePublicMarkdownImageWorkspacePath(markdownWorkspacePath, source, workspaceId);
  if (!workspacePath) return source;

  const destination = unwrapMarkdownDestination(source);
  // Internal preview parameters contain private workspace IDs and are not
  // meaningful to the public image endpoint.
  const { suffix } = destination.startsWith('/api/') ? { suffix: '' } : splitUrlDecoration(destination);
  const rewritten = `${publicMarkdownImagePath(token, workspacePath)}${suffix}`;
  return source.trim().startsWith('<') && source.trim().endsWith('>') ? `<${rewritten}>` : rewritten;
}

export function rewritePublicMarkdownImageSources(markdown: string, markdownWorkspacePath: string, token: string, workspaceId?: string | null): string {
  let rewritten = markdown;
  for (const image of publicMarkdownImageSources(markdown).reverse()) {
    const source = rewriteImageSource(image.source, markdownWorkspacePath, token, workspaceId);
    if (source === image.source) continue;
    rewritten = `${rewritten.slice(0, image.index)}${image.replace(source)}${rewritten.slice(image.end)}`;
  }
  return rewritten;
}

import { toHtmlPreviewUrl } from '@/app/lib/utils/media-url';
import type { MediaUrlOptions } from '@/app/lib/utils/media-url';

type MarkdownImageUrlResult =
  | {
      ok: true;
      src: string;
      workspacePath?: string;
      rewritten: boolean;
    }
  | {
      ok: false;
      src: string;
      error: string;
    };

const PRESERVED_PROTOCOLS = new Set(['http:', 'https:', 'data:', 'blob:']);
const PRESERVED_ABSOLUTE_PREFIXES = [
  '/api/',
  '/public/',
  '/_next/',
];

function getProtocol(value: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z\d+.-]*:)/.exec(value);
  return match ? match[1].toLowerCase() : null;
}

function splitUrlDecoration(value: string) {
  const queryIndex = value.indexOf('?');
  const hashIndex = value.indexOf('#');
  const indexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  const splitIndex = indexes.length > 0 ? Math.min(...indexes) : -1;

  if (splitIndex < 0) {
    return { pathname: value, suffix: '' };
  }

  return {
    pathname: value.slice(0, splitIndex),
    suffix: value.slice(splitIndex),
  };
}

function appendUrlDecoration(url: string, suffix: string) {
  if (!suffix) return url;
  if (suffix.startsWith('#')) return `${url}${suffix}`;
  if (!suffix.startsWith('?')) return `${url}${suffix}`;

  const hashIndex = suffix.indexOf('#');
  const query = hashIndex >= 0 ? suffix.slice(1, hashIndex) : suffix.slice(1);
  const hash = hashIndex >= 0 ? suffix.slice(hashIndex) : '';
  if (!query) return `${url}${hash}`;

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${query}${hash}`;
}

function decodePathSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function normalizeWorkspacePath(value: string): string | null {
  const parts: string[] = [];
  const normalizedValue = value.replace(/\\/g, '/').replace(/^\/+/, '');

  for (const rawSegment of normalizedValue.split('/')) {
    if (!rawSegment || rawSegment === '.') continue;

    const segment = decodePathSegment(rawSegment);
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }

    parts.push(segment);
  }

  return parts.length > 0 ? parts.join('/') : null;
}

function getWorkspaceDir(filePath: string) {
  const normalizedPath = normalizeWorkspacePath(filePath);
  if (!normalizedPath) return '';

  const lastSlashIndex = normalizedPath.lastIndexOf('/');
  return lastSlashIndex >= 0 ? normalizedPath.slice(0, lastSlashIndex) : '';
}

function shouldPreserveAbsolutePath(src: string) {
  return PRESERVED_ABSOLUTE_PREFIXES.some((prefix) => src.startsWith(prefix));
}

export function resolveMarkdownImageUrl(
  rawSrc: string | undefined,
  markdownFilePath?: string,
  options: MediaUrlOptions = {},
): MarkdownImageUrlResult {
  const src = rawSrc?.trim() || '';
  if (!src) {
    return { ok: false, src, error: 'Image source is empty.' };
  }

  if (src.startsWith('//')) {
    return { ok: true, src, rewritten: false };
  }

  const protocol = getProtocol(src);
  if (protocol) {
    if (PRESERVED_PROTOCOLS.has(protocol)) {
      return { ok: true, src, rewritten: false };
    }

    return {
      ok: false,
      src,
      error: `Unsupported image URL protocol: ${protocol}`,
    };
  }

  if (shouldPreserveAbsolutePath(src)) {
    return { ok: true, src, rewritten: false };
  }

  const { pathname, suffix } = splitUrlDecoration(src);
  if (!pathname) {
    return { ok: false, src, error: 'Image source path is empty.' };
  }

  const isWorkspaceAbsolute = pathname.startsWith('/');
  if (!isWorkspaceAbsolute && !markdownFilePath) {
    return { ok: true, src, rewritten: false };
  }

  const baseDir = isWorkspaceAbsolute ? '' : getWorkspaceDir(markdownFilePath || '');
  const candidatePath = isWorkspaceAbsolute
    ? pathname.slice(1)
    : [baseDir, pathname].filter(Boolean).join('/');
  const workspacePath = normalizeWorkspacePath(candidatePath);

  if (!workspacePath) {
    return {
      ok: false,
      src,
      error: 'Image path resolves outside the workspace.',
    };
  }

  return {
    ok: true,
    src: appendUrlDecoration(toHtmlPreviewUrl(workspacePath, options), suffix),
    workspacePath,
    rewritten: true,
  };
}

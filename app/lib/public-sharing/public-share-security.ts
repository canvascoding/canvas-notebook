import path from 'node:path';

export type PublicShareSecurityMode = 'strict' | 'interactive';

export const STRICT_PUBLIC_HTML_CSP = [
  'sandbox',
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  'img-src data: blob:',
  'media-src data: blob:',
  "style-src 'unsafe-inline'",
  'font-src data:',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const INTERACTIVE_PUBLIC_HTML_CSP = [
  'sandbox allow-scripts allow-popups allow-downloads',
  "default-src http: https: data: blob:",
  "script-src http: https: data: blob: 'unsafe-inline' 'unsafe-eval'",
  "style-src http: https: 'unsafe-inline'",
  'img-src http: https: data: blob:',
  'font-src http: https: data:',
  'media-src http: https: data: blob:',
  'connect-src http: https: ws: wss:',
  "worker-src http: https: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const PUBLIC_SHARE_ASSET_CSP = [
  "default-src 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "style-src 'none'",
  "script-src 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function normalizePublicShareSecurityMode(value: unknown): PublicShareSecurityMode {
  return value === 'interactive' ? 'interactive' : 'strict';
}

export function isHtmlWorkspacePath(filePath: string): boolean {
  const extension = path.posix.extname(filePath).slice(1).toLowerCase();
  return extension === 'html' || extension === 'htm';
}

export function isInteractiveHtmlPublicShare(share: {
  securityMode?: string | null;
  mimeType?: string | null;
  workspacePath?: string | null;
}): boolean {
  return normalizePublicShareSecurityMode(share.securityMode) === 'interactive'
    && (
      share.mimeType?.toLowerCase().includes('text/html')
      || Boolean(share.workspacePath && isHtmlWorkspacePath(share.workspacePath))
    );
}

export function resolvePublicHtmlSiteAssetWorkspacePath(
  entryWorkspacePath: string,
  requestedPathParts: string[] | undefined,
): string | null {
  const normalizedEntryPath = path.posix.normalize(
    entryWorkspacePath.trim().replace(/\0/g, '').replace(/\\/g, '/').replace(/^\/+/, '')
  );
  if (!normalizedEntryPath || normalizedEntryPath === '.' || normalizedEntryPath.startsWith('../')) {
    return null;
  }

  const entryFileName = path.posix.basename(normalizedEntryPath);
  const requestedPath = (requestedPathParts?.join('/') || entryFileName)
    .trim()
    .replace(/\0/g, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!requestedPath) return normalizedEntryPath;

  const normalizedRequestPath = path.posix.normalize(requestedPath);
  if (
    normalizedRequestPath === '.'
    || normalizedRequestPath.startsWith('../')
    || normalizedRequestPath.includes('/../')
  ) {
    return null;
  }

  if (normalizedRequestPath === entryFileName) {
    return normalizedEntryPath;
  }

  const entryDir = path.posix.dirname(normalizedEntryPath);
  const candidatePath = entryDir === '.'
    ? normalizedRequestPath
    : path.posix.normalize(path.posix.join(entryDir, normalizedRequestPath));

  if (candidatePath.startsWith('../') || candidatePath.includes('/../')) {
    return null;
  }

  if (entryDir !== '.' && candidatePath !== entryDir && !candidatePath.startsWith(`${entryDir}/`)) {
    return null;
  }

  return candidatePath;
}

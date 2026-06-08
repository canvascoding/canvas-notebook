const HTML_EXTENSIONS = new Set(['html', 'htm']);

const HTML_PREVIEW_ASSET_CONTENT_TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
};

export const HTML_PREVIEW_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' data: https:",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob: https: http:",
  "connect-src 'self' https: http:",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
].join('; ');

export const HTML_PREVIEW_ASSET_CSP = [
  "default-src 'none'",
  "frame-ancestors 'self'",
].join('; ');

function getExtension(filePath: string) {
  return filePath.split('.').pop()?.toLowerCase() || '';
}

function encodePathSegments(filePath: string) {
  return filePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function isHtmlFile(filePath: string): boolean {
  return HTML_EXTENSIONS.has(getExtension(filePath));
}

export function getHtmlPreviewAssetContentType(filePath: string): string {
  return HTML_PREVIEW_ASSET_CONTENT_TYPES[getExtension(filePath)] || 'application/octet-stream';
}

export function createHtmlPreviewBaseHref(routePrefix: string, filePath: string) {
  const cleanPrefix = routePrefix.replace(/\/+$/, '');
  const parentPath = filePath.split('/').slice(0, -1).join('/');
  const encodedParent = encodePathSegments(parentPath);
  return encodedParent ? `${cleanPrefix}/${encodedParent}/` : `${cleanPrefix}/`;
}

export function injectHtmlPreviewBase(html: string, baseHref: string) {
  if (/<base[\s/>]/i.test(html)) {
    return html;
  }

  const baseTag = `<base href="${escapeHtmlAttribute(baseHref)}">`;
  const headOpenTag = /<head(\s[^>]*)?>/i;

  if (headOpenTag.test(html)) {
    return html.replace(headOpenTag, (match) => `${match}\n  ${baseTag}`);
  }

  const htmlOpenTag = /<html(\s[^>]*)?>/i;
  if (htmlOpenTag.test(html)) {
    return html.replace(htmlOpenTag, (match) => `${match}\n<head>\n  ${baseTag}\n</head>`);
  }

  return `<head>\n  ${baseTag}\n</head>\n${html}`;
}

export function createHtmlPreviewDocument(html: string, filePath: string, routePrefix: string) {
  return injectHtmlPreviewBase(html, createHtmlPreviewBaseHref(routePrefix, filePath));
}

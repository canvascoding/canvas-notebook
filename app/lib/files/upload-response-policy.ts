import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  xml: 'text/xml',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
};

const ACTIVE_CONTENT_EXTENSIONS = new Set([
  'cjs',
  'htm',
  'html',
  'js',
  'mjs',
  'svg',
  'xhtml',
  'xml',
]);

function attachmentDisposition(fileName: string): string {
  const safeName = path.basename(fileName).replace(/["\r\n\\]/gu, '_') || 'attachment';
  return `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

export interface UploadResponsePolicy {
  contentType: string;
  contentDisposition: string | null;
  forceDownload: boolean;
}

export function getUploadResponsePolicy(fileName: string): UploadResponsePolicy {
  const extension = path.extname(fileName).slice(1).toLowerCase();
  const forceDownload = ACTIVE_CONTENT_EXTENSIONS.has(extension);
  return {
    contentType: forceDownload
      ? 'application/octet-stream'
      : CONTENT_TYPES[extension] || 'application/octet-stream',
    contentDisposition: forceDownload ? attachmentDisposition(fileName) : null,
    forceDownload,
  };
}

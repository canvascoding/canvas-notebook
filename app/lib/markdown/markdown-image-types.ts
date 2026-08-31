const MARKDOWN_IMAGE_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'webp',
]);

export function isMarkdownImagePath(value: string): boolean {
  const pathname = value.trim().split(/[?#]/u, 1)[0] || '';
  const fileName = pathname.replace(/\\/gu, '/').split('/').pop() || '';
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return false;
  return MARKDOWN_IMAGE_EXTENSIONS.has(fileName.slice(dotIndex + 1).toLowerCase());
}

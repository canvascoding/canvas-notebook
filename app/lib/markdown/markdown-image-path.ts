function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function normalizeWorkspaceMarkdownPath(value: string | null | undefined): string {
  const input = (value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const parts: string[] = [];

  for (const rawSegment of input.split('/')) {
    if (!rawSegment || rawSegment === '.') continue;

    const segment = decodeSegment(rawSegment);
    if (segment === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }

    parts.push(segment);
  }

  return parts.join('/');
}

export function getMarkdownFileDir(filePath: string | null | undefined): string {
  const normalizedPath = normalizeWorkspaceMarkdownPath(filePath);
  if (!normalizedPath) return '.';

  const slashIndex = normalizedPath.lastIndexOf('/');
  return slashIndex >= 0 ? normalizedPath.slice(0, slashIndex) : '.';
}

export function getWorkspaceTargetDirForMarkdown(filePath: string | null | undefined): string {
  return getMarkdownFileDir(filePath);
}

export function markdownImageSrcForWorkspacePath(
  imagePath: string,
  markdownFilePath: string | null | undefined,
): string {
  const normalizedImagePath = normalizeWorkspaceMarkdownPath(imagePath);
  if (!normalizedImagePath) return '';

  const baseDir = getMarkdownFileDir(markdownFilePath);
  if (!baseDir || baseDir === '.') return normalizedImagePath;

  const baseParts = baseDir.split('/').filter(Boolean);
  const imageParts = normalizedImagePath.split('/').filter(Boolean);
  let commonLength = 0;

  while (
    commonLength < baseParts.length
    && commonLength < imageParts.length
    && baseParts[commonLength] === imageParts[commonLength]
  ) {
    commonLength += 1;
  }

  const upParts = Array.from({ length: baseParts.length - commonLength }, () => '..');
  const downParts = imageParts.slice(commonLength);
  return [...upParts, ...downParts].join('/') || imageParts.at(-1) || normalizedImagePath;
}

export interface FilePathEntry {
  path: string;
  label: string;
}

const FILE_PATH_REGEX =
  /(?:\/data\/workspace\/[^\s)\]}'"`,;]+)|(?:\.\/[\w./-]+\.[\w]+)|(?:[\w-]+(?:\/[\w.-]+)+\.[\w]+)/g;

const MARKDOWN_LINK_REGEX = /\[([^\]]*)\]\(([^)]+)\)/g;

function hasFileExtension(path: string): boolean {
  const lastSegment = path.split('/').pop() || '';
  return /\.[a-zA-Z0-9]{1,10}$/.test(lastSegment);
}

function isLocalFilePath(href: string): boolean {
  if (!href || href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#') || href.startsWith('mailto:')) {
    return false;
  }
  if (href.startsWith('/data/workspace/')) return true;
  if (href.startsWith('./')) return hasFileExtension(href);
  if (href.startsWith('/')) return hasFileExtension(href);
  if (hasFileExtension(href) && href.includes('/')) return true;
  return false;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\/|\/$/g, '');
}

function getFileName(path: string): string {
  const normalized = normalizePath(path);
  const lastSegment = normalized.split('/').pop() || normalized;
  return lastSegment;
}

export function extractFilePaths(content: string): FilePathEntry[] {
  const seen = new Set<string>();
  const results: FilePathEntry[] = [];

  const mdMatches = [...content.matchAll(MARKDOWN_LINK_REGEX)];
  for (const match of mdMatches) {
    const label = match[1];
    const href = match[2];
    if (isLocalFilePath(href)) {
      const normalized = normalizePath(href);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        results.push({
          path: normalized,
          label: label || getFileName(href),
        });
      }
    }
  }

  const bareMatches = [...content.matchAll(FILE_PATH_REGEX)];
  for (const match of bareMatches) {
    const rawPath = match[0];
    if (isLocalFilePath(rawPath)) {
      const normalized = normalizePath(rawPath);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        results.push({
          path: normalized,
          label: getFileName(rawPath),
        });
      }
    }
  }

  return results;
}
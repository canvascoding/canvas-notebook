export interface FilePathEntry {
  path: string;
  label: string;
}

const ABSOLUTE_WORKSPACE_PREFIX = '/data/workspace/';

export function normalizeChatFilePath(filePath: string): string {
  return filePath
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/^\.\/|\/$/g, '')
    .replace(/^\/data\/workspace\//, '');
}

export function isFilePath(href: string): boolean {
  if (!href || href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto:')) {
    return false;
  }

  if (href.startsWith('/api/')) {
    return false;
  }

  if (href.startsWith('/') && !href.startsWith(ABSOLUTE_WORKSPACE_PREFIX)) {
    return false;
  }

  const hasExtension = /\.[^./\\]+$/.test(href);
  const isRelativePath = !href.startsWith('/') && (href.includes('/') || hasExtension);
  const isAbsoluteWorkspacePath = href.startsWith(ABSOLUTE_WORKSPACE_PREFIX);

  return isRelativePath || isAbsoluteWorkspacePath;
}

const FILE_PATH_REGEX =
  /(?:\/data\/workspace\/[^\s)\]}'"`,;]+)|(?:\.\/[\w./-]+\.[\w]+)|(?:[\w-]+(?:\/[\w.-]+)+\.[\w]+)|(?:["'`](?:[\w][\w./-]+\.[a-zA-Z0-9]{1,10})["'`])/g;

const MARKDOWN_LINK_REGEX = /\[([^\]]*)\]\(([^)]+)\)/g;

function normalizePath(path: string): string {
  return normalizeChatFilePath(path);
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
    if (isFilePath(href)) {
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
    const cleaned = normalizePath(rawPath);
    if (isFilePath(cleaned)) {
      if (!seen.has(cleaned)) {
        seen.add(cleaned);
        results.push({
          path: cleaned,
          label: getFileName(rawPath),
        });
      }
    }
  }

  return results;
}

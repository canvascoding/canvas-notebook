import { isFilePath, normalizeChatFilePath } from './extract-file-paths';

const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdx)$/i;

function decodeDisplayPath(path: string): string {
  try { return decodeURIComponent(path); } catch { return path; }
}

function localDocumentPath(href: string, allowExtensionless = false): string | null {
  const path = href.split(/[?#]/, 1)[0];
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)
    || !isFilePath(path) && !(allowExtensionless && path && !path.startsWith('/'))) return null;
  return normalizeChatFilePath(decodeDisplayPath(path)) || null;
}

export function isChatMarkdownDocumentPath(href: string): boolean {
  const path = localDocumentPath(href);
  return Boolean(path && MARKDOWN_EXTENSION.test(path));
}

export function getChatDocumentLinkLabel(
  href: string,
  label: string,
  { allowExtensionless = false }: { allowExtensionless?: boolean } = {},
): string | null {
  const path = localDocumentPath(href, allowExtensionless);
  if (!path) return null;
  const fileName = path.split('/').pop()!;
  const hasMarkdownExtension = MARKDOWN_EXTENSION.test(fileName);
  if (!hasMarkdownExtension && (!allowExtensionless || fileName.includes('.'))) return null;

  const stem = fileName.replace(MARKDOWN_EXTENSION, '');
  if (!stem) return null;
  const normalizedLabel = normalizeChatFilePath(decodeDisplayPath(label.trim()));
  if (!normalizedLabel) return null;
  const stemPath = path.replace(MARKDOWN_EXTENSION, '');
  const matchesTarget = [path, stemPath].some((target) => (
    normalizedLabel === target || target.endsWith(`/${normalizedLabel}`)
  ));
  return matchesTarget ? stem.replace(/^\p{L}/u, (letter) => letter.toUpperCase()) : null;
}

const MARP_MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const MARP_NAMED_FILE_REGEX = /\.(marp|slides)\.(md|markdown)$/i;
const MARP_COMMENT_REGEX = /<!--\s*marp\s*:\s*(true|yes|on)\s*-->/i;
const MARP_FRONTMATTER_REGEX = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MARP_FRONTMATTER_LINE_REGEX = /^\s*marp\s*:\s*(true|yes|on|"true"|'true')\s*$/im;

export function isMarpMarkdownPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return Array.from(MARP_MARKDOWN_EXTENSIONS).some((extension) => lower.endsWith(extension));
}

export function hasMarpFileName(filePath: string): boolean {
  return MARP_NAMED_FILE_REGEX.test(filePath);
}

export function hasMarpDirective(markdown: string): boolean {
  if (MARP_COMMENT_REGEX.test(markdown.slice(0, 4096))) {
    return true;
  }

  const frontmatter = markdown.match(MARP_FRONTMATTER_REGEX);
  if (!frontmatter) {
    return false;
  }

  return MARP_FRONTMATTER_LINE_REGEX.test(frontmatter[1]);
}

export function isMarpMarkdown(filePath: string, markdown?: string): boolean {
  if (!isMarpMarkdownPath(filePath)) {
    return false;
  }

  if (hasMarpFileName(filePath)) {
    return true;
  }

  return markdown ? hasMarpDirective(markdown) : false;
}

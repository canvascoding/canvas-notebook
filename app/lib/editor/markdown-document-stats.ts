export type MarkdownDocumentStats = {
  characters: number;
  words: number;
};

export function markdownTextForStats(markdown: string): string {
  return markdown
    .replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, '')
    .replace(/```[^\r\n]*\r?\n([\s\S]*?)```/gu, '$1')
    .replace(/<[^>\r\n]+>/gu, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/gu, (_match, target, alias) => (
      typeof alias === 'string' && alias.trim() ? alias : target
    ))
    .replace(/^\[\^[^\]\r\n]+\]:[ \t]*/gmu, '')
    .replace(/\[\^[^\]\r\n]+\]/gu, ' ')
    .replace(/\^\[([^\]]+)\]/gu, '$1')
    .replace(/^ {0,3}>[ \t]*(?:\[![^\]]+\][+-]?[ \t]*)?/gmu, '')
    .replace(/^ {0,3}(?:#{1,6}|[-+*]|\d+[.)])[ \t]+/gmu, '')
    .replace(/^ {0,3}[-*_]{3,}[ \t]*$/gmu, ' ')
    .replace(/[*_~=`$]+/gu, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .trim();
}

export function getMarkdownDocumentStats(markdown: string): MarkdownDocumentStats {
  const text = markdownTextForStats(markdown);
  const words = text.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  return {
    characters: Array.from(text).length,
    words,
  };
}

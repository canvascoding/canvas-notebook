import { parse as parseYaml } from 'yaml';

export type ObsidianFrontmatter = {
  aliases: string[];
  data: Record<string, unknown>;
  end: number;
  raw: string;
  start: number;
  tags: string[];
  title: string | null;
};

const MAX_FRONTMATTER_LENGTH = 64 * 1024;

function toStringList(value: unknown, splitWhitespace: boolean): string[] {
  const valueIsArray = Array.isArray(value);
  const values = valueIsArray ? value : value == null ? [] : [value];
  const normalized = values.flatMap((item) => {
    if (typeof item !== 'string' && typeof item !== 'number') return [];
    const text = String(item).trim();
    if (!text) return [];
    if (!splitWhitespace || valueIsArray) return [text];
    return text.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
  });

  return Array.from(new Set(normalized));
}

export function parseObsidianFrontmatter(markdown: string): ObsidianFrontmatter | null {
  const start = markdown.charCodeAt(0) === 0xfeff ? 1 : 0;
  const source = markdown.slice(start);
  const opener = source.match(/^---[ \t]*\r?\n/);
  if (!opener) return null;

  const contentStart = start + opener[0].length;
  const closingPattern = /^---[ \t]*(?:\r?\n|$)/gm;
  closingPattern.lastIndex = contentStart;
  const closing = closingPattern.exec(markdown);
  if (!closing) return null;

  const end = closing.index + closing[0].length;
  if (end - start > MAX_FRONTMATTER_LENGTH) return null;

  const raw = markdown.slice(contentStart, closing.index);
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }

  const titleValue = data.title;
  const title = typeof titleValue === 'string' || typeof titleValue === 'number'
    ? String(titleValue).trim() || null
    : null;

  return {
    aliases: toStringList(data.aliases ?? data.alias, false),
    data,
    end,
    raw,
    start,
    tags: toStringList(data.tags ?? data.tag, true).map((tag) => tag.replace(/^#/, '')),
    title,
  };
}

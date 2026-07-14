import { isMap, parseDocument, type Document } from 'yaml';

export type ObsidianFrontmatter = {
  aliases: string[];
  data: Record<string, unknown>;
  end: number;
  raw: string;
  start: number;
  tags: string[];
  title: string | null;
};

export type CanvasMarkdownDocument = {
  body: string;
  error: string | null;
  frontmatter: ObsidianFrontmatter | null;
  frontmatterPrefix: string;
  hasFrontmatter: boolean;
};

export type CanvasMarkdownPropertiesPatch = {
  aliases?: string[] | null;
  properties?: Record<string, unknown>;
  tags?: string[] | null;
  title?: string | null;
};

export type CanvasMarkdownUpdateResult = {
  changed: boolean;
  error: string | null;
  markdown: string;
};

type FrontmatterBoundary = {
  contentStart: number;
  end: number;
  rawEnd: number;
  start: number;
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

function findFrontmatterBoundary(markdown: string): FrontmatterBoundary | null {
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

  return {
    contentStart,
    end,
    rawEnd: closing.index,
    start,
  };
}

function getYamlDocument(raw: string): Document.Parsed {
  return parseDocument(raw, {
    keepSourceTokens: true,
    prettyErrors: false,
  });
}

function getYamlError(document: Document.Parsed): string | null {
  if (document.errors.length === 0) return null;
  return document.errors.map((error) => error.message).join('; ');
}

function toFrontmatter(
  markdown: string,
  boundary: FrontmatterBoundary,
  document: Document.Parsed,
): ObsidianFrontmatter {
  const parsed = document.errors.length === 0 ? document.toJS() : null;
  const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const titleValue = data.title;
  const title = typeof titleValue === 'string' || typeof titleValue === 'number'
    ? String(titleValue).trim() || null
    : null;

  return {
    aliases: toStringList(data.aliases ?? data.alias, false),
    data,
    end: boundary.end,
    raw: markdown.slice(boundary.contentStart, boundary.rawEnd),
    start: boundary.start,
    tags: toStringList(data.tags ?? data.tag, true).map((tag) => tag.replace(/^#/, '')),
    title,
  };
}

export function normalizeCanvasTag(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/^#+/, '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^[-/]+|[-/]+$/g, '');
}

export function normalizeCanvasTags(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const value of values) {
    const tag = normalizeCanvasTag(value);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }

  return tags;
}

export function parseCanvasMarkdownDocument(markdown: string): CanvasMarkdownDocument {
  const hasFrontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n/.test(markdown);
  if (!hasFrontmatter) {
    return {
      body: markdown,
      error: null,
      frontmatter: null,
      frontmatterPrefix: '',
      hasFrontmatter: false,
    };
  }

  const boundary = findFrontmatterBoundary(markdown);
  if (!boundary) {
    return {
      body: markdown,
      error: 'Frontmatter ist nicht geschlossen oder überschreitet 64 KB.',
      frontmatter: null,
      frontmatterPrefix: '',
      hasFrontmatter: true,
    };
  }

  const raw = markdown.slice(boundary.contentStart, boundary.rawEnd);
  const document = getYamlDocument(raw);
  const yamlError = getYamlError(document);
  const rootError = !yamlError && document.contents !== null && !isMap(document.contents)
    ? 'Frontmatter muss ein YAML-Objekt mit Schlüssel-Wert-Paaren sein.'
    : null;
  const error = yamlError ?? rootError;

  return {
    body: markdown.slice(boundary.end),
    error,
    frontmatter: toFrontmatter(markdown, boundary, document),
    frontmatterPrefix: markdown.slice(0, boundary.end),
    hasFrontmatter: true,
  };
}

export function composeCanvasMarkdownDocument(
  frontmatterPrefix: string,
  body: string,
): string {
  return `${frontmatterPrefix}${body}`;
}

export function splitCanvasMarkdownForRichEditor(markdown: string): {
  body: string;
  prefix: string;
} {
  const parsed = parseCanvasMarkdownDocument(markdown);
  if (!parsed.frontmatter || parsed.error) return { body: markdown, prefix: '' };

  const leadingBlankLines = parsed.body.match(/^(?:\r?\n)+/)?.[0] ?? '';
  return {
    body: parsed.body.slice(leadingBlankLines.length),
    prefix: `${parsed.frontmatterPrefix}${leadingBlankLines}`,
  };
}

function setDocumentValue(
  document: Document.Parsed,
  key: string,
  value: unknown,
): void {
  if (value === null) {
    document.delete(key);
    return;
  }
  document.set(key, value);
}

export function updateCanvasMarkdownProperties(
  markdown: string,
  patch: CanvasMarkdownPropertiesPatch,
): CanvasMarkdownUpdateResult {
  const parsed = parseCanvasMarkdownDocument(markdown);
  if (parsed.error) {
    return { changed: false, error: parsed.error, markdown };
  }

  const document = getYamlDocument(parsed.frontmatter?.raw ?? '');
  const yamlError = getYamlError(document);
  if (yamlError) return { changed: false, error: yamlError, markdown };
  if (document.contents !== null && !isMap(document.contents)) {
    return {
      changed: false,
      error: 'Frontmatter muss ein YAML-Objekt mit Schlüssel-Wert-Paaren sein.',
      markdown,
    };
  }

  if (patch.title !== undefined) {
    const title = patch.title?.trim() || null;
    setDocumentValue(document, 'title', title);
  }
  if (patch.tags !== undefined) {
    setDocumentValue(document, 'tags', patch.tags === null ? null : normalizeCanvasTags(patch.tags));
    if (document.has('tag')) document.delete('tag');
  }
  if (patch.aliases !== undefined) {
    const aliases = patch.aliases === null
      ? null
      : Array.from(new Set(patch.aliases.map((alias) => alias.trim()).filter(Boolean)));
    setDocumentValue(document, 'aliases', aliases);
    if (document.has('alias')) document.delete('alias');
  }
  for (const [key, value] of Object.entries(patch.properties ?? {})) {
    const normalizedKey = key.trim();
    if (!normalizedKey || ['__proto__', 'constructor', 'prototype'].includes(normalizedKey)) continue;
    setDocumentValue(document, normalizedKey, value);
  }

  const yaml = document.toString({ lineWidth: 0 }).trimEnd();
  const bom = markdown.charCodeAt(0) === 0xfeff ? '\uFEFF' : '';
  const body = parsed.body;
  const separator = body.length === 0 || body.startsWith('\n') || body.startsWith('\r\n') ? '' : '\n';
  const updated = `${bom}---\n${yaml}\n---\n${separator}${body}`;

  return {
    changed: updated !== markdown,
    error: null,
    markdown: updated,
  };
}

export function parseObsidianFrontmatter(markdown: string): ObsidianFrontmatter | null {
  return parseCanvasMarkdownDocument(markdown).frontmatter;
}

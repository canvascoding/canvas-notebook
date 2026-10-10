import path from 'node:path';

import { fileTypeFromBuffer } from 'file-type';

import { validateTextFileContent } from '@/app/lib/files/text-content-validation';
import { createObsidianSyntaxMask } from '@/app/lib/markdown/obsidian-flavored-markdown';
import { parseCanvasMarkdownDocument } from '@/app/lib/markdown/obsidian-metadata';
import { analyzeMarkdownRichMode } from '@/app/lib/markdown/rich-markdown-codec';

export const DIRECT_MCP_INGEST_MAX_TEXT_BYTES = 512 * 1024;
export const DIRECT_MCP_INGEST_MAX_BINARY_BYTES = 25 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  '.csv', '.html', '.json', '.markdown', '.md', '.mdx', '.rst', '.svg', '.text',
  '.toml', '.tsv', '.txt', '.xml', '.yaml', '.yml',
]);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
const TEXT_MIME_TYPES = new Set([
  'application/json', 'application/ld+json', 'application/toml', 'application/xhtml+xml',
  'application/xml', 'application/x-yaml', 'application/yaml', 'image/svg+xml',
]);
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
const DEFAULT_TEXT_MIME_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.json': 'application/json',
  '.markdown': 'text/markdown',
  '.md': 'text/markdown',
  '.mdx': 'text/mdx',
  '.svg': 'image/svg+xml',
  '.toml': 'application/toml',
  '.tsv': 'text/tab-separated-values',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

export type DirectMcpIngestValidationCode =
  | 'content_too_large'
  | 'invalid_utf8'
  | 'invalid_text'
  | 'invalid_mime_type'
  | 'mime_type_mismatch'
  | 'invalid_frontmatter'
  | 'markdown_parse_failed'
  | 'unsafe_slash_run';

export class DirectMcpIngestValidationError extends Error {
  constructor(readonly code: DirectMcpIngestValidationCode, message: string) {
    super(message);
    this.name = 'DirectMcpIngestValidationError';
  }
}

export type DirectMcpIngestContentValidation = {
  mimeType: string;
  markdown: null | {
    mode: 'rich' | 'normalizable' | 'source';
    reason?: string;
  };
  warnings: Array<{ code: string; message: string }>;
};

export function isDirectMcpTextPath(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}

/** Encode generated text without silently replacing malformed UTF-16. */
export function encodeDirectMcpTextContent(content: string): Buffer {
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.toString('utf8') !== content) {
    throw new DirectMcpIngestValidationError('invalid_utf8', 'Text must contain valid Unicode; unpaired surrogate characters cannot be saved.');
  }
  decodeText(buffer);
  return buffer;
}

function decodeText(content: Buffer): string {
  if (content.byteLength > DIRECT_MCP_INGEST_MAX_TEXT_BYTES) {
    throw new DirectMcpIngestValidationError('content_too_large', 'Text files may contain at most 512 KiB of UTF-8 content.');
  }
  let text: string;
  try {
    // ignoreBOM keeps the BOM in the returned text instead of discarding it.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    throw new DirectMcpIngestValidationError('invalid_utf8', 'Text files must be valid UTF-8. Convert the original file to UTF-8 before importing it.');
  }
  if (text.includes('\u0000')) {
    throw new DirectMcpIngestValidationError('invalid_text', 'Text files cannot contain NUL characters.');
  }
  return text;
}

function normalizedMimeType(value: string | undefined): string | null {
  if (value === undefined || !value.trim()) return null;
  if (value.length > 200 || /[\r\n]/u.test(value)) {
    throw new DirectMcpIngestValidationError('invalid_mime_type', 'mime_type must be a valid MIME type.');
  }
  const normalized = value.split(';', 1)[0].trim().toLowerCase();
  if (!MIME_TYPE_PATTERN.test(normalized)) {
    throw new DirectMcpIngestValidationError('invalid_mime_type', 'mime_type must be a valid MIME type.');
  }
  return normalized;
}

function isTextMimeType(mimeType: string | null): boolean {
  return mimeType !== null && (mimeType.startsWith('text/') || TEXT_MIME_TYPES.has(mimeType)
    || mimeType.endsWith('+json') || mimeType.endsWith('+xml'));
}

function markdownValidation(
  filePath: string,
  text: string,
  source: 'generated' | 'uploaded',
): Pick<DirectMcpIngestContentValidation, 'markdown' | 'warnings'> {
  const warnings: DirectMcpIngestContentValidation['warnings'] = [];
  let frontmatterError: string | null;
  try {
    frontmatterError = parseCanvasMarkdownDocument(text).error;
  } catch {
    frontmatterError = 'Markdown frontmatter could not be parsed safely.';
  }
  if (frontmatterError) {
    if (source === 'generated') {
      throw new DirectMcpIngestValidationError('invalid_frontmatter', frontmatterError);
    }
    warnings.push({ code: 'invalid_frontmatter', message: frontmatterError });
  }

  let analysis: ReturnType<typeof analyzeMarkdownRichMode>;
  try {
    analysis = frontmatterError
      ? { mode: 'source', reason: 'invalid_frontmatter' }
      : analyzeMarkdownRichMode(text);
  } catch {
    analysis = { mode: 'source', reason: 'parse_failed' };
  }
  if (analysis.mode === 'source') {
    if (source === 'generated' && analysis.reason === 'parse_failed') {
      throw new DirectMcpIngestValidationError('markdown_parse_failed', 'Markdown could not be parsed by the Canvas editor.');
    }
    if (source === 'generated' && analysis.reason === 'unsafe_slash_run') {
      throw new DirectMcpIngestValidationError('unsafe_slash_run', 'Markdown contains a runaway slash or backslash sequence. Correct the generated text before saving it.');
    }
    if (analysis.reason !== 'invalid_frontmatter') {
      warnings.push({
        code: analysis.reason,
        message: `The original Markdown is preserved and requires source mode (${analysis.reason}).`,
      });
    }
  } else if (analysis.mode === 'normalizable') {
    warnings.push({
      code: 'rich_normalization_available',
      message: `The original Markdown is preserved. The editor can apply safe formatting normalization for rich mode: ${analysis.normalizations.join(', ')}.`,
    });
  }

  // Existing table lint scans raw lines. Exclude code examples and comments
  // before linting; these checks inform callers without rewriting their file.
  const lint = validateTextFileContent(filePath, createObsidianSyntaxMask(text));
  for (const check of lint.checks) {
    if (!check.ok) warnings.push({ code: check.name, message: check.message });
  }

  return {
    markdown: analysis.mode === 'source'
      ? { mode: 'source', reason: analysis.reason }
      : { mode: analysis.mode },
    warnings,
  };
}

/** Check imported bytes without normalizing or mutating the caller's buffer. */
export async function validateDirectMcpIngestContent(input: {
  path: string;
  content: Buffer;
  source: 'generated' | 'uploaded';
  mimeType?: string;
}): Promise<DirectMcpIngestContentValidation> {
  const extension = path.posix.extname(input.path).toLowerCase();
  const declaredMimeType = normalizedMimeType(input.mimeType);
  const textPath = isDirectMcpTextPath(input.path);
  if (!textPath && input.content.byteLength > DIRECT_MCP_INGEST_MAX_BINARY_BYTES) {
    throw new DirectMcpIngestValidationError('content_too_large', 'Binary files may contain at most 25 MiB.');
  }
  const detected = textPath ? undefined : await fileTypeFromBuffer(input.content).catch(() => undefined);
  if (detected && declaredMimeType && declaredMimeType !== 'application/octet-stream'
    && detected.mime !== declaredMimeType) {
    throw new DirectMcpIngestValidationError('mime_type_mismatch', `The uploaded bytes are ${detected.mime}, not the declared ${declaredMimeType}.`);
  }
  const textContent = textPath || isTextMimeType(declaredMimeType);
  if (textContent) {
    if (textPath && declaredMimeType !== null && declaredMimeType !== 'application/octet-stream'
      && !isTextMimeType(declaredMimeType)) {
      throw new DirectMcpIngestValidationError('mime_type_mismatch', 'The declared MIME type is binary but the destination is a text file.');
    }
    const text = decodeText(input.content);
    const mimeType = declaredMimeType && declaredMimeType !== 'application/octet-stream'
      ? declaredMimeType
      : DEFAULT_TEXT_MIME_TYPES[extension] ?? 'text/plain';
    if (MARKDOWN_EXTENSIONS.has(extension)) {
      return { mimeType, ...markdownValidation(input.path, text, input.source) };
    }
    return { mimeType, markdown: null, warnings: [] };
  }

  return {
    mimeType: detected?.mime ?? declaredMimeType ?? 'application/octet-stream',
    markdown: null,
    warnings: [],
  };
}

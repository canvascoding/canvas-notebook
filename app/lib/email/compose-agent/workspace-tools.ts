import 'server-only';

import { promises as fs } from 'fs';
import path from 'path';
import { type AgentTool } from '@earendil-works/pi-agent-core';
import { PDFParse } from 'pdf-parse';
import { Type } from 'typebox';

import { getCachedFileReferenceEntries } from '@/app/lib/filesystem/file-reference-cache';
import { searchFileReferenceEntries, type FileReferenceEntry } from '@/app/lib/filesystem/file-reference-search';
import { getFileStats, readFile, resolveExistingWorkspacePath } from '@/app/lib/filesystem/workspace-files';

const ALLOWED_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'pdf']);
const MAX_SEARCH_RESULTS = 12;
const DEFAULT_READ_CHARS = 16_000;
const MAX_READ_CHARS = 24_000;
const MAX_PDF_BYTES = 40 * 1024 * 1024;
const MAX_PDF_PAGES = 30;
const BINARY_SAMPLE_BYTES = 8192;

function fileExtension(filePath: string): string {
  return path.extname(filePath).replace(/^\./, '').toLowerCase();
}

function isAllowedEntry(entry: FileReferenceEntry): boolean {
  return entry.type === 'file' && ALLOWED_EXTENSIONS.has((entry.extension || fileExtension(entry.path)).toLowerCase());
}

function clampLimit(value: unknown, defaultValue: number, maxValue: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : defaultValue;
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(Math.trunc(parsed), maxValue);
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n[...content truncated after ${maxChars} characters]`,
    truncated: true,
  };
}

function bufferLooksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, BINARY_SAMPLE_BYTES));
  if (sample.length === 0) return false;

  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    const isAllowedControl = byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if (byte < 32 && !isAllowedControl) controlBytes += 1;
  }

  return controlBytes / sample.length > 0.1;
}

async function readPdfText(filePath: string, buffer: Buffer, maxChars: number, signal?: AbortSignal) {
  if (buffer.length > MAX_PDF_BYTES) {
    throw new Error(`PDF is too large for email compose context (${buffer.length} bytes).`);
  }

  const parser = new PDFParse({ data: buffer });
  try {
    if (signal?.aborted) throw new Error('Aborted');
    const info = await parser.getInfo();
    const pagesToRead = Math.min(info.total, MAX_PDF_PAGES);
    const result = await parser.getText({
      first: pagesToRead,
      pageJoiner: '\n-- Page page_number of total_number --\n',
    });
    const text = result.text.trim();
    if (!text) {
      throw new Error('PDF has no extractable text. Scanned/image-only PDFs are not supported for email context.');
    }
    const truncated = truncateText(text, maxChars);
    const note = info.total > pagesToRead
      ? `\n\n[PDF text extraction limited to first ${pagesToRead} of ${info.total} pages]`
      : '';
    return {
      content: `${truncated.text}${note}`,
      details: {
        path: filePath,
        type: 'pdf',
        pages: info.total,
        pagesRead: pagesToRead,
        textLength: text.length,
        truncated: truncated.truncated || info.total > pagesToRead,
      },
    };
  } finally {
    await parser.destroy();
  }
}

async function readWorkspaceContextFile(filePath: string, maxChars: number, signal?: AbortSignal) {
  const extension = fileExtension(filePath);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported file type for email compose context: .${extension || 'unknown'}`);
  }

  const stats = await getFileStats(filePath);
  if (!stats.isFile) {
    throw new Error(`Not a file: ${filePath}`);
  }

  const buffer = await readFile(filePath);
  if (extension === 'pdf' || buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    return readPdfText(filePath, buffer, maxChars, signal);
  }

  if (bufferLooksBinary(buffer)) {
    throw new Error('Unsupported binary file for email compose context.');
  }

  const text = buffer.toString('utf8');
  const truncated = truncateText(text, maxChars);
  return {
    content: truncated.text,
    details: {
      path: filePath,
      type: 'text',
      size: buffer.length,
      textLength: text.length,
      truncated: truncated.truncated,
    },
  };
}

function formatSearchResults(files: FileReferenceEntry[]): string {
  if (files.length === 0) return 'No matching workspace files found.';
  return files.map((file, index) => `${index + 1}. ${file.path}`).join('\n');
}

export function createEmailWorkspaceTools(): AgentTool[] {
  return [
    {
      name: 'email_workspace_search',
      label: 'Searching workspace',
      description: 'Searches the Canvas workspace for readable context files. Only text, Markdown, CSV, JSON, and text PDFs are returned.',
      parameters: Type.Object({
        query: Type.String({ description: 'Search query for filenames or paths.' }),
        limit: Type.Optional(Type.Number({ description: `Maximum results, up to ${MAX_SEARCH_RESULTS}.` })),
      }),
      executionMode: 'sequential',
      execute: async (_toolCallId, params) => {
        const input = params as { query?: string; limit?: number };
        const query = String(input.query || '').trim();
        const limit = clampLimit(input.limit, 8, MAX_SEARCH_RESULTS);
        const entries = (await getCachedFileReferenceEntries())
          .filter(isAllowedEntry);
        const files = searchFileReferenceEntries(entries, query).slice(0, limit);
        return {
          content: [{ type: 'text', text: formatSearchResults(files) }],
          details: { query, files },
        };
      },
    },
    {
      name: 'email_workspace_read',
      label: 'Reading workspace file',
      description: 'Reads one workspace file for email drafting context. Supports text, Markdown, CSV, JSON, and text PDFs only.',
      parameters: Type.Object({
        path: Type.String({ description: 'Workspace-relative file path.' }),
        maxChars: Type.Optional(Type.Number({ description: `Maximum characters to return, up to ${MAX_READ_CHARS}.` })),
      }),
      executionMode: 'sequential',
      execute: async (_toolCallId, params, signal) => {
        const input = params as { path?: string; maxChars?: number };
        const requestedPath = String(input.path || '').trim();
        if (!requestedPath) throw new Error('path is required.');
        await fs.access(await resolveExistingWorkspacePath(requestedPath));
        const maxChars = clampLimit(input.maxChars, DEFAULT_READ_CHARS, MAX_READ_CHARS);
        const result = await readWorkspaceContextFile(requestedPath, maxChars, signal);
        return {
          content: [{ type: 'text', text: result.content }],
          details: result.details,
        };
      },
    },
  ];
}

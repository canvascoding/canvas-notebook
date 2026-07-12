import 'server-only';

import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { promises as fs } from 'fs';
import path from 'path';
import { type AgentTool } from '@earendil-works/pi-agent-core';
import { PDFParse } from 'pdf-parse';
import { Type } from 'typebox';

import { reauthorizeEmailAiWorkspace } from '@/app/lib/email/ai-runtime';
import { getCachedFileReferenceEntries } from '@/app/lib/filesystem/file-reference-cache';
import { searchFileReferenceEntries, type FileReferenceEntry } from '@/app/lib/filesystem/file-reference-search';
import { resolveExistingWorkspacePath } from '@/app/lib/filesystem/workspace-files';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const ALLOWED_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'pdf']);
const MAX_SEARCH_RESULTS = 12;
const DEFAULT_READ_CHARS = 16_000;
const MAX_READ_CHARS = 24_000;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 40 * 1024 * 1024;
const MAX_PDF_PAGES = 30;
const BINARY_SAMPLE_BYTES = 8192;
const MAX_TOOL_QUERY_CHARS = 500;
const MAX_TOOL_PATH_CHARS = 1_024;
const MAX_LSOF_OUTPUT_BYTES = 16 * 1024;
const LSOF_TIMEOUT_MS = 2_000;

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

function assertReadActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function resolveDarwinOpenFilePath(fileDescriptor: number): Promise<string> {
  const output = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      '/usr/sbin/lsof',
      ['-a', '-p', String(process.pid), '-d', String(fileDescriptor), '-Fn0'],
      { encoding: 'buffer', maxBuffer: MAX_LSOF_OUTPUT_BYTES, timeout: LSOF_TIMEOUT_MS },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
  const nameField = output
    .toString('utf8')
    .split('\0')
    .map((field) => field.replace(/^\n/u, ''))
    .find((field) => field.startsWith('n/'));
  if (!nameField) throw new Error('Unable to verify the opened workspace file descriptor.');
  return nameField.slice(1);
}

async function resolveOpenFileDescriptorPath(fileDescriptor: number): Promise<string> {
  if (process.platform === 'linux') {
    return fs.realpath(`/proc/self/fd/${fileDescriptor}`);
  }
  if (process.platform === 'darwin') {
    return resolveDarwinOpenFilePath(fileDescriptor);
  }
  throw new Error('Secure workspace file reads are not supported on this server platform.');
}

async function openVerifiedWorkspaceFile(
  filePath: string,
  workspace: WorkspaceContext,
): Promise<Awaited<ReturnType<typeof fs.open>>> {
  const workspaceRoot = await fs.realpath(workspace.rootPath);
  const resolvedPath = await resolveExistingWorkspacePath(filePath, { workspace });
  const handle = await fs.open(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);

  try {
    // Verify the path represented by the opened descriptor itself. Checking
    // only before open leaves a race where a writable parent becomes a
    // symlink between realpath() and open().
    const openedPath = await resolveOpenFileDescriptorPath(handle.fd);
    if (!isPathInsideRoot(workspaceRoot, openedPath)) {
      throw new Error('Workspace file changed outside the authorized workspace while it was being opened.');
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readBoundedFile(
  handle: Awaited<ReturnType<typeof fs.open>>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let position = 0;

  while (totalBytes <= maxBytes) {
    assertReadActive(signal);
    const readLength = Math.min(64 * 1024, maxBytes + 1 - totalBytes);
    const chunk = Buffer.allocUnsafe(readLength);
    const { bytesRead } = await handle.read(chunk, 0, readLength, position);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
    position += bytesRead;
  }

  assertReadActive(signal);
  if (totalBytes > maxBytes) {
    throw new Error(`Workspace file grew beyond the ${maxBytes}-byte email compose limit while it was being read.`);
  }
  return Buffer.concat(chunks, totalBytes);
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

async function readWorkspaceContextFile(
  filePath: string,
  maxChars: number,
  workspace: WorkspaceContext,
  signal?: AbortSignal,
) {
  const extension = fileExtension(filePath);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported file type for email compose context: .${extension || 'unknown'}`);
  }

  const maxBytes = extension === 'pdf' ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
  const handle = await openVerifiedWorkspaceFile(filePath, workspace);
  let buffer: Buffer;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }
    if (stats.size > maxBytes) {
      throw new Error(`Workspace file is too large for email compose context (${stats.size} bytes, max ${maxBytes}).`);
    }
    buffer = await readBoundedFile(handle, maxBytes, signal);
  } finally {
    await handle.close();
  }
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

export function createEmailWorkspaceTools(input: {
  userId: string;
  workspace: WorkspaceContext;
}): AgentTool[] {
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
        const workspace = await reauthorizeEmailAiWorkspace(input);
        const args = params as { query?: string; limit?: number };
        const query = String(args.query || '').trim();
        if (query.length > MAX_TOOL_QUERY_CHARS) {
          throw new Error(`Workspace search query exceeds ${MAX_TOOL_QUERY_CHARS} characters.`);
        }
        const limit = clampLimit(args.limit, 8, MAX_SEARCH_RESULTS);
        const entries = (await getCachedFileReferenceEntries(false, { workspace }))
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
        const workspace = await reauthorizeEmailAiWorkspace(input);
        const args = params as { path?: string; maxChars?: number };
        const requestedPath = String(args.path || '').trim();
        if (!requestedPath) throw new Error('path is required.');
        if (requestedPath.length > MAX_TOOL_PATH_CHARS) {
          throw new Error(`Workspace path exceeds ${MAX_TOOL_PATH_CHARS} characters.`);
        }
        const maxChars = clampLimit(args.maxChars, DEFAULT_READ_CHARS, MAX_READ_CHARS);
        const result = await readWorkspaceContextFile(requestedPath, maxChars, workspace, signal);
        return {
          content: [{ type: 'text', text: result.content }],
          details: result.details,
        };
      },
    },
  ];
}

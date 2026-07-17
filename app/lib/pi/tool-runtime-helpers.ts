import { exec } from 'child_process';
import { promises as fsPromises } from 'fs';
import { PDFParse } from 'pdf-parse';
import { type AgentTool } from '@earendil-works/pi-agent-core';
import { type ImageContent } from '@earendil-works/pi-ai';
import { promisify } from 'util';
import path from 'path';
import {
  applyAgentFilePatch,
  assertAgentPathAllowed,
  copyAgentPaths,
  deleteAgentPaths,
  detectUnsafeBashCommand,
  editAgentFile,
  editAgentExcalidrawScene,
  getAgentWorkspaceContext,
  getAgentWorkspaceRoot,
  listAgentFileSnapshots,
  moveAgentPaths,
  readAgentCollaborativeTextFile,
  readAgentCollaborativeExcalidrawFile,
  resolveAgentPath,
  restoreAgentFileSnapshot,
  sha256Buffer,
  writeAgentTextFile,
  type AgentFileChangeResult,
  type AgentFileValidationResult,
  type AgentPathOperationResult,
} from '@/app/lib/pi/agent-file-operations';
import { compactImageBufferForLlm } from '@/app/lib/pi/message-normalization';
import {
  getStudioAssetsRoot,
  getStudioEditsRoot,
  getStudioOutputsRoot,
  getStudioRoot,
  resolveStudioFilePath,
  STUDIO_ASSETS_ROOT_DIR,
  STUDIO_EDITS_ROOT_DIR,
  STUDIO_OUTPUTS_ROOT_DIR,
} from '@/app/lib/integrations/studio-workspace';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import { getAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { runWithAgentExecutionContext, type AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { createBrowserGatewayTool } from '@/app/lib/pi/browser/tool';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { hashAuditValue, recordAuditEvent, type AuditStatus } from '@/app/lib/audit/audit-service';

export const execAsync = promisify(exec);

export class BlockedBashCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedBashCommandError';
  }
}

export function assertBashCommandAllowed(command: string): void {
  const blockedReason = detectUnsafeBashCommand(command);
  if (blockedReason) {
    throw new BlockedBashCommandError(blockedReason);
  }
}

export function wrapToolWithExecutionContext(tool: AgentTool, context: AgentExecutionContext): AgentTool {
  const scopedTool = tool.name === 'browser'
    ? createBrowserGatewayTool({
        userId: context.userId,
        agentId: normalizeManagedAgentId(context.agentId),
        sessionId: context.sessionId,
        workspaceId: context.workspaceId,
        workspaceType: context.workspaceType,
        organizationId: context.organizationId,
      })
    : tool;
  const execute = scopedTool.execute;
  return {
    ...scopedTool,
    execute: (toolCallId, params, signal) => runWithAgentExecutionContext(
      context,
      () => execute(toolCallId, params, signal),
    ),
  };
}

export async function recordBashToolAudit(input: {
  command: string;
  status: AuditStatus;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  exitCode?: string | number | null;
}) {
  const executionContext = getAgentExecutionContext();
  if (!executionContext) return;

  const commandHash = hashAuditValue({ command: input.command });
  await recordAuditEvent({
    organizationId: executionContext.organizationId,
    customerId: executionContext.customerId,
    projectId: executionContext.projectId,
    workspaceId: executionContext.workspaceId,
    userId: executionContext.userId,
    sessionId: executionContext.sessionId,
    agentId: executionContext.agentId,
    source: 'agent_tool',
    eventType: 'command',
    entityType: 'workspace_shell',
    entityId: executionContext.workspaceId,
    action: 'agent_bash.execute',
    status: input.status,
    summary: `Agent bash command ${input.status}.`,
    metadata: {
      commandHash,
      commandLength: input.command.length,
      durationMs: input.durationMs,
      exitCode: input.exitCode ?? null,
      stdoutBytes: Buffer.byteLength(input.stdout ?? '', 'utf8'),
      stderrBytes: Buffer.byteLength(input.stderr ?? '', 'utf8'),
      error: input.error ? input.error.slice(0, 500) : null,
      workspace: {
        workspaceId: executionContext.workspaceId,
        workspaceType: executionContext.workspaceType,
        workspaceName: executionContext.workspaceName,
        workspaceRootRelativePath: executionContext.workspaceRootRelativePath,
      },
    },
    inputHash: commandHash,
    outputHash: hashAuditValue({
      stdout: input.stdout ?? '',
      stderr: input.stderr ?? '',
      error: input.error ?? '',
    }),
  });
}

export const DEFAULT_READ_TEXT_LIMIT = 40_000;
export const MAX_READ_TEXT_LIMIT = 120_000;
export const BINARY_SAMPLE_BYTES = 8192;
export const DEFAULT_PDF_TEXT_PAGE_LIMIT = 80;
export const MAX_PDF_TEXT_PAGE_LIMIT = 200;
export const DEFAULT_PDF_IMAGE_LIMIT = 2;
export const MAX_PDF_IMAGE_LIMIT = 5;
export const PDF_AUTO_IMAGE_MAX_PAGES = 20;
export const PDF_AUTO_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const PDF_IMAGE_RENDER_WIDTH = 900;
export const PDF_IMAGE_MAX_BYTES = 750_000;
export const PDF_IMAGE_TOTAL_MAX_BYTES = 1_500_000;
export const PDF_MAX_IN_MEMORY_BYTES = 100 * 1024 * 1024;


export const IMAGE_EXTENSIONS: Record<string, string> = {
  '.gif':  'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg':  'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
};

export const AUDIO_EXTENSIONS: Record<string, string> = {
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

export async function imageContentForBuffer(filePath: string, buffer: Buffer): Promise<ImageContent | null> {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_EXTENSIONS[ext];
  if (!mimeType) return null;
  try {
    return await compactImageBufferForLlm(buffer, path.basename(filePath), mimeType);
  } catch (error) {
    console.warn('[Read Tool] Failed to compact image for LLM transfer:', error instanceof Error ? error.message : error);
    throw error;
  }
}

export type ResolvedReadToolPath = {
  fullPath: string;
  displayPath: string;
  source: 'absolute' | 'workspace' | 'studio';
};

export function isPathWithin(candidatePath: string, basePath: string): boolean {
  const normalizedCandidate = path.resolve(candidatePath);
  const normalizedBase = path.resolve(basePath);
  return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(`${normalizedBase}${path.sep}`);
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

export function stripQueryAndHash(value: string): string {
  return value.split(/[?#]/, 1)[0];
}

export function safeDecodePath(value: string): string {
  return value
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

export function normalizeReadReferencePath(filePath: string): string {
  const trimmed = filePath.trim();
  let reference = trimmed;

  try {
    const parsed = new URL(trimmed, 'http://canvas.local');
    const pathname = safeDecodePath(parsed.pathname);
    if (pathname.startsWith('/api/studio/media/')) {
      reference = pathname.slice('/api/studio/media/'.length);
    } else if (pathname.startsWith('/api/media/')) {
      reference = pathname.slice('/api/media/'.length);
    } else if (pathname.startsWith('/media/')) {
      reference = pathname.slice('/media/'.length);
    } else if (pathname === '/api/files/preview') {
      reference = parsed.searchParams.get('path') || trimmed;
    } else if (parsed.origin !== 'http://canvas.local') {
      reference = trimmed;
    } else {
      reference = pathname;
    }
  } catch {
    reference = trimmed;
  }

  return safeDecodePath(stripQueryAndHash(toPosixPath(reference))).replace(/^\/+/, '');
}

export function pathExists(candidatePath: string): Promise<boolean> {
  return fsPromises.access(candidatePath)
    .then(() => true)
    .catch((error: unknown) => {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        return false;
      }
      throw error;
    });
}

export function getRelativePathIfWithin(candidatePath: string, basePath: string): string | null {
  const relativePath = path.relative(basePath, candidatePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  return toPosixPath(relativePath);
}

export function getStudioDisplayPathForAbsolute(filePath: string): string | null {
  const studioRelativePath = getRelativePathIfWithin(filePath, getStudioRoot());
  return studioRelativePath ? path.posix.join('studio', studioRelativePath) : null;
}

export function getWorkspaceDisplayPathForAbsolute(filePath: string): string | null {
  return getRelativePathIfWithin(filePath, getAgentWorkspaceRoot());
}

export function buildStudioRootReadCandidate(rootPath: string, displayRoot: string, relativePath: string): ResolvedReadToolPath | null {
  const fullPath = path.resolve(rootPath, relativePath);
  if (!isPathWithin(fullPath, rootPath)) {
    return null;
  }

  return {
    fullPath,
    displayPath: path.posix.join(displayRoot, toPosixPath(relativePath)),
    source: 'studio',
  };
}

export function buildStudioReadCandidate(referencePath: string): ResolvedReadToolPath | null {
  const normalized = normalizeReadReferencePath(referencePath);
  const withoutDataPrefix = normalized.startsWith('data/studio/')
    ? normalized.slice('data/'.length)
    : normalized;

  if (withoutDataPrefix.startsWith('studio/')) {
    const fullPath = resolveStudioFilePath(withoutDataPrefix);
    if (!fullPath) return null;
    return {
      fullPath,
      displayPath: withoutDataPrefix,
      source: 'studio',
    };
  }

  if (withoutDataPrefix.startsWith(`${STUDIO_OUTPUTS_ROOT_DIR}/`)) {
    const relativePath = withoutDataPrefix.slice(`${STUDIO_OUTPUTS_ROOT_DIR}/`.length);
    return buildStudioRootReadCandidate(getStudioOutputsRoot(), STUDIO_OUTPUTS_ROOT_DIR, relativePath);
  }

  if (withoutDataPrefix.startsWith(`${STUDIO_EDITS_ROOT_DIR}/`)) {
    const relativePath = withoutDataPrefix.slice(`${STUDIO_EDITS_ROOT_DIR}/`.length);
    return buildStudioRootReadCandidate(getStudioEditsRoot(), STUDIO_EDITS_ROOT_DIR, relativePath);
  }

  if (withoutDataPrefix.startsWith(`${STUDIO_ASSETS_ROOT_DIR}/`)) {
    const relativePath = withoutDataPrefix.slice(`${STUDIO_ASSETS_ROOT_DIR}/`.length);
    return buildStudioRootReadCandidate(getStudioAssetsRoot(), STUDIO_ASSETS_ROOT_DIR, relativePath);
  }

  if (/^studio-gen-[^/]+\.(?:gif|jpe?g|png|webp|svg)$/i.test(withoutDataPrefix)) {
    return buildStudioRootReadCandidate(getStudioOutputsRoot(), STUDIO_OUTPUTS_ROOT_DIR, withoutDataPrefix);
  }

  if (/^(?:products|personas|styles|presets|references)\//.test(withoutDataPrefix)) {
    return buildStudioRootReadCandidate(getStudioAssetsRoot(), STUDIO_ASSETS_ROOT_DIR, withoutDataPrefix);
  }

  return null;
}

export async function resolveReadToolPath(filePath: string): Promise<ResolvedReadToolPath> {
  if (path.isAbsolute(filePath)) {
    const absolutePath = path.resolve(filePath);
    return {
      fullPath: absolutePath,
      displayPath: getStudioDisplayPathForAbsolute(absolutePath) || getWorkspaceDisplayPathForAbsolute(absolutePath) || filePath,
      source: 'absolute',
    };
  }

  const workspacePath = resolveAgentPath(filePath);
  const candidates: ResolvedReadToolPath[] = [
    {
      fullPath: workspacePath,
      displayPath: filePath,
      source: 'workspace',
    },
  ];

  const studioCandidate = buildStudioReadCandidate(filePath);
  if (studioCandidate && !candidates.some((candidate) => path.resolve(candidate.fullPath) === path.resolve(studioCandidate.fullPath))) {
    candidates.push(studioCandidate);
  }

  for (const candidate of candidates) {
    if (await pathExists(candidate.fullPath)) {
      return candidate;
    }
  }

  return candidates[0];
}

export function formatImageReadText(params: {
  requestedPath: string;
  displayPath: string;
  mimeType: string;
  size: number;
}): string {
  return [
    `Image loaded for visual analysis: ${params.displayPath}`,
    params.displayPath !== params.requestedPath ? `Requested path: ${params.requestedPath}` : null,
    `MIME type: ${params.mimeType}`,
    `Size: ${params.size} bytes`,
    'The image is attached to this tool result as an image content block for vision-capable models.',
  ].filter(Boolean).join('\n');
}

export function getReadImagePreviewDetails(displayPath: string): { previewUrl?: string; mediaUrl?: string } {
  if (path.isAbsolute(displayPath)) {
    return {};
  }

  const normalizedDisplayPath = toPosixPath(displayPath).replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (!normalizedDisplayPath) {
    return {};
  }

  return {
    previewUrl: toPreviewUrl(normalizedDisplayPath, 192, { preset: 'mini' }),
    mediaUrl: toMediaUrl(normalizedDisplayPath),
  };
}

export function audioMimeTypeForPath(filePath: string): string {
  return AUDIO_EXTENSIONS[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export function clampReadTextLimit(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : DEFAULT_READ_TEXT_LIMIT;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_READ_TEXT_LIMIT;
  return Math.min(Math.trunc(parsed), MAX_READ_TEXT_LIMIT);
}

export function clampPositiveInteger(value: unknown, defaultValue: number, maxValue: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : defaultValue;
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(Math.trunc(parsed), maxValue);
}

export function truncateReadText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n[...content truncated after ${maxChars} characters]`,
    truncated: true,
  };
}

export function isPdfBuffer(filePath: string, buffer: Buffer): boolean {
  return path.extname(filePath).toLowerCase() === '.pdf'
    || buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

export function isPdfPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.pdf';
}

export function bufferLooksBinary(buffer: Buffer): boolean {
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

export function normalizePdfPageNumbers(value: unknown, totalPages: number, maxPages: number): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const pages: number[] = [];

  for (const raw of value) {
    const page = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(page)) continue;
    const normalized = Math.trunc(page);
    if (normalized < 1 || normalized > totalPages || seen.has(normalized)) continue;
    seen.add(normalized);
    pages.push(normalized);
    if (pages.length >= maxPages) break;
  }

  return pages.sort((a, b) => a - b);
}

export function firstPdfPages(totalPages: number, count: number): number[] {
  return Array.from({ length: Math.min(totalPages, count) }, (_, index) => index + 1);
}

export type PdfReadOptions = {
  maxChars: number;
  maxTextPages: number;
  textPages?: unknown;
  includeImages?: boolean;
  includeImagesExplicit: boolean;
  imagePages?: unknown;
  maxImages: number;
};

export async function renderPdfPageImagesForRead(
  parser: PDFParse,
  pageNumbers: number[],
): Promise<{ images: ImageContent[]; details: Array<{ pageNumber: number; bytes: number; width: number; height: number }>; skipped: string[] }> {
  if (pageNumbers.length === 0) {
    return { images: [], details: [], skipped: [] };
  }

  const screenshots = await parser.getScreenshot({
    partial: pageNumbers,
    desiredWidth: PDF_IMAGE_RENDER_WIDTH,
    imageBuffer: true,
    imageDataUrl: false,
  });

  const images: ImageContent[] = [];
  const details: Array<{ pageNumber: number; bytes: number; width: number; height: number }> = [];
  const skipped: string[] = [];
  let totalBytes = 0;

  for (const page of screenshots.pages) {
    const bytes = Buffer.from(page.data);
    if (bytes.length > PDF_IMAGE_MAX_BYTES) {
      skipped.push(`page ${page.pageNumber}: rendered image exceeded ${PDF_IMAGE_MAX_BYTES} bytes`);
      continue;
    }
    if (totalBytes + bytes.length > PDF_IMAGE_TOTAL_MAX_BYTES) {
      skipped.push(`page ${page.pageNumber}: skipped to keep PDF image result under ${PDF_IMAGE_TOTAL_MAX_BYTES} bytes`);
      continue;
    }

    totalBytes += bytes.length;
    images.push({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' });
    details.push({
      pageNumber: page.pageNumber,
      bytes: bytes.length,
      width: Math.round(page.width),
      height: Math.round(page.height),
    });
  }

  return { images, details, skipped };
}

export async function extractPdfTextForRead(filePath: string, buffer: Buffer, options: PdfReadOptions, signal?: AbortSignal) {
  const parser = new PDFParse({ data: buffer });
  try {
    throwIfAborted(signal);
    const info = await parser.getInfo();
    const totalPages = info.total;
    const explicitTextPages = normalizePdfPageNumbers(options.textPages, totalPages, MAX_PDF_TEXT_PAGE_LIMIT);
    const textPageNumbers = explicitTextPages.length > 0
      ? explicitTextPages
      : firstPdfPages(totalPages, Math.min(totalPages, options.maxTextPages));
    const textPageLimited = explicitTextPages.length === 0 && totalPages > textPageNumbers.length;

    throwIfAborted(signal);
    const result = await parser.getText({
      ...(explicitTextPages.length > 0 ? { partial: textPageNumbers } : { first: textPageNumbers.length }),
      pageJoiner: '\n-- Page page_number of total_number --',
    });
    const hasExtractedText = result.pages.some((page) => page.text.trim().length > 0);
    const notes: string[] = [];
    if (textPageLimited) {
      notes.push(`PDF text extraction was limited to the first ${textPageNumbers.length} of ${totalPages} pages. Call read with pdfTextPages or a larger maxPdfTextPages to inspect later pages.`);
    }

    const shouldAutoIncludeImages = !options.includeImagesExplicit
      && totalPages <= PDF_AUTO_IMAGE_MAX_PAGES
      && buffer.length <= PDF_AUTO_IMAGE_MAX_BYTES;
    const shouldIncludeImages = options.includeImages === true || shouldAutoIncludeImages;
    const imagePageNumbers = shouldIncludeImages
      ? (
          normalizePdfPageNumbers(options.imagePages, totalPages, options.maxImages).length > 0
            ? normalizePdfPageNumbers(options.imagePages, totalPages, options.maxImages)
            : firstPdfPages(totalPages, options.maxImages)
        )
      : [];

    let imageContent: ImageContent[] = [];
    let imageDetails: Array<{ pageNumber: number; bytes: number; width: number; height: number }> = [];
    let skippedImages: string[] = [];
    if (shouldIncludeImages) {
      throwIfAborted(signal);
      const rendered = await renderPdfPageImagesForRead(parser, imagePageNumbers);
      imageContent = rendered.images;
      imageDetails = rendered.details;
      skippedImages = rendered.skipped;
      if (imageDetails.length > 0) {
        notes.push(`Rendered PDF page image(s) included for vision-capable models: ${imageDetails.map((image) => image.pageNumber).join(', ')}.`);
      }
      if (skippedImages.length > 0) {
        notes.push(`Some PDF page images were skipped: ${skippedImages.join('; ')}.`);
      }
    } else if (!options.includeImagesExplicit && totalPages > 0) {
      notes.push(`PDF page images were not auto-included because the PDF is large or outside the auto-render limit. Call read with includePdfImages: true and pdfImagePages to inspect selected pages visually.`);
    }

    if (!hasExtractedText) {
      const noteText = notes.length > 0 ? `\n\n${notes.join('\n')}` : '';
      return {
        content: [
          { type: 'text' as const, text: `PDF parsed, but no extractable text was found. It may be scanned or image-based.${noteText}` },
          ...imageContent,
        ],
        details: {
          filePath,
          size: buffer.length,
          type: 'pdf',
          pages: totalPages,
          textPagesRead: textPageNumbers,
          textPageLimited,
          truncated: false,
          images: imageDetails,
          skippedImages,
        },
      };
    }

    const text = result.text.trim();
    const truncated = truncateReadText(text, options.maxChars);
    const noteText = notes.length > 0 ? `\n\n${notes.join('\n')}` : '';
    return {
      content: [
        { type: 'text' as const, text: `${truncated.text}${noteText}` },
        ...imageContent,
      ],
      details: {
        filePath,
        size: buffer.length,
        type: 'pdf',
        pages: totalPages,
        textPagesRead: textPageNumbers,
        textPageLimited,
        textLength: text.length,
        truncated: truncated.truncated,
        images: imageDetails,
        skippedImages,
      },
    };
  } finally {
    await parser.destroy();
  }
}

export {
  applyAgentFilePatch,
  assertAgentPathAllowed,
  copyAgentPaths,
  deleteAgentPaths,
  editAgentFile,
  editAgentExcalidrawScene,
  getAgentWorkspaceContext,
  getAgentWorkspaceRoot,
  listAgentFileSnapshots,
  moveAgentPaths,
  readAgentCollaborativeTextFile,
  readAgentCollaborativeExcalidrawFile,
  resolveAgentPath,
  restoreAgentFileSnapshot,
  sha256Buffer,
  writeAgentTextFile,
};

export type {
  AgentFileChangeResult,
  AgentFileValidationResult,
  AgentPathOperationResult,
};

export type CommandExecutionError = Error & {
  code?: number;
  stdout?: string;
  stderr?: string;
};

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown tool error';
}

export function asCommandExecutionError(error: unknown): CommandExecutionError {
  return error instanceof Error ? (error as CommandExecutionError) : new Error(String(error));
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Tool execution aborted.');
  }
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted ||
    (error instanceof Error && (
      error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      error.message.toLowerCase().includes('aborted')
    )),
  );
}

export function clampMaxResults(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.trunc(value), max));
}

export function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

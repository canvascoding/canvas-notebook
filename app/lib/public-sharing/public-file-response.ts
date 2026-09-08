import 'server-only';

import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { NextRequest, NextResponse } from 'next/server';

import { resolveExistingWorkspacePath } from '@/app/lib/filesystem/workspace-files';
import { assertPublicShareStillActive, isPublicSharedTextPath, PUBLIC_SHARE_TEXT_SIZE_LIMIT, readPublicShareText } from './public-share-text';
import {
  createPublicFileHeaders,
  getPublicShareMimeType,
  isSensitiveWorkspacePath,
  publicShareFileIdentityMatches,
  type PublicShareResolution,
} from '@/app/lib/public-sharing/public-file-shares';
import {
  isInteractiveHtmlPublicShare,
  resolvePublicHtmlSiteAssetWorkspacePath,
  type PublicShareSecurityMode,
} from '@/app/lib/public-sharing/public-share-security';

function parseRange(rangeHeader: string | null, fileSize: number): { start: number; end: number } | null | 'invalid' {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return 'invalid';

  let start = match[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  let end = match[2] ? Number.parseInt(match[2], 10) : Number.NaN;

  if (Number.isNaN(start) && Number.isNaN(end)) return 'invalid';
  if (Number.isNaN(start)) {
    const suffixLength = end;
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'invalid';
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    end = Number.isNaN(end) ? fileSize - 1 : end;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || start >= fileSize) return 'invalid';
  return { start, end: Math.min(end, fileSize - 1) };
}

export function publicShareErrorResponse(resolved: Extract<PublicShareResolution, { ok: false }>) {
  return NextResponse.json(
    { success: false, error: resolved.error },
    {
      status: resolved.status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
}

export function publicShareNotFoundResponse() {
  return NextResponse.json(
    { success: false, error: 'Public file not found.' },
    {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
}

function isWithinDirectory(candidatePath: string, directoryPath: string): boolean {
  const normalizedCandidate = path.resolve(candidatePath);
  const normalizedDirectory = path.resolve(directoryPath);
  return normalizedCandidate === normalizedDirectory || normalizedCandidate.startsWith(`${normalizedDirectory}${path.sep}`);
}

function requestedEntryFile(resolved: Extract<PublicShareResolution, { ok: true }>, requestedPathParts?: string[]) {
  const requestedWorkspacePath = resolvePublicHtmlSiteAssetWorkspacePath(resolved.workspacePath, requestedPathParts);
  return requestedWorkspacePath === resolved.workspacePath;
}

async function resolveResponseFile(
  resolved: Extract<PublicShareResolution, { ok: true }>,
  requestedPathParts?: string[],
) {
  const interactiveHtml = isInteractiveHtmlPublicShare({
    securityMode: resolved.share.securityMode,
    mimeType: resolved.mimeType,
    workspacePath: resolved.workspacePath,
  });

  if (!interactiveHtml) {
    if (!requestedEntryFile(resolved, requestedPathParts)) return null;
    return {
      workspacePath: resolved.workspacePath,
      fileName: resolved.share.fileName,
      fullPath: resolved.fullPath,
      sizeBytes: resolved.sizeBytes,
      mimeType: resolved.mimeType,
      fileIdentity: resolved.row.fileIdentity,
      asSiteAsset: false,
    };
  }

  const workspacePath = resolvePublicHtmlSiteAssetWorkspacePath(resolved.workspacePath, requestedPathParts);
  if (!workspacePath || isSensitiveWorkspacePath(workspacePath)) return null;

  const fullPath = workspacePath === resolved.workspacePath
    ? resolved.fullPath
    : await resolveExistingWorkspacePath(workspacePath, { workspace: resolved.workspace });
  const rootDir = path.dirname(resolved.fullPath);
  const realPath = await fs.realpath(fullPath);
  if (!isWithinDirectory(realPath, rootDir)) return null;

  const stats = await fs.stat(realPath);
  if (!stats.isFile()) return null;

  return {
    workspacePath,
    fileName: path.posix.basename(workspacePath),
    fullPath: realPath,
    sizeBytes: stats.size,
    fileIdentity: `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`,
    mimeType: workspacePath === resolved.workspacePath ? resolved.mimeType : getPublicShareMimeType(workspacePath),
    asSiteAsset: workspacePath !== resolved.workspacePath,
  };
}

export type PublicShareResponseFile = {
  workspacePath: string;
  fileName: string;
  fullPath: string;
  sizeBytes: number;
  mimeType: string;
  asSiteAsset: boolean;
  fileIdentity?: string;
  handle?: FileHandle;
};

export async function openPublicShareResponseFile(file: PublicShareResponseFile): Promise<PublicShareResponseFile> {
  const handle = await fs.open(file.fullPath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || (file.fileIdentity && !publicShareFileIdentityMatches(stats, file.fileIdentity))) {
      throw new Error('Shared file was replaced.');
    }
    return { ...file, sizeBytes: stats.size, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function publicShareFileStreamResponse(
  request: NextRequest,
  responseFile: PublicShareResponseFile,
  method: 'GET' | 'HEAD',
  securityMode: PublicShareSecurityMode,
) {
  const range = parseRange(request.headers.get('range'), responseFile.sizeBytes);
  if (range === 'invalid') {
    void responseFile.handle?.close();
    return new NextResponse(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${responseFile.sizeBytes}`,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  const headers = createPublicFileHeaders({
    fileName: responseFile.fileName,
    workspacePath: responseFile.workspacePath,
    mimeType: responseFile.mimeType,
    sizeBytes: responseFile.sizeBytes,
    range: range ? { ...range, total: responseFile.sizeBytes } : undefined,
    securityMode,
    asSiteAsset: responseFile.asSiteAsset,
    forceAttachment: request.nextUrl.searchParams.get('download') === '1',
  });

  if (method === 'HEAD') {
    void responseFile.handle?.close();
    return new NextResponse(null, { status: range ? 206 : 200, headers });
  }

  const streamOptions = range ? { start: range.start, end: range.end } : undefined;
  const nodeStream = responseFile.handle
    ? responseFile.handle.createReadStream(streamOptions)
    : createReadStream(responseFile.fullPath, streamOptions);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

  return new NextResponse(webStream, { status: range ? 206 : 200, headers });
}

export async function publicShareFileResponse(
  request: NextRequest,
  resolved: PublicShareResolution,
  method: 'GET' | 'HEAD',
  options: { requestedPathParts?: string[] } = {},
) {
  if (!resolved.ok) {
    return publicShareErrorResponse(resolved);
  }

  let responseFile: PublicShareResponseFile | null;
  try {
    responseFile = await resolveResponseFile(resolved, options.requestedPathParts);
  } catch {
    return publicShareNotFoundResponse();
  }
  if (!responseFile) {
    return publicShareNotFoundResponse();
  }

  try {
    if (!responseFile.asSiteAsset && resolved.sizeBytes <= PUBLIC_SHARE_TEXT_SIZE_LIMIT && isPublicSharedTextPath(resolved.workspacePath)) {
      const content = Buffer.from(await readPublicShareText(resolved));
      const range = parseRange(request.headers.get('range'), content.length);
      if (range === 'invalid') return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${content.length}`, 'Cache-Control': 'no-store' } });
      const headers = createPublicFileHeaders({
        ...responseFile, sizeBytes: content.length, securityMode: resolved.share.securityMode,
        range: range ? { ...range, total: content.length } : undefined,
        forceAttachment: request.nextUrl.searchParams.get('download') === '1',
      });
      return new NextResponse(method === 'HEAD' ? null : range ? content.subarray(range.start, range.end + 1) : content, {
        status: range ? 206 : 200, headers,
      });
    }
    if (method === 'GET') responseFile = await openPublicShareResponseFile(responseFile);
    await assertPublicShareStillActive(resolved);
    return publicShareFileStreamResponse(request, responseFile, method, resolved.share.securityMode);
  } catch {
    await responseFile.handle?.close();
    return publicShareNotFoundResponse();
  }
}

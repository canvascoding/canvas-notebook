import { promises as fs } from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import {
  publicShareFileStreamResponse,
  publicShareNotFoundResponse,
  openPublicShareResponseFile,
  type PublicShareResponseFile,
} from '@/app/lib/public-sharing/public-file-response';
import {
  getPublicShareMimeType,
  isSensitiveWorkspacePath,
  resolvePublicShareToken,
} from '@/app/lib/public-sharing/public-file-shares';
import { resolveExistingWorkspacePath } from '@/app/lib/filesystem/workspace-files';
import { collectPublicMarkdownImageWorkspacePaths } from '@/app/lib/public-sharing/public-markdown-images';
import { assertPublicShareStillActive, readPublicShareText } from '@/app/lib/public-sharing/public-share-text';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.markdown']);

function decodePathSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isImageMimeType(mimeType: string) {
  return mimeType.toLowerCase().startsWith('image/');
}

async function handlePublicMarkdownAssetRequest(
  request: NextRequest,
  context: { params: Promise<{ token: string; assetPath: string[] }> },
  method: 'GET' | 'HEAD',
) {
  const { token, assetPath } = await context.params;
  const resolved = await resolvePublicShareToken(decodePathSegment(token), { recordAccess: false });
  if (!resolved.ok) return publicShareNotFoundResponse();

  if (!MARKDOWN_EXTENSIONS.has(path.extname(resolved.workspacePath).toLowerCase())) {
    return publicShareNotFoundResponse();
  }

  const requestedWorkspacePath = assetPath.map(decodePathSegment).join('/');
  if (!requestedWorkspacePath || isSensitiveWorkspacePath(requestedWorkspacePath)) {
    return publicShareNotFoundResponse();
  }

  let markdown: string;
  try {
    markdown = await readPublicShareText(resolved);
  } catch {
    return publicShareNotFoundResponse();
  }

  const allowedAssetPaths = collectPublicMarkdownImageWorkspacePaths(markdown, resolved.workspacePath, resolved.workspace.workspaceId);
  if (!allowedAssetPaths.has(requestedWorkspacePath)) {
    return publicShareNotFoundResponse();
  }

  const mimeType = getPublicShareMimeType(requestedWorkspacePath);
  if (!isImageMimeType(mimeType)) {
    return publicShareNotFoundResponse();
  }

  try {
    const fullPath = await resolveExistingWorkspacePath(requestedWorkspacePath, { workspace: resolved.workspace });
    const stats = await fs.stat(fullPath);
    if (!stats.isFile()) return publicShareNotFoundResponse();
    let file: PublicShareResponseFile = {
      workspacePath: requestedWorkspacePath,
      fileName: path.posix.basename(requestedWorkspacePath),
      fullPath,
      sizeBytes: stats.size,
      fileIdentity: `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`,
      mimeType,
      asSiteAsset: false,
    };
    if (method === 'GET') file = await openPublicShareResponseFile(file);
    try {
      await assertPublicShareStillActive(resolved);
      return publicShareFileStreamResponse(request, file, method, resolved.share.securityMode);
    } catch (error) {
      await file.handle?.close();
      throw error;
    }
  } catch {
    return publicShareNotFoundResponse();
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string; assetPath: string[] }> },
) {
  return handlePublicMarkdownAssetRequest(request, context, 'GET');
}

export async function HEAD(
  request: NextRequest,
  context: { params: Promise<{ token: string; assetPath: string[] }> },
) {
  return handlePublicMarkdownAssetRequest(request, context, 'HEAD');
}

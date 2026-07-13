import { promises as fs } from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import {
  publicShareFileStreamResponse,
  publicShareNotFoundResponse,
} from '@/app/lib/public-sharing/public-file-response';
import {
  getPublicShareMimeType,
  isSensitiveWorkspacePath,
  resolvePublicShareToken,
} from '@/app/lib/public-sharing/public-file-shares';
import { resolveExistingWorkspacePath } from '@/app/lib/filesystem/workspace-files';
import { collectPublicMarkdownImageWorkspacePaths } from '@/app/lib/public-sharing/public-markdown-images';

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
    markdown = await fs.readFile(resolved.fullPath, 'utf8');
  } catch {
    return publicShareNotFoundResponse();
  }

  const allowedAssetPaths = collectPublicMarkdownImageWorkspacePaths(markdown, resolved.workspacePath);
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

    return publicShareFileStreamResponse(
      request,
      {
        workspacePath: requestedWorkspacePath,
        fileName: path.posix.basename(requestedWorkspacePath),
        fullPath,
        sizeBytes: stats.size,
        mimeType,
        asSiteAsset: false,
      },
      method,
      resolved.share.securityMode,
    );
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

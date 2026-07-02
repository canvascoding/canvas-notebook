import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { promises as fs } from 'fs';
import { resolveExistingWorkspacePath, validatePath } from '@/app/lib/filesystem/workspace-files';
import { 
  resolveValidatedStudioEditPath,
  resolveValidatedStudioAssetPath, 
  resolveValidatedStudioOutputPath,
  resolveValidatedUserUploadStudioRefPath 
} from '@/app/lib/integrations/studio-paths';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import {
  getPreviewContentType,
  getPreviewPreset,
  isSupportedPreviewExtension,
  renderCachedMediaPreview,
  resolvePreviewWidth,
} from '@/app/lib/files/media-preview';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

function buildMediaUrl(filePath: string, workspaceId?: string | null) {
  const encodedPath = filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const workspaceQuery = workspaceId?.trim()
    ? `?workspaceId=${encodeURIComponent(workspaceId.trim())}`
    : '';
  return `/api/media/${encodedPath}${workspaceQuery}`;
}

function buildSameOriginRedirect(request: NextRequest, relativePath: string): URL {
  return new URL(relativePath, request.url);
}

async function fileExists(filePath: string) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  try {
    const limited = rateLimit(request, {
      limit: 120,
      windowMs: 60_000,
      keyPrefix: 'files-preview',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
    if (workspaceResult.response) return workspaceResult.response;
    const fileOptions = workspaceFileOptions(workspaceResult.workspace);

    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');
    const widthParam = searchParams.get('w') || '';
    const preset = getPreviewPreset(searchParams.get('preset'));

    if (!filePath) {
      return NextResponse.json(
        { success: false, error: 'Path parameter is required' },
        { status: 400 }
      );
    }

    const width = resolvePreviewWidth(widthParam, preset);

    const extension = path.posix.extname(filePath).slice(1).toLowerCase();
    if (!isSupportedPreviewExtension(extension)) {
      const mediaPath = buildMediaUrl(filePath, workspaceResult.workspace.workspaceId);
      return NextResponse.redirect(buildSameOriginRedirect(request, mediaPath));
    }

    // Resolve the full filesystem path based on the virtual path prefix
    let fullPath: string;
    if (filePath.startsWith('studio/outputs/')) {
      const resolved = resolveValidatedStudioOutputPath(filePath.slice('studio/outputs/'.length));
      if (!resolved) {
        return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
      }
      fullPath = resolved;
    } else if (filePath.startsWith('studio/edits/')) {
      const resolved = resolveValidatedStudioEditPath(filePath.slice('studio/edits/'.length));
      if (!resolved) {
        return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
      }
      fullPath = resolved;
    } else if (filePath.startsWith('studio/assets/')) {
      const resolved = resolveValidatedStudioAssetPath(filePath.slice('studio/assets/'.length));
      if (!resolved) {
        return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
      }
      fullPath = resolved;
    } else if (filePath.startsWith('user-uploads/studio-references/')) {
      const resolved = resolveValidatedUserUploadStudioRefPath(filePath.slice('user-uploads/studio-references/'.length));
      if (!resolved) {
        return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
      }
      fullPath = resolved;
    } else if (
      filePath.startsWith('products/') ||
      filePath.startsWith('personas/') ||
      filePath.startsWith('styles/') ||
      filePath.startsWith('presets/') ||
      filePath.startsWith('references/')
    ) {
      const resolved = resolveValidatedStudioAssetPath(filePath);
      if (!resolved) {
        return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
      }
      fullPath = resolved;
    } else if (filePath.startsWith('studio-gen-')) {
      const resolved = resolveValidatedStudioOutputPath(filePath);
      if (!resolved) {
        return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
      }
      fullPath = resolved;
    } else {
      try {
        fullPath = await resolveExistingWorkspacePath(filePath, fileOptions);
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
          throw error;
        }
        fullPath = validatePath(filePath, fileOptions);
      }
    }

    // Check if file exists before stat
    const exists = await fileExists(fullPath);
    if (!exists) {
      return NextResponse.json(
        { success: false, error: 'File not found' },
        { status: 404 }
      );
    }

    const stats = await fs.stat(fullPath);
    if (!stats.isFile()) {
      return NextResponse.json(
        { success: false, error: 'File not found' },
        { status: 404 }
      );
    }

    let preview;
    try {
      preview = await renderCachedMediaPreview({
        inputPath: fullPath,
        cacheIdentity: filePath,
        extension,
        width,
        preset,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    } catch (error) {
      const mediaPath = buildMediaUrl(filePath, workspaceResult.workspace.workspaceId);
      console.error('[API] Preview error:', error);
      return NextResponse.redirect(buildSameOriginRedirect(request, mediaPath));
    }

    const requestEtag = request.headers.get('if-none-match');
    if (requestEtag && requestEtag === preview.etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: preview.etag,
          'Cache-Control': 'private, max-age=86400, immutable',
        },
      });
    }

    return new NextResponse(preview.body, {
      headers: {
        'Content-Type': getPreviewContentType(preview.format),
        'Cache-Control': 'private, max-age=86400, immutable',
        ETag: preview.etag,
      },
    });
  } catch (error) {
    console.error('[API] Preview error:', error);
    const message = error instanceof Error ? error.message : 'Failed to render preview';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import {
  createReadStream as createNodeReadStream,
  promises as fs,
} from 'fs';
import path from 'path';
import { createReadStream, getFileStats } from '@/app/lib/filesystem/workspace-files';
import { compactWorkspaceSelection } from '@/app/lib/files/operation-flows';
import { normalizeWorkspacePathParam } from '@/app/lib/files/path-utils';
import { Readable } from 'stream';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { isAdminUser } from '@/app/lib/admin-auth';
import { canExportWorkspaceFiles } from '@/app/lib/workspaces/export-access';
import {
  requireRequestPersonalWorkspace,
  requireRequestWorkspace,
  workspaceFileOptions,
} from '@/app/lib/workspaces/request';
import { withNativeWorkspaceFileRead, type NativeWorkspaceFileRead } from '@/app/lib/collaboration/workspace-native-file-read';
import { collaborationCheckpointValidationFailure } from '@/app/lib/collaboration/checkpoint-errors';
import { materializeWorkspaceDownloadArchive, type WorkspaceDownloadArchive } from '@/app/lib/files/workspace-download-archive';

const MAX_SINGLE_FILE_SIZE = 2 * 1024 * 1024 * 1024;
// Native text is materialized from a validated snapshot, so its memory budget is separate from streamed binary files.
const MAX_NATIVE_FILE_DOWNLOAD_SIZE = 64 * 1024 * 1024;
const DOWNLOAD_ARCHIVE_TTL_MS = 5 * 60_000;

class DownloadPlanError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly code: string = 'INVALID_DOWNLOAD_SELECTION',
  ) {
    super(message);
    this.name = 'DownloadPlanError';
  }
}

function resolveDownloadName(filePath: string): string {
  const basename = path.posix.basename(filePath);
  if (basename === '' || basename === '/' || basename === '.') return 'workspace';
  return basename;
}

function createAttachmentDisposition(fileName: string): string {
  const safeName = path.posix.basename(fileName).replace(/["\\\r\n]/gu, '_') || 'download';
  const fallbackName = safeName.replace(/[^\x20-\x7E]/gu, '_') || 'download';
  const utf8Name = encodeURIComponent(safeName).replace(/[!'()*]/gu, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return `attachment; filename="${fallbackName}"; filename*=UTF-8''${utf8Name}`;
}

function hasNodeErrorCode(error: unknown, codes: string[]) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    codes.includes(String(error.code))
  );
}

function normalizeSelectionPaths(paths: string[]): string[] {
  if (paths.length === 0) {
    throw new DownloadPlanError('Path parameter is required');
  }

  const normalizedPaths = paths.map((filePath) => {
    const normalized = normalizeWorkspacePathParam(filePath);
    if (!normalized) {
      throw new DownloadPlanError('Download paths must be workspace-relative files or folders');
    }
    return normalized;
  });

  return compactWorkspaceSelection(normalizedPaths);
}

async function createArchiveResponse(artifact: WorkspaceDownloadArchive, fileName: string): Promise<NextResponse> {
  const { archivePath, tempDirectory } = artifact;
  try {
    const stats = await fs.stat(archivePath);
    const stream = createNodeReadStream(archivePath);
    let cleanedUp = false;
    let expiration: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (expiration) clearTimeout(expiration);
      void fs.rm(tempDirectory, { recursive: true, force: true });
    };
    expiration = setTimeout(cleanup, DOWNLOAD_ARCHIVE_TTL_MS);
    expiration.unref?.();
    stream.once('close', cleanup);
    stream.once('error', cleanup);

    return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': createAttachmentDisposition(fileName),
        'Content-Length': stats.size.toString(),
      },
    });
  } catch (error) {
    await fs.rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const scope = searchParams.get('scope');
  if (scope === 'data') {
    return NextResponse.json(
      { success: false, error: 'Full data downloads are no longer available. Use an administrator migration or backup instead.' },
      { status: 410 },
    );
  }

  if (scope === 'workspace' && !searchParams.get('workspaceId')?.trim()) {
    return NextResponse.json(
      { success: false, error: 'Workspace selection is required' },
      { status: 400 },
    );
  }

  const workspaceResult = scope === 'personal'
    ? await requireRequestPersonalWorkspace(request, { permissions: 'canRead' })
    : await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const { session, workspace } = workspaceResult;

  if (scope === 'workspace') {
    const canExportWorkspace = canExportWorkspaceFiles({
      workspaceType: workspace.workspaceType,
      isPersonalOwner: workspace.workspaceType === 'personal' && workspace.ownerUserId === session.user.id,
      isInstanceAdmin: isAdminUser(session.user),
      canRead: workspace.permissions.canRead,
      status: workspace.status,
    });
    if (!canExportWorkspace) {
      return NextResponse.json(
        {
          success: false,
          error: 'Shared workspace exports are restricted to administrators',
          code: 'WORKSPACE_EXPORT_ADMIN_REQUIRED',
        },
        { status: 403 },
      );
    }
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'files-download',
  });
  if (!limited.ok) return limited.response;

  const isWorkspaceArchive = scope === 'personal' || scope === 'workspace';
  let selectedPaths: string[];
  try {
    selectedPaths = isWorkspaceArchive ? ['.'] : normalizeSelectionPaths(searchParams.getAll('path'));
  } catch (error) {
    if (error instanceof DownloadPlanError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }

  const fileOptions = workspaceFileOptions(workspace);
  try {
    const isMultipleSelection = selectedPaths.length > 1;
    const effectiveFilePath = selectedPaths[0];
    const download = async (native: NativeWorkspaceFileRead | null): Promise<NextResponse | (() => Promise<NextResponse>)> => {
      if (native) {
        if (!native.content) throw new DownloadPlanError('Native text export is unavailable', 409, 'NATIVE_EXPORT_UNAVAILABLE');
        return new NextResponse(Readable.toWeb(Readable.from([native.content])) as ReadableStream<Uint8Array>, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': createAttachmentDisposition(resolveDownloadName(effectiveFilePath)),
            'Content-Length': native.content.byteLength.toString(),
          },
        });
      }
      const archiveResponse = async () => {
        const artifact = await materializeWorkspaceDownloadArchive(workspace, selectedPaths);
        const fileName = isMultipleSelection ? 'notebook-selection.zip' : `${resolveDownloadName(effectiveFilePath)}.zip`;
        return createArchiveResponse(artifact, fileName);
      };
      if (isMultipleSelection || effectiveFilePath === '.') return archiveResponse;
      let stats: Awaited<ReturnType<typeof getFileStats>>;
      try { stats = await getFileStats(effectiveFilePath, fileOptions); }
      catch (error) {
        // A registry-only document can prove a virtual folder even when its
        // physical directory is absent. The archive reader confirms that scope.
        if (hasNodeErrorCode(error, ['ENOENT', 'ENOTDIR'])) return archiveResponse;
        throw error;
      }
      if (stats.isDirectory) return archiveResponse;

      if (stats.size > MAX_SINGLE_FILE_SIZE) {
        return NextResponse.json(
          { success: false, error: 'File is too large to download (max 2GB)' },
          { status: 413 },
        );
      }

      const { stream } = await createReadStream(effectiveFilePath, undefined, fileOptions);
      return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': createAttachmentDisposition(resolveDownloadName(effectiveFilePath)),
          'Content-Length': stats.size.toString(),
        },
      });
    };
    const response = !isMultipleSelection && effectiveFilePath !== '.'
      ? await withNativeWorkspaceFileRead({ workspace, path: effectiveFilePath, mode: 'export', maxBytes: MAX_NATIVE_FILE_DOWNLOAD_SIZE }, download)
      : await download(null);
    return typeof response === 'function' ? await response() : response;
  } catch (error) {
    if (hasNodeErrorCode(error, ['ENOENT', 'ENOTDIR'])) {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }
    if (error instanceof DownloadPlanError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    const nativeExportFailure = collaborationCheckpointValidationFailure(error);
    if (nativeExportFailure) {
      return NextResponse.json({ success: false, error: 'The native document cannot be exported losslessly.',
        code: nativeExportFailure.code }, { status: nativeExportFailure.status });
    }
    if (error instanceof Error && 'status' in error && Number.isInteger(error.status)
      && Number(error.status) >= 400 && Number(error.status) <= 599) {
      return NextResponse.json({ success: false, error: error.message,
        ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}) }, { status: Number(error.status) });
    }

    console.error('[API] File download error:', error);
    const message = error instanceof Error ? error.message : 'Failed to download file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

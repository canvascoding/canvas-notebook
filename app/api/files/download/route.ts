import { NextRequest, NextResponse } from 'next/server';
import { createReadStream as createNodeReadStream, promises as fs } from 'fs';
import path from 'path';
import { createReadStream, getFileStats, validatePath } from '@/app/lib/filesystem/workspace-files';
import { Readable } from 'stream';
import ZipStream from 'zip-stream';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { isAdminUser } from '@/app/lib/admin-auth';
import { canExportWorkspaceFiles } from '@/app/lib/workspaces/export-access';
import {
  requireRequestPersonalWorkspace,
  requireRequestWorkspace,
  workspaceFileOptions,
} from '@/app/lib/workspaces/request';

const MAX_ZIP_DOWNLOAD_SIZE = 1024 * 1024 * 1024;
const MAX_SINGLE_FILE_SIZE = 2 * 1024 * 1024 * 1024;

function resolveDownloadName(filePath: string): string {
  const basename = path.posix.basename(filePath);
  if (basename === '' || basename === '/') return 'workspace';
  return basename;
}

function hasNodeErrorCode(error: unknown, codes: string[]) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    codes.includes(String(error.code))
  );
}

type ZipArchive = InstanceType<typeof ZipStream>;

function addZipEntry(
  archive: ZipArchive,
  source: NodeJS.ReadableStream | Buffer | string | null,
  data: { name: string; type?: 'file' | 'directory'; stats?: import('fs').Stats }
) {
  return new Promise<void>((resolve, reject) => {
    archive.entry(source, data, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function addDirectoryToArchive(archive: ZipArchive, rootPath: string, downloadName: string) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });

  if (entries.length === 0) {
    await addZipEntry(archive, null, { name: `${downloadName}/`, type: 'directory' });
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    const relativePath = path.relative(rootPath, entryPath).split(path.sep).join('/');
    const zipPath = `${downloadName}/${relativePath}`;

    if (entry.isDirectory()) {
      await addDirectoryToArchive(archive, entryPath, zipPath);
      continue;
    }

    if (entry.isFile()) {
      const stats = await fs.stat(entryPath);
      await addZipEntry(archive, createNodeReadStream(entryPath), { name: zipPath, stats });
    }
  }
}

async function streamDirectoryToArchive(archive: ZipArchive, fullPath: string, downloadName: string) {
  try {
    await addDirectoryToArchive(archive, fullPath, downloadName);
    archive.finish();
  } catch (error) {
    archive.destroy(error instanceof Error ? error : new Error('Failed to create ZIP archive'));
  }
}

function createZipResponse(fullPath: string, downloadName: string) {
  const archive = new ZipStream({ level: 1 });
  const webStream = Readable.toWeb(archive) as ReadableStream<Uint8Array>;

  void streamDirectoryToArchive(archive, fullPath, downloadName);

  return new NextResponse(webStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${downloadName}.zip"`,
    },
  });
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

  const fileOptions = workspaceFileOptions(workspace);

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'files-download',
  });
  if (!limited.ok) {
    return limited.response;
  }

  const filePath = searchParams.get('path');
  const isWorkspaceArchive = scope === 'personal' || scope === 'workspace';
  const effectiveFilePath = isWorkspaceArchive ? '.' : filePath;
  if (!effectiveFilePath) {
    return NextResponse.json({ success: false, error: 'Path parameter is required' }, { status: 400 });
  }

  try {
    const stats = await getFileStats(effectiveFilePath, fileOptions);
    const downloadName = isWorkspaceArchive ? 'workspace' : resolveDownloadName(effectiveFilePath);

    if (stats.isDirectory) {
      if (stats.size > MAX_ZIP_DOWNLOAD_SIZE) {
        return NextResponse.json(
          { success: false, error: 'Directory is too large to download as ZIP (max 1GB)' },
          { status: 413 }
        );
      }

      const fullPath = validatePath(effectiveFilePath, fileOptions);
      return createZipResponse(fullPath, downloadName);
    } else {
      if (stats.size > MAX_SINGLE_FILE_SIZE) {
        return NextResponse.json(
          { success: false, error: 'File is too large to download (max 2GB)' },
          { status: 413 }
        );
      }

      const { stream } = await createReadStream(effectiveFilePath, undefined, fileOptions);
      const webStream = Readable.toWeb(stream) as ReadableStream<Uint8Array>;

      return new NextResponse(webStream, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${downloadName}"`,
          'Content-Length': stats.size.toString(),
        },
      });
    }
  } catch (error) {
    if (hasNodeErrorCode(error, ['ENOENT', 'ENOTDIR'])) {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }

    console.error('[API] File download error:', error);
    const message = error instanceof Error ? error.message : 'Failed to download file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

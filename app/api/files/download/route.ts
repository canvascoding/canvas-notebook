import { NextRequest, NextResponse } from 'next/server';
import {
  createReadStream as createNodeReadStream,
  createWriteStream as createNodeWriteStream,
  promises as fs,
  type Stats,
} from 'fs';
import os from 'os';
import path from 'path';
import { finished } from 'stream/promises';
import { createReadStream, getFileStats, validatePath, type WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import { compactWorkspaceSelection } from '@/app/lib/files/operation-flows';
import { normalizeWorkspacePathParam } from '@/app/lib/files/path-utils';
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
const MAX_ZIP_ENTRY_COUNT = 10_000;
const MAX_ZIP_DIRECTORY_DEPTH = 64;
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

interface ArchiveEntry {
  archivePath: string;
  fullPath: string | null;
  stats?: Stats;
  type: 'file' | 'directory';
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

type ZipArchive = InstanceType<typeof ZipStream>;

function addZipEntry(
  archive: ZipArchive,
  source: NodeJS.ReadableStream | Buffer | string | null,
  data: { name: string; type?: 'file' | 'directory'; stats?: Stats }
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

async function collectArchiveEntries(
  selectedPaths: readonly string[],
  fileOptions: WorkspaceFileOperationOptions,
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const archiveNames = new Map<string, string>();
  let totalSize = 0;

  const registerEntry = (entry: ArchiveEntry) => {
    const normalizedName = entry.archivePath.normalize('NFC').toLocaleLowerCase('en-US');
    const previousName = archiveNames.get(normalizedName);
    if (previousName && previousName !== entry.archivePath) {
      throw new DownloadPlanError(
        `The selected files would create conflicting archive names: ${previousName} and ${entry.archivePath}`,
        409,
        'ARCHIVE_NAME_CONFLICT',
      );
    }
    if (previousName) return;

    archiveNames.set(normalizedName, entry.archivePath);
    entries.push(entry);
    if (entries.length > MAX_ZIP_ENTRY_COUNT) {
      throw new DownloadPlanError(
        `Too many files to download as one archive (max ${MAX_ZIP_ENTRY_COUNT})`,
        413,
        'ARCHIVE_TOO_MANY_ENTRIES',
      );
    }
  };

  const visit = async (fullPath: string, archivePath: string, depth: number): Promise<void> => {
    if (depth > MAX_ZIP_DIRECTORY_DEPTH) {
      throw new DownloadPlanError(
        `Folder nesting is too deep to download (max ${MAX_ZIP_DIRECTORY_DEPTH} levels)`,
        413,
        'ARCHIVE_TOO_DEEP',
      );
    }

    const stats = await fs.lstat(fullPath);
    if (stats.isSymbolicLink()) {
      throw new DownloadPlanError(
        `Symbolic links cannot be included in downloads: ${archivePath}`,
        400,
        'ARCHIVE_SYMBOLIC_LINK',
      );
    }

    if (stats.isFile()) {
      totalSize += stats.size;
      if (totalSize > MAX_ZIP_DOWNLOAD_SIZE) {
        throw new DownloadPlanError(
          'Selected files are too large to download as ZIP (max 1GB)',
          413,
          'ARCHIVE_TOO_LARGE',
        );
      }
      registerEntry({ archivePath, fullPath, stats, type: 'file' });
      return;
    }

    if (!stats.isDirectory()) {
      throw new DownloadPlanError(
        `Unsupported file type in download: ${archivePath}`,
        400,
        'ARCHIVE_UNSUPPORTED_ENTRY',
      );
    }

    registerEntry({ archivePath: `${archivePath.replace(/\/+$/u, '')}/`, fullPath: null, type: 'directory' });
    const children = await fs.readdir(fullPath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      await visit(
        path.join(fullPath, child.name),
        `${archivePath.replace(/\/+$/u, '')}/${child.name}`,
        depth + 1,
      );
    }
  };

  for (const selectedPath of selectedPaths) {
    const fullPath = validatePath(selectedPath, fileOptions);
    await visit(fullPath, selectedPath === '.' ? 'workspace' : selectedPath, 0);
  }

  return entries;
}

async function writeArchive(entries: readonly ArchiveEntry[]): Promise<{ archivePath: string; tempDirectory: string }> {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-download-'));
  const archivePath = path.join(tempDirectory, 'selection.zip');
  const archive = new ZipStream({ level: 1 });
  const output = createNodeWriteStream(archivePath);
  let archiveError: Error | null = null;
  const outputFinished = finished(output);

  archive.on('error', (error) => {
    archiveError = error;
    output.destroy(error);
  });

  archive.pipe(output);
  try {
    for (const entry of entries) {
      if (entry.type === 'directory') {
        await addZipEntry(archive, null, { name: entry.archivePath, type: 'directory' });
        continue;
      }

      if (!entry.fullPath || !entry.stats) {
        throw new DownloadPlanError('Invalid file entry in download archive', 500, 'ARCHIVE_ENTRY_INVALID');
      }

      const currentStats = await fs.lstat(entry.fullPath);
      if (!currentStats.isFile() || currentStats.size !== entry.stats.size || currentStats.mtimeMs !== entry.stats.mtimeMs) {
        throw new DownloadPlanError(
          `A selected file changed while the archive was prepared: ${entry.archivePath}`,
          409,
          'ARCHIVE_SOURCE_CHANGED',
        );
      }
      await addZipEntry(archive, createNodeReadStream(entry.fullPath), { name: entry.archivePath, stats: currentStats });
    }
    archive.finish();
    await outputFinished;
    if (archiveError) throw archiveError;
    return { archivePath, tempDirectory };
  } catch (error) {
    archive.destroy(error instanceof Error ? error : new Error('Failed to create ZIP archive'));
    output.destroy();
    await fs.rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function createArchiveResponse(entries: readonly ArchiveEntry[], fileName: string): Promise<NextResponse> {
  const { archivePath, tempDirectory } = await writeArchive(entries);
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
    const stats = await getFileStats(effectiveFilePath, fileOptions);
    if (isMultipleSelection || stats.isDirectory) {
      const entries = await collectArchiveEntries(selectedPaths, fileOptions);
      const fileName = isMultipleSelection
        ? 'notebook-selection.zip'
        : `${resolveDownloadName(effectiveFilePath)}.zip`;
      return await createArchiveResponse(entries, fileName);
    }

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
  } catch (error) {
    if (hasNodeErrorCode(error, ['ENOENT', 'ENOTDIR'])) {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }
    if (error instanceof DownloadPlanError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }

    console.error('[API] File download error:', error);
    const message = error instanceof Error ? error.message : 'Failed to download file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

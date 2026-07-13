import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  resolveValidatedUserUploadStudioRefPath,
  resolveValidatedWorkspaceFilePath,
} from '@/app/lib/integrations/studio-paths';
import { getUserUploadsStudioRefRoot } from '@/app/lib/runtime-data-paths';
import { isPathInside } from '@/app/lib/security/safe-paths';
import { getWorkspacePath } from '@/app/lib/utils/workspace-manager';

export type StudioImportFile = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
};

type AllowedFileLocation = {
  filePath: string;
  root: string;
};

function resolveAllowedFilePath(filePath: string): AllowedFileLocation | null {
  if (filePath.startsWith('user-uploads/studio-references/')) {
    const root = getUserUploadsStudioRefRoot();
    const resolvedPath = resolveValidatedUserUploadStudioRefPath(filePath.slice('user-uploads/studio-references/'.length));
    return resolvedPath ? { filePath: resolvedPath, root } : null;
  }
  const workspacePath = resolveValidatedWorkspaceFilePath(filePath);
  if (workspacePath) {
    return { filePath: workspacePath, root: getWorkspacePath() };
  }

  const uploadPath = resolveValidatedUserUploadStudioRefPath(filePath);
  return uploadPath ? { filePath: uploadPath, root: getUserUploadsStudioRefRoot() } : null;
}

async function resolveExistingAllowedFilePath(filePath: string): Promise<string | null> {
  const location = resolveAllowedFilePath(filePath);
  if (!location) return null;

  try {
    const [realRoot, realPath] = await Promise.all([
      fs.realpath(location.root),
      fs.realpath(location.filePath),
    ]);
    return isPathInside(realRoot, realPath) ? realPath : null;
  } catch {
    return null;
  }
}

function mimeTypeFromFileName(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

export async function readStudioImportFile(filePath: string): Promise<StudioImportFile | null> {
  const resolvedPath = await resolveExistingAllowedFilePath(filePath);
  if (!resolvedPath) return null;

  const buffer = await fs.readFile(resolvedPath);
  const fileName = path.basename(resolvedPath) || 'imported.jpg';
  return {
    buffer,
    fileName,
    mimeType: mimeTypeFromFileName(fileName),
  };
}

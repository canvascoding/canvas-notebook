import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  resolveValidatedUserUploadStudioRefPath,
  resolveValidatedWorkspaceFilePath,
} from '@/app/lib/integrations/studio-paths';

export type StudioImportFile = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
};

function resolveAllowedFilePath(filePath: string): string | null {
  if (filePath.startsWith('user-uploads/studio-references/')) {
    return resolveValidatedUserUploadStudioRefPath(filePath.slice('user-uploads/studio-references/'.length));
  }
  return resolveValidatedWorkspaceFilePath(filePath)
    ?? resolveValidatedUserUploadStudioRefPath(filePath);
}

function mimeTypeFromFileName(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

export async function readStudioImportFile(filePath: string): Promise<StudioImportFile | null> {
  const resolvedPath = resolveAllowedFilePath(filePath);
  if (!resolvedPath) return null;

  const buffer = await fs.readFile(resolvedPath);
  const fileName = path.basename(filePath) || 'imported.jpg';
  return {
    buffer,
    fileName,
    mimeType: mimeTypeFromFileName(fileName),
  };
}

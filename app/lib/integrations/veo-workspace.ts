import path from 'path';
import { createDirectory } from '@/app/lib/filesystem/workspace-files';

export const VEO_ROOT_DIR = 'veo-studio';
export const VEO_OUTPUT_DIR = path.posix.join(VEO_ROOT_DIR, 'video-generation');
export const VEO_ASSETS_DIR = path.posix.join(VEO_ROOT_DIR, 'assets');

export async function ensureVeoWorkspace(): Promise<void> {
  await createDirectory(VEO_ROOT_DIR);
  await createDirectory(VEO_OUTPUT_DIR);
  await createDirectory(VEO_ASSETS_DIR);
}

export function createVeoOutputFilename(extension: string): string {
  const safeExtension = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = Math.random().toString(36).slice(2, 10);
  return `veo-${timestamp}-${random}.${safeExtension}`;
}


import path from 'path';
import { createDirectory } from '@/app/lib/filesystem/workspace-files';

export const IMAGE_GENERATION_ROOT_DIR = 'image-generation';
export const IMAGE_GENERATION_OUTPUT_DIR = path.posix.join(IMAGE_GENERATION_ROOT_DIR, 'generations');
export const IMAGE_GENERATION_ASSETS_DIR = path.posix.join(IMAGE_GENERATION_ROOT_DIR, 'assets');

export async function ensureImageGenerationWorkspace(): Promise<void> {
  await createDirectory(IMAGE_GENERATION_ROOT_DIR);
  await createDirectory(IMAGE_GENERATION_OUTPUT_DIR);
  await createDirectory(IMAGE_GENERATION_ASSETS_DIR);
}

function toSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slug || 'image';
}

export function createImageGenerationOutputFilename(
  prompt: string,
  index: number,
  extension: string
): string {
  const safeExtension = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = Math.random().toString(36).slice(2, 10);
  const promptSlug = toSlug(prompt);
  return `image-gen-${promptSlug}-${index + 1}-${timestamp}-${random}.${safeExtension}`;
}

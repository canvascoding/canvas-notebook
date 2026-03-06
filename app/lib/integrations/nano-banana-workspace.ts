import path from 'path';
import { createDirectory } from '@/app/lib/filesystem/workspace-files';

export const NANO_BANANA_ROOT_DIR = 'nano-banana-ad-localizer';
export const NANO_BANANA_OUTPUT_DIR = path.posix.join(NANO_BANANA_ROOT_DIR, 'localizations');
export const NANO_BANANA_ASSETS_DIR = path.posix.join(NANO_BANANA_ROOT_DIR, 'assets');

export async function ensureNanoBananaWorkspace(): Promise<void> {
  await createDirectory(NANO_BANANA_ROOT_DIR);
  await createDirectory(NANO_BANANA_OUTPUT_DIR);
  await createDirectory(NANO_BANANA_ASSETS_DIR);
}

function toSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'market';
}

export function createNanoBananaOutputFilename(market: string, extension: string): string {
  const safeExtension = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = Math.random().toString(36).slice(2, 10);
  const marketSlug = toSlug(market);
  return `nano-banana-${marketSlug}-${timestamp}-${random}.${safeExtension}`;
}

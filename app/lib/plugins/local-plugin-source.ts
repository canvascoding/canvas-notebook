import path from 'node:path';

import { requirePathInside } from '@/app/lib/security/safe-paths';

/**
 * Local plugin packages exposed through Settings must live in an explicit
 * intake directory. Agents use their workspace-scoped install path instead.
 */
export function resolveLocalPluginSourceRoot(): string {
  const configured = process.env.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT?.trim();
  return path.resolve(configured || path.join(process.cwd(), 'plugins'));
}

export function resolveLocalPluginSourcePath(sourcePath: string): string {
  if (sourcePath.includes('\0')) {
    throw new Error('Plugin source path is invalid.');
  }
  return requirePathInside(resolveLocalPluginSourceRoot(), sourcePath.trim());
}

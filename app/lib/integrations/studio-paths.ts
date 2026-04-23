import path from 'node:path';
import { getStudioAssetsRoot, getStudioOutputsRoot } from '@/app/lib/integrations/studio-workspace';

function resolveWithinRoot(root: string, relativePath: string): string | null {
  const resolvedRoot = path.resolve(/*turbopackIgnore: true*/ root);
  const resolvedTarget = path.resolve(/*turbopackIgnore: true*/ root, relativePath);
  if (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    return resolvedTarget;
  }
  return null;
}

export function resolveValidatedStudioAssetPath(relativePath: string): string | null {
  return resolveWithinRoot(getStudioAssetsRoot(), path.normalize(relativePath));
}

export function resolveValidatedStudioOutputPath(relativePath: string): string | null {
  return resolveWithinRoot(getStudioOutputsRoot(), path.normalize(relativePath));
}

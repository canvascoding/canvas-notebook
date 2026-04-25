import path from 'node:path';
import { getStudioAssetsRoot, getStudioOutputsRoot } from '@/app/lib/integrations/studio-workspace';
import { getUserUploadsStudioRefRoot } from '@/app/lib/runtime-data-paths';
import { getWorkspacePath } from '@/app/lib/utils/workspace-manager';

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

export function resolveValidatedUserUploadStudioRefPath(relativePath: string): string | null {
  return resolveWithinRoot(getUserUploadsStudioRefRoot(), path.normalize(relativePath));
}

export function resolveValidatedWorkspaceFilePath(absolutePath: string): string | null {
  const workspaceRoot = path.resolve(getWorkspacePath());
  const resolvedTarget = path.resolve(absolutePath);
  if (resolvedTarget === workspaceRoot || resolvedTarget.startsWith(`${workspaceRoot}${path.sep}`)) {
    return resolvedTarget;
  }
  return null;
}

export function getWorkspaceRoot(): string {
  return path.resolve(getWorkspacePath());
}

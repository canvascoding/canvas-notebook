import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  resolveExistingWorkspacePath,
  writeFile,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import { classifyMediaReference } from '@/app/lib/integrations/media-reference-resolver';
import { canWriteStudioMediaReference } from '@/app/lib/integrations/studio-media-access';
import type { StudioScope } from '@/app/lib/integrations/studio-scope';
import {
  getStudioRoot,
  getStudioWorkspaceRoot,
  getStudioWorkspaceVirtualRoot,
} from '@/app/lib/integrations/studio-workspace';
import { getUserUploadsStudioRefRoot } from '@/app/lib/runtime-data-paths';

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function requireExistingStudioTarget(
  absolutePath: string,
  allowedRoot: string,
): Promise<string> {
  const [realTarget, realRoot] = await Promise.all([
    fs.realpath(absolutePath),
    fs.realpath(allowedRoot),
  ]);
  if (!isWithinRoot(realTarget, realRoot)) {
    throw new Error('Source image is not writable in this workspace');
  }
  const stats = await fs.stat(realTarget);
  if (!stats.isFile()) {
    throw new Error('Source image is not a file');
  }
  return realTarget;
}

export async function overwriteAspectRatioSource(
  sourcePath: string,
  buffer: Buffer,
  scope: StudioScope,
  workspaceOptions?: WorkspaceFileOperationOptions,
): Promise<void> {
  const reference = classifyMediaReference(sourcePath, { userId: scope.actorUserId });
  if (!reference || reference.kind === 'external_url' || !reference.absolutePath && !reference.workspaceId) {
    throw new Error('Only local studio, upload, and workspace images can be overwritten');
  }

  if (reference.kind === 'workspace_relative' || reference.kind === 'workspace_absolute') {
    const workspace = workspaceOptions?.workspace;
    if (!workspace?.permissions.canWrite) {
      throw new Error('Source image is not writable in this workspace');
    }
    if (reference.workspaceId && reference.workspaceId !== workspace.workspaceId) {
      throw new Error('Source image belongs to a different workspace');
    }

    const existingPath = await resolveExistingWorkspacePath(reference.relativePath, workspaceOptions);
    if (reference.kind === 'workspace_absolute' && reference.absolutePath) {
      const realReferencePath = await fs.realpath(reference.absolutePath);
      if (realReferencePath !== existingPath) {
        throw new Error('Source image belongs to a different workspace');
      }
    }

    await writeFile(reference.relativePath, buffer, workspaceOptions);
    return;
  }

  if (!reference.absolutePath || !(await canWriteStudioMediaReference(reference, scope))) {
    throw new Error('Source image is not writable in this workspace');
  }

  const workspaceRoot = getStudioWorkspaceVirtualRoot(scope.storage);
  const allowedRoot = reference.kind === 'user_upload'
    ? getUserUploadsStudioRefRoot()
    : reference.relativePath.startsWith(`${workspaceRoot}/`)
      ? getStudioWorkspaceRoot(scope.storage)
      : getStudioRoot();
  const targetPath = await requireExistingStudioTarget(reference.absolutePath, allowedRoot);
  await fs.writeFile(targetPath, buffer);
}

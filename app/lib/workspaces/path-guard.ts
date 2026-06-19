import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { WorkspaceContext, WorkspacePathResolution } from './types';

export interface WorkspacePathError extends Error {
  code: 'WORKSPACE_PATH_OUTSIDE_ROOT' | 'WORKSPACE_PARENT_OUTSIDE_ROOT';
  status: number;
}

function createWorkspacePathError(
  code: WorkspacePathError['code'],
  message = 'Invalid path: directory traversal attempt detected'
): WorkspacePathError {
  const error = new Error(message) as WorkspacePathError;
  error.code = code;
  error.status = 400;
  return error;
}

function normalizeRelativeWorkspacePath(userPath: string): string {
  const trimmed = userPath.trim();
  if (!trimmed) return '.';
  if (trimmed.includes('\0') || path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw createWorkspacePathError('WORKSPACE_PATH_OUTSIDE_ROOT');
  }

  const normalized = trimmed.replace(/\\/g, '/');
  return normalized || '.';
}

function assertWithinBase(candidatePath: string, basePath: string, code: WorkspacePathError['code']): void {
  if (candidatePath !== basePath && !candidatePath.startsWith(`${basePath}${path.sep}`)) {
    throw createWorkspacePathError(code);
  }
}

export function resolveWorkspacePath(
  workspace: WorkspaceContext,
  userPath: string
): WorkspacePathResolution {
  const normalizedBase = path.resolve(workspace.rootPath);
  const relativePath = normalizeRelativeWorkspacePath(userPath);
  const absolutePath = path.resolve(normalizedBase, relativePath);

  assertWithinBase(absolutePath, normalizedBase, 'WORKSPACE_PATH_OUTSIDE_ROOT');

  return {
    workspace,
    relativePath,
    absolutePath,
  };
}

export async function ensureWorkspaceRoot(workspace: WorkspaceContext): Promise<string> {
  const rootPath = resolveWorkspacePath(workspace, '.').absolutePath;
  await fs.mkdir(rootPath, { recursive: true });
  return fs.realpath(rootPath);
}

export async function resolveExistingWorkspacePath(
  workspace: WorkspaceContext,
  userPath: string
): Promise<string> {
  const candidatePath = resolveWorkspacePath(workspace, userPath).absolutePath;
  const realBase = await ensureWorkspaceRoot(workspace);
  const realPath = await fs.realpath(candidatePath);
  assertWithinBase(realPath, realBase, 'WORKSPACE_PATH_OUTSIDE_ROOT');
  return realPath;
}

export async function resolveWritableWorkspacePath(
  workspace: WorkspaceContext,
  userPath: string
): Promise<string> {
  const candidatePath = resolveWorkspacePath(workspace, userPath).absolutePath;
  const realBase = await ensureWorkspaceRoot(workspace);
  const parentPath = path.dirname(candidatePath);
  const realParent = await fs.realpath(parentPath);
  assertWithinBase(realParent, realBase, 'WORKSPACE_PARENT_OUTSIDE_ROOT');

  try {
    const realExistingPath = await fs.realpath(candidatePath);
    assertWithinBase(realExistingPath, realBase, 'WORKSPACE_PATH_OUTSIDE_ROOT');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
      throw error;
    }
  }

  return candidatePath;
}

export async function resolveDirectoryCreationPath(
  workspace: WorkspaceContext,
  userPath: string
): Promise<string> {
  const candidatePath = resolveWorkspacePath(workspace, userPath).absolutePath;
  const realBase = await ensureWorkspaceRoot(workspace);
  let current = path.dirname(candidatePath);

  while (current !== path.dirname(current)) {
    try {
      const realCurrent = await fs.realpath(current);
      assertWithinBase(realCurrent, realBase, 'WORKSPACE_PARENT_OUTSIDE_ROOT');
      return candidatePath;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        const next = path.dirname(current);
        if (next === current) break;
        current = next;
        continue;
      }
      throw error;
    }
  }

  throw createWorkspacePathError(
    'WORKSPACE_PARENT_OUTSIDE_ROOT',
    'Invalid path: parent directory is outside workspace'
  );
}

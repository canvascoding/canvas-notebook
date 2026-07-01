import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import type { FileNode } from './types';
import { isSameOrDescendantPath, joinWorkspacePath } from './path-utils';

export function normalizeWorkspaceSelectionPath(inputPath: string): string {
  const normalized = inputPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

  return normalized || '.';
}

function isSameOrDescendantWorkspacePath(candidatePath: string, parentPath: string): boolean {
  if (parentPath === '.') return true;
  return isSameOrDescendantPath(candidatePath, parentPath);
}

export function compactWorkspaceSelection(paths: Iterable<string>): string[] {
  const normalizedPaths: string[] = [];
  const seen = new Set<string>();

  for (const inputPath of paths) {
    if (typeof inputPath !== 'string') continue;
    const normalizedPath = normalizeWorkspaceSelectionPath(inputPath);
    if (seen.has(normalizedPath)) continue;
    seen.add(normalizedPath);
    normalizedPaths.push(normalizedPath);
  }

  return normalizedPaths.filter((candidatePath) => (
    !normalizedPaths.some((parentPath) => (
      parentPath !== candidatePath &&
      isSameOrDescendantWorkspacePath(candidatePath, parentPath)
    ))
  ));
}

export function getWorkspacePathName(path: string): string {
  return path.split('/').pop() || path;
}

export function resolveMoveDestination(targetDir: string, name: string): string {
  return joinWorkspacePath(targetDir, name);
}

export function isMoveIntoSelf(sourcePath: string, destinationPath: string): boolean {
  return destinationPath !== sourcePath && isSameOrDescendantPath(destinationPath, sourcePath);
}

export function isProtectedDirectoryNode(node: FileNode | null | undefined): boolean {
  return Boolean(node && node.type === 'directory' && isProtectedAppOutputFolder(node.path));
}

export function splitProtectedWorkspacePaths(paths: Iterable<string>) {
  const allowedPaths: string[] = [];
  const protectedPaths: string[] = [];

  for (const path of paths) {
    if (isProtectedAppOutputFolder(path)) {
      protectedPaths.push(path);
    } else {
      allowedPaths.push(path);
    }
  }

  return {
    allowedPaths,
    protectedPaths,
    skippedCount: protectedPaths.length,
    hasProtected: protectedPaths.length > 0,
  };
}

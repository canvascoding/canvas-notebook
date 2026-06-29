import path from 'node:path';

export function isPathInside(parentDir: string, childPath: string): boolean {
  const resolvedParent = path.resolve(/*turbopackIgnore: true*/ parentDir);
  const resolvedChild = path.resolve(/*turbopackIgnore: true*/ childPath);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`);
}

export function resolvePathInside(parentDir: string, ...segments: string[]): string | null {
  const resolvedParent = path.resolve(/*turbopackIgnore: true*/ parentDir);
  const resolvedChild = path.resolve(/*turbopackIgnore: true*/ resolvedParent, ...segments);
  return isPathInside(resolvedParent, resolvedChild) ? resolvedChild : null;
}

export function requirePathInside(parentDir: string, ...segments: string[]): string {
  const resolved = resolvePathInside(parentDir, ...segments);
  if (!resolved) {
    throw new Error('Path must stay inside the allowed directory.');
  }
  return resolved;
}

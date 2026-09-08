import { isSameOrDescendantPath } from './path-utils';
import { remapPath } from './path-mutation-state';

export function prunePathSet(paths: ReadonlySet<string>, removed: readonly string[]): Set<string> {
  return new Set([...paths].filter((path) => !removed.some((root) => isSameOrDescendantPath(path, root))));
}

export function prunePathRecord<T>(record: Readonly<Record<string, T>>, removed: readonly string[]): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([path]) => !removed.some((root) => isSameOrDescendantPath(path, root))));
}

/** Destination entries belong to the replaced identity and must not win collisions. */
export function remapPathRecord<T>(record: Readonly<Record<string, T>>, oldPath: string, newPath: string): Record<string, T> {
  const retained = prunePathRecord(record, [oldPath, newPath]);
  for (const [path, value] of Object.entries(record)) {
    if (isSameOrDescendantPath(path, oldPath)) retained[remapPath(path, oldPath, newPath)] = value;
  }
  return retained;
}

export function remapPathSet(paths: ReadonlySet<string>, oldPath: string, newPath: string): Set<string> {
  return new Set([...paths]
    .filter((path) => isSameOrDescendantPath(path, oldPath) || !isSameOrDescendantPath(path, newPath))
    .map((path) => remapPath(path, oldPath, newPath)));
}

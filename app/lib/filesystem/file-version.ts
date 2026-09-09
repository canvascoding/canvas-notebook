import type { Stats } from 'node:fs';

export function filesystemFileVersion(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

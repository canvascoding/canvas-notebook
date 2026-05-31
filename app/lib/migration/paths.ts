import 'server-only';

import path from 'path';
import { promises as fs } from 'fs';

export function getMigrationDataRoot(): string {
  const configuredDataRoot = process.env.DATA?.trim();
  if (configuredDataRoot) {
    return path.isAbsolute(configuredDataRoot)
      ? configuredDataRoot
      : path.resolve(process.cwd(), configuredDataRoot);
  }

  const configuredCanvasRoot = process.env.CANVAS_DATA_ROOT?.trim();
  if (configuredCanvasRoot) {
    return path.resolve(configuredCanvasRoot);
  }

  return path.resolve(process.cwd(), 'data');
}

export function getMigrationRoot(): string {
  return path.join(getMigrationDataRoot(), '.migration');
}

export function getMigrationExportsRoot(): string {
  return path.join(getMigrationRoot(), 'exports');
}

export function getMigrationUploadsRoot(): string {
  return path.join(getMigrationRoot(), 'uploads');
}

export function getPendingRestorePath(): string {
  return path.join(getMigrationRoot(), 'pending-restore.json');
}

export async function ensureMigrationDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700).catch(() => undefined);
}

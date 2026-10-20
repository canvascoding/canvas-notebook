import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RestoreJournal } from './restore-files';
import { resolveRestoreTarget, assertRestoreAncestors } from './restore-plan';
import { isPortableCredentialPath } from './secret-export-policy';

export function inDatabaseRestoreArea(journal: RestoreJournal, relative: string): boolean {
  return Boolean(journal.areas?.some(area => relative === area.target || relative.startsWith(area.target + '/')));
}

/** Database workspace identities replace the old registry, so their file roots must move together. */
export async function prepareDatabaseRestoreAreas(dataRoot: string, journal: RestoreJournal, directories: string[]): Promise<void> {
  journal.areas = [];
  for (const [index, target] of ['workspace', 'workspaces'].entries()) {
    await assertRestoreAncestors(dataRoot, target);
    const stat = await fs.lstat(resolveRestoreTarget(dataRoot, target)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (stat && !stat.isDirectory()) throw new Error('A workspace data root is not a safe directory.');
    const backup = `.restore-backups/migration-${journal.id}/areas/${index}`;
    await assertRestoreAncestors(dataRoot, backup);
    journal.areas.push({ target, backup, previous: Boolean(stat) });
  }
  for (const file of journal.files) if (inDatabaseRestoreArea(journal, file.target)) file.previous = false;
  journal.directories = [...new Set([...journal.directories, ...directories.filter(directory => inDatabaseRestoreArea(journal, directory))])]
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

async function preserveAreaCredentials(dataRoot: string, area: NonNullable<RestoreJournal['areas']>[number], relative = ''): Promise<void> {
  const source = resolveRestoreTarget(dataRoot, area.backup + (relative ? '/' + relative : ''));
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const next = relative ? relative + '/' + entry.name : entry.name;
    const target = resolveRestoreTarget(dataRoot, area.target + '/' + next);
    if (entry.isSymbolicLink()) continue;
    if (isPortableCredentialPath(target, dataRoot) && entry.isFile()) {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.copyFile(resolveRestoreTarget(dataRoot, area.backup + '/' + next), target);
    } else if (entry.isDirectory()) await preserveAreaCredentials(dataRoot, area, next);
  }
}

export async function publishDatabaseRestoreAreas(dataRoot: string, journal: RestoreJournal): Promise<void> {
  for (const area of journal.areas ?? []) {
    await assertRestoreAncestors(dataRoot, area.target); await assertRestoreAncestors(dataRoot, area.backup);
    const target = resolveRestoreTarget(dataRoot, area.target); const backup = resolveRestoreTarget(dataRoot, area.backup);
    await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
    if (area.previous) await fs.rename(target, backup);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    if (area.previous) await preserveAreaCredentials(dataRoot, area);
  }
}

export async function rollbackDatabaseRestoreAreas(dataRoot: string, journal: RestoreJournal): Promise<void> {
  for (const area of [...(journal.areas ?? [])].reverse()) {
    await assertRestoreAncestors(dataRoot, area.target); await assertRestoreAncestors(dataRoot, area.backup);
    const target = resolveRestoreTarget(dataRoot, area.target); const backup = resolveRestoreTarget(dataRoot, area.backup);
    const exists = await fs.lstat(backup).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false; throw error;
    });
    if (exists) {
      await fs.rm(target, { recursive: true, force: true });
      await fs.cp(backup, target, { recursive: true, force: true });
    } else if (!area.previous) await fs.rm(target, { recursive: true, force: true });
  }
}

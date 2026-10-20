import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getMigrationRoot } from './paths';
import { writeMigrationJson } from './restore-storage';
import { assertRestoreAncestors, resolveRestoreTarget } from './restore-plan';
import type { SecretDataStorageScope } from '@/app/lib/runtime-data-paths';

export type RestoreJournal = {
  version: 1; id: string; phase: 'applying' | 'files_applied';
  files: Array<{ target: string; staged: string; backup: string; previous: boolean }>;
  directories: string[];
  oauth: Array<{ target: string; backup: string }>;
  native: Array<{ workspaceId: string; paths: string[] }>;
  secretFiles?: Array<{ scope: SecretDataStorageScope; backup: string }>;
};

export function restoreJournalPath(): string { return path.join(getMigrationRoot(), 'restore-in-progress.json'); }
export function saveRestoreJournal(journal: RestoreJournal): Promise<void> { return writeMigrationJson(restoreJournalPath(), journal); }

export async function prepareRestoreFileJournal(input: {
  id: string; dataRoot: string; files: Array<{ target: string; staged: string; workspaceId: string | null; workspacePath: string | null }>;
  directories: string[];
}): Promise<RestoreJournal> {
  const journal: RestoreJournal = { version: 1, id: input.id, phase: 'applying', files: [], directories: [], oauth: [], native: [] };
  for (const relative of input.directories) {
    await assertRestoreAncestors(input.dataRoot, relative);
    const stat = await fs.lstat(resolveRestoreTarget(input.dataRoot, relative)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (stat && !stat.isDirectory()) throw new Error('A directory in the import conflicts with an existing file.');
    if (!stat) journal.directories.push(relative);
  }
  const native = new Map<string, string[]>();
  for (const [index, file] of input.files.entries()) {
    await assertRestoreAncestors(input.dataRoot, file.target);
    const stat = await fs.lstat(resolveRestoreTarget(input.dataRoot, file.target)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (stat && !stat.isFile()) throw new Error('An imported file conflicts with an existing directory or special file.');
    const backup = `.restore-backups/migration-${input.id}/files/${index}`;
    await assertRestoreAncestors(input.dataRoot, backup);
    journal.files.push({ target: file.target, staged: file.staged, backup, previous: Boolean(stat) });
    if (file.workspaceId && file.workspacePath) {
      const paths = native.get(file.workspaceId) ?? []; paths.push(file.workspacePath); native.set(file.workspaceId, paths);
    }
  }
  journal.native = [...native].map(([workspaceId, paths]) => ({ workspaceId, paths }));
  return journal;
}

export async function publishRestoreFiles(dataRoot: string, journal: RestoreJournal): Promise<void> {
  await saveRestoreJournal(journal);
  if (journal.native.length) {
    const { archiveFileCollaborationPaths } = await import('@/app/lib/files/collaboration-policy');
    const { resolveExcalidrawCheckpointWorkspace: resolve } = await import('@/app/lib/excalidraw-collaboration/checkpoint-worker');
    for (const group of journal.native) {
      const workspace = await resolve(group.workspaceId);
      if (!workspace) throw new Error('A mapped workspace is no longer available.');
      await archiveFileCollaborationPaths({ workspace, paths: group.paths.map(p => ({ path: p, trashEntryId: journal.id })) });
    }
  }
  for (const relative of journal.directories) {
    await assertRestoreAncestors(dataRoot, relative);
    await fs.mkdir(resolveRestoreTarget(dataRoot, relative), { mode: 0o700 });
  }
  for (const file of journal.files) {
    await assertRestoreAncestors(dataRoot, file.target);
    const destination = resolveRestoreTarget(dataRoot, file.target);
    const backup = resolveRestoreTarget(dataRoot, file.backup);
    await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
    if (file.previous) await fs.rename(destination, backup);
    await fs.rename(resolveRestoreTarget(dataRoot, file.staged), destination);
  }
}

/** OAuth material is moved to the private rollback area, never copied into the new runtime. */
export async function resetRestoreOAuthFiles(dataRoot: string, journal: RestoreJournal): Promise<void> {
  const roots = ['', 'system'];
  for (const scope of ['users', 'organizations']) {
    const names = await fs.readdir(path.join(dataRoot, scope), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    for (const entry of names) if (entry.isDirectory()) roots.push(`${scope}/${entry.name}`);
  }
  const oauthPaths = ['settings/mcp-oauth', 'settings/email-oauth', 'settings/oauth-states', 'settings/states',
    'settings/auth.json', 'settings/connections', 'canvas-agent/auth.json', 'pi-oauth-states',
    'pi/auth.json', 'mcp/connections', 'mcp/states', 'mcp/oauth-states'];
  for (const root of roots) for (const relative of oauthPaths) {
    const target = root ? root + '/' + relative : relative;
    await assertRestoreAncestors(dataRoot, target);
    const exists = await fs.lstat(resolveRestoreTarget(dataRoot, target)).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false; throw error;
    });
    if (!exists) continue;
    const backup = `.restore-backups/migration-${journal.id}/oauth/${target}`;
    journal.oauth.push({ target, backup }); await saveRestoreJournal(journal);
    await fs.mkdir(path.dirname(resolveRestoreTarget(dataRoot, backup)), { recursive: true, mode: 0o700 });
    await fs.rename(resolveRestoreTarget(dataRoot, target), resolveRestoreTarget(dataRoot, backup));
  }
}

/** Interrupted publication is compensated before any HTTP listener is opened. */
export async function rollbackRestoreFiles(dataRoot: string, journal: RestoreJournal): Promise<void> {
  if (journal.version !== 1 || !/^[a-f0-9-]{36}$/iu.test(journal.id)) throw new Error('Invalid restore recovery journal.');
  if (journal.secretFiles?.length) {
    const { restoreMigrationSecrets } = await import('./restore-secrets');
    await restoreMigrationSecrets(dataRoot, journal);
  }
  for (const file of [...journal.oauth].reverse()) {
    await assertRestoreAncestors(dataRoot, file.target);
    await assertRestoreAncestors(dataRoot, file.backup);
    const backup = resolveRestoreTarget(dataRoot, file.backup);
    if (await fs.lstat(backup).then(() => true, () => false)) {
      await fs.mkdir(path.dirname(resolveRestoreTarget(dataRoot, file.target)), { recursive: true, mode: 0o700 });
      await fs.cp(backup, resolveRestoreTarget(dataRoot, file.target), { recursive: true, force: true });
    }
  }
  for (const file of [...journal.files].reverse()) {
    await assertRestoreAncestors(dataRoot, file.target);
    await assertRestoreAncestors(dataRoot, file.backup);
    const target = resolveRestoreTarget(dataRoot, file.target);
    const backup = resolveRestoreTarget(dataRoot, file.backup);
    const staged = resolveRestoreTarget(dataRoot, file.staged);
    const hasBackup = await fs.lstat(backup).then(() => true, () => false);
    const hasStaged = await fs.lstat(staged).then(() => true, () => false);
    if (hasBackup) {
      // Keep the private backup until recovery is durably complete. Repeating
      // rollback after another interrupted boot must restore the same bytes.
      const temporary = target + '.restore-' + journal.id;
      await fs.copyFile(backup, temporary);
      await fs.rename(temporary, target);
    }
    else if (!file.previous && !hasStaged) await fs.rm(target, { force: true });
    else if (file.previous && !hasStaged) throw new Error('The previous target file cannot be recovered from its restore backup.');
  }
  if (journal.native.length) {
    const { restoreFileCollaborationPath } = await import('@/app/lib/files/collaboration-policy');
    const { resolveExcalidrawCheckpointWorkspace: resolve } = await import('@/app/lib/excalidraw-collaboration/checkpoint-worker');
    for (const group of journal.native) {
      const workspace = await resolve(group.workspaceId);
      if (!workspace) throw new Error('The previous workspace lifecycle cannot be recovered.');
      for (const p of group.paths) await restoreFileCollaborationPath({ workspace, path: p, trashEntryId: journal.id });
    }
  }
  for (const directory of [...journal.directories].reverse()) {
    await fs.rmdir(resolveRestoreTarget(dataRoot, directory)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
    });
  }
}

import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveWorkspaceDataRoot } from '@/app/lib/workspaces/context';
import {
  assertWorkspacePathHasNoAliases,
  resolveExistingWorkspacePath,
  resolveWritableWorkspacePath,
  resolveWorkspacePath,
} from '@/app/lib/workspaces/path-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const BACKUP_DIRECTORY = '.workspace-operation-backups';
const ID_PATTERN = /^opb-[a-f0-9]{64}$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MANIFEST_LIMIT = 8 * 1024 * 1024;

export type WorkspaceOperationBackupEntry =
  | { type: 'directory'; path: string }
  | { type: 'file'; path: string; sizeBytes: number; sha256: string };

export type WorkspaceOperationBackup = {
  version: 1;
  backupId: string;
  operationId: string;
  workspaceId: string;
  workspaceType: WorkspaceContext['workspaceType'];
  organizationId: string | null;
  originalPath: string;
  itemType: 'file' | 'directory';
  capturedAt: string;
  retention: 'until_manual_cleanup';
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
  contentSha256: string;
  entries: WorkspaceOperationBackupEntry[];
};

export type WorkspaceOperationBackupListEntry =
  | { status: 'manifest_valid'; backupId: string; operationId: string; originalPath: string;
      itemType: WorkspaceOperationBackup['itemType']; capturedAt: string;
      retention: WorkspaceOperationBackup['retention']; sizeBytes: number;
      fileCount: number; directoryCount: number; contentSha256: string }
  | { status: 'unavailable'; backupId: string };

export class WorkspaceOperationBackupError extends Error {
  readonly status = 409;
  constructor(readonly code: 'INVALID_BACKUP' | 'CORRUPT_BACKUP' | 'UNSAFE_PATH' | 'RESTORE_COLLISION' | 'SOURCE_CHANGED', message: string) {
    super(message);
    this.name = 'WorkspaceOperationBackupError';
  }
}

function fail(code: WorkspaceOperationBackupError['code'], message: string): never {
  throw new WorkspaceOperationBackupError(code, message);
}

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function backupIdFor(workspace: WorkspaceContext, operationId: string, originalPath: string): string {
  if (!OPERATION_ID_PATTERN.test(operationId)) fail('INVALID_BACKUP', 'Invalid file operation ID.');
  return `opb-${digest(JSON.stringify([
    workspace.workspaceType, workspace.organizationId ?? null, workspace.workspaceId, operationId, originalPath,
  ]))}`;
}

function validRelativePath(value: unknown, allowRoot = false): value is string {
  return typeof value === 'string' && value.length <= 2048
    && (allowRoot && value === '.' || value.length > 0 && value !== '.')
    && !value.includes('\\') && !value.includes('\0')
    && !value.startsWith('/') && (value === '.' || value.split('/').every((segment) => segment && segment !== '.' && segment !== '..'));
}

function contentHash(entries: WorkspaceOperationBackupEntry[]): string {
  return digest(JSON.stringify(entries));
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) {
    fail('UNSAFE_PATH', 'File operation backup storage must be a private directory.');
  }
}

async function storageRoot(workspace: WorkspaceContext): Promise<string> {
  const dataRoot = await fs.realpath(resolveWorkspaceDataRoot());
  const workspaceRoot = await fs.realpath(workspace.rootPath);
  const root = path.join(dataRoot, BACKUP_DIRECTORY);
  if (root === workspaceRoot || root.startsWith(`${workspaceRoot}${path.sep}`)) {
    fail('UNSAFE_PATH', 'Backup storage cannot be inside the workspace.');
  }
  await ensurePrivateDirectory(root);
  const scope = path.join(root, digest(JSON.stringify([
    workspace.workspaceType, workspace.organizationId ?? null, workspace.workspaceId,
  ])));
  await ensurePrivateDirectory(scope);
  return scope;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writePrivateFile(filename: string, content: string): Promise<void> {
  const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
}

async function copyAndHash(source: string, target: string): Promise<{ sizeBytes: number; sha256: string }> {
  const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const before = await input.stat();
    if (!before.isFile()) fail('UNSAFE_PATH', 'Only regular files can be backed up.');
    output = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash('sha256');
    let count = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const read = await input.read(buffer, 0, buffer.length, count);
      if (!read.bytesRead) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      let written = 0;
      while (written < read.bytesRead) {
        const result = await output.write(buffer, written, read.bytesRead - written, count + written);
        if (!result.bytesWritten) fail('SOURCE_CHANGED', 'Could not write operation backup bytes.');
        written += result.bytesWritten;
      }
      count += read.bytesRead;
    }
    await output.sync();
    const after = await input.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || count !== before.size) {
      fail('SOURCE_CHANGED', 'A file changed while its operation backup was captured.');
    }
    return { sizeBytes: count, sha256: hash.digest('hex') };
  } finally {
    await output?.close().catch(() => undefined);
    await input.close().catch(() => undefined);
  }
}

async function hashFile(filename: string): Promise<{ sizeBytes: number; sha256: string }> {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) {
      fail('CORRUPT_BACKUP', 'Backup contains an unsafe file.');
    }
    const hash = createHash('sha256');
    let count = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, count);
      if (!read.bytesRead) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      count += read.bytesRead;
    }
    if (count !== stat.size) fail('CORRUPT_BACKUP', 'Backup file changed while being verified.');
    return { sizeBytes: count, sha256: hash.digest('hex') };
  } finally { await handle.close().catch(() => undefined); }
}

async function captureTree(source: string, destination: string, relative: string, workspaceRoot: string, entries: WorkspaceOperationBackupEntry[]): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Symbolic links cannot be backed up as file operation snapshots.');
  const realSource = await fs.realpath(source);
  if (realSource !== workspaceRoot && !realSource.startsWith(`${workspaceRoot}${path.sep}`)) {
    fail('UNSAFE_PATH', 'Backup source resolves outside its workspace.');
  }
  if (stat.isDirectory()) {
    entries.push({ type: 'directory', path: relative });
    await ensurePrivateDirectory(destination);
    const children = (await fs.readdir(source)).sort();
    for (const child of children) {
      await captureTree(path.join(source, child), path.join(destination, child), relative === '.' ? child : `${relative}/${child}`, workspaceRoot, entries);
    }
    const after = await fs.lstat(source);
    if (!after.isDirectory() || after.dev !== stat.dev || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs) {
      fail('SOURCE_CHANGED', 'A directory changed while its operation backup was captured.');
    }
    await syncDirectory(destination);
    return;
  }
  if (!stat.isFile()) fail('UNSAFE_PATH', 'Special files cannot be backed up.');
  const copied = await copyAndHash(source, destination);
  entries.push({ type: 'file', path: relative, ...copied });
}

function validateManifest(value: unknown, workspace: WorkspaceContext, backupId: string): WorkspaceOperationBackup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CORRUPT_BACKUP', 'Invalid backup manifest.');
  const backup = value as WorkspaceOperationBackup;
  if (backup.version !== 1 || backup.backupId !== backupId
    || backup.workspaceId !== workspace.workspaceId || backup.workspaceType !== workspace.workspaceType
    || backup.organizationId !== (workspace.organizationId ?? null)
    || !OPERATION_ID_PATTERN.test(backup.operationId)
    || !validRelativePath(backup.originalPath)
    || backupIdFor(workspace, backup.operationId, backup.originalPath) !== backupId
    || !['file', 'directory'].includes(backup.itemType)
    || backup.retention !== 'until_manual_cleanup'
    || !Number.isSafeInteger(backup.sizeBytes) || backup.sizeBytes < 0
    || !Number.isSafeInteger(backup.fileCount) || backup.fileCount < 0
    || !Number.isSafeInteger(backup.directoryCount) || backup.directoryCount < 0
    || !HASH_PATTERN.test(backup.contentSha256)
    || !Number.isFinite(Date.parse(backup.capturedAt)) || !Array.isArray(backup.entries)) {
    fail('CORRUPT_BACKUP', 'Backup manifest identity or metadata is invalid.');
  }
  const seen = new Set<string>();
  const seenDirectories = new Set<string>();
  let total = 0;
  let files = 0;
  let directories = 0;
  for (const entry of backup.entries) {
    if (!entry || !validRelativePath(entry.path, true) || seen.has(entry.path)
      || !['file', 'directory'].includes(entry.type)) fail('CORRUPT_BACKUP', 'Invalid backup entry.');
    if (entry.path !== '.' && !seenDirectories.has(path.posix.dirname(entry.path))) {
      fail('CORRUPT_BACKUP', 'Backup entry lacks an earlier parent directory.');
    }
    seen.add(entry.path);
    if (entry.type === 'file') {
      files += 1;
      if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !HASH_PATTERN.test(entry.sha256)) {
        fail('CORRUPT_BACKUP', 'Invalid backup file metadata.');
      }
      total += entry.sizeBytes;
    } else { directories += 1; seenDirectories.add(entry.path); }
  }
  if (total !== backup.sizeBytes || files !== backup.fileCount || directories !== backup.directoryCount
    || contentHash(backup.entries) !== backup.contentSha256 || !seen.has('.')
    || backup.entries[0]?.path !== '.'
    || backup.entries[0]?.type !== backup.itemType) {
    fail('CORRUPT_BACKUP', 'Backup tree is incomplete.');
  }
  return backup;
}

async function loadBackup(workspace: WorkspaceContext, backupId: string): Promise<{ backup: WorkspaceOperationBackup; folder: string }> {
  if (!ID_PATTERN.test(backupId)) fail('INVALID_BACKUP', 'Invalid file operation backup ID.');
  const folder = path.join(await storageRoot(workspace), backupId);
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) {
    fail('CORRUPT_BACKUP', 'Backup directory is unsafe.');
  }
  const manifestPath = path.join(folder, 'manifest.json');
  const manifestStat = await fs.lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.nlink !== 1 || (manifestStat.mode & 0o077) !== 0
    || manifestStat.size > MANIFEST_LIMIT || manifestStat.uid !== process.geteuid?.()) {
    fail('CORRUPT_BACKUP', 'Backup manifest is unsafe.');
  }
  const raw = await fs.readFile(manifestPath, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return fail('CORRUPT_BACKUP', 'Backup manifest is not valid JSON.'); }
  return { backup: validateManifest(parsed, workspace, backupId), folder };
}

async function verifyPayload(folder: string, backup: WorkspaceOperationBackup): Promise<void> {
  const payload = path.join(folder, 'payload');
  for (const entry of backup.entries) {
    const filename = entry.path === '.' ? payload : path.join(payload, ...entry.path.split('/'));
    const stat = await fs.lstat(filename);
    if (entry.type === 'directory') {
      if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) fail('CORRUPT_BACKUP', 'Backup directory is unsafe.');
    } else {
      const actual = await hashFile(filename);
      if (actual.sizeBytes !== entry.sizeBytes || actual.sha256 !== entry.sha256) {
        fail('CORRUPT_BACKUP', `Backup file failed SHA-256 verification: ${entry.path}`);
      }
    }
  }
}

/** Caller owns the workspace mutation lock. Reusing operationId + path returns the original snapshot. */
export async function captureWorkspaceOperationBackup(input: {
  workspace: WorkspaceContext;
  path: string;
  operationId: string;
}): Promise<WorkspaceOperationBackup> {
  const originalPath = resolveWorkspacePath(input.workspace, input.path).relativePath;
  if (originalPath === '.') fail('UNSAFE_PATH', 'Workspace root cannot be backed up as one file operation.');
  const backupId = backupIdFor(input.workspace, input.operationId, originalPath);
  const scope = await storageRoot(input.workspace);
  try {
    const existing = await loadBackup(input.workspace, backupId);
    await verifyPayload(existing.folder, existing.backup);
    return existing.backup;
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  await assertWorkspacePathHasNoAliases(input.workspace, originalPath, { readOnly: true });
  const source = await resolveExistingWorkspacePath(input.workspace, originalPath);
  const workspaceRoot = await fs.realpath(input.workspace.rootPath);
  const temporary = path.join(scope, `${backupId}.tmp-${randomUUID()}`);
  await ensurePrivateDirectory(temporary);
  try {
    const entries: WorkspaceOperationBackupEntry[] = [];
    await captureTree(source, path.join(temporary, 'payload'), '.', workspaceRoot, entries);
    const itemType = entries[0]?.type;
    if (!itemType) fail('SOURCE_CHANGED', 'Source disappeared during backup capture.');
    const backup: WorkspaceOperationBackup = {
      version: 1, backupId, operationId: input.operationId,
      workspaceId: input.workspace.workspaceId, workspaceType: input.workspace.workspaceType,
      organizationId: input.workspace.organizationId ?? null, originalPath, itemType,
      capturedAt: new Date().toISOString(),
      retention: 'until_manual_cleanup',
      sizeBytes: entries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.sizeBytes : 0), 0), entries,
      fileCount: entries.filter((entry) => entry.type === 'file').length,
      directoryCount: entries.filter((entry) => entry.type === 'directory').length,
      contentSha256: contentHash(entries),
    };
    await verifyPayload(temporary, backup);
    const manifest = `${JSON.stringify(backup)}\n`;
    if (Buffer.byteLength(manifest) > MANIFEST_LIMIT) fail('INVALID_BACKUP', 'File operation backup contains too many entries.');
    await writePrivateFile(path.join(temporary, 'manifest.json'), manifest);
    await syncDirectory(temporary);
    try { await fs.rename(temporary, path.join(scope, backupId)); }
    catch (error) {
      if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY')) throw error;
      const existing = await loadBackup(input.workspace, backupId);
      await verifyPayload(existing.folder, existing.backup);
      return existing.backup;
    }
    await syncDirectory(scope);
    return backup;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export async function getWorkspaceOperationBackup(input: {
  workspace: WorkspaceContext;
  backupId: string;
}): Promise<WorkspaceOperationBackup> {
  return (await loadBackup(input.workspace, input.backupId)).backup;
}

/** Workspace-scoped, bounded metadata listing. Payload integrity is verified at restore time. */
export async function listWorkspaceOperationBackups(input: {
  workspace: WorkspaceContext;
  limit?: number;
  cursor?: string;
}): Promise<{ backups: WorkspaceOperationBackupListEntry[]; nextCursor: string | null }> {
  if (input.cursor !== undefined && !ID_PATTERN.test(input.cursor)) {
    fail('INVALID_BACKUP', 'Invalid file operation backup cursor.');
  }
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail('INVALID_BACKUP', 'Backup list limit must be between 1 and 100.');
  }
  const scope = await storageRoot(input.workspace);
  const names = (await fs.readdir(scope))
    .filter((name) => ID_PATTERN.test(name) && (!input.cursor || name > input.cursor))
    .sort();
  const selected = names.slice(0, limit);
  const backups: WorkspaceOperationBackupListEntry[] = [];
  for (const backupId of selected) {
    try {
      const { backup } = await loadBackup(input.workspace, backupId);
      backups.push({ status: 'manifest_valid', backupId, operationId: backup.operationId,
        originalPath: backup.originalPath, itemType: backup.itemType, capturedAt: backup.capturedAt,
        retention: backup.retention, sizeBytes: backup.sizeBytes, fileCount: backup.fileCount,
        directoryCount: backup.directoryCount, contentSha256: backup.contentSha256 });
    } catch {
      // Keep a corrupt snapshot visible for support instead of silently omitting it.
      backups.push({ status: 'unavailable', backupId });
    }
  }
  return { backups, nextCursor: names.length > selected.length ? selected.at(-1) ?? null : null };
}

/** Verifies all stored bytes before restoring; never overwrites an existing target. Caller owns the mutation lock. */
export async function restoreWorkspaceOperationBackup(input: {
  workspace: WorkspaceContext;
  backupId: string;
  targetPath?: string;
}): Promise<{ backup: WorkspaceOperationBackup; restoredPath: string }> {
  const { backup, folder } = await loadBackup(input.workspace, input.backupId);
  const restoredPath = resolveWorkspacePath(input.workspace, input.targetPath ?? backup.originalPath).relativePath;
  if (restoredPath === '.') fail('UNSAFE_PATH', 'Workspace root cannot be a restore target.');
  await verifyPayload(folder, backup);
  await assertWorkspacePathHasNoAliases(input.workspace, restoredPath);
  const destination = await resolveWritableWorkspacePath(input.workspace, restoredPath);
  try { await fs.lstat(destination); fail('RESTORE_COLLISION', 'Restore target already exists.'); }
  catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  const payload = path.join(folder, 'payload');
  if (backup.itemType === 'file') {
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.restore-${randomUUID()}`);
    try {
      const copied = await copyAndHash(payload, temporary);
      const expected = backup.entries[0] as Extract<WorkspaceOperationBackupEntry, { type: 'file' }>;
      if (copied.sizeBytes !== expected.sizeBytes || copied.sha256 !== expected.sha256) {
        fail('CORRUPT_BACKUP', 'Backup changed during restore.');
      }
      try { await fs.link(temporary, destination); }
      catch (error) { if (hasCode(error, 'EEXIST')) fail('RESTORE_COLLISION', 'Restore target already exists.'); throw error; }
    } finally { await fs.rm(temporary, { force: true }); }
    const verified = await hashFile(destination);
    const expected = backup.entries[0] as Extract<WorkspaceOperationBackupEntry, { type: 'file' }>;
    if (verified.sizeBytes !== expected.sizeBytes || verified.sha256 !== expected.sha256) {
      fail('CORRUPT_BACKUP', 'Restored file failed SHA-256 verification.');
    }
    await syncDirectory(path.dirname(destination));
  } else {
    // mkdir is an exclusive destination claim. A crash leaves a visible partial tree,
    // which a retry refuses to overwrite; callers can inspect or trash that tree.
    try { await fs.mkdir(destination, { mode: 0o700 }); }
    catch (error) { if (hasCode(error, 'EEXIST')) fail('RESTORE_COLLISION', 'Restore target already exists.'); throw error; }
    for (const entry of backup.entries) {
      if (entry.path === '.') continue;
      const target = path.join(destination, ...entry.path.split('/'));
      if (entry.type === 'directory') await fs.mkdir(target, { mode: 0o700 });
      else {
        const copied = await copyAndHash(path.join(payload, ...entry.path.split('/')), target);
        if (copied.sizeBytes !== entry.sizeBytes || copied.sha256 !== entry.sha256) {
          fail('CORRUPT_BACKUP', `Backup changed during restore: ${entry.path}`);
        }
      }
    }
    for (const entry of backup.entries) {
      if (entry.type !== 'file') continue;
      const verified = await hashFile(path.join(destination, ...(entry.path === '.' ? [] : entry.path.split('/'))));
      if (verified.sizeBytes !== entry.sizeBytes || verified.sha256 !== entry.sha256) {
        fail('CORRUPT_BACKUP', `Restored file failed SHA-256 verification: ${entry.path}`);
      }
    }
    await syncDirectory(destination);
  }
  return { backup, restoredPath };
}

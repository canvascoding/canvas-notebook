import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createFullBackupJob, getFullBackupJob, inspectFullBackupArchive,
  promoteFullBackupJobToLatest, pruneFullBackupJobArtifacts,
} from '../app/lib/backups/full-backup-service';
import type { FullBackupJob } from '../app/lib/backups/types';

const execFileAsync = promisify(execFile);

async function completedJob(checkLock = false): Promise<FullBackupJob> {
  let queued: FullBackupJob | null = null;
  for (let attempt = 0; attempt < 40 && !queued; attempt += 1) {
    try { queued = await createFullBackupJob(); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('already running')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!queued) throw new Error('Previous isolated backup did not release its lock.');
  if (checkLock) {
    await assert.rejects(() => createFullBackupJob(), /already running/i);
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await getFullBackupJob(queued.id);
    if (job?.status === 'completed') return job;
    if (job?.status === 'failed') throw new Error(job.error || 'Full backup failed');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for isolated full backup test.');
}

async function sha256File(filename: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filename)).digest('hex');
}

async function zipEntry(filename: string, entry: string): Promise<string> {
  const { stdout } = await execFileAsync('unzip', ['-p', filename, entry], { encoding: 'utf8' });
  return stdout;
}

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-full-backup-test-'));
  const previous = {
    DATA: process.env.DATA, CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT,
    DATABASE_URL: process.env.DATABASE_URL, CANVAS_PG_DUMP_BIN: process.env.CANVAS_PG_DUMP_BIN,
    CANVAS_BACKUP_TARGET_DIR: process.env.CANVAS_BACKUP_TARGET_DIR,
  };
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.DATABASE_URL = 'postgres://backup_test:password@127.0.0.1:5432/isolated_test';
  delete process.env.CANVAS_BACKUP_TARGET_DIR;
  try {
    const fakePgDump = path.join(dataRoot, 'fake-pg-dump');
    await fs.writeFile(fakePgDump, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('pg_dump (PostgreSQL) 18.4'); process.exit(0); }
const fileIndex = args.indexOf('--file');
if (fileIndex < 0 || !args[fileIndex + 1]) process.exit(2);
fs.writeFileSync(args[fileIndex + 1], 'isolated fake PostgreSQL dump\\n');
`);
    await fs.chmod(fakePgDump, 0o700);
    process.env.CANVAS_PG_DUMP_BIN = fakePgDump;
    await fs.mkdir(path.join(dataRoot, 'workspaces', 'test'), { recursive: true });
    await fs.writeFile(path.join(dataRoot, 'workspaces', 'test', 'note.md'), 'before\n');
    for (const userFolder of ['cache', 'temp', 'logs', '.git', 'node_modules', '.next']) {
      const folder = path.join(dataRoot, 'workspaces', 'test', userFolder);
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, 'report.md'), `${userFolder} user content\n`);
    }
    const legacyGit = path.join(dataRoot, 'workspace', '.git');
    await fs.mkdir(legacyGit, { recursive: true });
    await fs.writeFile(path.join(legacyGit, 'config'), 'legacy workspace history\n');
    await fs.mkdir(path.join(dataRoot, 'cache'));
    await fs.writeFile(path.join(dataRoot, 'cache', 'runtime.tmp'), 'rebuildable');
    await fs.mkdir(path.join(dataRoot, 'system', 'backups', 'ignore'), { recursive: true });
    await fs.writeFile(path.join(dataRoot, 'system', 'backups', 'ignore', 'old.zip'), 'not nested');

    const first = await completedJob(true);
    assert(first.filePath);
    const inspected = await inspectFullBackupArchive(first.filePath);
    assert.equal(inspected.canRestore, true, 'manifest/database-dump preflight should pass');
    assert.equal(inspected.manifest?.consistency.files, 'online_best_effort');
    assert.equal(inspected.manifest?.database.backupKind, 'postgres_dump');
    assert(inspected.manifest?.files.some((entry) => entry.archivePath === 'data/workspaces/test/note.md'));
    for (const userFolder of ['cache', 'temp', 'logs', '.git', 'node_modules', '.next']) {
      assert(inspected.manifest?.files.some((entry) =>
        entry.archivePath === `data/workspaces/test/${userFolder}/report.md`));
    }
    assert(inspected.manifest?.files.some((entry) => entry.archivePath === 'data/workspace/.git/config'));
    assert(!inspected.manifest?.files.some((entry) => entry.archivePath === 'data/cache/runtime.tmp'));
    assert(!inspected.manifest?.files.some((entry) => entry.archivePath.endsWith('old.zip')));
    assert.equal(await zipEntry(first.filePath, 'data/workspaces/test/note.md'), 'before\n');
    const firstLatest = await promoteFullBackupJobToLatest(first);
    const originalLatestSha256 = await sha256File(firstLatest.filePath);

    await fs.writeFile(path.join(dataRoot, 'workspaces', 'test', 'note.md'), 'after\n');
    const second = await completedJob();
    assert(second.archiveSha256);
    const actualArchiveSha256 = second.archiveSha256;
    second.archiveSha256 = '0'.repeat(64);
    await assert.rejects(() => promoteFullBackupJobToLatest(second), /checksum/i);
    assert.equal(await sha256File(firstLatest.filePath), originalLatestSha256,
      'a failed promotion must retain the previous latest archive');
    second.archiveSha256 = actualArchiveSha256;
    const secondLatest = await promoteFullBackupJobToLatest(second);
    assert.equal(await zipEntry(secondLatest.filePath, 'data/workspaces/test/note.md'), 'after\n');
    const metadata = JSON.parse(await fs.readFile(secondLatest.metadataPath, 'utf8')) as { backupId: string };
    assert.equal(metadata.backupId, second.id);
    const pruned = await pruneFullBackupJobArtifacts();
    assert.deepEqual(pruned.sort(), [first.id, second.id].sort());
    assert.equal((await fs.stat(secondLatest.filePath)).isFile(), true);

    console.log('full backup service: fake pg_dump, lock, data archive, inspect, latest, failed promotion, prune OK; no restore exercised');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

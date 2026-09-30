import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const MARKER_POLL_MS = 20;
const CHILD_TIMEOUT_MS = 30_000;

function spawnWorker(mode: 'writer' | 'contender', fixtureRoot: string) {
  const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
  const scriptPath = path.resolve('scripts/full-backup-lock-atomic-test.ts');
  const child = spawn(process.execPath, [tsxCli, '--conditions', 'react-server', scriptPath, mode], {
    cwd: process.cwd(),
    env: { ...process.env, FULL_BACKUP_LOCK_FIXTURE_ROOT: fixtureRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  return {
    child,
    get output() { return output; },
    wait: async () => {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Worker timed out: ${output}`));
        }, CHILD_TIMEOUT_MS);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      });
      assert.equal(result.code, 0, `worker failed: ${output}`);
      return output;
    },
  };
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < CHILD_TIMEOUT_MS / MARKER_POLL_MS; attempt += 1) {
    if (await fs.stat(filePath).then(() => true, () => false)) return;
    await delay(MARKER_POLL_MS);
  }
  throw new Error('Timed out waiting for lock publication barrier.');
}

async function runWorker(mode: 'writer' | 'contender'): Promise<void> {
  const fixtureRoot = process.env.FULL_BACKUP_LOCK_FIXTURE_ROOT;
  if (!fixtureRoot) throw new Error('Worker fixture root is missing.');
  process.env.DATA = path.join(fixtureRoot, 'data');
  process.env.CANVAS_DATA_ROOT = process.env.DATA;
  process.env.DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1:5432/backup';
  process.env.CANVAS_PG_DUMP_BIN = path.join(fixtureRoot, 'fake-pg-dump');
  delete process.env.CANVAS_SECRETS_ENV_PATH;

  if (mode === 'writer') {
    const crypto = await import('node:crypto');
    const { resolveSystemBackupsDir } = await import('../app/lib/runtime-data-paths');
    const { withFileMutationLock } = await import('../app/lib/secrets/file-mutation-lock');
    const lockPath = path.join(resolveSystemBackupsDir(), '.full-backup.lock');
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await withFileMutationLock(lockPath, async () => {
      await fs.writeFile(path.join(fixtureRoot, 'owner-entered'), 'ready');
      await waitForFile(path.join(fixtureRoot, 'owner-publish'));
      const lock = { backupId: crypto.randomUUID(), createdAt: new Date().toISOString(), pid: process.pid };
      const temporaryPath = `${lockPath}.${lock.backupId}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(lock)}\n`, { mode: 0o600, flag: 'wx' });
      await fs.link(temporaryPath, lockPath);
      await fs.unlink(temporaryPath);
      await fs.writeFile(path.join(fixtureRoot, 'owner-published'), 'ready');
    });
    await waitForFile(path.join(fixtureRoot, 'owner-release'));
    console.log('OWNER: released');
    return;
  }

  const backup = await import('../app/lib/backups/full-backup-service');
  if (mode === 'contender') {
    try {
      await backup.createFullBackupJob();
      throw new Error('A second process acquired a backup while publication was in progress.');
    } catch (error) {
      if (!(error instanceof Error) || !/already running/i.test(error.message)) throw error;
      console.log('RESULT: rejected-active-lock');
    }
    return;
  }

  const queued = await backup.createFullBackupJob();
  console.log(`ACQUIRED:${queued.id}`);
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const job = await backup.getFullBackupJob(queued.id);
    if (job?.status === 'completed') {
      console.log(`COMPLETE:${job.filePath}`);
      return;
    }
    if (job?.status === 'failed') throw new Error(job.error || 'Backup writer failed.');
    await delay(25);
  }
  throw new Error('Timed out waiting for writer backup completion.');
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'writer' || mode === 'contender') {
    await runWorker(mode);
    return;
  }

  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-backup-lock-test-'));
  const beforeEnv = { ...process.env };
  try {
    const dataRoot = path.join(fixtureRoot, 'data');
    process.env.DATA = dataRoot;
    process.env.CANVAS_DATA_ROOT = dataRoot;
    process.env.DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1:5432/backup';
    process.env.CANVAS_PG_DUMP_BIN = path.join(fixtureRoot, 'fake-pg-dump');
    delete process.env.CANVAS_SECRETS_ENV_PATH;
    await fs.mkdir(dataRoot, { recursive: true });

    const fakePgDump = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('pg_dump (PostgreSQL) 18.4'); process.exit(0); }
write();
function write() { fs.writeFileSync(args[args.indexOf('--file') + 1], 'fixture dump'); }
`;
    await fs.writeFile(process.env.CANVAS_PG_DUMP_BIN, fakePgDump, { mode: 0o700 });
    await fs.chmod(process.env.CANVAS_PG_DUMP_BIN, 0o700);
    const credentials = [
      'system/secrets/Canvas-Secrets.env',
      'users/alice/secrets/Canvas-Secrets.env',
      'organizations/org-a/secrets/Canvas-Secrets.env',
    ];
    for (const relativePath of credentials) {
      const absolutePath = path.join(dataRoot, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, 'FIXTURE_SECRET=synthetic\n');
      await fs.chmod(absolutePath, 0o644);
    }

    const ownerPublish = path.join(fixtureRoot, 'owner-publish');
    const ownerRelease = path.join(fixtureRoot, 'owner-release');
    const writer = spawnWorker('writer', fixtureRoot);
    await waitForFile(path.join(fixtureRoot, 'owner-entered'));

    const contender = spawnWorker('contender', fixtureRoot);
    await delay(250);
    assert.equal(contender.output.includes('RESULT:'), false,
      'a contender must wait while the writer holds the stable sidecar lock');
    await fs.writeFile(ownerPublish, 'continue');
    await waitForFile(path.join(fixtureRoot, 'owner-published'));
    assert.equal(contender.output.includes('RESULT:'), false,
      'a contender must not inspect or remove the published owner record before the sidecar is released');
    const contenderOutput = await contender.wait();
    assert.match(contenderOutput, /RESULT: rejected-active-lock/);
    await fs.writeFile(ownerRelease, 'continue');
    assert.match(await writer.wait(), /OWNER: released/);
    await fs.unlink(path.join(dataRoot, 'system', 'backups', '.full-backup.lock'));

    const backup = await import('../app/lib/backups/full-backup-service');
    const completed = await backup.createFullBackupJob();
    let archivePath: string | null = null;
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      const job = await backup.getFullBackupJob(completed.id);
      if (job?.status === 'completed') { archivePath = job.filePath || null; break; }
      if (job?.status === 'failed') throw new Error(job.error || 'Archive fixture backup failed.');
      await delay(25);
    }
    assert.ok(archivePath, 'fixture backup should finish with an archive');

    const extracted = path.join(fixtureRoot, 'extracted');
    await fs.mkdir(extracted);
    const unzip = spawn('unzip', ['-q', archivePath, ...credentials.map((entry) => `data/${entry}`), '-d', extracted]);
    const unzipExit = await new Promise<number>((resolve, reject) => {
      unzip.once('error', reject);
      unzip.once('exit', (code) => resolve(code ?? -1));
    });
    assert.equal(unzipExit, 0, 'fixture archive should extract canonical credential entries');
    for (const relativePath of credentials) {
      const restored = path.join(extracted, 'data', relativePath);
      assert.equal((await fs.stat(restored)).mode & 0o777, 0o600, `${relativePath} must be private in the archive`);
    }

    const lockPath = path.join(dataRoot, 'system', 'backups', '.full-backup.lock');
    await fs.writeFile(lockPath, '{partial legacy lock');
    const recovered = await backup.createFullBackupJob();
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      const job = await backup.getFullBackupJob(recovered.id);
      if (job?.status === 'completed') break;
      if (job?.status === 'failed') throw new Error(job.error || 'Recovery backup failed.');
      await delay(25);
    }
    assert.equal((await backup.getFullBackupJob(recovered.id))?.status, 'completed',
      'a malformed leftover lock from an older interrupted writer should be recoverable');

    console.log('Full-backup lock publication is cross-process serialized; lock recovery works, and canonical credential entries archive as 0600.');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in beforeEnv)) delete process.env[key];
    Object.assign(process.env, beforeEnv);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

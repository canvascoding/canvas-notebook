import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const scriptPath = path.resolve('scripts/capability-preference-lock-test.ts');
const userId = 'preference-lock-user';
const children = new Set<ReturnType<typeof spawn>>();

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await fs.access(filePath).then(() => true, () => false)) return;
    await delay(10);
  }
  throw new Error('The preference test synchronization timed out.');
}

function startWorker(root: string, resourceId: string, revision: number, enabled: boolean, barrier?: string) {
  const child = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', scriptPath, '--worker', resourceId, String(revision), String(enabled), barrier || ''], {
    env: { ...process.env, DATA: root, CANVAS_DATA_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '', errors = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { errors += String(chunk); });
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => {
      children.delete(child);
      if (code === 0) resolve(); else reject(new Error(`Preference worker exited ${code}: ${errors}`));
    });
  });
  const ready = async () => {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (output.includes('ready\n')) return;
      assert.equal(child.exitCode, null, 'The preference worker exited before its operation.');
      await delay(10);
    }
    throw new Error('The preference worker did not become ready.');
  };
  return { child, completion, ready, result: () => JSON.parse(output.trim().split('\n').at(-1)!) as { outcome: 'updated' | 'conflict'; revision?: number; code?: string } };
}

async function worker(resourceId: string, revision: number, enabled: boolean, barrier: string): Promise<void> {
  const { setCapabilityPreference, CapabilityPreferenceConflictError } = await import('../app/lib/capabilities/preference-store');
  process.stdout.write('ready\n');
  if (barrier) await waitForFile(barrier);
  try {
    const record = await setCapabilityPreference({ userId, resourceId, expectedRevision: revision, enabled });
    process.stdout.write(`${JSON.stringify({ outcome: 'updated', revision: record.revision })}\n`);
  } catch (error) {
    if (!(error instanceof CapabilityPreferenceConflictError)) throw error;
    process.stdout.write(`${JSON.stringify({ outcome: 'conflict', code: error.code })}\n`);
  }
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-preference-lock-'));
  const previous = { DATA: process.env.DATA, CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT };
  process.env.DATA = root; process.env.CANVAS_DATA_ROOT = root;
  try {
    const { setCapabilityPreference, readCapabilityPreferences, CapabilityPreferenceConflictError } = await import('../app/lib/capabilities/preference-store');
    const { withFileMutationLock } = await import('../app/lib/secrets/file-mutation-lock');
    const { resolveUserSettingsDir, createAtomicTempPath } = await import('../app/lib/runtime-data-paths');
    assert.equal(await fs.stat(resolveUserSettingsDir('brand-new-user')).catch(() => null), null);
    assert.equal((await setCapabilityPreference({ userId: 'brand-new-user', resourceId: 'initial', enabled: true, expectedRevision: 0 })).revision, 1,
      'The first mutation creates the directory before acquiring its kernel lock.');
    const initial = await setCapabilityPreference({ userId, resourceId: 'keep-existing', enabled: true, expectedRevision: 0 });
    const target = path.join(resolveUserSettingsDir(userId), 'capabilities.json');
    const contenders: ReturnType<typeof startWorker>[] = [];
    await withFileMutationLock(target, async () => {
      contenders.push(startWorker(root, 'plugin-one', 0, false), startWorker(root, 'skill-two', 0, true));
      await Promise.all(contenders.map(child => child.ready()));
      await delay(200);
      assert(contenders.every(child => child.child.exitCode === null), 'Setters in other actual processes must wait for the identical file lock used by cleanup.');
      const before = await readCapabilityPreferences(userId);
      assert.deepEqual(Object.keys(before.preferences), ['keep-existing']);
      before.preferences['foreign-preserved'] = { enabled: false, revision: 7, updatedAt: '2026-10-06T00:00:00.000Z' };
      const temp = createAtomicTempPath(target);
      await fs.writeFile(temp, JSON.stringify(before)); await fs.rename(temp, target);
    });
    await Promise.all(contenders.map(child => child.completion));
    assert(contenders.every(child => child.result().outcome === 'updated'));
    let registry = await readCapabilityPreferences(userId);
    assert.deepEqual(registry.preferences['keep-existing'], initial);
    assert.deepEqual(registry.preferences['foreign-preserved'], { enabled: false, revision: 7, updatedAt: '2026-10-06T00:00:00.000Z' });
    assert.equal(registry.preferences['plugin-one'].revision, 1); assert.equal(registry.preferences['skill-two'].revision, 1);
    assert.equal((await fs.lstat(`${target}.lock`)).mode & 0o777, 0o600, 'The stable sidecar remains private across atomic preference renames.');

    await setCapabilityPreference({ userId, resourceId: 'same-cas', enabled: false, expectedRevision: 0 });
    const barrier = path.join(root, 'cas-ready');
    const left = startWorker(root, 'same-cas', 1, true, barrier), right = startWorker(root, 'same-cas', 1, false, barrier);
    await Promise.all([left.ready(), right.ready()]); await fs.writeFile(barrier, 'start');
    await Promise.all([left.completion, right.completion]);
    const outcomes = [left.result(), right.result()];
    assert.equal(outcomes.filter(result => result.outcome === 'updated' && result.revision === 2).length, 1);
    assert.equal(outcomes.filter(result => result.outcome === 'conflict' && result.code === 'CAPABILITY_PREFERENCE_REVISION_CONFLICT').length, 1);
    const beforeConflict = await fs.readFile(target, 'utf8');
    await assert.rejects(setCapabilityPreference({ userId, resourceId: 'same-cas', enabled: true, expectedRevision: 1 }), CapabilityPreferenceConflictError);
    assert.equal(await fs.readFile(target, 'utf8'), beforeConflict, 'Stale CAS changes neither this record nor unrelated preferences.');
    await Promise.all(Array.from({ length: 6 }, (_, index) => setCapabilityPreference({ userId, resourceId: 'local-queue', enabled: Boolean(index % 2) })));
    registry = await readCapabilityPreferences(userId);
    assert.equal(registry.preferences['local-queue'].revision, 6, 'The original in-process queue remains active after a CAS failure.');
    assert.equal(registry.preferences['same-cas'].revision, 2);
    assert.deepEqual(registry.preferences['keep-existing'], initial);
    assert.equal(registry.preferences['foreign-preserved'].revision, 7);
    console.log('PASS actual cross-process preference flock/CAS: cleanup lock blocks writers, unrelated entries survive, one CAS winner, stale write unchanged and local queue retained.');
  } finally {
    const active = [...children];
    for (const child of active) child.kill('SIGKILL');
    await Promise.all(active.map(child => new Promise<void>(resolve => child.once('close', () => resolve()))));
    await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

const workerIndex = process.argv.indexOf('--worker');
if (workerIndex >= 0) worker(process.argv[workerIndex + 1] || '', Number(process.argv[workerIndex + 2]), process.argv[workerIndex + 3] === 'true', process.argv[workerIndex + 4] || '')
  .catch(error => { console.error(error); process.exitCode = 1; });
else main().catch(error => { console.error(error); process.exitCode = 1; });

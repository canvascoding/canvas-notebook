import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { build } from 'esbuild';

import { WorkspaceMutationLockError, withWorkspaceMutationLock } from '../app/lib/files/workspace-mutation-lock';

const scriptPath = path.resolve('scripts/workspace-mutation-lock-test.ts');
const workspaceId = 'mutation-lock-test-workspace';
const children = new Set<ReturnType<typeof spawn>>();

function startWorker(dataRoot: string, mode: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions', 'react-server', scriptPath, '--worker', mode], {
    env: { ...process.env, DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    });
  });
  async function waitFor(text: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!stdout.includes(text)) {
      assert.equal(child.exitCode, null, `Worker exited before ${text}: ${stderr}`);
      assert.ok(Date.now() < deadline, `Worker did not emit ${text}: ${stderr}`);
      await delay(10);
    }
  }
  async function succeeds(): Promise<void> {
    const result = await completion;
    assert.equal(result.code, 0, `Worker failed (${result.signal}): ${stderr}`);
  }
  return { child, completion, waitFor, succeeds, output: () => stdout };
}

async function pythonProbe(handle: FileHandle): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CANVAS_PYTHON_PATH?.trim() || 'python3', [
      '-I', '-c', 'import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)',
    ], { stdio: ['ignore', 'ignore', 'pipe', handle.fd] });
    let output = '';
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function worker(mode: string): Promise<void> {
  const root = process.env.DATA!;
  if (mode === 'counter') {
    for (let index = 0; index < 6; index += 1) {
      await withWorkspaceMutationLock(workspaceId, async () => {
        const marker = path.join(root, 'critical-section');
        const handle = await fs.open(marker, 'wx');
        try {
          const count = Number(await fs.readFile(path.join(root, 'counter'), 'utf8'));
          await delay(5 + Math.floor(Math.random() * 15));
          await fs.writeFile(path.join(root, 'counter'), String(count + 1));
        } finally {
          await handle.close();
          await fs.unlink(marker);
        }
      });
    }
  } else if (mode === 'holder') {
    await withWorkspaceMutationLock(workspaceId, async () => {
      process.stdout.write('entered\n');
      await new Promise<void>((resolve) => {
        process.stdin.resume();
        process.stdin.once('data', () => { process.stdin.destroy(); resolve(); });
      });
    });
  } else if (mode === 'waiter') {
    process.stdout.write('waiting\n');
    await withWorkspaceMutationLock(workspaceId, async () => { process.stdout.write('entered\n'); });
  } else {
    throw new Error(`Unknown worker mode: ${mode}`);
  }
}

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workspace-mutation-lock-'));
  const originalData = process.env.DATA;
  const originalCanvasDataRoot = process.env.CANVAS_DATA_ROOT;
  const originalPython = process.env.CANVAS_PYTHON_PATH;
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  const lockPath = path.join(dataRoot, 'canvas-file-locks', `${createHash('sha256').update(workspaceId).digest('hex')}.lock`);

  try {
    await fs.writeFile(path.join(dataRoot, 'counter'), '0');
    await Promise.all(Array.from({ length: 4 }, () => startWorker(dataRoot, 'counter').succeeds()));
    assert.equal(await fs.readFile(path.join(dataRoot, 'counter'), 'utf8'), '24');
    console.log('PASS: Four independent Node processes serialize read/modify/write operations without overlap.');

    let descriptor: FileHandle | undefined;
    try {
      await withWorkspaceMutationLock(workspaceId, async () => {
        descriptor = await fs.open(lockPath, 'r+');
        const held = await pythonProbe(descriptor);
        assert.notEqual(held.code, 0);
        assert.match(held.output, /BlockingIOError/);
      });
      assert.equal((await pythonProbe(descriptor!)).code, 0);
    } finally {
      await descriptor?.close();
    }
    assert.equal((await fs.stat(lockPath)).mode & 0o777, 0o600);
    console.log('PASS: A completed helper retains the flock in the parent FD; closing it releases the lock.');

    const owner = startWorker(dataRoot, 'holder');
    await owner.waitFor('entered');
    const waiter = startWorker(dataRoot, 'waiter');
    await waiter.waitFor('waiting');
    await delay(100);
    assert.ok(!waiter.output().includes('entered'));
    owner.child.kill('SIGKILL');
    assert.equal((await owner.completion).signal, 'SIGKILL');
    await waiter.succeeds();
    assert.ok(waiter.output().includes('entered'));
    console.log('PASS: Killing the owner releases its lock without stale lease reaping.');

    const expected = new Error('Expected protected operation failure');
    await assert.rejects(withWorkspaceMutationLock(workspaceId, async () => { throw expected; }), (error) => error === expected);
    assert.equal(await withWorkspaceMutationLock(workspaceId, async () => 'released'), 'released');
    assert.equal(await withWorkspaceMutationLock(workspaceId, async () => (
      withWorkspaceMutationLock('nested-other-workspace', async () => (
        withWorkspaceMutationLock(workspaceId, async () => 'nested')
      ))
    )), 'nested');
    console.log('PASS: Exceptions release the lock and awaited same-workspace nesting is reentrant.');

    const bundle = await build({
      entryPoints: [path.resolve('app/lib/files/workspace-mutation-lock.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      alias: { 'server-only': path.resolve('node_modules/server-only/empty.js') },
    });
    const copyPaths = ['first', 'second'].map((name) => path.join(dataRoot, `${name}-lock-bundle.cjs`));
    await Promise.all(copyPaths.map((copyPath) => fs.writeFile(copyPath, bundle.outputFiles[0].text)));
    const require = createRequire(scriptPath);
    const copies = copyPaths.map((copyPath) => require(copyPath) as { withWorkspaceMutationLock: typeof withWorkspaceMutationLock });
    assert.equal(await copies[0].withWorkspaceMutationLock(workspaceId, async () => (
      copies[1].withWorkspaceMutationLock(workspaceId, async () => 'shared context')
    )), 'shared context');
    console.log('PASS: Independent server bundles share the reentrant context and process queue.');

    let awaken!: () => void;
    const deferred = new Promise<void>((resolve) => { awaken = resolve; });
    let escaped!: Promise<void>;
    let escapedEntered = false;
    await withWorkspaceMutationLock(workspaceId, async () => {
      escaped = deferred.then(() => withWorkspaceMutationLock(workspaceId, async () => { escapedEntered = true; }));
    });
    const blocker = startWorker(dataRoot, 'holder');
    await blocker.waitFor('entered');
    awaken();
    await delay(100);
    assert.equal(escapedEntered, false);
    blocker.child.stdin.write('release\n');
    await blocker.succeeds();
    await escaped;
    assert.equal(escapedEntered, true);
    console.log('PASS: Escaped async contexts reacquire a released lock and cannot bypass a new owner.');

    let releaseBusy!: () => void;
    let notifyHeld!: () => void;
    const held = new Promise<void>((resolve) => { notifyHeld = resolve; });
    const busy = withWorkspaceMutationLock(workspaceId, async () => {
      notifyHeld();
      await new Promise<void>((resolve) => { releaseBusy = resolve; });
    });
    await held;
    const queued = Array.from({ length: 64 }, () => withWorkspaceMutationLock(workspaceId, async () => undefined));
    await assert.rejects(withWorkspaceMutationLock(workspaceId, async () => assert.fail('Overflow must not execute')), (error) => (
      error instanceof WorkspaceMutationLockError && error.code === 'FILE_MUTATION_LOCK_BUSY' && error.retryable
    ));
    releaseBusy();
    await Promise.all([busy, ...queued]);
    console.log('PASS: The in-process queue has a bounded backlog and rejects excess work without executing it.');

    process.env.CANVAS_PYTHON_PATH = path.join(dataRoot, 'missing-python');
    await assert.rejects(withWorkspaceMutationLock(workspaceId, async () => assert.fail('Missing helper must not execute')), (error) => (
      error instanceof WorkspaceMutationLockError && error.code === 'FILE_MUTATION_LOCK_UNAVAILABLE'
    ));
    if (originalPython === undefined) delete process.env.CANVAS_PYTHON_PATH;
    else process.env.CANVAS_PYTHON_PATH = originalPython;
    await withWorkspaceMutationLock(workspaceId, async () => undefined);

    const unsafeWorkspace = 'unsafe-symlink';
    const unsafePath = path.join(dataRoot, 'canvas-file-locks', `${createHash('sha256').update(unsafeWorkspace).digest('hex')}.lock`);
    await fs.symlink(lockPath, unsafePath);
    await assert.rejects(withWorkspaceMutationLock(unsafeWorkspace, async () => assert.fail('Symlink lock must not execute')), (error) => (
      error instanceof WorkspaceMutationLockError && error.code === 'FILE_MUTATION_LOCK_UNAVAILABLE'
    ));
    console.log('PASS: Missing Python and symlink lockfiles fail closed.');

    const timeoutOwner = startWorker(dataRoot, 'holder');
    await timeoutOwner.waitFor('entered');
    const started = Date.now();
    const kernelWait = withWorkspaceMutationLock(workspaceId, async () => assert.fail('Timed-out kernel waiter must not execute'));
    const localWait = withWorkspaceMutationLock(workspaceId, async () => assert.fail('Timed-out local waiter must not execute'));
    const outcomes = await Promise.allSettled([kernelWait, localWait]);
    outcomes.forEach((result) => {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') {
        assert.ok(result.reason instanceof WorkspaceMutationLockError);
        assert.equal(result.reason.code, 'FILE_MUTATION_LOCK_TIMEOUT');
        assert.equal(result.reason.retryable, true);
        assert.equal(result.reason.status, 503);
      }
    });
    assert.ok(Date.now() - started >= 29_000);
    assert.ok(Date.now() - started < 35_000);
    timeoutOwner.child.stdin.write('release\n');
    await timeoutOwner.succeeds();
    await startWorker(dataRoot, 'waiter').succeeds();
    await withWorkspaceMutationLock(workspaceId, async () => undefined);
    console.log('PASS: Kernel and local acquisition deadlines fail closed; no orphan helper or waiter prevents subsequent acquisition.');
  } finally {
    await Promise.all([...children].map((child) => new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.kill('SIGKILL');
    })));
    if (originalData === undefined) delete process.env.DATA;
    else process.env.DATA = originalData;
    if (originalCanvasDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = originalCanvasDataRoot;
    if (originalPython === undefined) delete process.env.CANVAS_PYTHON_PATH;
    else process.env.CANVAS_PYTHON_PATH = originalPython;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

(process.argv[2] === '--worker' ? worker(process.argv[3]) : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

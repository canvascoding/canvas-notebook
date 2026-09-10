import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const scriptPath = path.resolve('scripts/mcp-storage-lock-test.ts');
const children = new Set<ReturnType<typeof spawn>>();

async function waitFor(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await fs.access(filePath).then(() => true, () => false)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function startWorker(dataRoot: string, mode: string, eventPath: string, readyPath: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions', 'react-server', scriptPath, '--worker', mode, eventPath, readyPath], {
    env: { ...process.env, DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.add(child);
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const completed = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      children.delete(child);
      if (code === 0) resolve(code);
      else reject(new Error(`Worker ${mode} exited ${code}: ${stderr}`));
    });
  });
  return { child, completed };
}

async function worker(mode: string, eventPath: string, readyPath: string): Promise<void> {
  const { withMcpStorageLock } = await import('../app/lib/mcp/storage-lock');
  const event = async (value: string) => fs.appendFile(eventPath, `${value}\n`);
  if (mode === 'holder') {
    await withMcpStorageLock('oauth/shared.json', null, async () => {
      await event('holder-enter');
      await fs.writeFile(readyPath, 'ready');
      await delay(350);
      await event('holder-exit');
    });
    return;
  }
  if (mode === 'contender') {
    await withMcpStorageLock('oauth/shared.json', null, async () => { await event('contender-enter'); });
    return;
  }
  if (mode === 'crash') {
    await withMcpStorageLock('oauth/crash.json', null, async () => {
      await fs.writeFile(readyPath, 'ready');
      await new Promise<void>(() => undefined);
    });
    return;
  }
  if (mode.startsWith('stress-')) {
    const guardPath = `${eventPath}.guard`;
    for (let iteration = 0; iteration < 15; iteration += 1) {
      await withMcpStorageLock('oauth/stress.json', null, async () => {
        let guard: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
          guard = await fs.open(guardPath, 'wx');
          await delay(3);
          await event(`${mode}:${iteration}`);
        } finally {
          await guard?.close();
          if (guard) await fs.unlink(guardPath).catch(() => undefined);
        }
      });
    }
    return;
  }
  throw new Error(`Unknown worker mode: ${mode}`);
}

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-storage-lock-'));
  const originalData = process.env.DATA;
  const originalCanvasDataRoot = process.env.CANVAS_DATA_ROOT;
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  try {
    const { withMcpStorageLock } = await import('../app/lib/mcp/storage-lock');
    const { resolveMcpStoragePath } = await import('../app/lib/mcp/storage');
    const eventPath = path.join(dataRoot, 'events.log');
    const holderReady = path.join(dataRoot, 'holder.ready');
    const holder = startWorker(dataRoot, 'holder', eventPath, holderReady);
    await waitFor(holderReady);

    const storagePath = resolveMcpStoragePath('oauth/shared.json', null);
    const lockDirectory = path.join(path.dirname(storagePath), '.mcp-storage-locks');
    assert.equal((await fs.lstat(lockDirectory)).mode & 0o777, 0o700, 'lock directory must be private');
    const lockFiles = await fs.readdir(lockDirectory);
    assert.equal(lockFiles.length, 1);
    assert.equal((await fs.lstat(path.join(lockDirectory, lockFiles[0]!))).mode & 0o777, 0o600, 'lockfile must be private');

    const contender = startWorker(dataRoot, 'contender', eventPath, path.join(dataRoot, 'unused.ready'));
    await delay(120);
    assert.equal((await fs.readFile(eventPath, 'utf8')).includes('contender-enter'), false, 'another process must wait for the same storage path');
    await Promise.all([holder.completed, contender.completed]);
    assert.deepEqual((await fs.readFile(eventPath, 'utf8')).trim().split('\n'), ['holder-enter', 'holder-exit', 'contender-enter']);

    await assert.rejects(
      withMcpStorageLock('oauth/error.json', null, async () => { throw new Error('expected operation failure'); }),
      /expected operation failure/u,
    );
    let releasedAfterError = false;
    await withMcpStorageLock('oauth/error.json', null, async () => { releasedAfterError = true; });
    assert.equal(releasedAfterError, true, 'operation errors must release the lock');

    let enteredA = false;
    let enteredB = false;
    let releaseBoth!: () => void;
    const bothEntered = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const connectionA = withMcpStorageLock('oauth/connection-a.json', null, async () => {
      enteredA = true;
      while (!enteredB) await delay(5);
      releaseBoth();
      await delay(25);
    });
    const connectionB = withMcpStorageLock('oauth/connection-b.json', null, async () => {
      enteredB = true;
      while (!enteredA) await delay(5);
      releaseBoth();
      await delay(25);
    });
    await bothEntered;
    await Promise.all([connectionA, connectionB]);

    const stressWorkers = Array.from({ length: 6 }, (_, index) => (
      startWorker(dataRoot, `stress-${index}`, eventPath, path.join(dataRoot, `stress-${index}.ready`))
    ));
    await Promise.all(stressWorkers.map(({ completed }) => completed));
    const stressEvents = (await fs.readFile(eventPath, 'utf8')).trim().split('\n').filter((event) => event.startsWith('stress-'));
    assert.equal(stressEvents.length, 90, 'six child processes must complete every serialized critical section');

    const crashReady = path.join(dataRoot, 'crash.ready');
    const crashed = startWorker(dataRoot, 'crash', eventPath, crashReady);
    await waitFor(crashReady);
    crashed.child.kill('SIGKILL');
    await crashed.completed.catch(() => undefined);
    let recoveredAfterCrash = false;
    await withMcpStorageLock('oauth/crash.json', null, async () => { recoveredAfterCrash = true; });
    assert.equal(recoveredAfterCrash, true, 'a dead local process must not leave MCP storage locked');

    console.log('mcp-storage-lock-test: ok');
  } finally {
    process.env.DATA = originalData;
    process.env.CANVAS_DATA_ROOT = originalCanvasDataRoot;
    for (const child of children) child.kill('SIGKILL');
    await Promise.all([...children].map((child) => new Promise<void>((resolve) => child.once('close', () => resolve()))));
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

const workerIndex = process.argv.indexOf('--worker');
if (workerIndex >= 0) {
  void worker(process.argv[workerIndex + 1] || '', process.argv[workerIndex + 2] || '', process.argv[workerIndex + 3] || '').catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

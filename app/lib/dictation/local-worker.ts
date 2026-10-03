import 'server-only';

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import { readLocalDictationRuntimeStatus } from './runtime-install';

const IDLE_MS = 5 * 60_000;
const TRANSCRIPTION_TIMEOUT_MS = 3 * 60_000;

type Pending = { resolve: (text: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

let worker: ChildProcessWithoutNullStreams | null = null;
let workerRuntimePath: string | null = null;
let starting: Promise<void> | null = null;
let nextId = 0;
let idleTimer: NodeJS.Timeout | null = null;
const pending = new Map<number, Pending>();
let activeRequests = 0;

export async function localDictationAvailable(model?: string): Promise<boolean> {
  const runtime = await readLocalDictationRuntimeStatus();
  return runtime.engine === 'whisper-cpp'
    ? Boolean(model && runtime.installedModels?.includes(model))
    : runtime.state === 'installed';
}

function rejectPending(error: Error): void {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function stopWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const child = worker;
  worker = null;
  workerRuntimePath = null;
  if (child) {
    rejectPending(new Error('Local dictation worker stopped.'));
    child.kill();
  }
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0) stopWorker();
  }, IDLE_MS);
  idleTimer.unref();
}

async function ensureWorker(runtimePath: string, cpp = false): Promise<void> {
  if (starting) {
    await starting;
    return ensureWorker(runtimePath, cpp);
  }
  if (worker && !worker.killed && workerRuntimePath === runtimePath) return;
  if (worker) stopWorker();
  starting = (async () => {
    const cacheDir = path.join(resolveCanvasDataRoot(), 'cache', 'dictation-models');
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const script = path.join(process.env.CANVAS_APP_ROOT?.trim() || process.cwd(), 'scripts', cpp ? 'dictation-cpp-worker.py' : 'dictation-worker.py');
    const child = spawn(process.env.CANVAS_PYTHON_PATH?.trim() || 'python3', ['-u', script], {
      stdio: 'pipe',
      env: { ...process.env, HF_HOME: cacheDir, PYTHONUNBUFFERED: '1', PYTHONPATH: runtimePath, PYTHONNOUSERSITE: '1', CANVAS_DICTATION_RUNTIME: runtimePath },
    });
    worker = child;
    workerRuntimePath = runtimePath;
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-800); });
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Local dictation worker did not start.'));
      }, 20_000);
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        let message: { type?: string; id?: number; text?: string; error?: string };
        try { message = JSON.parse(line) as typeof message; } catch { return; }
        if (message.type === 'ready') {
          ready = true;
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (typeof message.id !== 'number') return;
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.text ?? '');
        armIdleTimer();
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        if (!ready) reject(error);
        if (worker === child) {
          rejectPending(error);
          worker = null;
          workerRuntimePath = null;
        }
      });
      child.on('exit', () => {
        clearTimeout(timeout);
        const error = new Error(ready ? 'Local dictation worker stopped.' : `Local dictation unavailable: ${stderr || 'worker exited'}`);
        if (!ready) reject(error);
        if (worker === child) {
          rejectPending(error);
          worker = null;
          workerRuntimePath = null;
        }
      });
    });
    armIdleTimer();
  })().finally(() => { starting = null; });
  return starting;
}

export async function transcribeLocally(input: {
  buffer: Buffer;
  extension: string;
  model: string;
  language: string;
}): Promise<string> {
  const runtime = await readLocalDictationRuntimeStatus();
  const cpp = runtime.engine === 'whisper-cpp';
  if (!runtime.path || (cpp ? !runtime.installedModels?.includes(input.model) : runtime.state !== 'installed')) {
    throw new Error('Local dictation is not installed on this server.');
  }
  if (activeRequests >= 2) throw new Error('Local dictation is busy. Please try again shortly.');
  activeRequests += 1;
  let directory: string | null = null;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-dictation-'));
    const audioPath = path.join(directory, `recording${input.extension}`);
    await fs.writeFile(audioPath, input.buffer, { mode: 0o600 });
    await ensureWorker(runtime.path, cpp);
    if (!worker) throw new Error('Local dictation worker is unavailable.');
    if (idleTimer) clearTimeout(idleTimer);
    const id = ++nextId;
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Local transcription timed out.'));
        stopWorker();
      }, TRANSCRIPTION_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      worker?.stdin.write(`${JSON.stringify({ id, path: audioPath, model: input.model, language: input.language })}\n`);
    });
  } finally {
    activeRequests -= 1;
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}

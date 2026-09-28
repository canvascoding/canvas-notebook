import 'server-only';

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';

import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';

const execFileAsync = promisify(execFile);
const IDLE_MS = 5 * 60_000;
const TRANSCRIPTION_TIMEOUT_MS = 3 * 60_000;

type Pending = { resolve: (text: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

let worker: ChildProcessWithoutNullStreams | null = null;
let starting: Promise<void> | null = null;
let nextId = 0;
let idleTimer: NodeJS.Timeout | null = null;
let probe: { at: number; available: boolean } | null = null;
const pending = new Map<number, Pending>();
let activeRequests = 0;

export async function localDictationAvailable(): Promise<boolean> {
  if (probe && Date.now() - probe.at < 30_000) return probe.available;
  const available = await execFileAsync('python3', ['-c', 'import faster_whisper'], { timeout: 10_000 })
    .then(() => true, () => false);
  probe = { at: Date.now(), available };
  return available;
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

async function ensureWorker(): Promise<void> {
  if (starting) return starting;
  if (worker && !worker.killed) return;
  starting = (async () => {
    const cacheDir = path.join(resolveCanvasDataRoot(), 'cache', 'dictation-models');
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const script = path.join(process.cwd(), 'scripts', 'dictation-worker.py');
    const child = spawn('python3', ['-u', script], {
      stdio: 'pipe',
      env: { ...process.env, HF_HOME: cacheDir, PYTHONUNBUFFERED: '1' },
    });
    worker = child;
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
        }
      });
      child.on('exit', () => {
        clearTimeout(timeout);
        const error = new Error(ready ? 'Local dictation worker stopped.' : `Local dictation unavailable: ${stderr || 'worker exited'}`);
        if (!ready) reject(error);
        if (worker === child) {
          rejectPending(error);
          worker = null;
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
  if (!(await localDictationAvailable())) {
    throw new Error('Local dictation is not installed on this server.');
  }
  if (activeRequests >= 2) throw new Error('Local dictation is busy. Please try again shortly.');
  activeRequests += 1;
  let directory: string | null = null;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-dictation-'));
    const audioPath = path.join(directory, `recording${input.extension}`);
    await fs.writeFile(audioPath, input.buffer, { mode: 0o600 });
    await ensureWorker();
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

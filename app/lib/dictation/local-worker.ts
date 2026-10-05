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

type LocalTranscriptionInput = {
  buffer: Buffer;
  extension: string;
  model: string;
  language: string;
  prompt?: string;
  signal?: AbortSignal;
};

type Pending = {
  child: ChildProcessWithoutNullStreams;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
};

type Request = {
  id: number;
  input: LocalTranscriptionInput;
  runtimePath: string;
  cpp: boolean;
  settle: (error?: Error, text?: string) => void;
  settled: boolean;
};

type LocalWorkerState = {
  worker: ChildProcessWithoutNullStreams | null;
  workerRuntimePath: string | null;
  stopping: Promise<void> | null;
  nextId: number;
  idleTimer: NodeJS.Timeout | null;
  pending: Map<number, Pending>;
  requests: Set<Request>;
  queue: Request[];
  dispatching: boolean;
};

// Next routes and the agent server may load separate bundles of this module.
// Keep their local processing capacity and warm worker shared in this process.
const workerStateKey = Symbol.for('canvas.dictation.local-worker.v1');
const shared = globalThis as typeof globalThis & { [workerStateKey]?: LocalWorkerState };
const state: LocalWorkerState = shared[workerStateKey] ?? (shared[workerStateKey] = {
  worker: null, workerRuntimePath: null, stopping: null, nextId: 0,
  idleTimer: null, pending: new Map(), requests: new Set(), queue: [], dispatching: false,
});

export async function localDictationAvailable(model?: string): Promise<boolean> {
  const runtime = await readLocalDictationRuntimeStatus();
  return runtime.engine === 'whisper-cpp'
    ? Boolean(model && runtime.installedModels?.includes(model))
    : runtime.state === 'installed';
}

function rejectPending(error: Error, child: ChildProcessWithoutNullStreams): void {
  for (const [id, request] of state.pending) {
    if (request.child !== child) continue;
    state.pending.delete(id);
    request.reject(error);
  }
}

async function stopWorker(child = state.worker): Promise<void> {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = null;
  if (!child) {
    if (state.stopping) await state.stopping;
    return;
  }
  if (state.worker === child) {
    state.worker = null;
    state.workerRuntimePath = null;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Wait for close before releasing capacity or deleting audio. SIGTERM lets the
  // whisper.cpp wrapper reap its subprocess and clean its decoded audio first.
  const closed = new Promise<void>((resolve) => {
    const force = setTimeout(() => { child.kill('SIGKILL'); }, 5_000);
    force.unref();
    child.once('close', () => { clearTimeout(force); resolve(); });
    child.kill();
  });
  state.stopping = closed;
  try { await closed; } finally { if (state.stopping === closed) state.stopping = null; }
}

function armIdleTimer(): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    if (state.requests.size === 0 && !state.dispatching) void stopWorker();
  }, IDLE_MS);
  state.idleTimer.unref();
}

async function ensureWorker(runtimePath: string, cpp = false): Promise<ChildProcessWithoutNullStreams> {
  if (state.stopping) await state.stopping;
  const runtimeIdentity = `${cpp ? 'whisper-cpp' : 'faster-whisper'}:${runtimePath}`;
  if (state.worker && !state.worker.killed && state.workerRuntimePath === runtimeIdentity) return state.worker;
  if (state.worker) await stopWorker();
  const cacheDir = path.join(resolveCanvasDataRoot(), 'cache', 'dictation-models');
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const script = path.join(process.env.CANVAS_APP_ROOT?.trim() || process.cwd(), 'scripts', cpp ? 'dictation-cpp-worker.py' : 'dictation-worker.py');
  const child = spawn(process.env.CANVAS_PYTHON_PATH?.trim() || 'python3', ['-u', script], {
    stdio: 'pipe',
    env: { ...process.env, HF_HOME: cacheDir, PYTHONUNBUFFERED: '1', PYTHONPATH: runtimePath, PYTHONNOUSERSITE: '1', CANVAS_DICTATION_RUNTIME: runtimePath },
  });
  state.worker = child;
  state.workerRuntimePath = runtimeIdentity;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-800); });
  child.stdin.on('error', () => { void stopWorker(child); });
  try {
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        reject(new Error('Local dictation worker did not start.'));
      }, 20_000);
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        let message: { type?: string; id?: number; text?: string; error?: string; code?: string };
        try { message = JSON.parse(line) as typeof message; } catch { return; }
        if (message.type === 'ready') {
          ready = true;
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (typeof message.id !== 'number') return;
        const request = state.pending.get(message.id);
        if (!request || request.child !== child) return;
        state.pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error);
          if (message.code === 'TRANSCRIPTION_TIMEOUT') error.name = 'TimeoutError';
          request.reject(error);
        } else request.resolve(message.text ?? '');
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        if (!ready) reject(error);
      });
      child.on('close', () => {
        clearTimeout(timeout);
        lines.close();
        const error = new Error(ready ? 'Local dictation worker stopped.' : `Local dictation unavailable: ${stderr || 'worker exited'}`);
        if (!ready) reject(error);
        rejectPending(error, child);
        if (state.worker === child) {
          state.worker = null;
          state.workerRuntimePath = null;
        }
      });
    });
  } catch (error) {
    await stopWorker(child);
    throw error;
  }
  return child;
}

async function dispatchRequests(): Promise<void> {
  if (state.dispatching) return;
  state.dispatching = true;
  if (state.idleTimer) clearTimeout(state.idleTimer);
  try {
    while (state.queue.length > 0) {
      const request = state.queue.shift()!;
      let directory: string | null = null;
      let text: string | undefined;
      let failure: Error | undefined;
      try {
        if (request.settled) continue;
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-dictation-'));
        const audioPath = path.join(directory, `recording${request.input.extension}`);
        await fs.writeFile(audioPath, request.input.buffer, { mode: 0o600 });
        if (request.settled) continue;
        const child = await ensureWorker(request.runtimePath, request.cpp);
        if (request.settled) continue;
        text = await new Promise<string>((resolve, reject) => {
          // Only this request is dispatched. A stuck worker may be restarted
          // without rejecting requests that are still waiting in our queue.
          const timeout = setTimeout(() => { void stopWorker(child); }, TRANSCRIPTION_TIMEOUT_MS);
          state.pending.set(request.id, {
            child,
            resolve: (text) => { clearTimeout(timeout); resolve(text); },
            reject: (error) => { clearTimeout(timeout); reject(error); },
          });
          try {
            child.stdin.write(`${JSON.stringify({ id: request.id, path: audioPath,
              model: request.input.model, language: request.input.language, prompt: request.input.prompt })}\n`, (error) => {
              if (error) void stopWorker(child);
            });
          } catch {
            void stopWorker(child);
          }
        });
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      } finally {
        // Caller cancellation detaches its result but processing owns the file
        // and its capacity reservation until the worker replies or closes.
        try {
          if (directory) await fs.rm(directory, { recursive: true, force: true });
        } catch {
          failure ??= new Error('Local transcription temporary audio cleanup failed.');
        } finally {
          state.requests.delete(request);
          request.settle(failure, text);
        }
      }
    }
  } finally {
    state.dispatching = false;
    armIdleTimer();
  }
}

function cancellationError(): Error {
  return Object.assign(new Error('Local transcription cancelled.'), { name: 'AbortError' });
}

export async function transcribeLocally(input: LocalTranscriptionInput): Promise<string> {
  if (input.signal?.aborted) throw cancellationError();
  const runtime = await readLocalDictationRuntimeStatus();
  if (input.signal?.aborted) throw cancellationError();
  const cpp = runtime.engine === 'whisper-cpp';
  if (!runtime.path || (cpp ? !runtime.installedModels?.includes(input.model) : runtime.state !== 'installed')) {
    throw new Error('Local dictation is not installed on this server.');
  }
  if (state.requests.size >= 2) throw new Error('Local dictation is busy. Please try again shortly.');
  return new Promise<string>((resolve, reject) => {
    const detach = (error: Error) => {
      request.settle(error);
      const index = state.queue.indexOf(request);
      if (index >= 0) {
        state.queue.splice(index, 1);
        state.requests.delete(request);
      }
    };
    const abort = () => detach(cancellationError());
    const timer = setTimeout(() => detach(Object.assign(new Error('Local transcription timed out.'), {
      name: 'TimeoutError',
    })), TRANSCRIPTION_TIMEOUT_MS);
    const request: Request = {
      id: ++state.nextId, input, runtimePath: runtime.path!, cpp, settled: false,
      settle: (error, text) => {
        if (request.settled) return;
        request.settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(text ?? '');
      },
    };
    state.requests.add(request);
    state.queue.push(request);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    void dispatchRequests();
  });
}

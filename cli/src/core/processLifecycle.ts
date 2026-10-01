import type { ChildProcess } from 'node:child_process';

export interface ProcessLifecycleOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  processGroup?: boolean;
}

export function superviseProcess(child: ChildProcess, options: ProcessLifecycleOptions = {}) {
  let timedOut = false;
  let aborted = false;
  let stopping = false;
  let closed = false;
  let finished = false;
  let forceKilled = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (options.processGroup && process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const stop = () => {
    if (stopping || finished) return;
    stopping = true;
    kill('SIGTERM');
    forceKillTimer = setTimeout(() => {
      kill('SIGKILL');
      forceKilled = true;
      if (closed) cleanup();
    }, options.killGraceMs ?? 5_000);
    forceKillTimer.unref();
  };
  const abort = () => { aborted = true; stop(); };
  const timeout = options.timeoutMs && options.timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs) : undefined;
  timeout?.unref();
  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (timeout) clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    options.signal?.removeEventListener('abort', abort);
    resolveCompletion();
  };
  child.once('close', () => {
    closed = true;
    if (stopping && options.processGroup && process.platform !== 'win32' && child.pid && !forceKilled) {
      try {
        process.kill(-child.pid, 0);
        forceKillTimer?.ref();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          forceKillTimer?.ref();
          return;
        }
      }
    }
    cleanup();
  });
  child.once('error', cleanup);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  return { stop, completion, get timedOut() { return timedOut; }, get aborted() { return aborted; } };
}

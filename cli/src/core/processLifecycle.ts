import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';

export interface ProcessTermination {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  canceled: boolean;
  error?: Error;
}

const activeProcesses = new Set<{ stop(): void }>();

function forwardSignal(signal: NodeJS.Signals): void {
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  for (const active of activeProcesses) active.stop();
}

const forwardInterrupt = () => forwardSignal('SIGINT');
const forwardTermination = () => forwardSignal('SIGTERM');

export function startManagedProcess(command: string, args: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  timeoutMs?: number;
  signal?: AbortSignal;
  killGraceMs?: number;
} = {}): { child: ChildProcess; completion: Promise<ProcessTermination>; stop(): void } {
  const grouped = process.platform !== 'win32' && options.stdio !== 'inherit';
  const child = spawn(command, args, {
    cwd: options.cwd, env: options.env, stdio: options.stdio ?? 'pipe',
    shell: false, windowsHide: true, detached: grouped,
  });
  let settled = false;
  let stopping = false;
  let timedOut = false;
  let canceled = false;
  let streamError: Error | undefined;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let timeout: NodeJS.Timeout | undefined;
  let escalation: NodeJS.Timeout | undefined;
  let finalization: NodeJS.Timeout | undefined;
  let finish!: (error?: Error) => void;

  const kill = (signal: NodeJS.Signals) => {
    try {
      if (grouped && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
    }
  };
  const stop = () => {
    if (settled || stopping) return;
    stopping = true;
    canceled = !timedOut;
    if (process.platform === 'win32' && child.pid) {
      const taskkill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      taskkill.on('error', () => child.kill('SIGKILL'));
    } else kill('SIGTERM');
    const grace = options.killGraceMs ?? 5000;
    escalation = setTimeout(() => kill('SIGKILL'), grace);
    finalization = setTimeout(() => {
      kill('SIGKILL');
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish();
    }, grace + 1000);
    escalation.unref();
    finalization.unref();
  };
  const active = { stop };
  if (activeProcesses.size === 0) {
    process.on('SIGINT', forwardInterrupt);
    process.on('SIGTERM', forwardTermination);
  }
  activeProcesses.add(active);
  const completion = new Promise<ProcessTermination>((resolve, reject) => {
    finish = (error) => {
      if (settled) return;
      settled = true;
      if (stopping) kill('SIGKILL');
      clearTimeout(timeout);
      clearTimeout(escalation);
      clearTimeout(finalization);
      options.signal?.removeEventListener('abort', stop);
      activeProcesses.delete(active);
      if (activeProcesses.size === 0) {
        process.removeListener('SIGINT', forwardInterrupt);
        process.removeListener('SIGTERM', forwardTermination);
      }
      if (error) reject(error);
      else resolve({ code: streamError ? 1 : exitCode, signal: exitSignal, timedOut, canceled, ...(streamError ? { error: streamError } : {}) });
    };
    child.once('error', finish);
    child.once('exit', (code, signal) => { exitCode = code; exitSignal = signal; });
    child.once('close', (code, signal) => { exitCode = code; exitSignal = signal; finish(); });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on('error', (error) => { streamError = error; stop(); });
    }
  });
  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      timedOut = true;
      stop();
    } else {
      timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
      timeout.unref();
    }
  }
  if (options.signal?.aborted) stop();
  else options.signal?.addEventListener('abort', stop, { once: true });
  return { child, completion, stop };
}

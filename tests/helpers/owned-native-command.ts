import { spawn } from 'node:child_process';

type Receipt = { pid: number | null; exitCode: number | null; signal: NodeJS.Signals | null; exitVerified: boolean };
type Options = { label: 'storage-evidence' | 'scene-tool'; timeoutMs?: number; maxBuffer?: number };

/** Keep the original child-exit receipt when diagnostics or cleanup also fail. */
export function aggregateOwnedNativeErrors(primaryError: unknown, additionalErrors: readonly unknown[], message: string): AggregateError {
  const combined = new AggregateError(primaryError === undefined ? additionalErrors : [primaryError, ...additionalErrors], message);
  if (primaryError && typeof primaryError === 'object' && Object.hasOwn(primaryError, 'ownedChildReceipt')) {
    Object.assign(combined, { ownedChildReceipt: (primaryError as { ownedChildReceipt: unknown }).ownedChildReceipt });
  }
  return combined;
}

/** Direct Node child: retain its spawn object and prove exit before releasing the fixture. */
export async function runOwnedNativeCommand(args: string[], options: Options): Promise<{ stdout: string; receipt: Receipt }> {
  const timeout = options.timeoutMs ?? 30_000;
  const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000
    || !Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 4 * 1024 * 1024) {
    throw new Error('Invalid owned native command bounds.');
  }
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let failure: string | undefined;
  let didExit = false;
  const receipt: Receipt = { pid: child.pid ?? null, exitCode: null, signal: null, exitVerified: false };
  const timers = new Set<NodeJS.Timeout>();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      if (failure || !receipt.exitVerified || receipt.exitCode !== 0) {
        const reason = failure ?? 'failed';
        reject(Object.assign(new Error(`Owned ${options.label} child ${reason}; exit ${receipt.exitVerified ? 'verified' : 'unconfirmed'}.`),
          { ownedChildReceipt: { ...receipt } }));
      } else resolve({ stdout, receipt: { ...receipt } });
    };
    const later = (callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); timers.add(timer); };
    const stop = (reason: string) => {
      if (failure) return;
      failure = reason;
      // ChildProcess.kill uses this live spawn handle, never a stored or searched PID.
      if (!didExit) child.kill('SIGTERM');
      later(() => { if (!didExit) child.kill('SIGKILL'); }, 2_000);
      later(() => { child.stdout.destroy(); child.stderr.destroy(); finish(); }, 5_000);
    };
    child.once('error', () => {
      if (!child.pid) receipt.exitVerified = true;
      stop('could not start or terminate');
    });
    child.once('exit', (code, signal) => {
      didExit = true;
      receipt.exitCode = code;
      receipt.signal = signal;
      receipt.exitVerified = true;
    });
    child.once('close', finish);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxBuffer) stop('exceeded its output bound');
      else stdout += chunk;
    });
    // Error output may contain contexts or credentials; count it without retaining or logging it.
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > maxBuffer) stop('exceeded its error output bound'); });
    later(() => stop(`timed out after ${timeout}ms`), timeout);
  });
}

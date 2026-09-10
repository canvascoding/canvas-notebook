import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export function resolveStartupHealthBudget(value) {
  const seconds = Number.parseInt(value || '', 10);
  return Number.isSafeInteger(seconds) && seconds > 0 && Number.isSafeInteger(seconds * 1_000)
    ? seconds * 1_000
    : 180_000;
}

function processIsRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function probeHealth(url, timeoutMillis) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMillis))),
      redirect: 'error',
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/** One monotonic overall budget; a slow HTTP request must not extend it. */
export async function waitForStartupHealth({
  url, pid, budgetMillis, now = () => performance.now(),
  isRunning = processIsRunning, probe = probeHealth, pause = sleep,
}) {
  const deadline = now() + budgetMillis;
  while (now() < deadline) {
    if (!isRunning(pid)) return 'exited';
    const healthy = await probe(url, Math.min(5_000, deadline - now()));
    if (!isRunning(pid)) return 'exited';
    if (healthy && now() < deadline) return 'ready';
    const remaining = deadline - now();
    if (remaining > 0) await pause(Math.min(1_000, remaining));
  }
  return 'timeout';
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const url = new URL(process.argv[2]);
    const pid = Number(process.argv[3]);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid local readiness target');
    const budgetMillis = resolveStartupHealthBudget(process.argv[4]);
    const result = await waitForStartupHealth({ url, pid, budgetMillis });
    if (result !== 'ready') {
      console.error(result === 'exited'
        ? '[Startup] Next.js exited before becoming healthy.'
        : `[Startup] Next.js did not become healthy within ${budgetMillis / 1_000}s (STARTUP_HEALTH_MAX_ATTEMPTS).`);
      process.exitCode = result === 'exited' ? 2 : 1;
    }
  } catch {
    console.error('[Startup] Could not complete the local readiness check.');
    process.exitCode = 1;
  }
}

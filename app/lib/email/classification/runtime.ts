import 'server-only';

import { createEmailClassificationWorker, type EmailClassificationWorkerDependencies } from './worker';

type Worker = ReturnType<typeof createEmailClassificationWorker>;
type Runtime = { worker: Worker; timer: ReturnType<typeof setTimeout> | null; running: boolean; pending: boolean; stopped: boolean; trigger(): void; stop(): void };
type RuntimeGlobal = typeof globalThis & { __canvasEmailClassificationRuntime?: Runtime };

/** Starts only when the host explicitly initializes the runtime. Imports never create timers. */
export function initializeEmailClassificationRuntime(dependencies: EmailClassificationWorkerDependencies & { intervalMs?: number; initialDelayMs?: number } = {}): {
  started: boolean; trigger(): void; stop(): void;
} {
  if (process.env.NEXT_PHASE === 'phase-production-build') return { started: false, trigger() {}, stop() {} };
  const globalRuntime = globalThis as RuntimeGlobal;
  const existing = globalRuntime.__canvasEmailClassificationRuntime;
  if (existing && !existing.stopped) return { started: false, trigger: existing.trigger, stop: existing.stop };
  const worker = createEmailClassificationWorker(dependencies);
  const intervalMs = Math.max(250, dependencies.intervalMs ?? 5_000);
  const schedule = (delay: number) => {
    if (runtime.stopped) return;
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = setTimeout(() => { runtime.timer = null; void run(); }, delay);
    runtime.timer.unref?.();
  };
  const run = async () => {
    if (runtime.stopped) return;
    if (runtime.running) { runtime.pending = true; return; }
    runtime.running = true;
    runtime.pending = false;
    try { await worker.runCycle(); }
    catch { /* Aggregate health and per-job codes describe failures without logging message data. */ }
    finally { runtime.running = false; schedule(runtime.pending ? 0 : intervalMs); }
  };
  const runtime: Runtime = {
    worker, timer: null, running: false, pending: false, stopped: false,
    trigger() { if (runtime.running) runtime.pending = true; else schedule(0); },
    stop() { runtime.stopped = true; if (runtime.timer) clearTimeout(runtime.timer); runtime.timer = null; worker.stop(); },
  };
  globalRuntime.__canvasEmailClassificationRuntime = runtime;
  schedule(Math.max(0, dependencies.initialDelayMs ?? 1_500));
  return { started: true, trigger: runtime.trigger, stop: runtime.stop };
}

export { notifyEmailClassificationSettingsChanged } from './runtime-control';

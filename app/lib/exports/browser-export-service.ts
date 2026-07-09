import 'server-only';

import { spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import os from 'node:os';

export const DEFAULT_BROWSER_EXPORT_TIMEOUT_MS = 30_000;
export const DEFAULT_MARP_BROWSER_EXPORT_TIMEOUT_MS = 60_000;

const MAX_ACTIVE_BROWSER_EXPORT_JOBS = 1;
const DEFAULT_MAX_QUEUED_BROWSER_EXPORT_JOBS = 1;
const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_CLEANUP_GRACE_MS = 2_000;
const DEFAULT_MIN_FREE_MEMORY_MB = 256;
const DEFAULT_MAX_LOAD_PER_CPU = 2;
const DEFAULT_CHILD_PROCESS_MEMORY_MB = 1024;
const DEFAULT_CHILD_PROCESS_NICE = 10;

export type BrowserExportErrorCode =
  | 'BROWSER_EXPORT_QUEUE_FULL'
  | 'BROWSER_EXPORT_QUEUE_TIMEOUT'
  | 'BROWSER_EXPORT_TIMEOUT'
  | 'BROWSER_EXPORT_LOW_MEMORY'
  | 'BROWSER_EXPORT_HIGH_LOAD';

export class BrowserExportError extends Error {
  readonly code: BrowserExportErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: BrowserExportErrorCode,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BrowserExportError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type BrowserExportJobContext = {
  jobId: string;
  label: string;
  signal: AbortSignal;
  queuedAt: number;
  startedAt: number;
};

type BrowserExportJobOptions<T> = {
  label: string;
  timeoutMs?: number;
  timeoutErrorMessage?: string;
  run: (context: BrowserExportJobContext) => Promise<T>;
  onTimeout?: (error: BrowserExportError, context: BrowserExportJobContext) => Promise<void> | void;
};

type QueuedBrowserExportJob<T = unknown> = Required<Pick<BrowserExportJobOptions<T>, 'label' | 'run'>> &
  Pick<BrowserExportJobOptions<T>, 'timeoutMs' | 'timeoutErrorMessage' | 'onTimeout'> & {
    jobId: string;
    queuedAt: number;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
    waitTimer: NodeJS.Timeout | null;
  };

type BrowserExportQueueStatus = {
  active: number;
  queued: number;
  maxActive: number;
  maxQueued: number;
};

type BrowserExportResourceSnapshot = {
  freeMemoryMb: number;
  totalMemoryMb: number;
  loadAverage1m: number;
  cpuCount: number;
  loadPerCpu: number;
};

type BrowserExportResourceLimits = {
  minFreeMemoryMb: number;
  maxLoadPerCpu: number;
};

type BrowserExportChildProcessLimits = {
  memoryMb: number;
  cpuSeconds: number;
  nice: number;
};

type LimitedCommandSpec = {
  command: string;
  args: string[];
  appliedLimits: string[];
};

let activeJob: QueuedBrowserExportJob | null = null;
const queuedJobs: QueuedBrowserExportJob[] = [];
const activeJobContext = new AsyncLocalStorage<BrowserExportJobContext>();
const commandAvailability = new Map<string, boolean>();
let jobSequence = 0;

function parseIntegerEnv(name: string, fallback: number, options: { min: number; max?: number }): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;

  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(parsed, options.min), max);
}

function parseFloatEnv(name: string, fallback: number, options: { min: number; max?: number }): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;

  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(parsed, options.min), max);
}

function getMaxQueuedJobs(): number {
  return parseIntegerEnv(
    'CANVAS_BROWSER_EXPORT_MAX_QUEUE',
    DEFAULT_MAX_QUEUED_BROWSER_EXPORT_JOBS,
    { min: 0, max: 10 },
  );
}

function getQueueWaitTimeoutMs(): number {
  return parseIntegerEnv(
    'CANVAS_BROWSER_EXPORT_QUEUE_WAIT_TIMEOUT_MS',
    DEFAULT_QUEUE_WAIT_TIMEOUT_MS,
    { min: 1_000, max: 120_000 },
  );
}

function getCleanupGraceMs(): number {
  return parseIntegerEnv(
    'CANVAS_BROWSER_EXPORT_TIMEOUT_CLEANUP_GRACE_MS',
    DEFAULT_TIMEOUT_CLEANUP_GRACE_MS,
    { min: 250, max: 10_000 },
  );
}

function getResourceLimits(): BrowserExportResourceLimits {
  return {
    minFreeMemoryMb: parseIntegerEnv(
      'CANVAS_BROWSER_EXPORT_MIN_FREE_MEMORY_MB',
      DEFAULT_MIN_FREE_MEMORY_MB,
      { min: 0, max: 8192 },
    ),
    maxLoadPerCpu: parseFloatEnv(
      'CANVAS_BROWSER_EXPORT_MAX_LOAD_PER_CPU',
      DEFAULT_MAX_LOAD_PER_CPU,
      { min: 0, max: 32 },
    ),
  };
}

function getResourceSnapshot(): BrowserExportResourceSnapshot {
  const cpuCount = Math.max(1, os.cpus().length || 1);
  const loadAverage1m = process.platform === 'win32' ? 0 : os.loadavg()[0] || 0;
  const freeMemoryMb = Math.floor(os.freemem() / 1024 / 1024);
  const totalMemoryMb = Math.floor(os.totalmem() / 1024 / 1024);

  return {
    freeMemoryMb,
    totalMemoryMb,
    loadAverage1m,
    cpuCount,
    loadPerCpu: loadAverage1m / cpuCount,
  };
}

function assertResourceBudget(label: string): void {
  const limits = getResourceLimits();
  const snapshot = getResourceSnapshot();

  if (limits.minFreeMemoryMb > 0 && snapshot.freeMemoryMb < limits.minFreeMemoryMb) {
    throw new BrowserExportError(
      'BROWSER_EXPORT_LOW_MEMORY',
      'Browser export is temporarily unavailable because server memory is low. Try again shortly.',
      503,
      { label, ...snapshot, minFreeMemoryMb: limits.minFreeMemoryMb },
    );
  }

  if (limits.maxLoadPerCpu > 0 && snapshot.loadPerCpu > limits.maxLoadPerCpu) {
    throw new BrowserExportError(
      'BROWSER_EXPORT_HIGH_LOAD',
      'Browser export is temporarily unavailable because server load is high. Try again shortly.',
      503,
      { label, ...snapshot, maxLoadPerCpu: limits.maxLoadPerCpu },
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function removeQueuedJob(job: QueuedBrowserExportJob): boolean {
  const index = queuedJobs.indexOf(job);
  if (index === -1) return false;
  queuedJobs.splice(index, 1);
  return true;
}

function createTimeoutError(
  job: Pick<QueuedBrowserExportJob, 'jobId' | 'label' | 'timeoutErrorMessage'>,
  timeoutMs: number,
): BrowserExportError {
  return new BrowserExportError(
    'BROWSER_EXPORT_TIMEOUT',
    job.timeoutErrorMessage ?? 'Browser export timed out. Try again.',
    504,
    { jobId: job.jobId, label: job.label, timeoutMs },
  );
}

function startNextQueuedJob(): void {
  if (activeJob || queuedJobs.length === 0) return;
  const nextJob = queuedJobs.shift();
  if (!nextJob) return;
  void executeJob(nextJob);
}

async function executeJob<T>(job: QueuedBrowserExportJob<T>): Promise<void> {
  activeJob = job as QueuedBrowserExportJob;
  if (job.waitTimer) {
    clearTimeout(job.waitTimer);
    job.waitTimer = null;
  }

  const timeoutMs = job.timeoutMs ?? DEFAULT_BROWSER_EXPORT_TIMEOUT_MS;
  const startedAt = Date.now();
  const abortController = new AbortController();
  const context: BrowserExportJobContext = {
    jobId: job.jobId,
    label: job.label,
    signal: abortController.signal,
    queuedAt: job.queuedAt,
    startedAt,
  };

  let timeout: NodeJS.Timeout | null = null;
  let timedOut = false;
  let runPromise: Promise<T> | null = null;

  try {
    assertResourceBudget(job.label);

    runPromise = activeJobContext.run(context, () => Promise.resolve().then(() => job.run(context)));
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        const timeoutError = createTimeoutError(job, timeoutMs);
        abortController.abort(timeoutError);

        void Promise.race([
          Promise.resolve(job.onTimeout?.(timeoutError, context)),
          delay(getCleanupGraceMs()),
        ])
          .catch((cleanupError) => {
            console.warn('[Browser Export] Timeout cleanup failed:', cleanupError);
          })
          .finally(() => {
            reject(timeoutError);
          });
      }, timeoutMs);
    });

    const result = await Promise.race([runPromise, timeoutPromise]);
    job.resolve(result);
  } catch (error) {
    job.reject(error);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (timedOut && runPromise) {
      runPromise.catch(() => undefined);
    }
    activeJob = null;
    startNextQueuedJob();
  }
}

export function getBrowserExportQueueStatus(): BrowserExportQueueStatus {
  return {
    active: activeJob ? 1 : 0,
    queued: queuedJobs.length,
    maxActive: MAX_ACTIVE_BROWSER_EXPORT_JOBS,
    maxQueued: getMaxQueuedJobs(),
  };
}

export function isBrowserExportError(error: unknown): error is BrowserExportError {
  return error instanceof BrowserExportError;
}

export function getBrowserExportErrorResponse(error: unknown): {
  status: number;
  body: { success: false; code: BrowserExportErrorCode; error: string };
} | null {
  if (!isBrowserExportError(error)) return null;
  return {
    status: error.status,
    body: {
      success: false,
      code: error.code,
      error: error.message,
    },
  };
}

export function runBrowserExportJob<T>(options: BrowserExportJobOptions<T>): Promise<T> {
  const parentContext = activeJobContext.getStore();
  if (parentContext) {
    return options.run(parentContext);
  }

  assertResourceBudget(options.label);

  return new Promise<T>((resolve, reject) => {
    const job: QueuedBrowserExportJob<T> = {
      jobId: `browser-export-${++jobSequence}`,
      label: options.label,
      timeoutMs: options.timeoutMs,
      timeoutErrorMessage: options.timeoutErrorMessage,
      run: options.run,
      onTimeout: options.onTimeout,
      queuedAt: Date.now(),
      resolve,
      reject,
      waitTimer: null,
    };

    if (!activeJob && queuedJobs.length === 0) {
      void executeJob(job);
      return;
    }

    const maxQueued = getMaxQueuedJobs();
    if (queuedJobs.length >= maxQueued) {
      reject(new BrowserExportError(
        'BROWSER_EXPORT_QUEUE_FULL',
        'Browser export queue is busy. Try again shortly.',
        503,
        { label: options.label, ...getBrowserExportQueueStatus() },
      ));
      return;
    }

    job.waitTimer = setTimeout(() => {
      if (!removeQueuedJob(job as QueuedBrowserExportJob)) return;
      reject(new BrowserExportError(
        'BROWSER_EXPORT_QUEUE_TIMEOUT',
        'Browser export waited too long in the queue. Try again shortly.',
        503,
        { label: options.label, ...getBrowserExportQueueStatus() },
      ));
    }, getQueueWaitTimeoutMs());

    queuedJobs.push(job as QueuedBrowserExportJob);
  });
}

export function getBrowserExportChildProcessLimits(timeoutMs = DEFAULT_MARP_BROWSER_EXPORT_TIMEOUT_MS): BrowserExportChildProcessLimits {
  return {
    memoryMb: parseIntegerEnv(
      'CANVAS_BROWSER_EXPORT_CHILD_MEMORY_MB',
      DEFAULT_CHILD_PROCESS_MEMORY_MB,
      { min: 0, max: 8192 },
    ),
    cpuSeconds: parseIntegerEnv(
      'CANVAS_BROWSER_EXPORT_CHILD_CPU_SECONDS',
      Math.max(1, Math.ceil(timeoutMs / 1000)),
      { min: 0, max: 600 },
    ),
    nice: parseIntegerEnv(
      'CANVAS_BROWSER_EXPORT_CHILD_NICE',
      DEFAULT_CHILD_PROCESS_NICE,
      { min: 0, max: 19 },
    ),
  };
}

function commandExists(command: string): boolean {
  const cached = commandAvailability.get(command);
  if (cached !== undefined) return cached;

  const result = spawnSync('which', [command], { stdio: 'ignore' }).status === 0;
  commandAvailability.set(command, result);
  return result;
}

export function buildLimitedBrowserExportCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; platform?: NodeJS.Platform } = {},
): LimitedCommandSpec {
  const platform = options.platform ?? process.platform;
  const limits = getBrowserExportChildProcessLimits(options.timeoutMs);
  const appliedLimits: string[] = [];
  let limitedCommand = command;
  let limitedArgs = [...args];

  if (platform === 'linux' && commandExists('prlimit')) {
    const prlimitArgs: string[] = [];
    if (limits.memoryMb > 0) {
      prlimitArgs.push(`--as=${limits.memoryMb * 1024 * 1024}`);
      appliedLimits.push(`memory=${limits.memoryMb}MB`);
    }
    if (limits.cpuSeconds > 0) {
      prlimitArgs.push(`--cpu=${limits.cpuSeconds}`);
      appliedLimits.push(`cpu=${limits.cpuSeconds}s`);
    }

    if (prlimitArgs.length > 0) {
      limitedArgs = [...prlimitArgs, '--', limitedCommand, ...limitedArgs];
      limitedCommand = 'prlimit';
    }
  }

  if (platform !== 'win32' && limits.nice > 0 && commandExists('nice')) {
    limitedArgs = ['-n', String(limits.nice), limitedCommand, ...limitedArgs];
    limitedCommand = 'nice';
    appliedLimits.push(`nice=${limits.nice}`);
  }

  return {
    command: limitedCommand,
    args: limitedArgs,
    appliedLimits,
  };
}

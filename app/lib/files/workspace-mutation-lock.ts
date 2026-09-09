import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';

const ACQUIRE_TIMEOUT_MS = 30_000;
const MAX_WORKSPACES = 1_024;
const MAX_WAITERS = 1_024;
const MAX_WORKSPACE_WAITERS = 64;
const STATE_KEY = Symbol.for('canvas.workspace-mutation-lock.v1');

type LockErrorCode = 'FILE_MUTATION_LOCK_TIMEOUT' | 'FILE_MUTATION_LOCK_BUSY' | 'FILE_MUTATION_LOCK_UNAVAILABLE';

export class WorkspaceMutationLockError extends Error {
  readonly status = 503;
  readonly retryable: boolean;

  constructor(readonly code: LockErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceMutationLockError';
    this.retryable = code !== 'FILE_MUTATION_LOCK_UNAVAILABLE';
  }
}

type Lease = { active: boolean };
type Waiter = { resolve: (release: () => void) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type LocalLock = { waiters: Set<Waiter> };
type SharedState = {
  locks: Map<string, LocalLock>;
  waiterCount: number;
  context: AsyncLocalStorage<ReadonlyMap<string, Lease>>;
};

// Next.js can bundle this module more than once in a process. Both the local
// queue and reentrant context must be shared by every copy.
function getSharedState(): SharedState {
  const registry = globalThis as unknown as Record<symbol, SharedState | undefined>;
  return registry[STATE_KEY] ??= {
    locks: new Map(),
    waiterCount: 0,
    context: new AsyncLocalStorage(),
  };
}

function timeoutError(): WorkspaceMutationLockError {
  return new WorkspaceMutationLockError('FILE_MUTATION_LOCK_TIMEOUT', 'Workspace file mutation is busy. Retry the operation.');
}

function releaseLocalLock(state: SharedState, key: string, lock: LocalLock): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = lock.waiters.values().next().value as Waiter | undefined;
    if (next) {
      lock.waiters.delete(next);
      state.waiterCount -= 1;
      clearTimeout(next.timer);
      next.resolve(releaseLocalLock(state, key, lock));
    } else {
      state.locks.delete(key);
    }
  };
}

function acquireLocalLock(state: SharedState, key: string, deadline: number): Promise<() => void> {
  const existing = state.locks.get(key);
  if (!existing) {
    if (state.locks.size >= MAX_WORKSPACES) {
      return Promise.reject(new WorkspaceMutationLockError('FILE_MUTATION_LOCK_BUSY', 'Too many workspace file mutations. Retry the operation.'));
    }
    const lock: LocalLock = { waiters: new Set() };
    state.locks.set(key, lock);
    return Promise.resolve(releaseLocalLock(state, key, lock));
  }
  if (existing.waiters.size >= MAX_WORKSPACE_WAITERS || state.waiterCount >= MAX_WAITERS) {
    return Promise.reject(new WorkspaceMutationLockError('FILE_MUTATION_LOCK_BUSY', 'Too many waiting file mutations. Retry the operation.'));
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        existing.waiters.delete(waiter);
        state.waiterCount -= 1;
        reject(timeoutError());
      }, Math.max(1, deadline - performance.now())),
    };
    existing.waiters.add(waiter);
    state.waiterCount += 1;
  });
}

async function openLockFile(lockPath: string): Promise<FileHandle> {
  const directory = path.dirname(lockPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o022) !== 0) {
    throw new Error('Workspace lock directory must be a private, non-symlink directory.');
  }
  // NONBLOCK ensures even a pre-existing FIFO cannot hang before fstat rejects
  // it. Never unlink lockfiles: replacing an inode would split the lock domain.
  const handle = await fs.open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) {
      throw new Error('Workspace lockfile must be a private regular file owned by the runtime user.');
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function acquireKernelLock(handle: FileHandle, deadline: number): Promise<void> {
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) return Promise.reject(timeoutError());
  const appRoot = process.env.CANVAS_APP_ROOT?.trim() || process.cwd();
  const helperPath = path.join(appRoot, 'scripts', 'runtime', 'workspace-file-lock.py');
  return new Promise((resolve, reject) => {
    // fd3 is a duplicate of the parent's open file description, not a separate
    // open(). The helper must NOT issue LOCK_UN when exiting: the parent's fd
    // retains flock until the protected operation finishes and closes it.
    const helper = spawn(process.env.CANVAS_PYTHON_PATH?.trim() || 'python3', ['-I', helperPath], {
      stdio: ['ignore', 'pipe', 'pipe', handle.fd],
    });
    let stdout = '';
    let stderr = '';
    let spawnError: Error | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      helper.kill('SIGKILL');
    }, remainingMs);
    helper.stdout?.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(0, 64); });
    helper.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 2_048); });
    helper.on('error', (error) => { spawnError = error; });
    // Wait for close even after timeout/spawn error. Closing the parent's fd
    // sooner could leave a helper alive that acquires and retains an orphan lock.
    helper.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(timeoutError());
      else if (spawnError || code !== 0 || stdout !== 'locked\n') {
        reject(new WorkspaceMutationLockError(
          'FILE_MUTATION_LOCK_UNAVAILABLE',
          `Workspace file locking is unavailable. A Python 3 runtime with flock support is required.${stderr.trim() ? ` ${stderr.trim()}` : ''}`,
          spawnError ? { cause: spawnError } : undefined,
        ));
      } else resolve();
    });
  });
}

/**
 * Serialize the complete revision-check / mutation / metadata-commit sequence
 * across processes sharing DATA on a filesystem with working flock support.
 * Callers must await all mutations inside operation; arbitrary filesystem
 * writers remain outside this advisory protocol. No critical-section timeout
 * releases the lock while its operation is still running.
 */
export async function withWorkspaceMutationLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
  if (!workspaceId.trim()) throw new Error('A workspace ID is required for a file mutation.');
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new WorkspaceMutationLockError('FILE_MUTATION_LOCK_UNAVAILABLE', 'Workspace file locking requires Linux or macOS with flock support.');
  }
  const lockPath = path.join(resolveCanvasDataRoot(), 'canvas-file-locks', `${createHash('sha256').update(workspaceId).digest('hex')}.lock`);
  const state = getSharedState();
  const inherited = state.context.getStore();
  if (inherited?.get(lockPath)?.active) return operation();

  const deadline = performance.now() + ACQUIRE_TIMEOUT_MS;
  const release = await acquireLocalLock(state, lockPath, deadline);
  let handle: FileHandle | undefined;
  const lease: Lease = { active: false };
  try {
    try {
      handle = await openLockFile(lockPath);
      await acquireKernelLock(handle, deadline);
    } catch (error) {
      if (error instanceof WorkspaceMutationLockError) throw error;
      throw new WorkspaceMutationLockError('FILE_MUTATION_LOCK_UNAVAILABLE', 'Workspace file locking could not be initialized.', { cause: error });
    }
    lease.active = true;
    const context = new Map(inherited);
    context.set(lockPath, lease);
    return await state.context.run(context, operation);
  } finally {
    // Async work created inside an earlier operation can retain its ALS store.
    // It must reacquire the lock after that operation has ended.
    lease.active = false;
    try {
      await handle?.close();
    } finally {
      release();
    }
  }
}

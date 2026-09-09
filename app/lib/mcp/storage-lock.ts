import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { resolveMcpStoragePath } from '@/app/lib/mcp/storage';
import type { McpScope } from '@/app/lib/mcp/scope';

const ACQUIRE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 40;
const LOCK_DIRECTORY_NAME = '.mcp-storage-locks';
const LOCK_VERSION = 1;

type LockOwner = {
  version: typeof LOCK_VERSION;
  pid: number;
  hostname: string;
  nonce: string;
  createdAt: string;
};

type LockPaths = {
  directory: string;
  lockPath: string;
  reapingPath: string;
};

type LockRecord = {
  owner: LockOwner;
  dev: number;
  ino: number;
};

type LockErrorCode = 'MCP_STORAGE_LOCK_TIMEOUT' | 'MCP_STORAGE_LOCK_FOREIGN_HOST' | 'MCP_STORAGE_LOCK_UNAVAILABLE';

export class McpStorageLockError extends Error {
  readonly status = 503;
  readonly retryable: boolean;

  constructor(readonly code: LockErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'McpStorageLockError';
    this.retryable = code === 'MCP_STORAGE_LOCK_TIMEOUT';
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isAlreadyPresent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}

function lockUnavailable(message: string, cause?: unknown): McpStorageLockError {
  return new McpStorageLockError('MCP_STORAGE_LOCK_UNAVAILABLE', message, cause === undefined ? undefined : { cause });
}

function lockPathsFor(storagePath: string): LockPaths {
  const digest = createHash('sha256').update(storagePath).digest('hex');
  const directory = path.join(path.dirname(storagePath), LOCK_DIRECTORY_NAME);
  const lockPath = path.join(directory, `${digest}.lock`);
  return { directory, lockPath, reapingPath: `${lockPath}.reap` };
}

function isPrivateRegularFile(stat: Stats, maxLinks: number): boolean {
  return stat.isFile()
    && stat.nlink >= 1
    && stat.nlink <= maxLinks
    && (stat.mode & 0o077) === 0
    && stat.uid === process.geteuid?.();
}

function hasExpectedOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== 'object') return false;
  const owner = value as Partial<LockOwner>;
  return owner.version === LOCK_VERSION
    && Number.isSafeInteger(owner.pid)
    && (owner.pid ?? 0) > 0
    && typeof owner.hostname === 'string'
    && owner.hostname.length > 0
    && typeof owner.nonce === 'string'
    && /^[a-f0-9]{32,}$/u.test(owner.nonce)
    && typeof owner.createdAt === 'string';
}

async function ensurePrivateLockDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) {
    throw lockUnavailable('MCP storage lock directory must be a private directory owned by the runtime user.');
  }
}

async function readLockRecord(lockPath: string, maxLinks: number): Promise<LockRecord | null> {
  let before: Stats;
  try {
    before = await fs.lstat(lockPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw lockUnavailable('MCP storage lock could not be inspected.', error);
  }
  // On macOS a path lookup that races another process's unlink can return a
  // still-open inode whose link count has already reached zero. It no longer
  // names a lock, so retry acquisition instead of treating it as hostile.
  if (before.nlink === 0) return null;
  if (!isPrivateRegularFile(before, maxLinks)) {
    throw lockUnavailable(`MCP storage lock must be a private regular file owned by the runtime user (mode=${(before.mode & 0o777).toString(8)}, links=${before.nlink}, owner=${before.uid}).`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  } catch (error) {
    if (isMissing(error)) return null;
    throw lockUnavailable('MCP storage lock metadata is invalid; remove it manually only after confirming no MCP operation is running.', error);
  }
  if (!hasExpectedOwner(parsed)) {
    throw lockUnavailable('MCP storage lock metadata is invalid; remove it manually only after confirming no MCP operation is running.');
  }

  let after: Stats;
  try {
    after = await fs.lstat(lockPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw lockUnavailable('MCP storage lock could not be inspected.', error);
  }
  if (after.nlink === 0) return null;
  if (!isPrivateRegularFile(after, maxLinks)) {
    throw lockUnavailable(`MCP storage lock must be a private regular file owned by the runtime user (mode=${(after.mode & 0o777).toString(8)}, links=${after.nlink}, owner=${after.uid}).`);
  }
  if (before.dev !== after.dev || before.ino !== after.ino) return null;
  return { owner: parsed, dev: after.dev, ino: after.ino };
}

function sameLock(left: LockRecord, right: LockRecord): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.owner.nonce === right.owner.nonce
    && left.owner.pid === right.owner.pid
    && left.owner.hostname === right.owner.hostname;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function assertRecoverableHost(owner: LockOwner): void {
  const localHostname = os.hostname();
  if (owner.hostname !== localHostname) {
    throw new McpStorageLockError(
      'MCP_STORAGE_LOCK_FOREIGN_HOST',
      `MCP storage lock belongs to host ${owner.hostname}; automatic recovery is disabled across hosts. Confirm that host is stopped before removing the lock manually.`,
    );
  }
}

async function removeIfSameLock(lockPath: string, expected: LockRecord, maxLinks: number): Promise<boolean> {
  const current = await readLockRecord(lockPath, maxLinks);
  if (!current || !sameLock(current, expected)) return false;
  await fs.unlink(lockPath).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
  return true;
}

/**
 * A reaping hard link is an atomic claim on a particular lock inode. Every
 * contender checks it before creating a lock, so once it exists no contender
 * can replace the dead lock between identity validation and unlinking it.
 */
async function reapDeadLock(paths: LockPaths, observed: LockRecord): Promise<boolean> {
  assertRecoverableHost(observed.owner);
  if (processIsAlive(observed.owner.pid)) return false;

  try {
    await fs.link(paths.lockPath, paths.reapingPath);
  } catch (error) {
    if (isMissing(error) || isAlreadyPresent(error)) return false;
    throw lockUnavailable('MCP storage dead-lock recovery could not claim the lock.', error);
  }

  try {
    // A creator can crash after publishing its hard link but before removing
    // its temporary link. Reaping then adds a third link (temp, lock, reap).
    const reaping = await readLockRecord(paths.reapingPath, 3);
    const current = await readLockRecord(paths.lockPath, 3);
    if (!reaping || !current || !sameLock(reaping, observed) || !sameLock(current, observed)) return false;
    if (processIsAlive(reaping.owner.pid)) return false;
    await removeIfSameLock(paths.lockPath, observed, 3);
    return true;
  } finally {
    await fs.unlink(paths.reapingPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

async function createLock(lockPath: string, owner: LockOwner): Promise<boolean> {
  // Publish only a fully written owner record. Creating the temporary file with
  // O_EXCL and linking it into place means a contender never observes a new,
  // empty lockfile after the lock pathname has become visible.
  const temporaryPath = `${lockPath}.${process.pid}.${owner.nonce}.tmp`;
  const handle = await fs.open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temporaryPath, lockPath);
    return true;
  } catch (error) {
    if (isAlreadyPresent(error)) return false;
    throw error;
  } finally {
    await fs.unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

async function releaseLock(paths: LockPaths, owner: LockOwner, options: { ignoreReaping?: boolean } = {}): Promise<void> {
  const reaping = await readLockRecord(paths.reapingPath, 3);
  if (reaping && !options.ignoreReaping) return;
  const current = await readLockRecord(paths.lockPath, 3);
  if (!current || current.owner.nonce !== owner.nonce || current.owner.pid !== owner.pid || current.owner.hostname !== owner.hostname) return;
  await fs.unlink(paths.lockPath).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
}

async function acquireLock(relativePath: string, scope: McpScope | null | undefined): Promise<{ paths: LockPaths; owner: LockOwner }> {
  const storagePath = resolveMcpStoragePath(relativePath, scope);
  const paths = lockPathsFor(storagePath);
  await ensurePrivateLockDirectory(paths.directory);
  const owner: LockOwner = {
    version: LOCK_VERSION,
    pid: process.pid,
    hostname: os.hostname(),
    nonce: randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

  while (true) {
    const reaping = await readLockRecord(paths.reapingPath, 3);
    if (reaping) {
      if (Date.now() >= deadline) {
        throw lockUnavailable('MCP storage dead-lock recovery did not complete. Confirm that no MCP operation is running, then remove the .reap lock manually.');
      }
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
      continue;
    }
    try {
      if (await createLock(paths.lockPath, owner)) {
        // A reaper can publish its marker after the check above, remove the
        // dead source lock, and briefly leave that marker while this create
        // succeeds. Never enter the operation in that window.
        let marker: LockRecord | null;
        try {
          marker = await readLockRecord(paths.reapingPath, 3);
        } catch (error) {
          await releaseLock(paths, owner, { ignoreReaping: true }).catch(() => undefined);
          throw error;
        }
        if (!marker) return { paths, owner };
        // This cleanup path runs only before the operation is entered. The
        // marker belongs to the old dead inode, while this owner has just
        // published a separate inode after it was removed.
        await releaseLock(paths, owner, { ignoreReaping: true });
      }
    } catch (error) {
      if (!isAlreadyPresent(error)) throw lockUnavailable('MCP storage lock could not be created.', error);
    }

    const current = await readLockRecord(paths.lockPath, 3);
    if (current) {
      assertRecoverableHost(current.owner);
      if (!processIsAlive(current.owner.pid) && await reapDeadLock(paths, current)) continue;
    }
    if (Date.now() >= deadline) {
      throw new McpStorageLockError('MCP_STORAGE_LOCK_TIMEOUT', `MCP storage for ${relativePath} is busy; lock wait exceeded 30 seconds.`);
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Serializes a storage mutation for one resolved MCP path across all local
 * Node.js processes sharing its filesystem. Dead owners are recovered only
 * when their hostname matches this host and their PID no longer exists.
 */
export async function withMcpStorageLock<T>(
  relativePath: string,
  scope: McpScope | null | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const { paths, owner } = await acquireLock(relativePath, scope);
  try {
    return await operation();
  } finally {
    await releaseLock(paths, owner);
  }
}

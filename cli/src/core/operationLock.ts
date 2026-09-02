import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { RuntimeContext } from './types';

interface OperationLockOwner {
  version: 1;
  pid: number;
  nonce: string;
  operation: string;
  createdAt: string;
}

export interface OperationLockLease {
  path: string;
  release(): Promise<void>;
}

type OperationEnvironment = Readonly<Record<string, string | undefined>>;

export function parseOperationLockTimeout(env: OperationEnvironment = process.env): number {
  const timeoutSeconds = Number(env.CANVAS_OPERATION_LOCK_TIMEOUT || 60);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 7200) {
    throw new Error('CANVAS_OPERATION_LOCK_TIMEOUT must be an integer from 1 to 7200 seconds.');
  }
  return timeoutSeconds;
}

function lockPath(context: RuntimeContext, env: OperationEnvironment): string {
  return path.resolve(env.CANVAS_OPERATION_LOCK_PATH || path.join(context.paths.installDir, '.canvas-notebook-operation.lock'));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r').catch(() => null);
  if (!handle) return;
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeOwner(directory: string, owner: OperationLockOwner): Promise<void> {
  const ownerPath = path.join(directory, 'owner.json');
  const handle = await fs.open(ownerPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(ownerPath, 0o600);
  await syncDirectory(directory);
}

async function replaceOwner(directory: string, owner: OperationLockOwner): Promise<void> {
  const ownerPath = path.join(directory, 'owner.json');
  const tempPath = path.join(directory, `.owner.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, ownerPath);
  await fs.chmod(ownerPath, 0o600);
  await syncDirectory(directory);
}

async function readOwner(directory: string): Promise<OperationLockOwner | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8')) as Partial<OperationLockOwner>;
    if (parsed.version !== 1 || !Number.isInteger(parsed.pid) || typeof parsed.nonce !== 'string' ||
      typeof parsed.operation !== 'string' || typeof parsed.createdAt !== 'string') return null;
    return parsed as OperationLockOwner;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function reclaimAbandonedLock(directory: string): Promise<boolean> {
  const [owner, stat] = await Promise.all([
    readOwner(directory),
    fs.stat(directory).catch(() => null),
  ]);
  if (!stat || Date.now() - stat.mtimeMs < 2000) return false;
  if (owner && processIsAlive(owner.pid)) return false;
  if (!owner) {
    const entries = await fs.readdir(directory).catch(() => []);
    if (entries.some((entry) => entry !== 'owner.json')) return false;
  }
  const abandonedPath = `${directory}.abandoned-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    await fs.rename(directory, abandonedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
  const movedOwner = await readOwner(abandonedPath);
  if (owner && movedOwner?.nonce !== owner.nonce) {
    await fs.rename(abandonedPath, directory).catch(() => undefined);
    return false;
  }
  await fs.rm(abandonedPath, { recursive: true, force: true });
  await syncDirectory(path.dirname(directory));
  return true;
}

export async function acquireOperationLock(
  context: RuntimeContext,
  operation: string,
  env: OperationEnvironment = process.env,
): Promise<OperationLockLease> {
  const timeoutSeconds = parseOperationLockTimeout(env);
  const directory = lockPath(context, env);
  const deadline = Date.now() + timeoutSeconds * 1000;
  const owner: OperationLockOwner = {
    version: 1,
    pid: process.pid,
    nonce: crypto.randomBytes(16).toString('hex'),
    operation,
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(directory), { recursive: true });
  const inheritToken = env.CANVAS_CLI_SELF_UPDATE_REEXEC === 'true'
    ? env.CANVAS_OPERATION_LOCK_INHERIT_TOKEN
    : '';
  if (inheritToken) {
    const inheritedOwner = await readOwner(directory);
    if (inheritedOwner?.nonce !== inheritToken) {
      throw new Error('Inherited Canvas Notebook operation lock ownership is invalid.');
    }
    owner.nonce = inheritedOwner.nonce;
    owner.operation = inheritedOwner.operation;
    owner.createdAt = inheritedOwner.createdAt;
    await replaceOwner(directory, owner);
    process.env.CANVAS_OPERATION_LOCK_NONCE = owner.nonce;
    let released = false;
    return {
      path: directory,
      release: async () => {
        if (released) return;
        released = true;
        const current = await readOwner(directory);
        if (current?.nonce !== owner.nonce || current.pid !== process.pid) return;
        await fs.rm(directory, { recursive: true, force: true });
        await syncDirectory(path.dirname(directory));
        delete process.env.CANVAS_OPERATION_LOCK_NONCE;
      },
    };
  }
  while (true) {
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.chmod(directory, 0o700);
      await writeOwner(directory, owner);
      await syncDirectory(path.dirname(directory));
      process.env.CANVAS_OPERATION_LOCK_NONCE = owner.nonce;
      let released = false;
      return {
        path: directory,
        release: async () => {
          if (released) return;
          released = true;
          const current = await readOwner(directory);
          if (current?.nonce !== owner.nonce || current.pid !== process.pid) return;
          await fs.rm(directory, { recursive: true, force: true });
          await syncDirectory(path.dirname(directory));
          delete process.env.CANVAS_OPERATION_LOCK_NONCE;
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }
    if (await reclaimAbandonedLock(directory)) continue;
    if (Date.now() >= deadline) {
      throw new Error(`Another Canvas Notebook mutation is still running; lock wait exceeded ${timeoutSeconds}s.`);
    }
    await delay(Math.min(200, Math.max(25, deadline - Date.now())));
  }
}

export function commandRequiresOperationLock(command: string, args: string[]): boolean {
  if (command === 'install' || command === 'update' || command === 'cli-update' || command === 'config-set' || command === 'config-migrate' ||
    command === 'start' || command === 'restart' || command === 'stop' || command === 'down' ||
    command === 'admin' || command === 'backup' || command === 'cleanup-logs') return true;
  if (command === 'env') return args.includes('--sync') || args.includes('--render') || args.includes('--edit');
  if (command === 'database') return args[0] === 'prepare-postgres' || args[0] === 'reconcile-postgres-auth';
  if (command === 'service') return args[0] === 'install' || args[0] === 'uninstall';
  if (command === 'swap-sync' || command === 'swap-apply' || command === 'swap-enable' || command === 'swap-disable') return true;
  if (command === 'caddy-reload' || command === 'caddy-fix') return true;
  if (command === 'auto-update-enable' || command === 'auto-update-disable' || command === 'auto-update-sync') return true;
  return false;
}

export function commandCanRunWithPendingPostgresRecovery(command: string, args: string[]): boolean {
  if (command === 'update' || command === 'start' || command === 'restart' || command === 'stop' || command === 'cli-update') return true;
  if (command === 'env') return args.includes('--sync') || args.includes('--edit');
  return command === 'database' && args[0] === 'reconcile-postgres-auth';
}

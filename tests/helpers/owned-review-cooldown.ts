import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { requireOwnedQaAgentToolSocket } from './ordinary-agent-tool';

export type ReviewSourceGeneration = {
  pid: number; processStartIdentity: string; startedAt: number; bindingHash: string;
};
type Snapshot = { stat: Stats; bytes: Buffer };
type CooldownState = { version: 1; source: ReviewSourceGeneration; lastQuiescentNs: string };
type Input = { directory: string; bindingHash: string; socketPath: string; leasePath: string; lease: FileHandle };
type Hooks = {
  readSource?: () => Promise<ReviewSourceGeneration>;
  now?: () => bigint;
  wait?: (milliseconds: number) => Promise<void>;
};
const QUIET_NS = BigInt(61_000_000_000);

function requireValue(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Owned QA review cooldown rejected (${reason}).`);
}

async function readPrivateFile(filename: string): Promise<Snapshot | undefined> {
  let file: FileHandle;
  try { file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const before = await file.stat();
    requireValue(before.isFile() && before.uid === process.getuid?.() && (before.mode & 0o777) === 0o600
      && before.nlink === 1 && before.size <= 4096, 'private file ownership');
    const bytes = await file.readFile();
    const after = await file.stat();
    requireValue(before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && before.mtimeMs === after.mtimeMs, 'stable private file');
    return { stat: after, bytes };
  } finally { await file.close(); }
}

function sourceKey(source: ReviewSourceGeneration): string {
  requireValue(Number.isSafeInteger(source.pid) && source.pid > 0
    && typeof source.processStartIdentity === 'string' && source.processStartIdentity.startsWith(`${process.getuid?.()} `)
    && source.processStartIdentity.length <= 128 && Number.isSafeInteger(source.startedAt) && source.startedAt > 0
    && source.startedAt <= Date.now() && /^[a-f0-9]{64}$/u.test(source.bindingHash), 'source generation');
  return createHash('sha256').update(JSON.stringify({ pid: source.pid, processStartIdentity: source.processStartIdentity,
    startedAt: source.startedAt, bindingHash: source.bindingHash })).digest('hex');
}

function sameSnapshot(left: Snapshot | undefined, right: Snapshot | undefined): boolean {
  return left && right ? left.stat.dev === right.stat.dev && left.stat.ino === right.stat.ino
    && left.stat.mtimeMs === right.stat.mtimeMs && left.bytes.equals(right.bytes) : left === right;
}

async function readOwnedReviewSourceGeneration(socketPath: string): Promise<ReviewSourceGeneration> {
  await requireOwnedQaAgentToolSocket(socketPath);
  const receiptPath = path.join(path.dirname(socketPath), 'host-binding.json');
  const receipt = await readPrivateFile(receiptPath);
  requireValue(receipt, 'source receipt');
  await requireOwnedQaAgentToolSocket(socketPath);
  requireValue(sameSnapshot(receipt, await readPrivateFile(receiptPath)), 'unchanged validated source receipt');
  const source = JSON.parse(receipt.bytes.toString('utf8')) as ReviewSourceGeneration;
  sourceKey(source);
  return { pid: source.pid, processStartIdentity: source.processStartIdentity,
    startedAt: source.startedAt, bindingHash: source.bindingHash };
}

/** Runs only under the caller's existing exclusive QA review lease. No API bucket is mutated. */
export async function prepareOwnedReviewCooldown(input: Input, hooks: Hooks = {}): Promise<{ markQuiescent(): Promise<void> }> {
  const directory = await lstat(input.directory);
  requireValue(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid?.()
    && (directory.mode & 0o777) === 0o700 && await realpath(input.directory) === input.directory, 'private QA parent');
  requireValue(input.leasePath === path.join(input.directory, 'document-review-fixture.lock'), 'existing review lease');
  const heldLease = await input.lease.stat();
  const verifyLease = async () => {
    const currentDirectory = await lstat(input.directory);
    const current = await lstat(input.leasePath);
    const held = await input.lease.stat();
    requireValue(currentDirectory.dev === directory.dev && currentDirectory.ino === directory.ino
      && currentDirectory.uid === directory.uid && (currentDirectory.mode & 0o777) === 0o700
      && current.isFile() && !current.isSymbolicLink() && current.uid === process.getuid?.()
      && (current.mode & 0o777) === 0o600 && current.nlink === 1
      && current.dev === heldLease.dev && current.ino === heldLease.ino
      && held.dev === heldLease.dev && held.ino === heldLease.ino, 'exclusive lease ownership');
  };
  const readSource = hooks.readSource ?? (() => readOwnedReviewSourceGeneration(input.socketPath));
  const now = hooks.now ?? (() => process.hrtime.bigint());
  const wait = hooks.wait ?? (milliseconds => delay(milliseconds));
  await verifyLease();
  const source = await readSource();
  const key = sourceKey(source);
  requireValue(source.bindingHash === input.bindingHash, 'current target binding');
  const statePath = path.join(input.directory, 'document-review-cooldown.json');
  const original = await readPrivateFile(statePath);
  if (original) {
    const state = JSON.parse(original.bytes.toString('utf8')) as CooldownState;
    requireValue(state.version === 1 && /^\d{1,30}$/u.test(state.lastQuiescentNs), 'cooldown state');
    if (sourceKey(state.source) === key) {
      const elapsed = now() - BigInt(state.lastQuiescentNs);
      requireValue(elapsed >= BigInt(0), 'monotonic quiet receipt');
      const remaining = QUIET_NS - elapsed;
      if (remaining > BigInt(0)) await wait(Number((remaining + BigInt(999_999)) / BigInt(1_000_000)));
      requireValue(now() - BigInt(state.lastQuiescentNs) >= QUIET_NS, 'completed quiet interval');
    }
  }
  requireValue(sourceKey(await readSource()) === key, 'source unchanged after wait');
  await verifyLease();
  requireValue(sameSnapshot(original, await readPrivateFile(statePath)), 'cooldown CAS after wait');
  let marked = false;
  return { markQuiescent: async () => {
    requireValue(!marked, 'single quiet receipt');
    requireValue(sourceKey(await readSource()) === key, 'source unchanged at cleanup');
    await verifyLease();
    requireValue(sameSnapshot(original, await readPrivateFile(statePath)), 'cooldown CAS at cleanup');
    const encoded = Buffer.from(`${JSON.stringify({ version: 1, source, lastQuiescentNs: String(now()) })}\n`);
    const temporaryPath = path.join(input.directory, `.document-review-cooldown-${randomUUID()}.tmp`);
    let file: FileHandle | undefined;
    let temporary: Stats | undefined;
    let published = false;
    let failed = false;
    let primary: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      file = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporary = await file.stat();
      requireValue(temporary.isFile() && temporary.uid === process.getuid?.() && (temporary.mode & 0o777) === 0o600
        && temporary.nlink === 1, 'owned temporary state');
      let written = 0;
      while (written < encoded.length) {
        const result = await file.write(encoded, written, encoded.length - written, written);
        requireValue(result.bytesWritten > 0, 'state write progress');
        written += result.bytesWritten;
      }
      await file.sync();
      await file.close();
      file = undefined;
      requireValue(sourceKey(await readSource()) === key, 'source unchanged before publication');
      await verifyLease();
      requireValue(sameSnapshot(original, await readPrivateFile(statePath)), 'cooldown CAS before publication');
      const currentTemporary = await lstat(temporaryPath);
      requireValue(currentTemporary.isFile() && !currentTemporary.isSymbolicLink() && currentTemporary.dev === temporary.dev
        && currentTemporary.ino === temporary.ino && currentTemporary.uid === temporary.uid
        && (currentTemporary.mode & 0o777) === 0o600, 'temporary publication ownership');
      await rename(temporaryPath, statePath);
      published = true;
      const verified = await readPrivateFile(statePath);
      requireValue(verified && verified.stat.dev === temporary.dev && verified.stat.ino === temporary.ino
        && verified.bytes.equals(encoded), 'published quiet receipt');
      const parent = await open(input.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
      marked = true;
    } catch (error) { failed = true; primary = error; }
    try { await file?.close(); } catch (error) { cleanupErrors.push(error); }
    if (!published && temporary) {
      try {
        const current = await lstat(temporaryPath);
        requireValue(current.isFile() && !current.isSymbolicLink() && current.dev === temporary.dev
          && current.ino === temporary.ino && current.uid === temporary.uid, 'temporary cleanup ownership');
        await unlink(temporaryPath);
      } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(failed ? [primary, ...cleanupErrors] : cleanupErrors,
      'Owned review cooldown publication or cleanup failed.');
    if (failed) throw primary;
  } };
}

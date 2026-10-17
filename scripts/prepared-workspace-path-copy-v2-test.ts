import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import io, { type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { withPreparedWorkspacePathCopy as prepare, readPreparedWorkspacePathCopy as read,
  assertPreparedWorkspacePathCopyCurrent as current, publishPreparedWorkspacePathCopy as publish,
  assertPreparedWorkspacePathCopyReceiptCurrent as receiptCurrent, withRecoveredWorkspacePathCopy as recover,
  decodePreparedWorkspacePathCopyOriginal as decode, preparedWorkspacePathCopyProof as proof,
  PreparedWorkspacePathCopyError } from '../app/lib/filesystem/prepared-workspace-path-copy';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

// Actual owned filesystem observations only. Native membership, permissions,
// original journal and plan provenance remain the fixed owner's responsibility.
type Input = Parameters<typeof prepare>[0];
type Original = ReturnType<typeof read>;
type Fixture = { base: string; input: Input; source(name: string): string; target(name: string): string };
const policy = 'native-derived-leaves-v2' as const;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const actualFstat = io.fstatSync.bind(io);
const nodeKey = (info: BigIntStats) => `${info.dev}:${info.ino}`;
const code = (expected: string) => (error: unknown) => error instanceof PreparedWorkspacePathCopyError && error.code === expected;

function workspace(rootPath: string): WorkspaceContext {
  return { workspaceId: `copy-v2-${randomUUID()}`, workspaceType: 'personal', organizationId: null, rootPath, legacy: false,
    permissions: { canRead: false, canWrite: false, canDelete: false, canRunAgent: false,
      canManageWorkspace: false, canCreatePublicLinks: false } };
}
async function withFixture(t: TestContext, operation: (fixture: Fixture) => Promise<void>): Promise<void> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-prepared-copy-v2-')));
  await fs.chmod(base, 0o700); const birth = await fs.lstat(base, { bigint: true });
  const sourceRoot = path.join(base, 'source'), targetRoot = path.join(base, 'target');
  await fs.mkdir(sourceRoot, { mode: 0o700 }); await fs.mkdir(targetRoot, { mode: 0o700 });
  const ownedNodes = new Set<string>();
  const statIo = io as unknown as { fstatSync(fd: number, options?: { bigint?: boolean }): BigIntStats };
  t.mock.method(statIo, 'fstatSync', (fd: number, options?: { bigint?: boolean }) => {
    const actual = Reflect.apply(actualFstat, io, [fd, options]) as BigIntStats;
    if (fd >= 3 && typeof actual.dev === 'bigint') ownedNodes.add(nodeKey(actual));
    return actual;
  });
  try {
    await operation({ base, source: name => path.join(sourceRoot, name), target: name => path.join(targetRoot, name),
      input: { sourceWorkspace: workspace(sourceRoot), destinationWorkspace: workspace(targetRoot),
        sourcePath: 'native.md', destinationPath: 'copy.md', sourceKind: 'regular_file',
        projectionPaths: ['native.md'], sourceProjectionPolicy: policy } });
  } finally {
    t.mock.restoreAll();
    const leaked: number[] = [];
    for (const name of io.readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd')) {
      const fd = Number(name); if (!Number.isInteger(fd) || fd < 3) continue;
      try { if (ownedNodes.has(nodeKey(actualFstat(fd, { bigint: true })))) leaked.push(fd); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error; }
    }
    assert.deepEqual(leaked, [], 'All actual owned descriptors, including replaced or unlinked source inodes, close.');
    const actual = await fs.lstat(base, { bigint: true });
    assert.equal(actual.dev, birth.dev); assert.equal(actual.ino, birth.ino); assert.equal(actual.uid, birth.uid);
    assert.equal(actual.mode & BigInt(0o777), BigInt(0o700));
    await fs.rm(base, { recursive: true, force: false });
  }
}
async function put(filename: string, bytes = 'original projection'): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
}
async function replace(filename: string, bytes = 'new checkpoint'): Promise<void> {
  const temporary = filename + '.' + randomUUID(); await put(temporary, bytes); await fs.rename(temporary, filename);
}
async function absent(filename: string): Promise<void> { await assert.rejects(fs.lstat(filename), { code: 'ENOENT' }); }
async function capture(f: Fixture, input = f.input): Promise<Original> {
  let original!: Original;
  await prepare(input, async cap => { original = read(cap); });
  return original;
}
async function recoverInput(f: Fixture, original: Original, operation: Parameters<typeof recover>[1]): Promise<void> {
  await recover({ sourceWorkspace: f.input.sourceWorkspace, destinationWorkspace: f.input.destinationWorkspace, original }, operation);
}
async function publishNativeOnly(f: Fixture, original: Original): Promise<void> {
  const before = clone(original), originalProof = proof(original);
  await recoverInput(f, original, async cap => {
    assert.deepEqual(read(cap), before); await current(cap);
    const receipt = await publish(cap); assert.equal(receipt.observation.kind, 'projection_absent');
    assert.deepEqual(receipt.original, before); assert.deepEqual(receipt.createdParents, []);
    await receiptCurrent(cap, receipt); assert.equal(proof(read(cap)), originalProof);
  });
  assert.deepEqual(original, before); await absent(f.target(original.destinationPath));
}
async function mixed(f: Fixture): Promise<{ original: Original; input: Input }> {
  await put(f.source('folder/native.md')); await put(f.source('folder/sub/delete.md'));
  await put(f.source('folder/ordinary.md'), 'literal physical Markdown asset');
  await put(f.source('folder/sub/asset.pdf'), '%PDF-1.7\nactual opaque bytes');
  await fs.mkdir(f.source('folder/empty'), { mode: 0o700 });
  const input: Input = { ...f.input, sourceKind: 'directory', sourcePath: 'folder', destinationPath: 'folder-copy',
    projectionPaths: ['folder/native.md', 'folder/sub/delete.md', 'folder/sub/new.md'] };
  return { input, original: await capture(f, input) };
}

test('V1 retains its wire shape and rejects replacement of its original native projection inode', async t => withFixture(t, async f => {
  await put(f.source('native.md'));
  const { sourceProjectionPolicy: _policy, ...input } = f.input;
  const original = await capture(f, input); assert.equal(original.version, 1);
  assert.equal(Object.hasOwn(original, 'sourceProjectionPolicy'), false); assert.deepEqual(decode(clone(original)), original);
  await replace(f.source('native.md'));
  await assert.rejects(recoverInput(f, original, async () => assert.fail('V1 must remain exact.')), code('source-changed'));
  assert.equal(await fs.readFile(f.source('native.md'), 'utf8'), 'new checkpoint'); await absent(f.target('copy.md'));
}));

test('V2 keeps immutable original facts while a native projection is replaced by another safe inode', async t => withFixture(t, async f => {
  await put(f.source('native.md')); const original = await capture(f), before = clone(original);
  assert.equal(original.version, 2); if (original.version !== 2) assert.fail();
  assert.equal(original.sourceProjectionPolicy, policy); assert(Object.isFrozen(original));
  assert.deepEqual(decode(clone(original)), original);
  const previous = await fs.stat(f.source('native.md'), { bigint: true }); await replace(f.source('native.md'));
  assert.notEqual((await fs.stat(f.source('native.md'), { bigint: true })).ino, previous.ino);
  await publishNativeOnly(f, original); assert.deepEqual(original, before);
  assert.equal(await fs.readFile(f.source('native.md'), 'utf8'), 'new checkpoint');
}));

test('V2 accepts an original absent exact native leaf becoming a safe regular projection', async t => withFixture(t, async f => {
  const original = await capture(f, { ...f.input, sourceKind: 'projection_absent' });
  assert.equal(original.source.kind, 'projection_absent'); await put(f.source('native.md'));
  await publishNativeOnly(f, original); assert.equal(await fs.readFile(f.source('native.md'), 'utf8'), 'original projection');
}));

test('V2 accepts an original projected exact native leaf becoming absent', async t => withFixture(t, async f => {
  await put(f.source('native.md')); const original = await capture(f); await fs.unlink(f.source('native.md'));
  await publishNativeOnly(f, original); await absent(f.source('native.md'));
}));

test('V2 mixed folder preserves all assets and empty directories while exact projection leaves replace, disappear and appear', async t => withFixture(t, async f => {
  const { original } = await mixed(f), before = clone(original);
  await replace(f.source('folder/native.md')); await fs.unlink(f.source('folder/sub/delete.md'));
  await put(f.source('folder/sub/new.md'), 'new native-only projection');
  await recoverInput(f, original, async cap => {
    await current(cap); assert.deepEqual(read(cap), before);
    const receipt = await publish(cap); assert.equal(receipt.observation.kind, 'published'); await receiptCurrent(cap, receipt);
  });
  assert.deepEqual(original, before);
  assert.equal(await fs.readFile(f.target('folder-copy/ordinary.md'), 'utf8'), 'literal physical Markdown asset');
  assert.equal(await fs.readFile(f.target('folder-copy/sub/asset.pdf'), 'utf8'), '%PDF-1.7\nactual opaque bytes');
  assert((await fs.stat(f.target('folder-copy/empty'))).isDirectory());
  for (const name of ['native.md', 'sub/delete.md', 'sub/new.md']) await absent(f.target('folder-copy/' + name));
}));

test('V2 leaves clocks of directories outside projection ancestry exact', async t => withFixture(t, async f => {
  const { original } = await mixed(f), directory = f.source('folder/empty'), before = await fs.stat(directory);
  await fs.utimes(directory, before.atime, new Date(before.mtimeMs + 10_000));
  await assert.rejects(recoverInput(f, original, async () => assert.fail()), code('source-changed'));
  await absent(f.target('folder-copy'));
}));

test('V2 keeps actual directory mode immutable even on native projection ancestry', async t => withFixture(t, async f => {
  const { original } = await mixed(f); await fs.chmod(f.source('folder/sub'), 0o750);
  await assert.rejects(recoverInput(f, original, async () => assert.fail()), code('source-changed'));
  assert.equal((await fs.stat(f.source('folder/sub'))).mode & 0o777, 0o750);
}));

test('V2 does not allow replacing a source directory with an identical different inode', async t => withFixture(t, async f => {
  const { original } = await mixed(f); await fs.rename(f.source('folder'), f.source('old-folder'));
  await put(f.source('folder/native.md')); await put(f.source('folder/sub/delete.md'));
  await put(f.source('folder/ordinary.md'), 'literal physical Markdown asset');
  await put(f.source('folder/sub/asset.pdf'), '%PDF-1.7\nactual opaque bytes');
  await fs.mkdir(f.source('folder/empty'), { mode: 0o700 });
  await assert.rejects(recoverInput(f, original, async () => assert.fail()), code('source-changed'));
  await absent(f.target('folder-copy'));
}));

for (const mutation of ['replace', 'remove', 'add'] as const) test(`V2 rejects nonprojection asset ${mutation}`, async t => withFixture(t, async f => {
  const { original } = await mixed(f);
  if (mutation === 'replace') await replace(f.source('folder/ordinary.md'), 'foreign physical Markdown');
  else if (mutation === 'remove') await fs.unlink(f.source('folder/sub/asset.pdf'));
  else await put(f.source('folder/foreign.bin'), 'foreign asset');
  await assert.rejects(recoverInput(f, original, async () => assert.fail()), code('source-changed'));
  await absent(f.target('folder-copy'));
}));

for (const kind of ['symlink', 'hardlink', 'directory'] as const) test(`V2 rejects an unsafe native projection ${kind}`, async t => withFixture(t, async f => {
  await put(f.source('native.md')); const original = await capture(f); await fs.unlink(f.source('native.md'));
  await put(f.source('other.bin'), 'neighbor must survive');
  if (kind === 'symlink') await fs.symlink(f.source('other.bin'), f.source('native.md'));
  else if (kind === 'hardlink') await fs.link(f.source('other.bin'), f.source('native.md'));
  else await fs.mkdir(f.source('native.md'), { mode: 0o700 });
  await assert.rejects(recoverInput(f, original, async () => assert.fail()), code(kind === 'hardlink' ? 'unsafe-path' : 'source-changed'));
  assert.equal(await fs.readFile(f.source('other.bin'), 'utf8'), 'neighbor must survive'); await absent(f.target('copy.md'));
}));

test('V2 freshly checks native leaf binding after an actual open/stat ACK race', async t => withFixture(t, async f => {
  await put(f.source('native.md')); await put(f.source('other.bin'), 'neighbor'); const original = await capture(f);
  const originalNode = await fs.stat(f.source('native.md'), { bigint: true }); let fired = false;
  const before = io.fstatSync.bind(io), statIo = io as unknown as { fstatSync(fd: number, options?: { bigint?: boolean }): BigIntStats };
  t.mock.method(statIo, 'fstatSync', (fd: number, options?: { bigint?: boolean }) => {
    const actual = Reflect.apply(before, io, [fd, options]) as BigIntStats;
    if (!fired && actual.ino === originalNode.ino && actual.dev === originalNode.dev) {
      // Keep the held descriptor's nlink=1 profile valid so the fresh named
      // leaf check, rather than the earlier unsafe-FD check, detects the race.
      fired = true; io.renameSync(f.source('native.md'), f.source('ownedheld-native.md')); io.symlinkSync(f.source('other.bin'), f.source('native.md'));
    }
    return actual;
  });
  await assert.rejects(recoverInput(f, original, async () => assert.fail()), code('source-changed')); assert.equal(fired, true);
  assert.equal(await fs.readFile(f.source('other.bin'), 'utf8'), 'neighbor');
}));

test('V2 does not adopt a newly materialized source parent', async t => withFixture(t, async f => {
  const original = await capture(f, { ...f.input, sourcePath: 'missing/native.md', sourceKind: 'projection_absent', projectionPaths: ['missing/native.md'] });
  await put(f.source('missing/native.md'), 'checkpoint under a new parent');
  await assert.rejects(recoverInput(f, original, async () => assert.fail()), code('recovery-conflict'));
  assert.equal(await fs.readFile(f.source('missing/native.md'), 'utf8'), 'checkpoint under a new parent');
}));

test('V2 does not allow a logical absent folder to become a physical directory', async t => withFixture(t, async f => {
  const original = await capture(f, { ...f.input, sourcePath: 'logical', sourceKind: 'projection_absent', projectionPaths: ['logical/native.md'] });
  await put(f.source('logical/native.md'));
  await assert.rejects(recoverInput(f, original, async () => assert.fail()), code('source-changed'));
}));

test('V2 still rejects D2 and preserves the original staged asset payload', async t => withFixture(t, async f => {
  const { original } = await mixed(f); assert(original.staging);
  const payload = f.target(original.staging.relativePath + '/payload/sub/asset.pdf');
  const bytes = await fs.readFile(payload), payloadNode = await fs.stat(payload, { bigint: true });
  await put(f.target('folder-copy/foreign.bin'), 'D2'); const d2 = await fs.stat(f.target('folder-copy'), { bigint: true });
  await replace(f.source('folder/native.md'));
  await assert.rejects(recoverInput(f, original, async () => assert.fail()), code('recovery-conflict'));
  assert.equal((await fs.stat(f.target('folder-copy'), { bigint: true })).ino, d2.ino);
  assert.equal(await fs.readFile(f.target('folder-copy/foreign.bin'), 'utf8'), 'D2');
  assert.equal((await fs.stat(payload, { bigint: true })).ino, payloadNode.ino); assert.deepEqual(await fs.readFile(payload), bytes);
}));

test('V2 remains bounded when additional exact projection leaves appear', async t => withFixture(t, async f => {
  await put(f.source('folder/asset.bin'), 'asset');
  const original = await capture(f, { ...f.input, sourceKind: 'directory', sourcePath: 'folder', destinationPath: 'folder-copy',
    projectionPaths: ['folder/native.md'], budget: { maxDepth: 32, maxEntries: 2, maxHashBytes: 4 * 1024 ** 3 } });
  await put(f.source('folder/native.md'));
  await assert.rejects(recoverInput(f, original, async () => assert.fail()), code('budget-exceeded'));
  assert.equal(await fs.readFile(f.source('folder/asset.bin'), 'utf8'), 'asset'); await absent(f.target('folder-copy'));
}));

test('V2 discriminator and policy are strict detached data, with trap-free shared capture', async t => withFixture(t, async f => {
  await put(f.source('native.md')); const original = await capture(f);
  for (const mutation of [
    (value: Record<string, unknown>) => { delete value.sourceProjectionPolicy; },
    (value: Record<string, unknown>) => { value.sourceProjectionPolicy = undefined; },
    (value: Record<string, unknown>) => { value.sourceProjectionPolicy = 'unknown'; },
    (value: Record<string, unknown>) => { value.version = 1; },
    (value: Record<string, unknown>) => { value.extra = true; },
  ]) {
    const value = clone(original) as unknown as Record<string, unknown>; mutation(value); assert.throws(() => decode(value), code('invalid-input'));
  }
  let traps = 0;
  const proxy = new Proxy(original, { getPrototypeOf() { traps++; throw new Error('must not execute'); }, ownKeys() { traps++; throw new Error('must not execute'); } });
  assert.throws(() => decode(proxy), code('invalid-input')); assert.equal(traps, 0);
  const accessor = { ...original }; let getters = 0;
  Object.defineProperty(accessor, 'version', { enumerable: true, get() { getters++; return 2; } });
  assert.throws(() => decode(accessor), code('invalid-input')); assert.equal(getters, 0);
  await assert.rejects(prepare({ ...f.input, sourceProjectionPolicy: undefined } as unknown as Input,
    async () => assert.fail()), code('invalid-input'));
}));

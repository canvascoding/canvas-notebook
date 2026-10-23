import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import io, { type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { withPreparedWorkspacePathCopy as prepare, readPreparedWorkspacePathCopy as read,
  readPreparedWorkspacePathCopyDisposition as disposition, assertPreparedWorkspacePathCopyCurrent as current,
  publishPreparedWorkspacePathCopy as publish, assertPreparedWorkspacePathCopyReceiptCurrent as receiptCurrent,
  assertPreparedWorkspacePathCopyParentReceipt as parentCurrent, withRecoveredWorkspacePathCopy as recover,
  discardPreparedWorkspacePathCopy as discard, PreparedWorkspacePathCopyError } from '../app/lib/filesystem/prepared-workspace-path-copy';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

type Input = Parameters<typeof prepare>[0];
type Capability = Parameters<typeof read>[0];
type Original = ReturnType<typeof read>;
type ParentReceipt = Parameters<typeof parentCurrent>[1];
type Fixture = { base: string; sourceRoot: string; targetRoot: string; input: Input;
  source(relative: string): string; target(relative: string): string };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const code = (...expected: string[]) => (error: unknown) => error instanceof PreparedWorkspacePathCopyError && expected.includes(error.code);
const nodeKey = (info: BigIntStats) => `${info.dev}:${info.ino}`;
const actualFstat = io.fstatSync.bind(io);
const history = new Map<string, Set<string>>();
function remember(filename: string, info: BigIntStats): void {
  for (const [base, known] of history) if (filename === base || filename.startsWith(base + path.sep)) known.add(nodeKey(info));
}
function nodes(filename: string, known: Set<string> = new Set()): Set<string> {
  const info = io.lstatSync(filename, { bigint: true }); known.add(nodeKey(info)); remember(filename, info);
  if (info.isDirectory() && !info.isSymbolicLink()) for (const name of io.readdirSync(filename)) nodes(path.join(filename, name), known);
  return known;
}
function ownedDescriptors(base: string): number[] {
  const known = nodes(base, history.get(base)), result: number[] = [];
  for (const name of io.readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd')) {
    const fd = Number(name); if (!Number.isInteger(fd) || fd < 3) continue;
    try { if (known.has(nodeKey(actualFstat(fd, { bigint: true })))) result.push(fd); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error; }
  }
  return result.sort((a, b) => a - b);
}
function workspace(rootPath: string): WorkspaceContext {
  return { workspaceId: `ws-${randomUUID()}`, workspaceType: 'personal', organizationId: null,
    rootPath, legacy: false, permissions: { canRead: false, canWrite: false, canDelete: false,
      canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false } };
}
async function fixture(t: TestContext, run: (f: Fixture) => Promise<void>): Promise<void> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-prepared-path-copy-')));
  await fs.chmod(base, 0o700); const birth = await fs.lstat(base, { bigint: true });
  const sourceRoot = path.join(base, 'source'), targetRoot = path.join(base, 'target');
  await fs.mkdir(sourceRoot, { mode: 0o700 }); await fs.mkdir(targetRoot, { mode: 0o700 });
  history.set(base, nodes(base));
  // The production core fstats every native-returned FD. Retain those actual
  // inode identities even if preparation fails and unlinks staging before a
  // callback can enumerate it; an orphaned descriptor must still be detected.
  const realStat = io.fstatSync.bind(io);
  const statIo = io as unknown as { fstatSync(fd: number, options?: { bigint?: boolean }): BigIntStats };
  t.mock.method(statIo, 'fstatSync', (fd: number, options?: { bigint?: boolean }) => {
    const actual = Reflect.apply(realStat, io, [fd, options]) as BigIntStats;
    if (fd >= 3 && typeof actual.dev === 'bigint') history.get(base)!.add(nodeKey(actual));
    return actual;
  });
  const input: Input = { sourceWorkspace: workspace(sourceRoot), destinationWorkspace: workspace(targetRoot),
    sourcePath: 'note.md', destinationPath: 'copy.md', sourceKind: 'regular_file' };
  try { await run({ base, sourceRoot, targetRoot, input, source: name => path.join(sourceRoot, name), target: name => path.join(targetRoot, name) }); }
  finally {
    t.mock.restoreAll();
    try {
      assert.deepEqual(ownedDescriptors(base), [], 'Every actual owned native/openat FD, including unlinked historical objects, closes.');
      const actual = await fs.lstat(base, { bigint: true });
      assert.equal(actual.dev, birth.dev); assert.equal(actual.ino, birth.ino); assert.equal(actual.uid, birth.uid);
      assert.equal(actual.mode & BigInt(0o777), BigInt(0o700));
      await fs.rm(base, { recursive: true, force: false });
    } finally { history.delete(base); }
  }
}
async function put(filename: string, bytes: string | Buffer = 'original'): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); remember(filename, io.lstatSync(filename, { bigint: true }));
}
async function absent(filename: string): Promise<void> { await assert.rejects(fs.lstat(filename), { code: 'ENOENT' }); }
function present(filename: string): boolean { try { io.lstatSync(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
function frozen(value: unknown): void {
  if (value && typeof value === 'object') { assert(Object.isFrozen(value)); for (const child of Object.values(value)) frozen(child); }
}
function snapshot(filename: string): unknown {
  const info = io.lstatSync(filename, { bigint: true }); remember(filename, info);
  const common = { device: String(info.dev), inode: String(info.ino), mode: Number(info.mode), uid: Number(info.uid), gid: Number(info.gid), linkCount: String(info.nlink) };
  if (info.isFile()) return { ...common, kind: 'file', size: String(info.size), sha256: digest(io.readFileSync(filename)) };
  if (info.isDirectory()) return { ...common, kind: 'directory', entries: io.readdirSync(filename).sort().map(name => [name, snapshot(path.join(filename, name))]) };
  if (info.isSymbolicLink()) return { ...common, kind: 'symlink', target: io.readlinkSync(filename) };
  return { ...common, kind: 'special' };
}
function contents(filename: string): unknown {
  const info = io.lstatSync(filename, { bigint: true }); remember(filename, info);
  if (info.isDirectory()) return { kind: 'directory', entries: io.readdirSync(filename).sort().map(name => [name, contents(path.join(filename, name))]) };
  assert(info.isFile()); return { kind: 'file', size: String(info.size), sha256: digest(io.readFileSync(filename)) };
}
function stages(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const name of io.readdirSync(directory)) {
      const filename = path.join(directory, name), info = io.lstatSync(filename, { bigint: true }); remember(filename, info);
      if (name.startsWith('.canvas-create-') && name.endsWith('.tmp')) { result.push(filename); nodes(filename); }
      else if (info.isDirectory() && !info.isSymbolicLink()) visit(filename);
    }
  };
  visit(root); return result.sort();
}
function payload(root: string): string {
  const containers = stages(root); assert.equal(containers.length, 1);
  assert.equal(io.lstatSync(containers[0]).mode & 0o777, 0o700);
  const names = io.readdirSync(containers[0]); assert.equal(names.length, 1);
  return path.join(containers[0], names[0]);
}
function privateModes(filename: string): void {
  const info = io.lstatSync(filename);
  assert.equal(info.mode & 0o777, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory()) for (const name of io.readdirSync(filename)) privateModes(path.join(filename, name));
  else { assert(info.isFile()); assert.equal(info.nlink, 1); }
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Actual copy FS barrier timed out.')), 5_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
type ReadCallback = (error: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer) => void;
type SyncCallback = (error: NodeJS.ErrnoException | null) => void;
const observedIo = io as unknown as { read(fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: ReadCallback): void;
  fsync(fd: number, callback: SyncCallback): void; closeSync(fd: number): void };

test('opaque >6MiB file is fully private/staged off-target before callback and atomically published as a fresh inode', async t => fixture(t, async f => {
  const bytes = Buffer.alloc(6 * 1024 * 1024 + 13, 0xad); bytes.set([0xef, 0xbb, 0xbf, 0, 255]);
  const input = { ...f.input, sourcePath: ' Folder / note.md ', destinationPath: ' copy.md ' };
  await put(f.source(input.sourcePath), bytes); await put(f.target('neighbor.md'), 'neighbor');
  const original = snapshot(f.source(input.sourcePath)), sourceNode = io.lstatSync(f.source(input.sourcePath), { bigint: true });
  const receipt = await prepare(input, async cap => {
    const facts = read(cap); frozen(facts); assert.deepEqual(clone(facts), facts); assert.deepEqual(Reflect.ownKeys(cap), []);
    assert.equal(disposition(cap), 'pending'); await absent(f.target(input.destinationPath));
    const staged = payload(f.targetRoot); privateModes(staged);
    assert.deepEqual(await fs.readFile(staged), bytes); assert.notEqual(io.statSync(staged, { bigint: true }).ino, sourceNode.ino);
    await current(cap); const result = await publish(cap); await current(cap); await receiptCurrent(cap, result); return result;
  });
  frozen(receipt); assert.equal(receipt.observation.kind, 'published');
  if (receipt.observation.kind !== 'published') assert.fail();
  assert.equal(receipt.observation.method, 'rename-no-replace'); assert.deepEqual(receipt.createdParents, []);
  assert.deepEqual(await fs.readFile(f.target(input.destinationPath)), bytes);
  assert.deepEqual(snapshot(f.source(input.sourcePath)), original); assert.equal(io.statSync(f.target(input.destinationPath)).nlink, 1);
  assert.notEqual(io.statSync(f.target(input.destinationPath), { bigint: true }).ino, sourceNode.ino);
  assert.equal(await fs.readFile(f.target('neighbor.md'), 'utf8'), 'neighbor'); assert.deepEqual(stages(f.targetRoot), []);
}));

test('mixed folder includes opaque PDF/image/Markdown assets and empty directories while absent native children stay absent', async t => fixture(t, async f => {
  await fs.mkdir(f.source('folder/a'), { recursive: true, mode: 0o700 });
  await fs.mkdir(f.source('folder/empty'), { mode: 0o700 });
  await put(f.source('folder/a/file.md'), '# literal markdown\r\n'); await put(f.source('folder/document.pdf'), '%PDF-1.7\nfixture\n');
  await put(f.source('folder/image.bin'), Buffer.from([0, 255, 2, 128]));
  const input: Input = { ...f.input, sourcePath: 'folder', destinationPath: 'folder-copy', sourceKind: 'directory' };
  const original = snapshot(f.source('folder')), expected = contents(f.source('folder'));
  await prepare(input, async cap => {
    assert.deepEqual(contents(payload(f.targetRoot)), expected); await absent(f.target('folder-copy'));
    await absent(path.join(payload(f.targetRoot), 'native-only.md'));
    privateModes(payload(f.targetRoot)); const result = await publish(cap); await receiptCurrent(cap, result);
  });
  assert.deepEqual(contents(f.target('folder-copy')), expected); assert.deepEqual(snapshot(f.source('folder')), original);
  await absent(f.source('folder/native-only.md')); await absent(f.target('folder-copy/native-only.md'));
  assert.notEqual(io.statSync(f.target('folder-copy'), { bigint: true }).ino, io.statSync(f.source('folder'), { bigint: true }).ino);
  assert.deepEqual(stages(f.targetRoot), []);
}));

test('native-only file and logical-folder absence create no stage, file, target directory or invented content', async t => {
  for (const directory of [false, true]) await fixture(t, async f => {
    const input: Input = { ...f.input, sourcePath: directory ? 'logical-folder' : 'native-only.md',
      destinationPath: directory ? 'new/deeper/copied-logical-folder' : 'new/deeper/native-copy.md', sourceKind: 'projection_absent',
      ...(directory ? { projectionPaths: ['logical-folder/native-only.md'] } : {}) };
    const source = snapshot(f.sourceRoot), target = snapshot(f.targetRoot);
    const receipt = await prepare(input, async cap => {
      assert.equal(disposition(cap), 'projection_absent'); assert.deepEqual(stages(f.targetRoot), []);
      await current(cap); const result = await publish(cap); await receiptCurrent(cap, result); return result;
    });
    assert.equal(receipt.observation.kind, 'projection_absent'); assert.deepEqual(receipt.createdParents, []);
    assert.deepEqual(snapshot(f.sourceRoot), source); assert.deepEqual(snapshot(f.targetRoot), target);
  });
});

test('preparation leaves target parents absent and publish journals each actual synced parent before its child', async t => fixture(t, async f => {
  await put(f.source('note.md')); const births: ParentReceipt[] = [];
  const input = { ...f.input, destinationPath: 'new/deeper/copy.md' };
  const synced = new Set<string>(), realSync = observedIo.fsync.bind(observedIo);
  t.mock.method(observedIo, 'fsync', (fd: number, callback: SyncCallback) => {
    const key = nodeKey(io.fstatSync(fd, { bigint: true }));
    realSync(fd, error => { if (!error) synced.add(key); callback(error); });
  });
  await prepare(input, async cap => {
    await absent(f.target('new')); assert.equal(stages(f.targetRoot).length, 1);
    const receipt = await publish(cap, async birth => {
      parentCurrent(cap, birth); frozen(birth); births.push(birth);
      assert(io.lstatSync(f.target(birth.relativePath)).isDirectory());
      assert(synced.has(nodeKey(io.statSync(f.target(birth.relativePath), { bigint: true }))));
      assert(synced.has(nodeKey(io.statSync(path.dirname(f.target(birth.relativePath)), { bigint: true }))));
      if (birth.relativePath === 'new') await absent(f.target('new/deeper'));
      await absent(f.target(input.destinationPath));
    });
    assert.deepEqual(births.map(birth => birth.relativePath), ['new', 'new/deeper']);
    assert.deepEqual(receipt.createdParents, births); await receiptCurrent(cap, receipt);
  });
  assert.equal(await fs.readFile(f.target(input.destinationPath), 'utf8'), 'original'); assert.deepEqual(stages(f.targetRoot), []);
}));

test('missing-parent publication without a durable journal callback leaves source and off-target stage intact', async t => fixture(t, async f => {
  await put(f.source('note.md')); const input = { ...f.input, destinationPath: 'new/copy.md' };
  await assert.rejects(prepare(input, async cap => { await publish(cap); }), code('parent-journal-required'));
  await absent(f.target('new')); assert.equal(await fs.readFile(f.source('note.md'), 'utf8'), 'original');
  assert.equal(stages(f.targetRoot).length, 1); assert.equal(await fs.readFile(payload(f.targetRoot), 'utf8'), 'original');
}));

test('explicit discard removes only an owned unpublished stage and preserves both workspaces', async t => fixture(t, async f => {
  await put(f.source('note.md')); await put(f.target('neighbor.md'), 'keep'); const source = snapshot(f.sourceRoot);
  await prepare(f.input, async cap => {
    assert.equal(stages(f.targetRoot).length, 1); await discard(cap); assert.deepEqual(stages(f.targetRoot), []);
    await absent(f.target('copy.md'));
  });
  assert.deepEqual(snapshot(f.sourceRoot), source); assert.equal(await fs.readFile(f.target('neighbor.md'), 'utf8'), 'keep');
}));

test('exact native projection omission binds identity but reads no projection bytes and creates no invented file or parents', async t => fixture(t, async f => {
  await put(f.source('note.md'), 'stale native projection is not authority');
  const info = io.lstatSync(f.source('note.md'), { bigint: true }), original = snapshot(f.source('note.md'));
  const input: Input = { ...f.input, destinationPath: 'new/deeper/copy.md', projectionPaths: ['note.md'],
    budget: { maxDepth: 0, maxEntries: 1, maxHashBytes: 0 } };
  const realRead = observedIo.read.bind(observedIo);
  t.mock.method(observedIo, 'read', (fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: ReadCallback) => {
    assert.notEqual(nodeKey(io.fstatSync(fd, { bigint: true })), nodeKey(info), 'An exact omitted projection must not be hashed or copied.');
    realRead(fd, buffer, offset, length, position, callback);
  });
  const receipt = await prepare(input, async cap => {
    assert.equal(disposition(cap), 'projection_absent'); assert.deepEqual(stages(f.targetRoot), []);
    await current(cap); const result = await publish(cap); await receiptCurrent(cap, result); return result;
  });
  assert.equal(receipt.observation.kind, 'projection_absent'); await absent(f.target('new'));
  assert.deepEqual(snapshot(f.source('note.md')), original);
}));

test('mixed native omissions are exact owner data, not extension or glob filters, and retain ordinary assets plus empty directories', async t => fixture(t, async f => {
  await put(f.source('folder/native.weird'), 'stale physical native bytes');
  await put(f.source('folder/ordinary.md'), '# ordinary Markdown must copy\n');
  await put(f.source('folder/document.pdf'), '%PDF-owned'); await put(f.source('folder/native.weird-sibling'), 'ordinary sibling');
  await fs.mkdir(f.source('folder/empty'), { mode: 0o700 });
  const input: Input = { ...f.input, sourcePath: 'folder', destinationPath: 'folder-copy', sourceKind: 'directory',
    projectionPaths: ['folder/native.weird', 'folder/native-only.md'] };
  const source = snapshot(f.source('folder')), omittedKey = nodeKey(io.lstatSync(f.source('folder/native.weird'), { bigint: true }));
  const realRead = observedIo.read.bind(observedIo);
  t.mock.method(observedIo, 'read', (fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: ReadCallback) => {
    assert.notEqual(nodeKey(io.fstatSync(fd, { bigint: true })), omittedKey); realRead(fd, buffer, offset, length, position, callback);
  });
  await prepare(input, async cap => {
    await absent(path.join(payload(f.targetRoot), 'native.weird')); await absent(path.join(payload(f.targetRoot), 'native-only.md'));
    const receipt = await publish(cap); await receiptCurrent(cap, receipt);
  });
  await absent(f.target('folder-copy/native.weird')); await absent(f.target('folder-copy/native-only.md'));
  assert.equal(await fs.readFile(f.target('folder-copy/ordinary.md'), 'utf8'), '# ordinary Markdown must copy\n');
  assert.equal(await fs.readFile(f.target('folder-copy/native.weird-sibling'), 'utf8'), 'ordinary sibling');
  assert.equal(await fs.readFile(f.target('folder-copy/document.pdf'), 'utf8'), '%PDF-owned');
  assert.deepEqual(await fs.readdir(f.target('folder-copy/empty')), []); assert.deepEqual(snapshot(f.source('folder')), source);
}));

test('projection omission cannot cover directories, symlinks, hardlinks, outside paths or a replaced original native projection', async t => {
  for (const kind of ['directory', 'symlink', 'hardlink', 'outside', 'replace'] as const) await fixture(t, async f => {
    await put(f.source('folder/note.md'), 'projection');
    let input: Input = { ...f.input, sourcePath: 'folder', destinationPath: 'copy', sourceKind: 'directory', projectionPaths: ['folder/note.md'] };
    if (kind === 'directory') { await fs.unlink(f.source('folder/note.md')); await fs.mkdir(f.source('folder/note.md'), { mode: 0o700 }); }
    else if (kind === 'symlink') { await fs.unlink(f.source('folder/note.md')); await fs.symlink('../outside', f.source('folder/note.md')); }
    else if (kind === 'hardlink') await fs.link(f.source('folder/note.md'), f.source('external-link'));
    else if (kind === 'outside') input = { ...input, projectionPaths: ['outside.md'] };
    if (kind === 'replace') {
      await assert.rejects(prepare(input, async cap => {
        await fs.rename(f.source('folder/note.md'), f.source('original-projection'));
        await put(f.source('folder/note.md'), 'same path foreign projection'); await publish(cap);
      }), code('source-changed'));
      assert.equal(await fs.readFile(f.source('folder/note.md'), 'utf8'), 'same path foreign projection');
    } else await assert.rejects(prepare(input, async () => assert.fail('Unsafe omissions cannot create a callback.')),
      code(kind === 'outside' ? 'invalid-input' : 'unsafe-path'));
    await absent(f.target('copy'));
  });
});

test('reduced unique-byte, entry and depth budgets accept exact boundaries and reject one excess before publication', async t => {
  for (const mode of ['file-exact', 'file-over', 'empty-file', 'entries-exact', 'entries-over', 'depth-exact', 'depth-over', 'hash-total-over', 'empty-directory'] as const) await fixture(t, async f => {
    const isFile = ['file-exact', 'file-over', 'empty-file'].includes(mode);
    let input: Input = { ...f.input, sourceKind: isFile ? 'regular_file' : 'directory', budget: { maxDepth: 1, maxEntries: 3, maxHashBytes: 3 } };
    if (isFile) await put(f.source('note.md'), mode === 'empty-file' ? '' : mode === 'file-over' ? '1234' : '123');
    else {
      await fs.mkdir(f.source('note.md'), { mode: 0o700 });
      if (mode === 'empty-directory') input = { ...input, budget: { maxDepth: 0, maxEntries: 1, maxHashBytes: 0 } };
      else if (mode.startsWith('depth-')) {
        await fs.mkdir(f.source('note.md/a'), { mode: 0o700 });
        if (mode === 'depth-over') await put(f.source('note.md/a/b'), '');
      } else {
        await put(f.source('note.md/a'), mode === 'hash-total-over' ? '12' : '123');
        await fs.mkdir(f.source('note.md/empty'), { mode: 0o700 });
        if (mode === 'entries-over') await put(f.source('note.md/z'), '');
        if (mode === 'hash-total-over') { await put(f.source('note.md/z'), '34'); input = { ...input, budget: { maxDepth: 1, maxEntries: 4, maxHashBytes: 3 } }; }
      }
    }
    if (mode === 'empty-file') input = { ...input, budget: { maxDepth: 0, maxEntries: 1, maxHashBytes: 0 } };
    const before = snapshot(f.source('note.md'));
    if (mode.endsWith('-over')) {
      await assert.rejects(prepare(input, async () => assert.fail('An over-budget source cannot enter callback.')), code('budget-exceeded'));
      await absent(f.target('copy.md')); assert.deepEqual(stages(f.targetRoot), []);
    } else { await prepare(input, publish); assert.deepEqual(contents(f.target('copy.md')), contents(f.source('note.md'))); }
    assert.deepEqual(snapshot(f.source('note.md')), before);
  });
});

test('unsafe source/root/ancestor links, hardlinks and recursive special entries fail without publishing or altering neighbors', async t => {
  for (const kind of ['source-link', 'ancestor-link', 'root-link', 'hardlink', 'nested-link', 'fifo', 'writable-file', 'writable-directory'] as const) await fixture(t, async f => {
    let input: Input = f.input;
    await put(f.source('neighbor'), 'keep');
    if (kind === 'source-link') await fs.symlink('neighbor', f.source('note.md'));
    else if (kind === 'ancestor-link') { await fs.mkdir(f.source('real'), { mode: 0o700 }); await put(f.source('real/note.md')); await fs.symlink('real', f.source('alias')); input = { ...input, sourcePath: 'alias/note.md' }; }
    else if (kind === 'root-link') { const alias = path.join(f.base, 'source-alias'); await fs.symlink(f.sourceRoot, alias); input = { ...input, sourceWorkspace: { ...input.sourceWorkspace, rootPath: alias } }; }
    else if (kind === 'hardlink') { await put(f.source('note.md')); await fs.link(f.source('note.md'), f.source('external-link')); }
    else if (kind === 'nested-link') { await fs.mkdir(f.source('note.md'), { mode: 0o700 }); await fs.symlink('../neighbor', f.source('note.md/alias')); input = { ...input, sourceKind: 'directory' }; }
    else if (kind === 'fifo') { execFileSync('mkfifo', [f.source('note.md')]); }
    else if (kind === 'writable-file') { await put(f.source('note.md')); await fs.chmod(f.source('note.md'), 0o622); }
    else { await fs.mkdir(f.source('note.md'), { mode: 0o700 }); await fs.chmod(f.source('note.md'), 0o722); input = { ...input, sourceKind: 'directory' }; }
    const source = snapshot(f.sourceRoot);
    await assert.rejects(prepare(input, async () => assert.fail('Unsafe source cannot enter callback.')), code('unsafe-path'));
    assert.deepEqual(snapshot(f.sourceRoot), source); assert.deepEqual(stages(f.targetRoot), []); await absent(f.target('copy.md'));
    assert.equal(await fs.readFile(f.source('neighbor'), 'utf8'), 'keep');
  });
});

test('initial and late no-replace occupants preserve exact file, nonempty-directory and symlink D2 identities', async t => {
  for (const when of ['initial', 'late'] as const) for (const kind of ['file', 'directory', 'symlink'] as const) await fixture(t, async f => {
    await put(f.source('note.md')); const source = snapshot(f.source('note.md')); let occupant: unknown;
    const occupy = async () => {
      if (kind === 'file') await put(f.target('copy.md'), 'D2');
      else if (kind === 'directory') await put(f.target('copy.md/child'), 'D2');
      else await fs.symlink('../source/note.md', f.target('copy.md'));
      occupant = snapshot(f.target('copy.md'));
    };
    if (when === 'initial') await occupy();
    await assert.rejects(prepare(f.input, async cap => { if (when === 'late') await occupy(); await publish(cap); }), code('destination-occupied'));
    assert.deepEqual(snapshot(f.target('copy.md')), occupant); assert.deepEqual(snapshot(f.source('note.md')), source);
    assert.equal(stages(f.targetRoot).length, when === 'initial' ? 0 : 1);
  });
});

test('source byte/inode, source root/ancestor and target root/ancestor replacements never publish a replacement', async t => {
  for (const kind of ['bytes', 'source-inode', 'source-parent', 'source-root', 'target-parent', 'target-root'] as const) await fixture(t, async f => {
    await put(f.source('from/note.md')); await fs.mkdir(f.target('to'), { mode: 0o700 });
    const input = { ...f.input, sourcePath: 'from/note.md', destinationPath: 'to/copy.md' };
    await assert.rejects(prepare(input, async cap => {
      if (kind === 'bytes') await fs.writeFile(f.source('from/note.md'), 'new bytes');
      else if (kind === 'source-inode') { await fs.rename(f.source('from/note.md'), f.source('from/original')); await put(f.source('from/note.md'), 'D2 source'); }
      else if (kind === 'source-parent') { await fs.rename(f.source('from'), f.source('old-from')); await put(f.source('from/note.md'), 'D2 source'); }
      else if (kind === 'source-root') { await fs.rename(f.sourceRoot, path.join(f.base, 'old-source')); await put(f.source('from/note.md'), 'D2 source'); }
      else if (kind === 'target-parent') { await fs.rename(f.target('to'), f.target('old-to')); await fs.mkdir(f.target('to'), { mode: 0o700 }); }
      else { await fs.rename(f.targetRoot, path.join(f.base, 'old-target')); await fs.mkdir(f.targetRoot, { mode: 0o700 }); }
      await publish(cap);
    }), code(kind === 'bytes' || kind === 'source-inode' ? 'source-changed' : 'scope-changed'));
    await absent(f.target(input.destinationPath));
    if (kind === 'target-root') await absent(path.join(f.base, 'old-target/to/copy.md'));
    if (kind === 'target-parent') await absent(f.target('old-to/copy.md'));
  });
});

test('source recursive membership, nested content and descendant ctime changes invalidate the prepared copy', async t => {
  for (const kind of ['add', 'remove', 'bytes', 'inode', 'ctime'] as const) await fixture(t, async f => {
    await put(f.source('folder/nested/file'), 'original');
    const input: Input = { ...f.input, sourcePath: 'folder', destinationPath: 'copy', sourceKind: 'directory' };
    await assert.rejects(prepare(input, async cap => {
      if (kind === 'add') await put(f.source('folder/added'), 'addition');
      else if (kind === 'remove') await fs.unlink(f.source('folder/nested/file'));
      else if (kind === 'bytes') await fs.writeFile(f.source('folder/nested/file'), 'changed');
      else if (kind === 'inode') { await fs.rename(f.source('folder/nested/file'), f.source('old-file')); await put(f.source('folder/nested/file'), 'original'); }
      else { await fs.chmod(f.source('folder/nested/file'), 0o644); await fs.chmod(f.source('folder/nested/file'), 0o600); }
      await publish(cap);
    }), code('source-changed'));
    await absent(f.target('copy'));
  });
});

test('a destination parent born after staging is foreign D2 and is neither adopted nor journaled', async t => fixture(t, async f => {
  await put(f.source('note.md')); const input = { ...f.input, destinationPath: 'new/copy.md' }; let calls = 0;
  let d2: unknown;
  await assert.rejects(prepare(input, async cap => {
    await put(f.target('new/foreign'), 'D2'); d2 = snapshot(f.target('new'));
    await publish(cap, async () => { calls += 1; });
  }), code('recovery-conflict'));
  assert.equal(calls, 0); assert.deepEqual(snapshot(f.target('new')), d2); await absent(f.target('new/copy.md'));
}));

test('a callback failure retains the exact completed stage and recovery publishes it without restaging source bytes', async t => fixture(t, async f => {
  await put(f.source('note.md')); const primary = new Error('Original owner intent COMMIT unresolved'); let original!: Original;
  let staged: unknown;
  await assert.rejects(prepare(f.input, async cap => { original = read(cap); staged = snapshot(payload(f.targetRoot)); throw primary; }), error => error === primary);
  await absent(f.target('copy.md')); frozen(original);
  await recover({ sourceWorkspace: f.input.sourceWorkspace, destinationWorkspace: f.input.destinationWorkspace, original: clone(original) }, async cap => {
    assert.equal(disposition(cap), 'pending'); assert.deepEqual(snapshot(payload(f.targetRoot)), staged);
    const receipt = await publish(cap); await receiptCurrent(cap, receipt);
  });
  assert.equal(await fs.readFile(f.target('copy.md'), 'utf8'), 'original'); assert.deepEqual(stages(f.targetRoot), []);
  assert.equal(await fs.readFile(f.source('note.md'), 'utf8'), 'original');
}));

test('published recovery binds the actual original copy inode and preserves newly present source S2', async t => {
  for (const directory of [false, true]) await fixture(t, async f => {
    const input: Input = { ...f.input, sourceKind: directory ? 'directory' : 'regular_file' };
    if (directory) await put(f.source('note.md/asset.pdf'), '%PDF original'); else await put(f.source('note.md'));
    let original!: Original;
    await prepare(input, async cap => { original = read(cap); await publish(cap); });
    const published = snapshot(f.target('copy.md'));
    await fs.rename(f.source('note.md'), f.source('old-source')); await put(f.source('note.md'), 'source S2');
    const s2 = snapshot(f.source('note.md'));
    await recover({ sourceWorkspace: input.sourceWorkspace, destinationWorkspace: input.destinationWorkspace, original: clone(original) }, async cap => {
      assert.equal(disposition(cap), 'already_published'); await current(cap);
      const receipt = await publish(cap); await receiptCurrent(cap, receipt);
      assert.equal(receipt.observation.kind, 'published');
    });
    assert.deepEqual(snapshot(f.target('copy.md')), published); assert.deepEqual(snapshot(f.source('note.md')), s2);
    assert.deepEqual(stages(f.targetRoot), []);
  });
});

test('historical recovery refuses D2/source conflicts without deleting or altering the last original isolated stage', async t => {
  for (const mode of ['target-inode', 'target-bytes', 'neither', 'both', 'pending-stage-inode', 'pending-stage-bytes',
    'pending-source-bytes', 'pending-source-inode', 'pending-target-D2'] as const) await fixture(t, async f => {
    await put(f.source('note.md')); let original!: Original;
    const pending = mode.startsWith('pending-');
    await prepare(f.input, async cap => { original = read(cap); if (!pending) await publish(cap); });
    if (mode === 'target-inode') { await fs.rename(f.target('copy.md'), f.target('original-copy')); await put(f.target('copy.md')); }
    else if (mode === 'target-bytes') await fs.writeFile(f.target('copy.md'), 'corrupted');
    else if (mode === 'neither') await fs.rename(f.target('copy.md'), f.target('original-copy'));
    else if (mode === 'both') {
      assert(original.staging); await fs.mkdir(f.target(original.staging.relativePath), { mode: 0o700 });
      await put(path.join(f.target(original.staging.relativePath), 'payload'));
    } else if (mode === 'pending-stage-inode') { const staged = payload(f.targetRoot); await fs.rename(staged, f.target('old-stage-payload')); await put(staged); }
    else if (mode === 'pending-stage-bytes') await fs.writeFile(payload(f.targetRoot), 'corrupted');
    else if (mode === 'pending-source-bytes') await fs.writeFile(f.source('note.md'), 'source changed after original stage');
    else if (mode === 'pending-source-inode') { await fs.rename(f.source('note.md'), f.source('original-source')); await put(f.source('note.md'), 'source S2'); }
    else if (mode === 'pending-target-D2') await put(f.target('copy.md'), 'original');
    const source = snapshot(f.sourceRoot), target = snapshot(f.targetRoot);
    const isolated = pending ? { pathname: payload(f.targetRoot), before: snapshot(payload(f.targetRoot)) } : null;
    const expectedCode = mode === 'pending-stage-bytes' ? 'staging-changed'
      : mode === 'pending-source-bytes' || mode === 'pending-source-inode' ? 'source-changed' : 'recovery-conflict';
    await assert.rejects(recover({ sourceWorkspace: f.input.sourceWorkspace, destinationWorkspace: f.input.destinationWorkspace,
      original: clone(original) }, async () => assert.fail('Foreign/historically changed objects cannot enter recovery.')), code(expectedCode));
    if (isolated) assert.deepEqual(snapshot(isolated.pathname), isolated.before, 'A failed historical recovery preserves the original isolated object, inode and bytes.');
    assert.deepEqual(snapshot(f.sourceRoot), source); assert.deepEqual(snapshot(f.targetRoot), target);
  });
});

test('modified stage files, directory membership and a foreign stage-container replacement never publish or discard D2', async t => {
  for (const mode of ['bytes', 'inode', 'membership', 'container'] as const) await fixture(t, async f => {
    await put(f.source('folder/file'), 'original'); const input: Input = { ...f.input, sourcePath: 'folder', sourceKind: 'directory' };
    let d2: unknown;
    await assert.rejects(prepare(input, async cap => {
      const staged = payload(f.targetRoot);
      if (mode === 'bytes') await fs.writeFile(path.join(staged, 'file'), 'corrupted');
      else if (mode === 'inode') { await fs.rename(path.join(staged, 'file'), f.target('old-file')); await put(path.join(staged, 'file')); }
      else if (mode === 'membership') await put(path.join(staged, 'new-child'), 'D2');
      else {
        const container = stages(f.targetRoot)[0]; await fs.rename(container, container + '-original');
        await put(path.join(container, 'foreign'), 'D2'); d2 = snapshot(container);
      }
      await publish(cap);
    }), code('staging-changed'));
    await absent(f.target('copy.md'));
    if (mode === 'container') assert.deepEqual(snapshot(stages(f.targetRoot)[0]), d2);
  });
});

test('parent ACK failure requires exactly persisted original births and never adopts unjournaled directories', async t => fixture(t, async f => {
  await put(f.source('note.md')); const input = { ...f.input, destinationPath: 'new/deeper/copy.md' }, births: ParentReceipt[] = [];
  const primary = new Error('parent receipt ACK lost'); let original!: Original;
  await assert.rejects(prepare(input, async cap => {
    original = read(cap);
    await publish(cap, async birth => { parentCurrent(cap, birth); births.push(birth); throw primary; });
  }), error => error === primary || error instanceof PreparedWorkspacePathCopyError && error.code === 'parent-create-unconfirmed');
  assert.equal(births.length, 1); await absent(f.target('new/deeper')); await absent(f.target(input.destinationPath));
  await assert.rejects(recover({ sourceWorkspace: input.sourceWorkspace, destinationWorkspace: input.destinationWorkspace,
    original: clone(original) }, async () => assert.fail('Unjournaled actual parent is not adoptable.')), code('recovery-conflict'));
  await recover({ sourceWorkspace: input.sourceWorkspace, destinationWorkspace: input.destinationWorkspace,
    original: clone(original), createdParents: clone(births) }, async cap => {
    const receipt = await publish(cap, async birth => { parentCurrent(cap, birth); births.push(birth); });
    assert.deepEqual(receipt.createdParents, births); await receiptCurrent(cap, receipt);
  });
  assert.equal(await fs.readFile(f.target(input.destinationPath), 'utf8'), 'original');
}));

test('projection absence rejects late source or target D2 and does not invent or delete a physical projection', async t => {
  for (const where of ['source', 'target'] as const) await fixture(t, async f => {
    const input: Input = { ...f.input, sourceKind: 'projection_absent' }; let d2: unknown;
    await assert.rejects(prepare(input, async cap => {
      const filename = where === 'source' ? f.source('note.md') : f.target('copy.md');
      await put(filename, 'D2'); d2 = snapshot(filename); await publish(cap);
    }), code(where === 'source' ? 'source-changed' : 'destination-occupied'));
    assert.deepEqual(snapshot(where === 'source' ? f.source('note.md') : f.target('copy.md')), d2); assert.deepEqual(stages(f.targetRoot), []);
  });
});

test('strict requests and recovery reject traversal, overlap, foreign scopes, accessors and forged original shapes', async t => fixture(t, async f => {
  await put(f.source('note.md'));
  const invalid: unknown[] = [{ ...f.input, sourcePath: '../note.md' }, { ...f.input, destinationPath: '/outside' },
    { ...f.input, extra: true }, { ...f.input, projectionPaths: ['*.md'] },
    { ...f.input, destinationWorkspace: f.input.sourceWorkspace, destinationPath: 'note.md/child' },
    { ...f.input, budget: { maxDepth: 33, maxEntries: 1, maxHashBytes: 1 } }];
  let getterCalls = 0; const accessor = { ...f.input };
  Object.defineProperty(accessor, 'sourcePath', { enumerable: true, get: () => { getterCalls += 1; return 'note.md'; } }); invalid.push(accessor);
  for (const value of invalid) await assert.rejects(prepare(value as Input, async () => assert.fail('Invalid request cannot enter callback.')), code('invalid-input'));
  assert.equal(getterCalls, 0); assert.deepEqual(stages(f.targetRoot), []);
  let original!: Original;
  await prepare(f.input, async cap => { original = read(cap); });
  const wrong = clone(original) as unknown as { version: number }; wrong.version = 2;
  await assert.rejects(recover({ sourceWorkspace: f.input.sourceWorkspace, destinationWorkspace: f.input.destinationWorkspace,
    original: wrong as Original }, async () => assert.fail()), code('invalid-input'));
  await assert.rejects(recover({ sourceWorkspace: { ...f.input.sourceWorkspace, ownerUserId: 'foreign-owner' },
    destinationWorkspace: f.input.destinationWorkspace, original: clone(original) }, async () => assert.fail()), code('scope-changed'));
}));

test('every staged payload file/directory and its container have actual completed fsync before entering the callback', async t => fixture(t, async f => {
  await put(f.source('folder/a/file.md'), '# content'); await fs.mkdir(f.source('folder/empty'), { mode: 0o700 });
  const input: Input = { ...f.input, sourcePath: 'folder', sourceKind: 'directory' }, synced = new Set<string>();
  const realSync = observedIo.fsync.bind(observedIo);
  t.mock.method(observedIo, 'fsync', (fd: number, callback: SyncCallback) => {
    const key = nodeKey(io.fstatSync(fd, { bigint: true }));
    realSync(fd, error => { if (!error) synced.add(key); callback(error); });
  });
  await prepare(input, async cap => {
    const container = stages(f.targetRoot)[0], expected = nodes(container);
    assert([...expected].every(key => synced.has(key)), 'All real staged nodes must be durable before the owner can journal original facts.');
    assert(synced.has(nodeKey(io.statSync(f.targetRoot, { bigint: true }))), 'Container birth is synced in its real parent.');
    await discard(cap);
  });
}));

test('publication exposes the complete tree in one rename before actual parent fsync acknowledges success', async t => fixture(t, async f => {
  await put(f.source('folder/a/file.md'), 'a'); await put(f.source('folder/b.pdf'), '%PDF');
  const expected = contents(f.source('folder')), input: Input = { ...f.input, sourcePath: 'folder', sourceKind: 'directory' };
  const entered = gate(), release = gate(), realSync = observedIo.fsync.bind(observedIo); let armed = false, held = false;
  t.mock.method(observedIo, 'fsync', (fd: number, callback: SyncCallback) => realSync(fd, error => {
    if (armed && !held && present(f.target('copy.md'))) {
      held = true; entered.resolve(); void release.promise.then(() => callback(error));
    } else callback(error);
  }));
  await prepare(input, async cap => {
    await absent(f.target('copy.md')); armed = true;
    const pending = publish(cap); pending.catch(() => {});
    try { await bounded(entered.promise); assert.deepEqual(contents(f.target('copy.md')), expected); }
    finally { release.resolve(); }
    const receipt = await pending; await receiptCurrent(cap, receipt);
  });
  assert.equal(held, true); assert.deepEqual(contents(f.target('copy.md')), expected);
}));

test('a real preparation fsync ACK failure cannot enter the callback and cleans only its private incomplete stage', async t => fixture(t, async f => {
  await put(f.source('note.md')); await put(f.target('neighbor'), 'keep'); const source = snapshot(f.sourceRoot);
  const realSync = observedIo.fsync.bind(observedIo); let failed = false;
  t.mock.method(observedIo, 'fsync', (fd: number, callback: SyncCallback) => realSync(fd, error => {
    const failure = !failed; failed = true;
    callback(error ?? (failure ? Object.assign(new Error('Actual staging fsync ACK lost'), { code: 'EIO' }) : null));
  }));
  await assert.rejects(prepare(f.input, async () => assert.fail('Unsynced staging cannot become original facts.')));
  assert.equal(failed, true); await absent(f.target('copy.md')); assert.deepEqual(stages(f.targetRoot), []);
  assert.deepEqual(snapshot(f.sourceRoot), source); assert.equal(await fs.readFile(f.target('neighbor'), 'utf8'), 'keep');
}));

test('publication fsync ACK loss retains the actual target for receipt-bound recovery without touching source S2', async t => fixture(t, async f => {
  await put(f.source('note.md')); let original!: Original, armed = false, failed = false;
  const realSync = observedIo.fsync.bind(observedIo);
  t.mock.method(observedIo, 'fsync', (fd: number, callback: SyncCallback) => realSync(fd, error => {
    const failure = armed && !failed && present(f.target('copy.md')); if (failure) failed = true;
    callback(error ?? (failure ? Object.assign(new Error('Actual publication fsync ACK lost'), { code: 'EIO' }) : null));
  }));
  await assert.rejects(prepare(f.input, async cap => { original = read(cap); armed = true; return publish(cap); }),
    error => error instanceof PreparedWorkspacePathCopyError && error.mutationAttempted);
  assert.equal(failed, true); const published = snapshot(f.target('copy.md')); t.mock.restoreAll();
  await fs.rename(f.source('note.md'), f.source('old-source')); await put(f.source('note.md'), 'S2'); const source = snapshot(f.sourceRoot);
  await recover({ sourceWorkspace: f.input.sourceWorkspace, destinationWorkspace: f.input.destinationWorkspace, original: clone(original) }, async cap => {
    assert.equal(disposition(cap), 'already_published'); const receipt = await publish(cap); await receiptCurrent(cap, receipt);
  });
  assert.deepEqual(snapshot(f.target('copy.md')), published); assert.deepEqual(snapshot(f.sourceRoot), source); assert.deepEqual(stages(f.targetRoot), []);
}));

test('actual empty-container remove followed by lost cleanup ACK preserves the published target for recovery', async t => fixture(t, async f => {
  await put(f.source('note.md')); let original!: Original, removed = false;
  const cleanupIo = io as unknown as { rmdirSync(filename: string): void }, realRemove = cleanupIo.rmdirSync.bind(cleanupIo);
  t.mock.method(cleanupIo, 'rmdirSync', (filename: string) => {
    const isContainer = path.basename(filename).startsWith('.canvas-create-') && filename.endsWith('.tmp');
    realRemove(filename);
    if (isContainer && !removed && present(f.target('copy.md'))) {
      removed = true; assert.equal(present(filename), false); throw Object.assign(new Error('Actual cleanup ACK lost'), { code: 'EIO' });
    }
  });
  await assert.rejects(prepare(f.input, async cap => { original = read(cap); return publish(cap); }),
    error => error instanceof PreparedWorkspacePathCopyError && error.code === 'publication-unconfirmed' && error.mutationAttempted);
  assert.equal(removed, true); assert.deepEqual(stages(f.targetRoot), []); const published = snapshot(f.target('copy.md'));
  assert.equal(await fs.readFile(f.source('note.md'), 'utf8'), 'original'); t.mock.restoreAll();
  await recover({ sourceWorkspace: f.input.sourceWorkspace, destinationWorkspace: f.input.destinationWorkspace, original: clone(original) }, async cap => {
    assert.equal(disposition(cap), 'already_published'); const receipt = await publish(cap); await receiptCurrent(cap, receipt);
  });
  assert.deepEqual(snapshot(f.target('copy.md')), published); assert.deepEqual(stages(f.targetRoot), []);
}));

test('explicit discard never removes a replacement stage payload or a successfully published target', async t => {
  for (const published of [false, true]) await fixture(t, async f => {
    await put(f.source('note.md')); let protectedNode: unknown, protectedPath = '';
    const operation = prepare(f.input, async cap => {
      if (published) { await publish(cap); protectedPath = f.target('copy.md'); }
      else { protectedPath = payload(f.targetRoot); await fs.rename(protectedPath, f.target('original-payload')); await put(protectedPath, 'D2'); }
      protectedNode = snapshot(protectedPath); await discard(cap);
    });
    if (published) await operation; else await assert.rejects(operation, code('cleanup-unconfirmed'));
    assert.deepEqual(snapshot(protectedPath), protectedNode); assert.equal(await fs.readFile(f.source('note.md'), 'utf8'), 'original');
  });
});

test('captured scopes, paths, projections and budgets cannot be retargeted during the first actual source read', async t => fixture(t, async f => {
  await put(f.source('folder/file.md'), 'original'); await put(f.source('folder/native.md'), 'omitted projection');
  const input = { ...f.input, sourceWorkspace: { ...f.input.sourceWorkspace }, destinationWorkspace: { ...f.input.destinationWorkspace },
    sourcePath: 'folder', sourceKind: 'directory' as const, projectionPaths: ['folder/native.md'], budget: { maxDepth: 2, maxEntries: 4, maxHashBytes: 8 } };
  const expectedSourceScope = clone(input.sourceWorkspace), expectedTargetScope = clone(input.destinationWorkspace);
  const sourceKey = nodeKey(io.statSync(f.source('folder/file.md'), { bigint: true })), entered = gate(), release = gate();
  const realRead = observedIo.read.bind(observedIo); let held = false;
  t.mock.method(observedIo, 'read', (fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: ReadCallback) => {
    const original = nodeKey(io.fstatSync(fd, { bigint: true })) === sourceKey;
    realRead(fd, buffer, offset, length, position, (error, count, result) => {
      if (original && !held) { held = true; entered.resolve(); void release.promise.then(() => callback(error, count, result)); }
      else callback(error, count, result);
    });
  });
  const pending = prepare(input, async cap => {
    const facts = read(cap); assert.equal(facts.sourceWorkspace.rootPath, expectedSourceScope.rootPath);
    assert.equal(facts.destinationWorkspace.rootPath, expectedTargetScope.rootPath);
    assert.equal(facts.sourcePath, 'folder'); assert.equal(facts.destinationPath, 'copy.md');
    assert.deepEqual(facts.projectionPaths, ['folder/native.md']); assert.equal(facts.budget.maxHashBytes, 8);
    return publish(cap);
  }); pending.catch(() => {});
  try {
    await bounded(entered.promise); input.sourcePath = 'later'; input.destinationPath = 'later';
    input.sourceWorkspace.rootPath = '/later-source'; input.destinationWorkspace.rootPath = '/later-target';
    input.projectionPaths[0] = 'folder/file.md'; input.budget.maxHashBytes = 0;
  } finally { release.resolve(); }
  await pending; assert.equal(await fs.readFile(f.target('copy.md/file.md'), 'utf8'), 'original'); await absent(f.target('copy.md/native.md'));
}));

test('forged, retained, nested and repeated capabilities poison caught misuse and never become a free filesystem authority', async t => {
  for (const misuse of ['forged', 'nested', 'repeated', 'receipt-clone'] as const) await fixture(t, async f => {
    await put(f.source('note.md'));
    await assert.rejects(prepare(f.input, async cap => {
      if (misuse === 'forged') { try { read({} as Capability); } catch {} }
      else if (misuse === 'nested') { try { await prepare(f.input, async () => {}); } catch {} }
      else {
        const receipt = await publish(cap);
        if (misuse === 'repeated') await assert.rejects(publish(cap), code('already-published'));
        else { try { await receiptCurrent(cap, clone(receipt)); } catch {} }
      }
    }));
  });
  await fixture(t, async f => {
    await put(f.source('note.md')); let retained!: Capability;
    await prepare(f.input, async cap => { retained = cap; await discard(cap); });
    assert.throws(() => read(retained), code('invalid-lifetime')); assert.throws(() => disposition(retained), code('invalid-lifetime'));
    await assert.rejects(publish(retained), code('invalid-lifetime')); await assert.rejects(current(retained), code('invalid-lifetime'));
    await assert.rejects(discard(retained), code('invalid-lifetime'));
  });
});

test('unawaited actual publication/current reads drain before closing native descriptors and revoke detached capabilities', async t => {
  for (const published of [false, true]) await fixture(t, async f => {
    await put(f.source('note.md')); const entered = gate(), release = gate(), returned = gate(), realRead = observedIo.read.bind(observedIo);
    let armed = false, closedEarly = false, retained!: Capability, pending!: Promise<unknown>;
    t.mock.method(observedIo, 'read', (fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: ReadCallback) => {
      realRead(fd, buffer, offset, length, position, (error, count, result) => {
        if (armed) {
          armed = false; entered.resolve(); void release.promise.then(() => {
            try { io.fstatSync(fd); } catch { closedEarly = true; } callback(error, count, result);
          });
        } else callback(error, count, result);
      });
    });
    const operation = prepare(f.input, async cap => {
      retained = cap; if (published) await publish(cap);
      armed = true; pending = published ? current(cap) : publish(cap); pending.catch(() => {});
      await bounded(entered.promise); returned.resolve();
    }); operation.catch(() => {});
    try {
      await bounded(returned.promise); await new Promise<void>(resolve => setImmediate(resolve));
      assert(ownedDescriptors(f.base).length >= 2); release.resolve();
      await assert.rejects(operation, code('unawaited-operation')); await assert.rejects(pending); assert.equal(closedEarly, false);
      await assert.rejects(current(retained), code('invalid-lifetime')); assert.deepEqual(ownedDescriptors(f.base), []);
      if (published) assert.equal(await fs.readFile(f.target('copy.md'), 'utf8'), 'original'); else await absent(f.target('copy.md'));
      assert.equal(await fs.readFile(f.source('note.md'), 'utf8'), 'original');
    } finally { release.resolve(); await Promise.allSettled([operation, pending]); }
  });
});

test('callback failure after real publication preserves primary error and both source and published target', async t => fixture(t, async f => {
  await put(f.source('note.md')); const primary = new Error('Original durable publication receipt ACK lost'), source = snapshot(f.source('note.md'));
  await assert.rejects(prepare(f.input, async cap => { await publish(cap); throw primary; }), error => error === primary);
  assert.deepEqual(snapshot(f.source('note.md')), source); assert.equal(await fs.readFile(f.target('copy.md'), 'utf8'), 'original');
}));

test('every actual close-then-lost-ACK is attempted once and retained alongside an original callback failure', async t => fixture(t, async f => {
  await put(f.source('note.md')); const primary = new Error('SQL-like owner COMMIT unknown'), failures: Error[] = [], counts = new Map<number, number>();
  const realClose = observedIo.closeSync.bind(observedIo); let armed = false;
  t.mock.method(observedIo, 'closeSync', (fd: number) => {
    if (!armed || !nodes(f.base, history.get(f.base)).has(nodeKey(io.fstatSync(fd, { bigint: true })))) return realClose(fd);
    counts.set(fd, (counts.get(fd) ?? 0) + 1); const failure = new Error(`Actual close ACK ${fd}`); failures.push(failure);
    realClose(fd); throw failure;
  });
  await assert.rejects(prepare(f.input, async cap => { await publish(cap); armed = true; throw primary; }), error => {
    assert(error instanceof PreparedWorkspacePathCopyError); assert.equal(error.code, 'disposal-unconfirmed'); assert.equal(error.status, 503);
    assert(error.cause instanceof AggregateError); assert.equal(error.cause.errors[0], primary);
    for (const failure of failures) assert.equal(error.cause.errors.filter(item => item === failure || item instanceof Error && item.cause === failure).length, 1);
    return true;
  });
  assert(failures.length >= 2); assert([...counts.values()].every(count => count === 1));
  for (const fd of counts.keys()) assert.throws(() => io.fstatSync(fd), { code: 'EBADF' });
  assert.equal(await fs.readFile(f.target('copy.md'), 'utf8'), 'original'); assert.equal(await fs.readFile(f.source('note.md'), 'utf8'), 'original');
}));

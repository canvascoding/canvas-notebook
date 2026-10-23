import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import io, { type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { withPreparedWorkspacePathMove as prepare, readPreparedWorkspacePathMove as read,
  readPreparedWorkspacePathMoveDisposition as disposition, movePreparedWorkspacePath as move,
  assertPreparedWorkspacePathMoveCurrent as current, withRecoveredWorkspacePathMove as recover,
  PreparedWorkspacePathMoveError, type PreparedWorkspacePathMoveInput as Input,
  type PreparedWorkspacePathMoveOriginal as Original,
  type PreparedWorkspacePathMoveParentReceipt as ParentReceipt, type PreparedPathMoveIdentity as Identity,
  type PreparedPathMoveErrorCode as ErrorCode } from '../app/lib/filesystem/prepared-workspace-path-move';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const code = (...expected: ErrorCode[]) => (error: unknown) => error instanceof PreparedWorkspacePathMoveError && expected.includes(error.code);
type Capability = Parameters<typeof read>[0];
type Fixture = { base: string; root: string; input: Input; at(relative: string): string };
function identity(stat: BigIntStats): Identity {
  return { device: String(stat.dev), inode: String(stat.ino), mode: Number(stat.mode), uid: Number(stat.uid), gid: Number(stat.gid),
    linkCount: String(stat.nlink), size: String(stat.size), birthtimeNs: String(stat.birthtimeNs), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}
function nodeKey(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}`; }
const fixtureHistory = new Map<string, Set<string>>();
function remember(filename: string, info: BigIntStats): void {
  for (const [base, known] of fixtureHistory) if (filename === base || filename.startsWith(base + path.sep)) known.add(nodeKey(info));
}
function fixtureNodes(directory: string, result = fixtureHistory.get(directory) ?? new Set<string>()): Set<string> {
  const info = io.lstatSync(directory, { bigint: true }); result.add(nodeKey(info));
  if (info.isDirectory() && !info.isSymbolicLink()) for (const name of io.readdirSync(directory)) fixtureNodes(path.join(directory, name), result);
  return result;
}
/** Actual native openat descriptors are invisible to fs/promises.open spies. */
function ownedDescriptors(base: string): number[] {
  const owned = fixtureNodes(base), found: number[] = [];
  for (const name of io.readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd')) {
    const fd = Number(name); if (!Number.isInteger(fd) || fd < 3) continue;
    try { if (owned.has(nodeKey(io.fstatSync(fd, { bigint: true })))) found.push(fd); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error; }
  }
  return found.sort((a, b) => a - b);
}
async function fixture(t: TestContext, run: (value: Fixture) => Promise<void>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-prepared-path-move-')));
  await fs.chmod(base, 0o700); const birth = await fs.lstat(base, { bigint: true });
  const root = path.join(base, 'workspace'); await fs.mkdir(root, { mode: 0o700 });
  fixtureHistory.set(base, new Set([nodeKey(birth), nodeKey(await fs.lstat(root, { bigint: true }))]));
  const workspace: WorkspaceContext = { workspaceId: `ws-${randomUUID()}`, workspaceType: 'personal', organizationId: null,
    rootPath: root, legacy: false, permissions: { canRead: false, canWrite: false, canDelete: false, canCreatePublicLinks: false,
      canManageWorkspace: false, canRunAgent: false } };
  try { await run({ base, root, input: { workspace, sourcePath: 'note.md', destinationPath: 'renamed.md', sourceKind: 'regular_file' }, at: relative => path.join(root, relative) }); }
  finally {
    t.mock.restoreAll();
    try {
      assert.deepEqual(ownedDescriptors(base), [], 'Every actual fixture descriptor, including native openat and unlinked original FDs, must close.');
      const after = await fs.lstat(base, { bigint: true });
      assert.equal(after.dev, birth.dev); assert.equal(after.ino, birth.ino); assert.equal(after.uid, birth.uid);
      assert.equal(after.mode & BigInt(0o777), BigInt(0o700));
      await fs.rm(base, { recursive: true, force: false });
    } finally { fixtureHistory.delete(base); }
  }
}
async function put(filename: string, bytes: string | Buffer = 'original') {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
  remember(filename, io.lstatSync(filename, { bigint: true }));
}
async function absent(filename: string) { await assert.rejects(fs.lstat(filename), { code: 'ENOENT' }); }
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Actual FS barrier timed out')), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function frozen(value: unknown): void {
  if (value && typeof value === 'object') { assert(Object.isFrozen(value)); for (const child of Object.values(value)) frozen(child); }
}
function snapshot(filename: string): unknown {
  const info = io.lstatSync(filename, { bigint: true });
  remember(filename, info);
  const common = { device: String(info.dev), inode: String(info.ino), mode: String(info.mode), uid: String(info.uid),
    gid: String(info.gid), links: String(info.nlink) };
  if (info.isFile()) return { ...common, kind: 'file', size: String(info.size), sha256: digest(io.readFileSync(filename)) };
  if (info.isDirectory()) return { ...common, kind: 'directory', entries: io.readdirSync(filename).sort().map(name => [name, snapshot(path.join(filename, name))]) };
  if (info.isSymbolicLink()) return { ...common, kind: 'symlink', target: io.readlinkSync(filename) };
  return { ...common, kind: 'special' };
}
type ReadCallback = (error: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer) => void;
type SyncCallback = (error: NodeJS.ErrnoException | null) => void;
const observedIo = io as unknown as {
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: ReadCallback): void;
  fsync(fd: number, callback: SyncCallback): void;
  closeSync(fd: number): void;
};

test('literal names, opaque >6MiB file, frozen JSON facts, real no-replace inode/bytes and actual FD closure', async t => fixture(t, async f => {
  const input = { ...f.input, sourcePath: ' Folder / note.md ', destinationPath: ' Folder / moved.md ' };
  const bytes = Buffer.alloc(6 * 1024 * 1024 + 7, 0x9d); bytes.set([0xef, 0xbb, 0xbf, 0x00, 0xff]);
  await put(f.at(input.sourcePath), bytes); await put(f.at('note.md'), 'neighbor');
  const originalNode = snapshot(f.at(input.sourcePath)), before = identity(io.statSync(f.at(input.sourcePath), { bigint: true }));
  let facts!: Original;
  const receipt = await prepare(input, async cap => {
    facts = read(cap); frozen(facts); assert.deepEqual(clone(facts), facts); assert.deepEqual(Reflect.ownKeys(cap), []);
    assert.equal(disposition(cap), 'pending'); assert.equal(facts.sourcePath, input.sourcePath);
    assert.equal(facts.source.kind, 'regular_file');
    if (facts.source.kind !== 'regular_file') assert.fail();
    assert.deepEqual(facts.source.identity, before); assert.equal(facts.source.sha256, digest(bytes));
    assert(ownedDescriptors(f.base).length >= 2); await current(cap);
    const result = await move(cap); await current(cap); await current(cap); return result;
  });
  frozen(receipt); assert.equal(receipt.original, facts); assert.equal(receipt.observation.kind, 'moved');
  if (receipt.observation.kind !== 'moved') assert.fail();
  assert.equal(receipt.observation.method, 'rename-no-replace'); assert.deepEqual(receipt.createdParents, []);
  assert.deepEqual(snapshot(f.at(input.destinationPath)), originalNode); await absent(f.at(input.sourcePath));
  assert.deepEqual(await fs.readFile(f.at(input.destinationPath)), bytes); assert.equal(await fs.readFile(f.at('note.md'), 'utf8'), 'neighbor');
}));

test('directory inventory is globally sorted with PDF/image/opaque assets and empty directories; every original object moves', async t => fixture(t, async f => {
  await fs.mkdir(f.at('folder/a'), { recursive: true, mode: 0o700 });
  await fs.mkdir(f.at('folder/empty'), { mode: 0o700 });
  await put(f.at('folder/a/file.md'), '# markdown\n'); await put(f.at('folder/a.txt'), 'sibling lexical boundary');
  await put(f.at('folder/document.pdf'), Buffer.from('%PDF-1.7\nowned bytes\n'));
  await put(f.at('folder/image.bin'), Buffer.from([0, 255, 2, 128]));
  const input = { ...f.input, sourcePath: 'folder', destinationPath: 'folder-moved', sourceKind: 'directory' as const };
  const before = snapshot(f.at('folder'));
  const receipt = await prepare(input, async cap => {
    const source = read(cap).source; assert.equal(source.kind, 'directory'); if (source.kind !== 'directory') assert.fail();
    assert.deepEqual(source.entries.map(entry => entry.relativePath), ['', 'a', 'a.txt', 'a/file.md', 'document.pdf', 'empty', 'image.bin']);
    for (const entry of source.entries) {
      assert.deepEqual(entry.identity, identity(io.lstatSync(f.at(path.posix.join('folder', entry.relativePath)), { bigint: true })));
      if (entry.kind === 'regular_file') assert.equal(entry.sha256, digest(io.readFileSync(f.at(path.posix.join('folder', entry.relativePath)))));
    }
    frozen(source); await current(cap); const result = await move(cap); await current(cap); return result;
  });
  assert.equal(receipt.observation.kind, 'moved'); assert.deepEqual(snapshot(f.at('folder-moved')), before); await absent(f.at('folder'));
}));

test('reduced real entry/depth/hash budgets accept exact boundaries and reject one excess without mutation', async t => {
  for (const mode of ['file-exact', 'file-over', 'empty-file', 'entries-exact', 'entries-over', 'depth-exact', 'depth-over', 'hash-total-over', 'empty-directory'] as const) {
    await fixture(t, async f => {
      const isFile = ['file-exact', 'file-over', 'empty-file'].includes(mode);
      let input: Input = { ...f.input, sourceKind: isFile ? 'regular_file' : 'directory', budget: { maxDepth: 1, maxEntries: 3, maxHashBytes: 3 } };
      if (isFile) await put(f.at('note.md'), mode === 'empty-file' ? '' : mode === 'file-over' ? '1234' : '123');
      else {
        await fs.mkdir(f.at('note.md'), { mode: 0o700 });
        if (mode === 'empty-directory') input = { ...input, budget: { maxDepth: 0, maxEntries: 1, maxHashBytes: 0 } };
        else if (mode.startsWith('depth-')) {
          await fs.mkdir(f.at('note.md/a'), { mode: 0o700 });
          if (mode === 'depth-over') await put(f.at('note.md/a/b'), '');
        } else {
          await put(f.at('note.md/a'), mode === 'hash-total-over' ? '12' : '123');
          await fs.mkdir(f.at('note.md/empty'), { mode: 0o700 });
          if (mode === 'entries-over') await put(f.at('note.md/z'), '');
          if (mode === 'hash-total-over') { await put(f.at('note.md/z'), '34'); input = { ...input, budget: { maxDepth: 1, maxEntries: 4, maxHashBytes: 3 } }; }
        }
      }
      if (mode === 'empty-file') input = { ...input, budget: { maxDepth: 0, maxEntries: 1, maxHashBytes: 0 } };
      const original = snapshot(f.at('note.md'));
      if (mode.endsWith('-over')) {
        await assert.rejects(prepare(input, async () => assert.fail('Over-budget inventory cannot enter callback')), code('budget-exceeded'));
        assert.deepEqual(snapshot(f.at('note.md')), original); await absent(f.at('renamed.md'));
      } else { await prepare(input, move); assert.deepEqual(snapshot(f.at('renamed.md')), original); }
    });
  }
});

test('read-only preparation leaves missing destination ancestors absent; move requires a parent journal callback', async t => fixture(t, async f => {
  await put(f.at('note.md'));
  const input = { ...f.input, destinationPath: 'new/deeper/renamed.md' };
  await prepare(input, async cap => {
    assert.equal(read(cap).filesystem.destinationParents.missingPrefix, 'new');
    await current(cap); await absent(f.at('new'));
  });
  await absent(f.at('new'));
  await assert.rejects(prepare(input, move), code('parent-journal-required'));
  await absent(f.at('new')); assert.equal(await fs.readFile(f.at('note.md'), 'utf8'), 'original');
}));

test('real file growth between budget observation and hash observation consumes no over-budget content reads', async t => {
  for (const directory of [false, true]) await fixture(t, async f => {
    const input: Input = directory
      ? { ...f.input, sourcePath: 'folder', destinationPath: 'moved', sourceKind: 'directory', budget: { maxDepth: 1, maxEntries: 3, maxHashBytes: 4 } }
      : { ...f.input, budget: { maxDepth: 0, maxEntries: 1, maxHashBytes: 4 } };
    if (directory) { await put(f.at('folder/a'), '12'); await put(f.at('folder/b'), '34'); }
    else await put(f.at('note.md'), '1234');
    const target = f.at(directory ? 'folder/b' : 'note.md'), before = io.lstatSync(target, { bigint: true });
    const contentKeys = new Set((directory ? ['folder/a', 'folder/b'] : ['note.md']).map(name => nodeKey(io.lstatSync(f.at(name), { bigint: true }))));
    const realStat = io.fstatSync.bind(io), realRead = observedIo.read.bind(observedIo);
    let targetStats = 0, grew = false, contentBytes = 0, targetContentBytes = 0;
    const statIo = io as unknown as { fstatSync(fd: number, options: { bigint: true }): BigIntStats };
    t.mock.method(statIo, 'fstatSync', (fd: number, options: { bigint: true }) => {
      const actual = realStat(fd, options);
      if (nodeKey(actual) === nodeKey(before) && !grew) {
        // Count only real observations of this exact original FD/inode: open
        // identity, optional tree profile, then the separate budget observation.
        // Return that genuine observation while growing the real file before
        // the next hash observation. The assertion below concerns actual bytes.
        if (++targetStats === (directory ? 3 : 2)) {
          grew = true;
          const writer = io.openSync(target, io.constants.O_WRONLY | io.constants.O_APPEND | io.constants.O_NOFOLLOW);
          try { io.writeSync(writer, Buffer.from(directory ? '5' : 'over-budget-growth')); }
          finally { io.closeSync(writer); }
        }
      }
      return actual;
    });
    t.mock.method(observedIo, 'read', (fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: ReadCallback) => {
      const observed = realStat(fd, { bigint: true }), key = nodeKey(observed);
      realRead(fd, buffer, offset, length, position, (error, bytesRead, result) => {
        if (contentKeys.has(key)) contentBytes += bytesRead;
        if (key === nodeKey(before)) targetContentBytes += bytesRead;
        callback(error, bytesRead, result);
      });
    });
    let caught: unknown;
    try { await prepare(input, async () => assert.fail('The grown source cannot enter a prepared callback')); }
    catch (error) { caught = error; }
    assert(grew, 'The deterministic actual source growth must occur');
    assert.equal(io.lstatSync(target, { bigint: true }).ino, before.ino);
    assert(io.lstatSync(target, { bigint: true }).size > before.size);
    assert.equal(targetContentBytes, 0, 'An over-budget source observed before hashing must not consume content IO');
    assert(contentBytes <= 4, `Actual content reads exceeded maxHashBytes: ${contentBytes}`);
    assert(code('budget-exceeded')(caught), `Expected budget-exceeded after real growth; got ${String((caught as { code?: unknown })?.code)}`);
    await absent(f.at(input.destinationPath));
  });
});

test('each created parent is synced before its immutable journal callback and before creating its child', async t => fixture(t, async f => {
  await put(f.at('note.md')); const input = { ...f.input, destinationPath: 'new/deeper/renamed.md' };
  const synced: string[] = [], realSync = observedIo.fsync.bind(observedIo), journal: ParentReceipt[] = [];
  t.mock.method(observedIo, 'fsync', (fd: number, callback: SyncCallback) => {
    const key = nodeKey(io.fstatSync(fd, { bigint: true }));
    realSync(fd, error => { if (!error) synced.push(key); callback(error); });
  });
  const receipt = await prepare(input, async cap => move(cap, async parent => {
    frozen(parent); assert.deepEqual(clone(parent), parent);
    assert.equal(parent.relativePath, journal.length === 0 ? 'new' : 'new/deeper');
    assert.deepEqual(parent.identity, identity(io.lstatSync(f.at(parent.relativePath), { bigint: true })));
    assert(synced.includes(nodeKey(io.statSync(f.at(parent.relativePath), { bigint: true }))));
    assert(synced.includes(nodeKey(io.statSync(path.dirname(f.at(parent.relativePath)), { bigint: true }))));
    if (journal.length === 0) await absent(f.at('new/deeper'));
    await put(path.join(f.base, `journal-${journal.length}.json`), JSON.stringify(parent)); journal.push(parent);
  }));
  assert.deepEqual(receipt.createdParents, journal); assert.equal(journal.length, 2);
  assert.equal(journal[0].originalProof, journal[1].originalProof); assert.match(journal[0].originalProof, /^[a-f0-9]{64}$/u);
  await absent(f.at('note.md')); assert.equal(await fs.readFile(f.at(input.destinationPath), 'utf8'), 'original');
}));

test('a destination ancestor born after preparation is foreign D2 and cannot be silently adopted or journaled', async t => {
  for (const kind of ['empty', 'populated', 'symlink'] as const) await fixture(t, async f => {
    await put(f.at('note.md')); const input = { ...f.input, destinationPath: 'new/deeper/renamed.md' };
    const original = snapshot(f.at('note.md')); let born: unknown;
    await assert.rejects(prepare(input, async cap => {
      assert.equal(read(cap).filesystem.destinationParents.missingPrefix, 'new');
      if (kind === 'symlink') { await fs.mkdir(f.at('elsewhere'), { mode: 0o700 }); await fs.symlink('elsewhere', f.at('new')); }
      else { await fs.mkdir(f.at('new'), { mode: 0o700 }); if (kind === 'populated') await put(f.at('new/foreign'), 'D2'); }
      born = snapshot(f.at('new')); return move(cap, async () => assert.fail('A foreign parent cannot receive an owned birth receipt'));
    }), code(kind === 'symlink' ? 'unsafe-path' : 'recovery-conflict'));
    assert.deepEqual(snapshot(f.at('note.md')), original); assert.deepEqual(snapshot(f.at('new')), born); await absent(f.at(input.destinationPath));
  });
});

test('parent callback failure leaves evidence; recovery refuses unjournaled parents and resumes only persisted original pins', async t => fixture(t, async f => {
  await put(f.at('note.md')); const input = { ...f.input, destinationPath: 'new/deeper/renamed.md' };
  let original!: Original; const journal: ParentReceipt[] = [], lostAck = new Error('parent journal reply lost');
  await assert.rejects(prepare(input, async cap => {
    original = read(cap); return move(cap, async parent => { journal.push(parent); throw lostAck; });
  }), error => error instanceof PreparedWorkspacePathMoveError && error.mutationAttempted);
  assert.equal(journal.length, 1); assert.equal(await fs.readFile(f.at('note.md'), 'utf8'), 'original'); await absent(f.at('new/deeper'));
  const preserved = snapshot(f.at('new'));
  await assert.rejects(recover({ workspace: input.workspace, original }, async () => assert.fail()), code('recovery-conflict'));
  assert.deepEqual(snapshot(f.at('new')), preserved);
  for (const key of ['originalProof', 'relativePath', 'inode'] as const) {
    const altered = clone(journal) as unknown as Array<{ originalProof: string; relativePath: string; identity: { inode: string } }>;
    if (key === 'originalProof') altered[0].originalProof = '0'.repeat(64);
    else if (key === 'relativePath') altered[0].relativePath = 'foreign';
    else altered[0].identity.inode = String(BigInt(altered[0].identity.inode) + BigInt(1));
    await assert.rejects(recover({ workspace: input.workspace, original, createdParents: altered as unknown as ParentReceipt[] }, async () => assert.fail()), code(key === 'inode' ? 'recovery-conflict' : 'invalid-input'));
    assert.deepEqual(snapshot(f.at('new')), preserved);
  }
  const receipt = await recover({ workspace: input.workspace, original: clone(original), createdParents: clone(journal) }, async cap => {
    assert.equal(disposition(cap), 'pending'); assert.deepEqual(read(cap), original);
    return move(cap, async parent => { journal.push(parent); });
  });
  assert.equal(receipt.createdParents.length, 2); assert.equal(journal.length, 2);
  assert.equal(await fs.readFile(f.at(input.destinationPath), 'utf8'), 'original');
}));

test('projection absence has no invented hash, file, mkdir or journal; late source/destination D2 is never adopted', async t => {
  for (const late of ['none', 'source', 'destination'] as const) await fixture(t, async f => {
    const input: Input = { ...f.input, sourceKind: 'projection_absent', sourcePath: 'missing/source.md', destinationPath: 'other/missing/destination.md' };
    let original!: Original;
    if (late === 'none') {
      const receipt = await prepare(input, async cap => {
        original = read(cap); assert.deepEqual(original.source, { kind: 'projection_absent' });
        assert.equal(disposition(cap), 'projection_absent'); await current(cap);
        const result = await move(cap, async () => assert.fail('Absent projection must not create a parent'));
        await current(cap); return result;
      });
      assert.deepEqual(receipt.observation, { kind: 'projection_absent' }); assert.deepEqual(receipt.createdParents, []);
      await absent(f.at('missing')); await absent(f.at('other'));
      await put(f.at(input.sourcePath), 'new D2');
      await assert.rejects(recover({ workspace: input.workspace, original }, async () => assert.fail()), code('recovery-conflict'));
      assert.equal(await fs.readFile(f.at(input.sourcePath), 'utf8'), 'new D2'); await absent(f.at('other'));
    } else {
      await assert.rejects(prepare(input, async cap => {
        original = read(cap); await put(f.at(late === 'source' ? input.sourcePath : input.destinationPath), 'new D2');
        return move(cap, async () => assert.fail());
      }), code('source-changed', 'destination-occupied', 'recovery-conflict'));
      const changed = f.at(late === 'source' ? input.sourcePath : input.destinationPath), before = snapshot(changed);
      await assert.rejects(recover({ workspace: input.workspace, original }, async () => assert.fail()), code('recovery-conflict'));
      assert.deepEqual(snapshot(changed), before);
    }
  });
});

test('strict copied input rejects traversal, overlaps, unexpected keys, getters and invalid budgets before opening', async t => fixture(t, async f => {
  await put(f.at('note.md')); let opened = 0, getters = 0; const realOpen = io.openSync.bind(io);
  t.mock.method(io, 'openSync', (...args: Parameters<typeof io.openSync>) => { opened++; return realOpen(...args); });
  for (const sourcePath of ['', '.', '/note.md', './note.md', '../note.md', 'a//note.md', 'a/../note.md', 'a\\note.md', 'bad\0.md', '\ud800']) {
    await assert.rejects(prepare({ ...f.input, sourcePath }, async () => assert.fail()), code('invalid-input'));
  }
  for (const destinationPath of ['note.md', 'note.md/child', '.', '../out']) await assert.rejects(prepare({ ...f.input, destinationPath }, async () => assert.fail()), code('invalid-input'));
  for (const budget of [{ maxDepth: 33, maxEntries: 2, maxHashBytes: 3 }, { maxDepth: 1, maxEntries: 10001, maxHashBytes: 3 },
    { maxDepth: 1, maxEntries: 2, maxHashBytes: 4 * 1024 ** 3 + 1 }, { maxDepth: 1, maxEntries: 2 }, { maxDepth: 1, maxEntries: 2, maxHashBytes: -1 }]) {
    await assert.rejects(prepare({ ...f.input, budget } as Input, async () => assert.fail()), code('invalid-input'));
  }
  const accessor = { ...f.input }; Object.defineProperty(accessor, 'sourcePath', { enumerable: true, get: () => { getters++; return 'note.md'; } });
  await assert.rejects(prepare(accessor, async () => assert.fail()), code('invalid-input'));
  await assert.rejects(prepare({ ...f.input, extra: true } as Input, async () => assert.fail()), code('invalid-input'));
  assert.equal(getters, 0); assert.equal(opened, 0);
}));

test('request is copied before first actual read await and cannot be retargeted by later caller mutation', async t => fixture(t, async f => {
  await put(f.at('note.md')); const entered = gate(), release = gate(), realRead = observedIo.read.bind(observedIo); let armed = true;
  t.mock.method(observedIo, 'read', (fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: ReadCallback) => {
    realRead(fd, buffer, offset, length, position, (error, bytesRead, result) => {
      if (armed) { armed = false; entered.resolve(); void release.promise.then(() => callback(error, bytesRead, result)); }
      else callback(error, bytesRead, result);
    });
  });
  const mutable = { ...f.input, workspace: { ...f.input.workspace } };
  const operation = prepare(mutable, async cap => { assert.equal(read(cap).sourcePath, 'note.md'); return move(cap); });
  void operation.catch(() => {});
  try {
    await bounded(entered.promise); mutable.sourcePath = 'D2.md'; mutable.destinationPath = 'outside.md'; mutable.workspace.rootPath = '/outside';
    release.resolve(); await bounded(operation);
    assert.equal(await fs.readFile(f.at('renamed.md'), 'utf8'), 'original'); await absent(f.at('outside.md'));
  } finally { release.resolve(); await Promise.allSettled([operation]); }
}));

test('symlink roots/ancestors/sources and unsafe recursive special/hardlink entries fail without touching peers', async t => {
  for (const kind of ['source-link', 'ancestor-link', 'root-link', 'hardlink', 'fifo', 'child-link', 'child-fifo', 'child-hardlink', 'unsafe-file', 'unsafe-directory'] as const) {
    await fixture(t, async f => {
      let input = f.input; await put(f.at('real.md'), 'peer');
      if (kind === 'source-link') await fs.symlink('real.md', f.at('note.md'));
      else if (kind === 'ancestor-link') { await fs.mkdir(f.at('real'), { mode: 0o700 }); await fs.symlink('real', f.at('alias')); input = { ...input, sourcePath: 'alias/note.md' }; }
      else if (kind === 'root-link') { const link = path.join(f.base, 'alias'); await fs.symlink(f.root, link); input = { ...input, workspace: { ...input.workspace, rootPath: link } }; }
      else if (kind === 'hardlink') await fs.link(f.at('real.md'), f.at('note.md'));
      else if (kind === 'fifo') execFileSync('mkfifo', [f.at('note.md')]);
      else if (kind.startsWith('child-') || kind === 'unsafe-directory') {
        await fs.mkdir(f.at('note.md'), { mode: 0o700 }); input = { ...input, sourceKind: 'directory' };
        if (kind === 'child-link') await fs.symlink('../real.md', f.at('note.md/child'));
        if (kind === 'child-fifo') execFileSync('mkfifo', [f.at('note.md/child')]);
        if (kind === 'child-hardlink') await fs.link(f.at('real.md'), f.at('note.md/child'));
        if (kind === 'unsafe-directory') await fs.chmod(f.at('note.md'), 0o777);
      } else { await put(f.at('note.md')); await fs.chmod(f.at('note.md'), 0o666); }
      await assert.rejects(prepare(input, async () => assert.fail()), error => error instanceof PreparedWorkspacePathMoveError);
      assert.equal(await fs.readFile(f.at('real.md'), 'utf8'), 'peer'); await absent(f.at('renamed.md'));
    });
  }
});

test('source bytes, inode, parent or root changes after prepare never move the replacement', async t => {
  for (const kind of ['bytes', 'inode', 'ancestor', 'ancestor-link', 'root'] as const) await fixture(t, async f => {
    const input = { ...f.input, sourcePath: 'source/note.md', destinationPath: 'target/renamed.md' };
    await put(f.at(input.sourcePath)); await fs.mkdir(f.at('target'), { mode: 0o700 });
    await assert.rejects(prepare(input, async cap => {
      if (kind === 'bytes') await fs.writeFile(f.at(input.sourcePath), 'changed');
      else if (kind === 'inode') { await fs.rename(f.at(input.sourcePath), f.at('source/old.md')); await put(f.at(input.sourcePath), 'D2'); }
      else if (kind === 'root') { await fs.rename(f.root, path.join(f.base, 'old-root')); await fs.mkdir(f.root, { mode: 0o700 }); await put(f.at(input.sourcePath), 'D2'); }
      else { await fs.rename(f.at('source'), f.at('old-source')); if (kind === 'ancestor-link') await fs.symlink('old-source', f.at('source')); else await put(f.at(input.sourcePath), 'D2'); }
      return move(cap);
    }), error => {
      assert(error instanceof PreparedWorkspacePathMoveError, `${kind}: expected prepared error, received ${String((error as Error).name)} / ${String((error as { code?: unknown }).code)}`);
      return true;
    });
    const actualDestination = kind === 'root' ? path.join(f.base, 'old-root/target/renamed.md') : f.at(input.destinationPath);
    await absent(actualDestination); assert.equal(await fs.readFile(f.at(input.sourcePath), 'utf8'), kind === 'bytes' ? 'changed' : kind === 'ancestor-link' ? 'original' : 'D2');
  });
});

test('recursive membership, nested bytes/inode and descendant ctime changes invalidate preparation and post-move assertions', async t => {
  for (const when of ['before', 'after'] as const) for (const kind of ['add', 'remove', 'bytes', 'inode', 'ctime'] as const) await fixture(t, async f => {
    const input = { ...f.input, sourcePath: 'folder', destinationPath: 'moved', sourceKind: 'directory' as const };
    await put(f.at('folder/nested/file'), 'same bytes');
    await assert.rejects(prepare(input, async cap => {
      if (when === 'after') await move(cap);
      const prefix = when === 'before' ? 'folder' : 'moved', filename = f.at(`${prefix}/nested/file`);
      if (kind === 'add') await put(f.at(`${prefix}/new`), 'addition');
      else if (kind === 'remove') await fs.unlink(filename);
      else if (kind === 'bytes') await fs.writeFile(filename, 'new bytes');
      else if (kind === 'inode') { await fs.rename(filename, filename + '-old'); await put(filename, 'same bytes'); }
      else { await fs.chmod(filename, 0o644); await fs.chmod(filename, 0o600); }
      if (when === 'before') await move(cap); else await current(cap);
    }), error => error instanceof PreparedWorkspacePathMoveError);
    if (when === 'before') await absent(f.at('moved')); else await absent(f.at('folder'));
  });
});

test('late destination file, folder or symlink is preserved atomically, as are changed destination parent pins', async t => {
  for (const kind of ['file', 'directory', 'symlink', 'parent-replacement'] as const) await fixture(t, async f => {
    const input = { ...f.input, destinationPath: 'target/renamed.md' }; await put(f.at('note.md')); await fs.mkdir(f.at('target'), { mode: 0o700 });
    const original = snapshot(f.at('note.md')); let occupant: unknown;
    await assert.rejects(prepare(input, async cap => {
      if (kind === 'file') await put(f.at(input.destinationPath), 'occupant');
      else if (kind === 'directory') { await fs.mkdir(f.at(input.destinationPath), { mode: 0o700 }); await put(f.at(input.destinationPath + '/child'), 'occupant'); }
      else if (kind === 'symlink') await fs.symlink('../note.md', f.at(input.destinationPath));
      else { await fs.rename(f.at('target'), f.at('old-target')); await fs.mkdir(f.at('target'), { mode: 0o700 }); await put(f.at(input.destinationPath), 'D2 target'); }
      occupant = snapshot(f.at(input.destinationPath)); return move(cap);
    }), code('destination-occupied', 'scope-changed'));
    assert.deepEqual(snapshot(f.at('note.md')), original); assert.deepEqual(snapshot(f.at(input.destinationPath)), occupant);
  });
});

test('the moved root ctime exception is consumed once; later same-mode root ctime changes invalidate the receipt', async t => {
  for (const directory of [false, true]) await fixture(t, async f => {
    const input: Input = { ...f.input, sourceKind: directory ? 'directory' : 'regular_file' };
    if (directory) { await fs.mkdir(f.at('note.md'), { mode: 0o700 }); await put(f.at('note.md/child'), 'bytes'); }
    else await put(f.at('note.md'));
    await assert.rejects(prepare(input, async cap => {
      await move(cap); await current(cap);
      const before = io.lstatSync(f.at('renamed.md'), { bigint: true });
      await fs.chmod(f.at('renamed.md'), directory ? 0o755 : 0o644);
      await fs.chmod(f.at('renamed.md'), directory ? 0o700 : 0o600);
      const after = io.lstatSync(f.at('renamed.md'), { bigint: true });
      assert.equal(after.mode, before.mode); assert.equal(after.mtimeNs, before.mtimeNs); assert.notEqual(after.ctimeNs, before.ctimeNs);
      await current(cap);
    }), code('source-changed'));
    await absent(f.at('note.md')); assert(io.existsSync(f.at('renamed.md')));
  });
});

test('actual source/destination parent fsync follows rename and same-parent syncing deduplicates its real FD', async t => {
  for (const shared of [false, true]) await fixture(t, async f => {
    const input = { ...f.input, sourcePath: 'source/note.md', destinationPath: shared ? 'source/renamed.md' : 'target/renamed.md' };
    await put(f.at(input.sourcePath)); if (!shared) await fs.mkdir(f.at('target'), { mode: 0o700 });
    const expected = new Set([nodeKey(io.statSync(f.at('source'), { bigint: true })), nodeKey(io.statSync(path.dirname(f.at(input.destinationPath)), { bigint: true }))]);
    const actual: string[] = [], realSync = observedIo.fsync.bind(observedIo);
    t.mock.method(observedIo, 'fsync', (fd: number, callback: SyncCallback) => {
      assert(!io.existsSync(f.at(input.sourcePath)), 'Parent sync must follow the actual rename');
      assert.equal(io.readFileSync(f.at(input.destinationPath), 'utf8'), 'original');
      actual.push(nodeKey(io.fstatSync(fd, { bigint: true }))); realSync(fd, callback);
    });
    await prepare(input, move); assert.deepEqual(new Set(actual), expected); assert.equal(actual.length, expected.size);
  });
});

test('either actual parent fsync ACK failure leaves moved evidence; recovery re-syncs without touching a new source D2', async t => {
  for (const failureAt of [1, 2]) await fixture(t, async f => {
    const input = { ...f.input, sourcePath: 'source/note.md', destinationPath: 'target/renamed.md' };
    await put(f.at(input.sourcePath)); await fs.mkdir(f.at('target'), { mode: 0o700 });
    const expected = snapshot(f.at(input.sourcePath)), realSync = observedIo.fsync.bind(observedIo); let calls = 0, original!: Original;
    t.mock.method(observedIo, 'fsync', (fd: number, callback: SyncCallback) => {
      const failed = ++calls === failureAt;
      realSync(fd, error => callback(error ?? (failed ? Object.assign(new Error('actual fsync acknowledgement lost'), { code: 'EIO' }) : null)));
    });
    await assert.rejects(prepare(input, async cap => { original = read(cap); return move(cap); }), error => error instanceof PreparedWorkspacePathMoveError && error.mutationAttempted);
    await absent(f.at(input.sourcePath)); assert.deepEqual(snapshot(f.at(input.destinationPath)), expected); t.mock.restoreAll();
    await put(f.at(input.sourcePath), 'new source D2'); const d2 = snapshot(f.at(input.sourcePath)), synced: string[] = [];
    t.mock.method(observedIo, 'fsync', (fd: number, callback: SyncCallback) => { synced.push(nodeKey(io.fstatSync(fd, { bigint: true }))); realSync(fd, callback); });
    await recover({ workspace: input.workspace, original: clone(original) }, async cap => {
      assert.equal(disposition(cap), 'already_moved'); await move(cap); await current(cap);
    });
    assert.equal(new Set(synced).size, 2); assert.deepEqual(snapshot(f.at(input.sourcePath)), d2); assert.deepEqual(snapshot(f.at(input.destinationPath)), expected);
  });
});

test('recovery resumes original source, tolerates unrelated parent mtime, and proves original destination with D2 source preserved', async t => {
  for (const isDirectory of [false, true]) await fixture(t, async f => {
    const input: Input = { ...f.input, sourceKind: isDirectory ? 'directory' : 'regular_file' };
    if (isDirectory) { await fs.mkdir(f.at('note.md'), { mode: 0o700 }); await put(f.at('note.md/asset.pdf'), '%PDF'); }
    else await put(f.at('note.md'));
    let original!: Original; await prepare(input, async cap => { original = read(cap); });
    await put(f.at('neighbor'), 'unrelated directory mtime'); const expected = snapshot(f.at('note.md'));
    const first = await recover({ workspace: input.workspace, original: clone(original) }, async cap => {
      assert.equal(disposition(cap), 'pending'); assert.deepEqual(read(cap), original); await current(cap); return move(cap);
    });
    assert.equal(first.observation.kind, 'moved'); assert.deepEqual(snapshot(f.at('renamed.md')), expected);
    await put(f.at('note.md'), 'new D2'); const d2 = snapshot(f.at('note.md'));
    await recover({ workspace: input.workspace, original }, async cap => { assert.equal(disposition(cap), 'already_moved'); await move(cap); await current(cap); });
    assert.deepEqual(snapshot(f.at('note.md')), d2); assert.deepEqual(snapshot(f.at('renamed.md')), expected);
  });
});

test('recovery rejects both/neither/replaced/corrupted original and historical root/parent drift without adopting new objects', async t => {
  for (const kind of ['both', 'neither', 'foreign-destination', 'only-D2', 'corrupted', 'destination-parent', 'root'] as const) await fixture(t, async f => {
    const input = { ...f.input, sourcePath: 'source/note.md', destinationPath: 'target/renamed.md' };
    await put(f.at(input.sourcePath)); await fs.mkdir(f.at('target'), { mode: 0o700 }); let original!: Original;
    await prepare(input, async cap => { original = read(cap); if (['both', 'corrupted', 'destination-parent', 'root'].includes(kind)) await move(cap); });
    if (kind === 'both') await fs.link(f.at(input.destinationPath), f.at(input.sourcePath));
    else if (kind === 'neither') await fs.unlink(f.at(input.sourcePath));
    else if (kind === 'foreign-destination') await put(f.at(input.destinationPath), 'foreign');
    else if (kind === 'only-D2') { await fs.unlink(f.at(input.sourcePath)); await put(f.at(input.sourcePath), 'D2'); }
    else if (kind === 'corrupted') await fs.writeFile(f.at(input.destinationPath), 'corrupted');
    else if (kind === 'destination-parent') { await fs.rename(f.at('target'), f.at('old-target')); await fs.mkdir(f.at('target'), { mode: 0o700 }); }
    else { await fs.rename(f.root, path.join(f.base, 'old-root')); await fs.mkdir(f.root, { mode: 0o700 }); }
    const before = snapshot(f.base);
    await assert.rejects(recover({ workspace: input.workspace, original }, async () => assert.fail()), error => error instanceof PreparedWorkspacePathMoveError);
    assert.deepEqual(snapshot(f.base), before);
  });
});

test('recovery copies strict original/parent facts before awaits; forged shapes and accessors never become filesystem authority', async t => fixture(t, async f => {
  await put(f.at('note.md')); let original!: Original; await prepare(f.input, async cap => { original = read(cap); });
  for (const alter of [
    (value: Record<string, unknown>) => { value.version = 2; },
    (value: Record<string, unknown>) => { value.extra = true; },
    (value: Record<string, unknown>) => { value.destinationPath = '../outside'; },
    (value: Record<string, unknown>) => { (value.source as { sha256: string }).sha256 = 'not-a-hash'; },
    (value: Record<string, unknown>) => { ((value.source as { identity: { inode: string } }).identity).inode = '01'; },
  ]) {
    const copy = clone(original) as unknown as Record<string, unknown>; alter(copy);
    await assert.rejects(recover({ workspace: f.input.workspace, original: copy as unknown as Original }, async () => assert.fail()), code('invalid-input'));
  }
  let getters = 0; const copy = clone(original);
  Object.defineProperty(copy.source, 'identity', { enumerable: true, get() { getters++; return {}; } });
  await assert.rejects(recover({ workspace: f.input.workspace, original: copy }, async () => assert.fail()), code('invalid-input')); assert.equal(getters, 0);
  const entered = gate(), release = gate(), realRead = observedIo.read.bind(observedIo); let once = true;
  t.mock.method(observedIo, 'read', (fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: ReadCallback) => {
    realRead(fd, buffer, offset, length, position, (error, bytesRead, result) => {
      if (once) { once = false; entered.resolve(); void release.promise.then(() => callback(error, bytesRead, result)); } else callback(error, bytesRead, result);
    });
  });
  const mutable = clone(original) as unknown as Record<string, unknown>;
  const operation = recover({ workspace: f.input.workspace, original: mutable as unknown as Original }, async cap => { assert.deepEqual(read(cap), original); return move(cap); });
  void operation.catch(() => {});
  try { await bounded(entered.promise); mutable.sourcePath = 'D2.md'; mutable.destinationPath = 'outside.md'; release.resolve(); await bounded(operation); }
  finally { release.resolve(); await Promise.allSettled([operation]); }
  assert.equal(await fs.readFile(f.at('renamed.md'), 'utf8'), 'original'); await absent(f.at('outside.md'));
}));

test('forged, retained, nested, reentrant and repeated capabilities poison the active callback even if misuse is caught', async t => {
  for (const kind of ['forged-read', 'forged-disposition', 'nested', 'repeated', 'throw-undefined'] as const) await fixture(t, async f => {
    await put(f.at('note.md'));
    await assert.rejects(prepare(f.input, async cap => {
      if (kind === 'forged-read') { try { read({} as Capability); } catch {} }
      else if (kind === 'forged-disposition') { try { disposition({} as Capability); } catch {} }
      else if (kind === 'nested') { try { await prepare(f.input, async () => {}); } catch {} }
      else if (kind === 'repeated') { await move(cap); await assert.rejects(move(cap), code('already-moved')); }
      else throw undefined;
      return 'caught';
    }));
  });
  await fixture(t, async f => {
    await put(f.at('note.md')); let retained!: Capability;
    await prepare(f.input, async cap => { retained = cap; });
    assert.throws(() => read(retained), code('invalid-lifetime')); assert.throws(() => disposition(retained), code('invalid-lifetime'));
    await assert.rejects(move(retained), code('invalid-lifetime')); await assert.rejects(current(retained), code('invalid-lifetime'));
    await assert.rejects(prepare(f.input, async () => { try { read(retained); } catch {} }), code('invalid-lifetime'));
  });
});

test('unawaited actual read/move/assertion drains before native FD disposal and revokes detached callbacks', async t => {
  for (const assertion of [false, true]) await fixture(t, async f => {
    await put(f.at('note.md')); const entered = gate(), release = gate(), returned = gate(), realRead = observedIo.read.bind(observedIo);
    let armed = false, pending!: Promise<unknown>, retained!: Capability, closedEarly = false;
    t.mock.method(observedIo, 'read', (fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: ReadCallback) => {
      realRead(fd, buffer, offset, length, position, (error, bytesRead, result) => {
        if (armed) { armed = false; entered.resolve(); void release.promise.then(() => {
          try { io.fstatSync(fd); } catch { closedEarly = true; } callback(error, bytesRead, result);
        }); } else callback(error, bytesRead, result);
      });
    });
    const operation = prepare(f.input, async cap => {
      retained = cap; if (assertion) await move(cap); armed = true; pending = assertion ? current(cap) : move(cap);
      void pending.catch(() => {});
      await bounded(entered.promise); returned.resolve();
    });
    void operation.catch(() => {});
    try {
      await bounded(returned.promise); await new Promise<void>(resolve => setImmediate(resolve));
      assert(ownedDescriptors(f.base).length >= 2); release.resolve();
      await assert.rejects(operation, code('unawaited-operation')); await assert.rejects(pending); assert.equal(closedEarly, false);
      await assert.rejects(move(retained), code('invalid-lifetime')); assert.deepEqual(ownedDescriptors(f.base), []);
    } finally { release.resolve(); await Promise.allSettled([operation, pending]); }
  });
});

test('reentrant move poisons the first actual in-flight operation, drains it, and keeps the original object', async t => fixture(t, async f => {
  await put(f.at('note.md')); const entered = gate(), release = gate(), realRead = observedIo.read.bind(observedIo); let armed = false;
  t.mock.method(observedIo, 'read', (fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: ReadCallback) => {
    realRead(fd, buffer, offset, length, position, (error, bytesRead, result) => {
      if (armed) { armed = false; entered.resolve(); void release.promise.then(() => callback(error, bytesRead, result)); } else callback(error, bytesRead, result);
    });
  });
  await assert.rejects(prepare(f.input, async cap => {
    armed = true; const first = move(cap); void first.catch(() => {});
    try { await bounded(entered.promise); await assert.rejects(move(cap), code('reentrant-operation')); }
    finally { release.resolve(); }
    await assert.rejects(first); return 'caught';
  }), code('reentrant-operation'));
  assert.equal(await fs.readFile(f.at('note.md'), 'utf8'), 'original'); await absent(f.at('renamed.md'));
}));

test('callback error after a real move preserves exact primary failure and original destination without rollback', async t => fixture(t, async f => {
  await put(f.at('note.md')); const primary = new Error('durable owner receipt failed'), expected = snapshot(f.at('note.md'));
  await assert.rejects(prepare(f.input, async cap => { await move(cap); throw primary; }), error => error === primary);
  assert.deepEqual(snapshot(f.at('renamed.md')), expected); await absent(f.at('note.md'));
}));

test('every real close-then-lost-ACK is attempted once and retained alongside an original callback error', async t => {
  for (const withPrimary of [false, true]) await fixture(t, async f => {
    await put(f.at('note.md')); const primary = new Error('owner COMMIT unknown'), errors: Error[] = [], counts = new Map<number, number>();
    const realClose = observedIo.closeSync.bind(observedIo); let armed = false;
    t.mock.method(observedIo, 'closeSync', (fd: number) => {
      if (!armed) return realClose(fd);
      const owned = fixtureNodes(f.base).has(nodeKey(io.fstatSync(fd, { bigint: true })));
      if (!owned) return realClose(fd);
      counts.set(fd, (counts.get(fd) ?? 0) + 1); const lost = new Error(`close acknowledgement ${fd}`); errors.push(lost);
      realClose(fd); throw lost;
    });
    await assert.rejects(prepare(f.input, async cap => { await move(cap); armed = true; if (withPrimary) throw primary; }), error => {
      assert(error instanceof PreparedWorkspacePathMoveError); assert.equal(error.code, 'disposal-unconfirmed'); assert.equal(error.status, 503);
      assert.equal(error.mutationAttempted, true); assert(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors.length, errors.length + Number(withPrimary));
      if (withPrimary) assert.equal(error.cause.errors[0], primary);
      for (const lost of errors) assert.equal(error.cause.errors.filter(value => value === lost || value instanceof Error && value.cause === lost).length, 1);
      return true;
    });
    assert(errors.length >= 2); assert([...counts.values()].every(count => count === 1));
    for (const fd of counts.keys()) assert.throws(() => io.fstatSync(fd), { code: 'EBADF' });
    assert.equal(await fs.readFile(f.at('renamed.md'), 'utf8'), 'original'); await absent(f.at('note.md'));
  });
});

test('case-only rename follows actual filesystem aliases and retains the exact original inode through recovery', async t => fixture(t, async f => {
  await put(f.at('Case.md')); const input = { ...f.input, sourcePath: 'Case.md', destinationPath: 'case.md' };
  const aliases = io.existsSync(f.at('case.md')), expected = snapshot(f.at('Case.md')); let original!: Original;
  await prepare(input, async cap => { original = read(cap); assert.equal(original.caseOnlyAlias, aliases); await move(cap); await current(cap); });
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['case.md']); assert.deepEqual(snapshot(f.at('case.md')), expected);
  await recover({ workspace: input.workspace, original }, async cap => { assert.equal(disposition(cap), 'already_moved'); await move(cap); await current(cap); });
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['case.md']); assert.deepEqual(snapshot(f.at('case.md')), expected);
}));

test('a case alias can never substitute for the explicitly requested source entry', async t => fixture(t, async f => {
  await put(f.at('Case.md')); const before = snapshot(f.at('Case.md'));
  await assert.rejects(prepare({ ...f.input, sourcePath: 'case.md' }, async () => assert.fail()), code('source-changed', 'unsafe-path'));
  assert.deepEqual(snapshot(f.at('Case.md')), before); assert.deepEqual((await fs.readdir(f.root)).sort(), ['Case.md']);
}));

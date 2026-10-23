import assert from 'node:assert/strict';
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
  decodePreparedWorkspacePathCopyOriginal as decode, discardPreparedWorkspacePathCopy as discard,
  PreparedWorkspacePathCopyError, type PreparedWorkspacePathCopyInputV3 as Input,
  type PreparedWorkspacePathCopyOriginalV3 as Original, type PreparedPathCopyDerivedFileInput as Derived,
} from '../app/lib/filesystem/prepared-workspace-path-copy';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

// Actual FD mechanics only. These scopes grant no ACL, journal provenance,
// current SQL authority or Scene birth; those remain the original owner's job.
type Fixture = { input: Input; source(name: string): string; target(name: string): string };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const actualFstat = io.fstatSync.bind(io);
const nodeKey = (info: BigIntStats) => `${info.dev}:${info.ino}`;
const code = (expected: string) => (error: unknown) => error instanceof PreparedWorkspacePathCopyError && error.code === expected;
function workspace(rootPath: string): WorkspaceContext {
  return { workspaceId: `copy-v3-${randomUUID()}`, workspaceType: 'personal', organizationId: null, rootPath, legacy: false,
    permissions: { canRead: false, canWrite: false, canDelete: false, canRunAgent: false,
      canManageWorkspace: false, canCreatePublicLinks: false } };
}
function derived(pathname: string, content = '{"type":"excalidraw","elements":[]}'): Derived {
  const bytes = new Uint8Array(Buffer.from(content));
  return { path: pathname, provider: 'excalidraw', documentId: randomUUID(), lineageId: randomUUID(),
    lifecycleGeneration: 1, sourceContentProof: digest(bytes), bytes };
}
async function fixture(t: TestContext, operation: (f: Fixture) => Promise<void>): Promise<void> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-prepared-copy-v3-')));
  await fs.chmod(base, 0o700); const birth = await fs.lstat(base, { bigint: true });
  const sourceRoot = path.join(base, 'source'), targetRoot = path.join(base, 'target');
  await fs.mkdir(sourceRoot, { mode: 0o700 }); await fs.mkdir(targetRoot, { mode: 0o700 });
  const ownedNodes = new Set<string>(), statIo = io as unknown as { fstatSync(fd: number, options?: { bigint?: boolean }): BigIntStats };
  t.mock.method(statIo, 'fstatSync', (fd: number, options?: { bigint?: boolean }) => {
    const actual = Reflect.apply(actualFstat, io, [fd, options]) as BigIntStats;
    if (fd >= 3 && typeof actual.dev === 'bigint') ownedNodes.add(nodeKey(actual)); return actual;
  });
  try {
    await operation({ source: name => path.join(sourceRoot, name), target: name => path.join(targetRoot, name),
      input: { sourceWorkspace: workspace(sourceRoot), destinationWorkspace: workspace(targetRoot), sourcePath: 'drawing.excalidraw',
        destinationPath: 'copy.excalidraw', sourceKind: 'projection_absent', projectionPaths: [],
        sourceProjectionPolicy: 'provider-derived-files-v3', derivedFiles: [derived('drawing.excalidraw')] } });
  } finally {
    t.mock.restoreAll(); const leaked: number[] = [];
    for (const name of io.readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd')) {
      const fd = Number(name); if (!Number.isInteger(fd) || fd < 3) continue;
      try { if (ownedNodes.has(nodeKey(actualFstat(fd, { bigint: true })))) leaked.push(fd); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error; }
    }
    assert.deepEqual(leaked, [], 'Every actual owned FD closes, including replaced source and unlinked staged inodes.');
    const actual = await fs.lstat(base, { bigint: true });
    assert.equal(actual.dev, birth.dev); assert.equal(actual.ino, birth.ino); assert.equal(actual.uid, birth.uid);
    assert.equal(actual.mode & BigInt(0o777), BigInt(0o700)); await fs.rm(base, { recursive: true, force: false });
  }
}
async function put(filename: string, bytes: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
}
async function absent(filename: string): Promise<void> { await assert.rejects(fs.lstat(filename), { code: 'ENOENT' }); }
function v3(value: ReturnType<typeof read>): Original { assert.equal(value.version, 3); if (value.version !== 3) assert.fail(); return value; }
const payload = (f: Fixture, original: Original) => { assert(original.staging); return f.target(original.staging.relativePath + '/payload'); };
async function resume(f: Fixture, original: Original, operation: Parameters<typeof recover>[1]): Promise<void> {
  await recover({ sourceWorkspace: f.input.sourceWorkspace, destinationWorkspace: f.input.destinationWorkspace, original }, operation);
}

test('V3 creates real payloads for missing Scenes and virtual Scene directories, including parent ACKs and uppercase names', async t => fixture(t, async f => {
  const cases: Input[] = [{ ...f.input, destinationPath: 'new/deeper/copy.excalidraw' },
    { ...f.input, sourcePath: 'virtual', destinationPath: 'virtual-copy', derivedFiles: [derived('virtual/deep/DRAWING.EXCALIDRAW')] }];
  for (const input of cases) {
    await prepare(input, async cap => {
      const original = v3(read(cap)); assert.equal(original.source.kind, 'projection_absent'); assert(original.staging);
      assert.deepEqual(decode(clone(original)), original); assert.deepEqual(original.projectionPaths, []);
      const file = original.derivedFiles[0], relative = input.sourcePath === file.path ? '' : file.path.slice(input.sourcePath.length + 1);
      assert.equal(file.provider, 'excalidraw'); assert.equal(file.sizeBytes, input.derivedFiles[0].bytes.byteLength);
      assert.equal(file.sha256, digest(input.derivedFiles[0].bytes)); assert.equal(Object.hasOwn(file, 'bytes'), false);
      assert.deepEqual(await fs.readFile(path.join(payload(f, original), relative)), Buffer.from(input.derivedFiles[0].bytes));
      await absent(f.target(input.destinationPath)); const parents: string[] = [];
      const receipt = await publish(cap, async parent => { parentCurrent(cap, parent); parents.push(parent.relativePath); });
      assert.deepEqual(parents, input.destinationPath.startsWith('new/') ? ['new', 'new/deeper'] : []);
      assert.equal(receipt.observation.kind, 'published'); await receiptCurrent(cap, receipt);
      assert.deepEqual(await fs.readFile(f.target(input.destinationPath + (relative ? '/' + relative : ''))), Buffer.from(input.derivedFiles[0].bytes));
    });
    await absent(f.source(input.sourcePath));
  }
}));

test('V3 mixed output preserves ordinary Markdown, binary PDF and empty directories, omits Yjs and overlays existing/missing Scene leaves', async t => fixture(t, async f => {
  const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0xff, 0x80]);
  await put(f.source('folder/native.md'), 'stale Yjs projection'); await put(f.source('folder/ordinary.md'), '# literal asset\r\n');
  await put(f.source('folder/file.pdf'), pdf); await put(f.source('folder/drawing.excalidraw'), 'stale Scene projection');
  await fs.mkdir(f.source('folder/empty'), { mode: 0o700 });
  const before = await fs.lstat(f.source('folder/file.pdf'), { bigint: true });
  const files = [derived('folder/drawing.excalidraw', 'actual first Scene'), derived('folder/new/sub/other.excalidraw', 'actual second Scene')];
  await prepare({ ...f.input, sourcePath: 'folder', destinationPath: 'folder-copy', sourceKind: 'directory',
    projectionPaths: ['folder/native.md', 'folder/missing.md'], derivedFiles: files }, async cap => {
    const original = v3(read(cap)); assert.equal(original.source.kind, 'directory'); assert.equal(original.staging?.payload.kind, 'directory');
    assert.deepEqual(original.projectionPaths, ['folder/missing.md', 'folder/native.md']); assert.equal(original.derivedFiles.length, 2);
    assert.deepEqual(decode(clone(original)), original); const staged = payload(f, original);
    await absent(path.join(staged, 'native.md')); await absent(path.join(staged, 'missing.md'));
    assert.deepEqual(await fs.readFile(path.join(staged, 'file.pdf')), pdf);
    assert.equal(await fs.readFile(path.join(staged, 'ordinary.md'), 'utf8'), '# literal asset\r\n');
    assert.deepEqual(await fs.readdir(path.join(staged, 'empty')), []);
    for (const file of files) assert.deepEqual(await fs.readFile(path.join(staged, file.path.slice('folder/'.length))), Buffer.from(file.bytes));
    const receipt = await publish(cap); await receiptCurrent(cap, receipt);
  });
  assert.deepEqual(await fs.readFile(f.target('folder-copy/file.pdf')), pdf);
  assert.notEqual((await fs.stat(f.target('folder-copy/file.pdf'), { bigint: true })).ino, before.ino);
  assert.equal((await fs.lstat(f.source('folder/file.pdf'), { bigint: true })).ino, before.ino);
  assert.equal(await fs.readFile(f.source('folder/drawing.excalidraw'), 'utf8'), 'stale Scene projection');
  await absent(f.target('folder-copy/native.md')); await absent(f.source('folder/new'));
}));

test('V3 retains a raced destination, recovers original durable bytes and publishes through no-replace', async t => fixture(t, async f => {
  let original!: Original;
  await prepare(f.input, async cap => { original = v3(read(cap)); });
  const staged = payload(f, original), bytes = await fs.readFile(staged), held = await fs.stat(staged, { bigint: true });
  await put(f.target('copy.excalidraw'), 'foreign destination'); const foreign = await fs.stat(f.target('copy.excalidraw'), { bigint: true });
  await assert.rejects(resume(f, original, async () => assert.fail('A raced target cannot be adopted.')), code('recovery-conflict'));
  assert.equal((await fs.stat(f.target('copy.excalidraw'), { bigint: true })).ino, foreign.ino);
  assert.equal(await fs.readFile(f.target('copy.excalidraw'), 'utf8'), 'foreign destination');
  assert.equal((await fs.stat(staged, { bigint: true })).ino, held.ino); assert.deepEqual(await fs.readFile(staged), bytes);
  await fs.unlink(f.target('copy.excalidraw'));
  await resume(f, original, async cap => {
    assert.equal(disposition(cap), 'pending'); const receipt = await publish(cap);
    assert.equal(receipt.observation.kind, 'published');
    if (receipt.observation.kind !== 'published') assert.fail();
    assert.equal(receipt.observation.method, 'rename-no-replace'); await receiptCurrent(cap, receipt);
  });
  assert.equal((await fs.stat(f.target('copy.excalidraw'), { bigint: true })).ino, held.ino);
  assert.deepEqual(await fs.readFile(f.target('copy.excalidraw')), bytes); await absent(f.target(original.staging!.relativePath));
  await resume(f, original, async cap => { assert.equal(disposition(cap), 'already_published'); await current(cap); await receiptCurrent(cap, await publish(cap)); });
  await absent(f.source('drawing.excalidraw'));
}));

test('V3 never reads a Scene projection as content and captures owned input bytes across alias mutation and checkpoint replacement', async t => fixture(t, async f => {
  await put(f.source('drawing.excalidraw'), 'wrong physical bytes'); const before = await fs.stat(f.source('drawing.excalidraw'), { bigint: true });
  const sources = new Set([nodeKey(before)]); let sourceReads = 0;
  type Callback = (error: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer) => void;
  const observed = io as unknown as { read(fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: Callback): void };
  const realRead = observed.read.bind(observed);
  t.mock.method(observed, 'read', (fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: Callback) => {
    if (sources.has(nodeKey(actualFstat(fd, { bigint: true })))) sourceReads++;
    assert.equal(sourceReads, 0, 'Projection contents must never be hashed or copied.'); realRead(fd, buffer, offset, length, position, callback);
  });
  const expected = Buffer.from(f.input.derivedFiles[0].bytes);
  await prepare({ ...f.input, sourceKind: 'regular_file' }, async cap => {
    const original = v3(read(cap)); assert.equal(original.source.kind, 'projection_file');
    f.input.derivedFiles[0].bytes.fill(0x7f);
    await put(f.source('replacement.excalidraw'), 'later physical checkpoint');
    await fs.rename(f.source('replacement.excalidraw'), f.source('drawing.excalidraw'));
    sources.add(nodeKey(await fs.stat(f.source('drawing.excalidraw'), { bigint: true })));
    await current(cap); assert.deepEqual(await fs.readFile(payload(f, original)), expected);
    await receiptCurrent(cap, await publish(cap));
  });
  assert.equal(sourceReads, 0); assert.deepEqual(await fs.readFile(f.target('copy.excalidraw')), expected);
  assert.equal(await fs.readFile(f.source('drawing.excalidraw'), 'utf8'), 'later physical checkpoint');
}));

test('V3 rejects bare names, budgets, accessors/proxies, historical downgrades and actual owned payload tampering', async t => fixture(t, async f => {
  for (const name of ['.excalidraw', '.EXCALIDRAW', 'nested/.ExCaLiDrAw']) {
    await assert.rejects(prepare({ ...f.input, sourcePath: name, derivedFiles: [derived(name)] }, async () => assert.fail()), code('invalid-input'));
  }
  await assert.rejects(prepare({ ...f.input, budget: { maxDepth: 32, maxEntries: 10_000, maxHashBytes: f.input.derivedFiles[0].bytes.length - 1 } },
    async () => assert.fail()), code('budget-exceeded'));
  await assert.rejects(prepare({ ...f.input, sourcePath: 'virtual', derivedFiles: [derived('virtual/deep/drawing.excalidraw')],
    budget: { maxDepth: 1, maxEntries: 10, maxHashBytes: 1000 } }, async () => assert.fail()), code('budget-exceeded'));
  let getters = 0, traps = 0; const accessor = { ...f.input.derivedFiles[0] };
  Object.defineProperty(accessor, 'bytes', { enumerable: true, get() { getters++; throw new Error('not called'); } });
  await assert.rejects(prepare({ ...f.input, derivedFiles: [accessor] }, async () => assert.fail()), code('invalid-input'));
  const proxy = new Proxy(f.input.derivedFiles[0], { getPrototypeOf() { traps++; throw new Error('not called'); }, ownKeys() { traps++; throw new Error('not called'); } });
  await assert.rejects(prepare({ ...f.input, derivedFiles: [proxy] }, async () => assert.fail()), code('invalid-input'));
  assert.equal(getters, 0); assert.equal(traps, 0); assert.deepEqual(await fs.readdir(f.target('')), []);
  let original!: Original;
  await assert.rejects(prepare(f.input, async cap => {
    original = v3(read(cap));
    for (const version of [1, 2]) assert.throws(() => decode({ ...clone(original), version }), code('invalid-input'));
    const staged = payload(f, original), bytes = await fs.readFile(staged); bytes[0] ^= 1;
    await fs.writeFile(staged, bytes); await current(cap);
  }), code('staging-changed'));
  await absent(f.target('copy.excalidraw'));
  await assert.rejects(resume(f, original, async () => assert.fail()), code('staging-changed'));
  assert((await fs.lstat(payload(f, original))).isFile(), 'Unconfirmed durable payload is retained, never republished.');
  // A separate fresh preparation still disposes its own private stage through
  // the existing capability; fixture teardown retains responsibility for the
  // deliberately corrupted original tree.
  await prepare({ ...f.input, destinationPath: 'discarded.excalidraw' }, async cap => { await discard(cap); });
  await absent(f.target('discarded.excalidraw'));
}));

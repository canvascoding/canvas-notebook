import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { movePreparedWorkspaceSingleFileTrash as move, readPreparedWorkspaceSingleFileTrash as read,
  withPreparedWorkspaceSingleFileTrash as prepare, withRecoveredWorkspaceSingleFileTrash as recover, PreparedSingleFileTrashError,
  assertPreparedWorkspaceSingleFileTrashCurrent as assertCurrent,
  withPreparedWorkspaceSingleFileRestore as prepareRestore, withRecoveredWorkspaceSingleFileRestore as recoverRestore,
  readPreparedWorkspaceSingleFileRestore as readRestore, restorePreparedWorkspaceSingleFileTrash as restore,
  assertPreparedWorkspaceSingleFileRestoreCurrent as assertRestoreCurrent,
  type PreparedWorkspaceSingleFileTrash, type PreparedWorkspaceSingleFileTrashInput, type PreparedSingleFileTrashOriginalFacts,
  type PreparedWorkspaceSingleFileRestore, type PreparedSingleFileRestoreOriginalFacts, type PreparedSingleFileTrashReceipt } from '../app/lib/filesystem/prepared-single-file-trash';
import { absoluteDataPath, trashRelativePathFor } from '../app/lib/filesystem/workspace-trash-layout';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function fixture(run: (input: PreparedWorkspaceSingleFileTrashInput, data: string) => Promise<void>) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-prepared-trash-'));
  const data = await fs.realpath(temporary), root = path.join(data, 'workspace');
  await fs.mkdir(root);
  const workspace: WorkspaceContext = { workspaceId: `ws-${randomUUID()}`, workspaceType: 'personal', organizationId: null,
    rootPath: root, legacy: false, permissions: { canRead: false, canWrite: false, canDelete: false, canCreatePublicLinks: false,
      canManageWorkspace: false, canRunAgent: false } };
  try { await run({ workspace, dataRoot: data, canonicalPath: 'note.md', trashEntryId: `trash-${randomUUID()}` }, data); }
  finally { await fs.rm(data, { recursive: true, force: true }); }
}
function destination(input: PreparedWorkspaceSingleFileTrashInput): string {
  return absoluteDataPath(trashRelativePathFor(input.workspace, input.trashEntryId, input.canonicalPath), input.dataRoot);
}
const code = (expected: PreparedSingleFileTrashError['code']) => (error: unknown) =>
  error instanceof PreparedSingleFileTrashError && error.code === expected;
function track(t: TestContext) {
  const original = fs.open.bind(fs), handles: FileHandle[] = [], flags: number[] = [];
  t.mock.method(fs, 'open', async (file: string, mode: number) => {
    const handle = await original(file, mode); handles.push(handle); flags.push(mode); return handle;
  });
  return { assertClosed: () => {
    assert(handles.length > 0); assert(handles.every(handle => handle.fd === -1));
    assert(flags.every(value => (value & constants.O_NOFOLLOW) !== 0));
    assert(flags.some(value => (value & constants.O_DIRECTORY) !== 0));
  }, handles };
}
async function absent(file: string) { await assert.rejects(() => fs.lstat(file), { code: 'ENOENT' }); }
function gate() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('FS barrier timed out')), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

test('literal whitespace, opaque bytes over 5 MiB and frozen real rename proofs preserve the neighbor', async t => fixture(async input => {
  input = { ...input, canonicalPath: ' Folder / note.md ' };
  await fs.mkdir(path.join(input.workspace.rootPath, ' Folder '));
  const bytes = Buffer.alloc(6 * 1024 * 1024 + 7, 0x9d); bytes.set([0xef, 0xbb, 0xbf, 0x00, 0xff]);
  const source = path.join(input.workspace.rootPath, input.canonicalPath);
  await fs.writeFile(source, bytes); await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'neighbor');
  const before = await fs.stat(source), tracked = track(t); let facts;
  const receipt = await prepare(input, async cap => {
    facts = read(cap);
    assert(Object.isFrozen(facts) && Object.isFrozen(facts.workspace) && Object.isFrozen(facts.source));
    assert.equal(facts.canonicalPath, ' Folder / note.md '); assert.equal(facts.workspace.rootPath, input.workspace.rootPath);
    assert.equal(facts.source.kind, 'regular_file');
    if (facts.source.kind !== 'regular_file') assert.fail('regular file expected');
    assert(Object.isFrozen(facts.source.identity));
    assert.equal(facts.source.identity.inode, before.ino); assert.equal(facts.source.identity.size, bytes.length);
    assert.equal(facts.source.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(facts.expiresAtMs - facts.deletedAtMs, facts.retentionDays * 86400000);
    assert.deepEqual(JSON.parse(JSON.stringify(facts)), facts); assert.equal(Object.keys(cap).length, 0);
    return move(cap);
  });
  assert(Object.isFrozen(receipt) && Object.isFrozen(receipt.observation)); assert.equal(receipt.original, facts);
  assert.equal(receipt.observation.kind, 'moved');
  if (receipt.observation.kind !== 'moved') assert.fail('moved expected');
  assert.equal(receipt.observation.method, 'rename'); assert.equal(receipt.observation.identity.inode, before.ino);
  assert.equal((await fs.stat(destination(input))).ino, before.ino);
  assert.deepEqual(await fs.readFile(destination(input)), bytes); await absent(source);
  assert.equal(await fs.readFile(path.join(input.workspace.rootPath, 'note.md'), 'utf8'), 'neighbor'); tracked.assertClosed();
}));

test('zero-byte files have genuine inode/hash evidence; absent leaf or parent has only projection absence', async t => fixture(async input => {
  await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), Buffer.alloc(0)); const tracked = track(t);
  const empty = await prepare(input, async cap => move(cap));
  assert.equal(empty.original.source.kind, 'regular_file');
  if (empty.original.source.kind !== 'regular_file') assert.fail('file expected');
  assert.equal(empty.original.source.identity.size, 0);
  assert.equal(empty.original.source.sha256, createHash('sha256').digest('hex'));
  for (const canonicalPath of ['native-only.md', 'missing/folder/native-only.docx']) {
    const candidate = { ...input, canonicalPath, trashEntryId: `trash-${randomUUID()}` };
    const receipt = await prepare(candidate, async cap => {
      assert.deepEqual(read(cap).source, { kind: 'projection_absent' }); return move(cap);
    });
    assert.deepEqual(receipt.observation, { kind: 'projection_absent' });
    assert.deepEqual(receipt.original.source, { kind: 'projection_absent' });
    await absent(destination(candidate));
  }
  await absent(path.join(input.workspace.rootPath, 'missing')); tracked.assertClosed();
}));

test('strict copied input rejects traversal/root/accessors before opening and cannot retarget after await', async t => fixture(async input => {
  await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original');
  let getters = 0;
  const getter = Object.defineProperty({}, 'canonicalPath', { get: () => { getters++; return 'note.md'; } });
  for (const canonicalPath of ['.', '', '/note.md', './note.md', '../note.md', 'a//note.md', 'a/../note.md', 'a\\note.md', 'a\0.md']) {
    await assert.rejects(() => prepare({ ...input, canonicalPath }, async () => assert.fail()), code('invalid-input'));
  }
  const accessorInput = { ...input }; Object.defineProperty(accessorInput, 'canonicalPath', Object.getOwnPropertyDescriptor(getter, 'canonicalPath')!);
  await assert.rejects(() => prepare(accessorInput, async () => assert.fail()), code('invalid-input')); assert.equal(getters, 0);
  const entered = gate(), release = gate(), originalOpen = fs.open.bind(fs); let once = false;
  t.mock.method(fs, 'open', async (file: string, flags: number) => {
    const handle = await originalOpen(file, flags);
    if (!once) { once = true; entered.resolve(); await bounded(release.promise); }
    return handle;
  });
  const mutable = { ...input, workspace: { ...input.workspace } };
  const run = prepare(mutable, async cap => { assert.equal(read(cap).canonicalPath, 'note.md'); return move(cap); });
  await bounded(entered.promise);
  mutable.canonicalPath = 'other.md'; mutable.workspace.rootPath = '/outside'; mutable.dataRoot = '/outside'; mutable.trashEntryId = `trash-${randomUUID()}`;
  release.resolve(); await run;
  assert.equal(await fs.readFile(destination(input), 'utf8'), 'original'); await absent(path.join(input.workspace.rootPath, 'other.md'));
}));

test('root, ancestor and source symlinks, directories, hardlinks and special files are refused', async () => fixture(async (input, data) => {
  const root = input.workspace.rootPath;
  await fs.writeFile(path.join(root, 'target.md'), 'target'); await fs.symlink(path.join(root, 'target.md'), path.join(root, 'link.md'));
  await fs.link(path.join(root, 'target.md'), path.join(root, 'hard.md')); await fs.mkdir(path.join(root, 'folder'));
  await fs.symlink(path.join(root, 'folder'), path.join(root, 'linked-folder'));
  execFileSync('mkfifo', [path.join(root, 'pipe')]);
  for (const canonicalPath of ['link.md', 'target.md', 'hard.md', 'folder', 'linked-folder/file.md', 'pipe']) {
    await assert.rejects(() => prepare({ ...input, canonicalPath }, async () => assert.fail()), code('unsafe-path'));
  }
  await fs.symlink(root, path.join(data, 'root-link'));
  await assert.rejects(() => prepare({ ...input, workspace: { ...input.workspace, rootPath: path.join(data, 'root-link') } }, async () => assert.fail()), code('unsafe-path'));
  await fs.symlink(data, path.join(data, 'data-link'));
  await assert.rejects(() => prepare({ ...input, dataRoot: path.join(data, 'data-link') }, async () => assert.fail()), code('unsafe-path'));
  assert.equal(await fs.readFile(path.join(root, 'target.md'), 'utf8'), 'target');
}));

test('case aliases cannot move a differently named entry on either case-sensitive or insensitive filesystems', async () => fixture(async input => {
  await fs.writeFile(path.join(input.workspace.rootPath, 'Case.md'), 'case original');
  let aliasExists = true; try { await fs.lstat(path.join(input.workspace.rootPath, 'case.md')); } catch { aliasExists = false; }
  if (aliasExists) await assert.rejects(() => prepare({ ...input, canonicalPath: 'case.md' }, async () => assert.fail()), code('unsafe-path'));
  else {
    const absentCase = await prepare({ ...input, canonicalPath: 'case.md' }, async cap => move(cap));
    assert.equal(absentCase.observation.kind, 'projection_absent');
  }
  assert.equal(await fs.readFile(path.join(input.workspace.rootPath, 'Case.md'), 'utf8'), 'case original');
}));

test('source bytes/inode and source parent/root replacements after preparation never move another target', async () => {
  for (const mode of ['bytes', 'inode', 'ancestor', 'symlink', 'root'] as const) await fixture(async (input, data) => {
    input = { ...input, canonicalPath: 'folder/note.md' }; await fs.mkdir(path.join(input.workspace.rootPath, 'folder'));
    const original = path.join(input.workspace.rootPath, input.canonicalPath); await fs.writeFile(original, 'original');
    await assert.rejects(() => prepare(input, async cap => {
      if (mode === 'bytes') await fs.writeFile(original, 'modified');
      else if (mode === 'inode') { await fs.rename(original, `${original}.old`); await fs.writeFile(original, 'replacement'); }
      else if (mode === 'root') {
        await fs.rename(input.workspace.rootPath, path.join(data, 'old-root')); await fs.mkdir(input.workspace.rootPath);
        await fs.mkdir(path.join(input.workspace.rootPath, 'folder')); await fs.writeFile(original, 'replacement');
      } else {
        const parent = path.dirname(original); await fs.rename(parent, `${parent}.old`);
        if (mode === 'symlink') await fs.symlink(`${parent}.old`, parent);
        else { await fs.mkdir(parent); await fs.writeFile(original, 'replacement'); }
      }
      return move(cap);
    }), error => error instanceof PreparedSingleFileTrashError);
    await absent(destination(input)); assert.equal((await fs.readFile(original, 'utf8')), mode === 'bytes' ? 'modified' : mode === 'symlink' ? 'original' : 'replacement');
  });
});

test('an initially absent projection appearing before move is rejected and not archived mechanically', async () => fixture(async input => {
  await assert.rejects(() => prepare({ ...input, canonicalPath: 'missing/note.md' }, async cap => {
    assert.equal(read(cap).source.kind, 'projection_absent');
    await fs.mkdir(path.join(input.workspace.rootPath, 'missing')); await fs.writeFile(path.join(input.workspace.rootPath, 'missing/note.md'), 'new native projection');
    return move(cap);
  }), code('source-changed'));
  assert.equal(await fs.readFile(path.join(input.workspace.rootPath, 'missing/note.md'), 'utf8'), 'new native projection');
}));

test('preexisting entry directories, payloads and symlink trash ancestors never clobber existing data', async () => {
  for (const mode of ['entry', 'payload', 'symlink'] as const) await fixture(async input => {
    const source = path.join(input.workspace.rootPath, input.canonicalPath); await fs.writeFile(source, 'original');
    const target = destination(input);
    if (mode === 'symlink') { await fs.mkdir(path.join(input.dataRoot, 'outside')); await fs.symlink(path.join(input.dataRoot, 'outside'), path.join(input.dataRoot, '.trash')); }
    else { await fs.mkdir(path.dirname(target), { recursive: true }); if (mode === 'payload') await fs.writeFile(target, 'existing payload'); }
    await assert.rejects(() => prepare(input, async () => assert.fail()));
    assert.equal(await fs.readFile(source, 'utf8'), 'original');
    if (mode === 'payload') assert.equal(await fs.readFile(target, 'utf8'), 'existing payload');
  });
});

test('late destination occupation and unrelated entries in the reserved directory reject before rename', async () => {
  for (const name of ['note.md', 'other.md']) await fixture(async input => {
    const source = path.join(input.workspace.rootPath, input.canonicalPath); await fs.writeFile(source, 'original');
    await assert.rejects(() => prepare(input, async cap => {
      await fs.writeFile(path.join(path.dirname(destination(input)), name), 'late occupant'); return move(cap);
    }), code('destination-occupied'));
    assert.equal(await fs.readFile(source, 'utf8'), 'original');
    assert.equal(await fs.readFile(path.join(path.dirname(destination(input)), name), 'utf8'), 'late occupant');
  });
});

test('EXDEV refuses copy/remove fallback and closes every actual descriptor', async t => fixture(async input => {
  await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original'); const tracked = track(t);
  let renames = 0;
  t.mock.method(fs, 'rename', async () => { renames++; throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); });
  t.mock.method(fs, 'cp', async () => { assert.fail('must not copy'); });
  await assert.rejects(() => prepare(input, async cap => move(cap)), error => code('cross-device-move')(error)
    && (error as PreparedSingleFileTrashError).moveAttempted && (error as Error).cause instanceof Error);
  assert.equal(renames, 1); assert.equal(await fs.readFile(path.join(input.workspace.rootPath, 'note.md'), 'utf8'), 'original');
  await absent(destination(input)); tracked.assertClosed();
}));

test('callback failure after a genuine move retains its original error and payload without rollback', async t => fixture(async input => {
  await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original'); const tracked = track(t), original = new Error('durable layer failed');
  await assert.rejects(() => prepare(input, async cap => { await move(cap); throw original; }), error => error === original);
  assert.equal(await fs.readFile(destination(input), 'utf8'), 'original'); await absent(path.join(input.workspace.rootPath, 'note.md')); tracked.assertClosed();
}));

test('uncertain rename reply or after-move corruption cannot cause blind rollback or a success receipt', async t => {
  const originalRename = fs.rename.bind(fs);
  for (const mode of ['reply', 'corruption'] as const) await fixture(async input => {
    await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original');
    t.mock.method(fs, 'rename', async (from: string, to: string) => {
      await originalRename(from, to);
      if (mode === 'reply') throw new Error('reply lost');
      await fs.writeFile(to, 'altered after rename');
    });
    let received = false;
    await assert.rejects(() => prepare(input, async cap => { const receipt = await move(cap); received = true; return receipt; }));
    assert.equal(received, false); await absent(path.join(input.workspace.rootPath, 'note.md'));
    assert.equal(await fs.readFile(destination(input), 'utf8'), mode === 'reply' ? 'original' : 'altered after rename');
    t.mock.restoreAll();
  });
});

test('forged/retained/nested/reentrant/repeated misuse is fatal even when caught', async () => {
  for (const mode of ['forged', 'nested', 'reentrant', 'repeated', 'undefined'] as const) await fixture(async input => {
    await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original');
    await assert.rejects(() => prepare(input, async cap => {
      if (mode === 'forged') { try { read({} as PreparedWorkspaceSingleFileTrash); } catch {} }
      else if (mode === 'nested') { try { await prepare({ ...input, trashEntryId: `trash-${randomUUID()}` }, async () => {}); } catch {} }
      else if (mode === 'reentrant') {
        const first = move(cap); await assert.rejects(() => move(cap), code('reentrant-operation')); await assert.rejects(() => first);
      } else if (mode === 'repeated') { await move(cap); await assert.rejects(() => move(cap), code('already-moved')); }
      else throw undefined;
      return 'caller caught';
    }));
  });
  await fixture(async input => {
    let old!: PreparedWorkspaceSingleFileTrash;
    await prepare(input, async cap => { old = cap; });
    assert.throws(() => read(old), code('invalid-lifetime'));
    await assert.rejects(() => move(old), code('invalid-lifetime'));
    await assert.rejects(() => prepare({ ...input, trashEntryId: `trash-${randomUUID()}` }, async () => {
      try { read(old); } catch {} return 'caught old capability';
    }), code('invalid-lifetime'));
  });
});

test('detached work after callback and unawaited in-flight rename fail closed and drain before descriptor disposal', async t => fixture(async input => {
  await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original'); const tracked = track(t);
  const entered = gate(), release = gate(), originalRename = fs.rename.bind(fs); let closedEarly = false;
  t.mock.method(fs, 'rename', async (from: string, to: string) => {
    entered.resolve(); await bounded(release.promise); closedEarly = tracked.handles.some(handle => handle.fd === -1); await originalRename(from, to);
  });
  const returned = gate(); let detached!: Promise<unknown>;
  const run = prepare(input, async cap => { detached = move(cap); await bounded(entered.promise); returned.resolve(); });
  try {
    await bounded(returned.promise); await new Promise<void>(resolve => setImmediate(resolve));
    assert(tracked.handles.every(handle => handle.fd >= 0)); release.resolve();
    await assert.rejects(() => run, code('unawaited-operation')); await assert.rejects(() => detached);
    assert.equal(closedEarly, false); tracked.assertClosed(); assert.equal(await fs.readFile(destination(input), 'utf8'), 'original');
  } finally { release.resolve(); await Promise.allSettled([run]); }
  let retained!: PreparedWorkspaceSingleFileTrash; const wake = gate();
  const second = { ...input, canonicalPath: 'missing.md', trashEntryId: `trash-${randomUUID()}` };
  await prepare(second, async cap => { retained = cap; detached = wake.promise.then(() => move(cap)); });
  wake.resolve(); await assert.rejects(() => detached, code('invalid-lifetime')); assert.throws(() => read(retained), code('invalid-lifetime'));
}));

test('preparation failures and aborted callbacks close all handles and keep source bytes', async t => fixture(async input => {
  const tracked = track(t); await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original');
  const target = destination(input); await fs.mkdir(path.dirname(target), { recursive: true });
  await assert.rejects(() => prepare(input, async () => assert.fail()), { code: 'EEXIST' }); tracked.assertClosed();
  assert.equal(await fs.readFile(path.join(input.workspace.rootPath, 'note.md'), 'utf8'), 'original');
  const second = { ...input, trashEntryId: `trash-${randomUUID()}` };
  await assert.rejects(() => prepare(second, async () => { throw new Error('abort before durable intent'); }), /abort before durable intent/);
  tracked.assertClosed(); await absent(destination(second));
}));

test('original facts contain actual frozen source/DATA/root/ancestor/reservation directory pins', async () => fixture(async input => {
  input = { ...input, canonicalPath: ' outer /inner/note.md' };
  await fs.mkdir(path.join(input.workspace.rootPath, ' outer /inner'), { recursive: true });
  await fs.writeFile(path.join(input.workspace.rootPath, input.canonicalPath), 'original');
  await prepare(input, async cap => {
    const facts = read(cap), physical = facts.filesystem;
    assert(Object.isFrozen(physical) && Object.isFrozen(physical.workspaceRoot) && Object.isFrozen(physical.workspaceRoot.identity)
      && Object.isFrozen(physical.dataRoot) && Object.isFrozen(physical.sourceDirectories) && Object.isFrozen(physical.trashDirectories));
    assert.equal(physical.workspaceRoot.resolvedPath, input.workspace.rootPath);
    assert.equal(physical.workspaceRoot.identity.inode, (await fs.stat(input.workspace.rootPath)).ino);
    assert.equal(physical.dataRoot.identity.inode, (await fs.stat(input.dataRoot)).ino);
    assert.equal(physical.dataRoot.resolvedPath, input.dataRoot); assert.equal(physical.missingSourcePrefix, null);
    assert.deepEqual(physical.sourceDirectories.map(pin => pin.segment), [' outer ', 'inner']);
    let parent = input.workspace.rootPath;
    for (const pin of physical.sourceDirectories) {
      assert(Object.isFrozen(pin) && Object.isFrozen(pin.identity)); parent = path.join(parent, pin.segment);
      assert.equal(pin.identity.inode, (await fs.stat(parent)).ino);
    }
    parent = input.dataRoot;
    for (const pin of physical.trashDirectories) {
      assert(Object.isFrozen(pin) && Object.isFrozen(pin.identity)); parent = path.join(parent, pin.segment);
      assert.equal(pin.identity.inode, (await fs.stat(parent)).ino);
    }
    assert.equal(parent, path.dirname(destination(input)));
    assert.equal(physical.trashDirectories.at(-1)!.identity.mode & 0o077, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(facts)), facts);
  });
}));

test('recovering the durable original source resumes one rename from its immutable historical facts', async t => fixture(async input => {
  input = { ...input, canonicalPath: ' spaced.md' }; const source = path.join(input.workspace.rootPath, input.canonicalPath);
  await fs.writeFile(source, 'original'); const tracked = track(t);
  let original!: PreparedSingleFileTrashOriginalFacts;
  await prepare(input, async cap => { original = read(cap); });
  const beforeRoot = original.filesystem.workspaceRoot.identity;
  await fs.writeFile(path.join(input.workspace.rootPath, 'unrelated.md'), 'directory mtime changes are expected');
  assert.equal((await fs.stat(input.workspace.rootPath)).ino, beforeRoot.inode);
  const receipt = await recover({ workspace: input.workspace, dataRoot: input.dataRoot, original: JSON.parse(JSON.stringify(original)) }, async cap => {
    assert.deepEqual(read(cap), original); assert(Object.isFrozen(read(cap).filesystem)); return move(cap);
  });
  assert.equal(receipt.observation.kind, 'moved'); assert.deepEqual(receipt.original, original);
  assert.equal(await fs.readFile(destination(input), 'utf8'), 'original'); await absent(source); tracked.assertClosed();
}));

test('recovery proves the already moved original without a second rename or opening a recreated D2', async t => {
  for (const recreated of [false, true]) await fixture(async input => {
    input = { ...input, canonicalPath: ' leading.md' }; const source = path.join(input.workspace.rootPath, input.canonicalPath);
    await fs.writeFile(source, 'original'); const first = await prepare(input, async cap => move(cap));
    if (recreated) await fs.writeFile(source, 'D2 must survive');
    const neighbor = path.join(input.workspace.rootPath, 'leading.md'); await fs.writeFile(neighbor, 'neighbor');
    const newSource = recreated ? await fs.stat(source) : null;
    const originalOpen = fs.open.bind(fs); let sourceOpens = 0;
    t.mock.method(fs, 'open', async (file: string, flags: number) => { if (file === source) sourceOpens++; return originalOpen(file, flags); });
    t.mock.method(fs, 'rename', async () => assert.fail('already moved must not rename'));
    const receipt = await recover({ workspace: input.workspace, dataRoot: input.dataRoot, original: first.original }, async cap => move(cap));
    assert.equal(receipt.observation.kind, 'moved'); assert.deepEqual(receipt.original, first.original);
    if (receipt.observation.kind !== 'moved' || first.observation.kind !== 'moved') assert.fail('moved expected');
    assert.equal(receipt.observation.identity.inode, first.observation.identity.inode); assert.equal(receipt.observation.sha256, first.observation.sha256);
    assert.equal(await fs.readFile(destination(input), 'utf8'), 'original'); assert.equal(sourceOpens, 0);
    if (recreated) { assert.equal(await fs.readFile(source, 'utf8'), 'D2 must survive'); assert.equal((await fs.stat(source)).ino, newSource!.ino); }
    else await absent(source);
    assert.equal(await fs.readFile(neighbor, 'utf8'), 'neighbor'); t.mock.restoreAll();
  });
});

test('projection-absence recovery preserves newly present D2 without any payload, source-open or rename', async t => {
  for (const canonicalPath of ['new.md', 'new-folder/deeper/new.md']) await fixture(async input => {
    input = { ...input, canonicalPath }; let original!: PreparedSingleFileTrashOriginalFacts;
    await prepare(input, async cap => { original = read(cap); });
    assert.deepEqual(original.source, { kind: 'projection_absent' });
    const source = path.join(input.workspace.rootPath, canonicalPath);
    await fs.mkdir(path.dirname(source), { recursive: true }); await fs.writeFile(source, 'new D2'); const before = await fs.stat(source);
    const originalOpen = fs.open.bind(fs); let openedSource = false;
    t.mock.method(fs, 'open', async (file: string, flags: number) => { if (file === source) openedSource = true; return originalOpen(file, flags); });
    t.mock.method(fs, 'rename', async () => assert.fail('original absence cannot rename D2'));
    const receipt = await recover({ workspace: input.workspace, dataRoot: input.dataRoot, original }, async cap => move(cap));
    assert.deepEqual(receipt.original, original); assert.deepEqual(receipt.observation, { kind: 'projection_absent' });
    assert.equal(openedSource, false); assert.equal(await fs.readFile(source, 'utf8'), 'new D2'); assert.equal((await fs.stat(source)).ino, before.ino);
    await absent(destination(input)); t.mock.restoreAll();
  });
});

test('recovery rejects both/neither locations, replaced or corrupted trash payload, and a current D2 without original payload', async () => {
  for (const mode of ['both', 'neither', 'replacement', 'corruption', 'only-D2', 'changed-original']) await fixture(async input => {
    const source = path.join(input.workspace.rootPath, input.canonicalPath); await fs.writeFile(source, 'original');
    let original!: PreparedSingleFileTrashOriginalFacts;
    await prepare(input, async cap => { original = read(cap); if (!['neither', 'only-D2', 'changed-original'].includes(mode)) await move(cap); });
    if (mode === 'both') await fs.link(destination(input), source);
    else if (mode === 'replacement') { await fs.rename(destination(input), `${destination(input)}.old`); await fs.writeFile(destination(input), 'replacement'); }
    else if (mode === 'corruption') await fs.writeFile(destination(input), 'corrupted original');
    else if (mode === 'neither') await fs.unlink(source);
    else if (mode === 'only-D2') { await fs.unlink(source); await fs.writeFile(source, 'new D2'); }
    else await fs.writeFile(source, 'changed original');
    await assert.rejects(() => recover({ workspace: input.workspace, dataRoot: input.dataRoot, original }, async () => assert.fail()));
    if (mode === 'only-D2') assert.equal(await fs.readFile(source, 'utf8'), 'new D2');
    if (mode === 'replacement') assert.equal(await fs.readFile(destination(input), 'utf8'), 'replacement');
    if (mode === 'both') assert.equal(await fs.readFile(source, 'utf8'), 'original');
  });
});

test('recovery rejects historical root/ancestor/reservation mismatches instead of adopting current directory identities', async () => {
  for (const mode of ['source-parent', 'workspace-root', 'data-root', 'reservation', 'trash-parent'] as const) await fixture(async input => {
    input = { ...input, canonicalPath: 'folder/note.md' }; await fs.mkdir(path.join(input.workspace.rootPath, 'folder'));
    await fs.writeFile(path.join(input.workspace.rootPath, input.canonicalPath), 'original');
    const first = await prepare(input, async cap => move(cap));
    const target = mode === 'source-parent' ? path.join(input.workspace.rootPath, 'folder')
      : mode === 'workspace-root' ? input.workspace.rootPath : mode === 'data-root' ? input.dataRoot
        : mode === 'reservation' ? path.dirname(destination(input)) : path.join(input.dataRoot, '.trash');
    // A DATA replacement needs a sibling outside the fixture's cleanup root.
    const previous = `${target}-old-${randomUUID()}`;
    try {
      await fs.rename(target, previous); await fs.mkdir(target);
      await assert.rejects(() => recover({ workspace: input.workspace, dataRoot: input.dataRoot, original: first.original }, async () => assert.fail()));
    } finally {
      await fs.rm(target, { recursive: true, force: true }); await fs.rename(previous, target);
    }
    assert.equal(await fs.readFile(destination(input), 'utf8'), 'original');
  });
});

test('recovery copies bounded original facts before awaiting and rejects forged shapes/accessors without reading them', async t => fixture(async input => {
  await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original'); let original!: PreparedSingleFileTrashOriginalFacts;
  await prepare(input, async cap => { original = read(cap); });
  for (const mutate of [
    (copy: Record<string, unknown>) => { copy.version = 2; },
    (copy: Record<string, unknown>) => { copy.unknown = true; },
    (copy: Record<string, unknown>) => { copy.trashRelativePath = '../outside'; },
    (copy: Record<string, unknown>) => { (copy.filesystem as { sourceDirectories: unknown[] }).sourceDirectories = Array(129).fill(null); },
    (copy: Record<string, unknown>) => { (copy.workspace as { workspaceId: string }).workspaceId = 'different'; },
  ]) {
    const copy = JSON.parse(JSON.stringify(original)); mutate(copy);
    await assert.rejects(() => recover({ workspace: input.workspace, dataRoot: input.dataRoot, original: copy }, async () => assert.fail()), code('invalid-input'));
  }
  let getters = 0; const accessor = JSON.parse(JSON.stringify(original));
  Object.defineProperty(accessor.source.identity, 'inode', { enumerable: true, get: () => { getters++; return 1; } });
  await assert.rejects(() => recover({ workspace: input.workspace, dataRoot: input.dataRoot, original: accessor }, async () => assert.fail()), code('invalid-input'));
  assert.equal(getters, 0);
  const entered = gate(), release = gate(), realOpen = fs.open.bind(fs); let once = false;
  t.mock.method(fs, 'open', async (file: string, flags: number) => {
    const handle = await realOpen(file, flags); if (!once) { once = true; entered.resolve(); await bounded(release.promise); } return handle;
  });
  const mutable = JSON.parse(JSON.stringify(original));
  const run = recover({ workspace: input.workspace, dataRoot: input.dataRoot, original: mutable }, async cap => {
    assert.deepEqual(read(cap), original); return move(cap);
  });
  await bounded(entered.promise); mutable.canonicalPath = 'D2.md'; mutable.source.identity.inode = 0;
  mutable.filesystem.sourceDirectories.push({ segment: 'other', identity: {} }); release.resolve(); await run;
  assert.equal(await fs.readFile(destination(input), 'utf8'), 'original');
}));

test('recovered capabilities have the same caught/retained/single-use lifetime and do not delete historical reservations on failure', async () => fixture(async input => {
  await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original'); let original!: PreparedSingleFileTrashOriginalFacts;
  let retained!: PreparedWorkspaceSingleFileTrash;
  await prepare(input, async cap => { original = read(cap); retained = cap; });
  const entry = path.dirname(destination(input)), inode = (await fs.stat(entry)).ino;
  await assert.rejects(() => recover({ workspace: input.workspace, dataRoot: input.dataRoot, original }, async () => {
    try { read(retained); } catch {} return 'caught';
  }), code('invalid-lifetime'));
  assert.equal((await fs.stat(entry)).ino, inode); assert.equal(await fs.readFile(path.join(input.workspace.rootPath, 'note.md'), 'utf8'), 'original');
  await assert.rejects(() => recover({ workspace: input.workspace, dataRoot: input.dataRoot, original }, async cap => {
    await move(cap); await assert.rejects(() => move(cap), code('already-moved'));
  }), code('already-moved'));
  const success = await recover({ workspace: input.workspace, dataRoot: input.dataRoot, original }, async cap => move(cap));
  assert.equal(success.observation.kind, 'moved');
}));

test('current assertion verifies the moved actual FD/hash/name and rejects later payload edits or replacement before completion', async () => {
  for (const mode of ['bytes', 'replacement'] as const) await fixture(async input => {
    await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original'); let completed = 0;
    await assert.rejects(() => prepare(input, async cap => {
      await move(cap); await assertCurrent(cap); await assertCurrent(cap);
      if (mode === 'replacement') await fs.rename(destination(input), `${destination(input)}.original`);
      await fs.writeFile(destination(input), 'changed payload');
      await assertCurrent(cap); completed++;
    }), error => error instanceof PreparedSingleFileTrashError);
    assert.equal(completed, 0); await absent(path.join(input.workspace.rootPath, 'note.md'));
    assert.equal(await fs.readFile(destination(input), 'utf8'), 'changed payload');
    if (mode === 'replacement') assert.equal(await fs.readFile(`${destination(input)}.original`, 'utf8'), 'original');
  });
});

test('current assertion preserves D2/historical absence, rejects retained caps and drains an unawaited actual FS assertion before close', async t => {
  await fixture(async input => {
    await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original'); const first = await prepare(input, async cap => move(cap));
    const source = path.join(input.workspace.rootPath, 'note.md'); await fs.writeFile(source, 'new D2'); const before = await fs.stat(source);
    const realOpen = fs.open.bind(fs); let sourceOpens = 0; let old!: PreparedWorkspaceSingleFileTrash;
    t.mock.method(fs, 'open', async (file: string, flags: number) => { if (file === source) sourceOpens++; return realOpen(file, flags); });
    t.mock.method(fs, 'rename', async () => assert.fail('assertion/recovered observation must not rename'));
    await recover({ workspace: input.workspace, dataRoot: input.dataRoot, original: first.original }, async cap => {
      old = cap; await move(cap); await assertCurrent(cap); await fs.writeFile(source, 'new D2 independently changed'); await assertCurrent(cap);
    });
    assert.equal(sourceOpens, 0); assert.equal((await fs.stat(source)).ino, before.ino);
    assert.equal(await fs.readFile(source, 'utf8'), 'new D2 independently changed');
    await assert.rejects(() => assertCurrent(old), code('invalid-lifetime')); t.mock.restoreAll();
  });
  await fixture(async input => {
    await prepare(input, async cap => {
      await move(cap); await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'new D2 after absence'); await assertCurrent(cap);
    });
    assert.equal(await fs.readFile(path.join(input.workspace.rootPath, 'note.md'), 'utf8'), 'new D2 after absence'); await absent(destination(input));
  });
  await fixture(async input => {
    await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original'); const tracked = track(t);
    const entered = gate(), release = gate(), returned = gate(), realOpenDirectory = fs.opendir.bind(fs); let armed = false;
    t.mock.method(fs, 'opendir', async (file: string) => {
      const directory = await realOpenDirectory(file);
      if (armed) { armed = false; entered.resolve(); await bounded(release.promise); }
      return directory;
    });
    let pending!: Promise<void>;
    const run = prepare(input, async cap => {
      await move(cap); armed = true; pending = assertCurrent(cap); await bounded(entered.promise); returned.resolve();
    });
    try {
      await bounded(returned.promise); await new Promise<void>(resolve => setImmediate(resolve));
      assert(tracked.handles.every(handle => handle.fd >= 0)); release.resolve();
      await assert.rejects(() => run, code('unawaited-operation')); await assert.rejects(() => pending); tracked.assertClosed();
      assert.equal(await fs.readFile(destination(input), 'utf8'), 'original');
    } finally { release.resolve(); await Promise.allSettled([run]); }
    t.mock.restoreAll();
  });
});

test('all genuine descriptor close failures survive alongside the primary failure without retrying or rolling back the move', async t => {
  const realOpen = fs.open.bind(fs);
  for (const withPrimary of [false, true]) await fixture(async input => {
    const primary = new Error('SQL receipt phase failed'), closeFailures: Error[] = [], handles: FileHandle[] = [];
    const closes = new Map<FileHandle, number>();
    await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original');
    t.mock.method(fs, 'open', async (file: string, flags: number) => {
      const handle = await realOpen(file, flags), realClose = handle.close.bind(handle);
      handles.push(handle); const closeError = new Error(`close acknowledgment ${handles.length}`); closeFailures.push(closeError);
      t.mock.method(handle, 'close', async () => { closes.set(handle, (closes.get(handle) ?? 0) + 1); await realClose(); throw closeError; });
      return handle;
    });
    await assert.rejects(() => prepare(input, async cap => { await move(cap); if (withPrimary) throw primary; }), error => {
      assert(error instanceof PreparedSingleFileTrashError); assert.equal(error.code, 'disposal-unconfirmed');
      assert.equal(error.status, 503); assert.equal(error.moveAttempted, true); assert(error.cause instanceof AggregateError);
      const failures = error.cause.errors;
      assert.equal(failures.length, closeFailures.length + Number(withPrimary));
      if (withPrimary) assert.equal(failures[0], primary);
      for (const closeError of closeFailures) assert.equal(failures.filter(value => value === closeError).length, 1);
      return true;
    });
    assert(handles.length > 1); assert(handles.every(handle => handle.fd === -1 && closes.get(handle) === 1));
    assert.equal(await fs.readFile(destination(input), 'utf8'), 'original'); await absent(path.join(input.workspace.rootPath, 'note.md'));
    t.mock.restoreAll();
  });
});

test('restore freezes NEW destination parents before one reverse rename and preserves literal names and bytes', async t => fixture(async input => {
  input = { ...input, canonicalPath: ' Folder / note.md ' };
  const parent = path.join(input.workspace.rootPath, ' Folder '), source = path.join(parent, ' note.md ');
  await fs.mkdir(parent); const bytes = Buffer.alloc(6 * 1024 * 1024 + 3, 0xa7); bytes.set([0, 0xef, 0xbb, 0xbf, 0xff]);
  await fs.writeFile(source, bytes); const before = await fs.stat(source);
  const deleted = await prepare(input, move);
  // The Undo intent deliberately captures the CURRENT vacant parents, not the
  // old delete-parent identity. No directory is created by the restore seam.
  await fs.rename(parent, `${parent}-old`); await fs.mkdir(parent);
  const currentParent = await fs.stat(parent), neighbor = path.join(input.workspace.rootPath, 'note.md');
  await fs.writeFile(neighbor, 'neighbor'); const tracked = track(t); let original!: PreparedSingleFileRestoreOriginalFacts;
  const result = await prepareRestore({ workspace: input.workspace, dataRoot: input.dataRoot, receipt: deleted }, async cap => {
    original = readRestore(cap);
    assert(Object.isFrozen(original) && Object.isFrozen(original.destination) && Object.isFrozen(original.trashReceipt));
    assert.equal(original.trashReceipt.original.canonicalPath, input.canonicalPath);
    assert.equal(original.destination.kind, 'vacant');
    if (original.destination.kind !== 'vacant') assert.fail('vacant destination expected');
    assert.equal(original.destination.directories[0].identity.inode, currentParent.ino);
    assert.notEqual(original.destination.directories[0].identity.inode, deleted.original.filesystem.sourceDirectories[0].identity.inode);
    assert.deepEqual(JSON.parse(JSON.stringify(original)), original); assert.equal(Object.keys(cap).length, 0);
    await absent(source); const receipt = await restore(cap); await assertRestoreCurrent(cap); return receipt;
  });
  assert.equal(result.original, original); assert.equal(result.observation.kind, 'restored');
  if (result.observation.kind !== 'restored') assert.fail('restored payload expected');
  assert(Object.isFrozen(result) && Object.isFrozen(result.observation)); assert.equal(result.observation.method, 'rename');
  assert.equal(result.observation.identity.inode, before.ino); assert.equal(result.observation.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await fs.readFile(source), bytes); await absent(destination(input));
  assert.equal(await fs.readFile(neighbor, 'utf8'), 'neighbor'); tracked.assertClosed();
}));

test('restore logical projection absence never opens, creates or changes D2, including a newly present tree', async t => {
  for (const canonicalPath of ['note.md', 'missing/tree/note.docx']) await fixture(async input => {
    input = { ...input, canonicalPath };
    const deleted = await prepare(input, move), source = path.join(input.workspace.rootPath, canonicalPath);
    await fs.mkdir(path.dirname(source), { recursive: true }); await fs.writeFile(source, 'new D2'); const before = await fs.stat(source);
    const realOpen = fs.open.bind(fs), realRename = fs.rename.bind(fs); let sourceOpens = 0, renames = 0;
    t.mock.method(fs, 'open', async (file: string, flags: number) => { if (file === source) sourceOpens++; return realOpen(file, flags); });
    t.mock.method(fs, 'rename', async (from: string, to: string) => { renames++; return realRename(from, to); });
    let original!: PreparedSingleFileRestoreOriginalFacts;
    const first = await prepareRestore({ workspace: input.workspace, dataRoot: input.dataRoot, receipt: deleted }, async cap => {
      original = readRestore(cap); assert.deepEqual(original.destination, { kind: 'projection_absent' });
      const receipt = await restore(cap); await assertRestoreCurrent(cap); return receipt;
    });
    const resumed = await recoverRestore({ workspace: input.workspace, dataRoot: input.dataRoot, original }, async cap => {
      const receipt = await restore(cap); await assertRestoreCurrent(cap); return receipt;
    });
    assert.deepEqual(first, resumed); assert.deepEqual(first.observation, { kind: 'projection_absent' });
    assert.equal(renames, 0); assert.equal(sourceOpens, 0); assert.equal((await fs.stat(source)).ino, before.ino);
    assert.equal(await fs.readFile(source, 'utf8'), 'new D2'); await absent(destination(input)); t.mock.restoreAll();
  });
});

test('restore refuses D2 or unsafe/missing destination parents without touching the original trash payload', async () => {
  for (const scenario of ['D2', 'symlink', 'missing', 'directory', 'alias']) await fixture(async input => {
    input = { ...input, canonicalPath: 'folder/note.md' };
    const parent = path.join(input.workspace.rootPath, 'folder'), source = path.join(parent, 'note.md');
    await fs.mkdir(parent); await fs.writeFile(source, 'original'); const deleted = await prepare(input, move), payload = destination(input);
    const before = await fs.stat(payload);
    if (scenario === 'D2') await fs.writeFile(source, 'new D2');
    if (scenario === 'directory') await fs.mkdir(source);
    if (scenario === 'alias') await fs.writeFile(path.join(parent, 'NOTE.md'), 'alias D2');
    if (scenario === 'missing') await fs.rmdir(parent);
    if (scenario === 'symlink') { await fs.rename(parent, `${parent}-original`); await fs.symlink(`${parent}-original`, parent); }
    // A case-distinct alias is a legal different path on case-sensitive FS;
    // isolate the refusal check only when the requested path resolves to it.
    if (scenario === 'alias') {
      try { await fs.lstat(source); } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return; throw error; }
    }
    await assert.rejects(() => prepareRestore({ workspace: input.workspace, dataRoot: input.dataRoot, receipt: deleted }, restore),
      error => error instanceof PreparedSingleFileTrashError);
    assert.equal((await fs.stat(payload)).ino, before.ino); assert.equal(await fs.readFile(payload, 'utf8'), 'original');
    if (scenario === 'D2') assert.equal(await fs.readFile(source, 'utf8'), 'new D2');
  });
});

test('restore checks destination vacancy and trash bytes again immediately before the reverse rename', async () => {
  for (const scenario of ['D2', 'payload', 'parent', 'entry']) await fixture(async input => {
    input = { ...input, canonicalPath: 'folder/note.md' };
    const parent = path.join(input.workspace.rootPath, 'folder'), source = path.join(parent, 'note.md');
    await fs.mkdir(parent); await fs.writeFile(source, 'original'); const deleted = await prepare(input, move), payload = destination(input);
    await assert.rejects(() => prepareRestore({ workspace: input.workspace, dataRoot: input.dataRoot, receipt: deleted }, async cap => {
      readRestore(cap);
      if (scenario === 'D2') await fs.writeFile(source, 'new D2');
      if (scenario === 'payload') await fs.writeFile(payload, 'changed');
      if (scenario === 'parent') { await fs.rename(parent, `${parent}-old`); await fs.mkdir(parent); }
      if (scenario === 'entry') { await fs.rename(path.dirname(payload), `${path.dirname(payload)}-old`); await fs.mkdir(path.dirname(payload), { mode: 0o700 }); }
      await restore(cap);
    }), error => error instanceof PreparedSingleFileTrashError);
    if (scenario === 'D2') assert.equal(await fs.readFile(source, 'utf8'), 'new D2');
    else await absent(source);
  });
});

test('restore recovery uses the persisted NEW intent to finish pending or prove already restored without another rename', async t => {
  for (const alreadyRestored of [false, true]) await fixture(async input => {
    await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original'); const deleted = await prepare(input, move);
    let original!: PreparedSingleFileRestoreOriginalFacts; const interruption = new Error('lost SQL response');
    await assert.rejects(() => prepareRestore({ workspace: input.workspace, dataRoot: input.dataRoot, receipt: deleted }, async cap => {
      original = readRestore(cap); if (alreadyRestored) await restore(cap); throw interruption;
    }), error => error === interruption);
    const realRename = fs.rename.bind(fs); let renames = 0;
    t.mock.method(fs, 'rename', async (from: string, to: string) => { renames++; return realRename(from, to); });
    const result = await recoverRestore({ workspace: input.workspace, dataRoot: input.dataRoot, original: JSON.parse(JSON.stringify(original)) }, async cap => {
      assert.deepEqual(readRestore(cap), original); const receipt = await restore(cap); await assertRestoreCurrent(cap); return receipt;
    });
    assert.equal(result.observation.kind, 'restored'); assert.equal(renames, alreadyRestored ? 0 : 1);
    assert.equal(await fs.readFile(path.join(input.workspace.rootPath, 'note.md'), 'utf8'), 'original'); await absent(destination(input)); t.mock.restoreAll();
  });
});

test('restore recovery rejects D2, altered payload, both/neither locations and changed Undo parent/root/entry pins', async () => {
  for (const scenario of ['D2', 'payload', 'replacement', 'both', 'neither', 'parent', 'root', 'entry', 'restored-D2']) await fixture(async input => {
    input = { ...input, canonicalPath: 'folder/note.md' };
    const parent = path.join(input.workspace.rootPath, 'folder'), source = path.join(parent, 'note.md');
    await fs.mkdir(parent); await fs.writeFile(source, 'original'); const deleted = await prepare(input, move), payload = destination(input);
    let original!: PreparedSingleFileRestoreOriginalFacts;
    await prepareRestore({ workspace: input.workspace, dataRoot: input.dataRoot, receipt: deleted }, async cap => { original = readRestore(cap); });
    if (scenario === 'D2') await fs.writeFile(source, 'new D2');
    if (scenario === 'payload') await fs.writeFile(payload, 'changed');
    if (scenario === 'replacement') { await fs.rename(payload, `${payload}-old`); await fs.writeFile(payload, 'original'); }
    if (scenario === 'both') await fs.link(payload, source);
    if (scenario === 'neither') await fs.unlink(payload);
    if (scenario === 'parent') { await fs.rename(parent, `${parent}-old`); await fs.mkdir(parent); }
    if (scenario === 'root') { await fs.rename(input.workspace.rootPath, `${input.workspace.rootPath}-old`); await fs.mkdir(input.workspace.rootPath); }
    if (scenario === 'entry') { await fs.rename(path.dirname(payload), `${path.dirname(payload)}-old`); await fs.mkdir(path.dirname(payload), { mode: 0o700 }); }
    if (scenario === 'restored-D2') { await fs.rename(payload, source); await fs.unlink(source); await fs.writeFile(source, 'new D2'); }
    await assert.rejects(() => recoverRestore({ workspace: input.workspace, dataRoot: input.dataRoot, original }, restore),
      error => error instanceof PreparedSingleFileTrashError);
    if (scenario === 'D2' || scenario === 'restored-D2') assert.equal(await fs.readFile(source, 'utf8'), 'new D2');
  });
});

test('restore copies strict receipt/intent inputs before awaits and never reads forged getters', async t => fixture(async input => {
  await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original'); const deleted = await prepare(input, move);
  let reads = 0; const malformed = JSON.parse(JSON.stringify(deleted));
  Object.defineProperty(malformed.observation, 'identity', { enumerable: true, get() { reads++; return deleted.observation.kind === 'moved' ? deleted.observation.identity : null; } });
  await assert.rejects(() => prepareRestore({ workspace: input.workspace, dataRoot: input.dataRoot, receipt: malformed }, restore), code('invalid-input'));
  assert.equal(reads, 0);
  for (const changed of [
    { ...deleted, version: 2 }, { ...deleted, extra: true },
    { ...deleted, observation: { kind: 'projection_absent' } },
  ]) await assert.rejects(() => prepareRestore({ workspace: input.workspace, dataRoot: input.dataRoot, receipt: changed as PreparedSingleFileTrashReceipt }, restore), code('invalid-input'));
  const realOpen = fs.open.bind(fs), entered = gate(), release = gate(); let armed = true;
  t.mock.method(fs, 'open', async (file: string, flags: number) => {
    const handle = await realOpen(file, flags); if (armed) { armed = false; entered.resolve(); await bounded(release.promise); } return handle;
  });
  const mutable = JSON.parse(JSON.stringify(deleted)); const run = prepareRestore({ workspace: input.workspace, dataRoot: input.dataRoot, receipt: mutable }, async cap => {
    assert.equal(readRestore(cap).trashReceipt.original.canonicalPath, 'note.md'); await restore(cap);
  });
  try {
    await bounded(entered.promise); mutable.original.canonicalPath = 'other.md'; mutable.observation.sha256 = '0'.repeat(64); release.resolve(); await run;
  } finally { release.resolve(); await Promise.allSettled([run]); }
  assert.equal(await fs.readFile(path.join(input.workspace.rootPath, 'note.md'), 'utf8'), 'original'); t.mock.restoreAll();
}));

test('restore brands, caught misuse, nested/retained and repeated capabilities poison the active callback', async () => {
  for (const scenario of ['forged', 'cross-brand', 'nested', 'repeated', 'early-assert']) await fixture(async input => {
    await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original'); const deleted = await prepare(input, move);
    let retained!: PreparedWorkspaceSingleFileRestore;
    await assert.rejects(() => prepareRestore({ workspace: input.workspace, dataRoot: input.dataRoot, receipt: deleted }, async cap => {
      retained = cap;
      if (scenario === 'forged') await assert.rejects(() => restore({} as PreparedWorkspaceSingleFileRestore), code('invalid-lifetime'));
      if (scenario === 'cross-brand') assert.throws(() => read(cap as unknown as PreparedWorkspaceSingleFileTrash), code('invalid-lifetime'));
      if (scenario === 'nested') await assert.rejects(() => prepareRestore({ workspace: input.workspace, dataRoot: input.dataRoot, receipt: deleted }, restore), code('reentrant-operation'));
      if (scenario === 'repeated') { await restore(cap); await assert.rejects(() => restore(cap), code('already-moved')); }
      if (scenario === 'early-assert') await assert.rejects(() => assertRestoreCurrent(cap), code('invalid-lifetime'));
    }), error => error instanceof PreparedSingleFileTrashError);
    assert.throws(() => readRestore(retained), code('invalid-lifetime')); await assert.rejects(() => restore(retained), code('invalid-lifetime'));
  });
});

test('restore EXDEV and uncertain rename acknowledgement preserve evidence without copy or rollback', async t => {
  for (const uncertain of [false, true]) await fixture(async input => {
    await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original'); const deleted = await prepare(input, move);
    const realRename = fs.rename.bind(fs), tracked = track(t); let renames = 0;
    t.mock.method(fs, 'rename', async (from: string, to: string) => {
      renames++; if (uncertain) await realRename(from, to);
      throw Object.assign(new Error('rename response lost'), { code: uncertain ? 'EIO' : 'EXDEV' });
    });
    await assert.rejects(() => prepareRestore({ workspace: input.workspace, dataRoot: input.dataRoot, receipt: deleted }, restore),
      error => error instanceof PreparedSingleFileTrashError && error.code === (uncertain ? 'move-unconfirmed' : 'cross-device-move') && error.moveAttempted);
    assert.equal(renames, 1); assert.equal(await fs.readFile(uncertain ? path.join(input.workspace.rootPath, 'note.md') : destination(input), 'utf8'), 'original');
    await absent(uncertain ? destination(input) : path.join(input.workspace.rootPath, 'note.md')); tracked.assertClosed(); t.mock.restoreAll();
  });
});

test('restore post-rename assertion rejects changed bytes or replacement and never returns a second success', async () => {
  for (const replace of [false, true]) await fixture(async input => {
    const source = path.join(input.workspace.rootPath, 'note.md'); await fs.writeFile(source, 'original'); const deleted = await prepare(input, move);
    await assert.rejects(() => prepareRestore({ workspace: input.workspace, dataRoot: input.dataRoot, receipt: deleted }, async cap => {
      await restore(cap);
      if (replace) await fs.rename(source, `${source}-old`); await fs.writeFile(source, 'changed');
      await assertRestoreCurrent(cap);
    }), code('source-changed'));
    assert.equal(await fs.readFile(source, 'utf8'), 'changed'); await absent(destination(input));
  });
});

test('restore drains unawaited rename and assertion before closing held descriptors and revokes detached callbacks', async t => {
  for (const assertion of [false, true]) await fixture(async input => {
    await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original'); const deleted = await prepare(input, move), tracked = track(t);
    const entered = gate(), release = gate(), returned = gate(), realRename = fs.rename.bind(fs), realOpenDirectory = fs.opendir.bind(fs);
    let armed = false, pending!: Promise<unknown>, detached!: () => Promise<unknown>;
    if (assertion) t.mock.method(fs, 'opendir', async (file: string) => {
      const directory = await realOpenDirectory(file); if (armed) { armed = false; entered.resolve(); await bounded(release.promise); } return directory;
    });
    else t.mock.method(fs, 'rename', async (from: string, to: string) => { entered.resolve(); await bounded(release.promise); return realRename(from, to); });
    const run = prepareRestore({ workspace: input.workspace, dataRoot: input.dataRoot, receipt: deleted }, async cap => {
      if (assertion) { await restore(cap); armed = true; }
      detached = () => restore(cap); pending = assertion ? assertRestoreCurrent(cap) : restore(cap);
      await bounded(entered.promise); returned.resolve();
    });
    try {
      await bounded(returned.promise); await new Promise<void>(resolve => setImmediate(resolve));
      assert(tracked.handles.every(handle => handle.fd >= 0)); release.resolve();
      await assert.rejects(() => run, code('unawaited-operation')); await assert.rejects(() => pending);
      await assert.rejects(detached, code('invalid-lifetime')); tracked.assertClosed();
    } finally { release.resolve(); await Promise.allSettled([run, pending]); }
    t.mock.restoreAll();
  });
});

test('restore retains primary SQL-like failure plus every disposal rejection with own status503 and no compensating rename', async t => fixture(async input => {
  await fs.writeFile(path.join(input.workspace.rootPath, 'note.md'), 'original'); const deleted = await prepare(input, move);
  const realOpen = fs.open.bind(fs), primary = new Error('restore receipt COMMIT unknown'), closeFailures: Error[] = [], handles: FileHandle[] = [];
  t.mock.method(fs, 'open', async (file: string, flags: number) => {
    const handle = await realOpen(file, flags), realClose = handle.close.bind(handle), closeError = new Error('close acknowledgment lost');
    handles.push(handle); closeFailures.push(closeError);
    t.mock.method(handle, 'close', async () => { await realClose(); throw closeError; }); return handle;
  });
  await assert.rejects(() => prepareRestore({ workspace: input.workspace, dataRoot: input.dataRoot, receipt: deleted }, async cap => { await restore(cap); throw primary; }), error => {
    assert(error instanceof PreparedSingleFileTrashError); assert.equal(error.code, 'disposal-unconfirmed');
    assert.equal(Object.getOwnPropertyDescriptor(error, 'status')?.value, 503); assert.equal(error.moveAttempted, true);
    assert(error.cause instanceof AggregateError); assert.deepEqual(error.cause.errors, [primary, ...[...closeFailures].reverse()]); return true;
  });
  assert(handles.length > 1); assert(handles.every(handle => handle.fd === -1));
  assert.equal(await fs.readFile(path.join(input.workspace.rootPath, 'note.md'), 'utf8'), 'original'); await absent(destination(input)); t.mock.restoreAll();
}));

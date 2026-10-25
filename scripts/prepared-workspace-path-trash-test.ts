import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import io from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { trashRootForWorkspace } from '../app/lib/filesystem/workspace-trash-layout';
import { withPreparedWorkspacePathTrashes as prepare, withRecoveredWorkspacePathTrashes as recover,
  readPreparedWorkspacePathTrash as read, readPreparedWorkspacePathTrashDisposition as disposition,
  readPreparedWorkspacePathTrashReceipt as receipt, trashPreparedWorkspacePath as trash,
  assertPreparedWorkspacePathTrashCurrent as current, assertPreparedWorkspacePathTrashSourceVacant as vacant,
  assertPreparedWorkspacePathTrashReceiptCurrent as strict, decodePreparedWorkspacePathTrashOriginal as decodeOriginal,
  decodePreparedWorkspacePathTrashReceipt as decodeReceipt, preparedWorkspacePathTrashNamespaceFingerprints as fingerprints,
  PreparedWorkspacePathTrashError, type PreparedWorkspacePathTrashOriginal as Original,
  type PreparedWorkspacePathTrash as Cap, type PreparedWorkspacePathTrashSelection as Selection,
} from '../app/lib/filesystem/prepared-workspace-path-trash';

const error = (...codes: PreparedWorkspacePathTrashError['code'][]) => (failure: unknown) => {
  assert(failure instanceof PreparedWorkspacePathTrashError);
  assert(codes.includes(failure.code), `Unexpected prepared failure: ${failure.code}`); return true;
};
const selected = (canonicalPath: string, sourceKind: Selection['sourceKind'] = 'regular_file', stepKey = canonicalPath): Selection => ({
  stepKey, canonicalPath, trashEntryId: `trash-${randomUUID()}`, sourceKind,
});
type Fixture = { base: string; dataRoot: string; workspace: WorkspaceContext; remember(): void };
async function fixture(operation: (value: Fixture) => Promise<void>) {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'canvas-prepared-trash-cohort-'));
  await fs.chmod(base, 0o700);
  const rootPath = path.join(base, 'workspace'), dataRoot = path.join(base, 'data');
  await fs.mkdir(rootPath, { mode: 0o700 }); await fs.mkdir(dataRoot, { mode: 0o700 });
  const initial = await fs.lstat(base), nodes = new Set<string>();
  const collect = (filename: string) => {
    const info = io.lstatSync(filename); nodes.add(`${info.dev}:${info.ino}`);
    if (info.isDirectory() && !info.isSymbolicLink()) for (const name of io.readdirSync(filename)) collect(path.join(filename, name));
  };
  const workspace: WorkspaceContext = { workspaceId: path.basename(base), workspaceType: 'personal', organizationId: null,
    rootPath, legacy: false, status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true,
      canManageWorkspace: true, canCreatePublicLinks: true, canRunAgent: true } };
  const remember = () => collect(base);
  try { await operation({ base, workspace, dataRoot, remember }); }
  finally {
    collect(base);
    const fdDirectory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
    for (const name of io.readdirSync(fdDirectory)) if (/^\d+$/u.test(name)) {
      let info; try { info = io.fstatSync(Number(name)); } catch { continue; }
      assert.equal(nodes.has(`${info.dev}:${info.ino}`), false, 'Every fixture descriptor must close before cleanup.');
    }
    const final = await fs.lstat(base); assert.equal(final.dev, initial.dev); assert.equal(final.ino, initial.ino);
    await fs.rm(base, { recursive: true });
  }
}
async function file(value: Fixture, canonicalPath: string, content = canonicalPath) {
  await fs.mkdir(path.dirname(path.join(value.workspace.rootPath, canonicalPath)), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(value.workspace.rootPath, canonicalPath), content, { mode: 0o600 }); value.remember();
}
async function saved(value: Fixture, selections: readonly Selection[]) {
  return prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections, nowMs: 1_800_000_000_000 }, async caps =>
    caps.map(item => ({ stepKey: item.stepKey, original: read(item.cap) })));
}
const destination = (value: Fixture, original: Original) => path.join(value.dataRoot, original.trashRelativePath);

test('real regular file moves once into private DATA trash, preserving inode and bytes', () => fixture(async value => {
  await file(value, 'note.md', 'Native projection');
  const before = await fs.lstat(path.join(value.workspace.rootPath, 'note.md'));
  await prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('note.md')] }, async caps => {
    const cap = caps[0].cap, original = read(cap); assert(Object.isFrozen(original));
    assert.equal(original.sourceFingerprint, `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`);
    assert.equal(disposition(cap), 'pending');
    const actual = await trash(cap); assert.equal(actual.observation.kind, 'moved');
    assert.equal(disposition(cap), 'already_moved'); assert.equal(await receipt(cap), actual);
    await strict(cap, actual); await vacant(cap); await current(cap);
    const after = await fs.lstat(destination(value, original));
    assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
    assert.equal(await fs.readFile(destination(value, original), 'utf8'), 'Native projection');
    const entry = await fs.lstat(path.dirname(destination(value, original))); assert.equal(entry.mode & 0o777, 0o700);
    await assert.rejects(fs.lstat(path.join(value.workspace.rootPath, 'note.md')), { code: 'ENOENT' });
  });
}));

test('legacy owned 0755 namespace parents retain their identities while each new entry stays private', () => fixture(async value => {
  await file(value, 'folder/note.md', 'Preserved original');
  const shared = trashRootForWorkspace(value.workspace, value.dataRoot);
  await fs.mkdir(shared, { recursive: true, mode: 0o755 });
  const parents: Array<{ name: string; ino: number; mode: number }> = [];
  for (let name = shared; name !== value.dataRoot; name = path.dirname(name)) {
    await fs.chmod(name, 0o755); const info = await fs.lstat(name);
    parents.push({ name, ino: info.ino, mode: info.mode });
  }
  let original!: Original;
  await prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('folder', 'directory')] }, async caps => {
    original = read(caps[0].cap); await current(caps[0].cap);
    const moved = await trash(caps[0].cap); await strict(caps[0].cap, moved); await current(caps[0].cap);
    assert.equal((await fs.lstat(path.dirname(destination(value, original)))).mode & 0o777, 0o700);
  });
  await recover({ workspace: value.workspace, dataRoot: value.dataRoot, originals: [{ stepKey: 'folder', original }] }, async caps => {
    assert.equal(disposition(caps[0].cap), 'already_moved'); await current(caps[0].cap);
    assert.equal((await receipt(caps[0].cap)).observation.kind, 'moved');
  });
  assert.equal(await fs.readFile(path.join(destination(value, original), 'note.md'), 'utf8'), 'Preserved original');
  for (const parent of parents) {
    const info = await fs.lstat(parent.name); assert.equal(info.ino, parent.ino); assert.equal(info.mode, parent.mode);
  }
}));

test('a group-writable shared trash namespace still rejects preparation without moving the original', () => fixture(async value => {
  await file(value, 'folder/note.md', 'Untouched');
  await fs.mkdir(path.join(value.dataRoot, '.trash'), { mode: 0o700 });
  await fs.chmod(path.join(value.dataRoot, '.trash'), 0o775);
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot,
    selections: [selected('folder', 'directory')] }, async () => assert.fail('Unsafe parent reached callback.')), error('unsafe-path'));
  assert.equal(await fs.readFile(path.join(value.workspace.rootPath, 'folder/note.md'), 'utf8'), 'Untouched');
}));

test('an entry made traversable by another user is rejected before the physical move', () => fixture(async value => {
  await file(value, 'folder/note.md', 'Untouched');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot,
    selections: [selected('folder', 'directory')] }, async caps => {
    await fs.chmod(path.dirname(destination(value, read(caps[0].cap))), 0o755);
    await trash(caps[0].cap);
  }), error('unsafe-path', 'scope-changed'));
  assert.equal(await fs.readFile(path.join(value.workspace.rootPath, 'folder/note.md'), 'utf8'), 'Untouched');
}));

test('folder moves as one unchanged real tree with an exact fingerprint for every original entity', () => fixture(async value => {
  await file(value, 'folder/nested/note.md', '# Note'); await file(value, 'folder/picture.png', 'PNG');
  await file(value, 'folder/document.pdf', 'PDF');
  await prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('folder', 'directory')] }, async caps => {
    const original = read(caps[0].cap); assert.equal(original.source.kind, 'directory');
    assert.deepEqual(fingerprints(original).map(item => item.relativePath), ['', 'document.pdf', 'nested', 'nested/note.md', 'picture.png']);
    const rootBefore = await fs.lstat(path.join(value.workspace.rootPath, 'folder'));
    const moved = await trash(caps[0].cap); await strict(caps[0].cap, moved);
    const rootAfter = await fs.lstat(destination(value, original)); assert.equal(rootAfter.ino, rootBefore.ino);
    for (const name of ['nested/note.md', 'picture.png', 'document.pdf']) {
      assert.equal(await fs.readFile(path.join(destination(value, original), name), 'utf8'), name.endsWith('.md') ? '# Note' : name.endsWith('.png') ? 'PNG' : 'PDF');
    }
  });
}));

test('batch selections are detached, preserve caller order and all actual caps remain live together', () => fixture(async value => {
  await file(value, 'z.md', 'Z'); await file(value, 'a.md', 'A'); let retained!: Cap;
  const selections = [selected('z.md'), selected('a.md')];
  await prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections }, async caps => {
    assert(Object.isFrozen(caps)); assert.deepEqual(caps.map(item => item.stepKey), ['z.md', 'a.md']);
    selections[0] = selected('foreign.md');
    for (const item of caps) { const actual = await trash(item.cap); await strict(item.cap, actual); }
    await current(caps[0].cap); await current(caps[1].cap); retained = caps[0].cap;
  });
  assert.throws(() => read(retained), error('invalid-lifetime')); await assert.rejects(current(retained), error('invalid-lifetime'));
}));

test('missing native projection has no fabricated inode, hash, content or physical rename', () => fixture(async value => {
  await prepare({ workspace: value.workspace, dataRoot: value.dataRoot,
    selections: [selected('missing/parent/note.md', 'projection_absent')] }, async caps => {
    const original = read(caps[0].cap); assert.deepEqual(original.source, { kind: 'projection_absent' });
    assert.equal(original.sourceFingerprint, null); assert.deepEqual(fingerprints(original), []);
    assert.equal(disposition(caps[0].cap), 'projection_absent');
    const actual = await trash(caps[0].cap); assert.deepEqual(actual.observation, { kind: 'projection_absent' });
    await strict(caps[0].cap, actual); assert.deepEqual(await fs.readdir(path.dirname(destination(value, original))), []);
    await assert.rejects(fs.lstat(path.join(value.workspace.rootPath, 'missing')), { code: 'ENOENT' });
  });
}));

test('real cohort can mix a directory, an ordinary file and an absent projection', () => fixture(async value => {
  await file(value, 'folder/a.md', 'A'); await file(value, 'image.png', 'PNG');
  await prepare({ workspace: value.workspace, dataRoot: value.dataRoot,
    selections: [selected('note.md', 'projection_absent'), selected('image.png'), selected('folder', 'directory')] }, async caps => {
    assert.deepEqual(caps.map(item => read(item.cap).source.kind), ['projection_absent', 'regular_file', 'directory']);
    for (const item of caps) { const actual = await trash(item.cap); await strict(item.cap, actual); }
  });
}));

test('a strict completed reader never invokes the single-use mutator again', () => fixture(async value => {
  await file(value, 'note.md');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('note.md')] }, async caps => {
    const actual = await trash(caps[0].cap); assert.equal(await receipt(caps[0].cap), actual); await strict(caps[0].cap, actual);
    await trash(caps[0].cap);
  }), error('already-moved'));
}));

test('receipt reader refuses a cap that has not completed its original move', () => fixture(async value => {
  await file(value, 'note.md');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('note.md')] }, async caps => {
    await receipt(caps[0].cap);
  }), error('invalid-lifetime'));
}));

test('equal copied receipt is data and cannot substitute for the exact actual same-cap receipt', () => fixture(async value => {
  await file(value, 'note.md');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('note.md')] }, async caps => {
    const actual = await trash(caps[0].cap); assert.deepEqual(decodeReceipt(actual), actual);
    await strict(caps[0].cap, structuredClone(actual));
  }), error('recovery-conflict'));
}));

test('recovery from original pending cohort keeps all originals and moves each once', () => fixture(async value => {
  await file(value, 'a.md', 'A'); await file(value, 'b.md', 'B'); const originals = await saved(value, [selected('a.md'), selected('b.md')]);
  await recover({ workspace: value.workspace, dataRoot: value.dataRoot, originals: structuredClone(originals) }, async caps => {
    assert.deepEqual(caps.map(item => disposition(item.cap)), ['pending', 'pending']);
    for (const item of caps) { const actual = await trash(item.cap); await strict(item.cap, actual); }
  });
  assert.equal(await fs.readFile(destination(value, originals[0].original), 'utf8'), 'A');
  assert.equal(await fs.readFile(destination(value, originals[1].original), 'utf8'), 'B');
}));

test('partial-rename crash recovers original already-moved and untouched roots without a second rename', () => fixture(async value => {
  await file(value, 'a.md', 'A'); await file(value, 'folder/b.md', 'B'); const originals = await saved(value, [selected('a.md'), selected('folder', 'directory')]);
  const crash = new Error('Controlled owner stop after first root rename');
  await assert.rejects(recover({ workspace: value.workspace, dataRoot: value.dataRoot, originals }, async caps => {
    await trash(caps[0].cap); throw crash;
  }), failure => failure === crash);
  const firstBefore = await fs.lstat(destination(value, originals[0].original));
  await recover({ workspace: value.workspace, dataRoot: value.dataRoot, originals }, async caps => {
    assert.deepEqual(caps.map(item => disposition(item.cap)), ['already_moved', 'pending']);
    for (const item of caps) { const actual = await trash(item.cap); await strict(item.cap, actual); }
  });
  const firstAfter = await fs.lstat(destination(value, originals[0].original));
  assert.equal(firstAfter.ino, firstBefore.ino); assert.equal(firstAfter.ctimeMs, firstBefore.ctimeMs);
  assert.equal(await fs.readFile(path.join(destination(value, originals[1].original), 'b.md'), 'utf8'), 'B');
}));

test('recovery reads completed subset receipts before resuming any still-current pending root', () => fixture(async value => {
  await file(value, 'a.md', 'A'); await file(value, 'b.md', 'B');
  const originals = await saved(value, [selected('a.md'), selected('missing.md', 'projection_absent'), selected('b.md')]);
  const crash = new Error('Controlled owner stop after one rename');
  await assert.rejects(recover({ workspace: value.workspace, dataRoot: value.dataRoot, originals }, async caps => {
    await trash(caps[0].cap); throw crash;
  }), failure => failure === crash);
  await recover({ workspace: value.workspace, dataRoot: value.dataRoot, originals }, async caps => {
    assert.deepEqual(caps.map(item => disposition(item.cap)), ['already_moved', 'projection_absent', 'pending']);
    const moved = await receipt(caps[0].cap), absent = await receipt(caps[1].cap);
    assert.equal(await receipt(caps[0].cap), moved); await strict(caps[0].cap, moved); await strict(caps[1].cap, absent);
    await current(caps[2].cap); assert.equal(await fs.readFile(path.join(value.workspace.rootPath, 'b.md'), 'utf8'), 'B');
    const resumed = await trash(caps[2].cap); await strict(caps[2].cap, resumed);
  });
}));

test('real rename with lost parent-fsync ACK stays recoverable from original evidence', t => fixture(async value => {
  await file(value, 'note.md', 'D1'); const originals = await saved(value, [selected('note.md')]);
  const actualSync = io.fsync, target = destination(value, originals[0].original);
  let injected = false;
  t.mock.method(io, 'fsync', (fd: number, callback: Parameters<typeof io.fsync>[1]) => actualSync(fd, failure => {
    if (!failure && !injected && io.existsSync(target) && !io.existsSync(path.join(value.workspace.rootPath, 'note.md'))) {
      injected = true; callback(Object.assign(new Error('Controlled fsync acknowledgment loss'), { code: 'EIO' }));
    } else callback(failure);
  }));
  try {
    await assert.rejects(recover({ workspace: value.workspace, dataRoot: value.dataRoot, originals }, async caps => {
      await trash(caps[0].cap);
    }), error('move-unconfirmed'));
  } finally { io.fsync = actualSync; }
  assert.equal(injected, true); assert.equal(await fs.readFile(target, 'utf8'), 'D1');
  const before = await fs.lstat(target);
  await recover({ workspace: value.workspace, dataRoot: value.dataRoot, originals }, async caps => {
    assert.equal(disposition(caps[0].cap), 'already_moved'); const actual = await receipt(caps[0].cap); await strict(caps[0].cap, actual);
  });
  const after = await fs.lstat(target); assert.equal(after.ino, before.ino); assert.equal(after.ctimeMs, before.ctimeMs);
}));

test('an already-moved absent-projection recovery remains absence evidence', () => fixture(async value => {
  const originals = await saved(value, [selected('absent.md', 'projection_absent')]);
  for (let attempt = 0; attempt < 2; attempt++) await recover({ workspace: value.workspace, dataRoot: value.dataRoot, originals }, async caps => {
    assert.equal(disposition(caps[0].cap), 'projection_absent');
    const actual = await trash(caps[0].cap); await strict(caps[0].cap, actual);
  });
}));

for (const kind of ['regular_file', 'directory'] as const) test(`D2 at an old ${kind} source is preserved and blocks pending-cohort recovery`, () => fixture(async value => {
  await file(value, kind === 'directory' ? 'source/child.md' : 'source', 'D1');
  const originals = await saved(value, [selected('source', kind)]);
  await recover({ workspace: value.workspace, dataRoot: value.dataRoot, originals }, async caps => { await trash(caps[0].cap); });
  await file(value, 'source', 'D2');
  await assert.rejects(recover({ workspace: value.workspace, dataRoot: value.dataRoot, originals }, async () => assert.fail('D2 reached callback.')),
    error('recovery-conflict', 'source-changed'));
  assert.equal(await fs.readFile(path.join(value.workspace.rootPath, 'source'), 'utf8'), 'D2');
  assert.equal(await fs.readFile(kind === 'directory' ? path.join(destination(value, originals[0].original), 'child.md') : destination(value, originals[0].original), 'utf8'), 'D1');
}));

test('AfterTrash current/receipt/vacancy rejects D2 created during the same genuine callback', () => fixture(async value => {
  await file(value, 'note.md', 'D1');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('note.md')] }, async caps => {
    await trash(caps[0].cap); await file(value, 'note.md', 'D2'); await vacant(caps[0].cap);
  }), error('source-changed'));
  assert.equal(await fs.readFile(path.join(value.workspace.rootPath, 'note.md'), 'utf8'), 'D2');
}));

test('a newly materialized ancestor invalidates original projection-absence evidence', () => fixture(async value => {
  const originals = await saved(value, [selected('missing/note.md', 'projection_absent')]);
  await fs.mkdir(path.join(value.workspace.rootPath, 'missing'), { mode: 0o700 });
  await assert.rejects(recover({ workspace: value.workspace, dataRoot: value.dataRoot, originals }, async () => assert.fail('Changed ancestor reached callback.')),
    error('recovery-conflict', 'source-changed'));
}));

test('same bytes at a replacement inode never become the original D1', () => fixture(async value => {
  await file(value, 'note.md', 'D1'); const originals = await saved(value, [selected('note.md')]);
  await fs.rename(path.join(value.workspace.rootPath, 'note.md'), path.join(value.workspace.rootPath, 'old.md'));
  await file(value, 'note.md', 'D1');
  await assert.rejects(recover({ workspace: value.workspace, dataRoot: value.dataRoot, originals }, async () => assert.fail('Replacement reached callback.')),
    error('recovery-conflict'));
}));

test('a mutated descendant blocks a prepared directory before rename', () => fixture(async value => {
  await file(value, 'folder/nested/note.md', 'before');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('folder', 'directory')] }, async caps => {
    await fs.writeFile(path.join(value.workspace.rootPath, 'folder/nested/note.md'), 'after'); await trash(caps[0].cap);
  }), error('source-changed'));
  assert.equal(await fs.readFile(path.join(value.workspace.rootPath, 'folder/nested/note.md'), 'utf8'), 'after');
}));

test('unexpected descendant inserted after preparation blocks the exact tree', () => fixture(async value => {
  await file(value, 'folder/note.md');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('folder', 'directory')] }, async caps => {
    await file(value, 'folder/foreign.png'); await trash(caps[0].cap);
  }), error('source-changed'));
}));

test('post-rename payload mutation invalidates its same-cap completed receipt', () => fixture(async value => {
  await file(value, 'folder/note.md', 'D1');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('folder', 'directory')] }, async caps => {
    const actual = await trash(caps[0].cap);
    await fs.writeFile(path.join(destination(value, read(caps[0].cap)), 'note.md'), 'foreign'); await strict(caps[0].cap, actual);
  }), error('source-changed'));
}));

test('existing trash entry reservation is never borrowed even when empty', () => fixture(async value => {
  await file(value, 'note.md'); const selection = selected('note.md');
  await saved(value, [selection]);
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selection] }, async () => assert.fail('Borrowed reservation reached callback.')),
    error('destination-occupied'));
  assert.equal(await fs.readFile(path.join(value.workspace.rootPath, 'note.md'), 'utf8'), 'note.md');
}));

test('foreign trash payload is preserved and no-replace destination admission fails', () => fixture(async value => {
  await file(value, 'note.md', 'D1');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('note.md')] }, async caps => {
    const original = read(caps[0].cap); await fs.writeFile(destination(value, original), 'foreign', { mode: 0o600 }); value.remember();
    await trash(caps[0].cap);
  }), error('destination-occupied'));
  assert.equal(await fs.readFile(path.join(value.workspace.rootPath, 'note.md'), 'utf8'), 'D1');
}));

test('unexpected sibling inside private entry blocks mutation', () => fixture(async value => {
  await file(value, 'note.md', 'D1');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('note.md')] }, async caps => {
    await fs.writeFile(path.join(path.dirname(destination(value, read(caps[0].cap))), 'foreign'), 'foreign', { mode: 0o600 }); value.remember();
    await trash(caps[0].cap);
  }), error('destination-occupied'));
}));

for (const placement of ['leaf', 'parent', 'nested'] as const) test(`symlink at ${placement} is rejected without following it`, () => fixture(async value => {
  await file(value, 'target/note.md', 'retained');
  const selectedPath = placement === 'leaf' ? 'note.md' : placement === 'parent' ? 'linked/note.md' : 'folder';
  if (placement === 'nested') await fs.mkdir(path.join(value.workspace.rootPath, 'folder'), { mode: 0o700 });
  await fs.symlink(placement === 'leaf' ? 'target/note.md' : placement === 'parent' ? 'target' : '../target',
    path.join(value.workspace.rootPath, placement === 'leaf' ? 'note.md' : placement === 'parent' ? 'linked' : 'folder/linked'));
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot,
    selections: [selected(selectedPath, placement === 'nested' ? 'directory' : 'regular_file')] }, async () => assert.fail('Symlink reached callback.')),
    error('unsafe-path', 'source-changed'));
  assert.equal(await fs.readFile(path.join(value.workspace.rootPath, 'target/note.md'), 'utf8'), 'retained');
}));

for (const nested of [false, true]) test(`${nested ? 'nested' : 'root'} hard-linked regular file is rejected`, () => fixture(async value => {
  await file(value, nested ? 'folder/note.md' : 'note.md', 'retained');
  await fs.link(path.join(value.workspace.rootPath, nested ? 'folder/note.md' : 'note.md'), path.join(value.workspace.rootPath, 'alias.md'));
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot,
    selections: [selected(nested ? 'folder' : 'note.md', nested ? 'directory' : 'regular_file')] }, async () => assert.fail('Hard link reached callback.')),
    error('unsafe-path'));
}));

test('named FIFO is a rejected special node and never blocks on an ordinary file open', () => fixture(async value => {
  await fs.mkdir(path.join(value.workspace.rootPath, 'folder'), { mode: 0o700 });
  execFileSync('mkfifo', [path.join(value.workspace.rootPath, 'folder/fifo')]); value.remember();
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot,
    selections: [selected('folder', 'directory')] }, async () => assert.fail('Special node reached callback.')), error('unsafe-path'));
}));

test('source parent changed to a symlink is rejected even if it resolves to the old inode', () => fixture(async value => {
  await file(value, 'folder/note.md');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('folder/note.md')] }, async caps => {
    await fs.rename(path.join(value.workspace.rootPath, 'folder'), path.join(value.workspace.rootPath, 'old-folder'));
    await fs.symlink('old-folder', path.join(value.workspace.rootPath, 'folder')); await trash(caps[0].cap);
  }), error('scope-changed', 'unsafe-path'));
}));

test('configured DATA root cannot be swapped for a symlink to its original inode', () => fixture(async value => {
  await file(value, 'note.md');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('note.md')] }, async caps => {
    await fs.rename(value.dataRoot, value.dataRoot + '-old'); await fs.symlink(value.dataRoot + '-old', value.dataRoot); await trash(caps[0].cap);
  }), error('scope-changed'));
}));

test('trash reservation loses authority when made accessible to another group', () => fixture(async value => {
  await file(value, 'note.md');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('note.md')] }, async caps => {
    await fs.chmod(path.dirname(destination(value, read(caps[0].cap))), 0o750); await trash(caps[0].cap);
  }), error('unsafe-path', 'scope-changed'));
}));

test('source directory cannot contain DATA trash reservations, including configured-root aliases', () => fixture(async value => {
  const workspace = { ...value.workspace, rootPath: value.dataRoot };
  await fs.mkdir(path.join(value.dataRoot, '.trash'), { mode: 0o700 });
  await assert.rejects(prepare({ workspace, dataRoot: value.dataRoot,
    selections: [selected('.trash', 'directory')] }, async () => assert.fail('Recursive trash source reached callback.')), error('unsafe-path'));
  const inner = path.join(value.dataRoot, 'inner'), alias = path.join(value.base, 'data-alias');
  await fs.mkdir(inner, { mode: 0o700 }); await fs.mkdir(path.join(inner, '.trash'), { mode: 0o700 });
  await fs.symlink(value.dataRoot, alias);
  await assert.rejects(prepare({ workspace: { ...workspace, rootPath: path.join(alias, 'inner') }, dataRoot: inner,
    selections: [selected('.trash', 'directory')] }, async () => assert.fail('Real-root alias overlap reached callback.')), error('unsafe-path'));
}));

test('cumulative entries budget covers multiple individually legal trees before callback', () => fixture(async value => {
  await file(value, 'a/one.md', 'A'); await file(value, 'b/two.md', 'B');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot,
    selections: [selected('b', 'directory'), selected('a', 'directory')], budget: { maxDepth: 32, maxEntries: 3, maxHashBytes: 1024 } },
  async () => assert.fail('Cumulative over-budget trees reached callback.')), error('budget-exceeded'));
  assert.equal(await fs.readFile(path.join(value.workspace.rootPath, 'a/one.md'), 'utf8'), 'A');
  assert.equal(await fs.readFile(path.join(value.workspace.rootPath, 'b/two.md'), 'utf8'), 'B');
}));

test('cumulative hash budget covers several individually legal files', () => fixture(async value => {
  await file(value, 'a.md', 'AAA'); await file(value, 'b.md', 'BBB');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot,
    selections: [selected('a.md'), selected('b.md')], budget: { maxDepth: 32, maxEntries: 10, maxHashBytes: 5 } },
  async () => assert.fail('Cumulative over-budget bytes reached callback.')), error('budget-exceeded'));
}));

test('depth limit includes nested directories and files and cannot be increased', () => fixture(async value => {
  await file(value, 'folder/nested/note.md');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('folder', 'directory')],
    budget: { maxDepth: 1, maxEntries: 10, maxHashBytes: 1024 } }, async () => assert.fail('Over-depth tree reached callback.')), error('budget-exceeded'));
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('folder', 'directory')],
    budget: { maxDepth: 33, maxEntries: 10, maxHashBytes: 1024 } }, async () => assert.fail('Increased depth reached callback.')), error('invalid-input'));
}));

test('overlapping, duplicate-root, duplicate-step and duplicate-entry selections reject before callback', () => fixture(async value => {
  await file(value, 'folder/note.md');
  const a = selected('folder', 'directory');
  for (const selections of [[a, selected('folder/note.md')], [a, selected('folder', 'directory')],
    [a, selected('other.md', 'projection_absent', a.stepKey)], [a, { ...selected('other.md', 'projection_absent'), trashEntryId: a.trashEntryId }]]) {
    await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections }, async () => assert.fail('Invalid cohort reached callback.')),
      error('invalid-input'));
  }
}));

test('strict decoder rejects getters without invoking them and rejects sparse arrays, unknown fields and versions', () => fixture(async value => {
  await file(value, 'note.md'); const originals = await saved(value, [selected('note.md')]); const original = originals[0].original;
  assert.deepEqual(decodeOriginal(original), original); assert.notEqual(decodeOriginal(original), original);
  let invoked = false; const getter = { ...original };
  Object.defineProperty(getter, 'source', { enumerable: true, get() { invoked = true; return original.source; } });
  assert.throws(() => decodeOriginal(getter), error('invalid-input')); assert.equal(invoked, false);
  assert.throws(() => decodeOriginal({ ...original, version: 2 }), error('invalid-input'));
  assert.throws(() => decodeOriginal({ ...original, unexpected: true }), error('invalid-input'));
  const sparse = Array<Selection>(1);
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: sparse }, async () => assert.fail('Sparse cohort reached callback.')),
    error('invalid-input'));
}));

test('lexical escapes, noncanonical names and tampered trash paths reject before any callback', () => fixture(async value => {
  for (const pathname of ['../note.md', '/note.md', 'a//note.md', 'a/./note.md', 'a\\note.md', 'a\u0000note.md', '\ud800.md']) {
    await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected(pathname)] },
      async () => assert.fail('Invalid path reached callback.')), error('invalid-input'));
  }
  await file(value, 'note.md'); const originals = await saved(value, [selected('note.md')]);
  assert.throws(() => decodeOriginal({ ...originals[0].original, trashRelativePath: '../foreign' }), error('invalid-input'));
  const wrongRoot = structuredClone(originals[0].original);
  Reflect.set(wrongRoot.filesystem.workspaceRoot.identity, 'inode', '1');
  await assert.rejects(recover({ workspace: value.workspace, dataRoot: value.dataRoot,
    originals: [{ stepKey: originals[0].stepKey, original: wrongRoot }] }, async () => assert.fail('Wrong original root reached callback.')),
    error('recovery-conflict'));
}));

test('recovery cannot move unchanged originals in another workspace or another DATA scope', () => fixture(async value => {
  await file(value, 'note.md'); const originals = await saved(value, [selected('note.md')]);
  await assert.rejects(recover({ workspace: { ...value.workspace, workspaceId: 'foreign' }, dataRoot: value.dataRoot, originals },
    async () => assert.fail('Foreign workspace reached callback.')), error('scope-changed'));
  await assert.rejects(recover({ workspace: value.workspace, dataRoot: path.join(value.base, 'foreign'), originals },
    async () => assert.fail('Foreign DATA reached callback.')), error('scope-changed'));
}));

test('same-batch concurrent operations poison every cap and drain all opened descriptors', () => fixture(async value => {
  await file(value, 'a.md', 'A'); await file(value, 'b.md', 'B');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('a.md'), selected('b.md')] }, async caps => {
    const first = current(caps[0].cap), second = current(caps[1].cap);
    const settled = await Promise.allSettled([first, second]); assert(settled.some(item => item.status === 'rejected'));
  }), error('reentrant-operation'));
}));

test('nested explicit preparation poisons the original entire batch even when rejection is caught', () => fixture(async value => {
  await file(value, 'a.md'); await file(value, 'b.md');
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('a.md')] }, async () => {
    await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('b.md')] }, async () => undefined), error('reentrant-operation'));
  }), error('reentrant-operation'));
}));

test('an unawaited real read is poisoned and drained before the cohort returns', () => fixture(async value => {
  await file(value, 'note.md', 'A'.repeat(1024 * 1024));
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('note.md')] }, async caps => {
    void current(caps[0].cap).catch(() => undefined);
  }), error('unawaited-operation'));
}));

test('deferred escaped and foreign caps fail and cannot authorize a fresh cohort', () => fixture(async value => {
  await file(value, 'a.md'); await file(value, 'b.md'); let retained!: Cap;
  await prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('a.md')] }, async caps => { retained = caps[0].cap; });
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(current(retained), error('invalid-lifetime'));
  await assert.rejects(prepare({ workspace: value.workspace, dataRoot: value.dataRoot, selections: [selected('b.md')] }, async () => {
    assert.throws(() => read(retained), error('invalid-lifetime'));
  }), error('invalid-lifetime'));
}));

test('actual cross-device DATA is rejected without a copy fallback', async context => {
  if (process.platform !== 'linux') { context.skip('A real second writable device is only discovered at /dev/shm on Linux.'); return; }
  let external: string;
  try { external = await fs.mkdtemp('/dev/shm/canvas-prepared-trash-cross-device-'); }
  catch { context.skip('No private writable second device.'); return; }
  try {
    await fs.chmod(external, 0o700);
    const externalRoot = await fs.lstat(external);
    await fixture(async value => {
      if ((await fs.stat(value.workspace.rootPath)).dev === (await fs.stat(external)).dev) { context.skip('The candidate uses the same device.'); return; }
      await file(value, 'note.md', 'D1');
      await assert.rejects(prepare({ workspace: value.workspace, dataRoot: external, selections: [selected('note.md')] },
        async () => assert.fail('Cross-device cohort reached callback.')), error('cross-device-move'));
      assert.equal(await fs.readFile(path.join(value.workspace.rootPath, 'note.md'), 'utf8'), 'D1');
      assert.deepEqual(await fs.readdir(external), []);
    });
    for (const name of io.readdirSync('/proc/self/fd')) if (/^\d+$/u.test(name)) {
      let info; try { info = io.fstatSync(Number(name)); } catch { continue; }
      assert.equal(info.dev === externalRoot.dev && info.ino === externalRoot.ino, false, 'The rejected second-device root FD must close.');
    }
  } finally { await fs.rm(external, { recursive: true }); }
});

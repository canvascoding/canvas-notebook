import assert from 'node:assert/strict';
import { type Dir, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { assertWorkspaceOriginalPathsCurrent, WorkspaceOriginalFileSourceError,
  type WorkspaceOriginalPathObservation, type WorkspaceOriginalRootObservation } from '../app/lib/files/workspace-original-file-source';
import { filesystemFileVersion } from '../app/lib/filesystem/file-version';

type Batch = Parameters<typeof assertWorkspaceOriginalPathsCurrent>[0];
async function withOriginalPathsBatchFixture(operation: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-original-batch-'));
  try { await operation(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function observe(rootPath: string, selected: string[]): Promise<Batch> {
  const resolvedRootPath = await fs.realpath(rootPath), entries = new Map<string, WorkspaceOriginalPathObservation>();
  for (const pathname of selected) {
    let current = '';
    for (const segment of pathname.split('/')) {
      current = current ? `${current}/${segment}` : segment;
      if (entries.has(current)) continue;
      const stat = await fs.lstat(path.join(resolvedRootPath, current)); entries.set(current, { relativePath: current, stat, identity: filesystemFileVersion(stat) });
    }
  }
  const root: WorkspaceOriginalRootObservation = { resolvedRootPath, identity: filesystemFileVersion(await fs.stat(resolvedRootPath)), entries };
  return { configuredRootPath: rootPath, root, observed: selected.map(pathname => entries.get(pathname)!) };
}
const changed = (error: unknown) => error instanceof WorkspaceOriginalFileSourceError
  && ['physical-source-changed', 'physical-scope-changed'].includes(error.code);
const contains = (error: unknown, primary: Error): boolean => error === primary || error instanceof Error
  && (contains(error.cause, primary) || error instanceof AggregateError && error.errors.some(child => contains(child, primary)));
function watchDirectories(t: TestContext, hooks: { opened?: (directory: Dir, pathname: string) => void } = {}) {
  const original = fs.opendir.bind(fs), opened: Array<{ directory: Dir; pathname: string; read: Dir['read']; close: Dir['close'] }> = [];
  t.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
    const directory = await original(...args), pathname = String(args[0]);
    opened.push({ directory, pathname, read: directory.read.bind(directory), close: directory.close.bind(directory) });
    hooks.opened?.(directory, pathname); return directory;
  });
  return { opened, assertClosed: async () => {
    assert(opened.length > 0);
    for (const value of opened) await assert.rejects(() => value.read(), { code: 'ERR_DIR_CLOSED' });
  } };
}
function gateFirstRootStat(t: TestContext, root: string) {
  const original = fs.stat.bind(fs); let reached!: () => void, release!: () => void, held = false;
  const started = new Promise<void>(resolve => { reached = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(fs, 'stat', async (...args: Parameters<typeof fs.stat>) => {
    const value = await original(...args);
    if (!held && String(args[0]) === root) { held = true; reached(); await resume; }
    return value;
  });
  return { started, release };
}

test('fresh exact names, spaces and empty directory remain current; unselected unsafe/excluded descendants are not inspected', async t => withOriginalPathsBatchFixture(async root => {
  await fs.mkdir(path.join(root, ' Folder /empty'), { recursive: true }); await fs.writeFile(path.join(root, ' Folder / Note.md '), 'exact');
  await fs.mkdir(path.join(root, '.git')); await fs.writeFile(path.join(root, '.git/ignored'), 'excluded');
  await fs.symlink(path.join(root, '.git'), path.join(root, 'unselected-link'));
  const input = await observe(root, [' Folder / Note.md ', ' Folder /empty']);
  const original = fs.lstat.bind(fs), inspected: string[] = [];
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => { inspected.push(String(args[0])); return original(...args); });
  const tracked = watchDirectories(t); await assertWorkspaceOriginalPathsCurrent(input); await tracked.assertClosed();
  assert(inspected.every(filename => !filename.includes('/.git') && !filename.includes('/unselected-link')));
}));

test('192 siblings and nested children use one actual directory stream per required parent, with no elapsed-time assertion', async t => withOriginalPathsBatchFixture(async root => {
  await fs.mkdir(path.join(root, 'assets/deep'), { recursive: true }); await fs.mkdir(path.join(root, 'assets/empty'));
  const selected = ['assets/empty', 'assets/deep/child.bin']; await fs.writeFile(path.join(root, 'assets/deep/child.bin'), 'nested');
  for (let index = 0; index < 192; index++) { const name = `assets/${String(index).padStart(3, '0')}.bin`; await fs.writeFile(path.join(root, name), 'asset'); selected.push(name); }
  const input = await observe(root, selected), counts = new Map<string, number>();
  const tracked = watchDirectories(t, { opened: (_directory, pathname) => counts.set(pathname, (counts.get(pathname) ?? 0) + 1) });
  await assertWorkspaceOriginalPathsCurrent(input);
  assert.deepEqual([...counts].sort(), [[root, 1], [path.join(root, 'assets'), 1], [path.join(root, 'assets/deep'), 1]].sort());
  await tracked.assertClosed();
}));

test('exact case aliases cannot reuse another spelling even with the same actual inode and Stats', async () => withOriginalPathsBatchFixture(async root => {
  await fs.writeFile(path.join(root, 'Case.md'), 'case'); const actual = await observe(root, ['Case.md']);
  const alias = { ...actual.observed[0], relativePath: 'case.md' }, entries = new Map(actual.root.entries); entries.set('case.md', alias);
  await assert.rejects(assertWorkspaceOriginalPathsCurrent({ ...actual, root: { ...actual.root, entries }, observed: [alias] }), changed);
  assert.equal(await fs.readFile(path.join(root, 'Case.md'), 'utf8'), 'case');
}));

test('parent replacement is rejected even when the child inode AND complete child file-version stay identical', async t => withOriginalPathsBatchFixture(async root => {
  await fs.mkdir(path.join(root, 'outer/parent'), { recursive: true }); await fs.mkdir(path.join(root, 'outer/replacement'));
  await fs.writeFile(path.join(root, 'outer/parent/note.bin'), 'original');
  // Existing hardlinks are namespace observations only; this test reads no
  // source bytes through the FD reader and grants no file-write authority.
  await fs.link(path.join(root, 'outer/parent/note.bin'), path.join(root, 'outer/replacement/note.bin'));
  const input = await observe(root, ['outer/parent/note.bin']); let swapped = false;
  const tracked = watchDirectories(t, { opened: (directory, pathname) => {
    if (pathname !== path.join(root, 'outer/parent')) return;
    const read = directory.read.bind(directory);
    t.mock.method(directory, 'read', async () => { const value = await read();
      if (!swapped) { swapped = true; await fs.rename(path.join(root, 'outer/parent'), path.join(root, 'outer/old'));
        await fs.rename(path.join(root, 'outer/replacement'), path.join(root, 'outer/parent')); }
      return value;
    });
  } });
  await assert.rejects(assertWorkspaceOriginalPathsCurrent(input), changed); assert(swapped);
  const after = await fs.lstat(path.join(root, 'outer/parent/note.bin'));
  assert.equal(after.ino, input.observed[0].stat.ino); assert.equal(filesystemFileVersion(after), input.observed[0].identity);
  await tracked.assertClosed();
}));

test('a parent replaced by a symlink after streaming begins is rejected and all streams close', async t => withOriginalPathsBatchFixture(async root => {
  await fs.mkdir(path.join(root, 'outer/parent'), { recursive: true }); await fs.writeFile(path.join(root, 'outer/parent/note.bin'), 'original');
  const input = await observe(root, ['outer/parent/note.bin']); let swapped = false;
  const tracked = watchDirectories(t, { opened: (directory, pathname) => {
    if (pathname !== path.join(root, 'outer/parent')) return; const read = directory.read.bind(directory);
    t.mock.method(directory, 'read', async () => { const value = await read(); if (!swapped) { swapped = true;
      await fs.rename(path.join(root, 'outer/parent'), path.join(root, 'outer/previous'));
      await fs.symlink(path.join(root, 'outer/previous'), path.join(root, 'outer/parent')); } return value; });
  } });
  await assert.rejects(assertWorkspaceOriginalPathsCurrent(input), changed); assert(swapped); await tracked.assertClosed();
}));

test('retargeting an originally valid configured-root symlink during the first stat cannot adopt another root', async t => withOriginalPathsBatchFixture(async base => {
  for (const name of ['first', 'second']) { await fs.mkdir(path.join(base, name)); await fs.writeFile(path.join(base, name, 'note.bin'), name); }
  const configured = path.join(base, 'configured'); await fs.symlink(path.join(base, 'first'), configured);
  const input = await observe(configured, ['note.bin']), gate = gateFirstRootStat(t, input.root.resolvedRootPath);
  const pending = assertWorkspaceOriginalPathsCurrent(input); await gate.started;
  await fs.unlink(configured); await fs.symlink(path.join(base, 'second'), configured); gate.release();
  await assert.rejects(pending, changed); assert.equal(await fs.readFile(path.join(base, 'first/note.bin'), 'utf8'), 'first');
}));

test('caller array/Map/Stats/path/root mutation after invocation cannot replace the synchronously captured original', async t => withOriginalPathsBatchFixture(async base => {
  await fs.mkdir(path.join(base, 'first/folder'), { recursive: true }); await fs.mkdir(path.join(base, 'second'));
  await fs.writeFile(path.join(base, 'first/folder/note.bin'), 'original'); await fs.writeFile(path.join(base, 'second/other.bin'), 'other');
  const original = await observe(path.join(base, 'first'), ['folder/note.bin']), other = await observe(path.join(base, 'second'), ['other.bin']);
  const observed = [...original.observed], entries = new Map(original.root.entries), root = { ...original.root, entries };
  const input = { configuredRootPath: original.configuredRootPath, root, observed };
  const gate = gateFirstRootStat(t, original.root.resolvedRootPath), pending = assertWorkspaceOriginalPathsCurrent(input); await gate.started;
  input.configuredRootPath = other.configuredRootPath; root.resolvedRootPath = other.root.resolvedRootPath; root.identity = other.root.identity;
  entries.clear(); entries.set('other.bin', other.observed[0]); observed.splice(0, 1, other.observed[0]);
  const held = original.observed[0] as { relativePath: string; identity: string; stat: Stats };
  held.relativePath = 'other.bin'; held.identity = other.observed[0].identity; held.stat.size = 0; held.stat.mode = 0;
  gate.release(); await pending;
  assert.equal(await fs.readFile(path.join(original.root.resolvedRootPath, 'folder/note.bin'), 'utf8'), 'original');
}));

test('updating caller Stats/identity to a genuinely changed file during the first await cannot launder source drift', async t => withOriginalPathsBatchFixture(async root => {
  await fs.mkdir(path.join(root, 'folder')); await fs.writeFile(path.join(root, 'folder/note.bin'), 'original');
  const input = await observe(root, ['folder/note.bin']), gate = gateFirstRootStat(t, input.root.resolvedRootPath);
  const pending = assertWorkspaceOriginalPathsCurrent(input); await gate.started;
  await fs.writeFile(path.join(root, 'folder/note.bin'), 'a different actual source');
  const next = await fs.lstat(path.join(root, 'folder/note.bin'));
  const held = input.observed[0] as { stat: Stats; identity: string }; held.stat = next; held.identity = filesystemFileVersion(next);
  (input.root.entries as Map<string, WorkspaceOriginalPathObservation>).set('folder/note.bin', input.observed[0]);
  gate.release(); await assert.rejects(pending, changed);
}));

for (const mode of ['open', 'read', 'close-ack'] as const) test(`actual directory ${mode} failure never certifies current state and closes every opened stream`, async t => withOriginalPathsBatchFixture(async root => {
  await fs.mkdir(path.join(root, 'folder')); await fs.writeFile(path.join(root, 'folder/note.bin'), 'original');
  const input = await observe(root, ['folder/note.bin']), primary = new Error(`Owned directory ${mode} failure`); let fired = false;
  const tracked = watchDirectories(t, { opened: (directory, pathname) => {
    if (pathname !== path.join(root, 'folder')) return;
    if (mode === 'read') t.mock.method(directory, 'read', async () => { fired = true; throw primary; });
    if (mode === 'close-ack') { const close = directory.close.bind(directory); t.mock.method(directory, 'close', async () => { await close(); fired = true; throw primary; }); }
  } });
  if (mode === 'open') { const original = fs.opendir.bind(fs); t.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
    if (String(args[0]) === path.join(root, 'folder')) { fired = true; throw primary; } return original(...args);
  }); }
  await assert.rejects(assertWorkspaceOriginalPathsCurrent(input), error => contains(error, primary)); assert(fired); await tracked.assertClosed();
}));

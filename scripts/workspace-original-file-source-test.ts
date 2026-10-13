import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { assertWorkspaceOriginalPathCurrent, readWorkspaceOriginalFileSource, WorkspaceOriginalFileSourceError,
  type WorkspaceOriginalPathObservation, type WorkspaceOriginalRootObservation } from '../app/lib/files/workspace-original-file-source';
import { filesystemFileVersion } from '../app/lib/filesystem/file-version';

const FIVE_MIB = 5 * 1024 * 1024;
async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-original-source-'));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function observe(configuredRootPath: string, relativePath: string) {
  const resolvedRootPath = await fs.realpath(configuredRootPath);
  const entries = new Map<string, WorkspaceOriginalPathObservation>(); let current = '';
  for (const segment of relativePath.split('/')) {
    current = current ? `${current}/${segment}` : segment;
    const stat = await fs.lstat(path.join(resolvedRootPath, current));
    entries.set(current, { relativePath: current, stat, identity: filesystemFileVersion(stat) });
  }
  const root: WorkspaceOriginalRootObservation = { resolvedRootPath,
    identity: filesystemFileVersion(await fs.stat(resolvedRootPath)), entries };
  return { configuredRootPath, root, observed: entries.get(relativePath)! };
}
const code = (expected: WorkspaceOriginalFileSourceError['code']) => (error: unknown) =>
  error instanceof WorkspaceOriginalFileSourceError && error.code === expected;
function trackHandles(t: TestContext, afterOpen?: (handle: FileHandle) => Promise<void>) {
  const original = fs.open.bind(fs), handles: FileHandle[] = [], flags: number[] = [];
  t.mock.method(fs, 'open', async (filePath: string, options: number) => {
    flags.push(options); const handle = await original(filePath, options); handles.push(handle);
    await afterOpen?.(handle); return handle;
  });
  return { handles, flags, assertClosed: async () => {
    assert(handles.length > 0);
    for (const handle of handles) {
      assert.equal(handle.fd, -1);
      await assert.rejects(() => handle.stat(), { code: 'EBADF' });
    }
  } };
}

test('opaque original bytes retain BOM, CRLF, frontmatter and undecodable UTF-8 without parsing', async t => fixture(async root => {
  const bytes = Buffer.concat([Buffer.from('\uFEFF---\r\ntitle: 😀\r\n---\r\n\r\n# Body\r\n'), Buffer.from([0xff, 0xfe, 0x00])]);
  await fs.writeFile(path.join(root, 'source.txt'), bytes);
  const source = await observe(root, 'source.txt'); const tracked = trackHandles(t); let checks = 0;
  const result = await readWorkspaceOriginalFileSource({ ...source, maxBytes: FIVE_MIB, verifyCurrentSource: async () => { checks += 1; } });
  assert.deepEqual(Buffer.from(result), bytes); assert.equal(result.byteLength, result.buffer.byteLength); assert.equal(checks, 1);
  assert(tracked.flags.every(flags => (flags & constants.O_NOFOLLOW) !== 0 && (flags & constants.O_NONBLOCK) !== 0));
  await tracked.assertClosed();
}));

test('explicit 5 MiB succeeds, one byte over fails before hooks/open/allocation and zero-byte budgets are exact', async t => fixture(async root => {
  const bytes = Buffer.alloc(FIVE_MIB, 0x61);
  await fs.writeFile(path.join(root, 'exact.bin'), bytes);
  await fs.writeFile(path.join(root, 'large.bin'), Buffer.alloc(FIVE_MIB + 1, 0x62));
  await fs.writeFile(path.join(root, 'empty.bin'), Buffer.alloc(0));
  const tracked = trackHandles(t);
  const result = await readWorkspaceOriginalFileSource({ ...await observe(root, 'exact.bin'), maxBytes: FIVE_MIB, verifyCurrentSource: async () => {} });
  assert.deepEqual(Buffer.from(result), bytes); const opened = tracked.handles.length; let hooks = 0;
  const large = await observe(root, 'large.bin');
  await assert.rejects(() => readWorkspaceOriginalFileSource({ ...large, maxBytes: FIVE_MIB,
    verifyCurrentSource: async () => { hooks += 1; }, afterSourceFingerprint: async () => { hooks += 1; } }), code('source-too-large'));
  assert.equal(hooks, 0); assert.equal(tracked.handles.length, opened);
  const empty = await readWorkspaceOriginalFileSource({ ...await observe(root, 'empty.bin'), maxBytes: 0, verifyCurrentSource: async () => {} });
  assert.equal(empty.byteLength, 0); assert.equal(empty.buffer.byteLength, 0);
  const exact = await observe(root, 'exact.bin');
  for (const maxBytes of [-1, 1.5, NaN, Infinity, FIVE_MIB + 1]) {
    await assert.rejects(() => readWorkspaceOriginalFileSource({ ...exact, maxBytes, verifyCurrentSource: async () => {} }), code('invalid-source-limit'));
  }
  await tracked.assertClosed();
}));

test('exact leading/trailing spaces and filename case select actual entries without trimming', async () => fixture(async root => {
  await fs.mkdir(path.join(root, ' Folder '));
  await fs.writeFile(path.join(root, ' Folder / Note.md '), 'spaced original');
  await fs.mkdir(path.join(root, 'Folder'));
  await fs.writeFile(path.join(root, 'Folder/Note.md'), 'trimmed different file');
  const source = await observe(root, ' Folder / Note.md ');
  assert.equal(Buffer.from(await readWorkspaceOriginalFileSource({ ...source, maxBytes: 100, verifyCurrentSource: async () => {} })).toString(), 'spaced original');
  await fs.writeFile(path.join(root, 'Case.md'), 'original case');
  const actual = await observe(root, 'Case.md');
  const alias = { ...actual.observed, relativePath: 'case.md' };
  const fakeAliasMap = new Map(actual.root.entries); fakeAliasMap.set('case.md', alias);
  await assert.rejects(() => readWorkspaceOriginalFileSource({ ...actual, observed: alias,
    root: { ...actual.root, entries: fakeAliasMap }, maxBytes: 100, verifyCurrentSource: async () => {} }), code('physical-source-changed'));
  // Case-renaming changes namespace membership even when the same inode survives.
  const old = await observe(root, 'Case.md');
  await fs.rename(path.join(root, 'Case.md'), path.join(root, 'CASE.md'));
  await assert.rejects(() => assertWorkspaceOriginalPathCurrent(old), error => error instanceof WorkspaceOriginalFileSourceError);
}));

test('unsafe paths are rejected instead of being normalized into another file', async () => fixture(async root => {
  await fs.writeFile(path.join(root, 'note.md'), 'original'); const original = await observe(root, 'note.md');
  for (const relativePath of ['/note.md', '../note.md', 'folder/../note.md', './note.md', 'folder//note.md', 'note\\md', 'note\0.md']) {
    await assert.rejects(() => readWorkspaceOriginalFileSource({ ...original,
      observed: { ...original.observed, relativePath }, maxBytes: 100, verifyCurrentSource: async () => {} }), code('invalid-source-path'));
  }
}));

test('configured root symlinks are observed exactly; file symlinks, directories and hardlinks are unsafe', async () => fixture(async root => {
  await fs.mkdir(path.join(root, 'actual')); await fs.writeFile(path.join(root, 'actual/note.md'), 'actual');
  await fs.symlink(path.join(root, 'actual'), path.join(root, 'configured'));
  const configured = await observe(path.join(root, 'configured'), 'note.md');
  assert.equal(Buffer.from(await readWorkspaceOriginalFileSource({ ...configured, maxBytes: 100, verifyCurrentSource: async () => {} })).toString(), 'actual');
  await fs.symlink(path.join(root, 'actual/note.md'), path.join(root, 'file-link.md'));
  await fs.link(path.join(root, 'actual/note.md'), path.join(root, 'hard-link.md'));
  for (const relativePath of ['file-link.md', 'hard-link.md', 'actual']) {
    const source = await observe(root, relativePath);
    await assert.rejects(() => readWorkspaceOriginalFileSource({ ...source, maxBytes: 100,
      verifyCurrentSource: async () => {} }), code('unsafe-physical-source'));
  }
}));

test('inode replacement, size growth, ancestor replacement and introduced parent symlink invalidate observations', async () => {
  for (const mode of ['inode', 'growth', 'ancestor', 'parent-symlink'] as const) await fixture(async root => {
    await fs.mkdir(path.join(root, 'outer/inner'), { recursive: true });
    await fs.writeFile(path.join(root, 'outer/inner/note.md'), 'original');
    const source = await observe(root, 'outer/inner/note.md');
    const afterSourceFingerprint = async () => {
      if (mode === 'inode') {
        await fs.rename(path.join(root, 'outer/inner/note.md'), path.join(root, 'outer/inner/old.md'));
        await fs.writeFile(path.join(root, 'outer/inner/note.md'), 'replacement');
      } else if (mode === 'growth') await fs.appendFile(path.join(root, 'outer/inner/note.md'), ' enlarged');
      else {
        await fs.rename(path.join(root, 'outer/inner'), path.join(root, 'outer/previous'));
        if (mode === 'parent-symlink') await fs.symlink(path.join(root, 'outer/previous'), path.join(root, 'outer/inner'));
        else {
          await fs.mkdir(path.join(root, 'outer/inner'));
          await fs.rename(path.join(root, 'outer/previous/note.md'), path.join(root, 'outer/inner/note.md'));
          assert.equal((await fs.lstat(path.join(root, 'outer/inner/note.md'))).ino, source.observed.stat.ino);
        }
      }
    };
    await assert.rejects(() => readWorkspaceOriginalFileSource({ ...source, maxBytes: 100,
      verifyCurrentSource: async () => {}, afterSourceFingerprint }), error => error instanceof WorkspaceOriginalFileSourceError);
  });
});

test('caller mutation cannot replace captured paths, identities, ancestor entries or byte budget while awaiting', async () => fixture(async root => {
  await fs.mkdir(path.join(root, 'folder')); await fs.writeFile(path.join(root, 'folder/note.md'), 'original');
  await fs.writeFile(path.join(root, 'other.md'), 'other');
  const source = await observe(root, 'folder/note.md'); const other = await observe(root, 'other.md');
  const request = { ...source, maxBytes: 100, verifyCurrentSource: async () => {}, afterSourceFingerprint: async () => {
    request.maxBytes = 0; request.observed = other.observed; request.root = other.root;
    (source.root.entries as Map<string, WorkspaceOriginalPathObservation>).clear();
    (source.observed as { relativePath: string }).relativePath = 'other.md';
    source.observed.stat.size = 0;
  } };
  assert.equal(Buffer.from(await readWorkspaceOriginalFileSource(request)).toString(), 'original');
}));

test('fresh caller source check is awaited and path changes or failures cannot certify bytes', async t => fixture(async root => {
  await fs.writeFile(path.join(root, 'note.md'), 'original'); const source = await observe(root, 'note.md'); const tracked = trackHandles(t);
  await assert.rejects(() => readWorkspaceOriginalFileSource({ ...source, maxBytes: 100,
    verifyCurrentSource: async () => { throw new Error('source authority changed'); } }), /source authority changed/);
  assert.equal(tracked.handles.length, 0);
  await assert.rejects(() => readWorkspaceOriginalFileSource({ ...source, maxBytes: 100,
    verifyCurrentSource: async () => { await fs.appendFile(path.join(root, 'note.md'), 'changed'); } }), code('physical-source-changed'));
  assert.equal(tracked.handles.length, 0);
}));

test('real open FD is closed when source changes after opening or reading throws', async t => {
  for (const failure of ['after-open', 'read-error', 'after-read'] as const) await fixture(async root => {
    await fs.writeFile(path.join(root, 'note.md'), 'original'); const source = await observe(root, 'note.md');
    const tracked = trackHandles(t, async handle => {
      if (failure === 'after-open') await fs.appendFile(path.join(root, 'note.md'), 'changed');
      else {
        const original = handle.read.bind(handle);
        t.mock.method(handle, 'read', async (...args: Parameters<FileHandle['read']>) => {
          if (failure === 'read-error') throw new Error('injected read failure');
          const result = await original(...args);
          await fs.appendFile(path.join(root, 'note.md'), 'changed'); return result;
        });
      }
    });
    await assert.rejects(() => readWorkspaceOriginalFileSource({ ...source, maxBytes: 100, verifyCurrentSource: async () => {} }),
      failure === 'read-error' ? /injected read failure/ : code('physical-source-changed'));
    await tracked.assertClosed(); t.mock.restoreAll();
  });
});

test('new hardlink after opening, concurrent callers and success retain no usable descriptor', async t => fixture(async root => {
  await fs.writeFile(path.join(root, 'note.md'), 'original'); const source = await observe(root, 'note.md');
  const linked = trackHandles(t, async () => { await fs.link(path.join(root, 'note.md'), path.join(root, 'new-link.md')); });
  await assert.rejects(() => readWorkspaceOriginalFileSource({ ...source, maxBytes: 100, verifyCurrentSource: async () => {} }), code('unsafe-physical-source'));
  await linked.assertClosed(); t.mock.restoreAll(); await fs.unlink(path.join(root, 'new-link.md'));
  const current = await observe(root, 'note.md'); const tracked = trackHandles(t);
  const results = await Promise.all([1, 2].map(() => readWorkspaceOriginalFileSource({ ...current, maxBytes: 100, verifyCurrentSource: async () => {} })));
  assert(results.every(bytes => Buffer.from(bytes).toString() === 'original')); assert.equal(tracked.handles.length, 2);
  assert.notEqual(tracked.handles[0], tracked.handles[1]); await tracked.assertClosed();
}));

test('directory names stream without bulk readdir and retained directory handles close on match, miss and read error', async t => fixture(async root => {
  await fs.writeFile(path.join(root, 'note.md'), 'original'); const source = await observe(root, 'note.md');
  t.mock.method(fs, 'readdir', async () => { throw new Error('bulk directory allocation is forbidden'); });
  const original = fs.opendir.bind(fs); const directories: Awaited<ReturnType<typeof fs.opendir>>[] = [];
  let injectReadError = false;
  t.mock.method(fs, 'opendir', async (directoryPath: string) => {
    const directory = await original(directoryPath); directories.push(directory);
    if (injectReadError) t.mock.method(directory, 'read', async () => { throw new Error('injected directory read failure'); });
    return directory;
  });
  assert.equal(Buffer.from(await readWorkspaceOriginalFileSource({ ...source, maxBytes: 100, verifyCurrentSource: async () => {} })).toString(), 'original');
  const missing = { ...source.observed, relativePath: 'absent.md' };
  const entries = new Map(source.root.entries); entries.set(missing.relativePath, missing);
  await assert.rejects(() => assertWorkspaceOriginalPathCurrent({ ...source, observed: missing, root: { ...source.root, entries } }), code('physical-source-changed'));
  injectReadError = true;
  await assert.rejects(() => assertWorkspaceOriginalPathCurrent(source), /injected directory read failure/);
  assert(directories.length >= 3);
  for (const directory of directories) await assert.rejects(() => directory.close(), { code: 'ERR_DIR_CLOSED' });
}));

test('retargeted configured root and swapped observed root are rejected before opening the source', async () => fixture(async root => {
  await fs.mkdir(path.join(root, 'one')); await fs.mkdir(path.join(root, 'two'));
  await fs.writeFile(path.join(root, 'one/note.md'), 'first original'); await fs.writeFile(path.join(root, 'two/note.md'), 'other original');
  const configured = path.join(root, 'configured'); await fs.symlink(path.join(root, 'one'), configured);
  const source = await observe(configured, 'note.md');
  await assert.rejects(() => readWorkspaceOriginalFileSource({ ...source, maxBytes: 100, verifyCurrentSource: async () => {},
    afterSourceFingerprint: async () => { await fs.unlink(configured); await fs.symlink(path.join(root, 'two'), configured); } }), code('physical-scope-changed'));
  const other = await observe(path.join(root, 'two'), 'note.md');
  await assert.rejects(() => readWorkspaceOriginalFileSource({ ...source, root: other.root, maxBytes: 100,
    verifyCurrentSource: async () => {} }), code('physical-source-changed'));
}));

test('a regular file replaced by a real FIFO at open stays nonblocking, is rejected and closes the FD', async t => fixture(async root => {
  const filePath = path.join(root, 'note.md'); await fs.writeFile(filePath, 'original');
  const source = await observe(root, 'note.md'); const original = fs.open.bind(fs); let retained: FileHandle | undefined;
  const resolvedFilePath = path.join(source.root.resolvedRootPath, 'note.md');
  t.mock.method(fs, 'open', async (openedPath: string, flags: number) => {
    // Fail before an accidental blocking open if the required flag regresses.
    assert((flags & constants.O_NONBLOCK) !== 0); assert.equal(openedPath, resolvedFilePath);
    await fs.unlink(filePath); execFileSync('mkfifo', [filePath]);
    retained = await original(openedPath, flags); return retained;
  });
  await assert.rejects(() => readWorkspaceOriginalFileSource({ ...source, maxBytes: 100,
    verifyCurrentSource: async () => {} }), code('unsafe-physical-source'));
  assert(retained); assert.equal(retained.fd, -1); await assert.rejects(() => retained!.stat(), { code: 'EBADF' });
}));

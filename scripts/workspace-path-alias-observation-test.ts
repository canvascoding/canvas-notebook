import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertWorkspacePathHasNoAliases } from '../app/lib/workspaces/path-guard';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const originalReaddir = fs.readdir;
const contents = Buffer.from('[Document](nested/document.md)\n');
type Fixture = { root: string; file: string; workspace: WorkspaceContext };

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-path-observation-')));
  await fs.chmod(root, 0o700);
  const file = path.join(root, 'Verweise.md');
  const workspace: WorkspaceContext = {
    workspaceId: 'owned-path-observation', workspaceType: 'personal', rootPath: root,
    organizationId: null, ownerUserId: 'owned-path-observation', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true,
      canManageWorkspace: true, canRunAgent: true },
  };
  try {
    await fs.writeFile(file, contents);
    await run({ root, file, workspace });
  } finally {
    Object.defineProperty(fs, 'readdir', { value: originalReaddir });
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function duringDirectoryObservation(
  root: string,
  observe: (readActualDirectory: () => Promise<string[]>) => Promise<string[]>,
  run: () => Promise<void>,
): Promise<void> {
  // Interpose real rename/symlink operations between the guard's real lstat
  // and real readdir; never invent directory entries or replace lstat results.
  Object.defineProperty(fs, 'readdir', { value: async (parent: unknown, ...options: unknown[]) => {
    if (String(parent) === root && options.length === 0) return observe(() => originalReaddir(root));
    return Reflect.apply(originalReaddir, fs, [parent, ...options]);
  } });
  try { await run(); }
  finally { Object.defineProperty(fs, 'readdir', { value: originalReaddir }); }
}

test('canonical paths retain their exact bytes for read and mutation checks', async () => {
  await withFixture(async ({ file, workspace }) => {
    await assertWorkspacePathHasNoAliases(workspace, 'Verweise.md', { readOnly: true });
    await assertWorkspacePathHasNoAliases(workspace, 'Verweise.md');
    assert.deepEqual(await fs.readFile(file), contents);
  });
});

test('a configured root symlink remains supported', async () => {
  await withFixture(async ({ root, file, workspace }) => {
    const configuredRoot = path.join(root, 'configured-root');
    await fs.symlink(root, configuredRoot, 'dir');
    await assertWorkspacePathHasNoAliases({ ...workspace, rootPath: configuredRoot }, 'Verweise.md', { readOnly: true });
    assert.deepEqual(await fs.readFile(file), contents);
  });
});

test('real file and directory symlinks remain rejected for reads and mutations', async () => {
  await withFixture(async ({ root, file, workspace }) => {
    await fs.symlink('Verweise.md', path.join(root, 'alias.md'));
    await fs.symlink(root, path.join(root, 'directory-alias'), 'dir');
    for (const alias of ['alias.md', 'directory-alias/Verweise.md']) {
      for (const options of [{ readOnly: true }, {}]) {
        await assert.rejects(assertWorkspacePathHasNoAliases(workspace, alias, options), { code: 'WORKSPACE_PATH_ALIAS' });
      }
    }
    assert.deepEqual(await fs.readFile(file), contents);
  });
});

test('case-folding aliases stay rejected; distinct-case missing paths stay pristine', async (context) => {
  await withFixture(async ({ root, workspace }) => {
    const caseFolded = await fs.lstat(path.join(root, 'verweise.md')).catch(() => null);
    for (const options of [{ readOnly: true }, {}]) {
      if (caseFolded) {
        await assert.rejects(assertWorkspacePathHasNoAliases(workspace, 'verweise.md', options), { code: 'WORKSPACE_PATH_ALIAS' });
      } else {
        await assertWorkspacePathHasNoAliases(workspace, 'verweise.md', options);
        await assert.rejects(fs.lstat(path.join(root, 'verweise.md')), { code: 'ENOENT' });
      }
    }
    context.diagnostic(caseFolded ? 'Actual case-folding filesystem alias checked.' : 'Actual case-sensitive missing-name contract checked.');
  });
});

test('a read refreshes a directory observation after a canonical file disappears and returns', async () => {
  await withFixture(async ({ root, file, workspace }) => {
    let moved = false;
    await duringDirectoryObservation(root, async read => {
      if (moved) return read();
      moved = true;
      const staged = path.join(root, '.owned-transition');
      await fs.rename(file, staged);
      try { return await read(); }
      finally { await fs.rename(staged, file); }
    }, () => assertWorkspacePathHasNoAliases(workspace, 'Verweise.md', { readOnly: true }));
    assert(moved);
    assert((await fs.lstat(file)).isFile());
    assert.deepEqual(await fs.readFile(file), contents);
  });
});

test('a read refreshes a changed parent-directory observation before descending', async () => {
  await withFixture(async ({ root, workspace }) => {
    const directory = path.join(root, 'folder'), staged = path.join(root, '.owned-directory');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'note.md'), contents);
    let moved = false;
    await duringDirectoryObservation(root, async read => {
      if (moved) return read();
      moved = true;
      await fs.rename(directory, staged);
      try { return await read(); }
      finally { await fs.rename(staged, directory); }
    }, () => assertWorkspacePathHasNoAliases(workspace, 'folder/note.md', { readOnly: true }));
    assert(moved);
    assert.deepEqual(await fs.readFile(path.join(directory, 'note.md')), contents);
  });
});

test('a newly missing suffix remains missing and never becomes an alias or recreated file', async () => {
  await withFixture(async ({ root, file, workspace }) => {
    const staged = path.join(root, '.owned-removed-entry');
    let moved = false;
    await duringDirectoryObservation(root, async read => {
      if (!moved) { moved = true; await fs.rename(file, staged); }
      return read();
    }, () => assertWorkspacePathHasNoAliases(workspace, 'Verweise.md', { readOnly: true }));
    assert(moved);
    await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(staged), contents);
  });
});

test('a symlink appearing after the first observation is rejected on the fresh check', async () => {
  await withFixture(async ({ root, file, workspace }) => {
    const staged = path.join(root, '.owned-symlink-target');
    let moved = false;
    await duringDirectoryObservation(root, async read => {
      if (moved) return read();
      moved = true;
      await fs.rename(file, staged);
      const entries = await read();
      await fs.symlink('.owned-symlink-target', file);
      return entries;
    }, () => assert.rejects(assertWorkspacePathHasNoAliases(workspace, 'Verweise.md', { readOnly: true }), { code: 'WORKSPACE_PATH_ALIAS' }));
    assert(moved);
    assert((await fs.lstat(file)).isSymbolicLink());
    assert.deepEqual(await fs.readFile(staged), contents);
  });
});

test('mutation checks still reject inconsistent directory evidence without retrying a write', async () => {
  await withFixture(async ({ root, file, workspace }) => {
    await duringDirectoryObservation(root, async read => {
      const staged = path.join(root, '.owned-write-transition');
      await fs.rename(file, staged);
      try { return await read(); }
      finally { await fs.rename(staged, file); }
    }, () => assert.rejects(assertWorkspacePathHasNoAliases(workspace, 'Verweise.md'), { code: 'WORKSPACE_PATH_ALIAS' }));
    assert.deepEqual(await fs.readFile(file), contents);
  });
});

test('continuously inconsistent observations remain bounded and fail closed', async () => {
  await withFixture(async ({ root, file, workspace }) => {
    let observations = 0;
    await duringDirectoryObservation(root, async read => {
      assert(++observations <= 3, 'A read must not spin on a changing directory.');
      const staged = path.join(root, '.owned-continuous-transition');
      await fs.rename(file, staged);
      try { return await read(); }
      finally { await fs.rename(staged, file); }
    }, () => assert.rejects(assertWorkspacePathHasNoAliases(workspace, 'Verweise.md', { readOnly: true }), { code: 'WORKSPACE_PATH_ALIAS' }));
    assert.deepEqual(await fs.readFile(file), contents);
  });
});

test('read-only checks never create a missing workspace root', async () => {
  await withFixture(async ({ root, workspace }) => {
    const missingRoot = path.join(root, 'missing-root');
    await assert.rejects(assertWorkspacePathHasNoAliases({ ...workspace, rootPath: missingRoot }, 'future.md', { readOnly: true }), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(missingRoot), { code: 'ENOENT' });
  });
});

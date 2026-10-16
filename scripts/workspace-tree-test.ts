import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readWorkspaceTreePage, formatWorkspaceTreePage, WorkspaceTreeError } from '../app/lib/files/workspace-tree';

test('bounded tree pages enumerate every sibling and relative expansion reaches arbitrary depth', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-tree-pages-'));
  const scope = { workspaceId: 'tree-pages', rootPath };
  try {
    await fs.mkdir(path.join(rootPath, 'empty'));
    const deep = Array.from({ length: 18 }, (_, index) => `level-${index}`).join('/');
    await fs.mkdir(path.join(rootPath, deep), { recursive: true });
    await fs.writeFile(path.join(rootPath, deep, 'Überblick & notes.md'), '# Deep');
    await Promise.all(Array.from({ length: 601 }, (_, index) => fs.writeFile(
      path.join(rootPath, `file-${String(index).padStart(4, '0')}.md`), 'test')));
    await fs.writeFile(path.join(rootPath, '.secret'), 'hidden');
    await fs.symlink(os.tmpdir(), path.join(rootPath, 'outside'));
    let cursor: string | null = null;
    const found: string[] = [];
    do {
      const page = await readWorkspaceTreePage({ ...scope, maxDepth: 0, maxEntries: 37, cursor });
      assert.ok(page.entries.length <= 37);
      assert.equal(page.truncated_by_depth, true);
      assert.equal(page.has_more, page.next_cursor !== null);
      assert.match(formatWorkspaceTreePage(page), /file-/);
      found.push(...page.entries.map(entry => entry.path));
      cursor = page.next_cursor;
      assert.ok(!cursor || cursor.length < 2000);
    } while (cursor);
    assert.equal(found.length, 603);
    assert.equal(new Set(found).size, found.length);
    assert.ok(!found.includes('.secret') && !found.includes('outside'));
    let current = 'level-0';
    for (let index = 1; index < 18; index++) {
      const page = await readWorkspaceTreePage({ ...scope, path: current, maxDepth: 0 });
      const child = page.entries.find(entry => entry.type === 'directory');
      assert.equal(child?.children_state, 'depth_limited');
      current = child!.path;
    }
    const last = await readWorkspaceTreePage({ ...scope, path: current, maxDepth: 0 });
    assert.equal(last.entries[0].path, `${deep}/Überblick & notes.md`);
    assert.equal(last.truncated, false);
    const empty = await readWorkspaceTreePage({ ...scope, path: 'empty', maxDepth: 0 });
    assert.deepEqual(empty.directories, [{ path: 'empty', children_state: 'complete' }]);
  } finally { await fs.rm(rootPath, { recursive: true, force: true }); }
});

test('recursive continuation preserves ancestry, rejects changed listings and binds query/workspace', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-tree-cursor-'));
  const scope = { workspaceId: 'tree-cursor', rootPath };
  try {
    await fs.mkdir(path.join(rootPath, 'a', 'b'), { recursive: true });
    await fs.writeFile(path.join(rootPath, 'a', 'b', 'child.md'), '# Child');
    await fs.writeFile(path.join(rootPath, 'z.md'), '# Last');
    const first = await readWorkspaceTreePage({ ...scope, maxDepth: 2, maxEntries: 1 });
    assert.equal(first.entries[0].children_state, 'pending');
    assert.ok(first.next_cursor);
    let cursor = first.next_cursor;
    const found = [...first.entries];
    while (cursor) {
      const next = await readWorkspaceTreePage({ ...scope, maxDepth: 2, maxEntries: 1, cursor });
      found.push(...next.entries);
      cursor = next.next_cursor;
    }
    assert.deepEqual(found.map(entry => entry.path), ['a', 'a/b', 'a/b/child.md', 'z.md']);
    for (const request of [{ workspaceId: 'another' }, { path: 'a' }, { maxDepth: 1 }]) {
      await assert.rejects(readWorkspaceTreePage({ ...scope, maxDepth: 2, cursor: first.next_cursor, ...request }),
        (error: unknown) => error instanceof WorkspaceTreeError && error.code === 'INVALID_TREE_REQUEST');
    }
    await fs.writeFile(path.join(rootPath, 'new.md'), '# Changed');
    await assert.rejects(readWorkspaceTreePage({ ...scope, maxDepth: 2, cursor: first.next_cursor }),
      (error: unknown) => error instanceof WorkspaceTreeError && error.code === 'WORKSPACE_TREE_CHANGED');
    await assert.rejects(readWorkspaceTreePage({ ...scope, path: '.hidden' }));
    await assert.rejects(readWorkspaceTreePage({ ...scope, path: '../escape' }));
  } finally { await fs.rm(rootPath, { recursive: true, force: true }); }
});

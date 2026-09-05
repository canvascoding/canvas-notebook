import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addFileVisit, normalizeFileVisits, selectQuickAccessFiles, notebookFileHref } from '../app/lib/files/quick-access';
import type { FileNode } from '../app/lib/files/types';

async function main() {
  const nodes: FileNode[] = [
    { path: 'notes/a.md', name: 'a.md', type: 'file', title: 'Project plan', isFavorite: true },
    { path: 'deep/folder/b.md', name: 'b.md', type: 'file', pinnedAt: 10 },
    { path: 'new-agent-output.md', name: 'new-agent-output.md', type: 'file' },
  ];
  const visits = [
    { path: 'notes/a.md', openedAt: 10, count: 5 },
    { path: 'deep/folder/b.md', openedAt: 20, count: 1 },
    { path: 'deleted.md', openedAt: 30, count: 20 },
  ];
  assert.deepEqual(selectQuickAccessFiles(nodes, visits, 'recent').files.map((file) => file.path), ['deep/folder/b.md', 'notes/a.md']);
  assert.equal(selectQuickAccessFiles(nodes, visits, 'frequent').files[0].path, 'notes/a.md');
  assert.equal(selectQuickAccessFiles(nodes, visits, 'favorites').files[0].path, 'deep/folder/b.md');
  assert.equal(selectQuickAccessFiles(nodes, [], 'recent').total, 0, 'new/modified agent files are not personal visits');
  assert.equal(selectQuickAccessFiles(nodes, [], 'recent', 'project').files[0].path, 'notes/a.md', 'search includes custom titles');
  assert.equal(selectQuickAccessFiles(nodes, [], 'recent', 'deep/folder').total, 1, 'search includes nested paths');
  assert.equal(selectQuickAccessFiles(nodes, visits, 'all', '', 1).total, 3, 'limit retains the full matching count');
  assert.equal(selectQuickAccessFiles([], visits, 'recent').total, 0, 'history alone must never expose inaccessible files');
  assert.equal(addFileVisit(visits, 'notes/a.md', 40)[0].count, 5);
  assert.equal(addFileVisit(visits, 'notes/a.md', 90_000)[0].count, 6);
  assert.equal(normalizeFileVisits([{ path: '../escape', openedAt: 1, count: 1 }, ...visits, visits[0]]).length, 3);
  assert.equal(addFileVisit(Array.from({ length: 100 }, (_, i) => ({ path: `${i}.md`, openedAt: i + 1, count: 1 })), 'new.md').length, 100);
  const href = new URL(notebookFileHref('Notes/A & B #1.md', 'workspace & 1'), 'http://localhost');
  assert.equal(href.searchParams.get('path'), 'Notes/A & B #1.md');
  assert.equal(href.searchParams.get('workspaceId'), 'workspace & 1');

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-file-visits-'));
  process.env.CANVAS_DATA_ROOT = dataDir;
  try {
    const { recordFileVisit, readFileVisits } = await import('../app/lib/files/file-visit-storage');
    await Promise.all([
      recordFileVisit('alice', 'shared', 'first.md'),
      recordFileVisit('alice', 'shared', 'second.md'),
      recordFileVisit('bob', 'shared', 'private-history.md'),
      recordFileVisit('alice', 'other', 'other-workspace.md'),
    ]);
    assert.deepEqual(new Set((await readFileVisits('alice', 'shared')).map((visit) => visit.path)), new Set(['first.md', 'second.md']));
    assert.deepEqual((await readFileVisits('bob', 'shared')).map((visit) => visit.path), ['private-history.md']);
    assert.deepEqual((await readFileVisits('alice', 'other')).map((visit) => visit.path), ['other-workspace.md']);
    assert.deepEqual(await readFileVisits('stranger', 'shared'), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
  console.log('Quick access: selection, search, bounds, concurrent persistence and user/workspace isolation passed');
}
void main();

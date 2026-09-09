import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adoptNotebookDocumentLocation, closeNotebookDocumentTab, emptyNotebookDocumentTabsState,
  normalizeNotebookDocumentTabsState, openNotebookDocumentTab, readNotebookDocumentTabs,
  rememberNotebookDocumentId, renameNotebookDocumentTabs, writeNotebookDocumentTabs,
} from '../app/lib/notebook/document-tabs';

function fixture() {
  let state = emptyNotebookDocumentTabsState();
  for (const [path, id] of [['folder/a.md', 'doc-a'], ['folder/nested/b.md', 'doc-b'], ['outside.md', 'doc-c']]) {
    state = openNotebookDocumentTab(state, path).state;
    state = rememberNotebookDocumentId(state, path, id);
  }
  return state;
}

test('inactive identities survive opening another file, parent rename and persistence', () => {
  const state = renameNotebookDocumentTabs(fixture(), 'folder', 'renamed');
  assert.deepEqual(state, { activePath: 'outside.md', openPaths: ['renamed/a.md', 'renamed/nested/b.md', 'outside.md'],
    documentIds: { 'renamed/a.md': 'doc-a', 'renamed/nested/b.md': 'doc-b', 'outside.md': 'doc-c' } });
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } as unknown as Storage;
  writeNotebookDocumentTabs(storage, 'workspace', state);
  assert.deepEqual(readNotebookDocumentTabs(storage, 'workspace'), state);
  assert.deepEqual(readNotebookDocumentTabs(storage, 'other'), emptyNotebookDocumentTabsState());
});

test('an identity resolution renames only its current tab and cannot reopen or take over paths', () => {
  const state = fixture();
  const moved = adoptNotebookDocumentLocation(state, 'folder/a.md', 'doc-a', 'new/a.md');
  assert.equal(moved.activePath, 'outside.md');
  assert.deepEqual(moved.openPaths, ['new/a.md', 'folder/nested/b.md', 'outside.md']);
  assert.equal(moved.documentIds?.['new/a.md'], 'doc-a');
  assert.equal(adoptNotebookDocumentLocation(moved, 'folder/a.md', 'doc-a', 'late.md'), moved);
  for (const target of ['outside.md', '../escape.md', '/not-canonical.md', '']) {
    assert.equal(adoptNotebookDocumentLocation(state, 'folder/a.md', 'doc-a', target), state);
  }
  const closed = closeNotebookDocumentTab(state, 'folder/a.md');
  assert.equal(closed.documentIds?.['folder/a.md'], undefined);
  assert.equal(adoptNotebookDocumentLocation(closed, 'folder/a.md', 'doc-a', 'late.md'), closed);
  const reused = rememberNotebookDocumentId(openNotebookDocumentTab(closed, 'folder/a.md').state, 'folder/a.md', 'replacement');
  assert.equal(adoptNotebookDocumentLocation(reused, 'folder/a.md', 'doc-a', 'late.md'), reused);
});

test('a successful noncollaborative reopen removes its old identity; explicit overwrite keeps the moved identity', () => {
  const state = fixture();
  const plain = rememberNotebookDocumentId(state, 'folder/a.md', null);
  assert.equal(plain.documentIds?.['folder/a.md'], undefined);
  assert.equal(plain.documentIds?.['outside.md'], 'doc-c');
  const overwritten = renameNotebookDocumentTabs(state, 'folder/a.md', 'outside.md');
  assert.equal(overwritten.documentIds?.['outside.md'], 'doc-a');
  assert.deepEqual(overwritten.openPaths, ['outside.md', 'folder/nested/b.md']);
  const plainOverwrite = renameNotebookDocumentTabs(plain, 'folder/a.md', 'outside.md');
  assert.equal(plainOverwrite.documentIds?.['outside.md'], undefined, 'an unknown source cannot inherit the overwritten target identity');
});

test('legacy and malformed storage never invent an identity or retain closed paths', () => {
  const legacy = { activePath: 'a.md', openPaths: ['a.md'] };
  assert.deepEqual(normalizeNotebookDocumentTabsState(legacy), legacy);
  for (const documentIds of [null, [], { 'a.md': '' }, { 'a.md': ' padded ' }, { 'a.md': 'bad\0id' }, { 'closed.md': 'doc' }]) {
    assert.deepEqual(normalizeNotebookDocumentTabsState({ ...legacy, documentIds }), legacy);
  }
  const inherited = Object.create({ 'a.md': 'borrowed' });
  assert.deepEqual(normalizeNotebookDocumentTabsState({ ...legacy, documentIds: inherited }), legacy);
  const state = rememberNotebookDocumentId(legacy, 'a.md', 'doc');
  assert.deepEqual(closeNotebookDocumentTab(state, 'a.md'), emptyNotebookDocumentTabsState());
});

import assert from 'node:assert/strict';

import {
  NOTEBOOK_MAX_OPEN_DOCUMENTS,
  activateNotebookDocumentTab,
  closeNotebookDocumentTab,
  emptyNotebookDocumentTabsState,
  notebookDocumentTabsStorageKey,
  openNotebookDocumentTab,
  readNotebookDocumentTabs,
  renameNotebookDocumentTabs,
  writeNotebookDocumentTabs,
} from '../app/lib/notebook/document-tabs';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() { return values.size; },
    } satisfies Storage,
  };
}

let state = emptyNotebookDocumentTabsState();
state = openNotebookDocumentTab(state, 'one.md').state;
state = openNotebookDocumentTab(state, 'two.md').state;
state = openNotebookDocumentTab(state, 'three.md').state;
assert.deepEqual(state, {
  activePath: 'three.md',
  openPaths: ['one.md', 'two.md', 'three.md'],
});

state = activateNotebookDocumentTab(state, 'two.md');
assert.equal(state.activePath, 'two.md');
state = closeNotebookDocumentTab(state, 'two.md');
assert.equal(state.activePath, 'three.md', 'closing the active tab should prefer its right neighbor');
state = closeNotebookDocumentTab(state, 'three.md');
assert.equal(state.activePath, 'one.md', 'the left neighbor should be used when there is no right neighbor');

let limitedState = emptyNotebookDocumentTabsState();
for (let index = 0; index < NOTEBOOK_MAX_OPEN_DOCUMENTS; index += 1) {
  limitedState = openNotebookDocumentTab(limitedState, `doc-${index}.md`).state;
}
const limitedResult = openNotebookDocumentTab(limitedState, 'one-too-many.md');
assert.equal(limitedResult.status, 'limit-reached');
assert.equal(limitedResult.state, limitedState, 'the limit must never evict a background document');

const renamed = renameNotebookDocumentTabs({
  activePath: 'notes/daily/today.md',
  openPaths: ['notes/daily/today.md', 'notes/index.md'],
}, 'notes', 'archive/notes');
assert.deepEqual(renamed, {
  activePath: 'archive/notes/daily/today.md',
  openPaths: ['archive/notes/daily/today.md', 'archive/notes/index.md'],
});

const { storage, values } = memoryStorage();
writeNotebookDocumentTabs(storage, 'workspace-a', renamed);
assert.deepEqual(readNotebookDocumentTabs(storage, 'workspace-a'), renamed);
assert.equal(values.has(notebookDocumentTabsStorageKey('workspace-a')), true);

values.set('canvas.notebookOpenFilePath:workspace-legacy', 'legacy/readme.md');
assert.deepEqual(readNotebookDocumentTabs(storage, 'workspace-legacy'), {
  activePath: 'legacy/readme.md',
  openPaths: ['legacy/readme.md'],
});

console.log('notebook-document-tabs-test: ok');

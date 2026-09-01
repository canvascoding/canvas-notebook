import assert from 'node:assert/strict';

import {
  NOTEBOOK_MAX_OPEN_DOCUMENTS,
  closeNotebookDocumentTabsAtPaths,
  activateNotebookDocumentTab,
  closeNotebookDocumentTab,
  emptyNotebookDocumentTabsState,
  notebookDocumentTabsStorageKey,
  openNotebookDocumentTab,
  readNotebookDocumentTabs,
  renameNotebookDocumentTabs,
  writeNotebookDocumentTabs,
} from '../app/lib/notebook/document-tabs';
import { getNotebookTabRevealDelta } from '../app/lib/notebook/tab-strip';

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

const closedAfterExternalMove = closeNotebookDocumentTabsAtPaths({
  activePath: 'project/brief.md',
  openPaths: ['notes/today.md', 'project/brief.md', 'project/assets/spec.md'],
}, ['project']);
assert.deepEqual(closedAfterExternalMove, {
  activePath: 'notes/today.md',
  openPaths: ['notes/today.md'],
}, 'an externally moved folder must close every affected document tab');

let limitedState = emptyNotebookDocumentTabsState();
for (let index = 0; index < NOTEBOOK_MAX_OPEN_DOCUMENTS; index += 1) {
  limitedState = openNotebookDocumentTab(limitedState, `doc-${index}.md`).state;
}
const limitedResult = openNotebookDocumentTab(limitedState, 'one-too-many.md');
assert.equal(limitedResult.status, 'opened');
assert.deepEqual(limitedResult.state, {
  activePath: 'one-too-many.md',
  openPaths: [
    'doc-1.md',
    'doc-2.md',
    'doc-3.md',
    'doc-4.md',
    'doc-5.md',
    'doc-6.md',
    'doc-7.md',
    'one-too-many.md',
  ],
}, 'opening a ninth document must evict the oldest background document');

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

assert.equal(
  getNotebookTabRevealDelta({ left: 0, right: 320 }, { left: 80, right: 200 }),
  0,
);
assert.equal(
  getNotebookTabRevealDelta({ left: 0, right: 320 }, { left: -24, right: 96 }),
  -32,
);
assert.equal(
  getNotebookTabRevealDelta({ left: 0, right: 320 }, { left: 280, right: 380 }),
  68,
);

console.log('notebook-document-tabs-test: ok');

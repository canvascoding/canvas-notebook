import assert from 'node:assert/strict';
import { closeAllNotebookDocuments, notebookLocationAfterClosing } from '../app/lib/notebook/close-documents';
import {
  emptyNotebookDocumentTabsState, rememberNotebookClosedDocuments,
  writeNotebookDocumentTabs, readNotebookDocumentTabs, type NotebookDocumentTabsState,
} from '../app/lib/notebook/document-tabs';
import { registerDocumentTransitionGuard } from '../app/lib/files/document-transition';
import { useFileStore } from '../app/store/file-store';
import { useEditorStore } from '../app/store/editor-store';
import { useWorkspaceStore } from '../app/store/workspace-store';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const paths = Array.from({ length: 100 }, (_, index) => `doc-${index}.md`);
let tabs: NotebookDocumentTabsState;
let history: string[];
let commits = 0;
const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
} as Storage;

function setup() {
  useWorkspaceStore.setState({ activeWorkspaceId: 'a' });
  useFileStore.getState().resetWorkspaceView('a');
  useFileStore.setState({ currentFile: { path: paths[37], content: 'base' }, currentFileWorkspaceId: 'a' });
  useEditorStore.getState().setActiveFile(paths[37], 'base');
  tabs = { openPaths: [...paths], activePath: paths[37] };
  history = [];
  commits = 0;
  writeNotebookDocumentTabs(storage, 'a', tabs);
}

function close() {
  return closeAllNotebookDocuments({
    workspaceId: 'a', getTabs: () => tabs,
    onClosed: (snapshot) => {
      commits += 1;
      history = rememberNotebookClosedDocuments(history, snapshot.openPaths, snapshot.activePath);
      tabs = emptyNotebookDocumentTabsState();
      writeNotebookDocumentTabs(storage, 'a', tabs);
    },
  });
}

async function main() {
  const originalFetch = globalThis.fetch;
  try {
    setup();
    useEditorStore.getState().updateDraft('saved draft');
    let saves = 0;
    globalThis.fetch = (async (_input, init) => {
      saves += 1;
      assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), 'a');
      return Response.json({ data: { path: paths[37] } });
    }) as typeof fetch;
    assert.equal(await close(), true);
    assert.equal(saves, 1, 'only the loaded editor needs saving; closing must not load 99 neighboring tabs');
    assert.equal(commits, 1);
    assert.deepEqual(tabs, emptyNotebookDocumentTabsState());
    assert.deepEqual(readNotebookDocumentTabs(storage, 'a'), tabs, 'closed tabs stay closed after restoring storage');
    assert.equal(useFileStore.getState().currentFile, null);
    assert.equal(useEditorStore.getState().isDirty, false);
    assert.equal(history.length, 100);
    assert.equal(history.at(-1), paths[37], 'reopen restores the previously active document first');
    assert.equal(new Set(history).size, 100);
    assert.equal(rememberNotebookClosedDocuments(history, [paths[37]]).length, 100);

    setup();
    useEditorStore.getState().updateDraft('keep on failure');
    const originalTabs = tabs;
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    await assert.rejects(close(), /offline/);
    assert.equal(tabs, originalTabs);
    assert.equal(commits, 0);
    assert.equal(useEditorStore.getState().draft, 'keep on failure');

    setup();
    let pending = deferred();
    let unregister = registerDocumentTransitionGuard('a', paths[37], {
      hasPendingChanges: () => true, prepare: () => pending.promise,
    });
    const changedTabsClose = close();
    tabs = { ...tabs, openPaths: [...tabs.openPaths.slice(1), 'new.md'] };
    const changedTabs = tabs;
    pending.resolve();
    assert.equal(await changedTabsClose, false);
    assert.equal(tabs, changedTabs);
    assert.equal(commits, 0);
    assert.equal(useFileStore.getState().currentFile?.path, paths[37], 'an invalid batch must not clear the current editor');
    unregister();

    setup();
    pending = deferred();
    unregister = registerDocumentTransitionGuard('a', paths[37], {
      hasPendingChanges: () => true, prepare: () => pending.promise,
    });
    const newerOpenClose = close();
    useFileStore.setState({ openFileRequestId: useFileStore.getState().openFileRequestId + 1 });
    pending.resolve();
    assert.equal(await newerOpenClose, false, 'a newer open of even the same path supersedes closing');
    assert.equal(commits, 0);
    assert.equal(useFileStore.getState().currentFile?.path, paths[37]);
    unregister();

    setup();
    pending = deferred();
    unregister = registerDocumentTransitionGuard('a', paths[37], {
      hasPendingChanges: () => true, prepare: () => pending.promise,
    });
    const oldWorkspaceClose = close();
    useWorkspaceStore.setState({ activeWorkspaceId: 'b' });
    useFileStore.getState().resetWorkspaceView('b');
    useFileStore.setState({ currentFile: { path: 'other.md', content: 'other' }, currentFileWorkspaceId: 'b' });
    useEditorStore.getState().setActiveFile('other.md', 'other');
    pending.resolve();
    await assert.rejects(oldWorkspaceClose, /document changed/);
    assert.equal(commits, 0);
    assert.equal(useFileStore.getState().currentFile?.path, 'other.md');
    unregister();

    setup();
    unregister = registerDocumentTransitionGuard('a', paths[37], {
      hasPendingChanges: () => true, prepare: async () => { throw new Error('recovery blocked'); },
    });
    await assert.rejects(close(), /recovery blocked/);
    assert.equal(tabs.openPaths.length, 100);
    assert.equal(commits, 0);
    unregister();

    setup();
    tabs = { openPaths: ['report.docx', ...paths.slice(1)], activePath: 'report.docx' };
    useFileStore.setState({ currentFile: { path: 'report.docx', content: '' }, currentFileWorkspaceId: 'a' });
    useEditorStore.getState().setActiveFile('report.docx', '');
    useEditorStore.getState().updateDraft('binary editors must use their own save protocol');
    await assert.rejects(close(), /editor is still connecting/, 'DOCX must stay open until its save guard is ready');
    assert.equal(commits, 0);
    assert.equal(tabs.openPaths.length, 100);
    let docxPrepared = false;
    globalThis.fetch = (async () => { throw new Error('DOCX must not use the text save path'); }) as typeof fetch;
    unregister = registerDocumentTransitionGuard('a', 'report.docx', {
      hasPendingChanges: () => true, prepare: async () => { docxPrepared = true; },
    });
    assert.equal(await close(), true);
    assert.equal(docxPrepared, true);
    assert.equal(commits, 1);
    assert.equal(history.at(-1), 'report.docx');
    unregister();

    setup();
    useFileStore.getState().clearCurrentFile();
    assert.equal(await close(), true, 'a missing or unavailable preview can still be closed');
    setup();
    tabs = emptyNotebookDocumentTabsState();
    assert.equal(await close(), false);
    assert.equal(commits, 0);

    assert.equal(notebookLocationAfterClosing('https://example.test/de/notebook?path=doc-37.md&workspaceId=a&session=s#anchor', 'a', paths), '/de/notebook?workspaceId=a&session=s#anchor');
    assert.equal(notebookLocationAfterClosing('https://example.test/notebook?path=doc-37.md&workspaceId=b', 'a', paths), '/notebook?path=doc-37.md&workspaceId=b');
    assert.equal(notebookLocationAfterClosing('https://example.test/notebook?path=new.md', 'a', paths), '/notebook?path=new.md');
    console.log('notebook-close-all-test: ok');
  } finally {
    globalThis.fetch = originalFetch;
  }
}
void main();

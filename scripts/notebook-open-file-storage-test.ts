import assert from 'node:assert/strict';
import {
  clearLegacyStoredNotebookOpenFilePath,
  clearStoredNotebookOpenFilePath,
  notebookOpenFileStorageKey,
  normalizeNotebookFilePath,
  readStoredNotebookOpenFilePath,
  writeStoredNotebookOpenFilePath,
} from '../app/lib/files/notebook-open-file-storage';
import { normalizeWorkspacePathParam } from '../app/lib/files/path-utils';

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
  clear: () => values.clear(),
  key: (index: number) => Array.from(values.keys())[index] ?? null,
  get length() { return values.size; },
} satisfies Storage;

assert.equal(normalizeNotebookFilePath('./campaign/brief.md/'), 'campaign/brief.md');
assert.equal(normalizeNotebookFilePath('  '), null);
for (const exact of [' leading.md', 'folder/ leading.MARKDOWN']) {
  assert.equal(normalizeWorkspacePathParam(exact), exact);
  assert.equal(normalizeNotebookFilePath(exact), exact);
  writeStoredNotebookOpenFilePath(storage, 'workspace-exact', exact);
  assert.equal(readStoredNotebookOpenFilePath(storage, 'workspace-exact'), exact);
}
for (const [input, expected] of [[' office.docx ', 'office.docx'], [' notes.md ', 'notes.md'],
  ['folder\\office.docx', 'folder/office.docx']]) {
  assert.equal(normalizeWorkspacePathParam(input), expected, 'legacy noncanonical and Office aliases retain their normalization');
}
assert.equal(normalizeNotebookFilePath(' office.docx '), 'office.docx');
for (const invalid of ['../outside.md', 'folder/../outside.md', 'bad\0name.md']) {
  assert.equal(normalizeWorkspacePathParam(invalid), null);
}

writeStoredNotebookOpenFilePath(storage, 'workspace-marketing', './campaign/brief.md');
writeStoredNotebookOpenFilePath(storage, 'workspace-personal', 'notes/private.md');

assert.equal(
  readStoredNotebookOpenFilePath(storage, 'workspace-marketing'),
  'campaign/brief.md',
  'the marketing workspace should restore only its own open file',
);
assert.equal(
  readStoredNotebookOpenFilePath(storage, 'workspace-personal'),
  'notes/private.md',
  'the personal workspace should restore only its own open file',
);

values.set('canvas.notebookOpenFilePath', 'campaign/legacy.md');
assert.equal(
  readStoredNotebookOpenFilePath(storage, 'workspace-new'),
  null,
  'an unscoped legacy path must never leak into another workspace',
);
clearLegacyStoredNotebookOpenFilePath(storage);
assert.equal(values.has('canvas.notebookOpenFilePath'), false);

clearStoredNotebookOpenFilePath(storage, 'workspace-marketing');
assert.equal(readStoredNotebookOpenFilePath(storage, 'workspace-marketing'), null);
assert.equal(readStoredNotebookOpenFilePath(storage, 'workspace-personal'), 'notes/private.md');
assert.equal(
  notebookOpenFileStorageKey('workspace-personal'),
  'canvas.notebookOpenFilePath:workspace-personal',
);

console.log('notebook-open-file-storage-test: ok');

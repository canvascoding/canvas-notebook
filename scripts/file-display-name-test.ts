import assert from 'node:assert/strict';
import { getFileDisplayName } from '../app/lib/files/display-name';

assert.equal(getFileDisplayName({ name: 'Notebook.md', type: 'file' }), 'Notebook');
assert.equal(getFileDisplayName({ name: 'README.MD', type: 'file' }), 'README');
assert.equal(getFileDisplayName({ name: 'ReleaseNotes.mdx', type: 'file' }), 'ReleaseNotes');
assert.equal(getFileDisplayName({ name: 'Longform.markdown', type: 'file' }), 'Longform');
assert.equal(getFileDisplayName({ name: 'notes.txt', type: 'file' }), 'notes.txt');
assert.equal(getFileDisplayName({ name: 'docs.md', type: 'directory' }), 'docs.md');
assert.equal(getFileDisplayName({ name: '.md', type: 'file' }), '.md');

console.log('file-display-name-test: ok');

import assert from 'node:assert/strict';

import { getFileFormat, getFileTitle } from '../app/lib/files/metadata';

assert.equal(getFileTitle({ name: 'Project plan.md', type: 'file' }), 'Project plan');
assert.equal(getFileTitle({ name: 'Project plan.md', type: 'file', title: 'Quarterly plan' }), 'Quarterly plan');
assert.equal(getFileFormat({ name: 'report.pdf', type: 'file' }), 'PDF document (.pdf)');
assert.equal(getFileFormat({ name: 'archive', type: 'file' }), 'File');
assert.equal(getFileFormat({ name: 'Assets', type: 'directory' }), 'Folder');

console.log('File metadata format tests passed');

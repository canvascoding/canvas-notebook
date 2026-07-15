import assert from 'node:assert/strict';
import {
  WORKSPACE_FILE_DRAG_TYPE,
  decodeWorkspaceFileDrag,
  encodeWorkspaceFileDrag,
  getWorkspaceFileDragPaths,
  hasWorkspaceFileDragType,
  validateWorkspaceFileDrop,
} from '../app/lib/files/file-drag';

const encoded = encodeWorkspaceFileDrag({
  workspaceId: 'workspace-a',
  paths: ['docs', 'docs/nested.md', 'readme.md'],
});
assert.deepEqual(decodeWorkspaceFileDrag(encoded), {
  workspaceId: 'workspace-a',
  paths: ['docs', 'readme.md'],
});
assert.equal(decodeWorkspaceFileDrag('{broken'), null);
assert.equal(hasWorkspaceFileDragType(['Files', WORKSPACE_FILE_DRAG_TYPE]), true);
assert.equal(hasWorkspaceFileDragType(['Files']), false);

assert.deepEqual(
  getWorkspaceFileDragPaths('docs/a.md', ['docs/a.md', 'docs/b.md']),
  ['docs/a.md', 'docs/b.md'],
  'dragging a selected item should carry the complete selection',
);
assert.deepEqual(
  getWorkspaceFileDragPaths('docs/c.md', ['docs/a.md', 'docs/b.md']),
  ['docs/c.md'],
  'dragging an unselected item should carry only that item',
);

assert.deepEqual(validateWorkspaceFileDrop(['docs/a.md'], 'archive'), { valid: true });
assert.deepEqual(
  validateWorkspaceFileDrop(['docs/a.md'], 'docs'),
  { valid: false, reason: 'same-location' },
);
assert.deepEqual(
  validateWorkspaceFileDrop(['docs'], 'docs/nested'),
  { valid: false, reason: 'move-into-self' },
);

console.log('file-drag-move-test: ok');

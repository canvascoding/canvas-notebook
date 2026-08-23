import assert from 'node:assert/strict';

import {
  buildTodoFileNotebookHref,
  getTodoFileFallbackTitle,
  getTodoFileMetadataTitle,
} from '../app/lib/todos/file-link-display';

assert.equal(getTodoFileFallbackTitle('08_operations/admin/gtin-marketplace-overview.md'), 'gtin-marketplace-overview');
assert.equal(getTodoFileFallbackTitle('brief.pdf'), 'brief');
assert.equal(getTodoFileFallbackTitle('.env'), '.env');
assert.equal(getTodoFileMetadataTitle('---\ntitle: Marketplace Rollout\n---\n# Draft'), 'Marketplace Rollout');
assert.equal(getTodoFileMetadataTitle('# Draft'), null);
assert.equal(
  buildTodoFileNotebookHref({ path: 'notes/Plan A.md', workspaceId: 'workspace-123' }),
  '/notebook?path=notes%2FPlan+A.md&workspaceId=workspace-123',
);

console.log('Todo file link display tests passed.');

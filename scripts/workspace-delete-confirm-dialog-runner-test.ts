import { test } from 'node:test';
import { workspaceDeleteConfirmDialogTest } from './workspace-delete-confirm-dialog-test';

test('actual DeleteConfirmDialog asynchronous preview and binding', { timeout: 20_000 }, workspaceDeleteConfirmDialogTest);

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceFileLinkHref, matchesWorkspaceFileLinkIdentity } from '../app/lib/files/file-link-target';
import { getNotebookNavigationIntent } from '../app/lib/chat/chat-navigation-intent';
import { resolveNotebookEntry } from '../app/lib/notebook/notebook-entry';
import { safeAppReturnTo, localizedAppReturnTo } from '../app/lib/auth/return-to';
import { clearWorkspaceScopedNavigationParams } from '../app/lib/workspaces/navigation-sync';
import { notebookLocationAfterClosing } from '../app/lib/notebook/close-documents';

test('file identity and encoded paths survive the normal login return and workspace cleanup', () => {
  const target = { workspaceId: 'workspace-1', path: 'Notizen/Überblick & Plan.md', documentId: 'doc-1', lineageId: 'lineage-1' };
  const href = workspaceFileLinkHref(target);
  assert.equal(safeAppReturnTo(href), href);
  const localized = localizedAppReturnTo(href, 'de');
  const url = new URL(localized, 'https://canvas.test');
  const intent = getNotebookNavigationIntent(url.searchParams);
  assert.equal(intent.path, target.path);
  assert.equal(intent.documentId, target.documentId);
  assert.equal(intent.lineageId, target.lineageId);
  assert.equal(intent.workspaceId, target.workspaceId);
  assert.equal(clearWorkspaceScopedNavigationParams(url.search), '');
  const closed = new URL(notebookLocationAfterClosing(url.href, 'workspace-1', [target.path]), url.origin);
  assert.equal(closed.searchParams.has('documentId'), false);
  assert.equal(closed.searchParams.has('lineageId'), false);
  assert.equal(closed.searchParams.has('path'), false);
  const identityOnly = getNotebookNavigationIntent(new URLSearchParams('workspaceId=workspace-1&documentId=doc-1'));
  assert.deepEqual(resolveNotebookEntry({ intent: identityOnly, workspaceId: 'workspace-1', workspaceReady: true,
    hasInitialPrompt: false, restoredPath: 'different.md' }), { kind: 'document', path: '', revealChat: false });
});

test('loading and already-open reuse require the exact document and binary lineage identities', () => {
  const file = { collaboration: { document: { id: 'doc-1' }, lineageId: 'lineage-1' } };
  assert.equal(matchesWorkspaceFileLinkIdentity(file, { expectedDocumentId: 'doc-1', expectedLineageId: 'lineage-1' }), true);
  assert.equal(matchesWorkspaceFileLinkIdentity(file, { expectedDocumentId: 'replacement' }), false);
  assert.equal(matchesWorkspaceFileLinkIdentity(file, { expectedLineageId: 'replacement' }), false);
  assert.equal(matchesWorkspaceFileLinkIdentity({ collaboration: { lineageId: 'binary-1' } }, { expectedLineageId: 'binary-1' }), true);
  assert.equal(matchesWorkspaceFileLinkIdentity(null, { expectedLineageId: 'binary-1' }), false);
  assert.equal(matchesWorkspaceFileLinkIdentity(null, {}), true);
});

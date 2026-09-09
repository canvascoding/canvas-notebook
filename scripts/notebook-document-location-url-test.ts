import assert from 'node:assert/strict';
import { notebookUrlAfterDocumentMove } from '../app/lib/notebook/document-location-url';
import type { NotebookDocumentTabsState } from '../app/lib/notebook/document-tabs';

const before: NotebookDocumentTabsState = { activePath: 'other.md', openPaths: ['old/b.md', 'other.md'],
  documentIds: { 'old/b.md': 'document-b', 'other.md': 'document-other' } };
const after: NotebookDocumentTabsState = { activePath: 'other.md', openPaths: ['new/b.md', 'other.md'],
  documentIds: { 'new/b.md': 'document-b', 'other.md': 'document-other' } };
const href = 'https://canvas.test/de/notebook?path=old%2Fb.md&workspaceId=workspace&session=session&chat=open#block';
const moved = notebookUrlAfterDocumentMove(href, 'workspace', before, after)!;
assert.deepEqual(moved, { href: '/de/notebook?path=new%2Fb.md&workspaceId=workspace&session=session&chat=open#block',
  previousPath: 'old/b.md', path: 'new/b.md' });
assert.equal(notebookUrlAfterDocumentMove(href, 'another-workspace', before, after), null);
assert.equal(notebookUrlAfterDocumentMove(href.replace('old%2Fb.md', 'unknown.md'), 'workspace', before, after), null);
assert.equal(notebookUrlAfterDocumentMove(href, 'workspace', before, before), null);
assert.equal(notebookUrlAfterDocumentMove(href, 'workspace', { ...before, documentIds: {} }, after), null);
assert.equal(notebookUrlAfterDocumentMove(href, 'workspace', before, { ...after, documentIds: {} }), null);
assert.equal(notebookUrlAfterDocumentMove(href, 'workspace', before, {
  ...after, openPaths: ['new/b.md', 'duplicate.md'], documentIds: { 'new/b.md': 'document-b', 'duplicate.md': 'document-b' },
}), null);
assert.equal(notebookUrlAfterDocumentMove(href.replace('&workspaceId=workspace', ''), 'workspace', before, after)?.path, 'new/b.md');
assert.equal(notebookUrlAfterDocumentMove('https://canvas.test/notebook?chat=open', 'workspace', before, after), null);
console.log('Notebook document URL identity: confirmed move, workspace boundary, unknown/closed/duplicate targets and navigation parameters passed.');

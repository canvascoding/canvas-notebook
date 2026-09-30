import assert from 'node:assert/strict';
import { summarizeFileChanges } from '../app/lib/chat/file-change-summary';
import type { ChatFileReference } from '../app/lib/chat/tool-file-references';
import type { FileChangeAppData } from '../app/lib/tool-apps/file-change-data';
import { FILE_CHANGE_APP_URI, type BuiltinToolAppDescriptor } from '../app/lib/tool-apps/types';

const reference = (toolCallId: string, kind: ChatFileReference['kind'] = 'changed'): ChatFileReference => ({
  workspaceId: 'workspace-a', path: 'report.md', kind, toolCallId,
});
const group = (id: string, state: FileChangeAppData['entries'][number]['state'], operationId = `operation-${id}`): FileChangeAppData => ({
  contractVersion: 1, id, workspaceId: 'workspace-a', operation: 'write', status: state,
  createdAt: '2026-09-30T10:00:00.000Z',
  entries: [{ id: `entry-${id}`, ordinal: 0, pathHint: 'report.md', state, operationId, revisionId: null, additions: 5, deletions: 2 }],
});
const app = (entityId: string, toolCallId: string): BuiltinToolAppDescriptor => ({
  kind: 'builtin', version: 1, resourceUri: FILE_CHANGE_APP_URI, operation: 'write', entityId, toolCallId,
});
const references = [reference('review', 'review_required'), reference('applied')];
const apps = [app('first', 'review'), app('second', 'applied')];
const rows = summarizeFileChanges(references, [group('first', 'review_required'), group('second', 'applied')], apps, 'ready');
assert.equal(rows.length, 1);
assert.equal(rows[0].status, 'review_required', 'an earlier outstanding review survives a later applied edit');
assert.deepEqual(rows[0].changes.map(change => change.groupId), ['first', 'second']);
assert.equal(rows[0].additions, undefined, 'repeated edits must not inflate or imply a net diff');
const conflict = summarizeFileChanges(references, [group('first', 'conflict'), group('second', 'review_required')], apps, 'ready');
assert.equal(conflict[0].status, 'conflict');
const retriedOlder = summarizeFileChanges([reference('applied')],
  [group('second', 'applied'), group('first', 'rejected')], apps, 'ready');
assert.equal(retriedOlder[0].status, 'applied', 'a retried older group must not become the latest state');
assert.equal(retriedOlder[0].changes[0].groupId, 'second', 'the review action still selects the latest operation');
const partial = summarizeFileChanges(references, [group('second', 'applied')], apps, 'error');
assert.equal(partial[0].status, 'unavailable', 'a missing earlier operation prevents a fully current applied claim');
assert.equal(partial[0].changes.length, 1, 'available operations remain reviewable');
assert.equal(partial[0].additions, undefined);
const withBoundReferences = summarizeFileChanges([reference('applied'), ...references], [group('second', 'applied')], apps, 'error');
assert.equal(withBoundReferences.length, 1, 'deduped display receipts and per-operation receipts still render one row');
assert.equal(withBoundReferences[0].status, 'unavailable', 'missing earlier proposal remains attributable after display deduplication');
const loading = summarizeFileChanges(references, [], apps, 'loading');
assert.equal(loading[0].status, 'loading');
const duplicate = summarizeFileChanges(references, [group('first', 'applied', 'same'), group('second', 'applied', 'same')], apps, 'ready');
assert.equal(duplicate[0].changes.length, 1);
assert.equal(duplicate[0].additions, 5);
assert.equal(duplicate[0].deletions, 2);
const readThenWrite = summarizeFileChanges([reference('read', 'read')], [group('first', 'applied')], [apps[0]], 'ready');
assert.equal(readThenWrite[0].reference.kind, 'changed');
const legacy = summarizeFileChanges([reference('legacy'), reference('legacy2')], [], [], 'ready');
assert.equal(legacy.length, 1);
assert.equal(legacy[0].status, undefined, 'legacy references keep their original status without a new authorization request');
console.log('file change summary tests passed');

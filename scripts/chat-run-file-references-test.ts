import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ChatMessage } from '../app/lib/chat/types';
import type { ChatFileReference, ChatFileReferenceKind } from '../app/lib/chat/tool-file-references';
import { buildRunFileReferenceProjection } from '../app/lib/chat/run-file-references';
import { fileChangeToolApp } from '../app/lib/tool-apps/types';
import type { FileChangeGroupV1 } from '../app/lib/file-version-center/contracts/v1';

const user = (id: string): ChatMessage => ({ id, role: 'user', content: id, status: 'sent', piMessage: { role: 'user', content: id, timestamp: Number(id) } as AgentMessage });
const answer = (id = 'answer'): ChatMessage => ({ id, role: 'assistant', content: 'Done. Example: `example/fake.pdf`.', status: 'sent' });
const tool = (id: string, paths: string[], kind: ChatFileReferenceKind = 'read', options: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role: 'toolResult', content: '', status: 'sent', toolName: kind === 'read' ? 'read' : 'write', toolCallId: id,
  piMessage: { role: 'toolResult', toolName: kind === 'read' ? 'read' : 'write', toolCallId: id, isError: false, timestamp: 10,
    content: [], details: { chatFileReferences: { version: 1,
      references: paths.map(path => ({ path, kind, workspaceId: 'ws-a', toolCallId: id } satisfies ChatFileReference)) } },
  } as AgentMessage, ...options,
});
const project = (messages: ChatMessage[], active = false) => buildRunFileReferenceProjection(messages, 'ws-a', active);

const output = tool('write', ['report.md'], 'created');
const messages = [user('1'), tool('read', ['report.md']), output, tool('edit', ['report.md'], 'changed'), tool('read-again', ['report.md']), answer()];
const group = project(messages).get('answer')!;
assert.equal(group.references.length, 1);
assert.equal(group.references[0].kind, 'created', 'editing a new result still leaves it identified as created');
assert.equal(group.references[0].path, 'report.md');
assert.equal(project([user('1'), answer()]).size, 0, 'prose/code examples are never discovered');
assert.equal(project(messages, true).size, 0, 'unfinished run does not shuffle a growing result section');
assert.equal(buildRunFileReferenceProjection(messages, 'ws-b').size, 0, 'metadata cannot cross workspace scope');
assert.equal(buildRunFileReferenceProjection(messages, null).size, 0);
assert.equal(project([user('1'), output]).get('write')?.references.length, 1, 'interrupted run retains completed files');
assert.equal(project([user('1'), output, tool('pending', ['future.md'], 'created', { status: 'sending', type: 'tool_use' })]).get('pending')?.references.length, 1);
assert.equal(project([user('1'), output, answer('first'), user('2'), answer('second')]).has('second'), false);
assert.equal(project([user('1'), output, answer('first'), user('2'), tool('new', ['report.md']), answer('second')]).size, 2);
assert.equal(project([user('1'), output, answer('first'), user('2'), answer('second')], true).has('first'), true, 'new active run keeps prior result lists');
assert.equal(project([user('1'), output, tool('write', ['later.md'], 'changed'), answer()]).get('answer')?.references[0].path, 'later.md', 'replayed receipt replaces same tool call');
for (const rejected of [
  tool('error', ['failure.md'], 'read', { status: 'error' }),
  tool('search', ['found.md'], 'read', { toolName: 'search_workspace' }),
  tool('mismatch', ['wrong.md'], 'read', { toolCallId: 'different' }),
  tool('pending', ['future.md'], 'created', { status: 'sending' }),
]) assert.equal(project([user('1'), rejected, answer()]).size, 0);
const failed = tool('failed', ['failure.md']);
(failed.piMessage as { isError: boolean }).isError = true;
assert.equal(project([user('1'), failed, answer()]).size, 0);
const review = project([user('1'), tool('review', ['proposed.md'], 'review_required'), answer()]);
assert.equal(review.get('answer')?.references[0].kind, 'review_required');
const legacy = tool('legacy', []);
(legacy.piMessage as { details: unknown }).details = { type: 'text', filePath: 'old.md' };
assert.equal(project([user('1'), legacy, answer()]).get('answer')?.references[0].path, 'old.md');
(legacy.piMessage as { details: unknown }).details = { type: 'binary', filePath: 'old.odt' };
assert.equal(project([user('1'), legacy, answer()]).size, 0);
const many = tool('many', Array.from({ length: 35 }, (_, i) => `docs/${i}.md`), 'changed');
assert.equal(project([user('1'), many, answer()]).get('answer')?.references.length, 35);
assert.equal(project(messages).get('answer')?.key, project(messages.map(message => ({ ...message, id: `${message.id}-saved` }))).get('answer-saved')?.key, 'run keys survive DB id hydration');
assert.equal(project(messages).get('answer')?.key, project(messages.slice(3)).get('answer')?.key, 'loading earlier tools and the originating user preserves the same run key');

function changeReceipt(id: string, path: string, options: Partial<FileChangeGroupV1> = {}): ChatMessage {
  const changeGroup: FileChangeGroupV1 = {
    contractVersion: 1, id: `fvcg-${id.charCodeAt(0).toString(16).padStart(2, '0').repeat(32)}`,
    workspaceId: 'ws-a', sourceSessionId: 'session-1', toolCallId: id, operation: 'edit_file',
    status: 'applied', createdAt: '2026-09-30T10:00:00.000Z',
    entries: [{ id: `entry-${id}`, ordinal: 0, lineageId: 'lineage-1', revisionId: `revision-${id}`,
      pathHint: path, outcome: 'applied', additions: 2, deletions: 1 }], ...options,
  };
  return { id, role: 'toolResult', toolCallId: id, toolName: changeGroup.operation, status: 'sent', content: '',
    piMessage: { role: 'toolResult', toolName: changeGroup.operation, toolCallId: id, timestamp: 11,
      content: [], isError: false, details: { changeGroup, toolApp: fileChangeToolApp(changeGroup) } } as AgentMessage };
}
const boundOne = changeReceipt('a', 'docs/one.md');
const boundTwo = changeReceipt('b', 'docs/two.md');
const boundAgain = changeReceipt('c', 'docs/one.md');
const boundMessages = [user('1'), boundOne, answer('round-one'), boundTwo, boundAgain, answer('final')];
const boundSummary = project(boundMessages).get('final')!;
assert.equal(project(boundMessages).size, 1, 'all tool rounds share one summary');
assert.deepEqual(boundSummary.references.map(reference => reference.path), ['docs/one.md', 'docs/two.md']);
assert.equal(boundSummary.changeApps.length, 3, 'deduplicated file rows retain every original change binding');
assert.equal(boundSummary.changeReferences.length, 3, 'each binding retains its path for partial current-state reads');
assert.equal(project(boundMessages, true).size, 0, 'no change summary before the run ends');
for (const status of ['queued_steering', 'queued_follow_up', 'pending', 'aborting', 'error'] as const) {
  const queuedUser = { ...user('2'), status };
  assert.equal(project([user('1'), boundOne, queuedUser], true).size, 0,
    `${status} composer messages must not flush an active response`);
  assert.equal(project([user('1'), boundOne, queuedUser, boundTwo, answer()]).size, 1,
    `${status} composer messages must not split the completed summary`);
}
assert.equal(project([...boundMessages, user('2'), boundOne, answer('next')]).size, 2);
assert.equal(project([user('1'), boundOne]).get('a')?.changeApps.length, 1, 'interruption retains completed bindings');
assert.equal(project([user('1'), boundOne, { ...boundOne, id: 'saved' }, answer()]).get('answer')?.changeApps.length, 1);
assert.equal(project([user('1'), changeReceipt('d', 'foreign.md', { workspaceId: 'foreign' }), answer()]).size, 0);
const forgedBinding = structuredClone(boundOne);
(forgedBinding.piMessage as { details: { toolApp: { toolCallId: string } } }).details.toolApp.toolCallId = 'forged';
assert.equal(project([user('1'), forgedBinding, answer()]).size, 0);
const reviewThenApplied = project([user('1'), tool('review', ['docs/one.md'], 'review_required'), boundAgain, answer()]).get('answer')!;
assert.equal(reviewThenApplied.references[0].kind, 'review_required', 'later writes cannot hide unresolved legacy reviews');
assert.deepEqual(group.changeApps, [], 'legacy references need no synthetic group');
console.log('chat-run-file-references-test: ok');

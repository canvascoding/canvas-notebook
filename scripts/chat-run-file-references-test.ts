import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ChatMessage } from '../app/lib/chat/types';
import type { ChatFileReference, ChatFileReferenceKind } from '../app/lib/chat/tool-file-references';
import { buildRunFileReferenceProjection } from '../app/lib/chat/run-file-references';

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
console.log('chat-run-file-references-test: ok');

import assert from 'node:assert/strict';
import { reconcileChatMessages, reconcileChatPagination } from '../app/lib/chat/chat-reconciliation';
import type { ChatMessage } from '../app/lib/chat/types';

function message(id: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: String(id), role: 'user', status: 'sent', content: `Message ${id}`,
    piMessage: { role: 'user', content: `Message ${id}`, timestamp: id * 100, sequence: id } as ChatMessage['piMessage'], ...overrides };
}

const cached = Array.from({ length: 120 }, (_, index) => message(index + 1));
assert.equal(reconcileChatMessages(cached, cached.slice(-50), cached), cached,
  'refreshing 50 messages preserves all 120 cached messages and their array identity');
const page = Array.from({ length: 50 }, (_, index) => message(index + 1));
assert.deepEqual(reconcileChatMessages(cached.slice(50), page, cached.slice(50)), cached);
assert.deepEqual(reconcileChatMessages(cached, page, cached), cached, 'overlapping or repeated pages do not duplicate messages');

const start = message(121, { id: 'live-121', role: 'assistant', status: 'sending', content: 'First token' });
const streamed = { ...start, content: 'First token and the new response' };
const stale = { ...message(121), role: 'assistant' as const, content: 'First token' };
assert.equal(reconcileChatMessages([streamed], [stale], [start])[0], streamed,
  'live content arriving during the HTTP request wins');
const confirmed = reconcileChatMessages([streamed], [{ ...stale, content: streamed.content }], [streamed]);
assert.equal(confirmed.length, 1);
assert.equal(confirmed[0].id, '121', 'a later snapshot confirms a live message without duplication');
assert.equal(confirmed[0].status, 'sent');

const newLive = message(122, { id: 'new-live', optimistic: true });
const withNewLive = reconcileChatMessages([...cached, newLive], cached.slice(-50), cached);
assert.equal(withNewLive.length, 121);
assert.equal(withNewLive.at(-1), newLive, 'new optimistic messages survive background refresh');
const identicalText = [message(1), message(2, { content: 'Message 1', piMessage: message(1).piMessage })];
assert.equal(reconcileChatMessages([], identicalText, []).length, 2, 'distinct persisted IDs are never deduped by text or timestamp');

const collapsed = message(1, { isCollapsed: false });
assert.equal(reconcileChatMessages([collapsed], [message(1, { isCollapsed: true })], [collapsed])[0].isCollapsed, false);
const oldest = { hasMoreBefore: true, oldestMessageId: 1, oldestSequence: 1, oldestTimestamp: 100 };
const latestPage = { hasMoreBefore: true, oldestMessageId: 71, oldestSequence: 71, oldestTimestamp: 7100 };
assert.equal(reconcileChatPagination(oldest, latestPage), oldest, 'refresh never moves cursor past retained history');
assert.equal(reconcileChatPagination(latestPage, oldest), oldest, 'pagination advances the oldest boundary');
assert.equal(reconcileChatPagination(oldest, { ...oldest, hasMoreBefore: false }).hasMoreBefore, false);
console.log('chat-reconciliation-test: ok');

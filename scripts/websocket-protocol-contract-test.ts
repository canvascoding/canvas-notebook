import assert from 'node:assert/strict';
import { isRuntimeStatusStale, type RuntimeStatus } from '../app/lib/chat/runtime-status';
import {
  CHAT_WEBSOCKET_CLOSE_CODES,
  CHAT_WEBSOCKET_PATH,
  CHAT_WEBSOCKET_PROTOCOL,
  parseClientMessage,
} from '../app/lib/websocket/protocol';

assert.equal(CHAT_WEBSOCKET_PATH, '/ws/chat');
assert.equal(CHAT_WEBSOCKET_PROTOCOL, 'canvas-chat-v1');
assert.equal(CHAT_WEBSOCKET_CLOSE_CODES.serviceRestart, 1012);
assert.equal(CHAT_WEBSOCKET_CLOSE_CODES.unauthorized, 4001);
assert.equal(CHAT_WEBSOCKET_CLOSE_CODES.licenseRequired, 4003);
assert.equal(
  isRuntimeStatusStale(
    { sessionId: 'session-a', revision: 4 } as RuntimeStatus,
    { sessionId: 'session-a', revision: 3 } as RuntimeStatus,
  ),
  true,
);
assert.equal(
  isRuntimeStatusStale(
    { sessionId: 'session-a', revision: 4 } as RuntimeStatus,
    { sessionId: 'session-a', revision: 4 } as RuntimeStatus,
  ),
  false,
);

for (const message of [
  { type: 'subscribe_session', requestId: 'subscribe-1', sessionId: 'session-a' },
  { type: 'unsubscribe_session', sessionId: 'session-a' },
  { type: 'get_status', requestId: 'status-1', sessionId: 'session-a' },
  {
    type: 'send_message',
    requestId: 'send-1',
    sessionId: 'session-a',
    clientMessageId: 'pending-1',
    message: { role: 'user', content: 'hello', timestamp: Date.now() },
  },
  { type: 'control', sessionId: 'session-a', action: 'abort' },
]) {
  assert.equal(parseClientMessage(message).ok, true, `expected valid message: ${message.type}`);
}

for (const message of [
  null,
  [],
  {},
  { type: 'unknown', sessionId: 'session-a' },
  { type: 'subscribe_session', sessionId: '' },
  { type: 'subscribe_session', sessionId: 'x'.repeat(257) },
  { type: 'send_message', sessionId: 'session-a', message: 'hello' },
  { type: 'send_message', sessionId: 'session-a', clientMessageId: '', message: { role: 'user', content: 'hello', timestamp: Date.now() } },
  { type: 'send_message', sessionId: 'session-a', clientMessageId: 'x'.repeat(257), message: { role: 'user', content: 'hello', timestamp: Date.now() } },
  { type: 'control', sessionId: 'session-a', action: 'delete_everything' },
]) {
  assert.equal(parseClientMessage(message).ok, false, 'expected invalid message');
}

console.log('WebSocket protocol contract tests passed');

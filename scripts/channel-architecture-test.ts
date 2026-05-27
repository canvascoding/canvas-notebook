import assert from 'node:assert/strict';

import {
  normalizeStoredChannelId,
  telegramChannelSessionKey,
  telegramChatIdFromSessionKey,
  webChannelSessionKey,
} from '../app/lib/channels/constants';
import { buildUserAgentMessageFromInbound } from '../app/lib/channels/message-normalization';

assert.equal(normalizeStoredChannelId('app'), 'web');
assert.equal(normalizeStoredChannelId('web'), 'web');
assert.equal(normalizeStoredChannelId('telegram'), 'telegram');

assert.equal(webChannelSessionKey('user-123'), 'web:user:user-123');
assert.equal(telegramChannelSessionKey('123456'), 'telegram:123456');
assert.equal(telegramChannelSessionKey('telegram:123456'), 'telegram:123456');
assert.equal(telegramChatIdFromSessionKey('telegram:123456'), '123456');
assert.equal(telegramChatIdFromSessionKey('123456'), '123456');

const textOnly = buildUserAgentMessageFromInbound({
  channelId: 'web',
  channelSessionKey: 'web:user:user-123',
  userId: 'user-123',
  text: 'hello',
});
assert.equal(textOnly.role, 'user');
assert.equal(textOnly.content, 'hello');
assert.equal(typeof textOnly.timestamp, 'number');

const imageMessage = buildUserAgentMessageFromInbound({
  channelId: 'telegram',
  channelSessionKey: 'telegram:123456',
  userId: 'user-123',
  text: 'look',
  images: [{ data: 'abc', mimeType: 'image/png' }],
});
assert.deepEqual(imageMessage.content, [
  { type: 'text', text: 'look' },
  { type: 'image', data: 'abc', mimeType: 'image/png' },
]);

const explicitParts = buildUserAgentMessageFromInbound({
  channelId: 'telegram',
  channelSessionKey: 'telegram:123456',
  userId: 'user-123',
  text: 'ignored when contentParts are present',
  contentParts: [
    { type: 'text', text: 'caption' },
    { type: 'image', data: 'xyz', mimeType: 'image/jpeg' },
  ],
});
assert.deepEqual(explicitParts.content, [
  { type: 'text', text: 'caption' },
  { type: 'image', data: 'xyz', mimeType: 'image/jpeg' },
]);

console.log('channel architecture tests passed');

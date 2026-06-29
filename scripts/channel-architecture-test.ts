import assert from 'node:assert/strict';

import {
  normalizeStoredChannelId,
  telegramChannelSessionKey,
  telegramChatIdFromSessionKey,
  webChannelSessionKey,
} from '../app/lib/channels/constants';
import { buildDeliveryTarget } from '../app/lib/channels/delivery-targets';
import { buildUserAgentMessageFromInbound } from '../app/lib/channels/message-normalization';
import { buildChannelChatContext } from '../app/lib/channels/chat-context';
import { getChannelSystemPromptBlock } from '../app/lib/agents/channel-system-prompt';

assert.equal(normalizeStoredChannelId('app'), 'web');
assert.equal(normalizeStoredChannelId('web'), 'web');
assert.equal(normalizeStoredChannelId('telegram'), 'telegram');

assert.equal(webChannelSessionKey('user-123'), 'web:user:user-123');
assert.equal(telegramChannelSessionKey('123456'), 'telegram:123456');
assert.equal(telegramChannelSessionKey('telegram:123456'), 'telegram:123456');
assert.equal(telegramChatIdFromSessionKey('telegram:123456'), '123456');
assert.equal(telegramChatIdFromSessionKey('123456'), '123456');
assert.equal(getChannelSystemPromptBlock('web'), null);
assert.match(getChannelSystemPromptBlock('telegram') || '', /Do not use Markdown tables/);
assert.deepEqual(buildDeliveryTarget('telegram', 'telegram:123456'), {
  channelId: 'telegram',
  channelSessionKey: 'telegram:123456',
  channelThreadKey: undefined,
  chatId: '123456',
  threadId: undefined,
});
assert.deepEqual(buildDeliveryTarget('slack', 'C123', '1700000000.000'), {
  channelId: 'slack',
  channelSessionKey: 'C123',
  channelThreadKey: '1700000000.000',
  chatId: 'C123',
  threadId: '1700000000.000',
});

const textOnly = buildUserAgentMessageFromInbound({
  channelId: 'web',
  channelSessionKey: 'web:user:user-123',
  userId: 'user-123',
  text: 'hello',
  agentMessageTimestamp: 1710000000000,
});
assert.equal(textOnly.role, 'user');
assert.equal(textOnly.content, 'hello');
assert.equal(textOnly.timestamp, 1710000000000);

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

assert.deepEqual(
  buildChannelChatContext({ channelId: 'telegram' }, { channelId: 'web', currentTime: '2026-05-31T12:00:00.000Z' }),
  { channelId: 'telegram', currentTime: '2026-05-31T12:00:00.000Z' },
);

console.log('channel architecture tests passed');

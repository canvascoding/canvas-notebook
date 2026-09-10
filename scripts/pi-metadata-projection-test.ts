import assert from 'node:assert/strict';
import { projectAgentEventForExternal, projectAgentMessageForPersistence } from '../app/lib/pi/visual-data-projection';
import { piMetadataFixture, piToolMetadataFixture } from './helpers/pi-message-fixture';
import { parsePersistedPiMessage } from '../app/lib/pi/message-projection';
import { encodeAgentEvent } from '../app/lib/pi/stream-proxy';
import { removeImagesAfterProviderRejection } from '../app/lib/pi/vision-fallback-stream';

const before = JSON.stringify(piMetadataFixture);
const projected = projectAgentMessageForPersistence(piMetadataFixture);
assert.deepEqual(projected, piMetadataFixture);
assert.deepEqual(projectAgentMessageForPersistence(projected), projected, 'projection must be idempotent');
assert.equal(JSON.stringify(piMetadataFixture), before, 'projection must not mutate its input');
assert.deepEqual(projectAgentMessageForPersistence(piToolMetadataFixture), piToolMetadataFixture);
for (const mode of ['raw', 'context', 'display'] as const) {
  assert.deepEqual(parsePersistedPiMessage(JSON.stringify(projected), mode), piMetadataFixture);
}
assert.deepEqual(JSON.parse(encodeAgentEvent({ type: 'message_end', message: piMetadataFixture })).message, piMetadataFixture);
assert.deepEqual(removeImagesAfterProviderRejection({ messages: [piMetadataFixture] }).messages, [piMetadataFixture]);
for (const type of ['message_start', 'message_end', 'turn_end']) {
  assert.deepEqual(projectAgentEventForExternal({ type, message: piMetadataFixture }).message, piMetadataFixture);
}
assert.deepEqual(projectAgentEventForExternal({ type: 'agent_end', messages: [piMetadataFixture, piToolMetadataFixture] }).messages, [piMetadataFixture, piToolMetadataFixture]);
for (const key of ['partial', 'message', 'error']) {
  const event = { type: 'message_update', message: piMetadataFixture, assistantMessageEvent: { type: key === 'partial' ? 'thinking_delta' : key === 'message' ? 'done' : 'error', [key]: piMetadataFixture } };
  assert.deepEqual(projectAgentEventForExternal(event), event);
}

// An object nested in tool arguments or details cannot bypass redaction merely
// by using provider-field names or pretending to be an assistant message.
const hostile = { ...piMetadataFixture, content: [{ type: 'toolCall', id: 'hostile', name: 'inspect', arguments: {
  thinkingSignature: '/Users/private/secret.txt',
  message: { role: 'assistant', content: [{ type: 'thinking', thinkingSignature: '/Users/private/secret.txt' }] },
} }] };
const safe = projectAgentMessageForPersistence(hostile as typeof piMetadataFixture);
assert.doesNotMatch(JSON.stringify(safe), /\/Users\/private/);
const visible = projectAgentMessageForPersistence({ ...piMetadataFixture, content: [{ type: 'text', text: 'Read /Users/private/secret.txt' }] });
assert.match(JSON.stringify(visible), /absolute server path omitted/);
assert.deepEqual(projectAgentMessageForPersistence({ role: 'user', content: 'Old history', timestamp: 1 }), { role: 'user', content: 'Old history', timestamp: 1 });
console.log('Pi metadata projection contracts passed');

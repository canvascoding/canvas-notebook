import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import type { ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';

/** Pure actual history serializer. Unused DB/runtime imports provide no authorization evidence. */
function loadSerializer(): typeof import('../app/lib/mobile/chat')['serializeMobileChatMessage'] {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  const unused = new Set(['@/app/lib/agents/management-actions', '@/app/lib/agents/registry', '@/app/lib/agents/access',
    '@/app/lib/agent-runtime-policy/runtime-resolver', '@/app/lib/agent-runtime-policy/session-runtime-service', '@/app/lib/audit/audit-service',
    '@/app/lib/channels/constants', '@/app/lib/channels/agents', '@/app/lib/channels/channel-links', '@/app/lib/chat/read-cursor', '@/app/lib/chat/unread',
    '@/app/lib/db', '@/app/lib/db/schema', '@/app/lib/pi/runtime-service', '@/app/lib/pi/session-store', '@/app/lib/pi/session-titles',
    '@/app/lib/pi/system-prompt-snapshot', '@/app/lib/pi/session-workspace-context']);
  loader._load = (name, parent, main) => unused.has(name) ? {} : original(name, parent, main);
  try { return (createRequire(__filename)('../app/lib/mobile/chat') as typeof import('../app/lib/mobile/chat')).serializeMobileChatMessage; }
  finally { loader._load = original; }
}

const serialize = loadSerializer();
const body: ChatBodyV1 = { version: 1, parts: [{ type: 'text', text: 'Use ' },
  { type: 'extension_reference', occurrenceId: 'node-1', bundleId: 'plugin-1' }, { type: 'text', text: ' please.' }], bundles: [{
    id: 'plugin-1', caption: 'Native plugin', primary: { selection: { kind: 'plugin', package: {
      resourceRef: 'canvas-resource:11111111-1111-4111-8111-111111111111',
      publishedRevisionRef: 'canvas-package-revision:22222222-2222-4222-8222-222222222222', checksum: 'a'.repeat(64),
    }, skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null }, supporting: [], packageConnections: [],
  }] };
const source = { role: 'user', content: [{ type: 'text', text: 'Use Native plugin please.' }], body, timestamp: 1,
  clientMessageId: 'inline-message', extensionSelection: { accountSelectionRef: 'PRIVATE_RECEIPT' },
  privateBinding: 'PRIVATE_BINDING', contextPrompt: 'PRIVATE_CONTEXT' };
const row = (value: unknown) => ({ id: 1, sequence: 1, timestamp: 1, content: JSON.stringify(value) });
const accepted = serialize(row(source));
assert.deepEqual(accepted.body, body); assert.equal(accepted.text, 'Use Native plugin please.');
assert.equal(accepted.clientMessageId, 'inline-message');
assert.doesNotMatch(JSON.stringify(accepted), /PRIVATE_|accountSelectionRef|privateBinding|contextPrompt/u);
for (const invalid of [
  { ...source, role: 'assistant' }, { ...source, role: 'toolResult' },
  { ...source, content: [{ type: 'text', text: 'Other source text' }] },
  { ...source, body: { ...body, accountSelectionRef: 'PRIVATE_RECEIPT' } },
  { ...source, body: { ...body, bundles: [{ ...body.bundles[0], primary: { ...body.bundles[0]!.primary, accountSelectionRef: 'PRIVATE_RECEIPT' } }] } },
  { ...source, body: { ...body, bundles: [] } },
]) assert.equal(serialize(row(invalid)).body, undefined, 'Invalid, private, orphaned or non-user bodies never become inline presentation.');
const legacy = serialize(row({ role: 'user', content: 'Legacy text' }));
assert.equal(legacy.text, 'Legacy text'); assert.equal(legacy.body, undefined);
console.info('PASS actual Mobile history inline body: exact validated user text/public identity only, no receipts/private data, malformed/non-user/mismatch fallback and legacy text unchanged.');

import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { projectAgentMessageForPersistence } from '../app/lib/pi/visual-data-projection';

function loadSerializer(): typeof import('../app/lib/mobile/chat')['serializeMobileChatMessage'] {
  // Exercise the real pure history serializer. Unused DB/runtime entry points
  // are not loaded or called; this test supplies no authorization evidence.
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const original = internals._load;
  const unused = new Set([
    '@/app/lib/agents/management-actions', '@/app/lib/agents/registry', '@/app/lib/agents/access',
    '@/app/lib/agent-runtime-policy/runtime-resolver', '@/app/lib/agent-runtime-policy/session-runtime-service',
    '@/app/lib/audit/audit-service', '@/app/lib/channels/constants', '@/app/lib/channels/agents',
    '@/app/lib/channels/channel-links', '@/app/lib/chat/read-cursor', '@/app/lib/chat/unread',
    '@/app/lib/db', '@/app/lib/db/schema', '@/app/lib/pi/runtime-service', '@/app/lib/pi/session-store',
    '@/app/lib/pi/session-titles', '@/app/lib/pi/system-prompt-snapshot', '@/app/lib/pi/session-workspace-context',
  ]);
  internals._load = (name, parent, isMain) => unused.has(name) ? {} : original(name, parent, isMain);
  try { return (createRequire(__filename)('../app/lib/mobile/chat') as typeof import('../app/lib/mobile/chat')).serializeMobileChatMessage; }
  finally { internals._load = original; }
}

function assertPrivateFree(value: unknown): void {
  assert.doesNotMatch(JSON.stringify(value), /mcpAppAuthority|PRIVATE_AUTHORITY|PRIVATE_POLICY|PRIVATE_PROVIDER|PRIVATE_INPUT|PRIVATE_META|PRIVATE_RESULT|PRIVATE_UNKNOWN|_meta|mcpToolInput|structuredContent/u);
}

async function main(): Promise<void> {
  const serialize = loadSerializer();
  const { projectMobileChatDisplay, MAX_MOBILE_CHAT_DISPLAY_BYTES } = await import('../app/lib/mobile/chat-display');
  const callId = 'native-app-1-fixture';
  const appV1 = { version: 1 as const, connectionId: '11111111-1111-4111-8111-111111111111',
    toolName: 'app_view', resourceUri: 'ui://fixture/shared-design.html' };
  const appV2 = { version: 2 as const, connectionRef: 'canvas-connection:22222222-2222-4222-8222-222222222222',
    toolCallId: callId, toolName: 'app_view', resourceUri: appV1.resourceUri, bindingRevision: 'a'.repeat(64) };
  const timestamp = Date.parse('2026-10-09T10:00:00.000Z');
  const privateAuthority = { version: 1, integrationContext: { actorUserId: 'PRIVATE_AUTHORITY', workspaceRoot: '/PRIVATE_AUTHORITY' },
    effectivePolicy: { marker: 'PRIVATE_POLICY' }, providerRef: 'PRIVATE_PROVIDER', bindingRevision: appV2.bindingRevision };
  const message = { role: 'toolResult' as const, toolName: 'integrations', toolCallId: callId, isError: false, timestamp,
    content: [{ type: 'text' as const, text: 'Shared design is available.' }], details: {
      mcpApp: appV2, mcpAppAuthority: privateAuthority, mcpToolInput: { marker: 'PRIVATE_INPUT' },
      result: { content: [], structuredContent: { marker: 'PRIVATE_RESULT' }, _meta: { marker: 'PRIVATE_META' } },
      unknown: { marker: 'PRIVATE_UNKNOWN', mcpAppAuthority: privateAuthority },
    } } satisfies AgentMessage;
  const row = { id: 1, sequence: 1, timestamp, content: JSON.stringify(projectAgentMessageForPersistence(message)) };
  const raw = JSON.parse(row.content) as { details: Record<string, unknown> };
  assert.deepEqual(raw.details.mcpAppAuthority, privateAuthority, 'The actual persistence projection retains the server proof.');
  const untouched = row.content;
  const shared = serialize(row);
  assert.deepEqual(shared.display, { version: 1, mcpApp: appV2 },
    'The actual HTTP history serializer must transmit the saved shared invocation descriptor.');
  assertPrivateFree(shared); assert.equal(row.content, untouched);
  assert.equal(shared.toolCallId, callId); assert.equal(shared.toolName, 'integrations');
  assert.equal(shared.text, 'Shared design is available.'); assert.equal(shared.kind, 'tool');
  assert.equal(shared.role, 'tool'); assert.equal(shared.createdAt, new Date(timestamp).toISOString());

  const personal = serialize({ ...row, content: JSON.stringify(projectAgentMessageForPersistence({ ...message,
    details: { ...message.details, mcpApp: { ...appV1, unknownCredential: 'PRIVATE_UNKNOWN' } },
  } as AgentMessage)) });
  assert.deepEqual(personal.display, { version: 1, mcpApp: appV1 });
  assertPrivateFree(personal);
  const clone = projectMobileChatDisplay(message, callId); assert(clone);
  clone.mcpApp.toolName = 'other_view';
  assert.equal(message.details.mcpApp.toolName, 'app_view', 'Public descriptor objects cannot mutate the retained raw source.');
  assert.equal(projectMobileChatDisplay(message, 'another-transmitted-call'), undefined, 'The public descriptor must match the exact transmitted call ID.');

  for (const invalid of [
    { ...message, role: 'assistant' }, { ...message, isError: true }, { ...message, error: true },
    { ...message, details: { ...message.details, error: true } },
    { ...message, details: { ...message.details, isError: true } },
    { ...message, details: { ...message.details, result: { isError: true } } },
    { ...message, toolCallId: 'another-call' },
    { ...message, details: { ...message.details, mcpApp: { ...appV2, bindingRevision: 'A'.repeat(64) } } },
    { ...message, details: { ...message.details, mcpApp: { ...appV2, connectionRef: appV1.connectionId } } },
    { ...message, details: { ...message.details, mcpApp: { ...appV2, connectionId: appV1.connectionId } } },
    { ...message, details: { ...message.details, mcpApp: { ...appV2, mcpAppAuthority: privateAuthority } } },
    { ...message, details: { ...message.details, mcpApp: { ...appV2, resourceUri: 'https://foreign.example/widget' } } },
    { ...message, details: { ...message.details, mcpApp: { ...appV2, toolName: 't'.repeat(257) } } },
    { ...message, details: { ...message.details, mcpApp: { ...appV2, resourceUri: `ui://${'x'.repeat(4092)}` } } },
    { ...message, details: { ...message.details, mcpApp: { ...appV1, connectionId: 'invalid' } } },
    { ...message, details: { mcpAppAuthority: privateAuthority } },
  ]) {
    const result = serialize({ ...row, content: JSON.stringify(invalid) });
    assert.equal('display' in result, false, 'Failed, malformed or mismatched invocations cannot expose a widget target.');
    assertPrivateFree(result);
  }

  const ordinary = serialize({ ...row, content: JSON.stringify({ role: 'assistant', content: 'Ordinary answer.', timestamp }) });
  assert.deepEqual(ordinary, { id: '1', sequence: 1, role: 'assistant', kind: 'message', text: 'Ordinary answer.',
    toolCallId: null, toolName: null, toolInput: null, attachments: [], createdAt: new Date(timestamp).toISOString() });
  const legacy = serialize({ ...row, content: JSON.stringify({ ...message, details: undefined }) }, new Map([[callId, '{"query":"design"}']]));
  assert.equal('display' in legacy, false); assert.equal(legacy.text, shared.text);
  assert.equal(legacy.toolInput, '{"query":"design"}'); assert.deepEqual(legacy.attachments, shared.attachments);
  const compact = serialize({ ...row, content: JSON.stringify({ role: 'compact-break', attemptId: 'manual-fixture',
    kind: 'manual', omittedMessageCount: 4, timestamp: '2026-10-09T10:00:00.000Z', details: message.details }) });
  assert.deepEqual(compact, { id: '1', sequence: 1, role: 'system', kind: 'compact_break', text: '',
    compactMeta: { attemptId: 'manual-fixture', kind: 'manual', omittedMessageCount: 4, timestamp: '2026-10-09T10:00:00.000Z' },
    toolCallId: null, toolName: null, toolInput: null, attachments: [], createdAt: '2026-10-09T10:00:00.000Z' });
  assertPrivateFree(compact);
  const email = serialize({ ...row, content: JSON.stringify({ ...message, toolName: 'email_create_outbox_draft',
    details: { uiIntent: { view: 'review-draft', scope: 'personal', draftId: 'draft-fixture', subject: 'Draft subject' } } }) });
  assert.deepEqual(email.emailAction, { kind: 'review', scope: 'personal', workspaceId: null, draftId: 'draft-fixture', subject: 'Draft subject' });
  assert.equal('display' in email, false);
  const imageDetails = { type: 'image', filePath: 'artifacts/design.png', mimeType: 'image/png', size: 64, name: 'design.png' };
  const imageMessage = { ...message, details: { ...message.details, ...imageDetails } };
  const imageWithApp = serialize({ ...row, content: JSON.stringify(imageMessage) });
  const imageWithoutApp = serialize({ ...row, content: JSON.stringify({ ...imageMessage, details: imageDetails }) });
  assert.equal(imageWithApp.attachments.length, 1);
  assert.deepEqual(imageWithApp.attachments, imageWithoutApp.attachments, 'Adding the descriptor leaves the existing image attachment projection unchanged.');
  assert.deepEqual(imageWithApp.display, { version: 1, mcpApp: appV2 });

  const maxApp = { ...appV2, toolName: 't'.repeat(256), resourceUri: `ui://${'x'.repeat(4091)}` };
  const largeRaw = { ...message, details: { ...message.details, mcpApp: maxApp, privateLarge: 'PRIVATE_UNKNOWN'.repeat(200_000) } };
  const large = serialize({ ...row, content: JSON.stringify(largeRaw) });
  const publicDisplay = large.display;
  assert.deepEqual(publicDisplay, { version: 1, mcpApp: maxApp });
  assert.equal(MAX_MOBILE_CHAT_DISPLAY_BYTES, 128 * 1024);
  assert(Buffer.byteLength(JSON.stringify(publicDisplay), 'utf8') <= MAX_MOBILE_CHAT_DISPLAY_BYTES);
  assertPrivateFree(large);
  console.info('PASS actual mobile history serializer: persisted v1/v2 descriptors, private proof/input/meta excluded, errors and mismatches denied, 128KiB display bound, legacy/email/compaction unchanged; no DB/auth/native claims');
}

main().catch(error => {
  const site = error instanceof Error ? error.stack?.match(/mobile-chat-display-serializer-test\.ts:\d+:\d+/u)?.[0] : undefined;
  console.error('MOBILE_CHAT_DISPLAY_SERIALIZER_FAIL', error instanceof assert.AssertionError ? 'assertion' : 'unexpected', site ?? 'unknown');
  process.exitCode = 1;
});

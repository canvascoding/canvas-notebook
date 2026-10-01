import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import WebSocket from 'ws';

import { projectMobileEmailAction, projectMobileEmailAgentEvent, type MobileEmailAction } from '../app/lib/mobile/email-action';
import type { MobileChatMessage } from '../app/lib/mobile/chat';

type RecordValue = Record<string, unknown>;
type Wire = { type: string; sessionId: string; event: RecordValue };
type TestedServer = {
  serializeMobileChatMessage: (row: { id: number; sequence: number; timestamp: number; content: string }) => MobileChatMessage;
  broadcastAgentEvent: (sessionId: string, event: RecordValue) => void;
  subscribeToSession: (sessionId: string, socket: WebSocket) => boolean;
  unsubscribeFromSession: (sessionId: string, socket: WebSocket) => void;
  parsePersistedPiMessage: (content: string, mode: string) => { details?: RecordValue };
};

const rawBody = '<p>PRIVATE_SYNTHETIC_BODY</p>'.repeat(2_000);
function message(toolName = 'email_create_outbox_draft', intent: RecordValue = {
  view: 'review-draft', scope: 'workspace', workspaceId: 'workspace-a', draftId: 'draft-a', subject: 'Review this draft',
}): RecordValue {
  return { role: 'toolResult', toolName, toolCallId: 'call-a', isError: false, content: [{ type: 'text', text: rawBody }],
    details: { body: rawBody, accountId: 'not-an-action-field', credentials: 'SYNTHETIC_SECRET', uiIntent: intent } };
}
function eventFrom(message: RecordValue): RecordValue {
  return { type: 'tool_execution_end', toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError,
    result: { content: message.content, details: message.details } };
}
function row(value: RecordValue) { return { id: 1, sequence: 3, timestamp: Date.parse('2026-10-01T10:00:00Z'), content: JSON.stringify(value) }; }

async function loadRealServer(directory: string): Promise<TestedServer> {
  const filename = path.join(directory, 'server.cjs');
  // Keep the real serializer, display projection, broadcast and all their pure
  // dependencies. Eliminate unused app/runtime services and the module's bridge
  // registration so this contract test neither opens a DB nor starts a server.
  const unusedServices = new Set([
    '@/app/lib/agents/management-actions', '@/app/lib/agents/registry', '@/app/lib/agents/access',
    '@/app/lib/agent-runtime-policy/runtime-resolver', '@/app/lib/agent-runtime-policy/session-runtime-service',
    '@/app/lib/audit/audit-service', '@/app/lib/channels/agents', '@/app/lib/channels/channel-links',
    '@/app/lib/db', '@/app/lib/db/schema', '@/app/lib/pi/runtime-service', '@/app/lib/pi/session-store',
    '@/app/lib/pi/system-prompt-snapshot', '@/app/lib/pi/session-workspace-context',
    '@/app/lib/license', '@/app/lib/onboarding/status', '@/app/lib/security/trusted-origins',
    '@/app/lib/observability/operation-timing', '@/app/lib/pi/session-runtime-access',
  ]);
  await build({ stdin: { contents: `
    export { serializeMobileChatMessage } from './app/lib/mobile/chat';
    export { broadcastAgentEvent } from './server/websocket-server';
    export { subscribeToSession, unsubscribeFromSession } from './server/websocket-broadcast';
    export { parsePersistedPiMessage } from './app/lib/pi/message-projection';
  `, resolveDir: process.cwd(), sourcefile: 'mobile-email-action-contract-entry.ts' },
  outfile: filename, bundle: true, platform: 'node', format: 'cjs', packages: 'external', treeShaking: true,
  plugins: [{ name: 'unused-service-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, argument => {
      if (argument.path === 'server-only') return { path: argument.path, namespace: 'empty', sideEffects: false };
      if (argument.path === './chat-event-bridge') return { path: argument.path, namespace: 'bridge' };
      if (unusedServices.has(argument.path) || /^\.\/(?:websocket-auth|websocket-rate-limit|websocket-session-queue|agent-runtime-loader)$/u.test(argument.path)) {
        return { path: argument.path, external: true, sideEffects: false };
      }
      return undefined;
    });
    builder.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: '', loader: 'js' }));
    builder.onLoad({ filter: /.*/, namespace: 'bridge' }, () => ({ contents: 'export function initializeWebSocketBridge() {}', loader: 'js' }));
  } }], logLevel: 'warning' });
  return createRequire(import.meta.url)(filename) as TestedServer;
}

async function main() {
  const expected: MobileEmailAction = { kind: 'review', scope: 'workspace', workspaceId: 'workspace-a', draftId: 'draft-a', subject: 'Review this draft' };
  for (const tool of ['email_create_outbox_draft', 'email_update_outbox_draft']) {
    const source = message(tool);
    assert.deepEqual(projectMobileEmailAction(source), expected);
    assert.deepEqual(projectMobileEmailAgentEvent(eventFrom(source)).emailAction, expected);
    assert.equal(JSON.stringify(projectMobileEmailAction(source)).includes('PRIVATE_SYNTHETIC'), false);
    assert.equal(JSON.stringify(projectMobileEmailAction(source)).includes('SYNTHETIC_SECRET'), false);
  }
  const personal = message('email_create_outbox_draft', { view: 'review-draft', scope: 'personal', draftId: 'personal-draft', subject: null,
    workspaceId: 'untrusted-chat-organization', url: 'https://untrusted.test/draft', body: rawBody });
  const personalExpected: MobileEmailAction = { kind: 'review', scope: 'personal', workspaceId: null, draftId: 'personal-draft', subject: null };
  assert.deepEqual(projectMobileEmailAction(personal), personalExpected, 'Personal actions never borrow the organization chat workspace');
  const queue = message('email_list_outbox_drafts', { view: 'review-center', scope: 'workspace', workspaceId: 'workspace-a', draftId: 'ignored', url: 'javascript:bad' });
  assert.deepEqual(projectMobileEmailAction(queue), { kind: 'queue', scope: 'workspace', workspaceId: 'workspace-a', subject: null });
  const personalQueue = message('email_list_outbox_drafts', { view: 'review-center', scope: 'personal' });
  assert.deepEqual(projectMobileEmailAction(personalQueue), { kind: 'queue', scope: 'personal', workspaceId: null, subject: null });
  assert.deepEqual(projectMobileEmailAction(message('email_update_outbox_draft', {
    view: 'review-draft', scope: 'workspace', workspaceId: 'workspace-a', draftId: 'a'.repeat(200), subject: 'a'.repeat(1_000),
  })), { ...expected, draftId: 'a'.repeat(200), subject: 'a'.repeat(1_000) });
  assert.equal(projectMobileEmailAction(message('email_create_outbox_draft', {
    view: 'review-draft', scope: 'personal', draftId: 'draft-a', subject: '  Clean subject  ',
  }))?.subject, 'Clean subject');

  const valid = message();
  const details = valid.details as RecordValue;
  const intent = details.uiIntent as RecordValue;
  const invalid: unknown[] = [null, [], { ...valid, role: 'assistant' }, { ...valid, role: 'user' },
    { ...valid, isError: true }, { ...valid, isError: 'false' }, { ...valid, error: true }, { ...valid, success: false },
    { ...valid, toolName: 'workspace_email_create_outbox_draft' }, { ...valid, toolName: 'email_send' }, { ...valid, toolName: 'email_create_outbox_draft_extra' },
    { ...valid, details: { uiIntent: intent, error: 'synthetic tool failed' } }, { ...valid, details: [] },
    { ...valid, details: { draftId: 'draft-a', subject: 'Text and details fallback is forbidden' } },
    { ...valid, details: { uiIntent: { ...intent, scope: 'organization' } } },
    { ...valid, details: { uiIntent: { ...intent, view: 'review-center' } } },
    { ...valid, details: { uiIntent: { ...intent, workspaceId: null } } },
    { ...valid, details: { uiIntent: { ...intent, workspaceId: 'https://untrusted.test/workspace' } } },
    { ...valid, details: { uiIntent: { ...intent, workspaceId: '../workspace' } } },
    { ...valid, details: { uiIntent: { ...intent, draftId: 'a'.repeat(201) } } },
    { ...valid, details: { uiIntent: { ...intent, draftId: '' } } },
    { ...valid, details: { uiIntent: { ...intent, draftId: 'draft?inject=1' } } },
    { ...valid, details: { uiIntent: { ...intent, subject: 'a'.repeat(1_001) } } },
    { ...valid, details: { uiIntent: { ...intent, subject: 'Subject\r\nHeader' } } },
    { ...valid, details: { uiIntent: { ...intent, subject: 'Subject\u2028line' } } },
    { ...valid, details: { uiIntent: { ...intent, subject: {} } } },
  ];
  for (const source of invalid) assert.equal(projectMobileEmailAction(source), null);
  for (const source of [
    { ...eventFrom(valid), type: 'tool_execution_update' }, { ...eventFrom(valid), type: 'tool_execution_start' },
    { ...eventFrom(valid), isError: true }, { ...eventFrom(valid), result: { ...details, error: 'failed' } },
    { type: 'message_end', message: valid },
  ]) assert.equal('emailAction' in projectMobileEmailAgentEvent({ ...source, emailAction: expected }), false);
  const spoof = { type: 'tool_execution_end', toolName: 'bash', isError: false, result: { content: 'Review /email/reviews/draft-a', details: { uiIntent: intent } }, emailAction: expected };
  assert.equal('emailAction' in projectMobileEmailAgentEvent(spoof), false, 'Unrelated tools cannot forge navigation metadata');

  const directory = await mkdtemp(path.join(process.cwd(), '.mobile-email-action-test-'));
  let unsubscribe: (() => void) | undefined;
  try {
    const server = await loadRealServer(directory);
    const transmitted: Wire[] = [];
    const socket = { readyState: WebSocket.OPEN, send: (serialized: string) => transmitted.push(JSON.parse(serialized) as Wire) } as unknown as WebSocket;
    server.subscribeToSession('email-session', socket);
    unsubscribe = () => server.unsubscribeFromSession('email-session', socket);
    for (const source of [valid, message('email_update_outbox_draft'), personal, queue, personalQueue]) {
      const persisted = server.serializeMobileChatMessage(row(source));
      const rawEvent = { ...eventFrom(source), emailAction: { kind: 'queue', url: 'https://spoof.test' } };
      const original = JSON.stringify(rawEvent);
      server.broadcastAgentEvent('email-session', rawEvent);
      assert.deepEqual(transmitted.at(-1)?.event.emailAction, persisted.emailAction, 'Real live broadcast and persisted serializer project identical destinations');
      assert.equal(transmitted.at(-1)?.sessionId, 'email-session');
      assert.equal(JSON.stringify(rawEvent), original, 'Projection never mutates runtime events');
      assert.equal(persisted.role, 'tool'); assert.equal(persisted.kind, 'tool');
      assert.ok(persisted.text.length < rawBody.length, 'Existing display text compaction still applies');
    }
    const large = message();
    large.details = { ...Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`padding${index}`, rawBody])), ...details };
    assert.equal(server.parsePersistedPiMessage(row(large).content, 'display').details?.uiIntent, undefined, 'Fixture exceeds legacy details key compaction');
    assert.deepEqual(server.serializeMobileChatMessage(row(large)).emailAction, expected, 'Action survives display compaction because it uses original details');
    const oldMessage = { role: 'toolResult', toolName: 'email_create_outbox_draft', content: [{ type: 'text', text: 'Older draft result remains readable.' }] };
    const oldSerialized = server.serializeMobileChatMessage(row(oldMessage));
    assert.equal(oldSerialized.text, 'Older draft result remains readable.'); assert.equal('emailAction' in oldSerialized, false);
    const forgedMessage = { ...oldMessage, emailAction: expected };
    assert.equal('emailAction' in server.serializeMobileChatMessage(row(forgedMessage)), false);
    server.broadcastAgentEvent('email-session', spoof);
    assert.equal('emailAction' in transmitted.at(-1)!.event, false);
    const failedSerialized = server.serializeMobileChatMessage(row({ ...valid, isError: true }));
    assert.equal(failedSerialized.kind, 'error'); assert.equal('emailAction' in failedSerialized, false);
    const compact = server.serializeMobileChatMessage(row({ role: 'compact-break', kind: 'manual', timestamp: '2026-10-01T10:00:00Z', emailAction: expected }));
    assert.equal(compact.kind, 'compact_break'); assert.equal('emailAction' in compact, false);
    console.log('mobile-email-action-test: ok (safe whitelist, bounds, personal scope, raw compaction, real serializer/live broadcast parity, errors and legacy compatibility)');
  } finally { unsubscribe?.(); await rm(directory, { recursive: true, force: true }); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });

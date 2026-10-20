import assert from 'node:assert/strict';
import Module from 'node:module';
import { webcrypto } from 'node:crypto';
import { parseClientMessage } from '../app/lib/websocket/protocol';
import { WebSocketClient } from '../app/lib/websocket/client';
import { captureChatTransportJson, resolveChatClientMessageId } from '../app/lib/chat/message-submission';
import { telegramInboundClientMessageId } from '../app/lib/channels/telegram/message-identity';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { completeTodoFollowUpTransaction, prepareTodoFollowUpTransaction } from '../app/lib/todos/follow-up-transaction';
import type { ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';
import type { ChatExtensionSelectionInput } from '../app/lib/capabilities/extensions/contracts';
import type { InboundMessage } from '../app/lib/channels/types';
import { followUpTodoDetail, useTodoDetailStore } from '../app/store/todo-detail-store';
import type { TodoItem } from '../app/lib/todos/client-types';

// Transport adapters only. Controlled runtime/session boundaries below issue no
// SQL handle, source proof, execution claim or model/provider request.
async function main() {
  const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  const selected: ChatExtensionSelectionInput = { version: 1, origin: 'turn_reference', selections: [{
    selection: { kind: 'mcp', source: 'mcp', target: { kind: 'shared',
      connectionRef: 'canvas-connection:00000000-0000-4000-8000-000000000001', bindingRevision: 3 } },
    requirement: 'optional', toolCap: ['READ'],
  }] };
  const body: ChatBodyV1 = { version: 1, parts: [{ type: 'text', text: 'Mit ' },
    { type: 'extension_reference', occurrenceId: 'occurrence-1', bundleId: 'bundle-1' }],
  bundles: [{ id: 'bundle-1', caption: 'MCP', primary: selected.selections[0], supporting: [], packageConnections: [] }] };
  const message = { role: 'user', content: 'Mit MCP', timestamp: 0, clientMessageId: 'stable-message' };
  const envelope = { type: 'send_message', sessionId: 'session-a', message, body, selection: selected,
    expectedAgentId: 'agent-a', expectedWorkspaceId: 'workspace-a' };
  const parsed = parseClientMessage(Object.freeze(envelope));
  assert(parsed.ok && parsed.message.type === 'send_message');
  assert.equal(parsed.message.clientMessageId, message.clientMessageId);
  assert.equal((parsed.message.message as unknown as Record<string, unknown>).clientMessageId, message.clientMessageId);
  assert.deepEqual(json(parsed.message.body), body); assert.deepEqual(json(parsed.message.selection), selected);
  assert.equal(Object.hasOwn(envelope, 'clientMessageId'), false, 'Parsing does not mutate the original envelope');
  for (const action of ['follow_up', 'steer', 'replace']) {
    const control = parseClientMessage({ ...envelope, type: 'control', action, clientMessageId: message.clientMessageId });
    assert(control.ok && control.message.type === 'control');
    assert.deepEqual(json(control.message.body), body); assert.deepEqual(json(control.message.selection), selected);
  }
  const outerOnly = parseClientMessage({ type: 'send_message', sessionId: 'session-a', clientMessageId: 'outer-only',
    message: { role: 'user', content: 'plain', timestamp: 1 } });
  assert(outerOnly.ok && outerOnly.message.type === 'send_message');
  assert.equal((outerOnly.message.message as unknown as Record<string, unknown>).clientMessageId, 'outer-only');
  for (const invalid of [
    { ...envelope, clientMessageId: 'different' },
    { type: 'send_message', sessionId: 'session-a', message: { role: 'user', content: 'plain', timestamp: 1 } },
    { ...envelope, clientMessageId: ' stable-message' },
    { ...envelope, clientMessageId: 'x'.repeat(129) },
    { ...envelope, message: { ...message, role: 'assistant' } },
    { ...envelope, agentId: 'different-agent' },
    { ...envelope, body: null }, { ...envelope, body: undefined },
    { ...envelope, selection: { ...selected, unknown: true } },
    { ...envelope, type: 'control', action: 'abort' },
  ]) assert.equal(parseClientMessage(invalid).ok, false);
  let getterCalls = 0;
  const accessor = { ...envelope };
  Object.defineProperty(accessor, 'body', { enumerable: true, get() { getterCalls++; return body; } });
  assert.equal(parseClientMessage(accessor).ok, false); assert.equal(getterCalls, 0);
  assert.throws(() => captureChatTransportJson({ toJSON() { getterCalls++; return {}; } }));
  assert.equal(getterCalls, 0);
  assert.throws(() => resolveChatClientMessageId(undefined, undefined));
  assert.throws(() => resolveChatClientMessageId(null, 'valid'));
  assert.throws(() => resolveChatClientMessageId('first', 'second'));
  const client = new WebSocketClient('ws://transport.invalid/ws/chat');
  let clientPayload: Record<string, unknown> | undefined;
  client.request = async <T extends Record<string, unknown>>(type: string, payload: Record<string, unknown>): Promise<T> => {
    assert.equal(type, 'send_message'); clientPayload = payload; return { success: true, status: null } as unknown as T;
  };
  assert.deepEqual(await client.sendMessage('session-a', message, { currentPage: '/chat' }, { body, selection: selected }), { success: true, status: null });
  assert.deepEqual(json(clientPayload), { sessionId: 'session-a', message, context: { currentPage: '/chat' }, body, selection: selected, clientMessageId: message.clientMessageId });

  const eventId = telegramInboundClientMessageId('42', '100', 10);
  assert.equal(eventId, telegramInboundClientMessageId('42', '100', 10));
  assert.notEqual(eventId, telegramInboundClientMessageId('43', '100', 10));
  assert.notEqual(eventId, telegramInboundClientMessageId('42', '101', 10));
  assert.notEqual(eventId, telegramInboundClientMessageId('42', '100', 11));
  assert.equal(telegramInboundClientMessageId('42', '100', 10, 'album-a'), telegramInboundClientMessageId('42', '100', 11, 'album-a'));
  assert.notEqual(eventId, telegramInboundClientMessageId('42', '100', 10, 'album-a'));
  assert.throws(() => telegramInboundClientMessageId('42', '100'));

  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const previousLoad = loader._load;
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { reached = resolve; });
  let received: unknown[] = [], resolverCalls = 0, sourceReads = 0, sourceFailure = false;
  const originalSource = { payload: { identity: { userId: 'alice', sessionId: 'original-telegram-session',
    agentId: 'original-agent', workspaceId: 'original-workspace' } } };
  loader._load = (name, parent, isMain) => {
    if (name === '@/app/lib/pi/durable-message-admission' || name.endsWith('/app/lib/pi/durable-message-admission.ts')) return {
      readOwnedAcceptedChatMessageForChannelSource: async (input: unknown) => {
        sourceReads++;
        assert.deepEqual(json(input), { userId: 'alice', clientMessageId: eventId, channelId: 'telegram', channelSessionKey: 'telegram:42:100' });
        if (sourceFailure) throw new Error('The original channel message cannot be uniquely recovered.');
        return originalSource;
      },
      readOwnedChatMessageExecutionSnapshot: (original: unknown) => { assert.equal(original, originalSource); return originalSource; },
    };
    if (parent?.filename.endsWith('/channels/router.ts')) {
      if (name === '@/app/lib/pi/runtime-service') return { sendMessage: async (...args: unknown[]) => { received = args; return null; } };
      if (name === './session-resolver') return { resolveChannelSession: async () => { resolverCalls++; reached(); await held; return 'session-a'; } };
      if (name === '@/app/lib/pi/session-workspace-context') return { requestedWorkspaceIdFromChatContext: (context?: { workspace?: { workspaceId: string } }) => context?.workspace?.workspaceId ?? null };
    }
    return previousLoad(name, parent, isMain);
  };
  try {
    const { handleInboundChannelMessage } = await import('../app/lib/channels/router');
    const inbound: InboundMessage = { channelId: 'web', channelSessionKey: 'web:user:alice', userId: 'alice',
      clientMessageId: message.clientMessageId, agentMessageTimestamp: 0, text: '',
      contentParts: [{ type: 'text', text: 'Mit MCP', textSignature: 'unchanged-signature' },
        { type: 'image', data: '/api/files/uploads/stable', mimeType: 'image/png' }],
      body: structuredClone(body), selection: structuredClone(selected), expectedAgentId: 'agent-a', expectedWorkspaceId: 'workspace-a' };
    const original = structuredClone(inbound), pending = handleInboundChannelMessage(inbound, { currentPage: '/chat' });
    await entered;
    inbound.body!.bundles[0].caption = 'changed after await'; inbound.selection!.selections[0].toolCap = [];
    inbound.contentParts![0] = { type: 'text', text: 'changed after await' };
    release();
    assert.deepEqual(await pending, { sessionId: 'session-a', status: null }, 'Cold confirmed replay returns null without a fabricated idle status');
    assert.deepEqual(json(received), ['session-a', 'alice', { role: 'user', content: original.contentParts, timestamp: 0, clientMessageId: message.clientMessageId },
      { currentPage: '/chat', channelId: 'web' }, { body: original.body, selection: original.selection,
        expectedAgentId: 'agent-a', expectedWorkspaceId: 'workspace-a' }]);
    const { clientMessageId: missingId, ...missing } = original; assert(missingId);
    await assert.rejects(handleInboundChannelMessage(missing)); assert.equal(resolverCalls, 1, 'Missing identity fails before any session resolution');
    const telegram: InboundMessage = { channelId: 'telegram', channelSessionKey: 'telegram:42:100', userId: 'alice',
      clientMessageId: eventId, agentMessageTimestamp: 0, text: 'Provider retry' };
    assert.deepEqual(await handleInboundChannelMessage(telegram), { sessionId: 'original-telegram-session', status: null });
    assert.deepEqual(json(received), ['original-telegram-session', 'alice', { role: 'user', content: 'Provider retry', timestamp: 0, clientMessageId: eventId },
      { channelId: 'telegram' }, { expectedAgentId: 'original-agent', expectedWorkspaceId: 'original-workspace' }]);
    assert.equal(resolverCalls, 1, 'An original provider admission bypasses active-session selection and its writes');
    await assert.rejects(handleInboundChannelMessage({ ...telegram, requestedSessionId: 'different-session' }), /different original session/u);
    sourceFailure = true;
    await assert.rejects(handleInboundChannelMessage(telegram), /cannot be uniquely recovered/u);
    assert.equal(sourceReads, 3); assert.equal(resolverCalls, 1, 'Uncertain provider provenance cannot fall back to a fresh session');
  } finally { release(); loader._load = previousLoad; }

  const storage = new Map<string, string>(), previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto'), previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: {
    getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
  }, dispatchEvent: () => true } });
  if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  try {
    observeOpenedDocumentAuth({ data: { user: { id: 'alice' }, session: { id: 'session-alice' } } });
    const first = prepareTodoFollowUpTransaction('todo-a', 'same comment', 'de', 'original-session');
    assert.deepEqual(prepareTodoFollowUpTransaction('todo-a', 'same comment', 'de', 'original-session'), first, 'Retry/reopen uses the persisted original request');
    assert.deepEqual(prepareTodoFollowUpTransaction('todo-a', 'same comment', 'de', 'changed-session'), first, 'Retry never retargets a pending request after the to-do was relinked');
    const edited = prepareTodoFollowUpTransaction('todo-a', 'edited comment', 'de', 'original-session'); assert.notEqual(edited.clientMessageId, first.clientMessageId);
    completeTodoFollowUpTransaction('todo-a', first);
    assert.deepEqual(prepareTodoFollowUpTransaction('todo-a', 'edited comment', 'de', 'original-session'), edited, 'Late old ACK cannot clear a newer request');
    observeOpenedDocumentAuth({ data: { user: { id: 'bob' }, session: { id: 'session-bob' } } });
    const otherActor = prepareTodoFollowUpTransaction('todo-a', 'edited comment', 'de', 'original-session'); assert.notEqual(otherActor.clientMessageId, edited.clientMessageId);
    observeOpenedDocumentAuth({ data: { user: { id: 'alice' }, session: { id: 'session-alice' } } });
    assert.deepEqual(prepareTodoFollowUpTransaction('todo-a', 'edited comment', 'de', 'original-session'), edited);
    completeTodoFollowUpTransaction('todo-a', edited);
    assert.notEqual(prepareTodoFollowUpTransaction('todo-a', 'edited comment', 'de', 'original-session').clientMessageId, edited.clientMessageId, 'A confirmed, deliberately repeated send is a new request');
    assert.doesNotMatch([...storage.values()].join(''), /accountSelectionRef|secret|providerRef/u);

    const todo = { id: 'todo-store', canWrite: true, status: 'done', sourceSessionId: 'original-session' } as TodoItem;
    useTodoDetailStore.setState({ open: true, todoId: todo.id, todo, loading: false, busy: false, error: null });
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) throw new Error('Lost HTTP acknowledgement');
      return Response.json({ success: true, data: { todo } });
    };
    await followUpTodoDetail('store retry', 'de');
    assert.equal(useTodoDetailStore.getState().busy, false); assert.match(useTodoDetailStore.getState().error ?? '', /Lost HTTP/u);
    await followUpTodoDetail('store retry', 'de');
    assert.equal(requests.length, 2); assert.equal(requests[0].clientMessageId, requests[1].clientMessageId);
    assert.equal(requests[1].expectedSessionId, 'original-session');
    assert.equal(useTodoDetailStore.getState().error, null);
  } finally {
    observeOpenedDocumentAuth(null);
    useTodoDetailStore.setState({ open: false, todo: null, todoId: null, loading: false, busy: false });
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousCrypto) Object.defineProperty(globalThis, 'crypto', previousCrypto); else Reflect.deleteProperty(globalThis, 'crypto');
  }
  console.log('PASS chat message transport: exact IDs, separate inline intent, captured channel arguments, nullable cold replay, Telegram provider IDs and scoped persistent Todo retries; no SQL/source/execution/provider authority claimed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });

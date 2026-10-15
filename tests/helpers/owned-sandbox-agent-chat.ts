import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, type APIResponse, type BrowserContext } from '@playwright/test';
import WebSocket from 'ws';
import type { AiAppRuntimeCatalog, AiCatalogProviderUpdate } from '../../app/lib/agent-runtime-policy/types';
import type { ServerMessage } from '../../app/lib/websocket/protocol';
import { projectAgentEventForExternal } from '../../app/lib/pi/visual-data-projection';
import { requireOwnedYjsQaTarget } from '../../scripts/lib/owned-yjs-authority-qa';
import type { OwnedModelStep, startOwnedAgentToolModel } from './owned-agent-tool-model';

type ModelFixture = Awaited<ReturnType<typeof startOwnedAgentToolModel>>;
type Packet = ServerMessage & Record<string, unknown>;
export type OwnedSandboxToolEnd = { toolCallId: string; toolName: string; isError: boolean; result: Record<string, unknown> };
export type OwnedSandboxChatClosure = {
  ownerId: string; workspaceId: string; agentId: string; sessionId: string;
  turns: Array<{ marker: string; done: string; toolResults: OwnedSandboxToolEnd[];
    finalStatus: Record<string, unknown>; messageSaved: true }>;
  sessionDeletion: { success: true; deleted: string };
  agentDeletion: { success: true; data: { deleted: true; agentId: string } };
};

const providersForUpdate = (catalog: AiAppRuntimeCatalog): AiCatalogProviderUpdate[] => catalog.providers.map(value => ({
  providerInstallationId: value.installationId, providerId: value.providerId, enabled: value.enabled,
  credentialScope: value.credentialScope, config: value.config,
  modelIds: value.models.filter(model => model.enabled).map(model => model.id),
  defaultModelId: value.models.find(model => model.isProviderDefault)?.id ?? '',
}));
const idle = (status: Record<string, unknown>) => status.phase === 'idle' && status.activeTool === null
  && status.pendingToolCalls === 0 && status.canAbort === false
  && Array.isArray(status.followUpQueue) && status.followUpQueue.length === 0
  && Array.isArray(status.steeringQueue) && status.steeringQueue.length === 0;
const text = (message: Record<string, unknown>) => typeof message.content === 'string' ? message.content
  : Array.isArray(message.content) ? message.content.map(part => part?.type === 'text' ? part.text : '').join('\n') : '';

/** Compare the real external projection, retaining every semantic receipt field.
 * Persistence finalizes display budgeting after the live tool-end event. Its
 * two top-level budget fields and its exact privacy-label spelling are the only
 * permitted differences; this does not erase nested native mutation receipts.
 */
export function comparableOwnedSandboxToolResult(result: Record<string, unknown>): unknown {
  const copy = structuredClone({ content: result.content, details: result.details });
  if (copy.details && typeof copy.details === 'object' && !Array.isArray(copy.details)) {
    delete (copy.details as Record<string, unknown>).toolOutput;
    delete (copy.details as Record<string, unknown>).toolOutputView;
  }
  const normalizePrivacyLabel = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replaceAll('[absolute server path omitted from persisted chat history]',
      '[absolute server path omitted from live event]');
    if (Array.isArray(value)) return value.map(normalizePrivacyLabel);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizePrivacyLabel(entry)]));
    return value;
  };
  return normalizePrivacyLabel(projectAgentEventForExternal({ type: 'tool_execution_end', result: copy }).result);
}

/** The normal authenticated chat creates its own actor/context/package bindings.
 * No direct tool endpoint, private runtime object, synthetic grant or replacement
 * collaboration handler participates in this acceptance path.
 */
export async function createOwnedSandboxAgentChat(input: {
  context: BrowserContext; workspaceId: string; ownerId: string; skillName: string; model: ModelFixture;
}) {
  const target = await requireOwnedYjsQaTarget();
  const origin = process.env.BASE_URL!;
  const request = input.context.request;
  const organizationId = process.env.CANVAS_ORGANIZATION_ID!;
  assert.equal(target.dataRoot, process.env.DATA);
  assert.match(input.skillName, /^native-sandbox-[a-z0-9][a-z0-9-]{7,39}$/u);
  assert.match(input.model.model, /^owned-sandbox-[a-f0-9]{16}$/u);
  assert.equal(new URL(input.model.origin).hostname, '127.0.0.1');
  assert.notEqual(input.model.origin, origin);
  const q = new URLSearchParams({ organizationId, workspaceId: input.workspaceId });
  const receipt = { phase: 'authenticate', pendingMutation: null as string | null,
    ownerId: input.ownerId, workspaceId: input.workspaceId, agentId: '', sessionId: '',
    originalCatalog: null as AiAppRuntimeCatalog | null, ownedCatalogRevision: 0,
    closure: null as OwnedSandboxChatClosure | null };
  let socket: WebSocket | undefined, closed = false, running = false;
  const packets: Packet[] = [], socketErrors: string[] = [];
  let packetBytes = 0;
  const json = async <T,>(response: APIResponse): Promise<T> => {
    try {
      assert(response.ok(), `Owned chat ${receipt.phase} returned HTTP ${response.status()}.`);
      const bytes = await response.body(); assert(bytes.length <= 4 * 1024 * 1024);
      const body = JSON.parse(bytes.toString()); assert.equal(body.success, true);
      return body as T;
    } finally { await response.dispose(); }
  };
  const mutate = async <T,>(phase: string, method: 'POST' | 'PUT' | 'DELETE', route: string, data?: unknown): Promise<T> => {
    receipt.phase = phase; receipt.pendingMutation = `${method} ${route}`;
    const result = await json<T>(await request.fetch(route, { method, data, maxRedirects: 0, timeout: 30_000 }));
    receipt.pendingMutation = null; return result;
  };
  const catalog = async () => (await json<{ data: { catalog: AiAppRuntimeCatalog } }>(
    await request.get('/api/admin/agent-runtime/catalog', { timeout: 30_000, maxRedirects: 0 }))).data.catalog;
  const exchange = async (type: 'get_status' | 'subscribe_session' | 'control', extra: Record<string, unknown> = {}) => {
    assert(socket?.readyState === WebSocket.OPEN);
    const requestId = randomUUID();
    socket.send(JSON.stringify({ type, sessionId: receipt.sessionId, requestId, ...extra }));
    const expected = type === 'get_status' ? 'status_result' : type === 'control' ? 'control_result' : 'subscribe_result';
    await expect.poll(() => {
      assert.deepEqual(socketErrors, []);
      return packets.some(packet => packet.type === expected && packet.requestId === requestId);
    }, { timeout: 30_000 }).toBe(true);
    const result = packets.find(packet => packet.type === expected && packet.requestId === requestId)!;
    assert.equal(result.success, true); return result;
  };
  const status = async () => {
    const result = await exchange('get_status');
    assert(result.status && typeof result.status === 'object'); return result.status as Record<string, unknown>;
  };
  const closeSocket = async () => {
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    const held = socket;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => held.terminate(), 2_000);
      held.once('close', () => { clearTimeout(timer); resolve(); }); held.close();
    });
    assert.equal(held.readyState, WebSocket.CLOSED);
  };
  const fail = async (cause: unknown): Promise<never> => {
    // A failed/uncertain turn never receives a positive cleanup receipt. Abort
    // the held normal session when possible, close only our socket, preserve DATA.
    if (socket?.readyState === WebSocket.OPEN && receipt.sessionId) {
      try { await exchange('control', { action: 'abort' }); await expect.poll(async () => idle(await status()), { timeout: 30_000 }).toBe(true); }
      catch { /* Preserve original error plus the incomplete receipt. */ }
    }
    await closeSocket();
    throw Object.assign(new Error(`Owned sandbox chat stopped during ${receipt.phase}; preserve its fixture.`, { cause }),
      { cleanupReceipt: structuredClone(receipt) });
  };
  try {
    const auth = await request.get('/api/auth/get-session', { timeout: 30_000, maxRedirects: 0 });
    try { assert(auth.ok()); assert.equal((await auth.json()).user?.id, input.ownerId); } finally { await auth.dispose(); }
    const settings = await json<{ data: { documentReviewEnabled: boolean } }>(await request.get('/api/server-settings'));
    assert.equal(settings.data.documentReviewEnabled, false, 'This acceptance requires Review Center to remain disabled.');
    const original = await catalog(); receipt.originalCatalog = original;
    const configured = await mutate<{ data: { catalog: AiAppRuntimeCatalog } }>('configure-owned-provider', 'PUT', '/api/admin/agent-runtime/catalog', {
      expectedRevision: original.revision,
      providers: [...providersForUpdate(original).filter(value => !(value.providerId === 'ollama' && value.credentialScope === 'system')),
        { providerId: 'ollama', enabled: true, credentialScope: 'system', modelIds: [input.model.model], defaultModelId: input.model.model,
          config: { ollamaMode: 'local', ollamaHost: input.model.origin, ollamaModelSource: 'custom', ollamaCustomModel: input.model.model } }],
      defaultSelection: null,
    });
    receipt.ownedCatalogRevision = configured.data.catalog.revision;
    const installation = configured.data.catalog.providers.find(value => value.providerId === 'ollama' && value.credentialScope === 'system');
    assert(installation && installation.config.ollamaHost === input.model.origin);
    const verified = await mutate<{ data: { success: boolean; status: string } }>('verify-owned-provider', 'POST',
      `/api/admin/agent-runtime/providers/${encodeURIComponent(installation.installationId)}/verify`);
    assert.equal(verified.data.success, true); assert.equal(verified.data.status, 'ready');
    const ready = await catalog(); receipt.ownedCatalogRevision = ready.revision;
    assert.equal(ready.providers.find(value => value.installationId === installation.installationId)?.status, 'ready');
    const created = await mutate<{ data: { agent: { agentId: string; createdByUserId: string; scopeType: string } } }>(
      'create-owned-agent', 'POST', `/api/agents?${q}`, { name: `Native sandbox ${input.model.model.slice(-16)}`, scopeType: 'user',
        enabledTools: ['bash', 'read', 'edit_file', 'list_canvas_skill_scripts', 'describe_canvas_skill_script', 'run_canvas_skill_script'],
        relevantSkills: [input.skillName], relevantConnections: [], expectedCatalogRevision: ready.revision,
        defaultProviderInstallationId: installation.installationId, defaultProvider: 'ollama', defaultModel: input.model.model, defaultThinking: 'off' });
    receipt.agentId = created.data.agent.agentId;
    assert.equal(created.data.agent.createdByUserId, input.ownerId); assert.equal(created.data.agent.scopeType, 'user');
    assert.match(receipt.agentId, /^[a-z0-9][a-z0-9_-]{0,63}$/u);
    const createdSession = await mutate<{ session: { sessionId: string; agentId: string } }>('create-owned-session', 'POST', '/api/sessions', {
      agentId: receipt.agentId, workspaceId: input.workspaceId, clientRequestId: randomUUID(), title: `Native sandbox ${input.model.model.slice(-16)}`,
    });
    receipt.sessionId = createdSession.session.sessionId; assert.equal(createdSession.session.agentId, receipt.agentId);
    assert(receipt.sessionId);
    receipt.closure = { ownerId: input.ownerId, workspaceId: input.workspaceId, agentId: receipt.agentId, sessionId: receipt.sessionId,
      turns: [], sessionDeletion: null!, agentDeletion: null! };
    const cookie = (await input.context.cookies(origin)).map(item => `${item.name}=${item.value}`).join('; '); assert(cookie);
    socket = new WebSocket(`${origin.replace(/^http/u, 'ws')}/ws/chat`, 'canvas-chat-v1', {
      headers: { Cookie: cookie, Origin: origin, 'x-canvas-workspace-id': input.workspaceId }, maxPayload: 2 * 1024 * 1024,
      handshakeTimeout: 10_000, followRedirects: false,
    });
    socket.on('error', () => socketErrors.push('owned_socket_error'));
    socket.on('message', raw => {
      const serialized = raw.toString();
      packetBytes += Buffer.byteLength(serialized);
      if (packetBytes > 8 * 1024 * 1024 || packets.length >= 4_096) { socketErrors.push('owned_socket_budget'); socket?.terminate(); return; }
      try { packets.push(JSON.parse(serialized) as Packet); }
      catch { socketErrors.push('owned_socket_invalid_json'); socket?.terminate(); }
    });
    await expect.poll(() => packets.find(packet => packet.type === 'auth_success')?.userId, { timeout: 30_000 }).toBe(input.ownerId);
    await exchange('subscribe_session'); receipt.phase = 'ready';
  } catch (cause) { return fail(cause); }
  return {
    agentId: receipt.agentId, sessionId: receipt.sessionId,
    async turn(marker: string, steps: readonly OwnedModelStep[]) {
      try {
        assert(!closed && !running && !receipt.pendingMutation); running = true; receipt.phase = `turn:${marker}`;
        const done = input.model.arm(marker, steps), offset = packets.length;
        assert(socket?.readyState === WebSocket.OPEN);
        const requestId = randomUUID();
        socket.send(JSON.stringify({ type: 'send_message', requestId, sessionId: receipt.sessionId, agentId: receipt.agentId,
          clientMessageId: randomUUID(), message: { role: 'user', content: marker, timestamp: Date.now() } }));
        await expect.poll(() => packets.slice(offset).some(packet => packet.type === 'send_message_result' && packet.requestId === requestId), { timeout: 30_000 }).toBe(true);
        assert.equal(packets.slice(offset).find(packet => packet.type === 'send_message_result' && packet.requestId === requestId)?.success, true);
        await expect.poll(() => packets.slice(offset).some(packet => packet.type === 'agent_event' && packet.sessionId === receipt.sessionId
          && packet.event.type === 'message_saved'), { timeout: 90_000 }).toBe(true);
        await expect.poll(async () => idle(await status()), { timeout: 30_000 }).toBe(true);
        const finalStatus = await status(); assert(idle(finalStatus)); assert.deepEqual(socketErrors, []);
        const response = await json<{ messages: Array<Record<string, unknown>>; hasMoreBefore: boolean; hasMoreAfter: boolean }>(
          await request.get(`/api/sessions/messages?${new URLSearchParams({ sessionId: receipt.sessionId, agentId: receipt.agentId,
            workspaceId: input.workspaceId, raw: 'true', limit: '200' })}`, { timeout: 30_000, maxRedirects: 0 }));
        assert.equal(response.hasMoreBefore, false); assert.equal(response.hasMoreAfter, false);
        const start = response.messages.findLastIndex(message => message.role === 'user' && text(message) === marker);
        assert(start >= 0); const messages = response.messages.slice(start);
        const final = messages.at(-1)!; assert.equal(final.role, 'assistant'); assert.equal(text(final), done); assert.equal(final.stopReason, 'stop');
        const model = input.model.evidence(); assert.equal(model.active?.completed, true); assert.deepEqual(model.failures, []);
        const toolResults: OwnedSandboxToolEnd[] = packets.slice(offset).flatMap(packet => {
          if (packet.type !== 'agent_event' || packet.sessionId !== receipt.sessionId || packet.event.type !== 'tool_execution_end') return [];
          const event = packet.event;
          assert.equal(typeof event.toolCallId, 'string'); assert.equal(typeof event.toolName, 'string');
          assert(event.result && typeof event.result === 'object');
          return [{ toolCallId: event.toolCallId as string, toolName: event.toolName as string,
            isError: event.isError === true, result: event.result as Record<string, unknown> }];
        });
        assert.equal(toolResults.length, model.active!.issued.length);
        for (const [index, issued] of model.active!.issued.entries()) {
          const observed = toolResults[index]; assert.equal(observed.toolCallId, issued.id); assert.equal(observed.toolName, issued.name);
          const saved = messages.filter(message => message.role === 'toolResult' && message.toolCallId === issued.id);
          assert.equal(saved.length, 1); assert.equal(saved[0].toolName, issued.name); assert.equal(saved[0].isError, observed.isError);
          assert.deepEqual(comparableOwnedSandboxToolResult(saved[0]), comparableOwnedSandboxToolResult(observed.result));
        }
        receipt.closure!.turns.push({ marker, done, toolResults, finalStatus, messageSaved: true });
        running = false; receipt.phase = 'ready';
        return { events: structuredClone(packets.slice(offset)) as Array<Record<string, unknown>>, messages, model };
      } catch (cause) { return fail(cause); }
    },
    async close() {
      try {
        assert(!closed && !running && receipt.closure?.turns.length && !receipt.pendingMutation);
        assert(input.model.evidence().active?.completed); assert(idle(await status()));
        await closeSocket();
        const sessionDeletion = await mutate<OwnedSandboxChatClosure['sessionDeletion']>('delete-owned-session', 'DELETE',
          `/api/sessions?${new URLSearchParams({ agentId: receipt.agentId, sessionId: receipt.sessionId })}`);
        assert.deepEqual(sessionDeletion, { success: true, deleted: receipt.sessionId }); receipt.closure.sessionDeletion = sessionDeletion;
        const preview = await mutate<{ data: { agent: { agentId: string; createdByUserId: string; revision: number }; impacts: { sessions: number }; confirmationToken: string } }>(
          'preview-owned-agent-delete', 'POST', `/api/agents/delete-preview?${q}`, { agentId: receipt.agentId });
        assert.equal(preview.data.agent.agentId, receipt.agentId); assert.equal(preview.data.agent.createdByUserId, input.ownerId);
        assert.equal(preview.data.impacts.sessions, 0);
        const agentDeletion = await mutate<OwnedSandboxChatClosure['agentDeletion']>('delete-owned-agent', 'DELETE', `/api/agents?${q}`, {
          agentId: receipt.agentId, expectedRevision: preview.data.agent.revision, confirmationToken: preview.data.confirmationToken });
        assert.deepEqual(agentDeletion, { success: true, data: { deleted: true, agentId: receipt.agentId } }); receipt.closure.agentDeletion = agentDeletion;
        const current = await catalog(); assert.equal(current.revision, receipt.ownedCatalogRevision);
        const original = receipt.originalCatalog!;
        const restored = await mutate<{ data: { catalog: AiAppRuntimeCatalog } }>('restore-owned-catalog', 'PUT', '/api/admin/agent-runtime/catalog', {
          expectedRevision: current.revision, providers: providersForUpdate(original), defaultSelection: original.defaultSelection });
        assert.deepEqual(providersForUpdate(restored.data.catalog), providersForUpdate(original));
        assert.deepEqual(restored.data.catalog.defaultSelection, original.defaultSelection);
        closed = true; receipt.phase = 'closed';
        return { sessionId: receipt.sessionId, agentId: receipt.agentId, sessionDeleted: true as const, agentDeleted: true as const,
          providerRestored: true as const, allTurnsCompleted: true as const, closure: structuredClone(receipt.closure) };
      } catch (cause) { return fail(cause); }
    },
  };
}

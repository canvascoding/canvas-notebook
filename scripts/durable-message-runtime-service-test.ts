import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Api, AssistantMessage, Model, StreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
import type { SqlConnection } from '../app/lib/db';
import type { ChatRequestContext } from '../app/lib/chat/types';
import type { ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';
import type { ChatExtensionSelectionInput } from '../app/lib/capabilities/extensions/contracts';
import type { UserAgentMessage } from '../app/lib/pi/runtime-service';
import { createDurableMessageExecutionFixture } from './helpers/durable-message-execution-fixture';

/** Real Service, SQL, actor/session/Use, source preparation, Runtime factory and
 * SDK. Only the SDK's public provider stream and the existing SQL-transport
 * fault/barrier hooks are controlled; no authority/registry/policy is replaced.
 * This suite is PGlite-only; it makes no HTTP/WebSocket/browser acceptance claim.
 */
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Service fixture did not reach ${label}.`)), 25_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
type Receipt = { client_message_id: string; private_payload: string; payload_hash: string; execution_phase: string;
  execution_revision: number; queue_lane: string; queue_ordinal: number; runtime_token: string };
type Barrier = ReturnType<typeof deferred>;

async function main(): Promise<void> {
  assert.equal(process.argv.includes('--native'), false, 'This owned suite does not launch a native fixture.');
  const fixture = await createDurableMessageExecutionFixture();
  const application = fixture.application;
  const nonce = randomUUID().replaceAll('-', '');
  const prefix = `service-${nonce}-`;
  const holds = new Map<string, Barrier>(), entered = new Map<string, Barrier>();
  const frames: Awaited<ReturnType<typeof fixture.createSessionRuntime>>[] = [];
  const requestIds: string[] = [], abortedIds: string[] = [], failures: unknown[] = [];
  let restoreProvider: (() => void) | undefined;
  let stage = 'genuine service fixture setup';
  const sql = async <T>(operation: (database: SqlConnection) => Promise<T>): Promise<T> => {
    const database = await application.database.openDb();
    try { return await operation(database); } finally { await database.close(); }
  };
  try {
    const service = await import('../app/lib/pi/runtime-service');
    const admission = await import('../app/lib/pi/durable-message-admission');
    const { withPiSessionOperationLock } = await import('../app/lib/pi/session-operation-lock');
    const { createManagedAgent } = await import('../app/lib/agents/management-actions');
    const { publishMcpServerDefinition } = await import('../app/lib/mcp/server-definitions');
    const { createPersonalMcpConnection } = await import('../app/lib/mcp/personal-connections');
    const { readMcpConfig } = await import('../app/lib/mcp/config');
    const { createUploadAccessGrant } = await import('../app/lib/files/upload-access-store');
    const { projectChatBodyText } = await import('../app/lib/chat/chat-body-contracts');
    const { receiptFreeChatExtensionSelection, parseStoredAcceptedChatMessage } = await import('../app/lib/chat/durable-message-contracts');
    const submission = await import('../app/lib/chat/message-submission');
    const compat = await import('@earendil-works/pi-ai/compat');
    const piAi = await import('@earendil-works/pi-ai');

    const definition = await publishMcpServerDefinition(application.organizationId, `Service MCP ${nonce}`,
      { url: 'https://203.0.113.74/mcp', transport: 'http', auth: 'none', enabled: true });
    const connection = await createPersonalMcpConnection('alice', definition.id, 'Service exact personal MCP');
    const connectionId = (await readMcpConfig({ userId: 'alice' })).mcpServers[connection.server]?.connectionId; assert(connectionId);
    const selection: ChatExtensionSelectionInput = { version: 1, origin: 'turn_reference', selections: [{
      selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${connectionId}` } },
      requirement: 'optional', toolCap: ['fixture_read'],
    }] };
    const body: ChatBodyV1 = { version: 1, parts: [{ type: 'text', text: 'Use ' },
      { type: 'extension_reference', occurrenceId: 'first', bundleId: 'mcp' }, { type: 'text', text: ' for this turn.' }],
    bundles: [{ id: 'mcp', caption: 'Exact personal MCP', primary: selection.selections[0], supporting: [], packageConnections: [] }] };
    const created = await createManagedAgent({ ...application.owner, source: 'api' }, {
      name: `Service admission ${nonce}`, scopeType: 'organization', enabledTools: ['read', 'mcp'],
      defaultProviderInstallationId: fixture.model.providerInstallationId, defaultProvider: fixture.model.providerId,
      defaultModel: fixture.model.modelId, defaultThinking: 'off', expectedCatalogRevision: fixture.model.expectedCatalogRevision,
      extensions: { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null,
        standalone: [{ mode: 'selectable', configurationId: 'service-mcp', source: 'mcp', requirement: 'optional',
          allowedChoices: [], personalPolicy: { source: 'mcp', serverDefinitionIds: [definition.id], toolCap: ['fixture_read'] } }] },
      grants: [{ targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false }],
    });
    const agentId = created.agent.agentId;
    const frame = await fixture.createSessionRuntime({ userId: 'alice', agentId }); frames.push(frame);
    const rows = async (sessionId = frame.sessionId): Promise<Receipt[]> => sql(database => database.all(`SELECT r.client_message_id,
      r.private_payload,r.payload_hash,r.execution_phase,r.execution_revision,r.queue_lane,r.queue_ordinal,r.runtime_token
      FROM pi_message_delivery_receipts r JOIN pi_sessions s ON s.id=r.pi_session_db_id
      WHERE s.user_id='alice' AND s.session_id=$1 ORDER BY r.queue_ordinal`, [sessionId]) as Promise<Receipt[]>);
    const row = async (id: string, sessionId = frame.sessionId) => {
      const value = (await rows(sessionId)).find(candidate => candidate.client_message_id === id); assert(value); return value;
    };
    const message = (id: string, content: UserAgentMessage['content'] = `Exact service message ${id}`): UserAgentMessage =>
      ({ role: 'user', content, timestamp: 123, clientMessageId: id });
    const waitRequest = (id: string) => {
      const value = entered.get(id) ?? deferred(); entered.set(id, value); return bounded(value.promise, `provider ${id}`);
    };
    const hold = (id: string) => { const value = deferred(); holds.set(id, value); return value; };
    const response = (model: Model<Api>, stopReason: AssistantMessage['stopReason']): AssistantMessage => ({
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: stopReason === 'stop' ? [{ type: 'text', text: 'Service boundary completed.' }] : [], stopReason, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const api = frame.runtime.model.api, previousProvider = compat.getApiProvider(api), registrationId = `service-provider-${nonce}`;
    const controlledStream = (model: Model<Api>, _context: TranscriptContext, options?: StreamOptions) => {
      const stream = piAi.createAssistantMessageEventStream();
      void (async () => {
        assert.equal(model.id, fixture.model.modelId); assert.equal(model.provider, fixture.model.providerId);
        const running = await sql(database => database.all(`SELECT r.client_message_id,r.execution_revision FROM pi_message_delivery_receipts r
          JOIN pi_sessions s ON s.id=r.pi_session_db_id WHERE s.user_id='alice' AND r.execution_phase='running'
          AND r.client_message_id LIKE $1`, [`${prefix}%`]) as Promise<{ client_message_id: string; execution_revision: number }[]>);
        assert.equal(running.length, 1, 'The actual service request has exactly one claimed/running SQL source.');
        const id = running[0].client_message_id;
        assert.equal(Number(running[0].execution_revision), 3);
        requestIds.push(id);
        const partial = response(model, 'stop'); stream.push({ type: 'start', partial: { ...partial, content: [] } });
        const reached = entered.get(id) ?? deferred(); entered.set(id, reached); reached.resolve();
        const gate = holds.get(id);
        if (gate) {
          let onAbort: (() => void) | undefined;
          try {
            await Promise.race([gate.promise, new Promise<void>(resolve => {
              onAbort = () => resolve();
              if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener('abort', onAbort, { once: true });
            })]);
          } finally { if (onAbort) options?.signal?.removeEventListener('abort', onAbort); }
        }
        if (options?.signal?.aborted) {
          abortedIds.push(id);
          stream.push({ type: 'error', reason: 'aborted', error: response(model, 'aborted') });
        } else stream.push({ type: 'done', reason: 'stop', message: response(model, 'stop') });
      })().catch(error => {
        failures.push(error);
        for (const reached of entered.values()) reached.resolve();
        stream.push({ type: 'error', reason: 'error', error: { ...response(model, 'error'), errorMessage: 'Service transport assertion failed.' } });
      });
      return stream;
    };
    compat.registerApiProvider({ api, stream: controlledStream, streamSimple: controlledStream }, registrationId);
    restoreProvider = () => { compat.unregisterApiProviders(registrationId); if (previousProvider) compat.registerApiProvider(previousProvider); };

    stage = 'missing IDs, mismatched transport IDs and accessor rejection before SQL';
    const invalid = { code: 'AGENT_MESSAGE_ADMISSION_INVALID', status: 400 };
    let reads = 0, getterCalls = 0;
    application.setBeforeRead(async () => { reads++; });
    await assert.rejects(service.sendMessage(frame.sessionId, 'alice', { role: 'user', content: 'No logical send ID', timestamp: 1 }), invalid);
    const getterMessage = Object.defineProperty({ role: 'user', content: 'A getter may not execute', timestamp: 1 }, 'clientMessageId',
      { enumerable: true, get: () => { getterCalls++; return `${prefix}getter`; } });
    await assert.rejects(service.sendMessage(frame.sessionId, 'alice', getterMessage as UserAgentMessage), invalid);
    assert.throws(() => submission.resolveChatClientMessageId(`${prefix}outer`, `${prefix}nested`), { code: 'INVALID_CLIENT_MESSAGE_ID' });
    assert.throws(() => submission.resolveChatClientMessageId(undefined, undefined), { code: 'INVALID_CLIENT_MESSAGE_ID' });
    assert.equal(submission.resolveChatClientMessageId(`${prefix}same`, `${prefix}same`), `${prefix}same`);
    assert.equal(reads, 0); assert.equal(getterCalls, 0);
    application.setBeforeRead(undefined); assert.equal((await rows()).length, 0);

    stage = 'synchronous capture before the real session operation lock can await';
    const lockEntered = deferred(), releaseLock = deferred();
    const locking = withPiSessionOperationLock(frame.sessionId, 'alice', async () => { lockEntered.resolve(); await releaseLock.promise; });
    await bounded(lockEntered.promise, 'the actual session operation lock');
    const captureId = `${prefix}capture`;
    const original = message(captureId, [{ type: 'text', text: 'Original exact content', textSignature: 'exact-signature' }]);
    const context: ChatRequestContext = { activeFilePath: 'before.md', currentPage: '/chat', planningMode: false };
    const sent = service.sendMessage(frame.sessionId, 'alice', original, context);
    original.content = 'Mutated after submission'; original.timestamp = 999; original.clientMessageId = `${prefix}changed`;
    context.activeFilePath = 'after.md'; context.planningMode = true;
    releaseLock.resolve(); await locking; await bounded(sent, 'captured admission ACK');
    await waitRequest(captureId); await bounded(frame.runtime.agent.waitForIdle(), 'captured SDK settlement');
    const captured = parseStoredAcceptedChatMessage(JSON.parse((await row(captureId)).private_payload));
    assert.deepEqual(captured.message, { role: 'user', content: [{ type: 'text', text: 'Original exact content', textSignature: 'exact-signature' }], timestamp: 123 });
    assert.equal(captured.context.activeFilePath, 'before.md'); assert.equal(captured.context.planningMode, false);
    assert.equal((await row(captureId)).execution_phase, 'succeeded'); assert.deepEqual(failures, []);

    stage = 'metadata-only upload ACL rejects missing/foreign IDs before commit';
    const foreignUpload = `${nonce}-foreign.png`, missingUpload = `${nonce}-missing.png`;
    await createUploadAccessGrant({ fileId: foreignUpload, ownerUserId: 'bob', workspaceId: null,
      storagePath: `image/${foreignUpload}`, originalName: 'Private bob image.png', mimeType: 'image/png', category: 'image', sizeBytes: 1, createdAt: 1 });
    const beforeUploads = await rows(), beforeRequests = requestIds.length;
    for (const [label, fileId] of [['missing', missingUpload], ['foreign', foreignUpload]] as const) {
      await assert.rejects(service.sendMessage(frame.sessionId, 'alice', message(`${prefix}upload-${label}`,
        [{ type: 'image', data: `/api/files/${fileId}`, mimeType: 'image/png' }])), /Upload attachment is not available/u);
    }
    assert.deepEqual(await rows(), beforeUploads); assert.equal(requestIds.length, beforeRequests);

    stage = 'cold replay after real admission/invalidation does not create or hydrate a runtime';
    const cold = await fixture.createSessionRuntime({ userId: 'alice', agentId }); frames.push(cold);
    const coldId = `${prefix}cold`, coldMessage = message(coldId);
    const coldContext: ChatRequestContext = { studioContext: { outputFilePath: '/not-a-readable-studio-file.png' }, activeFilePath: 'cold-exact.md' };
    const prepared = await admission.prepareChatMessageAdmission({ userId: 'alice', sessionId: cold.sessionId,
      clientMessageId: coldId, message: { role: 'user', content: coldMessage.content, timestamp: coldMessage.timestamp }, context: coldContext });
    assert.equal(prepared.kind, 'prepared'); if (prepared.kind !== 'prepared') throw new Error('Expected actual cold preparation.');
    await admission.commitPreparedChatMessageAdmission(prepared.admission);
    await fixture.runtimeApi.invalidatePiRuntime(cold.sessionId, 'alice');
    assert.equal(await fixture.runtimeApi.getExistingPiRuntime(cold.sessionId, 'alice'), null);
    const coldRows = await rows(cold.sessionId), countsBefore = fixture.counts(), requestsBeforeCold = requestIds.length;
    let forbiddenMetadata = 0;
    application.setBeforeRead(async query => {
      if (/\b(?:agent_capability_bindings|agent_user_preferences|canvas_ai_catalog|capability_resources|integration_connections)\b/iu.test(query)) {
        forbiddenMetadata++; throw new Error('Cold replay must not prepare sources, tools or models.');
      }
    });
    application.setBeforeFetch(async () => { forbiddenMetadata++; throw new Error('Cold replay may not hydrate provider metadata.'); });
    try {
      assert.equal(await service.sendMessage(cold.sessionId, 'alice', coldMessage, coldContext), null);
      assert.equal(await service.control(cold.sessionId, 'alice', 'replace', coldMessage, undefined, coldContext), null);
      assert.equal(await fixture.runtimeApi.getExistingPiRuntime(cold.sessionId, 'alice'), null);
      assert.equal(forbiddenMetadata, 0); assert.equal(requestIds.length, requestsBeforeCold);
      assert.deepEqual(fixture.counts(), countsBefore);
    } finally { application.setBeforeRead(undefined); application.setBeforeFetch(undefined); }
    assert.deepEqual(await rows(cold.sessionId), coldRows, 'Cold replay never claims, cancels, changes mode, or rewrites accepted intent.');

    stage = 'queued inline body and exact selection stay distinct from active SDK state';
    const activeId = `${prefix}active`, activeHold = hold(activeId);
    await service.sendMessage(frame.sessionId, 'alice', message(activeId), { activeFilePath: 'active.md' });
    await waitRequest(activeId);
    const activePrompt = frame.runtime.agent.state.systemPrompt, activeTools = frame.runtime.agent.state.tools;
    const queuedId = `${prefix}body`, queueMessage = message(queuedId, projectChatBodyText(body));
    await service.sendFollowUpMessage(frame.sessionId, 'alice', queueMessage, { activeFilePath: 'queued.md' },
      { expectedAgentId: agentId }, { body, selection, expectedWorkspaceId: frame.context.workspaceId });
    const queuedRow = await row(queuedId), storedQueued = parseStoredAcceptedChatMessage(JSON.parse(queuedRow.private_payload));
    assert.equal(queuedRow.execution_phase, 'queued'); assert.equal(Number(queuedRow.execution_revision), 1);
    assert.equal(queuedRow.queue_lane, 'follow_up'); assert.deepEqual(storedQueued.body, body);
    assert.deepEqual(storedQueued.extensionSelection?.publicSelection, receiptFreeChatExtensionSelection(selection));
    assert.equal(storedQueued.context.activeFilePath, 'queued.md'); assert.equal(storedQueued.message.content, projectChatBodyText(body));
    assert.equal(frame.runtime.agent.state.systemPrompt, activePrompt); assert.equal(frame.runtime.agent.state.tools, activeTools);
    assert.equal(requestIds.includes(queuedId), false);

    stage = 'atomic replacement cancels exact waiting SQL targets; replay neither aborts nor recancels';
    const siblingId = `${prefix}sibling`;
    await service.control(frame.sessionId, 'alice', 'follow_up', message(siblingId), undefined, { activeFilePath: 'sibling.md' });
    const beforeReplacement = await rows(), replaceId = `${prefix}replace`, replaceMessage = message(replaceId);
    const replaceHold = hold(replaceId);
    await bounded(service.control(frame.sessionId, 'alice', 'replace', replaceMessage, undefined, { activeFilePath: 'replace.md' }), 'replacement ACK');
    await waitRequest(replaceId);
    for (const id of [queuedId, siblingId]) {
      const cancelled = await row(id), before = beforeReplacement.find(value => value.client_message_id === id); assert(before);
      assert.equal(cancelled.execution_phase, 'cancelled'); assert.equal(Number(cancelled.execution_revision), 2);
      assert.equal(cancelled.private_payload, before.private_payload); assert.equal(cancelled.payload_hash, before.payload_hash);
      assert.equal(requestIds.includes(id), false);
    }
    assert.deepEqual(abortedIds, [activeId], 'Only the actual preceding request is aborted by the fresh replace.');
    const lateId = `${prefix}late`;
    await service.control(frame.sessionId, 'alice', 'follow_up', message(lateId), undefined, { activeFilePath: 'late.md' });
    const beforeReplay = await rows(), requestsBeforeReplay = [...requestIds], abortedBeforeReplay = [...abortedIds];
    await service.control(frame.sessionId, 'alice', 'replace', replaceMessage, undefined, { activeFilePath: 'replace.md' });
    assert.deepEqual(await rows(), beforeReplay, 'An accepted replace replay never mutates any later queued sibling.');
    assert.deepEqual(requestIds, requestsBeforeReplay); assert.deepEqual(abortedIds, abortedBeforeReplay);
    assert.equal((await row(lateId)).execution_phase, 'queued'); assert.equal((await row(replaceId)).execution_phase, 'running');
    replaceHold.resolve(); activeHold.resolve(); await waitRequest(lateId);
    await bounded(frame.runtime.agent.waitForIdle(), 'replacement and later sibling settlement');
    assert.equal((await row(lateId)).execution_phase, 'succeeded'); assert.equal((await row(replaceId)).execution_phase, 'succeeded');
    assert.deepEqual(failures, []); assert.equal(fixture.counts().forbiddenModelRequests, 0); assert.equal(fixture.counts().externalRequests, 0);
    console.log('PASS durable runtime service: actual SQL/source/Runtime/SDK admission, pre-await capture, cold replay, upload ACL, exact queued body and atomic replacement replay.');
  } catch (error) {
    console.error(`FAIL durable runtime service at ${stage}:`, error); throw error;
  } finally {
    application.setBeforeRead(undefined); application.setAfterRead(undefined); application.setAfterQuery(undefined); application.setBeforeFetch(undefined);
    for (const gate of holds.values()) gate.resolve();
    try {
      for (const frame of frames) await bounded(frame.runtime.agent.waitForIdle(), 'owned SDK cleanup');
    } finally { restoreProvider?.(); await fixture.close(); }
  }
}
void main();

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BeforeToolCallContext } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Model, TranscriptContext } from '@earendil-works/pi-ai';
import type { SqlConnection } from '../app/lib/db';
import type { OwnedAcceptedChatMessage } from '../app/lib/pi/durable-message-admission';
import type { StoredAcceptedChatMessage } from '../app/lib/chat/durable-message-contracts';
import { projectChatBodyText, type ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';
import type { ChatMessageQueueUpdate } from '../app/lib/pi/durable-message-queue';
import type { ChatExtensionSelectionInput } from '../app/lib/capabilities/extensions/contracts';
import { createDurableMessageExecutionFixture } from './helpers/durable-message-execution-fixture';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';

// Actual Runtime factory/registry, SDK, SQL, Use and source preparation. Only
// the SDK's public API-provider stream boundary is controlled. A real read tool
// still runs, and real session persistence/settlement crosses explicit barriers.
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`The controlled SDK did not reach ${label}.`)), 20_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
type Row = { client_message_id: string; execution_phase: string; execution_revision: number; private_payload: string; payload_hash: string };
type Expected = { owned: OwnedAcceptedChatMessage; serverId: string; providerRefs: string[]; packageRefs: string[]; activeFilePath: string;
  cancelled: readonly ChatMessageQueueUpdate[]; originalPayload: StoredAcceptedChatMessage };
type Request = { clientMessageId: string; prompt: string; tools: string[]; phase: string; revision: number };

function referenceBody(selection: ChatExtensionSelectionInput): ChatBodyV1 {
  assert(selection.selections.length === 1 || selection.selections.length === 2);
  assert.equal(selection.packageConnections?.length ?? 0, 0, 'These fixture references are independent primaries, never invented plugin dependencies.');
  const parts: ChatBodyV1['parts'] = [{ type: 'text', text: 'Read the exact ' }];
  const bundles = selection.selections.map(({ selection: selected, requirement, toolCap }, index) => {
    if (index) parts.push({ type: 'text', text: ' ' });
    parts.push({ type: 'extension_reference', occurrenceId: `occurrence-${index}`, bundleId: `bundle-${index}` });
    return { id: `bundle-${index}`, caption: selection.selections.length === 1 ? 'selected source' : index === 0 ? 'selected' : 'source',
      primary: { selection: structuredClone(selected), requirement, toolCap: structuredClone(toolCap) }, supporting: [], packageConnections: [] };
  });
  parts.push({ type: 'text', text: ' and finish.' });
  return { version: 1, parts, bundles };
}

async function plainSdkSmoke(fixture: Awaited<ReturnType<typeof createDurableMessageExecutionFixture>>): Promise<void> {
  const service = await import('../app/lib/pi/durable-message-admission');
  const compat = await import('@earendil-works/pi-ai/compat');
  const piAi = await import('@earendil-works/pi-ai');
  const frame = await fixture.createSessionRuntime({ userId: 'alice' });
  const input = { userId: frame.userId, sessionId: frame.sessionId, clientMessageId: 'plain-sdk-smoke',
    message: { role: 'user' as const, content: 'Give a final short answer.', timestamp: 1 }, selection: null };
  const prepared = await service.prepareChatMessageAdmission(input); assert.equal(prepared.kind, 'prepared');
  if (prepared.kind !== 'prepared') throw new Error('A new genuine plain admission is required.');
  const owned = await service.commitPreparedChatMessageAdmission(prepared.admission);
  const original = service.readOwnedAcceptedChatMessageData(owned, frame.context);
  assert.equal(original.payload.extensionSelection, null);
  const api = frame.runtime.model.api, previous = compat.getApiProvider(api), registration = `plain-sdk-${randomUUID()}`;
  const requestReached = deferred(), failures: unknown[] = [];
  let requests = 0;
  const modelResponse = (model: Model<Api>, error?: unknown): AssistantMessage => ({ role: 'assistant', api: model.api,
    provider: model.provider, model: model.id, content: error ? [] : [{ type: 'text', text: 'Done.' }], stopReason: error ? 'error' : 'stop',
    timestamp: Date.now(), ...(error ? { errorMessage: 'Controlled plain SDK assertion failed.' } : {}),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const stream = (model: Model<Api>, context: TranscriptContext) => {
    const result = piAi.createAssistantMessageEventStream(); requests++;
    void (async () => {
      const current = await service.readOwnedAcceptedChatMessage({ userId: frame.userId, sessionId: frame.sessionId,
        clientMessageId: input.clientMessageId, expectedAgentId: frame.agentId, expectedWorkspaceId: frame.context.workspaceId }); assert(current);
      const actual = service.readOwnedAcceptedChatMessageData(current, frame.context);
      assert.equal(actual.phase, 'running'); assert.equal(actual.executionRevision, 3);
      assert.deepEqual(actual.payload, original.payload); assert.equal(model.id, fixture.model.modelId);
      assert(JSON.stringify(context.messages).includes(input.message.content));
      assert(piAi.getCurrentTools(context.messages).some(tool => tool.name === 'read'));
      const message = modelResponse(model);
      result.push({ type: 'start', partial: { ...message, content: [] } }); result.push({ type: 'done', reason: 'stop', message });
      requestReached.resolve();
    })().catch(error => { failures.push(error); result.push({ type: 'error', reason: 'error', error: modelResponse(model, error) }); requestReached.resolve(); });
    return result;
  };
  compat.registerApiProvider({ api, stream, streamSimple: stream }, registration);
  try {
    await frame.runtime.acceptOwnedMessage(owned);
    await bounded(requestReached.promise, 'plain fixed-empty provider boundary');
    await bounded(frame.runtime.agent.waitForIdle(), 'plain fixed-empty settlement');
    assert.equal(failures.length, 0); assert.equal(requests, 1);
    const final = await service.readOwnedAcceptedChatMessage({ userId: frame.userId, sessionId: frame.sessionId,
      clientMessageId: input.clientMessageId, expectedAgentId: frame.agentId, expectedWorkspaceId: frame.context.workspaceId }); assert(final);
    const actual = service.readOwnedAcceptedChatMessageData(final, frame.context);
    assert.equal(actual.phase, 'succeeded'); assert.equal(actual.executionRevision, 4); assert.deepEqual(actual.payload, original.payload);
    assert.equal(frame.runtime.getOwnedQueuedMessages().length, 0);
    console.log('PASS plain fixed-empty/null-selection SDK smoke: genuine Admission/Owner/Claim/Running3/provider/actual persistence/Succeeded4; one controlled provider stream, original payload unchanged.');
  } finally {
    try { if (frame.runtime.agent.state.isStreaming) { await frame.runtime.abort(); await bounded(frame.runtime.agent.waitForIdle(), 'plain SDK cleanup'); } }
    finally { compat.unregisterApiProviders(registration); if (previous) compat.registerApiProvider(previous); }
  }
}

async function main(): Promise<void> {
  const networkFetch = globalThis.fetch;
  const fixture = await createDurableMessageExecutionFixture();
  const application = fixture.application;
  const fixtureFetch = globalThis.fetch;
  const envKeys = ['COMPOSIO_API_KEY', 'COMPOSIO_BASE_URL', 'COMPOSIO_LOGGING_LEVEL'] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  const nonce = randomUUID();
  let composio: Awaited<ReturnType<typeof createComposioProviderFixture>> | undefined;
  let restoreProvider: (() => void) | undefined;
  const releaseAll: Array<() => void> = [];
  const frames: Array<Awaited<ReturnType<typeof fixture.createSessionRuntime>>> = [];
  const transportFailures: unknown[] = [];
  const blockedExternalAttempts: Array<{ origin: string; path: string; method: string }> = [];
  let primaryFailure: unknown;
  let stage = 'genuine metadata setup';
  const sql = async <T>(run: (database: SqlConnection) => Promise<T>): Promise<T> => {
    const database = await application.database.openDb();
    try { return await run(database); } finally { await database.close(); }
  };
  try {
    await plainSdkSmoke(fixture);
    if (process.argv.includes('--smoke')) return;
    const service = await import('../app/lib/pi/durable-message-admission');
    const queue = await import('../app/lib/pi/durable-message-execution');
    const management = await import('../app/lib/agents/management-actions');
    const profiles = await import('../app/lib/composio/composio-profiles');
    const { listPersonalWorkflowProviderAccountChoices } = await import('../app/lib/integration-tools/workflow-personal-bindings');
    const { createIntegrationProviderRef } = await import('../app/lib/integration-tools/references');
    const { readPersonalComposioAccountReference } = await import('../app/lib/composio/composio-shared-account-reference');
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    const turn = await import('../app/lib/capabilities/extensions/turn-runtime');
    const packages = await import('../app/lib/capabilities/packages/runtime-bindings');
    const effective = await import('../app/lib/capabilities/extensions/effective-context');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const packageActions = await import('../app/lib/capabilities/packages/actions');
    const activation = await import('../app/lib/capabilities/packages/activation');
    const personalActivation = await import('../app/lib/capabilities/activation-actions');
    const definitions = await import('../app/lib/mcp/server-definitions');
    const personalMcp = await import('../app/lib/mcp/personal-connections');
    const mcp = await import('../app/lib/mcp/config');
    const compat = await import('@earendil-works/pi-ai/compat');
    const piAi = await import('@earendil-works/pi-ai');

    composio = await createComposioProviderFixture();
    const composioOrigin = composio.baseUrl;
    let providerMetadataForbidden = false;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === composioOrigin) {
        assert(!providerMetadataForbidden, 'Dispatch/reissue must not renew account choices or probe Composio readiness.');
        assert.equal((init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(), 'GET');
        assert(['/api/v3.1/toolkits', '/api/v3.1/connected_accounts'].includes(url.pathname));
        return networkFetch(input, { ...init, redirect: 'error' });
      }
      if (url.origin === application.registry.baseUrl || url.origin === fixture.origin) return fixtureFetch(input, init);
      const blocked = { origin: url.origin, path: url.pathname,
        method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() };
      blockedExternalAttempts.push(blocked); console.log('Blocked SDK external transport attempt (no query/body/headers)', blocked);
      throw new Error('No external request is allowed outside the owned registry, model metadata and Composio metadata fixtures.');
    };
    process.env.COMPOSIO_API_KEY = ''; process.env.COMPOSIO_BASE_URL = composioOrigin; process.env.COMPOSIO_LOGGING_LEVEL = 'silent';
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: `fixture-${randomBytes(24).toString('hex')}` }],
      { secretScope: 'user', userId: 'alice' });
    await profiles.ensureDefaultComposioProfile('alice');
    const profile = await profiles.createComposioProfile({ ownerUserId: 'alice', name: 'Actual SDK account selection' });
    composio.accounts.set(profile.composioUserId, [
      { id: 'sdk-account-a', toolkit: 'canva', status: 'ACTIVE' }, { id: 'sdk-account-b', toolkit: 'canva', status: 'ACTIVE' },
    ]);
    const providerRef = createIntegrationProviderRef({ source: 'composio', profileId: profile.id, toolkit: 'canva',
      scope: { type: 'user', ownerUserId: 'alice', resourceId: `profile:${profile.id}:canva` } });
    const choices = await listPersonalWorkflowProviderAccountChoices({ actor: application.alice, providerRef,
      exactToolkit: { profileId: profile.id, toolkit: 'canva' } });
    assert.equal(choices.accounts.length, 2);
    const accountSelection = (accountId: string): ChatExtensionSelectionInput => {
      const choice = choices.accounts.find(value => readPersonalComposioAccountReference(value.accountSelectionRef).accountId === accountId); assert(choice);
      return { version: 1, origin: 'turn_reference', selections: [{ selection: { kind: 'composio', source: 'composio', toolkit: 'canva',
        target: { kind: 'personal', profileId: profile.id, accountBinding: 'account', accountId,
          connectionRef: `composio-personal:${profile.id}:${accountId}` } }, requirement: 'optional', toolCap: ['DESIGN_CREATE'], accountSelectionRef: choice.accountSelectionRef }] };
    };
    const packageName = `sdk-held-${nonce.slice(0, 8)}`;
    const archive = await application.registry.addPackage('application', 'plugin', packageName, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name: packageName, version: '1.0.0', skills: './skills', description: 'Actual immutable SDK source' }),
      'skills/sdk-held-source/SKILL.md': '---\nname: sdk-held-source\ndescription: Exact immutable SDK child\n---\n\nRead the selected local source.\n',
    }, plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(application.owner, {
      source: { kind: 'plugin', registryId: 'store-application', entryKey: packageName, version: '1.0.0', checksum: archive.checksum },
      ownership: { type: 'organization' }, grants: [application.owner, application.alice].map(actor => ({
        targetType: 'user' as const, targetId: actor.userId, canUse: true, canEdit: false, canManage: false })),
    });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const descriptor = await packageActions.inspectCapabilityPackage(application.owner, pin.resourceRef); assert(descriptor.state);
    await activation.setCapabilityPackageDefaultActivationAction(application.owner, pin.resourceRef, {
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: descriptor.state.packageRevision, expectedPublishedRevisionRef: pin.publishedRevisionRef,
      expectedDefaultEnabled: false, enabled: true });
    await personalActivation.setPersonalCapabilityActivation({ context: { userId: 'alice', organizationId: application.organizationId,
      workspaceId: application.alice.workspaceId, role: 'member' }, actorUserId: 'alice', resourceId: descriptor.sourceStamp.resourceId, enabled: true });
    const packageAndAccount = (): ChatExtensionSelectionInput => ({ ...accountSelection('sdk-account-a'), selections: [
      { selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null },
      ...accountSelection('sdk-account-a').selections,
    ] });
    const definition = await definitions.publishMcpServerDefinition(application.organizationId, 'Actual SDK MCP',
      { url: 'https://203.0.113.73/mcp', transport: 'http', auth: 'none', enabled: true });
    const connection = await personalMcp.createPersonalMcpConnection('alice', definition.id, 'Exact SDK MCP');
    const connectionId = (await mcp.readMcpConfig({ userId: 'alice' })).mcpServers[connection.server]?.connectionId; assert(connectionId);
    const mcpSelection: ChatExtensionSelectionInput = { version: 1, origin: 'turn_reference', selections: [{
      selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${connectionId}` } },
      requirement: 'optional', toolCap: ['read_fixture'],
    }] };
    const agent = await management.createManagedAgent({ ...application.owner, source: 'api' }, {
      name: `SDK durable ${nonce}`, scopeType: 'organization', enabledTools: ['read', 'mcp'],
      defaultProviderInstallationId: fixture.model.providerInstallationId, defaultProvider: fixture.model.providerId,
      defaultModel: fixture.model.modelId, defaultThinking: fixture.model.thinkingLevel, expectedCatalogRevision: fixture.model.expectedCatalogRevision,
      extensions: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' },
      grants: [{ targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false }],
    });

    const rows = async (sessionId: string): Promise<Row[]> => sql(database => database.all(`SELECT r.client_message_id,r.execution_phase,
      r.execution_revision,r.private_payload,r.payload_hash FROM pi_message_delivery_receipts r
      JOIN pi_sessions s ON s.id=r.pi_session_db_id WHERE s.session_id=$1 AND s.user_id='alice' ORDER BY r.queue_ordinal`, [sessionId]) as Promise<Row[]>);
    const fresh = async (sessionId: string, clientMessageId: string) => {
      const owned = await service.readOwnedAcceptedChatMessage({ userId: 'alice', sessionId, clientMessageId,
        expectedAgentId: agent.agent.agentId, expectedWorkspaceId: application.alice.workspaceId! });
      assert(owned); return owned;
    };
    const prepare = async (frame: Awaited<ReturnType<typeof fixture.createSessionRuntime>>, clientMessageId: string,
      selection: ChatExtensionSelectionInput | null, lane: 'prompt' | 'follow_up' | 'steer' = 'prompt',
      replacementTargets?: readonly OwnedAcceptedChatMessage[], body?: ChatBodyV1): Promise<Expected> => {
      const activeFilePath = `focus-${clientMessageId}.md`;
      if (body) assert.equal(projectChatBodyText(body), 'Read the exact selected source and finish.');
      const prepared = await service.prepareChatMessageAdmission({ userId: frame.userId, sessionId: frame.sessionId, clientMessageId,
        message: { role: 'user', content: 'Read the exact selected source and finish.', timestamp: 123 },
        context: { activeFilePath }, mode: lane === 'steer' ? 'steer' : 'message', selection, ...(body === undefined ? {} : { body }) });
      assert.equal(prepared.kind, 'prepared'); if (prepared.kind !== 'prepared') throw new Error('A genuine new preparation is required.');
      const admitted = replacementTargets === undefined
        ? { message: await service.commitPreparedChatMessageAdmission(prepared.admission, { lane }), cancelled: [] }
        : await service.commitPreparedChatMessageReplacement(prepared.admission, replacementTargets,
          { lane: lane === 'follow_up' ? 'follow_up' : 'prompt' });
      const owned = admitted.message;
      const stored = service.readOwnedAcceptedChatMessageData(owned, frame.context);
      const context = { ...frame.context, agentTurnId: stored.payload.serverMessageId,
        ...(stored.payload.extensionSelection ? { turnExtensions: stored.payload.extensionSelection.publicSelection } : {}) };
      const packageSelection = await packages.getAuthorizedAgentWorkflowPackageSelections(context);
      const source = await turn.reissueOwnedChatMessageRuntimeSelection(context, owned, { packageSelection });
      const issued = await effective.resolveEffectiveExtensionContext({ ...context, ...(source ? { turnExtensionSource: source } : {}) }, { packageSelection });
      const data = effective.readEffectiveExtensionContext(issued); assert(data);
      return { owned, serverId: stored.payload.serverMessageId, providerRefs: data.workflowProjection?.selectedProviders.map(value => value.providerRef) ?? [],
        packageRefs: data.packages.map(value => value.publishedRevisionRef), activeFilePath, cancelled: admitted.cancelled, originalPayload: stored.payload };
    };

    const requests: Request[] = [];
    let currentFrame: Awaited<ReturnType<typeof fixture.createSessionRuntime>> | undefined;
    let expected = new Map<string, Expected>();
    let respond: (clientMessageId: string, count: number) => AssistantMessage['content'] = () => [{ type: 'text', text: 'Done.' }];
    const responseCounts = new Map<string, number>();
    const requestReached = new Map<string, ReturnType<typeof deferred>>();
    let firstRequest = deferred();
    const responseMessage = (model: Model<Api>, content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage => ({
      role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const initial = await fixture.createSessionRuntime({ userId: 'alice', agentId: agent.agent.agentId });
    frames.push(initial);
    const api = initial.runtime.model.api, previousProvider = compat.getApiProvider(api), registrationId = `durable-sdk-${nonce}`;
    const controlledStream = (model: Model<Api>, context: TranscriptContext) => {
      const stream = piAi.createAssistantMessageEventStream();
      void (async () => {
        assert(currentFrame, 'Only this fixture’s selected Runtime may request the controlled transport.');
        assert.equal(model.id, fixture.model.modelId); assert.equal(model.provider, fixture.model.providerId);
        const state = await rows(currentFrame.sessionId), running = state.filter(row => row.execution_phase === 'running');
        assert.equal(running.length, 1); const active = running[0], selected = expected.get(active.client_message_id); assert(selected);
        assert.equal(Number(active.execution_revision), 3, 'Every model request is backed by the same current running execution revision.');
        const prompt = piAi.getCurrentSystemPrompt(context.messages), tools = piAi.getCurrentTools(context.messages).map(tool => tool.name).sort();
        for (const ref of selected.providerRefs) assert(prompt.includes(ref), 'The provider sees the exact current account route.');
        for (const [key, other] of expected) if (key !== active.client_message_id)
          for (const ref of other.providerRefs) if (!selected.providerRefs.includes(ref)) assert(!prompt.includes(ref), 'Queued accounts cannot leak into the current system prompt.');
        for (const ref of selected.packageRefs) assert(prompt.includes(ref));
        // Runtime continuation has its own SDK message, converted to user at
        // the provider boundary. It must not replace the original admitted
        // user's captured context or become a new durable message identity.
        const originalUser = context.messages.findLast(message => message.role === 'user'
          && Reflect.get(message, 'serverMessageId') === selected.serverId)
          ?? context.messages.findLast(message => message.role === 'user' && JSON.stringify(message).includes(selected.activeFilePath));
        assert(originalUser, 'The actual send retains the admitted user and its exact captured file context.');
        assert(JSON.stringify(originalUser).includes(selected.activeFilePath));
        const runningOwned = await fresh(currentFrame.sessionId, active.client_message_id);
        assert.equal(service.readOwnedAcceptedChatMessageData(runningOwned, currentFrame.context).payload.serverMessageId, selected.serverId);
        requests.push({ clientMessageId: active.client_message_id, prompt, tools, phase: active.execution_phase, revision: Number(active.execution_revision) });
        requestReached.get(active.client_message_id)?.resolve();
        const count = (responseCounts.get(active.client_message_id) ?? 0) + 1; responseCounts.set(active.client_message_id, count);
        const content = respond(active.client_message_id, count), toolUse = content.some(part => part.type === 'toolCall');
        const message = responseMessage(model, content, toolUse ? 'toolUse' : 'stop');
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: toolUse ? 'toolUse' : 'stop', message }); firstRequest.resolve();
      })().catch(error => {
        transportFailures.push(error); firstRequest.resolve();
        stream.push({ type: 'error', reason: 'error', error: { ...responseMessage(model, [], 'error'), errorMessage: 'Controlled SDK fixture assertion failed.' } });
      });
      return stream;
    };
    compat.registerApiProvider({ api, stream: controlledStream, streamSimple: controlledStream }, registrationId);
    restoreProvider = () => { compat.unregisterApiProviders(registrationId); if (previousProvider) compat.registerApiProvider(previousProvider); };
    const beginScenario = (frame: typeof initial, entries: Array<[string, Expected]>) => {
      currentFrame = frame; expected = new Map(entries); requests.length = 0; responseCounts.clear(); firstRequest = deferred();
      requestReached.clear(); for (const [key] of entries) requestReached.set(key, deferred());
    };
    const awaitEnd = async (frame: typeof initial) => {
      await bounded(firstRequest.promise, 'the first provider request');
      await bounded(frame.runtime.agent.waitForIdle(), 'SDK final persistence/settlement');
      if (transportFailures.length) throw new AggregateError(transportFailures, 'Controlled SDK provider-boundary assertions failed.');
    };
    const toolBarrier = (frame: typeof initial) => {
      const reached = deferred(), release = deferred(); releaseAll.push(release.resolve);
      const previous = frame.runtime.agent.beforeToolCall;
      frame.runtime.agent.beforeToolCall = async (context: BeforeToolCallContext, signal) => {
        const result = await previous?.(context, signal);
        if (context.toolCall.name === 'read') { reached.resolve(); await release.promise; }
        return result;
      };
      return { reached, release };
    };
    const writeReadFile = async (frame: typeof initial) => {
      await fs.mkdir(frame.context.workspaceRoot, { recursive: true });
      await fs.writeFile(path.join(frame.context.workspaceRoot, 'sdk-source.txt'), 'ACTUAL_LOCAL_READ_RESULT', 'utf8');
    };
    const readCall: AssistantMessage['content'] = [{ type: 'toolCall', id: 'sdk-actual-read', name: 'read', arguments: { path: 'sdk-source.txt' } }];

    stage = 'A stays active through actual tool and persistence; independent B/C follow-ups';
    await writeReadFile(initial);
    const aSelection = packageAndAccount(), bSelection = accountSelection('sdk-account-b');
    const a = await prepare(initial, 'follow-a', aSelection, 'prompt', undefined, referenceBody(aSelection));
    const b = await prepare(initial, 'follow-b', bSelection, 'follow_up', undefined, referenceBody(bSelection));
    const c = await prepare(initial, 'follow-c', mcpSelection, 'follow_up', undefined, referenceBody(mcpSelection));
    const originalRows = (await rows(initial.sessionId)).map(row => [row.client_message_id, row.private_payload, row.payload_hash]);
    assert.notDeepEqual(a.providerRefs, b.providerRefs); assert.equal(c.providerRefs.length, 1);
    assert(a.packageRefs.includes(pin.publishedRevisionRef));
    beginScenario(initial, [['follow-a', a], ['follow-b', b], ['follow-c', c]]);
    providerMetadataForbidden = true;
    respond = (key, count) => key === 'follow-a' && count === 1 ? readCall : [{ type: 'text', text: `Done ${key}.` }];
    const firstTool = toolBarrier(initial);
    await initial.runtime.acceptOwnedMessage(a.owned); await bounded(firstTool.reached.promise, 'A actual read preflight');
    const currentPrompt = initial.runtime.agent.state.systemPrompt, currentTools = initial.runtime.agent.state.tools.map(tool => tool.name);
    await initial.runtime.acceptOwnedMessage(b.owned); await initial.runtime.acceptOwnedMessage(c.owned);
    assert.equal(initial.runtime.agent.state.systemPrompt, currentPrompt);
    assert.deepEqual(initial.runtime.agent.state.tools.map(tool => tool.name), currentTools);
    assert.deepEqual((await rows(initial.sessionId)).map(row => [row.client_message_id, row.execution_phase, Number(row.execution_revision)]),
      [['follow-a', 'running', 3], ['follow-b', 'queued', 1], ['follow-c', 'queued', 1]]);
    assert.equal(initial.runtime.agent.steeringMode, 'one-at-a-time'); assert.equal(initial.runtime.agent.followUpMode, 'one-at-a-time');
    assert.equal(initial.runtime.getOwnedQueuedMessages().length, 2);
    const persistenceReached = deferred(), releasePersistence = deferred(); releaseAll.push(releasePersistence.resolve);
    const sessionDbId = service.readOwnedAcceptedChatMessageData(a.owned, initial.context).rowIdentity.sessionDbId;
    let insertedTranscript = false, persistenceHeld = false;
    application.setAfterQuery(async (query, params) => {
      if (/INSERT INTO pi_messages/u.test(query) && params[0] === sessionDbId) insertedTranscript = true;
      if (query.trim() === 'COMMIT' && insertedTranscript && !persistenceHeld) {
        persistenceHeld = true; persistenceReached.resolve(); await releasePersistence.promise;
      }
    });
    firstTool.release.resolve();
    try {
      await bounded(persistenceReached.promise, 'actual A transcript COMMIT');
      assert.equal(requests.length, 1, 'No next request or queue handoff can overtake A persistence.');
      assert.equal(initial.runtime.agent.state.systemPrompt, currentPrompt);
    } finally { releasePersistence.resolve(); }
    await awaitEnd(initial); application.setAfterQuery(undefined);
    assert.deepEqual(requests.map(request => request.clientMessageId), ['follow-a', 'follow-a', 'follow-b', 'follow-c']);
    assert.deepEqual((await rows(initial.sessionId)).map(row => [row.execution_phase, Number(row.execution_revision)]), [['succeeded', 4], ['succeeded', 4], ['succeeded', 4]]);
    assert.deepEqual((await rows(initial.sessionId)).map(row => [row.client_message_id, row.private_payload, row.payload_hash]), originalRows,
      'Runtime context activation never rewrites the durable body, attachments, intent hash or exact selection.');
    assert(initial.runtime.agent.state.messages.some(message => message.role === 'toolResult' && JSON.stringify(message).includes('ACTUAL_LOCAL_READ_RESULT')));
    assert.equal(initial.runtime.agent.state.messages.filter(message => message.role === 'user').length, 3, 'Equal text/timestamps with distinct durable IDs are separate messages.');
    assert.equal(initial.runtime.getOwnedQueuedMessages().length, 0);
    const persistedUsers = await sql(database => database.all(`SELECT content FROM pi_messages
      WHERE pi_session_db_id=$1 AND role='user' ORDER BY sequence`, [sessionDbId]) as Promise<Array<{ content: string }>>);
    assert.equal(persistedUsers.length, 3);
    for (const [index, selected] of [a, b, c].entries()) {
      const message = JSON.parse(persistedUsers[index].content) as Record<string, unknown>;
      assert.equal(message.clientMessageId, selected.originalPayload.clientMessageId);
      assert.equal(message.serverMessageId, selected.originalPayload.serverMessageId);
      assert.deepEqual(message.body, selected.originalPayload.body, 'History retains the exact admitted body, without a current-catalog reconstruction.');
      assert.deepEqual(message.content, selected.originalPayload.message.content); assert.equal(message.timestamp, selected.originalPayload.message.timestamp);
      assert(!JSON.stringify(message.body).includes('accountSelectionRef'));
    }

    stage = 'user steer switches accounts only after actual A tool settlement';
    providerMetadataForbidden = false;
    const steering = await fixture.createSessionRuntime({ userId: 'alice', agentId: agent.agent.agentId }); await writeReadFile(steering);
    frames.push(steering);
    const steerA = await prepare(steering, 'steer-a', accountSelection('sdk-account-a'));
    const steerB = await prepare(steering, 'steer-b', accountSelection('sdk-account-b'), 'steer');
    beginScenario(steering, [['steer-a', steerA], ['steer-b', steerB]]);
    providerMetadataForbidden = true;
    respond = (key, count) => key === 'steer-a' && count === 1 ? readCall : [{ type: 'text', text: `Done ${key}.` }];
    const steerTool = toolBarrier(steering);
    await steering.runtime.acceptOwnedMessage(steerA.owned); await bounded(steerTool.reached.promise, 'steering A read');
    const steerPrompt = steering.runtime.agent.state.systemPrompt;
    await steering.runtime.acceptOwnedMessage(steerB.owned); assert.equal(steering.runtime.agent.state.systemPrompt, steerPrompt);
    assert.deepEqual((await rows(steering.sessionId)).map(row => row.execution_phase), ['running', 'queued']);
    steerTool.release.resolve(); await awaitEnd(steering);
    assert.deepEqual(requests.map(request => request.clientMessageId), ['steer-a', 'steer-b']);
    assert.deepEqual((await rows(steering.sessionId)).map(row => [row.execution_phase, Number(row.execution_revision)]), [['cancelled', 4], ['succeeded', 4]]);
    assert(steering.runtime.agent.state.messages.some(message => message.role === 'toolResult' && JSON.stringify(message).includes('ACTUAL_LOCAL_READ_RESULT')),
      'Cancelled after steering does not erase the completed real tool effect/result.');

    stage = 'manual next dispatch after Abort removes the already attached SDK B copy';
    providerMetadataForbidden = false;
    const aborted = await fixture.createSessionRuntime({ userId: 'alice', agentId: agent.agent.agentId }); frames.push(aborted); await writeReadFile(aborted);
    const abortA = await prepare(aborted, 'abort-a', accountSelection('sdk-account-a'));
    const abortB = await prepare(aborted, 'abort-b', accountSelection('sdk-account-b'), 'follow_up');
    beginScenario(aborted, [['abort-a', abortA], ['abort-b', abortB]]); providerMetadataForbidden = true;
    respond = (key, count) => key === 'abort-a' && count === 1 ? readCall : [{ type: 'text', text: `Done ${key}.` }];
    let abortedRuns = 0;
    aborted.runtime.agent.subscribe(event => { if (event.type === 'agent_end') abortedRuns++; });
    const abortTool = toolBarrier(aborted);
    await aborted.runtime.acceptOwnedMessage(abortA.owned); await bounded(abortTool.reached.promise, 'Abort A tool');
    await aborted.runtime.acceptOwnedMessage(abortB.owned);
    assert(aborted.runtime.agent.peekQueuedMessages().some(message => Reflect.get(message, 'serverMessageId') === abortB.serverId), 'B is actually attached to the SDK queue before Abort.');
    await aborted.runtime.abort(); abortTool.release.resolve();
    await bounded(requestReached.get('abort-b')!.promise, 'manual B dispatch after Abort'); await awaitEnd(aborted);
    assert.deepEqual(requests.map(request => request.clientMessageId), ['abort-a', 'abort-b']);
    assert.deepEqual((await rows(aborted.sessionId)).map(row => [row.execution_phase, Number(row.execution_revision)]), [['cancelled', 4], ['succeeded', 4]]);
    assert.equal(aborted.runtime.agent.state.messages.filter(message => message.role === 'user' && Reflect.get(message, 'serverMessageId') === abortB.serverId).length, 1);
    assert.equal(aborted.runtime.agent.hasQueuedMessages(), false); assert.equal(abortedRuns, 2);

    stage = 'atomic Replace cancels attached B and dispatches C exactly once after Abort';
    providerMetadataForbidden = false;
    const replacement = await fixture.createSessionRuntime({ userId: 'alice', agentId: agent.agent.agentId }); frames.push(replacement); await writeReadFile(replacement);
    const replaceA = await prepare(replacement, 'replace-a', accountSelection('sdk-account-a'));
    const replaceB = await prepare(replacement, 'replace-b', accountSelection('sdk-account-b'), 'follow_up');
    beginScenario(replacement, [['replace-a', replaceA], ['replace-b', replaceB]]); providerMetadataForbidden = true;
    respond = (key, count) => key === 'replace-a' && count === 1 ? readCall : [{ type: 'text', text: `Done ${key}.` }];
    let replacedRuns = 0;
    replacement.runtime.agent.subscribe(event => { if (event.type === 'agent_end') replacedRuns++; });
    const replaceTool = toolBarrier(replacement);
    await replacement.runtime.acceptOwnedMessage(replaceA.owned); await bounded(replaceTool.reached.promise, 'Replace A tool');
    await replacement.runtime.acceptOwnedMessage(replaceB.owned);
    assert(replacement.runtime.agent.peekQueuedMessages().some(message => Reflect.get(message, 'serverMessageId') === replaceB.serverId));
    providerMetadataForbidden = false;
    const replaceC = await prepare(replacement, 'replace-c', accountSelection('sdk-account-b'), 'prompt', [await fresh(replacement.sessionId, 'replace-b')]);
    providerMetadataForbidden = true; expected.set('replace-c', replaceC); requestReached.set('replace-c', deferred());
    assert.deepEqual(replaceC.cancelled.map(value => [value.clientMessageId, value.phase, value.executionRevision]), [['replace-b', 'cancelled', 2]]);
    await replacement.runtime.acceptOwnedMessage(replaceC.owned, { replace: true, cancelled: replaceC.cancelled });
    replaceTool.release.resolve();
    await bounded(requestReached.get('replace-c')!.promise, 'manual C dispatch after actual Replace'); await awaitEnd(replacement);
    assert.deepEqual(requests.map(request => request.clientMessageId), ['replace-a', 'replace-c']);
    assert.deepEqual((await rows(replacement.sessionId)).map(row => [row.client_message_id, row.execution_phase, Number(row.execution_revision)]),
      [['replace-a', 'cancelled', 4], ['replace-b', 'cancelled', 2], ['replace-c', 'succeeded', 4]]);
    assert.equal(replacement.runtime.agent.state.messages.filter(message => message.role === 'user' && Reflect.get(message, 'serverMessageId') === replaceB.serverId).length, 0);
    assert.equal(replacement.runtime.agent.state.messages.filter(message => message.role === 'user' && Reflect.get(message, 'serverMessageId') === replaceC.serverId).length, 1);
    assert.equal(replacement.runtime.agent.hasQueuedMessages(), false); assert.equal(replacedRuns, 2);

    stage = 'synthetic continuation retains the same durable frame and claim';
    providerMetadataForbidden = false;
    const continuation = await fixture.createSessionRuntime({ userId: 'alice', agentId: agent.agent.agentId }); await writeReadFile(continuation);
    frames.push(continuation);
    const continuationA = await prepare(continuation, 'continuation-a', accountSelection('sdk-account-a'));
    beginScenario(continuation, [['continuation-a', continuationA]]);
    providerMetadataForbidden = true;
    respond = (_key, count) => count === 1 ? [{ type: 'text', text: 'Ich lese jetzt die Datei.' }]
      : count === 2 ? readCall : [{ type: 'text', text: 'Done. The actual source is read.' }];
    await continuation.runtime.acceptOwnedMessage(continuationA.owned); await awaitEnd(continuation);
    assert.deepEqual(requests.map(request => [request.clientMessageId, request.phase, request.revision]),
      Array.from({ length: 3 }, () => ['continuation-a', 'running', 3]));
    assert.deepEqual((await rows(continuation.sessionId)).map(row => [row.execution_phase, Number(row.execution_revision)]), [['succeeded', 4]]);
    const turns = await sql(database => database.all('SELECT turn_id FROM file_agent_turns WHERE source_session_id=$1', [continuation.sessionId]) as Promise<Array<{ turn_id: string }>>);
    assert.deepEqual(turns.map(turnRecord => turnRecord.turn_id), [continuationA.serverId], 'Synthetic continuation never mints a second file turn or execution claim.');

    stage = 'an explicitly cancelled queued B cannot reach the provider through stale RAM';
    providerMetadataForbidden = false;
    const cancelled = await fixture.createSessionRuntime({ userId: 'alice', agentId: agent.agent.agentId }); await writeReadFile(cancelled);
    frames.push(cancelled);
    const cancelA = await prepare(cancelled, 'cancel-a', accountSelection('sdk-account-a'));
    const cancelB = await prepare(cancelled, 'cancel-b', accountSelection('sdk-account-b'), 'follow_up');
    beginScenario(cancelled, [['cancel-a', cancelA], ['cancel-b', cancelB]]);
    providerMetadataForbidden = true;
    respond = (key, count) => key === 'cancel-a' && count === 1 ? readCall : [{ type: 'text', text: `Done ${key}.` }];
    const cancelTool = toolBarrier(cancelled);
    await cancelled.runtime.acceptOwnedMessage(cancelA.owned); await bounded(cancelTool.reached.promise, 'cancellation A read');
    await cancelled.runtime.acceptOwnedMessage(cancelB.owned);
    const [cancelUpdate] = await queue.cancelOwnedQueuedChatMessages([await fresh(cancelled.sessionId, 'cancel-b')]);
    assert.equal(cancelUpdate.phase, 'cancelled'); assert.equal(cancelUpdate.executionRevision, 2);
    cancelTool.release.resolve(); await awaitEnd(cancelled);
    assert(!requests.some(request => request.clientMessageId === 'cancel-b'));
    const cancelledRows = await rows(cancelled.sessionId);
    assert.deepEqual(cancelledRows.find(row => row.client_message_id === 'cancel-b')?.execution_phase, 'cancelled');
    assert.equal(Number(cancelledRows.find(row => row.client_message_id === 'cancel-b')?.execution_revision), 2);

    stage = 'a genuine but stale queued B revision cannot silently dispatch a changed lane';
    providerMetadataForbidden = false;
    const stale = await fixture.createSessionRuntime({ userId: 'alice', agentId: agent.agent.agentId }); await writeReadFile(stale);
    frames.push(stale);
    const staleA = await prepare(stale, 'stale-a', accountSelection('sdk-account-a'));
    const staleB = await prepare(stale, 'stale-b', accountSelection('sdk-account-b'), 'follow_up');
    beginScenario(stale, [['stale-a', staleA], ['stale-b', staleB]]);
    providerMetadataForbidden = true;
    respond = (key, count) => key === 'stale-a' && count === 1 ? readCall : [{ type: 'text', text: `Done ${key}.` }];
    const staleTool = toolBarrier(stale);
    await stale.runtime.acceptOwnedMessage(staleA.owned); await bounded(staleTool.reached.promise, 'stale revision A read');
    await stale.runtime.acceptOwnedMessage(staleB.owned);
    const promoted = await queue.promoteOwnedQueuedChatMessage(await fresh(stale.sessionId, 'stale-b'));
    assert.equal(promoted.message.executionRevision, 2); assert.equal(promoted.message.queue?.lane, 'steer');
    staleTool.release.resolve(); await awaitEnd(stale);
    assert(!requests.some(request => request.clientMessageId === 'stale-b'));
    const stillQueued = await fresh(stale.sessionId, 'stale-b');
    const staleData = service.readOwnedAcceptedChatMessageData(stillQueued, stale.context);
    assert.equal(staleData.phase, 'queued'); assert.equal(staleData.executionRevision, 2);
    assert.equal(staleData.queue?.lane, 'steer'); assert.equal(staleData.payload.mode, 'message', 'Promotion never rewrites original intake intent.');
    await queue.cancelOwnedQueuedChatMessages([stillQueued]);

    providerMetadataForbidden = true;
    const before = composio.calls.length;
    await cancelled.runtime.refreshOwnedQueue();
    assert.equal(composio.calls.length, before, 'Read-only queue refresh cannot re-open receipt/account metadata.');
    assert.equal(transportFailures.length, 0);
    assert.equal(fixture.counts().forbiddenModelRequests, 0); assert.equal(fixture.counts().externalRequests, 0);
    assert(composio.calls.every(call => !call.path.includes('/execute/') && !call.path.includes('/tool_router/')));
    assert(blockedExternalAttempts.every(attempt => attempt.origin === 'https://registry.npmjs.org'
      && attempt.path === '/@composio/core/latest' && attempt.method === 'GET'), 'No unexpected external attempt may disappear behind a background-probe failure.');
    console.log(JSON.stringify({ blockedSdkVersionChecks: blockedExternalAttempts.length, actualExternalRequests: fixture.counts().externalRequests }));
    console.log('PASS durable Runtime/SDK integration: actual queued→running→terminal SQL, genuine published Plugin/approved MCP/exact Composio account routes, stable A tools/context through actual read and persistence, independent B/C handoffs with exact admitted inline body/CID/serverID in SQL history, steer/Abort/atomicReplace settlement without SDK duplicates, synthetic continuation same claim, cancelled or stale-revision RAM entry never reaches model; controlled SDK transport only, no native/browser/model business request.');
  } catch (error) {
    primaryFailure = error;
    console.error(`Durable Runtime/SDK stage: ${stage}`, error, fixture.counts()); throw error;
  } finally {
    application.setAfterQuery(undefined); application.setBeforeRead(undefined); application.setAfterRead(undefined);
    for (const release of releaseAll) release();
    const cleanupErrors: unknown[] = [];
    // Keep the controlled transport installed until every actual SDK listener
    // has settled, including an assertion-failure/abort cleanup path.
    for (const frame of frames) {
      try {
        if (frame.runtime.agent.state.isStreaming || frame.runtime.getStatus().canAbort) await frame.runtime.abort();
        await bounded(frame.runtime.agent.waitForIdle(), 'owned Runtime cleanup');
      } catch (error) { cleanupErrors.push(error); }
    }
    try { restoreProvider?.(); } catch (error) { cleanupErrors.push(error); }
    globalThis.fetch = fixtureFetch;
    try { await composio?.close(); } catch (error) { cleanupErrors.push(error); }
    for (const [key, value] of previousEnv) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    try { await fixture.close(); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(primaryFailure === undefined ? cleanupErrors : [primaryFailure, ...cleanupErrors], 'Owned durable SDK fixture cleanup failed.');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

import assert from 'node:assert/strict';
import Module from 'node:module';
import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { ManagedControlPlaneCatalog } from '../app/lib/managed/control-plane-models';

const model: Model<'openai-completions'> = {
  id: 'fixture-model', name: 'Fixture', provider: 'canvas-control-plane', api: 'openai-completions',
  baseUrl: 'https://unused.invalid/v1', input: ['text'], reasoning: false, contextWindow: 32_000,
  maxTokens: 4_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const provider = {
  installationId: 'aip_managed_fixture', providerId: model.provider, name: 'Fixture', enabled: true,
  status: 'ready', source: 'managed', sourceRevision: 'revision-1', credentialScope: 'managed', config: {},
  models: [{ id: model.id, enabled: true, reasoning: false, supportsVision: false,
    thinkingLevels: ['off'], metadata: { contextWindow: 32_000, maxTokens: 4_000 } }],
};
const context = { organizationId: 'org-fixture', userId: 'user-fixture', workspaceId: 'ws-fixture',
  workspaceType: 'personal' as const, agentId: 'bradley' };
const selected = { providerInstallationId: provider.installationId, providerId: model.provider,
  modelId: model.id, thinkingLevel: 'off' };
const selection = { selection: selected, catalogRevision: 1, policyRevision: 0, selectionSource: 'session' };
const resolution = { ...selection, context: { ...context, executionMode: 'interactive',
  principal: { type: 'user', credentialSubjectUserId: context.userId } } };
const ready: ManagedControlPlaneCatalog = { status: 'ready', errorCode: null, catalogRevision: 'revision-1',
  defaultModelId: model.id, defaultThinkingLevel: 'off', models: [{ ...model, managedProvider: 'openai' }] };
const unavailable: ManagedControlPlaneCatalog = { ...ready, status: 'unavailable',
  errorCode: 'MANAGED_CATALOG_TEMPORARILY_UNAVAILABLE', httpStatus: 503, models: [] };
let remote = structuredClone(ready);
let credentialHook = () => {};
let discoveryHook = async (_signal?: AbortSignal) => {};
let providerRequests = 0;
let response: (messages: AgentMessage[]) => AssistantMessage = () =>
  assistant([{ type: 'text', text: 'Recovered.' }], 'stop');

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content,
    stopReason, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

const modules = Module as unknown as { _load: (request: string, parent?: unknown, isMain?: boolean) => unknown };
const originalLoad = modules._load;
modules._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {};
  if (request.endsWith('/catalog-store')) return { readAppRuntimeCatalog: async () => ({ revision: 1, providers: [structuredClone(provider)] }) };
  if (request.endsWith('/runtime-store')) return { readWorkspaceModelPolicy: async () => null };
  if (request.endsWith('/runtime-resolver')) return {
    resolveEffectiveAgentRuntime: async () => resolution, assertEffectiveRuntimeSelection: () => selection,
    buildEffectiveCatalogProviders: ({ catalog }: { catalog: { providers: unknown[] } }) => catalog.providers,
    runtimePrincipalCanUseUserCredentials: () => true,
  };
  if (request.endsWith('/model-resolver')) return { modelSupportsImageInput: () => false,
    resolvePiModel: async (_provider: string, id: string, options: { managedCatalog: ManagedControlPlaneCatalog }) => {
      const found = options.managedCatalog.models.find((candidate) => candidate.id === id);
      if (!found) throw new Error('Model removed');
      return found;
    } };
  if (request.endsWith('/installation-credentials')) return {
    resolveProviderInstallationRuntimeAuth: async () => {
      credentialHook();
      return { configured: true, apiKey: 'fixture-only', env: {} };
    },
  };
  if (request.endsWith('/managed/control-plane-models')) return {
    CANVAS_CONTROL_PLANE_PROVIDER_ID: model.provider, MANAGED_CATALOG_WARM_CACHE_MS: 30_000,
    getCanvasControlPlaneCatalog: async (options?: { signal?: AbortSignal }) => {
      await discoveryHook(options?.signal);
      options?.signal?.throwIfAborted();
      return structuredClone(remote);
    },
  };
  if (request === '@earendil-works/pi-ai/compat') return {
    createAssistantMessageEventStream,
    streamSimple: (_model: unknown, request: { messages: AgentMessage[] }, options: { apiKey?: string }) => {
      assert.equal(options.apiKey, 'fixture-only', 'only fresh instance credentials may reach the provider');
      providerRequests += 1;
      const stream = createAssistantMessageEventStream();
      const output = response(request.messages);
      if (output.stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: output });
      else stream.push({ type: 'done', reason: output.stopReason as 'stop' | 'toolUse', message: output });
      return stream;
    },
  };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const { resolveExecutableAgentRuntime, resolveProviderInstallationModel, AiRuntimeExecutionError } =
    await import('../app/lib/agent-runtime-policy/provider-runtime');
  const runtime = await resolveExecutableAgentRuntime(context);
  remote = structuredClone(unavailable);
  const failed = await (await runtime.streamFn(model, normalizeContext({ messages: [] }))).result();
  assert.equal(failed.stopReason, 'error');
  assert.match(failed.errorMessage!, /send a new message/i);
  assert.doesNotMatch(failed.errorMessage!, /Sync and review/);
  assert.equal(runtime.requiresRecreation(), true, 'temporary failures must evict the live runtime at agent_end');
  assert.equal(providerRequests, 0, 'failed validation must not dispatch a provider request');

  for (const [catalogError, runtimeError, message, httpStatus] of [
    ['MANAGED_CATALOG_TIMEOUT', 'RUNTIME_MANAGED_CATALOG_UNAVAILABLE', /timed out/, undefined],
    ['MANAGED_CATALOG_AUTH_FAILED', 'RUNTIME_MANAGED_CATALOG_AUTH_FAILED', /credentials.*401/, 401],
    ['MANAGED_CATALOG_FORBIDDEN', 'RUNTIME_MANAGED_CATALOG_FORBIDDEN', /access.*403/, 403],
    ['MANAGED_CONNECTION_INCOMPLETE', 'RUNTIME_MANAGED_CONNECTION_INCOMPLETE', /not configured/, undefined],
    ['MANAGED_CATALOG_HTTP_ERROR', 'RUNTIME_MANAGED_CATALOG_HTTP_ERROR', /HTTP 404/, 404],
  ] as const) {
    remote = { ...unavailable, errorCode: catalogError, httpStatus };
    await assert.rejects(resolveProviderInstallationModel({ provider, model: provider.models[0] } as
      Parameters<typeof resolveProviderInstallationModel>[0]), (error: unknown) => {
      assert.ok(error instanceof AiRuntimeExecutionError);
      assert.equal(error.code, runtimeError);
      assert.match(error.message, message);
      return true;
    });
  }
  remote = { ...ready, status: 'invalid', errorCode: 'MANAGED_CATALOG_REVISION_MISSING', catalogRevision: null };
  await assert.rejects(resolveExecutableAgentRuntime(context), { code: 'RUNTIME_MANAGED_CATALOG_INVALID' });
  remote = { ...ready, defaultModelId: 'replacement-model',
    models: [{ ...ready.models[0], id: 'replacement-model' }] };
  await assert.rejects(resolveExecutableAgentRuntime(context), { code: 'RUNTIME_MANAGED_CATALOG_CHANGED' });
  remote = structuredClone(ready);
  remote.models[0].contextWindow = 16_000;
  await assert.rejects(resolveExecutableAgentRuntime(context), { code: 'RUNTIME_MANAGED_CATALOG_CHANGED' });

  // A genuine agent tool chain loses discovery before its next model request.
  // Rebuild the executable runtime and replay its history with a new user
  // message; the SDK must keep the completed tool result without re-running it.
  remote = structuredClone(ready);
  let toolExecutions = 0;
  response = () => assistant([{ type: 'toolCall', id: 'completed-call', name: 'inspect', arguments: {} }], 'toolUse');
  const tool = { name: 'inspect', label: 'Inspect', description: 'Fixture inspection', parameters: Type.Object({}),
    execute: async () => {
      toolExecutions += 1;
      remote = structuredClone(unavailable);
      return { content: [{ type: 'text' as const, text: 'Completed tool result' }], details: {} };
    } };
  const firstRuntime = await resolveExecutableAgentRuntime(context);
  const firstAgent = new Agent({ initialState: { model, tools: [tool], systemPrompt: 'Fixture agent' },
    streamFn: firstRuntime.streamFn, getApiKey: firstRuntime.getApiKey });
  const callsBeforeTool = providerRequests;
  await firstAgent.prompt('Inspect once.');
  assert.equal(toolExecutions, 1);
  assert.equal(providerRequests, callsBeforeTool + 1);
  assert.equal(firstAgent.state.messages.at(-1)?.role, 'assistant');
  assert.equal((firstAgent.state.messages.at(-1) as AssistantMessage).stopReason, 'error');
  assert.equal(firstRuntime.requiresRecreation(), true);

  remote = structuredClone(ready);
  // A source revision bump alone must not require a manual synchronization.
  remote.catalogRevision = 'revision-2';
  response = (messages) => {
    assert.ok(messages.some((entry) => entry.role === 'toolResult'), 'completed result survives recovery');
    assert.match(JSON.stringify(messages), /Completed tool result/);
    return assistant([{ type: 'text', text: 'Recovered.' }], 'stop');
  };
  const nextRuntime = await resolveExecutableAgentRuntime(context);
  const nextAgent = new Agent({ initialState: { model, tools: [tool], systemPrompt: 'Fixture agent',
    messages: firstAgent.state.messages }, streamFn: nextRuntime.streamFn, getApiKey: nextRuntime.getApiKey });
  await nextAgent.prompt('Continue with the completed result.');
  assert.equal(toolExecutions, 1, 'a new message must not replay a completed action');
  assert.equal((nextAgent.state.messages.at(-1) as AssistantMessage).stopReason, 'stop');

  // Credential lookup may overlap with a local policy revocation.
  credentialHook = () => { provider.enabled = false; };
  const beforeRevocation = providerRequests;
  assert.equal((await (await nextRuntime.streamFn(model, normalizeContext({ messages: [] }))).result()).stopReason, 'error');
  assert.equal(providerRequests, beforeRevocation);
  credentialHook = () => {}; provider.enabled = true;

  const abortRuntime = await resolveExecutableAgentRuntime(context);
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const controller = new AbortController();
  discoveryHook = async (signal) => {
    assert.equal(signal, controller.signal, 'runtime cancellation reaches the catalog caller');
    started.resolve(); await released.promise;
  };
  const pending = abortRuntime.streamFn(model, normalizeContext({ messages: [] }), { signal: controller.signal });
  await started.promise; controller.abort();
  const aborted = await (await pending).result();
  assert.equal(aborted.stopReason, 'aborted');
  assert.equal(abortRuntime.requiresRecreation(), false);
  assert.equal(providerRequests, beforeRevocation);
  released.resolve(); discoveryHook = async () => {};

  // The SDK's getApiKey callback has no signal. It must not start a separate,
  // unabortable catalog lookup before the authenticated stream boundary.
  const sdkRuntime = await resolveExecutableAgentRuntime(context);
  const sdkStarted = Promise.withResolvers<void>();
  const sdkReleased = Promise.withResolvers<void>();
  let discoveryCalls = 0;
  let discoverySignal: AbortSignal | undefined;
  discoveryHook = async (signal) => {
    discoveryCalls += 1; discoverySignal = signal;
    sdkStarted.resolve(); await sdkReleased.promise;
  };
  const sdkAgent = new Agent({ initialState: { model, systemPrompt: 'Fixture agent' },
    streamFn: sdkRuntime.streamFn, getApiKey: sdkRuntime.getApiKey });
  const sdkPrompt = sdkAgent.prompt('A cancellable managed request.');
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await sdkStarted.promise;
    assert.ok(discoverySignal, 'the only per-request discovery runs at the signal-aware stream boundary');
    sdkAgent.abort();
    await Promise.race([sdkPrompt, new Promise<void>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('SDK cancellation waited for catalog discovery')), 500);
    })]);
    assert.equal(discoveryCalls, 1, 'the SDK credential callback must not duplicate remote discovery');
    assert.equal(providerRequests, beforeRevocation);
    assert.equal((sdkAgent.state.messages.at(-1) as AssistantMessage).stopReason, 'aborted');
  } finally {
    clearTimeout(deadline); sdkReleased.resolve(); discoveryHook = async () => {};
    await sdkPrompt;
  }

  // An error from an already-dispatched stream keeps its provider diagnostics
  // and never retries the model request or executed tools automatically.
  response = () => ({ ...assistant([{ type: 'text', text: 'Partial response' }], 'error'),
    errorMessage: 'fixture provider connection reset during streaming' });
  const streamedError = await (await abortRuntime.streamFn(model, normalizeContext({ messages: [] }))).result();
  assert.match(streamedError.errorMessage!, /connection reset during streaming/);
  assert.equal(providerRequests, beforeRevocation + 1);
  console.log('Managed runtime classification, tool-chain recovery, revocation, cancellation and stream failure tests passed');
} finally { modules._load = originalLoad; }

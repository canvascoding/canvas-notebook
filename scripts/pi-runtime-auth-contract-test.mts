import assert from 'node:assert/strict';
import Module from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { piMetadataFixture } from './helpers/pi-message-fixture';
import { runWithAbortSignal } from '../app/lib/concurrency/run-with-abort-signal';

const model: Model<'openai-responses'> = {
  id: 'fixture-model', name: 'Fixture', provider: 'openai-codex', api: 'openai-responses',
  baseUrl: 'https://unused.invalid', input: ['text'], reasoning: true, contextWindow: 32_000,
  maxTokens: 4_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const provider = {
  installationId: 'aip_auth_fixture', providerId: model.provider, name: 'Fixture', enabled: true,
  status: 'ready', source: 'built-in', credentialScope: 'user', config: { authMethod: 'oauth' },
  models: [{ id: model.id, enabled: true, reasoning: true, supportsVision: false, thinkingLevels: ['off', 'high'], metadata: { contextWindow: 32_000, maxTokens: 4_000 } }],
};
const context = { organizationId: 'org-auth', userId: 'user-auth', workspaceId: 'ws-auth', workspaceType: 'personal' as const, agentId: 'bradley' };
const selected = { providerInstallationId: provider.installationId, providerId: model.provider, modelId: model.id, thinkingLevel: 'high' };
const selection = { selection: selected, catalogRevision: 1, policyRevision: 0, selectionSource: 'session' };
const resolution = { ...selection, context: { ...context, executionMode: 'interactive', principal: { type: 'user', credentialSubjectUserId: context.userId } } };
let mode: 'normal' | 'pending' | 'revoke' = 'normal';
let reached = Promise.withResolvers<void>();
let release = Promise.withResolvers<void>();
let observedSignal: AbortSignal | undefined;
let providerRequests = 0;
let authRequests = 0;
const moduleInternals = Module as unknown as { _load: (request: string, parent?: unknown, isMain?: boolean) => unknown };
const originalLoad = moduleInternals._load;
moduleInternals._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {};
  if (request.endsWith('/catalog-store')) return { readAppRuntimeCatalog: async () => ({ revision: 1, providers: [structuredClone(provider)] }) };
  if (request.endsWith('/runtime-store')) return { readWorkspaceModelPolicy: async () => null };
  if (request.endsWith('/runtime-resolver')) return {
    resolveEffectiveAgentRuntime: async () => resolution,
    assertEffectiveRuntimeSelection: () => selection,
    buildEffectiveCatalogProviders: ({ catalog }: { catalog: { providers: unknown[] } }) => catalog.providers,
    runtimePrincipalCanUseUserCredentials: () => true,
  };
  if (request.endsWith('/model-resolver')) return { getPiModels: () => [model], modelSupportsImageInput: () => false };
  if (request.endsWith('/agents/storage')) return { isManagedControlPlaneAvailable: () => false };
  if (request.endsWith('/integrations/env-config')) return { readScopedEnvState: async () => { assert.fail('OAuth must not read global environment credentials'); } };
  if (request.endsWith('/managed/control-plane-models')) return { CANVAS_CONTROL_PLANE_PROVIDER_ID: 'canvas-control-plane' };
  if (request.endsWith('/pi/oauth')) return {
    isOAuthProvider: () => true,
    getProviderRequestAuth: async (_id: string, scope: { userId: string }, options?: { signal?: AbortSignal }) => {
      authRequests += 1;
      assert.equal(scope.userId, context.userId);
      observedSignal = options?.signal;
      if (mode === 'pending') { reached.resolve(); await release.promise; }
      if (mode === 'revoke') provider.enabled = false;
      options?.signal?.throwIfAborted();
      return { apiKey: 'fixture-only', env: {} };
    },
  };
  if (request === '@earendil-works/pi-ai/compat') return {
    createAssistantMessageEventStream,
    streamSimple: () => {
      providerRequests += 1;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: { ...piMetadataFixture, content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' } });
      return stream;
    },
  };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const helperSignal = new AbortController();
  assert.equal(await runWithAbortSignal(helperSignal.signal, async () => 42), 42);
  assert.equal(getEventListeners(helperSignal.signal, 'abort').length, 0);
  await assert.rejects(runWithAbortSignal(helperSignal.signal, async () => { throw new Error('fixture rejection'); }), /fixture rejection/);
  assert.equal(getEventListeners(helperSignal.signal, 'abort').length, 0);
  const { resolveExecutableAgentRuntime } = await import('../app/lib/agent-runtime-policy/provider-runtime');
  const runtime = await resolveExecutableAgentRuntime(context);
  const signal = new AbortController();
  const normal = await runtime.streamFn(model, { messages: [] }, { signal: signal.signal });
  await normal.result();
  assert.equal(observedSignal, signal.signal, 'provider request signal must reach OAuth through both credential layers');
  assert.equal(providerRequests, 1);
  const callsBeforeAbort = authRequests;
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const skipped = await runtime.streamFn(model, { messages: [] }, { signal: alreadyAborted.signal });
  assert.equal((await skipped.result()).stopReason, 'aborted');
  assert.equal(authRequests, callsBeforeAbort, 'an already cancelled request must not start credential lookup');

  // Simulate an uncooperative refresh/credential-lock wait. The request must
  // settle promptly even before that underlying operation releases its lock.
  mode = 'pending';
  reached = Promise.withResolvers<void>();
  release = Promise.withResolvers<void>();
  const abort = new AbortController();
  const pending = runtime.streamFn(model, { messages: [] }, { signal: abort.signal });
  try {
    await reached.promise;
    abort.abort(new Error('fixture cancelled'));
    const timeout = new AbortController();
    try {
      const result = await Promise.race([
        Promise.resolve(pending).then((stream) => stream.result()),
        delay(500, null, { signal: timeout.signal }),
      ]);
      assert.ok(result, 'stop must not wait for credential refresh/lock release');
      assert.equal((result as AssistantMessage).stopReason, 'aborted');
      assert.equal(providerRequests, 1);
      assert.equal(runtime.requiresRecreation(), false);
    } finally { timeout.abort(); }
  } finally { release.resolve(); await pending; }

  mode = 'revoke';
  const revoked = await runtime.streamFn(model, { messages: [] });
  assert.equal((await revoked.result()).stopReason, 'error');
  assert.equal(providerRequests, 1, 'revocation during auth must prevent provider dispatch');
  assert.equal(runtime.requiresRecreation(), true);
  console.log('Pi request auth, cancellation and revocation contracts passed');
} finally { moduleInternals._load = originalLoad; }

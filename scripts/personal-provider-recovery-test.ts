import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { AiWorkspaceModelPolicy } from '../app/lib/agent-runtime-policy/types';

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-personal-provider-'));
  const previousRoot = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  const database = await createPiTestDatabase();
  const internals = Module as unknown as { _load: (name: string, parent?: unknown, isMain?: boolean) => unknown };
  const originalLoad = internals._load;
  const sdk = originalLoad.call(Module, path.resolve('node_modules/@earendil-works/pi-ai/dist/index.js'), undefined, false) as typeof import('@earendil-works/pi-ai');
  const id = `aip_${'a'.repeat(24)}`;
  const providerId = process.argv.includes('--openai') ? 'openai' : 'openai-codex';
  const model = {
    id: 'gpt-6-sol', name: 'Fixture', provider: providerId, api: providerId === 'openai' ? 'openai-responses' as const : 'openai-codex-responses' as const,
    baseUrl: 'https://unused.invalid', reasoning: true, input: ['text'] as ['text'],
    contextWindow: 32_000, maxTokens: 4_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let responseError: string | null = null;
  let duringAuth: (() => Promise<void>) | null = null;
  let grantActive = true;
  let policy: AiWorkspaceModelPolicy | null = null;
  let providerRequests = 0;
  let signedIn = true;
  let workspaceAllowed = true;
  let agentAllowed = true;
  class FixtureAgentAccessError extends Error { code = 'AGENT_ACCESS_DENIED'; status = 403; }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Live network is forbidden in the personal provider fixture.'); };
  internals._load = function (name, parent, isMain) {
    if (name === 'server-only') return {};
    if (name.endsWith('/app/lib/db') || name === '@/app/lib/db') return database;
    if (name.endsWith('/agents/storage')) return { isManagedControlPlaneAvailable: () => false };
    if (name.endsWith('/agents/registry')) return {
      normalizeManagedAgentId: (value: string) => value,
      getAgentProfile: async () => ({ id: 'canvas-agent', defaultProvider: '', defaultModel: '' }),
    };
    if (name.endsWith('/app/lib/auth') || name === '@/app/lib/auth') return { auth: { api: { getSession: async () => signedIn ? { user: { id: 'owner-a' } } : null } } };
    if (name.endsWith('/workspaces/request')) return { requireSessionWorkspace: async () => workspaceAllowed
      ? { workspace: { organizationId: 'org-fixture', workspaceId: 'workspace-fixture', workspaceType: 'team' } }
      : { response: Response.json({ success: false }, { status: 403 }) } };
    if (name.endsWith('/agents/access')) return { AgentAccessError: FixtureAgentAccessError, requireAgentAccessForWorkspace: async () => { if (!agentAllowed) throw new FixtureAgentAccessError(); } };
    if (name.endsWith('/utils/rate-limit')) return { rateLimit: () => ({ ok: true }) };
    if (name.endsWith('/runtime-store')) return {
      readWorkspaceModelPolicy: async () => policy,
      readUserWorkspaceProviderGrant: async () => grantActive ? { status: 'active', allowedExecutionModes: ['interactive'], revision: 1 } : null,
      readUserModelPreference: async () => null, readPiSessionRuntimeSnapshot: async () => null,
    };
    if (name.endsWith('/installation-credentials')) return {
      isProviderInstallationCredentialAvailable: async () => true,
      resolveProviderInstallationRuntimeAuth: async (input: { userId: string }) => {
        if (duringAuth) { const operation = duringAuth; duringAuth = null; await operation(); }
        return { configured: true, apiKey: `fixture-only-${input.userId}`, env: {} };
      },
    };
    if (name === '@earendil-works/pi-ai/compat') return {
      getProviders: () => [providerId], getModels: () => [model], registerBuiltInApiProviders: () => {},
      createAssistantMessageEventStream: sdk.createAssistantMessageEventStream,
      completeSimple: async () => {
        providerRequests++;
        return { role: 'assistant', content: responseError ? [] : [{ type: 'text', text: 'OK' }], stopReason: responseError ? 'error' : 'stop', errorMessage: responseError, usage: {} };
      },
      streamSimple: () => {
        providerRequests++;
        const stream = sdk.createAssistantMessageEventStream();
        stream.push({ type: 'done', reason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixture chat completed' }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...model.cost, total: 0 } } } });
        return stream;
      },
    };
    return originalLoad.call(this, name, parent, isMain);
  };
  try {
    const db = await database.openDb();
    for (const userId of ['owner-a', 'owner-b']) await db.run(
      'INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, $1, $2, 1, 1, 1)', [userId, `${userId}@fixture.invalid`],
    );
    await db.run('INSERT INTO canvas_organization_settings (organization_id, owner_user_id, created_at, updated_at) VALUES ($1, $2, 1, 1)', ['org-fixture', 'owner-a']);
    await db.run(`INSERT INTO ai_provider_installations (id, organization_id, provider_id, display_name, source, credential_scope, enabled, status, config_json, revision, created_at, updated_at)
      VALUES ($1, 'org-fixture', $2, 'Codex', 'built-in', 'user', 1, 'degraded', '{"authMethod":"oauth"}', 1, 1, 1)`, [id, providerId]);
    await db.run(`INSERT INTO ai_provider_models (organization_id, provider_installation_id, model_id, display_name, enabled, is_provider_default, reasoning, supports_vision, thinking_levels_json, metadata_json, revision, created_at, updated_at)
      VALUES ('org-fixture', $1, 'gpt-6-sol', 'Fixture', 1, 1, 1, 0, '["medium"]', '{"contextWindow":32000,"maxTokens":4000}', 1, 1, 1)`, [id]);
    await db.run("INSERT INTO ai_runtime_defaults (organization_id, catalog_revision, migration_state, created_at, updated_at) VALUES ('org-fixture', 7, 'configured', 1, 1)");
    const oauth = await import('../app/lib/pi/oauth');
    const { readAppRuntimeCatalog } = await import('../app/lib/agent-runtime-policy/catalog-store');
    const { readPersonalProviderVerification, writePersonalProviderVerification, personalProviderConnectionId } = await import('../app/lib/agent-runtime-policy/personal-provider-store');
    const { verifyPersonalProvider } = await import('../app/lib/agent-runtime-policy/personal-provider-verification');
    const { resolveEffectiveAgentRuntime } = await import('../app/lib/agent-runtime-policy/runtime-resolver');
    const { resolveExecutableAgentRuntime } = await import('../app/lib/agent-runtime-policy/provider-runtime');
    const contextFor = (userId: string) => ({ organizationId: 'org-fixture', userId, workspaceId: 'workspace-fixture', workspaceType: 'team' as const, agentId: 'canvas-agent', executionMode: 'interactive' as const, principal: { type: 'user' as const, userId, credentialSubjectUserId: userId }, requestedSelection: { providerInstallationId: id, providerId, modelId: model.id, thinkingLevel: 'medium' as const } });
    for (const userId of ['owner-a', 'owner-b']) await oauth.saveProviderCredentials(providerId, { access: `fixture-${userId}`, refresh: `fixture-refresh-${userId}`, expires: Date.now() + 3_600_000 }, { userId });
    const a = contextFor('owner-a'); const b = contextFor('owner-b');
    assert.equal((await resolveEffectiveAgentRuntime(a)).providers[0].selectable, false);
    assert.equal((await verifyPersonalProvider({ context: a, providerInstallationId: id })).success, true);
    assert.equal((await resolveEffectiveAgentRuntime(a)).providers[0].selectable, true);
    assert.equal((await resolveEffectiveAgentRuntime(b)).providers[0].selectable, false, 'another account must not inherit readiness');
    const catalog = await readAppRuntimeCatalog('org-fixture');
    const provider = catalog.providers[0];
    assert.equal(catalog.revision, 7); assert.equal(provider.status, 'degraded', 'personal probes must not update global state');
    const runtime = await resolveExecutableAgentRuntime(a);
    const chat = await runtime.streamFn(model, sdk.normalizeContext({ messages: [] }));
    assert.equal((await chat.result()).stopReason, 'stop', 'recovery must permit an actual runtime request');
    responseError = 'HTTP 429 fixture quota';
    const failed = await verifyPersonalProvider({ context: b, providerInstallationId: id });
    assert.equal(failed.success, false); assert.equal(failed.code, 'PROVIDER_RATE_LIMITED');
    assert.equal((await resolveEffectiveAgentRuntime(a)).providers[0].selectable, true, 'another owner failure cannot block A');
    assert.equal((await readPersonalProviderVerification({ provider, organizationId: a.organizationId, userId: b.userId })).failureCode, 'PROVIDER_RATE_LIMITED');
    duringAuth = async () => { throw new Error('OAuth refresh failed', { cause: new Error('HTTP 429 fixture refresh quota') }); };
    const refreshLimited = await verifyPersonalProvider({ context: a, providerInstallationId: id });
    assert.equal(refreshLimited.code, 'PROVIDER_RATE_LIMITED', 'refresh throttling must not be reported as a rejected login');
    duringAuth = async () => { throw new Error('OAuth refresh failed', { cause: new Error('HTTP 401 fixture invalid token') }); };
    assert.equal((await verifyPersonalProvider({ context: a, providerInstallationId: id })).code, 'PROVIDER_AUTH_REJECTED');
    responseError = null;
    await verifyPersonalProvider({ context: a, providerInstallationId: id });
    const beforeBlocked = providerRequests;
    grantActive = false;
    await assert.rejects(verifyPersonalProvider({ context: a, providerInstallationId: id }), { code: 'PERSONAL_PROVIDER_APPROVAL_REQUIRED' });
    assert.equal(providerRequests, beforeBlocked); grantActive = true; responseError = null;
    duringAuth = async () => { grantActive = false; };
    await assert.rejects(verifyPersonalProvider({ context: a, providerInstallationId: id }), { code: 'PERSONAL_PROVIDER_APPROVAL_REQUIRED' });
    assert.equal(providerRequests, beforeBlocked, 'revocation during auth cannot dispatch'); grantActive = true;
    await assert.rejects(verifyPersonalProvider({ context: { ...a, principal: { ...a.principal, credentialSubjectUserId: b.userId } }, providerInstallationId: id }), { code: 'PERSONAL_PROVIDER_NOT_ALLOWED' });
    await assert.rejects(verifyPersonalProvider({ context: { ...a, executionMode: 'organization_automation' }, providerInstallationId: id }), { code: 'PERSONAL_PROVIDER_NOT_ALLOWED' });
    const abort = new AbortController(); abort.abort();
    await assert.rejects(verifyPersonalProvider({ context: a, providerInstallationId: id, signal: abort.signal }));
    assert.equal(providerRequests, beforeBlocked);
    policy = { organizationId: a.organizationId, workspaceId: a.workspaceId, revision: 1, allowedModels: [], defaultSelection: null, allowUserCredentials: true, updatedByUserId: null, updatedAt: null };
    await assert.rejects(verifyPersonalProvider({ context: a, providerInstallationId: id }), { code: 'PERSONAL_PROVIDER_NOT_ALLOWED' });
    assert.equal(providerRequests, beforeBlocked); policy = null;
    // Reconnect during runtime credential lookup must be caught by the final readiness check.
    duringAuth = async () => { await oauth.saveProviderCredentials(providerId, { access: 'new-fixture', refresh: 'new-fixture-refresh', expires: Date.now() + 3_600_000 }, { userId: a.userId }); };
    assert.equal((await (await runtime.streamFn(model, sdk.normalizeContext({ messages: [] }))).result()).stopReason, 'error');
    assert.equal(providerRequests, beforeBlocked);
    assert.equal((await resolveEffectiveAgentRuntime(a)).providers[0].selectable, false);
    await verifyPersonalProvider({ context: a, providerInstallationId: id });
    const state = await readPersonalProviderVerification({ provider, organizationId: a.organizationId, userId: a.userId });
    assert.equal(state.status, 'ready');
    assert.equal((await readPersonalProviderVerification({ provider: { ...provider, config: { ...provider.config, openaiCompatibleBaseUrl: 'https://changed.invalid' } }, organizationId: a.organizationId, userId: a.userId })).status, 'unverified');
    await assert.rejects(writePersonalProviderVerification({ organizationId: a.organizationId, userId: a.userId, provider, modelId: model.id, catalogRevision: 7, connectionId: personalProviderConnectionId(provider, a.userId)!, expectedRevision: 0, status: 'degraded', failureCode: 'MODEL_TEST_FAILED', verifiedAt: null, checkedAt: Date.now() }), { code: 'PROVIDER_VERIFICATION_CONFLICT' });
    assert.equal((await readPersonalProviderVerification({ provider, organizationId: a.organizationId, userId: a.userId })).status, 'ready');
    await oauth.removeProviderCredentials(providerId, { userId: a.userId });
    assert.equal((await readPersonalProviderVerification({ provider, organizationId: a.organizationId, userId: a.userId })).status, 'unverified');
    // Exercise the real public route with ordinary-user auth and real scoped probe/store/resolution.
    await oauth.saveProviderCredentials(providerId, { access: 'route-fixture', refresh: 'route-refresh', expires: Date.now() + 3_600_000 }, { userId: a.userId });
    const { POST } = await import('../app/api/agent-runtime/personal-provider-verify/route');
    const { NextRequest } = await import('next/server');
    const payload = { workspaceId: a.workspaceId, agentId: a.agentId, providerInstallationId: id, modelId: model.id };
    const request = (body: object) => new NextRequest('http://localhost/api/agent-runtime/personal-provider-verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const callsBeforeRoute = providerRequests;
    assert.equal((await POST(request({ ...payload, userId: b.userId }))).status, 400);
    assert.equal((await POST(request({ ...payload, executionMode: 'organization_automation' }))).status, 400);
    signedIn = false; assert.equal((await POST(request(payload))).status, 401); signedIn = true;
    workspaceAllowed = false; assert.equal((await POST(request(payload))).status, 403); workspaceAllowed = true;
    agentAllowed = false; assert.equal((await POST(request(payload))).status, 403); agentAllowed = true;
    assert.equal(providerRequests, callsBeforeRoute);
    const routeResult = await POST(request(payload));
    assert.equal(routeResult.status, 200);
    const routePayload = await routeResult.json();
    assert.equal(routePayload.data.resolution.providers[0].selectable, true);
    assert.equal(routePayload.data.resolution.context.principal.credentialSubjectUserId, a.userId);
    assert.equal((await readAppRuntimeCatalog(a.organizationId)).providers[0].status, 'degraded');
    console.log('Personal provider recovery: real PostgreSQL schema/store, two-owner isolation, runtime recovery, auth/grant fences, reconnect/logout invalidation and stale-write rejection passed.');
  } finally {
    internals._load = originalLoad; globalThis.fetch = originalFetch;
    if (previousRoot === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = previousRoot;
    await database.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

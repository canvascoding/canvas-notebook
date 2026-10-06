import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { IntegrationExecutionContext, IntegrationSourceSnapshot } from '../app/lib/integration-tools/contracts';

type Account = { slug: string; status: string; disabled?: boolean; id?: string };
type ProviderCall = { path: string; cursor: string | null; userId: string | null };
const APPS = [
  { slug: 'canva', name: 'Canva', no_auth: false },
  { slug: 'slack', name: 'Slack', no_auth: false },
  { slug: 'duckduckgo', name: 'DuckDuckGo', no_auth: true },
  { slug: 'github', name: 'GitHub', no_auth: false },
  { slug: 'google', name: 'Google', no_auth: true },
];

async function createFixture() {
  const calls: ProviderCall[] = [];
  const accounts = new Map<string, Account[]>();
  const accountFailures = new Map<string, { cursor: string | null; status: number }>();
  let toolkitFailure: { cursor: string | null; status: number } | null = null;
  let repeatCursor = false;
  let malformedNoAuth = false;
  let activeRequests = 0;
  let peakAccountRequests = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const managed = url.pathname.startsWith('/v1/managed/composio');
    const userId = managed ? stringHeader(request.headers['x-canvas-composio-user-id']) : url.searchParams.get('user_ids');
    const cursor = url.searchParams.get('cursor');
    calls.push({ path: url.pathname, userId, cursor });
    const send = (payload: unknown, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (managed) assert.equal(request.headers.authorization, 'Bearer fixture-instance-token');
    if (url.pathname === '/api/v3.1/toolkits' || url.pathname === '/v1/managed/composio/toolkits') {
      if (toolkitFailure?.cursor === cursor) return send({ error: 'secret-provider-token-DO-NOT-EXPOSE' }, toolkitFailure.status);
      const page = cursor ? APPS.slice(3) : APPS.slice(0, 3);
      const items = page.map((app) => ({ ...app, no_auth: malformedNoAuth && app.slug === 'canva' ? 'false' : app.no_auth,
        is_local_toolkit: false,
        meta: { description: `${app.name} catalogue metadata`, tools_count: 999 } }));
      return send({ [managed ? 'toolkits' : 'items']: items, next_cursor: repeatCursor ? 'page-2' : cursor ? null : 'page-2', total_pages: 2 });
    }
    if (url.pathname === '/api/v3.1/connected_accounts' || url.pathname === '/v1/managed/composio/status') {
      assert.ok(userId, 'Provider identity must be derived from the resolved profile');
      const failure = accountFailures.get(userId!);
      if (failure?.cursor === cursor) return send({ error: 'secret-profile-token-DO-NOT-EXPOSE' }, failure.status);
      activeRequests += 1;
      peakAccountRequests = Math.max(peakAccountRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeRequests -= 1;
      const list = accounts.get(userId!) || [];
      const page = managed ? list : list.slice(cursor ? 2 : 0, cursor ? list.length : 2);
      const items = page.map((item) => ({
        id: item.id || `ca-${userId}-${item.slug}`, toolkit: { slug: item.slug, name: APPS.find((app) => app.slug === item.slug)?.name },
        status: item.status, status_reason: null, is_disabled: item.disabled || false,
        auth_config: { id: `ac-${item.slug}`, is_composio_managed: true, is_disabled: false },
        created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z',
      }));
      if (managed) return send({ configured: true, apiKeyValid: true, providerHealthy: true,
        connectedAccounts: items.map((item) => ({ id: item.id, toolkit: item.toolkit, status: item.status, is_disabled: item.is_disabled })) });
      return send({ items, next_cursor: !cursor && list.length > 2 ? 'accounts-2' : null,
        total_pages: list.length > 2 ? 2 : 1 });
    }
    return send({ error: `Unexpected endpoint ${url.pathname}` }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  return { accounts, calls, accountFailures, baseUrl: `http://127.0.0.1:${address.port}`,
    setToolkitFailure: (value: typeof toolkitFailure) => { toolkitFailure = value; },
    setRepeatCursor: (value: boolean) => { repeatCursor = value; },
    setMalformedNoAuth: (value: boolean) => { malformedNoAuth = value; },
    peakAccountRequests: () => peakAccountRequests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } };
}

function stringHeader(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function app(snapshot: IntegrationSourceSnapshot, slug: string, profileName: string) {
  const provider = snapshot.providers.find((item) => item.application === slug && item.connection?.displayName === profileName);
  assert.ok(provider, `${slug}/${profileName} must be present`);
  return provider;
}

async function main() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-integration-composio-'));
  const testDb = await createPiTestDatabase();
  const provider = await createFixture();
  const envKeys = ['DATA', 'CANVAS_DATA_ROOT', 'COMPOSIO_BASE_URL', 'COMPOSIO_API_KEY',
    'CANVAS_MANAGED_SERVICES_ENABLED', 'CANVAS_CONTROL_PLANE_URL', 'CANVAS_INSTANCE_TOKEN'] as const;
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { DATA: dataDir, CANVAS_DATA_ROOT: dataDir,
    COMPOSIO_BASE_URL: provider.baseUrl, CANVAS_MANAGED_SERVICES_ENABLED: 'false' });
  delete process.env.COMPOSIO_API_KEY;
  const workspace = { workspaceId: 'integration-catalog-team', workspaceType: 'team',
    organizationId: 'integration-catalog-org', displayName: 'Catalogue test', legacy: false };
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return testDb;
    if (request === '@/app/lib/pi/session-workspace-context') return {
      resolveAgentSessionWorkspaceForUser: async ({ userId }: { userId: string }) => {
        assert.ok(['catalogue-user-a', 'catalogue-user-b'].includes(userId));
        return workspace;
      },
    };
    return originalLoad(request, parent, isMain);
  };
  try {
    const database = await testDb.openDb();
    for (const userId of ['catalogue-user-a', 'catalogue-user-b']) {
      await database.run('INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES ($1,$1,$2,1,1,1)', [userId, `${userId}@example.test`]);
    }
    await database.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,created_at,updated_at) VALUES ('integration-catalog-org','catalogue-user-a',1,1)");
    await database.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,created_at,updated_at) VALUES ('integration-catalog-team','integration-catalog-org','team','workspaces/integration-catalog-team','Catalogue test',1,1)");
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'fixture-key' }], { secretScope: 'legacy' });
    const { resolveComposioContext } = await import('../app/lib/composio/composio-context');
    const { createComposioProfile, setComposioWorkspaceProfileOverride, archiveComposioProfile } = await import('../app/lib/composio/composio-profiles');
    const { listComposioIntegrationProviders } = await import('../app/lib/integration-tools/adapters/composio');
    const context = (actorUserId: string): IntegrationExecutionContext => ({ actorUserId,
      organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, policyRevision: 'fixture-policy' });
    const defaultA = await resolveComposioContext({ userId: 'catalogue-user-a', workspaceId: workspace.workspaceId });
    const defaultB = await resolveComposioContext({ userId: 'catalogue-user-b', workspaceId: workspace.workspaceId });
    const design = await createComposioProfile({ ownerUserId: 'catalogue-user-a', name: 'Design accounts' });
    const archived = await createComposioProfile({ ownerUserId: 'catalogue-user-a', name: 'Archived accounts' });
    await archiveComposioProfile({ ownerUserId: 'catalogue-user-a', profileId: archived.id });
    provider.accounts.set(defaultA.composioUserId, [
      { slug: 'canva', status: 'ACTIVE' }, { slug: 'slack', status: 'INITIATED' },
      { slug: 'google', status: 'ACTIVE' }, { slug: 'github', status: 'ACTIVE', disabled: true },
    ]);
    provider.accounts.set(defaultB.composioUserId, [{ slug: 'canva', status: 'INITIATED' }, { slug: 'slack', status: 'ACTIVE' }]);
    provider.accounts.set(design.composioUserId, [{ slug: 'canva', status: 'EXPIRED' }, { slug: 'github', status: 'ACTIVE' }]);
    provider.accounts.set(archived.composioUserId, [{ slug: 'canva', status: 'ACTIVE' }]);
    const a = await listComposioIntegrationProviders(context('catalogue-user-a'));
    const b = await listComposioIntegrationProviders(context('catalogue-user-b'));
    assert.equal(a.complete, true);
    assert.equal(a.providers.length, 8, 'Four visible apps for each active owned profile');
    assert.equal(b.providers.length, 4);
    assert.equal(app(a, 'canva', defaultA.profileName).state, 'ready');
    assert.equal(app(b, 'canva', defaultB.profileName).state, 'auth_required');
    assert.equal(app(a, 'slack', defaultA.profileName).canExecute, false, 'INITIATED is not connected');
    assert.equal(app(a, 'github', defaultA.profileName).canExecute, false, 'Disabled ACTIVE account is not usable');
    assert.equal(app(a, 'github', design.name).canExecute, true);
    assert.equal(app(a, 'duckduckgo', design.name).canExecute, true, 'No-auth apps need no account');
    assert.ok(a.providers.every((item) => item.scope.type === 'user' && item.scope.ownerUserId === 'catalogue-user-a'));
    assert.ok(a.providers.every((item) => item.application !== 'google' && item.connection?.displayName !== archived.name));
    assert.notEqual(app(a, 'canva', defaultA.profileName).providerRef, app(a, 'canva', design.name).providerRef);
    assert.notEqual(app(a, 'canva', defaultA.profileName).providerRef, app(b, 'canva', defaultB.profileName).providerRef);
    assert.equal(app(a, 'canva', defaultA.profileName).connection?.effective, true);
    assert.ok(!JSON.stringify(a).includes('ca-') && !JSON.stringify(a).includes(design.composioUserId));
    assert.ok(provider.calls.filter((call) => call.path === '/api/v3.1/connected_accounts').every((call) =>
      [defaultA.composioUserId, defaultB.composioUserId, design.composioUserId].includes(call.userId!)));
    assert.equal(provider.calls.filter((call) => call.path === '/api/v3.1/toolkits').length, 4, 'App metadata fetched once per snapshot, not per profile');
    assert.ok(provider.calls.some((call) => call.cursor === 'accounts-2'));
    assert.ok(provider.peakAccountRequests() <= 2);
    assert.ok(provider.calls.every((call) => !call.path.includes('/tools') && !call.path.includes('/session')));
    const unchanged = await listComposioIntegrationProviders(context('catalogue-user-a'));
    assert.equal(unchanged.revision, a.revision, 'Fresh status timestamps do not invalidate an unchanged catalogue cursor');
    const designAccounts = provider.accounts.get(design.composioUserId)!;
    provider.accounts.set(design.composioUserId, [...designAccounts, { slug: 'github', status: 'ACTIVE', id: 'second-github-account' }]);
    const ambiguous = await listComposioIntegrationProviders(context('catalogue-user-a'));
    assert.equal(app(ambiguous, 'github', design.name).state, 'unknown');
    assert.equal(app(ambiguous, 'github', design.name).canExecute, false, 'Multiple active accounts need an explicit account binding');
    assert.equal(app(ambiguous, 'github', design.name).authorized, true);
    provider.accounts.set(design.composioUserId, designAccounts.map((item) => item.slug === 'github' ? { ...item, id: 'reconnected-github-account' } : item));
    const reconnected = await listComposioIntegrationProviders(context('catalogue-user-a'));
    assert.notEqual(reconnected.revision, a.revision, 'Changing an actual connected account invalidates a catalogue cursor');
    provider.accounts.set(design.composioUserId, designAccounts);
    provider.setMalformedNoAuth(true);
    const malformed = await listComposioIntegrationProviders(context('catalogue-user-b'));
    assert.equal(app(malformed, 'canva', defaultB.profileName).requiresAuth, true);
    assert.equal(app(malformed, 'canva', defaultB.profileName).canExecute, false, 'String false cannot enable a no-auth app');
    provider.setMalformedNoAuth(false);
    await assert.rejects(setComposioWorkspaceProfileOverride({ userId: 'catalogue-user-b', workspaceId: workspace.workspaceId, profileId: design.id }), /not found/u);
    await setComposioWorkspaceProfileOverride({ userId: 'catalogue-user-a', workspaceId: workspace.workspaceId, profileId: design.id });
    const switched = await listComposioIntegrationProviders(context('catalogue-user-a'));
    assert.equal(app(switched, 'canva', design.name).connection?.effective, true);
    assert.equal(app(switched, 'canva', defaultA.profileName).connection?.effective, false);
    assert.equal(app(switched, 'canva', design.name).providerRef, app(a, 'canva', design.name).providerRef);
    assert.notEqual(switched.revision, a.revision);

    provider.accountFailures.set(design.composioUserId, { cursor: null, status: 401 });
    const partialAccount = await listComposioIntegrationProviders(context('catalogue-user-a'));
    assert.equal(partialAccount.complete, false);
    assert.equal(app(partialAccount, 'canva', defaultA.profileName).canExecute, true, 'Another failed profile cannot disable a healthy profile');
    assert.equal(app(partialAccount, 'github', design.name).state, 'degraded');
    assert.equal(app(partialAccount, 'duckduckgo', design.name).canExecute, true, 'Account enumeration is irrelevant to a no-auth app');
    assert.ok(partialAccount.providerErrors.length > 0);
    assert.ok(!JSON.stringify(partialAccount).includes('DO-NOT-EXPOSE'));
    provider.accountFailures.clear();
    provider.accountFailures.set(defaultA.composioUserId, { cursor: 'accounts-2', status: 403 });
    const partialAccountPage = await listComposioIntegrationProviders(context('catalogue-user-a'));
    assert.equal(partialAccountPage.complete, false);
    assert.equal(app(partialAccountPage, 'canva', defaultA.profileName).authorized, true, 'A successful page remains visible');
    assert.equal(app(partialAccountPage, 'canva', defaultA.profileName).canExecute, false, 'An incomplete auth check fails closed');
    assert.equal(app(partialAccountPage, 'github', design.name).canExecute, true);
    provider.accountFailures.clear();
    provider.setToolkitFailure({ cursor: 'page-2', status: 401 });
    const partialCatalog = await listComposioIntegrationProviders(context('catalogue-user-a'));
    assert.equal(partialCatalog.complete, false);
    assert.equal(app(partialCatalog, 'canva', defaultA.profileName).canExecute, true);
    assert.equal(app(partialCatalog, 'github', design.name).canExecute, true, 'Live account metadata preserves a known app after catalogue failure');
    assert.ok(!JSON.stringify(partialCatalog).includes('DO-NOT-EXPOSE'));
    provider.setToolkitFailure(null);
    provider.setRepeatCursor(true);
    const repeated = await listComposioIntegrationProviders(context('catalogue-user-b'));
    assert.equal(repeated.complete, false);
    assert.ok(repeated.providerErrors.some((error) => error.code === 'COMPOSIO_BAD_RESPONSE'));
    provider.setRepeatCursor(false);

    // The managed path reuses the signed Canvas proxy, with the exact same owned
    // profile identity and app-only disclosure. No third-party live account is used.
    await replaceScopedEnvEntries('integrations', [], { secretScope: 'legacy' });
    Object.assign(process.env, { CANVAS_MANAGED_SERVICES_ENABLED: 'true',
      CANVAS_CONTROL_PLANE_URL: provider.baseUrl, CANVAS_INSTANCE_TOKEN: 'fixture-instance-token' });
    const managed = await listComposioIntegrationProviders(context('catalogue-user-a'));
    assert.equal(managed.complete, true);
    assert.equal(managed.providers.length, 8);
    assert.equal(app(managed, 'canva', defaultA.profileName).canExecute, true);
    assert.equal(app(managed, 'canva', design.name).canExecute, false);
    assert.equal(app(managed, 'duckduckgo', design.name).canExecute, true);
    assert.equal(app(managed, 'canva', design.name).providerRef, app(a, 'canva', design.name).providerRef);
    assert.ok(provider.calls.filter((call) => call.path === '/v1/managed/composio/status').every((call) =>
      [defaultA.composioUserId, design.composioUserId].includes(call.userId!)));
    provider.accountFailures.set(design.composioUserId, { cursor: null, status: 403 });
    const managedPartial = await listComposioIntegrationProviders(context('catalogue-user-a'));
    assert.equal(managedPartial.complete, false);
    assert.equal(app(managedPartial, 'canva', defaultA.profileName).canExecute, true);
    assert.equal(app(managedPartial, 'github', design.name).canExecute, false);
    assert.ok(!JSON.stringify(managedPartial).includes('DO-NOT-EXPOSE'));
    console.log('integration-tool-composio-catalog-test: ok (real SDK HTTP, local/managed, profiles/user isolation, ACTIVE/no-auth/hidden, pagination and partial errors)');
  } finally {
    internals._load = originalLoad;
    await provider.close();
    await testDb.close();
    await rm(dataDir, { recursive: true, force: true });
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

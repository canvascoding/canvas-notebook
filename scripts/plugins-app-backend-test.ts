import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { NextRequest } from 'next/server';
import { emailOAuthFeedbackKey } from '../app/lib/email/oauth-feedback';
import { readPluginNavigation } from '../app/lib/plugins/plugin-navigation';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const internals = Module as typeof Module & { _load: LoadFn };
const originalLoad = internals._load;
const originalEnvironment = { ...process.env };
const inserts: unknown[][] = [];
let mode: 'local' | 'managed' = 'local';
let returnedEmailUrl = '/en/plugins?view=installed&plugin=assigned&source=installed&scope=organization';
let emailFails = false;
let callbackConsumed = false;
const readinessCalls: Array<Record<string, unknown>> = [];
const context = { userId: 'owner', workspaceId: 'verified-workspace', profileId: 'profile', composioUserId: 'entity', storageScope: { userId: 'owner' } };
const database = { openDb: async () => ({
  run: async (sql: string, values: unknown[]) => { if (sql.includes('INSERT INTO composio_oauth_flow_states')) inserts.push(values); },
  close: async () => undefined,
}) };
const personal = { name: 'same-name', scopeType: 'user', resourceId: 'personal', version: '1.0.0', enabled: true, skills: [], connectors: { email: [{ label: 'Personal', required: false }] } };
const organization = { ...personal, scopeType: 'organization', resourceId: 'assigned', connectors: { email: [{ label: 'Assigned', required: true }] } };
let repeatAssignedResource = false;
let registryDeduplicator: (plugins: typeof personal[], preferredScope: string) => typeof personal[];

internals._load = (request, parent, isMain) => {
  const file = parent?.filename || '';
  if (request === 'server-only') return {};
  if (file.endsWith('/composio-oauth-state.ts')) {
    if (request === '@/app/lib/db') return database;
    if (request === '@/app/lib/security/auth-secret') return { resolveAuthSecret: () => 'oauth-test-key' };
    if (request === './composio-profiles') return { ComposioProfileError: class extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } } };
  }
  if (file.endsWith('/composio-auth.ts') || file.endsWith('/composio-gateway.ts')) {
    if (request === './composio-client') return { getComposio: async () => ({}), getComposioMode: async () => mode };
    if (request === './composio-session') return { getComposioSession: async () => ({ authorize: async () => ({ redirectUrl: 'https://auth.example.test/connect' }) }), resetSessionCache: () => undefined };
    if (request === './composio-toolkit-registry') return { getAvailableToolkitsRaw: async () => [{ slug: 'drive' }], clearToolkitCache: () => undefined };
    if (request === './composio-context') return { composioContextCacheKey: () => 'fixture' };
    if (request === './managed-composio-client') return { requestManagedComposio: async () => ({ redirectUrl: 'https://auth.example.test/managed' }) };
    if (request === '../db' || request === '../db/schema' || request === './composio-tool-discovery' || request === './managed-composio-execution' || request === './composio-webhook-secret') return {};
  }
  if (file.endsWith('/api/composio/connect/[toolkit]/route.ts')) {
    if (request === '@/app/lib/composio/composio-request') return { requireComposioRequestContext: async () => ({ composioContext: context }) };
    if (request === '@/app/lib/composio/composio-context') return { toPublicEffectiveComposioContext: () => ({ id: 'profile' }) };
  }
  if (file.endsWith('/api/composio/callback/route.ts')) {
    if (request === '@/app/lib/composio/composio-oauth-state') return { consumeComposioOAuthFlowState: async () => {
      if (callbackConsumed) throw new Error('Already consumed');
      callbackConsumed = true;
      return { ...context, toolkitSlug: 'drive', returnPath: '/en/plugins?plugin=drive&source=installed&workspaceId=verified-workspace' };
    } };
    if (request === '@/app/lib/composio/composio-gateway') return { clearComposioGatewayCaches: () => undefined };
    if (request === '@/app/lib/composio/composio-context') return { composioContextFromEffectiveProfile: () => context };
    if (request === '@/app/lib/composio/composio-profiles') return { resolveEffectiveComposioProfile: async () => ({ id: 'profile' }), ComposioProfileError: class extends Error {} };
  }
  if (file.endsWith('/api/plugins/route.ts')) {
    if (request === 'next/headers') return { headers: async () => new Headers() };
    if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => ({ user: { id: 'owner' } }) } } };
    if (request === '@/app/lib/organization/permissions') return { readOrganizationPermissionForUser: async () => ({ organizationId: 'org', permission: { status: 'active', role: 'member' } }) };
    if (request === '@/app/lib/capabilities/request-scope') return {
      resolveCapabilityStorageScope: () => ({ scopeType: 'user' }),
      resolveCapabilityExecutionContextForUser: async (input: { requestedWorkspaceId: string }) => {
        assert.equal(input.requestedWorkspaceId, 'requested-workspace');
        return { organizationId: 'org', userId: 'owner', workspaceId: 'verified-workspace' };
      },
    };
    if (request === '@/app/lib/pi/session-workspace-context') return { resolveAgentSessionWorkspaceForUser: async () => { throw new Error('Workspace should resolve once'); } };
    if (request === '@/app/lib/plugins/canvas-plugin-registry') return { listCanvasPlugins: async (scope: { scopeType: string }) => [scope.scopeType === 'organization' ? organization : personal], deduplicateCanvasPluginInstallRecords: (plugins: typeof personal[], preferredScope: string) => registryDeduplicator(plugins, preferredScope) };
    if (request === '@/app/lib/plugins/plugin-connection-readiness') return { resolvePluginConnectionReadiness: async (input: Record<string, unknown>) => {
      readinessCalls.push(input);
      const required = (input.connectors as typeof personal.connectors).email[0].required;
      return { ready: !required, items: [{ type: 'email', key: required ? 'assigned' : 'personal', required, ready: false, action: 'configure-email' }], summary: { total: 1, ready: 0, requiredMissing: required ? 1 : 0, recommendedMissing: required ? 0 : 1 } };
    } };
    if (request === '@/app/lib/capabilities/catalog') return { resolveEffectiveCapabilitySnapshot: async () => {
      assert.equal(readinessCalls.length % 2, 0, 'both exact manifests are checked before snapshot resolution');
      return { capabilities: (repeatAssignedResource ? [personal, organization, organization] : [personal, organization]).map(plugin => ({ ref: { ...plugin, resourceType: 'plugin' }, effectiveEnabled: plugin.scopeType === 'organization', readiness: plugin.scopeType === 'organization' ? 'personal-connection-required' : 'conflict' })) };
    } };
  }
  if (file.endsWith('/api/email/oauth/callback/route.ts')) {
    if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => ({ user: { id: 'owner' } }) } } };
    if (request === '@/app/lib/utils/request-origin') return { getPublicRequestOrigin: () => 'https://canvas.example.test' };
    if (request === '@/app/lib/email/local-service') return {
      readLocalEmailOAuthReturnUrl: async (userId: string, state: string) => { assert.equal(userId, 'owner'); return state === 'owned' ? returnedEmailUrl : undefined; },
      completeLocalEmailOAuth: async () => { if (emailFails) throw new Error('token_exchange_failed'); return { returnUrl: returnedEmailUrl }; },
    };
  }
  if (file.endsWith('/email/local-service.ts') && request.startsWith('@/app/lib/') && request !== '@/app/lib/runtime-data-paths') return {};
  if (file.endsWith('/canvas-plugin-store.ts')) {
    if (request === '@/app/lib/plugins/canvas-plugin-registry') return { listCanvasPlugins: async () => [] };
    if (request === '@/app/lib/plugins/visible-installed-plugins') return { listVisibleInstalledCanvasPlugins: async () => [] };
    if (request === '@/app/lib/skills/canvas-skill-store') return { readCanvasSkillRegistry: async () => ({ skills: {} }) };
    if (request === '@/app/lib/plugins/plugin-mcp-template-service') return {};
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-backend-'));
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.BASE_URL = 'https://canvas.example.test';
  try {
    const registrySource = await fs.readFile('app/lib/plugins/canvas-plugin-registry.ts', 'utf8');
    const parsedRegistry = ts.createSourceFile('canvas-plugin-registry.ts', registrySource, ts.ScriptTarget.Latest, true);
    const deduplicator = parsedRegistry.statements.find((node): node is ts.FunctionDeclaration => (
      ts.isFunctionDeclaration(node) && node.name?.text === 'deduplicateCanvasPluginInstallRecords'
    ));
    assert.ok(deduplicator, 'the registry mock executes the actual runtime name-preference helper');
    const deduplicatorCode = ts.transpileModule(`${deduplicator.getText(parsedRegistry).replace(/^export\s+/, '')}\ndeduplicateCanvasPluginInstallRecords;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    registryDeduplicator = new vm.Script(deduplicatorCode).runInNewContext();
    assert.equal(registryDeduplicator([personal, organization], 'user').length, 1, 'runtime package preference intentionally remains name-based');

    const { createComposioOAuthFlowState } = await import('../app/lib/composio/composio-oauth-state');
    const returnPath = '/en/plugins?view=installed&scope=organization&plugin=drive&source=installed&resource=assigned&workspaceId=spoofed';
    const flow = await createComposioOAuthFlowState({ context: context as never, toolkitSlug: 'drive', returnPath });
    const destination = new URL(flow.returnPath, process.env.BASE_URL);
    assert.equal(destination.pathname, '/en/plugins');
    assert.equal(destination.searchParams.get('resource'), 'assigned');
    assert.equal(destination.searchParams.get('scope'), 'organization');
    assert.equal(destination.searchParams.get('workspaceId'), 'verified-workspace');
    assert.equal(inserts.at(-1)?.[6], flow.returnPath, 'the validated return path is bound to opaque OAuth state');
    for (const unsafe of ['https://evil.test', '//evil.test', '/\\evil.test', '/plugins\n']) {
      await assert.rejects(createComposioOAuthFlowState({ context: context as never, toolkitSlug: 'drive', returnPath: unsafe }), /return path is invalid/);
    }
    const mobile = await createComposioOAuthFlowState({ context: context as never, toolkitSlug: 'drive', mobileReturnUrl: 'canvasnotebook://extensions/plugins' });
    assert.equal(mobile.returnPath, 'canvasnotebook://extensions/plugins');
    const defaults = await createComposioOAuthFlowState({ context: context as never, toolkitSlug: 'drive' });
    assert.equal(new URL(defaults.returnPath, process.env.BASE_URL).pathname, '/settings');

    const { connectGatewayToolkit } = await import('../app/lib/composio/composio-gateway');
    for (const gatewayMode of ['local', 'managed'] as const) {
      mode = gatewayMode;
      await connectGatewayToolkit('drive', context as never, { returnPath });
      assert.equal(new URL(String(inserts.at(-1)?.[6]), process.env.BASE_URL).pathname, '/en/plugins', `${mode} mode preserves plugin return`);
    }
    const { POST } = await import('../app/api/composio/connect/[toolkit]/route');
    const unsafeResponse = await POST(new NextRequest('https://canvas.example.test/api/composio/connect/drive', { method: 'POST', body: JSON.stringify({ returnPath: '//evil.test' }) }), { params: Promise.resolve({ toolkit: 'drive' }) });
    assert.equal(unsafeResponse.status, 400);
    const response = await POST(new NextRequest('https://canvas.example.test/api/composio/connect/drive', { method: 'POST', body: JSON.stringify({ returnPath }) }), { params: Promise.resolve({ toolkit: 'drive' }) });
    assert.equal(response.status, 200);
    assert.equal(new URL(String(inserts.at(-1)?.[6]), process.env.BASE_URL).searchParams.get('workspaceId'), 'verified-workspace');

    const { GET: composioCallback } = await import('../app/api/composio/callback/route');
    for (const [error, expected] of [['access_denied', 'cancelled'], ['provider_secret_error', 'failed'], ['', 'returned']]) {
      callbackConsumed = false;
      const callback = await composioCallback(new NextRequest(`https://canvas.example.test/api/composio/callback?flow=bound&error=${error}`));
      const url = new URL(callback.headers.get('location')!);
      assert.equal(url.pathname, '/en/plugins');
      assert.equal(url.searchParams.get('workspaceId'), 'verified-workspace');
      assert.equal(url.searchParams.get(error ? 'composioError' : 'composio'), expected);
      assert.equal(url.searchParams.get('composio'), 'returned', 'existing Settings and mobile round-trip flag remains additive');
      assert.equal(url.href.includes('provider_secret_error'), false);
      assert.equal((await composioCallback(new NextRequest('https://canvas.example.test/api/composio/callback?flow=bound'))).status, 500, 'callback state remains single use');
    }

    const { GET: pluginsGet } = await import('../app/api/plugins/route');
    const defaultResponse = await pluginsGet(new NextRequest('https://canvas.example.test/api/plugins?fresh=1', { headers: { 'x-canvas-workspace-id': 'requested-workspace' } }));
    assert.equal(defaultResponse.status, 200);
    const defaultBody = await defaultResponse.json();
    assert.deepEqual(defaultBody.plugins.map((plugin: { resourceId: string }) => plugin.resourceId), ['assigned'], 'Chat and mobile use the organization namespace owner rather than the hidden personal copy');
    assert.deepEqual(defaultBody.stats, { total: 1, enabled: 1, disabled: 0 });
    const pluginsResponse = await pluginsGet(new NextRequest('https://canvas.example.test/api/plugins?identity=resource&fresh=1', { headers: { 'x-canvas-workspace-id': 'requested-workspace' } }));
    assert.equal(pluginsResponse.status, 200);
    const installedBody = await pluginsResponse.json();
    const installed = installedBody.plugins;
    assert.equal(installed.length, 1, 'the presentation API hides the shadowed personal copy while retaining the organization identity');
    assert.deepEqual(installed.map((plugin: { resourceId: string; scopeType: string }) => [plugin.resourceId, plugin.scopeType]), [['assigned', 'organization']]);
    assert.deepEqual(installedBody.stats, { total: 1, enabled: 1, disabled: 0 }, 'statistics count visible resources and their effective state');
    assert.equal(installed.find((plugin: { resourceId: string }) => plugin.resourceId === 'assigned').connectionReadiness.summary.requiredMissing, 1);
    assert.equal(installed.some((plugin: { resourceId: string }) => plugin.resourceId === 'personal'), false);
    const orgDetail = readPluginNavigation(new URL('https://canvas.example.test/en/plugins?view=installed&plugin=same-name&source=installed&resourceId=assigned&workspaceId=verified-workspace').searchParams);
    assert.equal(installed.find((plugin: { resourceId: string }) => plugin.resourceId === orgDetail.resourceId)?.scopeType, 'organization', 'an exact organization detail URL resolves the real API response instead of falling back to the same-name personal record');
    assert.ok(readinessCalls.every(call => call.fresh === true && call.workspaceId === 'verified-workspace' && call.userId === 'owner'));
    repeatAssignedResource = true;
    const repeated = await pluginsGet(new NextRequest('https://canvas.example.test/api/plugins?identity=resource&fresh=1', { headers: { 'x-canvas-workspace-id': 'requested-workspace' } }));
    const repeatedBody = await repeated.json();
    assert.equal(repeatedBody.plugins.length, 1, 'duplicate resource references and shadowed personal identities do not reappear');
    assert.deepEqual(repeatedBody.stats, installedBody.stats);
    repeatAssignedResource = false;
    await pluginsGet(new NextRequest('https://canvas.example.test/api/plugins?identity=resource&workspaceId=requested-workspace'));
    assert.ok(readinessCalls.slice(-2).every(call => call.fresh === false));

    const { GET: emailGet } = await import('../app/api/email/oauth/callback/route');
    for (const [query, expected] of [
      ['error=access_denied&error_description=private-provider-details&state=owned', 'cancelled'],
      ['error=user_cancelled&state=owned', 'cancelled'],
      ['error=private-provider-error&error_description=private-provider-details&state=owned', 'failed'],
      ['state=owned', 'missing_code_or_state'],
      ['code=code&state=owned', 'failed'],
    ]) {
      emailFails = query.startsWith('code=');
      const emailResponse = await emailGet(new NextRequest(`https://canvas.example.test/api/email/oauth/callback?${query}`));
      const url = new URL(emailResponse.headers.get('location')!);
      assert.equal(url.pathname, '/en/plugins', 'cancellation and token failure return to the original detail');
      assert.equal(url.searchParams.get('plugin'), 'assigned');
      assert.equal(url.searchParams.get('emailOAuthError'), expected);
      assert.equal(url.href.includes('private-provider'), false, 'callback destinations never contain provider diagnostics');
      assert.equal(url.href.includes('token_exchange_failed'), false, 'callback destinations never expose internal token errors');
    }
    for (const [code, expected] of [
      ['cancelled', 'errors.oauthCancelled'], ['access_denied', 'errors.oauthCancelled'], ['user_cancelled', 'errors.oauthCancelled'],
      ['missing_code_or_state', 'errors.oauthIncomplete'], ['unauthorized', 'errors.oauthUnauthorized'],
      ['failed', 'errors.oauthFailed'], ['legacy private provider diagnostics', 'errors.oauthFailed'],
    ]) assert.equal(emailOAuthFeedbackKey(code), expected, 'Settings maps controlled and legacy callback values to localized copy');
    returnedEmailUrl = 'https://evil.test';
    const rejectedReturn = await emailGet(new NextRequest('https://canvas.example.test/api/email/oauth/callback?error=access_denied&state=owned'));
    assert.equal(new URL(rejectedReturn.headers.get('location')!).origin, 'https://canvas.example.test');

    const { readLocalEmailOAuthReturnUrl } = await import('../app/lib/email/local-service');
    const { resolveUserSecretsDir } = await import('../app/lib/runtime-data-paths');
    const state = 's'.repeat(43);
    const stateFile = path.join(resolveUserSecretsDir('owner'), 'email-oauth', '.state', `${createHash('sha256').update(state).digest('hex')}.json`);
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const stored = { state, userId: 'owner', returnUrl: '/plugins?plugin=assigned', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await fs.writeFile(stateFile, JSON.stringify(stored));
    assert.equal(await readLocalEmailOAuthReturnUrl('owner', state), stored.returnUrl);
    assert.equal(await readLocalEmailOAuthReturnUrl('owner', '../private-state', true), undefined);
    assert.equal(await readLocalEmailOAuthReturnUrl('other-user', state, true), undefined);
    await fs.writeFile(stateFile, JSON.stringify({ ...stored, expiresAt: new Date(0).toISOString() }));
    assert.equal(await readLocalEmailOAuthReturnUrl('owner', state), undefined);
    await fs.writeFile(stateFile, JSON.stringify(stored));
    assert.equal(await readLocalEmailOAuthReturnUrl('owner', state, true), stored.returnUrl);
    await assert.rejects(fs.stat(stateFile), { code: 'ENOENT' });

    const registryPath = path.join(dataRoot, 'registry.json');
    await fs.writeFile(registryPath, JSON.stringify({ schemaVersion: 1, id: 'test-store', name: 'Test Store', updatedAt: new Date().toISOString(), plugins: Array.from({ length: 15 }, (_, i) => ({ name: `plugin-${i}`, displayName: `Plugin ${String(i).padStart(2, '0')}`, description: '', latestVersion: '1.0.0', versions: { '1.0.0': { version: '1.0.0', downloadUrl: 'https://example.test/archive.zip', checksum: `sha256:${'a'.repeat(64)}` } } })) }));
    process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL = pathToFileURL(registryPath).toString();
    const { listCanvasPluginStore } = await import('../app/lib/plugins/canvas-plugin-store');
    const first = await listCanvasPluginStore({ pageSize: 12 });
    assert.equal(first.plugins.some(plugin => plugin.name === 'plugin-14'), false);
    const detail = await listCanvasPluginStore({ name: 'plugin-14', pageSize: 12 });
    assert.equal(detail.pagination.totalItems, 1);
    assert.equal(detail.plugins[0].name, 'plugin-14', 'exact-name lookup restores a detail beyond the first catalog page');
    assert.equal((await listCanvasPluginStore({ name: 'plugin-1' })).plugins.length, 1, 'name lookup is exact rather than substring search');
    assert.equal((await listCanvasPluginStore({ name: 'missing' })).plugins.length, 0);
    console.log('Plugins backend: secure Composio local/managed returns, exact scoped readiness, email cancellation/error state and off-page catalog detail passed.');
  } finally {
    internals._load = originalLoad;
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

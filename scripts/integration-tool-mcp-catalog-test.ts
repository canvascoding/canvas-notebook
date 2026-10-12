import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { installMcpAccessMocks } from './fixtures/mcp-test-access';

async function startFixture() {
  let origin = '';
  let requests = 0;
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'catalog-fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }));
    return server;
  }, { legacy: 'reject' });
  const server = http.createServer(async (request, response) => {
    requests += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = await handler.fetch(new Request(`${origin}${request.url}`, {
      method: request.method,
      headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}),
    }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/mcp`,
    get requests() { return requests; },
    close: async () => {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function main() {
  const environmentKeys = ['CANVAS_DATA_ROOT', 'INTEGRATIONS_ENV_MASTER_KEY', 'BASE_URL', 'MCP_ALLOW_INSECURE_HTTP', 'MCP_ALLOW_PRIVATE_NETWORK', 'MCP_ALLOW_STDIO'] as const;
  const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-integration-mcp-catalog-'));
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.INTEGRATIONS_ENV_MASTER_KEY = crypto.randomBytes(32).toString('base64url');
  process.env.BASE_URL = 'http://localhost:3000';
  process.env.MCP_ALLOW_INSECURE_HTTP = 'true';
  process.env.MCP_ALLOW_PRIVATE_NETWORK = 'true';
  process.env.MCP_ALLOW_STDIO = 'false';
  const { memberships, restore } = installMcpAccessMocks();
  memberships.set('admin', { organizationId: 'org-a', role: 'admin', status: 'active' });
  memberships.set('member', { organizationId: 'org-a', role: 'member', status: 'active' });
  memberships.set('other', { organizationId: 'org-b', role: 'admin', status: 'active' });
  const fixture = await startFixture();
  const { listMcpIntegrationProviders } = await import('../app/lib/integration-tools/adapters/mcp');
  const { readMcpConfig, writeMcpConfigRaw, resolveMcpConfigPath } = await import('../app/lib/mcp/config');
  const { hashMcpAuthConfig } = await import('../app/lib/mcp/connection-identity');
  const { publishMcpServerDefinition, setMcpServerDefinitionEnabled } = await import('../app/lib/mcp/server-definitions');
  const { createPersonalMcpConnection } = await import('../app/lib/mcp/personal-connections');
  const { recordMcpConnectionObservation } = await import('../app/lib/mcp/connection-health');
  const { readMcpOAuthLifecycle } = await import('../app/lib/mcp/oauth-lifecycle');
  const { writeMcpCredentialJson } = await import('../app/lib/mcp/credential-storage');
  const { resolveScopedMcpPath, MCP_SYSTEM_SCOPE } = await import('../app/lib/mcp/scope');
  const { resolveOrganizationMcpTemplatesDir } = await import('../app/lib/runtime-data-paths');
  const { patchUnifiedEnvEntries } = await import('../app/lib/secrets/unified-env-store');
  const { listMcpTools, closeAllMcpServers } = await import('../app/lib/mcp/manager');
  const context = (actorUserId: string, organizationId: string | null = 'org-a', workspaceId = 'team-workspace') => ({
    actorUserId, organizationId, workspaceId, policyRevision: 'catalog-policy-1',
  });
  const adminScope = { userId: 'admin', organizationId: 'org-a' };
  const memberScope = { userId: 'member', organizationId: 'org-a' };

  try {
    await writeMcpConfigRaw(JSON.stringify({ mcpServers: {
      systemPrivate: { url: fixture.url, auth: 'none', displayName: 'System private account' },
    } }), MCP_SYSTEM_SCOPE);
    const firstDefinition = await publishMcpServerDefinition('org-a', 'Canva', { url: fixture.url, auth: 'none' });
    const secondDefinition = await publishMcpServerDefinition('org-a', 'Available template', { url: fixture.url, auth: 'none' });
    await publishMcpServerDefinition('org-b', 'Foreign organization private label', { url: fixture.url, auth: 'none' });
    const accountA = await createPersonalMcpConnection('member', firstDefinition.id, 'Canva first');
    const accountB = await createPersonalMcpConnection('member', firstDefinition.id, 'Canva second');
    const memberConfig = await readMcpConfig(memberScope);
    memberConfig.mcpServers[accountA.server].displayName = 'Canva';
    memberConfig.mcpServers[accountB.server].displayName = 'Canva';
    memberConfig.mcpServers[accountB.server].enabled = false;
    memberConfig.mcpServers.unapproved = { url: fixture.url, auth: 'none', displayName: 'Private unapproved' };
    await writeMcpConfigRaw(JSON.stringify(memberConfig), memberScope);
    await writeMcpConfigRaw(JSON.stringify({ mcpServers: {
      foreignAccount: { url: fixture.url, auth: 'none', displayName: 'Foreign private account' },
    } }), { userId: 'other', organizationId: 'org-b' });

    const member = await listMcpIntegrationProviders(context('member'));
    const existing = member.providers.filter(provider => provider.configured);
    assert.equal(existing.length, 2, 'real production access excludes unapproved member connections');
    assert.equal(new Set(existing.map(provider => provider.providerRef)).size, 2, 'duplicate labels have distinct actual connection identities');
    assert.deepEqual(existing.map(provider => provider.displayName), ['Canva', 'Canva']);
    assert(existing.every(provider => provider.application === undefined), 'an account label cannot manufacture application metadata');
    assert(existing.every(provider => provider.scope.type === 'user' && provider.scope.ownerUserId === 'member'), 'approved templates do not turn private accounts into shared accounts');
    assert(existing.some(provider => provider.state === 'disabled' && !provider.canExecute));
    assert(existing.some(provider => provider.state === 'unknown' && provider.canExecute && provider.authorized === true && provider.health === 'unknown'), 'unprobed no-auth connection remains callable without invented health');
    const candidates = member.providers.filter(provider => !provider.configured);
    assert.equal(candidates.length, 1, 'an installed definition does not also appear as a setup candidate');
    assert.equal(candidates[0].scope.resourceId, `definition:${secondDefinition.id}`);
    assert.equal(candidates[0].state, 'setup_required');
    assert.equal(candidates[0].canExecute, false, 'a definition never shares an account');
    assert(!JSON.stringify(member).includes('Foreign') && !JSON.stringify(member).includes('System private account'), 'foreign accounts, organization definitions and system fallback are hidden');
    assert.equal(fixture.requests, 0, 'catalog discovery does not contact providers or preload tool lists');
    assert.deepEqual((await listMcpIntegrationProviders(context('member', 'org-a', 'another-allowed-workspace'))).providers.map(provider => provider.providerRef), member.providers.map(provider => provider.providerRef), 'personal connection identity does not change with workspace selection');
    await assert.rejects(() => listMcpIntegrationProviders(context('member', 'org-b')), /organization/i);
    memberships.set('member', { organizationId: 'org-a', role: 'member', status: 'suspended' });
    await assert.rejects(() => listMcpIntegrationProviders(context('member')), /active|seat/i);
    memberships.set('member', { organizationId: 'org-a', role: 'member', status: 'active' });

    const processMarker = path.join(dataRoot, 'process-was-started');
    await writeMcpConfigRaw(JSON.stringify({ mcpServers: {
      remote: { url: fixture.url, auth: 'none', displayName: 'Remote account' },
      personal: { url: fixture.url, auth: 'none', organizationId: null, displayName: 'Unassociated personal account' },
      process: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(processMarker)}, 'started')`], displayName: 'Configured local process' },
      oauth: { url: fixture.url, auth: 'oauth', oauth: { issuer: 'https://identity.example.test' }, displayName: 'OAuth account' },
      bearer: { url: fixture.url, auth: 'none', bearerTokenEnv: 'CANVA_BEARER_TOKEN', displayName: 'Bearer account' },
      apiKey: { url: fixture.url, auth: 'none', headersFromEnv: { 'X-Api-Key': 'CANVA_API_KEY' }, displayName: 'API key account' },
      variable: { url: '${MCP_ACCOUNT_URL}', auth: 'none', displayName: 'Variable endpoint' },
      processAuth: { command: process.execPath, args: ['-e', 'process.exit(0)'], env: { ACCESS_TOKEN: '${PROCESS_ACCESS_TOKEN}' }, displayName: 'Process credential account' },
    } }), adminScope);
    const adminConfig = await readMcpConfig(adminScope);
    const before = await listMcpIntegrationProviders(context('admin'));
    assert.equal(before.providers.find(provider => provider.displayName === 'OAuth account')?.state, 'auth_required');
    assert.equal(before.providers.find(provider => provider.displayName === 'Unassociated personal account')?.authorized, true, 'credential lookup uses the connection association, not a fabricated organization binding');
    for (const name of ['Bearer account', 'API key account', 'Process credential account']) {
      const provider = before.providers.find(provider => provider.displayName === name);
      assert(provider && provider.requiresAuth && !provider.authorized && !provider.canExecute, 'missing static credentials cannot become usable no-auth connections');
      assert(provider.nextActions.some(action => action.kind === 'setup' && action.href === '/settings?tab=secrets'));
    }
    assert.equal(before.providers.find(provider => provider.displayName === 'Variable endpoint')?.state, 'degraded', 'a missing non-credential expression is a configuration issue');
    assert.equal(before.providers.find(provider => provider.displayName === 'Configured local process')?.canExecute, false, 'the instance STDIO policy still applies during discovery');
    assert.equal(fixture.requests, 0);
    await assert.rejects(() => fs.access(processMarker), { code: 'ENOENT' }, 'discovery never starts configured stdio processes');
    const serialized = JSON.stringify(before);
    assert(!serialized.includes(fixture.url) && !serialized.includes(processMarker) && !serialized.includes('identity.example.test'), 'discovery does not expose raw configuration');

    // A real MCP request records health through the existing manager, not an
    // adapter mock. Subsequent discovery reads that observation without a call.
    await listMcpTools('remote', { scope: adminScope });
    const afterRequestCount = fixture.requests;
    assert(afterRequestCount > 0);
    const healthy = await listMcpIntegrationProviders(context('admin'));
    const remote = healthy.providers.find(provider => provider.displayName === 'Remote account');
    assert(remote && remote.state === 'ready' && remote.health === 'healthy' && remote.checkedAt && remote.statusSource === 'cache');
    assert.equal(fixture.requests, afterRequestCount);
    await recordMcpConnectionObservation(adminConfig.mcpServers.remote, adminScope, { kind: 'success' }, { now: Date.now() - 1000 });
    assert.equal((await listMcpIntegrationProviders(context('admin'))).revision, healthy.revision, 'a new observation timestamp alone does not invalidate pagination');

    await recordMcpConnectionObservation(adminConfig.mcpServers.remote, adminScope, { kind: 'success' }, { now: Date.now() - 6 * 60_000 });
    const stale = await listMcpIntegrationProviders(context('admin'));
    assert.equal(stale.providers.find(provider => provider.displayName === 'Remote account')?.health, 'unknown', 'stale health is not reported as a current probe');
    await recordMcpConnectionObservation(adminConfig.mcpServers.remote, adminScope, { kind: 'failure', code: 'network_error' });
    const unhealthy = await listMcpIntegrationProviders(context('admin'));
    assert.equal(unhealthy.providers.find(provider => provider.displayName === 'Remote account')?.state, 'degraded');

    const oauthConnection = adminConfig.mcpServers.oauth;
    assert(oauthConnection.connectionId);
    const lifecycle = await readMcpOAuthLifecycle(oauthConnection.connectionId, adminScope);
    await writeMcpCredentialJson(`connections/${oauthConnection.connectionId}/tokens.json`, {
      serverName: 'oauth', connectionId: oauthConnection.connectionId, authVersion: oauthConnection.authVersion,
      lifecycleGeneration: lifecycle.generation, serverUrl: fixture.url, issuer: 'https://identity.example.test', resource: fixture.url,
      configHash: hashMcpAuthConfig(oauthConnection), clientId: 'fixture-client', tokenType: 'Bearer',
      accessToken: 'test-only-token-not-for-discovery', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), updatedAt: new Date().toISOString(),
    }, adminScope);
    const authorized = await listMcpIntegrationProviders(context('admin'));
    assert.equal(authorized.providers.find(provider => provider.displayName === 'OAuth account')?.authorized, true, 'OAuth authorization uses the real bound credential store');
    assert(!JSON.stringify(authorized).includes('test-only-token-not-for-discovery'));
    await recordMcpConnectionObservation(oauthConnection, adminScope, { kind: 'failure', code: 'insufficient_scope' });
    const scopeRequired = await listMcpIntegrationProviders(context('admin'));
    assert.equal(scopeRequired.providers.find(provider => provider.displayName === 'OAuth account')?.state, 'auth_required', 'a stored token does not erase an observed missing authorization scope');
    assert.equal(fixture.requests, afterRequestCount, 'status and OAuth reads stay local');

    await patchUnifiedEnvEntries([
      { key: 'CANVA_BEARER_TOKEN', value: 'private-fixture-bearer' },
      { key: 'CANVA_API_KEY', value: 'private-fixture-api-key' },
      { key: 'MCP_ACCOUNT_URL', value: fixture.url },
    ], { userId: 'admin' });
    const staticAuthorized = await listMcpIntegrationProviders(context('admin'));
    for (const name of ['Bearer account', 'API key account']) {
      const provider = staticAuthorized.providers.find(provider => provider.displayName === name);
      assert(provider && provider.requiresAuth && provider.authorized && provider.canExecute && provider.health === 'unknown', 'scoped configured credential presence does not imply healthy provider reachability');
    }
    assert(!JSON.stringify(staticAuthorized).includes('private-fixture'), 'resolved ENV values are never exposed');
    assert.equal((await listMcpIntegrationProviders(context('member'))).providers.some(provider => provider.displayName === 'Bearer account'), false, 'another user cannot discover a private credential binding');

    const remoteHealthPath = resolveScopedMcpPath(adminScope, `connections/${adminConfig.mcpServers.remote.connectionId}/health.json`);
    assert(remoteHealthPath);
    await fs.writeFile(remoteHealthPath, '{"secret":"do-not-leak-health-error"');
    const partialStatus = await listMcpIntegrationProviders(context('admin'));
    assert.equal(partialStatus.complete, false);
    assert(partialStatus.providers.some(provider => provider.displayName === 'API key account' && provider.canExecute), 'one corrupt status does not discard unrelated usable connections');
    assert(partialStatus.providerErrors.some(error => error.code === 'MCP_STATUS_UNAVAILABLE'));
    assert(!JSON.stringify(partialStatus).includes('do-not-leak-health-error'));
    await fs.rm(remoteHealthPath);

    await setMcpServerDefinitionEnabled('org-a', firstDefinition.id, false);
    const afterRevocation = await listMcpIntegrationProviders(context('member'));
    assert(!afterRevocation.providers.some(provider => provider.displayName === 'Canva'), 'current definition revocation hides previously approved connections');

    const definitionPath = path.join(resolveOrganizationMcpTemplatesDir('org-a'), 'approved-servers.json');
    const validDefinitions = await fs.readFile(definitionPath, 'utf8');
    await fs.writeFile(definitionPath, '{"secret":"do-not-leak-definition-error"');
    const partialDefinitions = await listMcpIntegrationProviders(context('admin'));
    assert.equal(partialDefinitions.complete, false);
    assert(partialDefinitions.providers.some(provider => provider.displayName === 'API key account' && provider.canExecute), 'unavailable setup catalogue preserves independent owned connections');
    assert(partialDefinitions.providerErrors.some(error => error.code === 'MCP_SETUP_CATALOG_UNAVAILABLE'));
    assert(!JSON.stringify(partialDefinitions).includes('do-not-leak-definition-error'));
    await fs.writeFile(definitionPath, validDefinitions);

    const legacyScope = { userId: 'legacy', organizationId: 'org-a' };
    memberships.set('legacy', { organizationId: 'org-a', role: 'admin', status: 'active' });
    const legacyPath = resolveMcpConfigPath(legacyScope);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, JSON.stringify({ mcpServers: { old: { url: fixture.url, auth: 'none', displayName: 'Legacy account' } } }));
    const legacyFirst = await listMcpIntegrationProviders(context('legacy'));
    const legacySecond = await listMcpIntegrationProviders(context('legacy'));
    const legacyProvider = legacyFirst.providers.find(provider => provider.displayName === 'Legacy account');
    assert(legacyProvider);
    assert.match(legacyProvider.scope.resourceId, /^[a-f0-9-]{36}$/);
    assert.equal(legacyProvider.providerRef, legacySecond.providers.find(provider => provider.displayName === 'Legacy account')?.providerRef, 'production migration supplies stable scoped legacy identity');
    console.log('integration-tool-mcp-catalog-test: ok');
  } finally {
    await closeAllMcpServers().catch(() => undefined);
    await fixture.close();
    restore();
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

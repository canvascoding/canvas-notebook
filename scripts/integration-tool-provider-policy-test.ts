import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import type { IntegrationExecutionContext, IntegrationOperation, IntegrationPolicy, IntegrationProviderDescriptor,
  IntegrationProviderPage, IntegrationProviderToolRule, IntegrationToolPage, IntegrationToolSchema } from '../app/lib/integration-tools/contracts';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';

const operations: readonly IntegrationOperation[] = ['list_providers', 'search_providers', 'list_tools', 'search_tools', 'describe', 'call'];

async function testProviderPolicy() {
  const policy = await import('../app/lib/integration-tools/policy');
  const unrestricted = policy.UNRESTRICTED_INTEGRATION_POLICY;
  const context: IntegrationExecutionContext = { actorUserId: 'alice', policyRevision: 'pure-policy' };
  const provider = (providerRef: string): IntegrationProviderDescriptor => ({ providerRef, source: 'mcp', displayName: providerRef,
    scope: { type: 'user', resourceId: providerRef, ownerUserId: 'alice' }, state: 'ready', configured: true,
    requiresAuth: false, authorized: true, health: 'healthy', canExecute: true, checkedAt: null,
    statusSource: 'configuration', pluginRefs: [], skillRefs: [], matchReasons: [], nextActions: [] });
  const a = provider('mcp:v1:a'); const b = provider('mcp:v1:b');
  const matrix: IntegrationPolicy = { ...unrestricted, providerToolRules: [
    { source: 'mcp', providerRef: a.providerRef, allowedToolNames: ['create', 'read'], allowedOperations: operations },
    { source: 'mcp', providerRef: b.providerRef, allowedToolNames: ['notify'], allowedOperations: ['list_providers', 'list_tools', 'describe'] },
  ] };
  assert(policy.isIntegrationToolAllowed(context, matrix, a, 'create', 'call'));
  assert(!policy.isIntegrationToolAllowed(context, matrix, a, 'notify', 'call'));
  assert(!policy.isIntegrationToolAllowed(context, matrix, b, 'create', 'describe'));
  assert(!policy.isIntegrationToolAllowed(context, matrix, b, 'notify', 'call'));
  assert(!policy.isIntegrationProviderVisible(context, matrix, provider('mcp:v1:c')));
  assert.deepEqual(policy.integrationPolicyAllowedToolNames(matrix, 'mcp', b.providerRef), ['notify']);
  assert.deepEqual(policy.integrationPolicyAllowedToolNames({ ...matrix, allowedToolNames: ['read', 'notify'] }, 'mcp', a.providerRef), ['read']);
  const narrowed: IntegrationPolicy = { ...unrestricted, providerToolRules: [
    { source: 'mcp', providerRef: b.providerRef, allowedToolNames: null, allowedOperations: ['list_tools'] },
    { source: 'mcp', providerRef: a.providerRef, allowedToolNames: ['read'], allowedOperations: ['call', 'describe'] },
  ] };
  const intersection = policy.intersectIntegrationPolicies(matrix, narrowed, unrestricted);
  assert.deepEqual(intersection.providerToolRules?.map(rule => [rule.providerRef, rule.allowedToolNames, rule.allowedOperations]), [
    [a.providerRef, ['read'], ['describe', 'call']], [b.providerRef, ['notify'], ['list_tools']],
  ]);
  assert.deepEqual(policy.intersectIntegrationPolicies(matrix, { ...unrestricted, providerToolRules: [] }).providerToolRules, []);
  assert.deepEqual(policy.intersectIntegrationPolicies(matrix, { ...unrestricted, providerToolRules: [matrix.providerToolRules![0]] }).providerToolRules?.map(rule => rule.providerRef), [a.providerRef]);
  assert.deepEqual(policy.intersectIntegrationPolicies(unrestricted, { ...unrestricted, providerToolRules: null }), unrestricted,
    'Unrestricted legacy intersections retain the established five-field shape.');
  for (const invalid of [
    [matrix.providerToolRules![0], matrix.providerToolRules![0]],
    [{ ...matrix.providerToolRules![0], source: 'composio' }],
    [{ ...matrix.providerToolRules![0], allowedOperations: ['mcp.call'] }],
    [{ ...matrix.providerToolRules![0], allowedToolNames: undefined }],
    [{ ...matrix.providerToolRules![0], userId: 'forged' }], {},
  ]) {
    const denied = { ...unrestricted, providerToolRules: invalid } as IntegrationPolicy;
    assert(!policy.isIntegrationProviderToolRulesValid(invalid));
    assert(!policy.isIntegrationOperationAllowed(denied, 'mcp', 'list_providers'));
    assert(!policy.isIntegrationProviderVisible(context, denied, a));
    assert(!policy.isIntegrationToolAllowed(context, denied, a, 'create', 'call'));
    assert.deepEqual(policy.intersectIntegrationPolicies(denied, unrestricted).providerToolRules, []);
  }
  for (const ref of [a, b]) for (const tool of ['create', 'read', 'notify']) for (const op of operations) {
    assert(!policy.isIntegrationToolAllowed(context, intersection, ref, tool, op)
      || policy.isIntegrationToolAllowed(context, matrix, ref, tool, op) && policy.isIntegrationToolAllowed(context, narrowed, ref, tool, op));
  }
  const { readPrivateDelegatedIntegrationSnapshot } = await import('../app/lib/integration-tools/delegation-contracts');
  const snapshot = { version: 1, parent: { actorUserId: 'alice', organizationId: null, workspaceId: 'personal-alice',
    sessionId: 'session', agentId: 'agent', agentTurnId: null, policyRevision: 'policy', policy: matrix }, bindings: [
    { providerRef: 'composio:v1:bound', toolName: 'DESIGN_CREATE', bindingRevision: 'binding', tool: {
      name: 'DESIGN_CREATE', description: '', inputSchema: true, toolVersion: '20261006_00' } },
  ] };
  assert.deepEqual(readPrivateDelegatedIntegrationSnapshot(snapshot).parent.policy.providerToolRules, matrix.providerToolRules);
  assert.throws(() => readPrivateDelegatedIntegrationSnapshot({ ...snapshot, parent: { ...snapshot.parent,
    policy: { ...matrix, providerToolRules: [matrix.providerToolRules![0], matrix.providerToolRules![0]] } } }), { code: 'provider_denied' });
}

async function createMcpFixture() {
  let origin = '';
  let requests = 0;
  const calls: string[] = [];
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'provider-policy-fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: ['create_design', 'read_design'].map(name => ({
      name, description: name, inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    })) }));
    server.setRequestHandler('tools/call', async request => {
      calls.push(request.params.name);
      return { content: [{ type: 'text', text: 'Provider policy verified.' }] };
    });
    return server;
  }, { legacy: 'reject' });
  const server = http.createServer(async (request, response) => {
    requests++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = await handler.fetch(new Request(`${origin}${request.url}`, { method: request.method,
      headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}) }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) for await (const chunk of result.body) response.write(Buffer.from(chunk));
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: `${origin}/mcp`, calls, requests: () => requests,
    close: async () => { await handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function main() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-provider-policy-'));
  const database = await createPiTestDatabase();
  const composio = await createComposioProviderFixture();
  const mcp = await createMcpFixture();
  const environment = { DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, COMPOSIO_BASE_URL: composio.baseUrl,
    CANVAS_INSTANCE_ID: 'provider-policy-fixture', CANVAS_ORGANIZATION_ID: 'provider-policy-org', CANVAS_DEPLOYMENT_MODE: 'team',
    CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_MANAGED_SERVICES_ENABLED: 'false', MCP_ALLOW_INSECURE_HTTP: 'true',
    MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_STDIO: 'false', INTEGRATIONS_ENV_MASTER_KEY: randomUUID() + randomUUID(), BASE_URL: 'http://localhost:3000' };
  const oldEnvironment = Object.fromEntries([...Object.keys(environment), 'COMPOSIO_API_KEY'].map(key => [key, process.env[key]]));
  Object.assign(process.env, environment); delete process.env.COMPOSIO_API_KEY;
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (name, parent, isMain) => {
    if (name === 'server-only' || name === '@earendil-works/pi-agent-core' || name === '@earendil-works/pi-ai/oauth') return {};
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false,
    };
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    if (name.includes('license/seat-limit')) return { assertUserSeatAccess: async ({ userId }: { userId: string }) => ({ userId, mode: 'team', organizationId: 'provider-policy-org' }) };
    return originalLoad(name, parent, isMain);
  };
  try {
    await testProviderPolicy();
    const sql = await database.openDb();
    for (const id of ['admin', 'alice']) {
      await sql.run('INSERT INTO "user" (id,name,email,role,email_verified,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,1,1)', [id, `${id}@example.test`]);
    }
    await sql.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('provider-policy-org','admin','team',1,1,1)");
    for (const id of ['admin', 'alice']) {
      await sql.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('provider-policy-org',$1,$2,'active',1,1,1)", [id, id === 'admin' ? 'owner' : 'member']);
      await sql.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,'provider-policy-org','personal',$2,$3,$2,'active',1,1)", [`personal-${id}`, id, `workspaces/personal-${id}/files`]);
    }
    const admin = { userId: 'admin', workspaceId: 'personal-admin', organizationId: 'provider-policy-org' };
    const owner = { type: 'organization' as const, organizationId: 'provider-policy-org' };
    const context: IntegrationExecutionContext = { actorUserId: 'alice', organizationId: owner.organizationId,
      workspaceId: 'personal-alice', policyRevision: 'provider-policy-1' };
    const grant = { targetType: 'user' as const, targetId: 'alice', canUse: true, canManage: false, allowedToolNames: null };
    const { patchUnifiedEnvEntries } = await import('../app/lib/secrets/unified-env-store');
    await patchUnifiedEnvEntries([{ key: 'COMPOSIO_API_KEY', value: 'fixture-organization-key' }], { secretScope: 'organization', organizationId: owner.organizationId });
    const { createSharedComposioProfile } = await import('../app/lib/composio/composio-shared-profiles');
    const profile = await createSharedComposioProfile({ actor: admin, ownership: owner, name: 'Bound accounts', providerMode: 'local' });
    composio.accounts.set(profile.composioUserId, [{ id: 'canva-exact-a', toolkit: 'canva', status: 'ACTIVE' },
      { id: 'canva-exact-b', toolkit: 'canva', status: 'ACTIVE' }, { id: 'other-app-account', toolkit: 'slack', status: 'ACTIVE' }]);
    const store = await import('../app/lib/integration-tools/connections/store');
    const createComposio = (account: string, names: string[]) => store.createSharedIntegrationConnection(admin, { ownership: owner,
      displayName: account, allowedToolNames: names, grants: [grant], backend: { source: 'composio', profileId: profile.id,
        toolkit: 'canva', mode: 'local', accountBinding: 'account', connectedAccountId: account } });
    const ca = await createComposio('canva-exact-a', ['DESIGN_CREATE', 'ASSET_LOOKUP']);
    const cb = await createComposio('canva-exact-b', ['DESIGN_CREATE', 'ASSET_LOOKUP']);
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const createMcp = (name: string) => createSharedMcpConnection(admin, { ownership: owner, displayName: name,
      allowedToolNames: ['create_design', 'read_design'], grants: [grant], config: { url: mcp.url, auth: 'none' }, secrets: [] });
    const ma = await createMcp('MCP Creator'); const mb = await createMcp('MCP Reader');
    const { createSharedIntegrationProviderRef } = await import('../app/lib/integration-tools/connections/provider-authorization');
    const refs = [ma, mb, ca, cb].map(connection => createSharedIntegrationProviderRef(connection.resource));
    const { UNRESTRICTED_INTEGRATION_POLICY: unrestricted } = await import('../app/lib/integration-tools/policy');
    const matrix: IntegrationPolicy = { ...unrestricted, providerToolRules: refs.map((providerRef, i): IntegrationProviderToolRule => ({
      source: i < 2 ? 'mcp' : 'composio', providerRef,
      allowedToolNames: [['create_design'], ['read_design'], ['DESIGN_CREATE'], ['ASSET_LOOKUP']][i], allowedOperations: operations,
    })) };
    const { IntegrationDispatcher } = await import('../app/lib/integration-tools/dispatcher');
    const dispatcher = new IntegrationDispatcher();
    const run = (request: unknown, policy = matrix) => dispatcher.execute({ context, policy, request, toolCallId: 'provider-policy-fixture' });
    const page = await run({ action: 'list', target: 'providers' }) as IntegrationProviderPage;
    assert.deepEqual(page.providers.map(provider => provider.providerRef).sort(), [...refs].sort());
    assert(!JSON.stringify(page).includes('other-app-account'));
    const counts = () => [mcp.requests(), composio.calls.length, mcp.calls.length, composio.calls.filter(call => call.path.includes('/tools/execute/')).length];
    for (const i of [0, 1, 2, 3]) {
      const beforePage = composio.calls.filter(call => call.path === '/api/v3.1/tools').length;
      const list = await run({ action: 'list', target: 'tools', providerRef: refs[i], limit: 1 }) as IntegrationToolPage;
      assert.deepEqual(list.tools.map(tool => tool.name), matrix.providerToolRules![i].allowedToolNames);
      assert.equal(list.nextCursor, null, 'One allowed later tool fills the first page without disclosing other tools.');
      if (i >= 2) {
        const reads = composio.calls.filter(call => call.path === '/api/v3.1/tools').slice(beforePage);
        assert(reads.length > 0 && reads.every(call => call.toolNames === matrix.providerToolRules![i].allowedToolNames!.join(',')),
          'The installed SDK receives only this concrete provider’s tool slugs.');
      }
      const schema = await run({ action: 'describe', toolRef: list.tools[0].toolRef }) as IntegrationToolSchema;
      const args = i === 3 ? { folder_id: 'fixture-folder' } : { title: 'Policy design' };
      await run({ action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef, arguments: args });
      if (i >= 2) {
        const call = composio.calls.filter(call => call.path.includes('/tools/execute/')).at(-1)!;
        assert.equal(call.body.connected_account_id, i === 2 ? 'canva-exact-a' : 'canva-exact-b');
        assert.equal(call.body.version, '20261006_00');
      }
      const foreignList = await run({ action: 'list', target: 'tools', providerRef: refs[i] }, unrestricted) as IntegrationToolPage;
      const opposite = foreignList.tools.find(tool => !matrix.providerToolRules![i].allowedToolNames!.includes(tool.name))!;
      assert(opposite);
      const beforeDenied = counts();
      await assert.rejects(() => run({ action: 'describe', toolRef: opposite.toolRef }), { code: 'tool_denied' });
      await assert.rejects(() => run({ action: 'call', toolRef: opposite.toolRef, schemaRef: schema.schemaRef, arguments: {} }), { code: 'tool_denied' });
      assert.deepEqual(counts(), beforeDenied, 'An issued unrestricted route cannot cross the provider-tool matrix or cause metadata/dispatch.');
      const readOnly: IntegrationPolicy = { ...matrix, providerToolRules: matrix.providerToolRules!.map((rule, index) => index === i
        ? { ...rule, allowedOperations: operations.filter(op => op !== 'call') } : rule) };
      const beforeReadOnly = counts();
      await assert.rejects(() => run({ action: 'call', toolRef: schema.toolRef, schemaRef: schema.schemaRef, arguments: args }, readOnly), { code: 'tool_denied' });
      assert.deepEqual(counts(), beforeReadOnly);
    }
    const beforeClosed = counts();
    for (const policy of [{ ...matrix, providerToolRules: [] },
      { ...matrix, providerToolRules: [matrix.providerToolRules![0], matrix.providerToolRules![0]] }]) {
      const hidden = await run({ action: 'list', target: 'providers' }, policy) as IntegrationProviderPage;
      assert.deepEqual(hidden.providers, []); assert.equal(hidden.complete, true);
      await assert.rejects(() => run({ action: 'list', target: 'tools', providerRef: refs[2] }, policy), { code: 'provider_denied' });
    }
    assert.deepEqual(counts(), beforeClosed, 'Closed or duplicate matrices cause zero SDK reads or business calls.');
    const policyExcluded = { ...matrix, providerToolRules: matrix.providerToolRules!.filter(rule => rule.providerRef !== refs[2]) };
    await assert.rejects(() => run({ action: 'list', target: 'tools', providerRef: refs[2] }, policyExcluded), { code: 'provider_denied' });
    assert.deepEqual(counts(), beforeClosed);
    const current = (await store.getIntegrationConnectionRecord(ca.resource.connectionRef))!;
    await store.mutateSharedIntegrationConnection(admin, ca.resource.connectionRef, { expectedMetadataRevision: current.resource.metadataRevision,
      expectedGrantsRevision: current.resource.grantsRevision, expectedBindingRevision: current.resource.bindingRevision, allowedToolNames: ['ASSET_LOOKUP'] });
    const beforeConnectionDenied = counts();
    await assert.rejects(() => run({ action: 'list', target: 'tools', providerRef: refs[2] }), { code: 'tool_denied' });
    assert.deepEqual(counts(), beforeConnectionDenied, 'Current shared connection restrictions additionally intersect the workflow matrix before SDK lookup.');
    console.log('integration-tool-provider-policy-test: PASS (closed-world matrices, monotone intersections, strict delegation, actual PGlite ACL + MCP/Composio SDK pagination/exact accounts/versions, negative zero-dispatch gates)');
  } finally {
    try { const { closeAllMcpServers } = await import('../app/lib/mcp/manager'); await closeAllMcpServers(); } finally {
      internals._load = originalLoad;
      await mcp.close(); await composio.close(); await database.close(); await rm(dataRoot, { recursive: true, force: true });
      for (const [key, value] of Object.entries(oldEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });

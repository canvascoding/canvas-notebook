import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';

async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  const provider = await createComposioProviderFixture();
  const previousFetch = globalThis.fetch;
  const actualFetch = (await import('undici')).fetch;
  const env = { COMPOSIO_BASE_URL: provider.baseUrl, COMPOSIO_API_KEY: '', CANVAS_CONTROL_PLANE_URL: provider.baseUrl,
    CANVAS_INSTANCE_TOKEN: 'owned-inventory-instance', CANVAS_MANAGED_SERVICES_ENABLED: 'false', COMPOSIO_LOGGING_LEVEL: 'silent' };
  const previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let interceptedUpdate = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.href === 'https://registry.npmjs.org/@composio/core/latest') { interceptedUpdate++; return Response.json({ version: '0.0.0' }); }
    assert.equal(url.origin, provider.baseUrl);
    assert(['/api/v3.1/toolkits', '/v1/managed/composio/toolkits'].includes(url.pathname), 'Only toolkit catalogue HTTP is permitted.');
    assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
    return actualFetch(url.href, { ...init, redirect: 'error' } as Parameters<typeof actualFetch>[1]) as unknown as Promise<Response>;
  };
  try {
    const contextService = await import('../app/lib/agents/extension-options-context');
    const inventory = await import('../app/lib/agents/extension-options-inventory');
    const registry = await import('../app/lib/agents/registry');
    const grants = await import('../app/lib/agents/grants');
    const access = await import('../app/lib/mcp/access');
    const config = await import('../app/lib/mcp/config');
    const configRoute = await import('../app/api/integrations/mcp-config/route');
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const { resolveOrganizationMcpTemplatesDir } = await import('../app/lib/runtime-data-paths');
    const envConfig = await import('../app/lib/integrations/env-config');
    const ownerActor = { ...fixture.owner, source: 'api' as const }, aliceActor = { ...fixture.alice, source: 'api' as const };
    const ownerSource = { ...fixture.owner, organizationId: fixture.organizationId };
    const owner = await contextService.resolveAgentExtensionOptionsContext(ownerActor, { kind: 'prospective', scopeType: 'user' });
    const alice = await contextService.resolveAgentExtensionOptionsContext(aliceActor, { kind: 'prospective', scopeType: 'user' });
    const organization = await contextService.resolveAgentExtensionOptionsContext(ownerActor, { kind: 'prospective', scopeType: 'organization' });
    const setup = async (userId: string, name: string) => {
      const response = await configRoute.PUT(new NextRequest('http://localhost:3001/api/integrations/mcp-config', { method: 'PUT',
        headers: fixture.headers(userId), body: JSON.stringify({ rawContent: JSON.stringify({ mcpServers: {
          [name]: { url: 'https://mcp.inventory.example.test/mcp', transport: 'http', auth: 'none', enabled: true },
        } }) }) }));
      assert.equal(response.status, 200);
      return config.readMcpConfig({ userId });
    };
    const ownerConfig = await setup(fixture.owner.userId, 'Own exact MCP');
    // Arrange historical stored member config through its existing storage
    // service; the public admin-only configuration PUT is deliberately retained.
    await config.writeMcpConfigRaw(JSON.stringify({ mcpServers: { 'Member MCP': {
      url: 'https://mcp.inventory.example.test/mcp', transport: 'http', auth: 'none', enabled: true,
    } } }), { userId: fixture.alice.userId });
    const aliceConfig = await config.readMcpConfig({ userId: fixture.alice.userId });
    const ownerId = ownerConfig.mcpServers['Own exact MCP'].connectionId!;
    const aliceId = aliceConfig.mcpServers['Member MCP'].connectionId!;
    const ownerPath = config.resolveMcpConfigPath({ userId: fixture.owner.userId });
    const alicePath = config.resolveMcpConfigPath({ userId: fixture.alice.userId });
    const definitionId = randomUUID();
    const definitionPath = path.join(resolveOrganizationMcpTemplatesDir(fixture.organizationId), 'approved-servers.json');
    const definition = { version: 1, id: definitionId, organizationId: fixture.organizationId, name: 'Approved exact inventory', enabled: true,
      revision: 1, config: { url: 'https://mcp.inventory.example.test/mcp', transport: 'http', auth: 'none' }, updatedAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(definitionPath), { recursive: true });
    await fs.writeFile(definitionPath, JSON.stringify({ version: 1, definitions: [definition] }));
    const originalOwner = await fs.readFile(ownerPath, 'utf8');
    const originalAlice = await fs.readFile(alicePath, 'utf8');
    const ownerInventory = await inventory.readAgentMcpOptionsInventory(owner);
    const own = ownerInventory.items.find(item => item.id === `mcp-personal:${ownerId}`);
    assert(own?.kind === 'mcp');
    assert.equal(own.connections[0].authorization, 'not_required');
    assert.equal(own.connections[0].health, 'unknown');
    assert.equal(own.connections[0].access.canUse, true);
    assert(own.icon?.url.includes('/api/plugins/mcp-icons/'));
    assert(ownerInventory.items.some(item => item.id === `mcp-definition:${definitionId}`));
    assert(!(await inventory.readAgentMcpOptionsInventory(organization)).items.some(item => item.id === own.id));
    assert(!(await inventory.readAgentMcpOptionsInventory(alice)).items.some(item => item.id === `mcp-personal:${aliceId}`), 'A member cannot select an unapproved manual MCP.');
    assert.equal(await fs.readFile(ownerPath, 'utf8'), originalOwner);
    assert.equal(await fs.readFile(alicePath, 'utf8'), originalAlice);
    const privateExact = await inventory.readAgentOwnMcpOptionMetadata(owner, own.id);
    assert.equal(privateExact?.connection.connectionId, ownerId);
    assert.equal(await inventory.readAgentOwnMcpOptionMetadata(organization, own.id), null);

    // The same actual post-read policy is used by the unchanged runtime entry
    // and the new metadata reader, including current approved-definition changes.
    aliceConfig.mcpServers['Member MCP'].organizationId = fixture.organizationId;
    aliceConfig.mcpServers['Member MCP'].serverDefinitionId = definitionId;
    await fs.writeFile(alicePath, JSON.stringify(aliceConfig));
    const approvedAlice = await inventory.readAgentMcpOptionsInventory(alice);
    assert(approvedAlice.items.some(item => item.id === `mcp-personal:${aliceId}`));
    assert.equal((await access.assertMcpConnectionAccess(aliceId, { userId: fixture.alice.userId })).connection.connectionId, aliceId);
    await fs.writeFile(definitionPath, JSON.stringify({ version: 1, definitions: [{ ...definition, enabled: false }] }));
    assert(!(await inventory.readAgentMcpOptionsInventory(alice)).items.some(item => item.id === `mcp-personal:${aliceId}`));
    await assert.rejects(() => access.assertMcpConnectionAccess(aliceId, { userId: fixture.alice.userId }), /approval was removed or changed/u);
    await fs.writeFile(definitionPath, JSON.stringify({ version: 1, definitions: [definition] }));

    const target = await registry.createAgentProfile({ agentId: `inventory-agent-${randomUUID()}`, name: 'Actual target-only chooser',
      scopeType: 'organization', organizationId: fixture.organizationId, createdByUserId: fixture.owner.userId, accessPolicy: 'restricted' });
    await grants.upsertAgentGrant({ agentId: target.agentId, organizationId: fixture.organizationId, targetType: 'user', targetId: fixture.alice.userId,
      actorUserId: fixture.owner.userId, canUse: false, canEdit: true, canManage: false });
    const targetOnly = await createSharedMcpConnection(ownerSource, { ownership: { type: 'organization', organizationId: fixture.organizationId },
      displayName: 'Target-only shared MCP', accessMode: 'restricted', allowedToolNames: ['READ'],
      grants: [{ targetType: 'agent', targetId: target.agentId, canUse: true, canManage: false, allowedToolNames: ['READ'] }],
      config: { url: 'https://shared.inventory.example.test/mcp', transport: 'http', auth: 'none', enabled: true } });
    const existing = await contextService.resolveAgentExtensionOptionsContext(aliceActor, { kind: 'existing', agentId: target.agentId,
      expectedRevision: target.revision, expectedWorkflowRevision: 0 });
    assert(!(await inventory.readAgentMcpOptionsInventory(alice)).items.some(item => item.id === targetOnly.resource.connectionRef));
    const existingInventory = await inventory.readAgentMcpOptionsInventory(existing);
    const selected = existingInventory.items.find(item => item.id === targetOnly.resource.connectionRef);
    assert(selected?.kind === 'mcp');
    assert.equal(selected.connections[0].access.canUse, true);
    assert.equal(selected.connections[0].access.canManage, false);
    assert.equal(selected.icon, undefined, 'A target-only grant never fabricates image endpoint ActorRead.');
    const targetBackend = targetOnly.backend;
    assert(targetBackend.source === 'mcp');
    const sharedPath = path.join((await import('../app/lib/runtime-data-paths')).resolveOrganizationDataRoot(fixture.organizationId),
      'mcp', 'shared', targetBackend.connectionId, 'config.json');
    const originalShared = await fs.readFile(sharedPath, 'utf8');
    const sharedMetadata = await inventory.readAgentSharedMcpOptionMetadata(existing, targetOnly.resource.connectionRef);
    assert.equal(sharedMetadata?.connection.connectionId, targetBackend.connectionId);
    assert.equal(sharedMetadata?.authorization.canManage, false, 'Metadata does not promote Use to Manage.');
    assert.equal(await fs.readFile(sharedPath, 'utf8'), originalShared, 'The private shared reader does not repair or migrate configuration.');
    await assert.rejects(() => inventory.readAgentSharedMcpOptionMetadata(alice, targetOnly.resource.connectionRef), error => (error as { status?: number }).status === 403);
    assert.doesNotMatch(JSON.stringify(existingInventory), /backend_connection_id|mcp\.inventory|shared\.inventory|headers|bearerTokenEnv|composioUserId/u);
    let lists = 0;
    fixture.setBeforeRead(async query => {
      if (/SELECT connection_ref FROM integration_connection_resources/u.test(query) && ++lists === 2) {
        await fixture.sql.run('UPDATE integration_connection_grants SET can_use=0 WHERE connection_ref=$1', [targetOnly.resource.connectionRef]);
      }
    });
    assert(!(await inventory.readAgentMcpOptionsInventory(existing)).items.some(item => item.id === targetOnly.resource.connectionRef), 'Late source grant revocation removes an earlier authorized candidate.');
    fixture.setBeforeRead(undefined);
    await assert.rejects(() => inventory.readAgentSharedMcpOptionMetadata(existing, targetOnly.resource.connectionRef), error => [403, 404].includes((error as { status: number }).status));
    await assert.rejects(() => inventory.readAgentMcpOptionsInventory({ ...owner }), /genuine|issued/u);

    const workflows = await import('../app/lib/agents/workflow-configuration');
    await workflows.updateManagedAgentConfiguration({ actor: aliceActor, agentId: target.agentId,
      expectedRevision: target.revision, expectedWorkflowRevision: 0, extensions: {
        version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null,
        standalone: [{ mode: 'selectable', configurationId: 'own-user-option', source: 'mcp', requirement: 'optional', allowedChoices: [],
          personalPolicy: { source: 'mcp', serverDefinitionIds: [definitionId], toolCap: [] } }],
      } });
    await grants.upsertAgentGrant({ agentId: target.agentId, organizationId: fixture.organizationId, targetType: 'user', targetId: fixture.alice.userId,
      actorUserId: fixture.owner.userId, canUse: true, canEdit: false, canManage: false });
    const choiceSnapshot = await workflows.readManagedAgentWorkflow(aliceActor, target.agentId);
    const choiceContext = await contextService.resolveAgentExtensionOptionsContext(aliceActor, { kind: 'user_choice', agentId: target.agentId,
      capabilityKey: choiceSnapshot.bindings[0].resourceId, expectedWorkflowRevision: choiceSnapshot.workflowRevision,
      expectedPreferenceRevision: choiceSnapshot.preferenceRevision });
    let globalSharedQueries = 0;
    fixture.setBeforeRead(async query => { if (/SELECT connection_ref FROM integration_connection_resources/u.test(query)) globalSharedQueries++; });
    const ownChoiceInventory = await inventory.readAgentOwnMcpOptionsInventory(choiceContext);
    assert(ownChoiceInventory.items.some(item => item.id === `mcp-personal:${aliceId}`));
    assert(!ownChoiceInventory.items.some(item => item.id.startsWith('canvas-connection:')));
    assert.equal(globalSharedQueries, 0, 'Own per-user slot metadata never enumerates shared candidates.');
    assert.equal((await inventory.readAgentOwnMcpOptionMetadata(choiceContext, `mcp-personal:${aliceId}`))?.connection.serverDefinitionId, definitionId);
    await assert.rejects(() => inventory.readAgentMcpOptionsInventory(choiceContext), /exact permitted slot/u);
    fixture.setBeforeRead(undefined);

    await envConfig.replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'owned-inventory-project-key' }], { secretScope: 'system' });
    const beforeProfiles = await fixture.sql.all('SELECT id FROM composio_connection_profiles');
    const first = await inventory.readAgentComposioOptionsCatalogue(owner, new AbortController().signal, { search: '' });
    assert(first.items.some(item => item.id === 'composio:canva'));
    assert(first.continuation);
    const second = await inventory.readAgentComposioOptionsCatalogue(owner, new AbortController().signal, { search: '', continuation: first.continuation });
    assert(second.items.some(item => item.id === 'composio:github'));
    assert.equal(second.coverage.status, 'complete');
    const exact = await inventory.readAgentComposioOptionsCatalogue(owner, new AbortController().signal, { selectedSlug: 'github' });
    assert(exact.items.some(item => item.id === 'composio:github'));
    assert.deepEqual(await fixture.sql.all('SELECT id FROM composio_connection_profiles'), beforeProfiles);
    await assert.rejects(() => inventory.readAgentComposioOptionsCatalogue(owner, new AbortController().signal,
      { continuation: first.continuation, search: 'changed' }), /catalogue context changed/u);
    await envConfig.replaceScopedEnvEntries('integrations', [], { secretScope: 'system' });
    process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
    const beforeManaged = provider.calls.length;
    const managedNoProfiles = await inventory.readAgentComposioOptionsCatalogue(owner, new AbortController().signal);
    assert.equal(managedNoProfiles.coverage.status, 'not_configured');
    assert.equal(managedNoProfiles.coverage.error?.code, 'COMPOSIO_PROFILE_REQUIRED');
    assert.equal(provider.calls.length, beforeManaged, 'Managed zero profiles does not invent a context or entity.');
    assert.deepEqual(await fixture.sql.all('SELECT id FROM composio_connection_profiles'), beforeProfiles);

    // Cold MCP storage, malformed identities and symlinks do not cause repair,
    // identity generation, credential changes or source metadata disclosure.
    const coldActor = { ...fixture.actor('bob'), source: 'api' as const };
    const cold = await contextService.resolveAgentExtensionOptionsContext(coldActor, { kind: 'prospective', scopeType: 'user' });
    const coldPath = config.resolveMcpConfigPath({ userId: coldActor.userId });
    await inventory.readAgentMcpOptionsInventory(cold);
    await assert.rejects(() => fs.access(coldPath), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    const duplicate = structuredClone(ownerConfig);
    duplicate.mcpServers['Duplicate exact ID'] = structuredClone(duplicate.mcpServers['Own exact MCP']);
    await fs.writeFile(ownerPath, JSON.stringify(duplicate));
    const duplicated = await inventory.readAgentMcpOptionsInventory(owner);
    assert(!duplicated.items.some(item => item.id === own.id));
    assert.equal(duplicated.coverage.status, 'partial');
    await fs.rm(ownerPath);
    await fs.symlink(alicePath, ownerPath);
    const symlinked = await inventory.readAgentMcpOptionsInventory(owner);
    assert(!symlinked.items.some(item => item.id.startsWith('mcp-personal:')));
    assert.equal(symlinked.coverage.status, 'partial', 'Safe approved offerings survive an unreadable personal file.');
    assert.equal(fixture.providerRequests(), 0);
    assert(provider.calls.every(call => ['/api/v3.1/toolkits', '/v1/managed/composio/toolkits'].includes(call.path)));
    console.log(`PASS actual agent options inventory: real actor/target/source SQL, unchanged personal MCP policy, target-only grant/revoke, private metadata and icons, cold/duplicate/symlink no-repair, catalogue cursor+zero-profile safety; account/status/tools/business0, intercepted SDK update ${interceptedUpdate}.`);
  } finally {
    fixture.setBeforeRead(undefined);
    globalThis.fetch = previousFetch;
    await provider.close();
    await fixture.close();
    for (const [key, value] of Object.entries(previousEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

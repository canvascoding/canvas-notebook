import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import Module from 'node:module';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

/** Actual scoped Mobile route + Agent/SQL authority; only the external SDK metadata transport is controlled. */
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown;
    _resolveFilename: (name: string, parent: NodeModule | null) => string };
  const previous = loader._load, accountId = 'exact-own-account-two-with-private-long-id';
  let metadataReads = 0, prohibitMetadata = false;
  const accounts = new Map<string, string[]>();
  const sdk = {
    isComposioConfigured: async () => true,
    getComposioMode: async () => 'local', getComposioModeForContext: async () => 'local',
    getLocalComposioApiKey: async () => 'owned-test-key', getLocalComposioApiKeyForContext: async () => 'owned-test-key',
    getComposio: async () => ({ getConfig: () => ({ apiKey: 'owned-test-key' }),
      getClient: () => ({ toolkits: { list: async () => { assert(!prohibitMetadata, 'Presentation must never probe the provider.'); metadataReads++;
        return { items: [{ slug: 'canva', name: 'Canva', noAuth: false }, { slug: 'duckduckgo', name: 'DuckDuckGo', noAuth: true }], next_cursor: null }; } } }),
      connectedAccounts: { list: async (query: { userIds: string[] }) => { assert(!prohibitMetadata, 'Presentation must never enumerate accounts.'); metadataReads++;
        return { items: (accounts.get(query.userIds[0]) ?? []).map(id => ({ id, toolkit: { slug: 'canva', name: 'Canva' }, status: 'ACTIVE' })), nextCursor: null }; } },
    }),
  };
  loader._load = (name, parent, isMain) => {
    let resolved = name; try { resolved = loader._resolveFilename(name, parent); } catch { /* Alias checked below. */ }
    return name === '@/app/lib/composio/composio-client' || resolved === path.join(process.cwd(), 'app/lib/composio/composio-client.ts') ? sdk : previous(name, parent, isMain);
  };
  try {
    const profiles = await import('../app/lib/composio/composio-profiles');
    const management = await import('../app/lib/agents/management-actions');
    const workflows = await import('../app/lib/agents/workflow-configuration');
    const bindings = await import('../app/lib/integration-tools/workflow-personal-bindings');
    const refs = await import('../app/lib/integration-tools/references');
    const sealed = await import('../app/lib/composio/composio-shared-account-reference');
    const choices = await import('../app/lib/agents/extension-choice');
    const route = await import('../app/api/mobile/v1/agents/[agentId]/workflow/route');
    const mcpRoute = await import('../app/api/integrations/mcp-config/route');
    const mcpConfig = await import('../app/lib/mcp/config');
    const owner = { ...fixture.owner, source: 'api' as const };
    await profiles.ensureDefaultComposioProfile(owner.userId);
    const profile = await profiles.createComposioProfile({ ownerUserId: owner.userId, name: 'Own design profile' });
    accounts.set(profile.composioUserId, ['exact-own-account-one', accountId]);
    const agent = await management.createManagedAgent(owner, { name: `Own metadata ${randomUUID()}`, scopeType: 'organization', enabledTools: ['read', 'mcp'],
      extensions: { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null,
        standalone: [{ mode: 'selectable', configurationId: 'own-canva', requirement: 'optional', source: 'composio', toolkit: 'canva', allowedChoices: [],
          personalPolicy: { source: 'composio', toolkit: 'canva', toolCap: null } }] },
      grants: [{ targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false }] });
    const initial = await workflows.inspectManagedAgentWorkflow(owner, agent.agent.agentId);
    const slot = initial.standalone![0], providerRef = refs.createIntegrationProviderRef({ source: 'composio', profileId: profile.id, toolkit: 'canva',
      scope: { type: 'user', ownerUserId: owner.userId, resourceId: `profile:${profile.id}:canva` } });
    const offered = await bindings.listPersonalWorkflowProviderAccountChoices({ actor: owner, providerRef, exactToolkit: { profileId: profile.id, toolkit: 'canva' } });
    const offeredAccount = offered.accounts.find(row => sealed.readPersonalComposioAccountReference(row.accountSelectionRef).accountId === accountId)!; assert(offeredAccount);
    await choices.setManagedAgentStandaloneChoice({ actor: owner, agentId: agent.agent.agentId, capabilityKey: slot.capabilityKey,
      expectedWorkflowRevision: initial.workflowRevision, expectedPreferenceRevision: 0,
      standaloneSelection: { selection: { kind: 'composio', source: 'composio', toolkit: 'canva', target: { kind: 'personal', profileId: profile.id,
        accountBinding: 'account', accountId, connectionRef: `composio-personal:${profile.id}:${accountId}` } },
      accountSelectionRef: offeredAccount.accountSelectionRef, requirement: 'optional', toolCap: null } });
    const ownState = await workflows.readManagedAgentWorkflow(owner, agent.agent.agentId);
    const storedTarget = ownState.choices[slot.capabilityKey].personalTarget!;
    assert(storedTarget.kind === 'personal');
    const issued = await bindings.verifyStoredPersonalWorkflowProviderTarget({ actor: owner, target: {
      binding: storedTarget.personalBinding!, boundProviderRef: storedTarget.boundProviderRef!, baseProviderRef: storedTarget.providerRef,
      bindingFingerprint: storedTarget.bindingFingerprint! } }, { checkProviderReadiness: false });
    assert(bindings.readPreparedPersonalWorkflowConnectionLabel(issued).includes('Own design profile'));
    await assert.rejects(bindings.verifyStoredPersonalWorkflowProviderTarget({ actor: { ...fixture.alice, source: 'api' }, target: {
      binding: storedTarget.personalBinding!, boundProviderRef: storedTarget.boundProviderRef!, baseProviderRef: storedTarget.providerRef,
      bindingFingerprint: storedTarget.bindingFingerprint! } }, { checkProviderReadiness: false }), { code: 'provider_denied' });
    const readsBefore = metadataReads; prohibitMetadata = true;
    const read = async (userId: string) => {
      const response = await route.GET(new NextRequest(`http://localhost:3001/api/mobile/v1/agents/${agent.agent.agentId}/workflow`, { headers: fixture.headers(userId) }),
        { params: Promise.resolve({ agentId: agent.agent.agentId }) }); assert.equal(response.status, 200);
      return (await response.json()).data.workflow as Awaited<ReturnType<typeof workflows.inspectManagedAgentWorkflow>>;
    };
    const expected = `canva · Own design profile · Account ${createHash('sha256').update(accountId).digest('hex').slice(0, 10)}`;
    const own = await read('owner'); assert.equal(own.standalone![0].selectedConnection?.label, expected);
    assert.equal(own.standalone![0].selectedConnection?.status, 'unknown'); assert.equal(own.standalone![0].selectedConnection?.availability, 'available');
    assert(!own.standalone![0].selectedConnection!.label.includes(accountId), 'Full account ID is not promoted into the primary presentation label.');
    const other = await read('alice'); assert(!JSON.stringify(other).includes('Own design profile')); assert(!JSON.stringify(other).includes(expected)); assert(!JSON.stringify(other).includes(accountId));
    assert.equal(other.standalone![0].selectionOrigin, 'missing');
    await fixture.sql.run('UPDATE composio_connection_profiles SET name=$1 WHERE id=$2', ['Renamed\u202E\n profile', profile.id]);
    const renamed = await read('owner'); assert.equal(renamed.standalone![0].selectedConnection?.label,
      `canva · Renamed profile · Account ${createHash('sha256').update(accountId).digest('hex').slice(0, 10)}`);
    assert.equal(metadataReads, readsBefore); assert(metadataReads > 0);
    await profiles.archiveComposioProfile({ ownerUserId: owner.userId, profileId: profile.id });
    const archived = await read('owner'); assert.equal(archived.standalone![0].selectedConnection?.availability, 'unavailable');
    assert(!JSON.stringify(archived).includes('Renamed profile')); assert.equal(metadataReads, readsBefore);
    assert.throws(() => bindings.readPreparedPersonalWorkflowConnectionLabel({ kind: 'prepared_personal_workflow_provider_target', source: 'composio', boundProviderRef: 'forged' }),
      { code: 'provider_denied' });
    const configured = await mcpRoute.PUT(new NextRequest('http://localhost:3001/api/integrations/mcp-config', { method: 'PUT', headers: fixture.headers('owner'),
      body: JSON.stringify({ rawContent: JSON.stringify({ mcpServers: { 'Exact owned MCP': { url: 'https://owned.invalid/mcp', transport: 'http', auth: 'none', enabled: true } } }) }) }));
    assert.equal(configured.status, 200); const connection = (await mcpConfig.readMcpConfig({ userId: owner.userId })).mcpServers['Exact owned MCP']; assert(connection.connectionId);
    const mcp = await management.createManagedAgent(owner, { name: `MCP metadata ${randomUUID()}`, scopeType: 'user', enabledTools: ['read', 'mcp'],
      extensions: { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [{ mode: 'fixed',
        entry: { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${connection.connectionId}` } }, requirement: 'optional', toolCap: null } }] } });
    const mcpRead = await workflows.inspectManagedAgentWorkflow(owner, mcp.agent.agentId);
    assert.equal(mcpRead.standalone![0].selectedConnection?.label, 'Exact owned MCP');
    assert.equal(mcpRead.standalone![0].selectedConnection?.status, 'unknown'); assert.equal(fixture.providerRequests(), 0); assert.equal(metadataReads, readsBefore);
    console.log('PASS actual Agent/SQL + Mobile workflow route: own profile and stable exact-account hint, no full-ID primary label or foreign metadata, rename/sanitize/archive, forged-proof rejection, actual MCP name, presentation provider probes 0.');
  } finally { loader._load = previous; await fixture.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

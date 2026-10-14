import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';

// Real PGlite actor/target/source ACLs, writers and saved bindings, pure FS MCP
// metadata and SDK toolkit HTTP to one owned server. No source/authority mocks.
// Accounts may be read while arranging initial exact account admission, never
// during display inspection. No provider status/tools/business traffic.
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  const provider = await createComposioProviderFixture();
  const previousFetch = globalThis.fetch, actualFetch = (await import('undici')).fetch;
  const previousUrl = process.env.COMPOSIO_BASE_URL;
  process.env.COMPOSIO_BASE_URL = provider.baseUrl;
  let displayOnly = false, toolkitReads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.href === 'https://registry.npmjs.org/@composio/core/latest') return Response.json({ version: '0.0.0' });
    assert.equal(url.origin, provider.baseUrl);
    assert.equal(init?.method ?? 'GET', 'GET');
    assert(/^\/api\/v3\.1\/(?:toolkits|connected_accounts)(?:\/[^/]+)?$/u.test(url.pathname));
    if (displayOnly) assert(url.pathname.startsWith('/api/v3.1/toolkits'), `Display must not probe ${url.pathname}`);
    const response = await actualFetch(url.href, { ...init, redirect: 'error' } as Parameters<typeof actualFetch>[1]);
    if (url.pathname === '/api/v3.1/toolkits') {
      toolkitReads++;
      const body = await response.json() as { items: Array<{ slug: string; meta: Record<string, unknown> }> };
      for (const row of body.items) row.meta.logo = `https://icons.fixture.invalid/${row.slug}.svg?private=strip`;
      return Response.json(body);
    }
    return response as unknown as Response;
  };
  try {
    const { owner, alice, organizationId } = fixture;
    const actor = { ...owner, source: 'api' as const };
    const config = await import('../app/lib/mcp/config');
    await config.writeMcpConfigRaw(JSON.stringify({ mcpServers: { 'Saved Knowledge MCP': {
      url: 'https://saved.metadata.invalid/mcp', transport: 'http', auth: 'none', enabled: true,
    } } }), { userId: owner.userId });
    const stored = await config.readMcpConfig({ userId: owner.userId });
    const ownRef = `mcp-personal:${stored.mcpServers['Saved Knowledge MCP'].connectionId!}`;
    const originalConfig = await fs.readFile(config.resolveMcpConfigPath({ userId: owner.userId }), 'utf8');
    await (await import('../app/lib/integrations/env-config')).replaceScopedEnvEntries('integrations',
      [{ key: 'COMPOSIO_API_KEY', value: 'owned-display-only-key' }], { secretScope: 'user', userId: owner.userId });
    const composio = await (await import('../app/lib/composio/composio-context')).resolveComposioContext({ userId: owner.userId, workspaceId: owner.workspaceId });
    const profiles = await import('../app/lib/composio/composio-profiles');
    await profiles.renameComposioProfile({ ownerUserId: owner.userId, profileId: composio.profileId, name: 'Saved Design Profile' });
    provider.accounts.set(composio.composioUserId, [{ id: 'actual-account-b', toolkit: 'canva', status: 'ACTIVE' }]);
    const providerRef = (await import('../app/lib/integration-tools/references')).createIntegrationProviderRef({ source: 'composio', profileId: composio.profileId,
      toolkit: 'canva', scope: { type: 'user', ownerUserId: owner.userId, resourceId: `profile:${composio.profileId}:canva` } });
    const choices = await (await import('../app/lib/integration-tools/workflow-personal-bindings')).listPersonalWorkflowProviderAccountChoices({
      actor, providerRef, exactToolkit: { profileId: composio.profileId, toolkit: 'canva' } });
    assert.equal(choices.accounts.length, 1);
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const shared = await createSharedMcpConnection({ ...owner, organizationId }, {
      ownership: { type: 'organization', organizationId }, displayName: 'Saved Organization MCP', accessMode: 'restricted', allowedToolNames: [],
      grants: [{ targetType: 'user', targetId: owner.userId, canUse: true, canManage: false, allowedToolNames: [] }],
      config: { url: 'https://saved.shared.invalid/mcp', transport: 'http', auth: 'none', enabled: true },
    });
    const management = await import('../app/lib/agents/management-actions');
    const created = await management.createManagedAgent(actor, { agentId: `saved-display-${randomUUID()}`, name: 'Saved metadata fixture',
      enabledTools: ['read', 'mcp', 'composio_execute'], extensions: { version: 1, origin: 'agent_configuration', mode: 'fixed',
        selections: [], workflow: null, standalone: [
          { mode: 'fixed', entry: { requirement: 'optional', toolCap: [],
            selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: ownRef } } } },
          { mode: 'selectable', configurationId: 'shared-mcp', source: 'mcp', requirement: 'optional', defaultChoiceId: 'shared-choice',
            allowedChoices: [{ choiceId: 'shared-choice', toolCap: [], selection: { kind: 'mcp', source: 'mcp', target: { kind: 'shared',
              connectionRef: shared.resource.connectionRef, bindingRevision: shared.resource.bindingRevision } } }] },
          { mode: 'fixed', entry: { requirement: 'optional', toolCap: [], accountSelectionRef: choices.accounts[0].accountSelectionRef,
            selection: { kind: 'composio', source: 'composio', toolkit: 'canva', target: { kind: 'personal', profileId: composio.profileId,
              accountBinding: 'account', accountId: 'actual-account-b', connectionRef: `composio-personal:${composio.profileId}:actual-account-b` } } } },
        ] } });
    const beforeDisplayCalls = provider.calls.length;
    const profileCount = (await profiles.listExistingComposioProfiles(owner.userId)).length;
    displayOnly = true;
    const { inspectManagedAgentExtensions } = await import('../app/lib/agents/extension-inspection');
    const inspection = await inspectManagedAgentExtensions(actor, created.agent.agentId);
    assert.equal(inspection.configurationState, 'available');
    const summaries = inspection.standaloneSummaries!;
    const own = summaries.find(row => row.selection.kind === 'mcp' && row.selection.target.kind === 'personal');
    assert.equal(own?.label, 'Saved Knowledge MCP');
    assert(own?.icon?.url.startsWith('/api/plugins/mcp-icons/'));
    assert.equal(own.scopeLabel, 'personal');
    const sharedRow = summaries.find(row => row.configurationId === 'shared-mcp');
    assert.equal(sharedRow?.choiceId, 'shared-choice');
    assert.equal(sharedRow?.label, 'Saved Organization MCP');
    assert(sharedRow?.icon?.url.includes('binding='));
    const canva = summaries.find(row => row.selection.kind === 'composio');
    assert.equal(canva?.label, 'Canva');
    assert.equal(canva?.profileLabel, 'Saved Design Profile');
    assert.equal(canva?.icon?.url, 'https://icons.fixture.invalid/canva.svg');
    assert(!('accountLabel' in canva!));
    assert(toolkitReads > 0);
    assert(provider.calls.slice(beforeDisplayCalls).every(call => call.path.startsWith('/api/v3.1/toolkits')));
    assert.equal((await profiles.listExistingComposioProfiles(owner.userId)).length, profileCount);
    assert.equal(await fs.readFile(config.resolveMcpConfigPath({ userId: owner.userId }), 'utf8'), originalConfig);
    assert.doesNotMatch(JSON.stringify(summaries), /saved\.metadata|saved\.shared|owned-display-only-key|composioUserId|accountSelectionRef|retainedBindingRef|backend|oauth|headers/u);
    await assert.rejects(() => inspectManagedAgentExtensions({ ...alice, source: 'api' }, created.agent.agentId));
    const contextService = await import('../app/lib/agents/extension-options-context');
    const context = await contextService.resolveAgentExtensionOptionsContext(actor, { kind: 'existing', agentId: created.agent.agentId,
      expectedRevision: created.agent.revision, expectedWorkflowRevision: inspection.workflowRevision });
    const { readAgentExtensionStandalonePresentation } = await import('../app/lib/agents/extension-standalone-presentation');
    await assert.rejects(() => readAgentExtensionStandalonePresentation({ ...context }), /genuine|issued/u);
    await fixture.sql.run('UPDATE integration_connection_grants SET can_use=0 WHERE connection_ref=$1', [shared.resource.connectionRef]);
    const revoked = await inspectManagedAgentExtensions(actor, created.agent.agentId);
    assert.equal(revoked.configurationState, 'blocked');
    assert.equal(revoked.standaloneSummaries, undefined, 'Revoked sources never keep old display metadata.');
    console.log('PASS standalone presentation: actual saved MCP/Composio labels, exact icons/profile, no account/status probes, SQL ACL/clone/revoke and unchanged config');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.COMPOSIO_BASE_URL; else process.env.COMPOSIO_BASE_URL = previousUrl;
    await provider.close(); await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

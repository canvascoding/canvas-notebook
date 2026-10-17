import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { IntegrationExecutionContext, IntegrationProviderDescriptor, IntegrationToolSchema } from '../app/lib/integration-tools/contracts';
import type { IntegrationToolAdapter } from '../app/lib/integration-tools/runtime-contracts';
import { createPiTestDatabase } from './helpers/pi-test-database';

// Actual PGlite actor/session/workspace/source/ACL/intake/WeakMap authority.
// External licensing, model metadata and provider IO are controlled boundaries;
// this fixture makes no network calls and proves no production seat entitlement.
async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-extension-integration-'));
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_ORGANIZATION_ID: 'extension-integration-org',
    CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_MCP_DIRECT_ENABLED: 'false',
    BETTER_AUTH_BASE_URL: 'http://localhost:3000' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const database = await createPiTestDatabase();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return { getModels: () => [], getProviders: () => [],
      registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false };
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    if (name.includes('license/seat-limit')) return { assertUserSeatAccess: async ({ userId }: { userId: string }) => {
      assert.ok(['owner', 'alice'].includes(userId), 'Only fixture actors cross the external licensing boundary.');
      return { userId, mode: 'team', organizationId: environment.CANVAS_ORGANIZATION_ID };
    } };
    if (name === '@/app/lib/agents/workspace-brand-context') return { getWorkspaceBrandPromptBlock: async () => null };
    return original(name, parent, isMain);
  };
  try {
    const sql = await database.openDb();
    for (const id of ['owner', 'alice']) await sql.run(
      'INSERT INTO "user" (id,name,email,role,email_verified,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,1,1)', [id, `${id}@example.test`]);
    await sql.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('extension-integration-org','owner','team',1,1,1)");
    await sql.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,created_at,updated_at) VALUES ('extension-integration-org','owner','owner','active',1,1)");
    await sql.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,created_at,updated_at) VALUES ('extension-integration-org','alice','member','active',1,1)");
    await sql.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('team-a','extension-integration-org','team','workspaces/team-a/files','Team A','active',1,1)");
    await sql.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ('extension-integration-org','team-a','alice','member','active',1,1,0,1,1)");
    await sql.run("UPDATE agents SET access_policy='restricted',scope_type='organization',organization_id='extension-integration-org',owner_user_id='owner',enabled_tools_json='[]',revision=1 WHERE agent_id='bradley'");
    await sql.run("INSERT INTO agent_grants (id,agent_id,organization_id,target_type,target_id,can_use,can_edit,can_manage,created_at,updated_at) VALUES ('general-grant','bradley','extension-integration-org','workspace','team-a',1,0,0,1,1)");
    const { piSessions } = await import('../app/lib/db/schema');
    await database.db.insert(piSessions).values({ sessionId: 'actual-session', userId: 'alice', agentId: 'bradley',
      workspaceId: 'team-a', workspaceType: 'team', organizationId: 'extension-integration-org', provider: 'fixture', model: 'fixture',
      createdAt: new Date(), updatedAt: new Date() });
    const contexts = await import('../app/lib/integration-tools/context');
    const { resolveEffectiveExtensionContext, readEffectiveExtensionContext, isIssuedScopedIntegrationTurn } = await import('../app/lib/capabilities/extensions/effective-context');
    const { getAuthorizedAgentWorkflowPackageSelections } = await import('../app/lib/capabilities/packages/runtime-bindings');
    const { prepareAcceptedTurnExtensionSelection, readAcceptedTurnExtensionSelection } = await import('../app/lib/capabilities/extensions/accepted-turn-selection');
    const { reissueAcceptedTurnRuntimeSelection } = await import('../app/lib/capabilities/extensions/turn-runtime');
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const { createSharedIntegrationProviderRef, transferIntegrationProviderAuthorization } = await import('../app/lib/integration-tools/connections/provider-authorization');
    const { mutateSharedIntegrationConnection, authorizeIntegrationConnection } = await import('../app/lib/integration-tools/connections/store');
    const { createSharedIntegrationPolicyDescriptor } = await import('../app/lib/integration-tools/connections/provider-policy');
    const { integrationConnectionActorFromContext } = await import('../app/lib/integration-tools/connections/contracts');
    const { IntegrationDispatcher } = await import('../app/lib/integration-tools/dispatcher');
    const { createIntegrationGatewayTool } = await import('../app/lib/pi/integration-tool-gateway');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const owner = { userId: 'owner', organizationId: 'extension-integration-org' };
    const grant = { targetType: 'user' as const, targetId: 'alice', canUse: true, canManage: false, allowedToolNames: ['read_fixture'] };
    const shared = await createSharedMcpConnection(owner, { ownership: { type: 'organization', organizationId: owner.organizationId },
      displayName: 'Exact selected source', accessMode: 'restricted', grants: [grant], allowedToolNames: ['read_fixture', 'other_fixture'],
      config: { url: 'https://fixture.invalid/mcp', transport: 'http', auth: 'none', enabled: true } });
    const base = (await contexts.resolveIntegrationExecutionContext({ actorUserId: 'alice', sessionId: 'actual-session', policyRevision: 'fixture' })).executionContext;
    const intake = { ...base, agentTurnId: 'intake-turn' };
    const accepted = await prepareAcceptedTurnExtensionSelection(intake, { version: 1, origin: 'turn_reference', selections: [{
      selection: { kind: 'mcp', source: 'mcp', target: { kind: 'shared', connectionRef: shared.resource.connectionRef,
        bindingRevision: shared.resource.bindingRevision } }, requirement: 'optional', toolCap: ['read_fixture'],
    }] });
    const turn: AgentExecutionContext = { ...intake, agentTurnId: 'actual-human-turn',
      turnExtensions: readAcceptedTurnExtensionSelection(accepted, intake).publicSelection };
    const packageSelection = await getAuthorizedAgentWorkflowPackageSelections(turn);
    turn.turnExtensionSource = await reissueAcceptedTurnRuntimeSelection(turn, accepted, intake, { packageSelection });
    const held = await resolveEffectiveExtensionContext(turn, { packageSelection });
    assert.equal(isIssuedScopedIntegrationTurn(held), true);
    const fresh = await contexts.resolveRuntimeIntegrationExecutionContext({ executionContext: held, policyRevision: 'fresh' });
    assert.equal(fresh.executionContext.turnExtensionSource, held.turnExtensionSource, 'The real issued source pointer retains object identity.');
    assert.deepEqual(fresh.executionContext.turnExtensions, held.turnExtensions);
    assert.equal(fresh.executionContext.agentTurnId, held.agentTurnId);
    assert.equal(isIssuedScopedIntegrationTurn(fresh.executionContext), true);
    const actualProviderRef = createSharedIntegrationProviderRef(shared.resource);
    const effective = readEffectiveExtensionContext(fresh.executionContext)!;
    assert.deepEqual(effective.workflowProjection?.policy.providerToolRules?.map(rule => [rule.providerRef, rule.allowedToolNames]),
      [[actualProviderRef, ['read_fixture']]], 'The finite current projection contains exactly the accepted source and intersected cap.');
    for (const changed of [
      { ...held, turnExtensionSource: structuredClone(held.turnExtensionSource) },
      { ...held, turnExtensionSource: undefined },
      { ...held, agentTurnId: 'foreign-turn' }, { ...held, sessionId: 'foreign-session' },
      { ...held, turnExtensions: { ...held.turnExtensions!, selections: [] } },
    ]) await assert.rejects(contexts.resolveRuntimeIntegrationExecutionContext({ executionContext: changed, policyRevision: 'denied' }),
      { code: 'AGENT_EXTENSION_CONTEXT_DENIED' });
    await sql.run("UPDATE canvas_workspace_members SET can_write=0 WHERE user_id='alice'");
    await assert.rejects(contexts.resolveRuntimeIntegrationExecutionContext({ executionContext: held, policyRevision: 'downgraded' }),
      { code: 'provider_denied' }, 'Role downgrade cannot drop an accepted source and continue as general policy.');
    await sql.run("UPDATE canvas_workspace_members SET can_write=1 WHERE user_id='alice'");

    let providerIo = 0, businessCalls = 0;
    let duringDescribe: (() => Promise<void>) | undefined;
    const descriptor: IntegrationProviderDescriptor = { providerRef: actualProviderRef, source: 'mcp', displayName: 'Controlled exact metadata',
      scope: { type: 'organization', organizationId: owner.organizationId, resourceId: shared.resource.connectionRef },
      configured: true, requiresAuth: false, authorized: true, state: 'ready', health: 'healthy', canExecute: true,
      checkedAt: null, statusSource: 'provider', pluginRefs: [], skillRefs: [], matchReasons: [], nextActions: [] };
    const currentDescriptor = async (context: IntegrationExecutionContext) => {
      const current = await authorizeIntegrationConnection(integrationConnectionActorFromContext(context), shared.resource.connectionRef, 'inspect');
      const issued = await createSharedIntegrationPolicyDescriptor(context, current);
      // Controlled provider status overlays the actual source-issued descriptor;
      // it never constructs or substitutes a connection authorization.
      return transferIntegrationProviderAuthorization(context, issued, { ...issued, ...descriptor, scope: issued.scope });
    };
    const adapter: IntegrationToolAdapter = { source: 'mcp',
      async resolveProvider(context, ref) { providerIo++; assert.equal(ref, actualProviderRef); return { provider: await currentDescriptor(context), binding: {}, bindingRevision: 'fixture-1' }; },
      async listTools() { providerIo++; return { tools: [{ name: 'read_fixture', description: 'Read fixture', effect: 'read' }], complete: true, nextCursor: null, providerErrors: [] }; },
      async describeTool() { providerIo++; const hook = duringDescribe; duringDescribe = undefined; await hook?.();
        return { name: 'read_fixture', description: 'Read fixture', effect: 'read', toolVersion: '1', inputSchema: { type: 'object', additionalProperties: false } }; },
      async callTool() { businessCalls++; return { content: [{ type: 'text', text: 'Controlled result' }], details: {} }; },
    };
    const noComposio = async (): Promise<never> => { throw new Error('A finite MCP turn must not perform Composio IO.'); };
    const dispatcher = new IntegrationDispatcher({ adapters: { mcp: adapter, composio: { source: 'composio',
      resolveProvider: noComposio, listTools: noComposio, describeTool: noComposio, callTool: noComposio } }, catalogAdapters: {
      mcp: async context => { providerIo++; return { source: 'mcp', providers: [await currentDescriptor(context), { ...descriptor, providerRef: 'unselected-ref', displayName: 'Unselected source' }],
        complete: true, providerErrors: [], revision: 'fixture-catalogue' }; },
      composio: async () => { throw new Error('A finite MCP turn must not probe Composio.'); },
    } });
    const details = (result: AgentToolResult<unknown>) => result.details as { integrationError?: { error: { code: string } }; providers?: IntegrationProviderDescriptor[] };
    const tool = createIntegrationGatewayTool({ userId: 'alice', agentId: 'bradley', sessionId: 'actual-session', executionContext: held },
      { dispatcher, isEnabled: () => false });
    const invoke = (request: unknown, context = held) => runWithAgentExecutionContext(context, () => tool.execute('fixture-call', request as never));
    const generic = createIntegrationGatewayTool({ userId: 'alice', agentId: 'bradley', sessionId: 'actual-session', executionContext: base },
      { dispatcher, isEnabled: () => false });
    assert.equal(details(await generic.execute('disabled-general', { action: 'list', target: 'providers' })).integrationError?.error.code, 'tool_denied');
    assert.equal(providerIo, 0, 'Unscoped general flagOFF performs no provider IO.');
    const page = await invoke({ action: 'list', target: 'providers' });
    assert.equal(details(page).integrationError, undefined);
    assert.deepEqual(details(page).providers?.map(provider => provider.providerRef), [actualProviderRef]);
    const beforeClone = providerIo;
    assert.equal(details(await invoke({ action: 'list', target: 'providers' }, { ...held,
      turnExtensionSource: structuredClone(held.turnExtensionSource) })).integrationError?.error.code, 'provider_denied');
    assert.equal(providerIo, beforeClone, 'A cloned opaque source is denied before provider IO.');
    const tools = await invoke({ action: 'list', target: 'tools', providerRef: actualProviderRef });
    const toolRef = (details(tools) as unknown as { tools: Array<{ toolRef: string }> }).tools[0].toolRef;
    const described = details(await invoke({ action: 'describe', toolRef })) as unknown as IntegrationToolSchema;
    let revocationApplied = false;
    duringDescribe = async () => {
      await mutateSharedIntegrationConnection(owner, shared.resource.connectionRef, { expectedMetadataRevision: shared.resource.metadataRevision,
        expectedGrantsRevision: shared.resource.grantsRevision, expectedBindingRevision: shared.resource.bindingRevision, grants: [] });
      revocationApplied = true;
    };
    const revoked = await invoke({ action: 'call', toolRef: described.toolRef, schemaRef: described.schemaRef, arguments: {} });
    assert.equal(revocationApplied, true, 'The actual grant mutation ran between schema preparation and business IO.');
    assert.ok(['schema_changed', 'provider_denied', 'tool_denied'].includes(details(revoked).integrationError?.error.code ?? ''),
      'Fresh source revocation must produce an authority error, not an unrelated provider failure.');
    assert.equal(businessCalls, 0, 'No business call starts after late source revocation.');
    // Protocol fixtures only: V1/V2 readers exist before the later authoring
    // phase enables aggregate writes. Empty fixed configurations grant no source.
    for (const version of [1, 2]) {
      await sql.run('UPDATE agents SET workflow_version=$1,workflow_revision=workflow_revision+1 WHERE agent_id=\'bradley\'', [version]);
      const fixed = await contexts.resolveIntegrationExecutionContext({ actorUserId: 'alice', sessionId: 'actual-session', policyRevision: 'fixed' });
      const fixedTool = createIntegrationGatewayTool({ userId: 'alice', agentId: 'bradley', sessionId: 'actual-session', executionContext: fixed.executionContext },
        { dispatcher, isEnabled: () => false });
      const fixedPage = details(await fixedTool.execute('fixed-off', { action: 'list', target: 'providers' }));
      assert.equal(fixedPage.integrationError, undefined, `Fixed V${version} gateway admission is independent of the UI experiment.`);
      assert.deepEqual(fixedPage.providers, [], 'An empty fixed configuration does not inherit generic sources.');
    }
    console.log('PASS actual PGlite integration context: issued pointer/public turn/turn ID, finite caps, clone and role fences, unscoped flagOFF, fixed V1/V2 flagOFF, and late source revocation before business IO.');
  } finally {
    loader._load = original;
    await database.close();
    await rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

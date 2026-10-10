import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { createPiTestDatabase } from './helpers/pi-test-database';
import {
  createIntegrationPolicyFromLegacyTools,
  INTEGRATION_LEGACY_CAPABILITY_NAMES,
  isIntegrationOperationAllowed,
  UNRESTRICTED_INTEGRATION_POLICY,
} from '../app/lib/integration-tools/policy';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-integration-runtime-policy-'));
  const environment = {
    DATA: root, CANVAS_DATA_ROOT: root, CANVAS_ORGANIZATION_ID: 'runtime-policy-org',
    CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
    CANVAS_MCP_DIRECT_ENABLED: 'false', BETTER_AUTH_BASE_URL: 'http://localhost:3000',
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const database = await createPiTestDatabase();
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    if (name === '@/app/lib/skills/effective-skill-read-roots') return {
      resolveEffectiveSkillReadRoots: async () => [], resolvePersonalSkillReadRoots: async () => [],
    };
    if (name === '@/app/lib/agents/workspace-brand-context') return { getWorkspaceBrandPromptBlock: async () => null };
    return originalLoad(name, parent, isMain);
  };
  try {
    const empty = createIntegrationPolicyFromLegacyTools({ legacyToolNames: [] });
    assert.deepEqual(empty.allowedSources, []);
    for (const name of ['integrations', 'composio', 'mcp_custom_action', 'constructor', 'toString']) {
      assert.deepEqual(createIntegrationPolicyFromLegacyTools({ legacyToolNames: [name] }), empty, 'Unknown names and group aliases never grant a source.');
    }
    const mcp = createIntegrationPolicyFromLegacyTools({ legacyToolNames: ['mcp'] });
    assert.deepEqual(mcp.allowedSources, ['mcp']);
    assert.equal(mcp.allowedOperations?.length, 6);
    const executeOnly = createIntegrationPolicyFromLegacyTools({ legacyToolNames: ['composio_execute'] });
    assert.deepEqual(executeOnly.allowedOperations, ['composio.call']);
    const connectionsOnly = createIntegrationPolicyFromLegacyTools({ legacyToolNames: ['COMPOSIO_MANAGE_CONNECTIONS'] });
    assert.deepEqual(connectionsOnly.allowedOperations, ['composio.list_providers', 'composio.search_providers']);
    assert.deepEqual(createIntegrationPolicyFromLegacyTools({ legacyToolNames: ['COMPOSIO_GET_TOOL_SCHEMAS'] }).allowedOperations, ['composio.describe']);
    const searchOnly = createIntegrationPolicyFromLegacyTools({ legacyToolNames: ['COMPOSIO_SEARCH_TOOLS'] });
    assert.equal(searchOnly.allowedOperations?.length, 4);
    assert.equal(isIntegrationOperationAllowed(searchOnly, 'composio', 'call'), false);
    for (const options of [{ planningMode: true }, { emailEventAutomation: true }]) {
      assert.deepEqual(createIntegrationPolicyFromLegacyTools({ legacyToolNames: INTEGRATION_LEGACY_CAPABILITY_NAMES, ...options }), empty);
    }
    assert.deepEqual(createIntegrationPolicyFromLegacyTools({ legacyToolNames: ['__none__', 'mcp'] }), empty);
    const narrowed = createIntegrationPolicyFromLegacyTools({ legacyToolNames: INTEGRATION_LEGACY_CAPABILITY_NAMES, restrictions: [{
      ...UNRESTRICTED_INTEGRATION_POLICY, allowedProviderRefs: ['fixed-connection'], allowedApplications: ['canva'],
      allowedToolNames: [], allowedSources: ['mcp'],
    }] });
    assert.deepEqual(narrowed.allowedProviderRefs, ['fixed-connection']);
    assert.deepEqual(narrowed.allowedApplications, ['canva']);
    assert.deepEqual(narrowed.allowedToolNames, []);
    assert.deepEqual(narrowed.allowedSources, ['mcp']);

    const raw = await database.openDb();
    for (const userId of ['owner', 'alice', 'bob']) await raw.run(
      'INSERT INTO "user" (id,name,email,role,email_verified,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,1,1)', [userId, `${userId}@example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('runtime-policy-org','owner','team',1,1,1)");
    for (const userId of ['alice', 'bob']) await raw.run(
      "INSERT INTO organization_user_permissions (organization_id,user_id,role,status,created_at,updated_at) VALUES ('runtime-policy-org',$1,'member','active',1,1)", [userId]);
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('team-a','runtime-policy-org','team','workspaces/team-a/files','Team A','active',1,1)");
    await raw.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ('runtime-policy-org','team-a','alice','member','active',1,0,0,1,1)");
    for (const agentId of ['design-agent', 'parent-agent']) {
      await raw.run("INSERT INTO agents (agent_id,name,type,access_policy,scope_type,organization_id,owner_user_id,enabled_tools_json,revision,created_at,updated_at) VALUES ($1,$1,'special','restricted','organization','runtime-policy-org','owner','[]',1,1,1)", [agentId]);
      await raw.run("INSERT INTO agent_grants (id,agent_id,organization_id,target_type,target_id,can_use,can_edit,can_manage,created_at,updated_at) VALUES ($1,$2,'runtime-policy-org','workspace','team-a',1,0,0,1,1)", [`grant-${agentId}`, agentId]);
    }
    const { piDelegations, piSessions } = await import('../app/lib/db/schema');
    const now = new Date();
    const session = (sessionId: string, agentId = 'design-agent', userId = 'alice') => ({
      sessionId, userId, agentId, workspaceId: 'team-a', workspaceType: 'team', organizationId: 'runtime-policy-org',
      provider: 'fixture', model: 'fixture', createdAt: now, updatedAt: now,
    });
    await database.db.insert(piSessions).values([
      session('normal'), session('parent', 'parent-agent'), session('foreign-parent', 'parent-agent', 'bob'), session('automation-run'),
      { ...session('managed'), sessionKind: 'delegation_worker', parentSessionId: 'parent', delegationDepth: 1 },
      { ...session('ephemeral'), sessionKind: 'delegation_worker', parentSessionId: 'normal', delegationDepth: 1 },
    ]);
    const task = (id: string, workerSessionId: string, workerType: 'managed' | 'ephemeral', sourceSessionId: string, sourceAgentId: string) => ({
      id, userId: 'alice', sourceSessionId, sourceAgentId, workerSessionId,
      targetAgentId: workerType === 'managed' ? 'design-agent' : null, workerType,
      goal: 'Run the integration fixture', toolsetsJson: JSON.stringify(['mcp', 'composio']), status: 'running',
      createdAt: now, updatedAt: now,
    });
    await database.db.insert(piDelegations).values([
      task('managed-task', 'managed', 'managed', 'parent', 'parent-agent'),
      task('ephemeral-task', 'ephemeral', 'ephemeral', 'normal', 'design-agent'),
    ]);
    const { resolveIntegrationExecutionContext, resolveIntegrationAuthorizationContext, resolveRuntimeIntegrationExecutionContext } = await import('../app/lib/integration-tools/context');
    const { resolveIntegrationRuntimePolicy } = await import('../app/lib/integration-tools/runtime-policy');
    const initial = await resolveIntegrationExecutionContext({ actorUserId: 'alice', sessionId: 'normal', policyRevision: 'initial' });
    const context = { ...initial.executionContext, agentTurnId: 'server-issued-turn' };
    const callPolicy = (executionContext: AgentExecutionContext = context, options = {}) => resolveIntegrationRuntimePolicy({ executionContext, ceiling: UNRESTRICTED_INTEGRATION_POLICY, ...options });
    const baseline = await callPolicy();
    assert.deepEqual(baseline.policy.allowedSources, ['mcp', 'composio']);
    assert.equal(isIntegrationOperationAllowed(baseline.policy, 'mcp', 'call'), true, 'Read/run workspace permission preserves existing external-tool access.');
    assert.equal((await callPolicy()).policyRevision, baseline.policyRevision, 'Unchanged authority has a stable revision.');
    const authorization = await resolveIntegrationAuthorizationContext({ actorUserId: 'alice', sessionId: 'normal', policyRevision: 'initial' });
    assert.deepEqual(authorization.executionContext.skillReadRoots, []);
    assert.deepEqual(authorization.executionContext.skillPackageBindings, []);
    assert.deepEqual(await callPolicy(authorization.executionContext), baseline,
      'Prompt-file capture does not change the current legacy policy, provenance or fingerprint.');
    const runtimeContext = await resolveRuntimeIntegrationExecutionContext({ executionContext: context, policyRevision: baseline.policyRevision });
    assert.equal(runtimeContext.executionContext.canWrite, false);
    assert.equal(runtimeContext.executionContext.agentTurnId, context.agentTurnId);
    for (const changed of [
      { ...context, workspaceId: 'missing' }, { ...context, workspaceType: 'personal' as const },
      { ...context, organizationId: 'foreign-org' }, { ...context, workspaceRoot: path.join(root, 'forged') },
      { ...context, agentId: 'parent-agent' },
    ]) await assert.rejects(resolveRuntimeIntegrationExecutionContext({ executionContext: changed, policyRevision: baseline.policyRevision }), { code: 'provider_denied' });
    const mutable = { executionContext: { ...context }, policyRevision: baseline.policyRevision };
    const contextPending = resolveRuntimeIntegrationExecutionContext(mutable);
    Object.assign(mutable.executionContext, { workspaceId: 'forged', userId: 'bob' });
    assert.equal((await contextPending).integrationContext.actorUserId, 'alice');
    const mutableCeiling = { ...mcp, allowedSources: ['mcp'] as Array<'mcp' | 'composio'> };
    const policyPending = resolveIntegrationRuntimePolicy({ executionContext: context, ceiling: mutableCeiling });
    mutableCeiling.allowedSources.push('composio');
    assert.deepEqual((await policyPending).policy.allowedSources, ['mcp'], 'The captured ceiling cannot be broadened during a DB await.');

    const setEnabled = async (names: string[]) => raw.run("UPDATE agents SET enabled_tools_json=$1,revision=revision+1 WHERE agent_id='design-agent'", [JSON.stringify(names)]);
    await setEnabled(['mcp']);
    const mcpOnly = await callPolicy();
    assert.deepEqual(mcpOnly.policy.allowedSources, ['mcp']);
    assert.notEqual(mcpOnly.policyRevision, baseline.policyRevision);
    await setEnabled(['COMPOSIO_GET_TOOL_SCHEMAS']);
    assert.deepEqual((await callPolicy()).policy.allowedOperations, ['composio.describe']);
    const heldMcpCeiling = await resolveIntegrationRuntimePolicy({ executionContext: context, ceiling: mcpOnly.policy });
    assert.deepEqual(heldMcpCeiling.policy.allowedSources, [], 'New preferences cannot replace the registered source ceiling.');
    assert.deepEqual(await resolveIntegrationRuntimePolicy({ executionContext: authorization.executionContext, ceiling: mcpOnly.policy }), heldMcpCeiling,
      'Authorization-only contexts retain current agent settings and the saved monotone ceiling.');
    await setEnabled(['__none__']);
    assert.deepEqual((await callPolicy()).policy.allowedSources, []);
    await setEnabled([' __none__ ', 'mcp']);
    assert.deepEqual((await callPolicy()).policy.allowedSources, [], 'Normalized sentinel still denies a mixed legacy selection.');
    await setEnabled(['composio']);
    assert.deepEqual((await callPolicy()).policy.allowedSources, [], 'A previously ineffective group alias stays ineffective.');
    await setEnabled(['filesystem', 'terminal']);
    assert.deepEqual((await callPolicy()).policy.allowedSources, ['mcp', 'composio'], 'Legacy default aliases preserve existing defaults.');
    await setEnabled([]);

    for (const sessionId of ['managed', 'ephemeral', 'automation-run']) {
      const resolved = await resolveIntegrationExecutionContext({ actorUserId: 'alice', sessionId, policyRevision: 'test' });
      const effective = await callPolicy(resolved.executionContext);
      const authorization = await resolveIntegrationAuthorizationContext({ actorUserId: 'alice', sessionId, policyRevision: 'test' });
      assert.deepEqual(authorization.executionContext.skillReadRoots, []);
      assert.deepEqual(authorization.executionContext.skillPackageBindings, []);
      assert.deepEqual(await callPolicy(authorization.executionContext), effective,
        'Managed/ephemeral/automation authority and policy revisions remain equal without prompt-file capture.');
      if (sessionId === 'automation-run') assert.deepEqual(effective.policy.allowedSources, ['mcp', 'composio']);
      else {
        assert.equal(isIntegrationOperationAllowed(effective.policy, 'mcp', 'call'), true);
        assert.equal(isIntegrationOperationAllowed(effective.policy, 'composio', 'call'), true);
        assert.equal(isIntegrationOperationAllowed(effective.policy, 'composio', 'search_tools'), false, 'The existing execute-only Composio worker ceiling is unchanged.');
      }
    }
    const ephemeral = (await resolveIntegrationExecutionContext({ actorUserId: 'alice', sessionId: 'ephemeral', policyRevision: 'test' })).executionContext;
    const ephemeralPolicy = await callPolicy(ephemeral);
    await raw.run("UPDATE pi_delegations SET status='cancelled' WHERE id='ephemeral-task'");
    const cancelledPolicy = await callPolicy(ephemeral);
    assert.deepEqual(cancelledPolicy.policy.allowedSources, []);
    const cancelledAuthorization = await resolveIntegrationAuthorizationContext({ actorUserId: 'alice', sessionId: 'ephemeral', policyRevision: 'test' });
    assert.deepEqual(await callPolicy(cancelledAuthorization.executionContext), cancelledPolicy,
      'A new authorization context cannot revive a cancelled delegated task.');
    await raw.run("UPDATE pi_delegations SET status='running',cancel_requested_at=1 WHERE id='ephemeral-task'");
    assert.deepEqual((await callPolicy(ephemeral)).policy.allowedSources, []);
    await raw.run("UPDATE pi_delegations SET cancel_requested_at=NULL,source_session_id='foreign-parent' WHERE id='ephemeral-task'");
    assert.deepEqual((await callPolicy(ephemeral)).policy.allowedSources, []);
    await raw.run("UPDATE pi_delegations SET source_session_id='normal',source_agent_id='parent-agent' WHERE id='ephemeral-task'");
    assert.deepEqual((await callPolicy(ephemeral)).policy.allowedSources, []);
    await raw.run("UPDATE pi_delegations SET source_agent_id='design-agent',user_id='bob' WHERE id='ephemeral-task'");
    assert.deepEqual((await callPolicy(ephemeral)).policy.allowedSources, []);
    await raw.run("UPDATE pi_delegations SET user_id='alice' WHERE id='ephemeral-task'");
    await raw.run("UPDATE pi_sessions SET session_kind='conversation' WHERE session_id='ephemeral'");
    assert.deepEqual((await callPolicy(ephemeral)).policy.allowedSources, []);
    await raw.run("UPDATE pi_sessions SET session_kind='delegation_worker' WHERE session_id='ephemeral'");
    await database.db.insert(piDelegations).values(task('ambiguous-task', 'ephemeral', 'ephemeral', 'normal', 'design-agent'));
    assert.deepEqual((await callPolicy(ephemeral)).policy.allowedSources, []);
    await raw.run("DELETE FROM pi_delegations WHERE id='ambiguous-task'");
    assert.equal((await callPolicy(ephemeral)).policyRevision, ephemeralPolicy.policyRevision);
    await raw.run("UPDATE pi_delegations SET id='replacement-task' WHERE id='ephemeral-task'");
    assert.notEqual((await callPolicy(ephemeral)).policyRevision, ephemeralPolicy.policyRevision, 'A reused worker cannot reuse a prior task schema revision.');
    await raw.run("UPDATE pi_delegations SET status='completed' WHERE id='managed-task'");
    const managed = (await resolveIntegrationExecutionContext({ actorUserId: 'alice', sessionId: 'managed', policyRevision: 'test' })).executionContext;
    assert.deepEqual((await callPolicy(managed)).policy.allowedSources, []);
    for (const mode of [{ planningMode: true }, { emailEventAutomation: true }]) assert.deepEqual((await callPolicy(context, mode)).policy.allowedSources, []);

    const beforePersistence = { ...context, sessionId: 'new-automation' };
    await assert.rejects(resolveRuntimeIntegrationExecutionContext({ executionContext: beforePersistence, policyRevision: 'test' }), { code: 'provider_denied' });
    await database.db.insert(piSessions).values(session('new-automation'));
    assert.equal((await resolveRuntimeIntegrationExecutionContext({ executionContext: beforePersistence, policyRevision: 'test' })).executionContext.sessionId, 'new-automation');
    await raw.run("UPDATE agent_grants SET can_use=0 WHERE agent_id='design-agent'");
    await assert.rejects(resolveRuntimeIntegrationExecutionContext({ executionContext: context, policyRevision: 'test' }), { code: 'AGENT_ACCESS_DENIED' });
    await raw.run("UPDATE agent_grants SET can_use=1 WHERE agent_id='design-agent'");
    await raw.run("UPDATE canvas_workspace_members SET status='disabled' WHERE user_id='alice'");
    await assert.rejects(resolveRuntimeIntegrationExecutionContext({ executionContext: context, policyRevision: 'test' }), /inaccessible/u);
    console.log('PASS real PG runtime integration policy: exact legacy rights, monotone ceilings, defaults/sentinel, managed and ephemeral provenance, automation persistence, live revocation and immutable context.');
  } finally {
    internals._load = originalLoad;
    await database.close();
    await rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

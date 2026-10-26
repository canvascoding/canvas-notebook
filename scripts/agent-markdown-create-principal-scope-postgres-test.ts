import assert from 'node:assert/strict';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceAgentToolPrincipalAccess } from '../app/lib/workspaces/request-principal';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Real captured PI invocations and transactions. A valid seat in a different
// configured organization must never authorize the original workspace.
await withNativeCopyMetadataOwnerFixture(async h => {
  const { MAIN_AGENT_ID } = await import('../app/lib/agents/main-agent');
  const { EMAIL_MANAGED_AGENT_ID } = await import('../app/lib/agents/storage');
  const { openDb } = await import('../app/lib/db');
  const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
  const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
  const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
  const { withAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
  const principal = await import('../app/lib/workspaces/request-principal');
  const agentIds = [MAIN_AGENT_ID, EMAIL_MANAGED_AGENT_ID, 'scoped-create-fixture'];
  for (const agentId of agentIds) {
    await h.admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
      VALUES($1,'Scope fixture','special','restricted','organization','principal-org','["write"]',100,100)
      ON CONFLICT(agent_id) DO UPDATE SET enabled_tools_json=excluded.enabled_tools_json`, [agentId]);
    await h.admin.query(`INSERT INTO agent_members(agent_id,organization_id,user_id,status,can_use,created_at,updated_at)
      VALUES($1,'principal-org','owner','active',1,100,100)`, [agentId]);
    await h.admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,
      workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
      VALUES($1,'owner',$2,'fixture','fixture','principal-org',$3,$4,'Scope fixture',$5,100,100)`,
    [`scope-${agentId}`, agentId, h.source.workspaceId, h.source.workspaceType, h.source.rootRelativePath]);
  }
  await h.admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
    VALUES('second-fixture-org','owner','team',1,200,200)`);
  await h.admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
    VALUES('second-fixture-org','owner','owner','active',1,200,200)`);
  await h.admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
    VALUES('second-fixture-seat','second-fixture-org','owner@principal.test','owner','owner','active',100,100,200,200)`);
  await h.admin.query(`INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('second-fixture-org',200,200)`);
  let groups = 0;
  for (const agentId of agentIds) for (const create of [false, true]) for (const drift of [false, true]) {
    let entered = false, checked = false, published = false, errorCode: string | null = null;
    const actual = await resolveAgentExecutionContextForStoredSession({ sessionId: `scope-${agentId}`, userId: 'owner', agentId,
      permissions: ['canRead', 'canRunAgent', 'canWrite'] });
    async function phase<P>(p: P, bind: (database: SqlConnection, p: P,
      operation: (access: WorkspaceAgentToolPrincipalAccess) => Promise<string>) => Promise<string>) {
      return executeLifecycleTransaction({ openConnection: openDb, execute: async database => {
        await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
        return bind(database, p, async access => {
          entered = true;
          if (drift) await database.run(`UPDATE canvas_organization_settings SET created_at=50 WHERE organization_id='second-fixture-org'`);
          await access.assertCurrent(); checked = true;
          return 'current-result';
        });
      }, recoverCommitted: async () => { throw new Error('Unexpected unconfirmed scope fixture transaction.'); } });
    }
    try {
      const result = await runWithAgentExecutionContext(actual, () => withAgentToolInvocation(actual,
        { toolName: 'write', toolCallId: `${agentId}-${create}-${drift}` }, () => create
          ? principal.withWorkspaceAgentMarkdownCreatePrincipalOriginalOrigin({ workspaceId: h.source.workspaceId }, () => undefined,
            p => phase(p, principal.withWorkspaceAgentMarkdownCreatePrincipalOnConnection))
          : principal.withWorkspaceAgentToolPrincipalOriginalOrigin({ workspaceId: h.source.workspaceId, permission: 'canWrite' }, () => undefined,
            p => phase(p, principal.withWorkspaceAgentToolPrincipalOnConnection))));
      published = result === 'current-result';
    } catch (error) {
      errorCode = error && typeof error === 'object' ? String(Reflect.get(error, 'code') ?? Reflect.get(error, 'name')) : 'unknown';
    } finally {
      // Restore only this fixture's row, including when the pre-fix Create
      // incorrectly committed its self-drift. No production row is touched.
      await h.admin.query(`UPDATE canvas_organization_settings SET created_at=200 WHERE organization_id='second-fixture-org'`);
    }
    assert(entered, 'Each genuine phase must enter before any drift.');
    assert.equal(checked, !drift, 'Current must reject organization drift for every Agent access shortcut.');
    assert.equal(published, !drift, 'No precomputed successful result may escape a drifted scope.');
    if (drift) assert(errorCode && /^(?:PRINCIPAL_|AGENT_ACTOR_CONTEXT_)/u.test(errorCode));
    else assert.equal(errorCode, null);
    groups++;
  }
  assert.equal(groups, 12);
  console.log(JSON.stringify({ suite: 'agent-markdown-create-principal-scope', groups,
    evidence: 'genuine_pg_and_pi_default_email_and_restricted_agent_controls_and_primary_organization_drift' }));
});

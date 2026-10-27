import assert from 'node:assert/strict';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceAgentToolPrincipalAccess } from '../app/lib/workspaces/request-principal';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Real captured PI invocations and transactions. Every current check must see
// changes made after admission, including the genuine Create snapshot path.
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
  const drifts = ['control', 'organization', 'session-archive', 'session-scope', 'session-id',
    'profile-revision', 'workspace-root', 'workspace-disabled', 'account-ban', 'seat-suspended'] as const;
  const authorityRows = async () => (await h.admin.query(`
    SELECT 'organization' AS kind,organization_id AS key,to_jsonb(o) AS value,xmin::text AS version FROM canvas_organization_settings o
    UNION ALL SELECT 'session',session_id,to_jsonb(s),xmin::text FROM pi_sessions s
    UNION ALL SELECT 'profile',agent_id,to_jsonb(a),xmin::text FROM agents a
    UNION ALL SELECT 'workspace',id,to_jsonb(w),xmin::text FROM canvas_workspaces w
    UNION ALL SELECT 'account',id,to_jsonb(u),xmin::text FROM "user" u
    UNION ALL SELECT 'seat',id,to_jsonb(m),xmin::text FROM team_memberships m
    UNION ALL SELECT 'seat-sync',organization_id,to_jsonb(s),xmin::text FROM team_membership_sync_state s
    UNION ALL SELECT 'organization-permission',organization_id||':'||user_id,to_jsonb(p),xmin::text FROM organization_user_permissions p
    ORDER BY kind,key`)).rows;
  let groups = 0;
  for (const agentId of agentIds) for (const create of [false, true]) for (const drift of drifts) {
    let entered = false, checked = false, published = false, errorCode: string | null = null;
    const actual = await resolveAgentExecutionContextForStoredSession({ sessionId: `scope-${agentId}`, userId: 'owner', agentId,
      permissions: ['canRead', 'canRunAgent', 'canWrite'] });
    const before = await authorityRows();
    async function phase<P>(p: P, bind: (database: SqlConnection, p: P,
      operation: (access: WorkspaceAgentToolPrincipalAccess) => Promise<string>) => Promise<string>) {
      return executeLifecycleTransaction({ openConnection: openDb, execute: async database => {
        await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
        return bind(database, p, async access => {
          entered = true;
          switch (drift) {
            case 'organization':
              await database.run(`UPDATE canvas_organization_settings SET created_at=50 WHERE organization_id='second-fixture-org'`); break;
            case 'session-archive':
              await database.run('UPDATE pi_sessions SET archived_at=101 WHERE session_id=$1', [`scope-${agentId}`]); break;
            case 'session-scope':
              await database.run("UPDATE pi_sessions SET workspace_root_relative_path=workspace_root_relative_path||'/drift' WHERE session_id=$1", [`scope-${agentId}`]); break;
            case 'session-id':
              await database.run('UPDATE pi_sessions SET id=id+1000 WHERE session_id=$1', [`scope-${agentId}`]); break;
            case 'profile-revision':
              await database.run('UPDATE agents SET revision=revision+1 WHERE agent_id=$1', [agentId]); break;
            case 'workspace-root':
              await database.run("UPDATE canvas_workspaces SET root_relative_path=root_relative_path||'/drift' WHERE id=$1", [h.source.workspaceId]); break;
            case 'workspace-disabled':
              await database.run("UPDATE canvas_workspaces SET status='disabled' WHERE id=$1", [h.source.workspaceId]); break;
            case 'account-ban':
              await database.run('UPDATE "user" SET banned=1 WHERE id=$1', ['owner']); break;
            case 'seat-suspended':
              await database.run("UPDATE team_memberships SET status='suspended' WHERE id='owner-seat'"); break;
          }
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
    }
    assert(entered, 'Each genuine phase must enter before any drift.');
    const succeeds = drift === 'control';
    assert.equal(checked, succeeds, `Current must reject ${drift} for every Agent access shortcut.`);
    assert.equal(published, succeeds, 'No precomputed successful result may escape a drifted scope.');
    if (!succeeds) assert(errorCode && /^(?:PRINCIPAL_|AGENT_ACTOR_CONTEXT_|SEAT_)/u.test(errorCode));
    else assert.equal(errorCode, null);
    assert.deepEqual(await authorityRows(), before, 'Controls and rolled-back denials preserve actual authority rows and xmin.');
    groups++;
  }
  assert.equal(groups, agentIds.length * 2 * drifts.length);
  console.log(JSON.stringify({ suite: 'agent-markdown-create-principal-scope', groups,
    evidence: 'genuine_pg_and_pi_default_email_and_restricted_agents_fresh_scope_account_session_profile_checks_and_exact_rollback' }));
});

import assert from 'node:assert/strict';
import type { SqlConnection } from '../app/lib/db';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Mutate the actual held transaction after its genuine scope-facts SELECT.
// No SQL reply, Principal, PI invocation or authority decision is substituted.
await withNativeCopyMetadataOwnerFixture(async h => {
  const { MAIN_AGENT_ID } = await import('../app/lib/agents/main-agent');
  const { EMAIL_MANAGED_AGENT_ID } = await import('../app/lib/agents/storage');
  const { openDb } = await import('../app/lib/db');
  const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
  const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
  const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
  const { withAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
  const principal = await import('../app/lib/workspaces/request-principal');
  const agents = [MAIN_AGENT_ID, EMAIL_MANAGED_AGENT_ID];
  for (const agentId of agents) {
    await h.admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
      VALUES($1,'Final origin fixture','special','restricted','organization','principal-org','["write"]',100,100)
      ON CONFLICT(agent_id) DO UPDATE SET enabled_tools_json=excluded.enabled_tools_json`, [agentId]);
    await h.admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,
      workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
      VALUES($1,'owner',$2,'fixture','fixture','principal-org',$3,$4,'Final origin fixture',$5,100,100)`,
    [`final-${agentId}`, agentId, h.source.workspaceId, h.source.workspaceType, h.source.rootRelativePath]);
  }
  const authorityRows = async () => (await h.admin.query(`
    SELECT 'workspace' AS kind,id AS key,to_jsonb(w) AS value,xmin::text AS version FROM canvas_workspaces w
    UNION ALL SELECT 'workspace-member',workspace_id||':'||user_id,to_jsonb(m),xmin::text FROM canvas_workspace_members m
    UNION ALL SELECT 'session',session_id,to_jsonb(s),xmin::text FROM pi_sessions s
    UNION ALL SELECT 'agent',agent_id,to_jsonb(a),xmin::text FROM agents a
    UNION ALL SELECT 'account',id,to_jsonb(u),xmin::text FROM "user" u
    UNION ALL SELECT 'organization',organization_id,to_jsonb(o),xmin::text FROM canvas_organization_settings o
    UNION ALL SELECT 'seat',id,to_jsonb(m),xmin::text FROM team_memberships m
    ORDER BY kind,key`)).rows;
  const relationOids = async () => (await h.admin.query(`SELECT name,
    to_regclass(quote_ident($1)||'.'||quote_ident(name))::oid AS oid
    FROM unnest($2::text[]) names(name) ORDER BY name`,
  [h.schema, ['canvas_workspaces', 'canvas_workspace_members']])).rows;
  const drifts = ['control', 'search-path', 'workspace-root', 'workspace-disabled', 'relation-shadow', 'workspace-missing'] as const;
  let groups = 0;
  for (const agentId of agents) for (const drift of drifts) {
    const context = await resolveAgentExecutionContextForStoredSession({ sessionId: `final-${agentId}`, userId: 'owner', agentId,
      permissions: ['canRead', 'canRunAgent', 'canWrite'] });
    const before = await authorityRows(), beforeOids = await relationOids();
    let armed = false, facts = 0, entered = false, checked = false, published = false, origins = 0;
    let originsBefore = -1, originsAfter = -1, errorCode: string | null = null;
    const openConnection = async (): Promise<SqlConnection> => {
      const actual = await openDb();
      return {
        get: async (sql, args) => {
          const row = await actual.get(sql, args);
          if (armed && row && typeof row === 'object' && Array.isArray(Reflect.get(row, 'sessions'))
            && Object.hasOwn(row, 'workspace') && Object.hasOwn(row, 'profile') && Object.hasOwn(row, 'seat')) {
            armed = false; facts++;
            switch (drift) {
              case 'search-path': await actual.run('SET LOCAL search_path=pg_catalog'); break;
              case 'workspace-root': await actual.run("UPDATE canvas_workspaces SET root_relative_path=root_relative_path||'/changed' WHERE id=$1", [h.source.workspaceId]); break;
              case 'workspace-disabled': await actual.run("UPDATE canvas_workspaces SET status='disabled' WHERE id=$1", [h.source.workspaceId]); break;
              case 'relation-shadow': {
                await actual.run('ALTER TABLE canvas_workspace_members RENAME TO final_origin_original_members');
                await actual.run('CREATE TEMP TABLE canvas_workspace_members (not_a_membership integer)');
                const shadow = await actual.get(`SELECT to_regclass('canvas_workspace_members')::oid
                  IS DISTINCT FROM to_regclass(quote_ident($1)||'.canvas_workspace_members')::oid AS different`, [h.schema]);
                assert(shadow && typeof shadow === 'object');
                assert.equal(Reflect.get(shadow, 'different'), true); break;
              }
              case 'workspace-missing': await actual.run('ALTER TABLE canvas_workspaces RENAME TO final_origin_original_workspaces'); break;
            }
          }
          return row;
        },
        all: (sql, args) => actual.all(sql, args),
        run: (sql, args) => actual.run(sql, args),
        close: error => actual.close(error),
      };
    };
    try {
      const result = await runWithAgentExecutionContext(context, () => withAgentToolInvocation(context,
        { toolName: 'write', toolCallId: `final-${agentId}-${drift}` }, () =>
          principal.withWorkspaceAgentMarkdownCreatePrincipalOriginalOrigin({ workspaceId: h.source.workspaceId }, () => { origins++; },
            p => executeLifecycleTransaction({ openConnection, execute: async database => {
              await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
              return principal.withWorkspaceAgentMarkdownCreatePrincipalOnConnection(database, p, async access => {
                entered = true; originsBefore = origins; armed = true;
                try { await access.assertCurrent(); checked = true; }
                finally { originsAfter = origins; }
                return 'current-original';
              });
            }, recoverCommitted: async () => { throw new Error('Unexpected unconfirmed final-origin fixture.'); } }))));
      published = result === 'current-original';
    } catch (error) {
      errorCode = error && typeof error === 'object' ? String(Reflect.get(error, 'code') ?? Reflect.get(error, 'name')) : 'unknown';
    }
    const control = drift === 'control';
    assert(entered); assert.equal(facts, 1, 'The real scope snapshot must precede the same-transaction drift.');
    assert.equal(checked, control); assert.equal(published, control);
    assert.equal(errorCode, control ? null : drift === 'relation-shadow' || drift === 'workspace-missing'
      ? 'PRINCIPAL_SCHEMA_INVALID' : 'PRINCIPAL_SCOPE_CHANGED');
    assert.equal(originsAfter, originsBefore + (control ? 1 : 0), 'A failed final observation must never reach the original-origin sink.');
    assert.deepEqual(await authorityRows(), before); assert.deepEqual(await relationOids(), beforeOids);
    groups++;
  }
  assert.equal(groups, agents.length * drifts.length);
  console.log(JSON.stringify({ suite: 'agent-markdown-create-final-origin', groups,
    evidence: 'actual_post_facts_realm_workspace_and_relation_drift_typed_denials_no_origin_result_and_exact_rollback' }));
});

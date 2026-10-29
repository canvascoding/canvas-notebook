import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Genuine captured PI callers, existing locks and real PostgreSQL. Positive
// rows and authority are not substituted; faults execute actual held SQL.
await withNativeCopyMetadataOwnerFixture(async h => {
  const { MAIN_AGENT_ID } = await import('../app/lib/agents/main-agent');
  const { EMAIL_MANAGED_AGENT_ID } = await import('../app/lib/agents/storage');
  const { openDb } = await import('../app/lib/db');
  const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
  const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
  const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
  const { withAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
  const principal = await import('../app/lib/workspaces/request-principal');
  const agents = [MAIN_AGENT_ID, EMAIL_MANAGED_AGENT_ID, 'initial-snapshot-restricted'];
  const stableTables = ['user', 'session', 'agents', 'agent_members', 'agent_grants', 'pi_sessions',
    'canvas_organization_settings', 'organization_user_permissions', 'team_memberships', 'team_membership_sync_state',
    'canvas_workspaces', 'canvas_workspace_members', 'canvas_project_members', 'collaboration_documents',
    'collaboration_yjs_states', 'file_collaboration_lineages', 'file_revisions'];
  for (const agentId of agents) {
    await h.admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
      VALUES($1,'Initial snapshot fixture','special','restricted','organization','principal-org','["write"]',100,100)
      ON CONFLICT(agent_id) DO UPDATE SET enabled_tools_json=excluded.enabled_tools_json`, [agentId]);
    await h.admin.query(`INSERT INTO agent_members(agent_id,organization_id,user_id,status,can_use,created_at,updated_at)
      VALUES($1,'principal-org','owner','active',1,100,100)`, [agentId]);
    await h.admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,
      workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
      VALUES($1,'owner',$2,'fixture','fixture','principal-org',$3,$4,'Initial snapshot',$5,100,100)`,
    [`initial-${agentId}`, agentId, h.source.workspaceId, h.source.workspaceType, h.source.rootRelativePath]);
  }
  const rows = async () => {
    const result: Record<string, unknown> = {};
    for (const name of stableTables) result[name] = (await h.admin.query(`SELECT to_jsonb(r) AS body,xmin::text AS xmin
      FROM "${h.schema}"."${name}" r ORDER BY to_jsonb(r)::text,xmin::text`)).rows;
    return result;
  };
  const drifts = ['control', 'account-ban', 'session-archive', 'search-path-order', 'search-path-missing',
    'relation-shadow', 'relation-missing'] as const;
  let groups = 0;
  for (const agentId of agents) for (const drift of drifts) {
    const context = await resolveAgentExecutionContextForStoredSession({ sessionId: `initial-${agentId}`, userId: 'owner', agentId,
      permissions: ['canRead', 'canRunAgent', 'canWrite'] });
    const before = await rows();
    let entered = false, checked = false, published = false, failure: unknown;
    try {
      const result = await runWithAgentExecutionContext(context, () => withAgentToolInvocation(context,
        { toolName: 'write', toolCallId: `initial-${agentId}-${drift}` }, () =>
          principal.withWorkspaceAgentMarkdownCreatePrincipalOriginalOrigin({ workspaceId: h.source.workspaceId }, () => undefined,
            p => executeLifecycleTransaction({ openConnection: openDb, execute: async database => {
              await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
              return principal.withWorkspaceAgentMarkdownCreatePrincipalOnConnection(database, p, async access => {
                entered = true;
                if (drift === 'account-ban') await database.run('UPDATE "user" SET banned=1 WHERE id=$1', ['owner']);
                if (drift === 'session-archive') await database.run('UPDATE pi_sessions SET archived_at=101 WHERE session_id=$1', [`initial-${agentId}`]);
                if (drift === 'search-path-order') await database.run(`SET LOCAL search_path=pg_catalog,"${h.schema}",pg_temp`);
                if (drift === 'search-path-missing') await database.run('SET LOCAL search_path=pg_catalog');
                if (drift === 'relation-missing') await database.run('ALTER TABLE agents RENAME TO initial_snapshot_original_agents');
                if (drift === 'relation-shadow') {
                  await database.run('ALTER TABLE canvas_workspace_members RENAME TO initial_snapshot_original_members');
                  await database.run('CREATE TEMP TABLE canvas_workspace_members (not_a_member integer)');
                  const shadow = await database.get(`SELECT to_regclass('canvas_workspace_members')::oid IS DISTINCT FROM
                    to_regclass(quote_ident($1)||'.canvas_workspace_members')::oid AS shadow`, [h.schema]) as { shadow: boolean };
                  assert.equal(shadow.shadow, true);
                }
                let sql = 0, joint = 0, final = 0;
                const observations: Array<{ backend: unknown; transaction: unknown }> = [];
                await h.withProbe(async event => {
                  sql++;
                  const row = event.result.rows[0];
                  if (row?.principal_identity) { joint++; observations.push(row.principal_identity); }
                  if (row?.schema === h.schema && row.workspace_id === h.source.workspaceId && Array.isArray(row.relations)) {
                    final++; observations.push(row);
                  }
                }, () => access.assertCurrent());
                checked = true;
                console.log('AGENT_INITIAL_SNAPSHOT_COUNTS', JSON.stringify({ agent: agents.indexOf(agentId), sql, joint, final }));
                if (agentId !== 'initial-snapshot-restricted') assert.equal(sql, 2,
                  'A managed Current uses one fresh identity/scope snapshot and its fresh final origin snapshot.');
                else assert(sql > 2, 'The restricted Agent retains its real access resolver.');
                assert.equal(joint, 1); assert.equal(final, 1); assert.equal(observations.length, 2);
                assert.equal(observations[0].backend, observations[1].backend);
                assert.equal(observations[0].transaction, observations[1].transaction);
                assert.equal(typeof observations[0].transaction, 'string');
                // Another explicit Current must execute both snapshots anew.
                let repeated = 0;
                await h.withProbe(async event => {
                  const row = event.result.rows[0];
                  if (row?.principal_identity || row?.schema === h.schema && row.workspace_id === h.source.workspaceId
                    && Array.isArray(row.relations)) repeated++;
                }, () => access.assertCurrent());
                assert.equal(repeated, 2);
                return 'current-initial';
              });
            }, recoverCommitted: async () => { throw new Error('Unexpected unconfirmed initial-snapshot fixture.'); } }))));
      published = result === 'current-initial';
    } catch (error) { failure = error; }
    assert(entered);
    if (drift === 'control') {
      if (failure) throw failure;
      assert(checked && published);
    } else {
      assert(!checked && !published);
      assert.match(String(failure && typeof failure === 'object' ? Reflect.get(failure, 'code') : failure), /^PRINCIPAL_/u);
    }
    assert.deepEqual(await rows(), before, 'Success and rolled-back denial preserve real authority/native rows and xmin.');
    groups++;
  }
  assert.equal(groups, 21);
  console.log('AGENT_INITIAL_SNAPSHOT_PROOF', JSON.stringify({ groups, freshManagedCurrentSql: 2,
    restrictedResolverRetained: true, actualAuthorityNativeRowsAndXminUnchanged: true }));
});

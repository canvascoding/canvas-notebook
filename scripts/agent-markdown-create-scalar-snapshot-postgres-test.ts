import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Genuine non-admin PI caller and held PostgreSQL transaction. Actual column
// changes must never disappear through JSON rounding or grant new permissions.
await withDocumentReadToolDispatchFixture(async h => {
  const { openDb } = await import('../app/lib/db');
  const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
  const principal = await import('../app/lib/workspaces/request-principal');
  const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
  const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
  const { withAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
  const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
  const { readPostgresWorkspaceForActorInSingleSnapshotOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
  const schema = (await h.admin.query('SELECT current_schema() AS schema')).rows[0].schema as string;
  await h.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'");
  await h.setPiEnabledTools(['write']);
  const stableTables = ['user', 'session', 'agents', 'agent_members', 'agent_grants', 'pi_sessions',
    'canvas_organization_settings', 'organization_user_permissions', 'team_memberships', 'team_membership_sync_state',
    'canvas_workspaces', 'canvas_workspace_members', 'canvas_project_members'];
  const rows = async () => {
    const authority: Record<string, unknown> = {};
    for (const name of stableTables) authority[name] = (await h.admin.query(`SELECT to_jsonb(r) AS body,xmin::text AS xmin
      FROM "${schema}"."${name}" r ORDER BY to_jsonb(r)::text,xmin::text`)).rows;
    const columns = (await h.admin.query(`SELECT c.relname,a.attname,a.atttypid,a.atttypmod
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY c.relname,a.attname`, [schema, stableTables])).rows;
    return { authority, columns, domain: await h.snapshot() };
  };
  const faults = ['control', 'write-numeric-one', 'write-numeric-fraction', 'profile-revision-fraction',
    'profile-workflow-revision-underflow', 'unsupported-workspace-domain', 'unsupported-profile-domain'] as const;
  const failures: unknown[] = [];
  let groups = 0;
  for (const mode of ['prepared', 'fallback'] as const) for (const fault of faults) {
    const context = await resolveAgentExecutionContextForStoredSession({ sessionId: h.piSessionId, userId: 'reader',
      agentId: h.agentId, permissions: ['canRead', 'canWrite', 'canRunAgent'] });
    const before = await rows(), rollback = new Error('Roll back the owned scalar fixture mutation.');
    let entered = false, mutated = false, checked = false, failure: unknown;
    try {
      await runWithAgentExecutionContext(context, () => withAgentToolInvocation(context,
        { toolName: 'write', toolCallId: `scalar-${mode}-${fault}` }, () =>
          principal.withWorkspaceAgentMarkdownCreatePrincipalOriginalOrigin({ workspaceId: h.workspaceId }, () => undefined,
            p => executeLifecycleTransaction({ openConnection: async () => {
              const database = await openDb();
              if (mode === 'fallback') delete database.getPrepared;
              return database;
            }, execute: async database => {
              await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
              return principal.withWorkspaceAgentMarkdownCreatePrincipalOnConnection(database, p, async access => {
                entered = true;
                if (fault.startsWith('write-numeric-')) {
                  await database.run('ALTER TABLE organization_user_permissions ALTER COLUMN can_write_team_workspace TYPE numeric USING can_write_team_workspace::numeric');
                  await database.run('UPDATE organization_user_permissions SET can_write_team_workspace=$2::numeric WHERE user_id=$1',
                    ['reader', fault === 'write-numeric-one' ? '1' : '1.00000000000000000001']);
                  const scalar = await readPostgresWorkspaceForActorInSingleSnapshotOnConnection(database,
                    resolveWorkspaceActor({ id: 'reader', role: 'user', email: 'reader@dispatch.test' }), h.workspaceId);
                  assert(scalar); assert.equal(scalar.permissions.canWrite, false);
                }
                if (fault === 'profile-revision-fraction' || fault === 'profile-workflow-revision-underflow') {
                  const column = fault === 'profile-revision-fraction' ? 'revision' : 'workflow_revision';
                  await database.run(`ALTER TABLE agents ALTER COLUMN ${column} TYPE numeric USING ${column}::numeric`);
                  await database.run(`UPDATE agents SET ${column}=${column}+'1e-400'::numeric WHERE agent_id=$1`, [h.agentId]);
                  const raw = await database.get(`SELECT ${column} AS scalar, to_jsonb(${column}) AS encoded FROM agents WHERE agent_id=$1`,
                    [h.agentId]) as { scalar: unknown; encoded: unknown };
                  assert.equal(typeof raw.scalar, 'string');
                  assert.equal(Number.isSafeInteger(raw.encoded), true, 'JSON hides the actual fractional profile revision.');
                  assert.match(String(raw.scalar), /\./u);
                }
                if (fault === 'unsupported-workspace-domain' || fault === 'unsupported-profile-domain') {
                  await database.run('CREATE DOMAIN agent_snapshot_numeric_flag AS numeric');
                  if (fault === 'unsupported-workspace-domain') await database.run('ALTER TABLE organization_user_permissions ALTER COLUMN can_write_team_workspace TYPE agent_snapshot_numeric_flag USING can_write_team_workspace::numeric');
                  else await database.run('ALTER TABLE agents ALTER COLUMN revision TYPE agent_snapshot_numeric_flag USING revision::numeric');
                }
                mutated = fault !== 'control';
                await access.assertCurrent(); checked = true;
                assert.equal(fault, 'control', 'Unexpected acceptance rolls back before COMMIT.');
                throw rollback;
              });
            }, recoverCommitted: async () => { throw new Error('Unexpected unconfirmed scalar fixture commit.'); } }))));
    } catch (error) { failure = error; }
    assert.deepEqual(await rows(), before, 'Actual auth/native rows, xmin and column types are restored.');
    assert(entered);
    console.log('AGENT_SCALAR_SNAPSHOT_CASE', JSON.stringify({ mode, fault, entered, mutated, checked, restored: true }));
    try {
      if (fault === 'control') { assert(checked); assert.equal(failure, rollback); assert(!mutated); }
      else {
        assert(mutated && !checked);
        const code = failure && typeof failure === 'object' ? Reflect.get(failure, 'code') : undefined;
        if (fault.startsWith('unsupported-')) assert.equal(code, 'PRINCIPAL_SCHEMA_INVALID');
        else if (fault.startsWith('profile-')) assert.equal(code, 'PRINCIPAL_ACCESS_DENIED');
        else assert.equal(code, 'WORKSPACE_PERMISSION_DENIED');
      }
    } catch (error) { failures.push(error); }
    groups++;
  }
  assert.equal(groups, 14);
  if (failures.length) throw new AggregateError(failures, 'Actual scalar snapshot decisions differ from the scalar policy.');
  console.log('AGENT_SCALAR_SNAPSHOT_PROOF', JSON.stringify({ groups, realNonAdmin: true,
    scalarPolicyPreserved: true, profilePrecisionPreserved: true, actualRowsXminAndTypesRestored: true }));
});

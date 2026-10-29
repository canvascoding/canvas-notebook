import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Actual authenticated member, actual held PostgreSQL connection and original
// query replies. Faults change real SQL state; no positive authority is forged.
await withNativeCopyMetadataOwnerFixture(async h => {
  const { openDb } = await import('../app/lib/db');
  const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
  const principal = await import('../app/lib/workspaces/request-principal');
  const { readPostgresWorkspaceForActorInSingleSnapshotOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
  const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
  const stableTables = ['user', 'session', 'canvas_organization_settings', 'organization_user_permissions',
    'team_memberships', 'team_membership_sync_state', 'canvas_workspaces', 'canvas_projects',
    'canvas_workspace_members', 'canvas_project_members', 'collaboration_documents', 'collaboration_yjs_states',
    'file_collaboration_lineages', 'file_revisions', 'workspace_file_metadata', 'workspace_file_user_states'];
  const rows = async () => {
    const result: Record<string, unknown> = {};
    for (const name of stableTables) result[name] = (await h.admin.query(`SELECT to_jsonb(r) AS body,xmin::text AS xmin
      FROM "${h.schema}"."${name}" r ORDER BY to_jsonb(r)::text,xmin::text`)).rows;
    result.columnTypes = (await h.admin.query(`SELECT c.relname,a.attname,a.atttypid,a.atttypmod
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY c.relname,a.attname`, [h.schema, stableTables])).rows;
    return result;
  };
  const faults = ['control', 'account-ban', 'session-expiry', 'session-token', 'session-impersonation', 'session-missing',
    'seat-revoked', 'workspace-disabled', 'workspace-root', 'read-revoked', 'write-revoked',
    'search-path-order', 'search-path-missing', 'relation-shadow', 'relation-missing',
    'write-numeric-one', 'write-numeric-fraction', 'read-numeric-fraction', 'unsupported-write-domain'] as const;
  let groups = 0;
  for (const permission of ['canRead', 'canWrite'] as const) for (const fault of faults) {
    // Both the first observation and the retained final observation must see
    // real context drift. Policy faults run between the two real SQL replies.
    const timings = fault.startsWith('search-path') || fault.startsWith('relation-') ? ['before', 'between'] : ['between'];
    for (const timing of timings) {
      const before = await rows();
      let entered = false, checked = false, published = false, injected = false, failure: unknown;
      const rollbackReadControl = new Error('Read remains allowed after write-only revocation; rollback fixture fault.');
      const readSurvives = permission === 'canRead' && (fault === 'write-revoked' || fault.startsWith('write-numeric-'));
      const mutate = async (query: (text: string, values?: unknown[]) => Promise<unknown>) => {
        injected = true;
        if (fault === 'account-ban') await query('UPDATE "user" SET banned=1 WHERE id=$1', ['member']);
        if (fault === 'session-expiry') await query('UPDATE "session" SET expires_at=1 WHERE id=$1', ['session-member']);
        if (fault === 'session-token') await query('UPDATE "session" SET token=token||$1 WHERE id=$2', ['-rotated', 'session-member']);
        if (fault === 'session-impersonation') await query('UPDATE "session" SET impersonated_by=$1 WHERE id=$2', ['owner', 'session-member']);
        if (fault === 'session-missing') await query('DELETE FROM "session" WHERE id=$1', ['session-member']);
        if (fault === 'seat-revoked') await query("UPDATE team_memberships SET status='suspended' WHERE user_id=$1", ['member']);
        if (fault === 'workspace-disabled') await query("UPDATE canvas_workspaces SET status='disabled' WHERE id=$1", [h.destination.workspaceId]);
        if (fault === 'workspace-root') await query("UPDATE canvas_workspaces SET root_relative_path=root_relative_path||'/changed' WHERE id=$1", [h.destination.workspaceId]);
        if (fault === 'read-revoked') await query('UPDATE canvas_workspace_members SET can_read=0,can_write=0 WHERE workspace_id=$1 AND user_id=$2', [h.destination.workspaceId, 'member']);
        if (fault === 'write-revoked') await query('UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id=$2', [h.destination.workspaceId, 'member']);
        if (fault === 'search-path-order') await query(`SET LOCAL search_path=pg_catalog,"${h.schema}",pg_temp`);
        if (fault === 'search-path-missing') await query('SET LOCAL search_path=pg_catalog');
        if (fault === 'relation-shadow') await query(`CREATE TEMP TABLE canvas_workspace_members (LIKE "${h.schema}".canvas_workspace_members INCLUDING ALL)`);
        if (fault === 'relation-missing') await query('ALTER TABLE canvas_workspace_members RENAME TO member_snapshot_original_members');
        if (fault === 'write-numeric-one' || fault === 'write-numeric-fraction' || fault === 'read-numeric-fraction') {
          const column = fault === 'read-numeric-fraction' ? 'can_read' : 'can_write';
          await query(`ALTER TABLE canvas_workspace_members ALTER COLUMN ${column} TYPE numeric USING ${column}::numeric`);
          await query(`UPDATE canvas_workspace_members SET ${column}=$3::numeric WHERE workspace_id=$1 AND user_id=$2`,
            [h.destination.workspaceId, 'member', fault === 'write-numeric-one' ? '1' : '1.00000000000000000001']);
          if (fault === 'read-numeric-fraction') await query('UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id=$2',
            [h.destination.workspaceId, 'member']);
        }
        if (fault === 'unsupported-write-domain') {
          await query('CREATE DOMAIN member_snapshot_numeric_flag AS numeric');
          await query('ALTER TABLE canvas_workspace_members ALTER COLUMN can_write TYPE member_snapshot_numeric_flag USING can_write::numeric');
        }
      };
      try {
        const result = await principal.withWorkspaceRequestPrincipal(await h.request(h.destination, 'member'),
          { workspaceId: h.destination.workspaceId, permission }, p => executeLifecycleTransaction({
            openConnection: openDb, execute: async database => {
              await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
              return principal.withWorkspaceRequestPrincipalOnConnection(database, p, async access => {
                entered = true;
                if (fault !== 'control' && timing === 'before') await mutate(async (text, values) => database.run(text, values));
                let sql = 0;
                const observations: Array<{ backend: unknown; transaction: unknown }> = [];
                await h.withProbe(async event => {
                  sql++;
                  const row = event.result.rows[0];
                  if (row?.schema === h.schema && Array.isArray(row.relations) && row.workspace && row.seat) observations.push(row);
                  // Forward the actual first reply after a real same-B change.
                  if (fault !== 'control' && timing === 'between' && !injected) {
                    await mutate(event.raw);
                    if (fault.includes('numeric')) {
                      const scalar = await readPostgresWorkspaceForActorInSingleSnapshotOnConnection({
                        get: async (text, values) => (await event.raw(text, values)).rows[0],
                      }, resolveWorkspaceActor({ id: 'member', role: 'user', email: 'member@principal.test' }), h.destination.workspaceId);
                      assert.equal(fault === 'read-numeric-fraction' ? scalar?.permissions.canRead ?? false : scalar?.permissions.canWrite ?? false,
                        false, 'The unchanged scalar policy denies the actual NUMERIC permission on the same connection.');
                    }
                  }
                }, () => access.assertCurrent());
                checked = true;
                console.log('MEMBER_CURRENT_SNAPSHOT_COUNTS', JSON.stringify({ permission, fault, timing, sql }));
                assert.equal(sql, 2, 'Every Member Current requires exactly two fresh complete observations.');
                assert.equal(observations.length, 2);
                assert.equal(observations[0].backend, observations[1].backend);
                assert.equal(observations[0].transaction, observations[1].transaction);
                assert.equal(typeof observations[0].transaction, 'string');
                if (readSurvives) throw rollbackReadControl;
                assert.equal(fault, 'control', 'Unexpectedly accepted faults must roll back before COMMIT.');
                let repeated = 0;
                await h.withProbe(async () => { repeated++; }, () => access.assertCurrent());
                assert.equal(repeated, 2, 'A repeated Current must read both observations afresh.');
                return 'current-member';
              });
            }, recoverCommitted: async () => { throw new Error('Unexpected unconfirmed Member fixture commit.'); },
          }));
        published = result === 'current-member';
      } catch (error) { failure = error; }
      assert.deepEqual(await rows(), before, 'Control and rolled-back faults preserve all real authority/native/metadata rows, xmin and column types.');
      assert(entered);
      if (fault === 'control') {
        if (failure) throw failure;
        assert(checked && published); assert(!injected);
      } else if (readSurvives) {
        assert(checked && injected && !published); assert.equal(failure, rollbackReadControl);
      } else {
        assert(injected && !checked && !published);
        const code = failure && typeof failure === 'object' ? Reflect.get(failure, 'code') : undefined;
        assert.equal(code, fault === 'account-ban' ? 'SEAT_ACCESS_INACTIVE'
          : fault === 'seat-revoked' ? 'SEAT_MEMBERSHIP_REQUIRED'
          : fault.startsWith('session-') ? 'PRINCIPAL_AUTH_REVOKED'
          : fault.startsWith('relation-') || fault === 'unsupported-write-domain' ? 'PRINCIPAL_SCHEMA_INVALID'
          : fault === 'read-revoked' || fault === 'write-revoked' || fault.includes('numeric')
            ? 'PRINCIPAL_ACCESS_DENIED' : 'PRINCIPAL_SCOPE_CHANGED', `${fault}: ${String(failure)}`);
      }
      groups++;
    }
  }
  assert.equal(groups, 46);
  console.log('MEMBER_CURRENT_SNAPSHOT_PROOF', JSON.stringify({ groups, freshCurrentSql: 2,
    realMemberReadAndWrite: true, betweenReplyRevocation: true, actualRowsAndXminUnchanged: true }));
});

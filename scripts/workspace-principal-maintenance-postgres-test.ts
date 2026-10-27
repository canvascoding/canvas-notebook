import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

async function workspacePrincipalMaintenancePostgresTest(): Promise<void> {
  await withNativeCopyMetadataOwnerFixture(async h => {
    const filePath = 'maintenance/metadata.md';
    await h.upload(filePath, Buffer.from('# Original maintenance target\n'));
    const stableTables = ['user', 'session', 'team_memberships', 'team_membership_sync_state',
      'canvas_organization_settings', 'organization_user_permissions', 'canvas_workspaces', 'canvas_projects',
      'canvas_workspace_members', 'canvas_project_members', 'collaboration_documents', 'collaboration_yjs_states',
      'file_collaboration_lineages', 'file_revisions', 'collaboration_markdown_file_import_receipts', 'collaboration_markdown_create_births'];
    const rows = async (names: readonly string[]) => {
      const result: Record<string, unknown> = {};
      for (const name of names) result[name] = (await h.admin.query(`SELECT to_jsonb(r) AS body,r.xmin::text AS xmin
        FROM "${h.schema}"."${name}" r ORDER BY to_jsonb(r)::text`)).rows;
      return result;
    };
    let groups = 0;
    const cases: Array<{ relation: string; mode: 'short' | 'long'; activity: 'analyze' | 'ban' | 'disable' }> = [];
    for (const relation of ['user', 'team_memberships', 'canvas_workspaces', 'canvas_organization_settings']) {
      for (const mode of ['short', 'long'] as const) cases.push({ relation, mode, activity: 'analyze' });
    }
    cases.push({ relation: 'user', mode: 'short', activity: 'ban' },
      { relation: 'canvas_workspaces', mode: 'short', activity: 'disable' });
    for (const { relation, mode, activity } of cases) {
      const before = await rows(stableTables);
      let expectedAuthority = before;
      const beforeMetadata = await rows(['workspace_file_metadata', 'workspace_file_user_states']);
      let injected = false, maintenanceOpen = false, requestTerminal = false, waiting = false, releasedForWaiter = false;
      let requestSucceeded = false, failure: unknown, principalPid: number | undefined;
      let waitingSince: number | undefined, waitingEnded: number | undefined;
      let monitor: Promise<void> | undefined;
      const lock = (await h.admin.query(`SELECT to_regclass(quote_ident($1)||'.'||quote_ident($2))::oid AS oid`,
        [h.schema, relation])).rows[0].oid;
      const codes: string[] = [];
      try {
        await h.withProbe(async event => {
          if (injected || !event.text.includes("SET LOCAL statement_timeout='5s'")
            || !event.text.includes("SET LOCAL lock_timeout='50ms'")) return;
          injected = true; principalPid = Number(Reflect.get(event.client, 'processID'));
          assert(Number.isSafeInteger(principalPid) && principalPid > 0);
          assert.equal((await event.raw('SHOW lock_timeout')).rows[0].lock_timeout, '50ms');
          assert.equal((await event.raw('SHOW transaction_timeout')).rows[0].transaction_timeout, '5s');
          await h.admin.query('BEGIN'); maintenanceOpen = true;
          // Execute the real maintenance or revocation, never a simulated
          // query result or an explicit imitation of its table lock.
          if (activity === 'analyze') await h.admin.query(`ANALYZE "${h.schema}"."${relation}"`);
          else {
            if (activity === 'ban') await h.admin.query("UPDATE \"user\" SET banned=1 WHERE id='owner'");
            else await h.admin.query("UPDATE canvas_workspaces SET status='disabled' WHERE id=$1", [h.source.workspaceId]);
            expectedAuthority = await rows(stableTables);
          }
          const held = (await h.admin.query(`SELECT mode FROM pg_locks WHERE pid=pg_backend_pid()
            AND relation=$1::oid AND granted`, [lock])).rows;
          assert(held.some(row => row.mode === (activity === 'analyze' ? 'ShareUpdateExclusiveLock' : 'RowExclusiveLock')));
          const deadline = performance.now() + 2000;
          monitor = (async () => {
            while (true) {
              const observed = (await h.admin.query(`SELECT EXISTS(SELECT 1 FROM pg_locks
                WHERE pid=$1 AND relation=$2::oid AND mode='ShareLock' AND NOT granted) AS waiting`, [principalPid, lock])).rows[0];
              if (observed.waiting === true) { waiting = true; waitingSince ??= performance.now(); }
              if (mode === 'short' && waiting || requestTerminal || performance.now() >= deadline) {
                releasedForWaiter = mode === 'short' && waiting && !requestTerminal;
                await h.admin.query('COMMIT'); maintenanceOpen = false; waitingEnded = performance.now(); return;
              }
              await new Promise(resolve => setTimeout(resolve, 1));
            }
          })();
          void monitor.catch(() => undefined);
        }, () => h.metadata(h.source, filePath, { title: 'After maintenance', isFavorite: true, pinned: true }, 'owner'));
        requestSucceeded = true;
      } catch (error) { failure = error; }
      finally {
        requestTerminal = true;
        try { await monitor; }
        finally { if (maintenanceOpen) { await h.admin.query('ROLLBACK'); maintenanceOpen = false; } }
      }
      assert(injected); assert.equal(maintenanceOpen, false);
      if (failure && typeof failure === 'object') {
        const pending: unknown[] = [failure], seen = new Set<unknown>();
        for (const error of pending) {
          if (!error || typeof error !== 'object' || seen.has(error)) continue;
          seen.add(error); assert(seen.size < 64);
          const code = Reflect.get(error, 'code'); if (typeof code === 'string') codes.push(code);
          pending.push(Reflect.get(error, 'cause')); const errors: unknown = Reflect.get(error, 'errors'); if (Array.isArray(errors)) pending.push(...errors);
        }
      }
      assert.deepEqual(await rows(stableTables), expectedAuthority, 'The Principal may not change authority/native rows beyond the actual external update.');
      const afterMetadata = await rows(['workspace_file_metadata', 'workspace_file_user_states']);
      if (!requestSucceeded) assert.deepEqual(afterMetadata, beforeMetadata, 'A busy Principal must leave all metadata/xmin intact.');
      console.log('PRINCIPAL_FOUNDATION_CONTENTION', JSON.stringify({ relation, mode, activity, requestSucceeded, waiting,
        releasedForWaiter, codes, maintenanceLock: activity === 'analyze' ? 'ShareUpdateExclusiveLock' : 'RowExclusiveLock', principalLockTimeoutMs: 50,
        visibleWaitMs: waitingSince === undefined || waitingEnded === undefined ? null : Math.round((waitingEnded - waitingSince) * 100) / 100 }));
      assert.equal(requestSucceeded, mode === 'short' && activity === 'analyze', 'Only settled maintenance may proceed; committed revocation must deny.');
      assert.equal(waiting, true, 'The real Principal must be observed waiting for this exact maintenance relation.');
      if (mode === 'short' && activity === 'analyze') {
        assert.equal(releasedForWaiter, true); assert.equal(failure, undefined);
        const title = (await h.admin.query('SELECT title FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2',
          [h.source.workspaceId, filePath])).rows;
        assert.equal(title.length, 1); assert.equal(title[0].title, 'After maintenance');
        const personal = (await h.admin.query('SELECT is_favorite,pinned_at FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2 AND user_id=$3',
          [h.source.workspaceId, filePath, 'owner'])).rows;
        assert.equal(personal.length, 1); assert.equal(Number(personal[0].is_favorite), 1); assert(Number(personal[0].pinned_at) > 0);
      } else assert(codes.includes(activity === 'ban' ? 'SEAT_ACCESS_INACTIVE'
        : activity === 'disable' ? 'PRINCIPAL_SCOPE_CHANGED' : 'PRINCIPAL_BUSY'));
      if (activity === 'ban') await h.admin.query("UPDATE \"user\" SET banned=0 WHERE id='owner'");
      if (activity === 'disable') await h.admin.query("UPDATE canvas_workspaces SET status='active' WHERE id=$1", [h.source.workspaceId]);
      groups++;
    }
    console.log('PRINCIPAL_FOUNDATION_CONTENTION_GROUPS', groups);
  });
}

await workspacePrincipalMaintenancePostgresTest();

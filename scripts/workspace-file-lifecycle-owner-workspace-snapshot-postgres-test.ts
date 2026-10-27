import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';
import type { SqlConnection } from '../app/lib/db';

// Actual dedicated sessions and actual pg_locks replies. Negative public ALS
// objects never replace a successful SQL result, connection or owner context.
async function lifecycleOwnerWorkspaceSnapshotPostgresTest(): Promise<void> {
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { openDb } = await import('../app/lib/db');
    const { withWorkspaceFileLifecycleGuard, readWorkspaceFileLifecycleOwnerWorkspaceSnapshot: readOwner } =
      await import('../app/lib/files/workspace-file-lifecycle-guard');
    const { getWorkspaceFileLifecycleLeases, withWorkspaceFileLifecycleLeases } =
      await import('../app/lib/collaboration/file-lifecycle-admission-context');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const workspaceId = h.source.workspaceId, key = collaborationAdmissionLockKey(workspaceId);
    const cases: string[] = [];
    const test = async (name: string, operation: () => Promise<void>) => {
      await operation(); cases.push(name); console.log(`Lifecycle owner snapshot PG18 passed: ${name}`);
    };
    const guarded = async (operation: (owner: SqlConnection) => Promise<void>) => {
      let owner: SqlConnection | undefined;
      await withWorkspaceFileLifecycleGuard({ workspaceId, paths: ['owner-snapshot.md'] }, async () => {
        assert(owner); await operation(owner);
      }, async () => { owner = await openDb(); return owner; });
    };
    const snapshotSql = (text: string) => text.startsWith('SELECT realm.*,EXISTS(') && text.includes('pg_catalog.pg_locks');
    const metadata = async () => (await h.admin.query(`SELECT 'document' AS kind,id AS identity,xmin::text AS xmin,to_jsonb(d) AS row
      FROM collaboration_documents d WHERE workspace_id=$1 UNION ALL
      SELECT 'state',document_id,xmin::text,to_jsonb(s) FROM collaboration_yjs_states s WHERE workspace_id=$1
      UNION ALL SELECT 'workspace',id,xmin::text,to_jsonb(w) FROM canvas_workspaces w WHERE id=$1
      ORDER BY kind,identity`, [workspaceId])).rows;
    const expectedWorkspace = (await h.admin.query('SELECT type,organization_id,project_id,customer_id,owner_user_id,root_relative_path,status FROM canvas_workspaces WHERE id=$1', [workspaceId])).rows[0];
    const before = await metadata();

    await test('one fresh SQL statement per genuine owner observation', async () => {
      let queries = 0;
      await guarded(async owner => {
        await h.withProbe(async event => { if (snapshotSql(event.text)) queries++; }, async () => {
          for (let i = 0; i < 2; i++) {
            const observed = await readOwner(owner, workspaceId); assert(observed?.snapshot);
            assert.equal(observed.snapshot.schema, h.schema); assert.equal(observed.snapshot.held, true);
            assert(Number(observed.snapshot.backend) > 0); assert(Number(observed.snapshot.database) > 0);
            assert.equal(observed.snapshot.workspace_id, workspaceId);
            for (const field of Object.keys(expectedWorkspace)) assert.deepEqual(observed.snapshot[field], expectedWorkspace[field]);
            assert(Number(observed.snapshot.schema_oid) > 0); assert.equal(observed.snapshot.database_oid, observed.snapshot.database);
            assert.equal(observed.snapshot.search_path, observed.snapshot.searchPath);
            assert.equal(typeof observed.snapshot.start, 'string'); assert.equal(typeof observed.snapshot.searchPath, 'string');
            assert.equal(queries, i + 1, 'A previous positive observation cannot replace the next actual query.');
          }
        });
      });
      assert.equal(queries, 2);
    });
    await test('actual same-owner workspace facts are fresh and rollback preserves rows and xmin', async () => {
      await guarded(async owner => {
        const first = await readOwner(owner, workspaceId); assert(first?.snapshot);
        await owner.run('BEGIN');
        try {
          const changed = await owner.get(`UPDATE canvas_workspaces SET root_relative_path=root_relative_path||'-changed'
            WHERE id=$1 RETURNING root_relative_path`, [workspaceId]) as { root_relative_path: string };
          const next = await readOwner(owner, workspaceId); assert(next?.snapshot);
          assert.equal(next.snapshot.held, true); assert.equal(next.snapshot.backend, first.snapshot.backend);
          assert.equal(next.snapshot.root_relative_path, changed.root_relative_path);
          assert.notEqual(next.snapshot.root_relative_path, first.snapshot.root_relative_path);
        } finally { await owner.run('ROLLBACK'); }
        assert.equal((await readOwner(owner, workspaceId))?.snapshot?.root_relative_path, first.snapshot.root_relative_path);
      });
      assert.deepEqual(await metadata(), before);
    });
    await test('another real connection, copied facade and different workspace cannot select this owner', async () => {
      await guarded(async owner => {
        let queries = 0;
        await h.withProbe(async event => { if (snapshotSql(event.text)) queries++; }, async () => {
          assert.equal(await readOwner(h.connection, workspaceId), undefined);
          assert.equal(await readOwner({ ...owner }, workspaceId), undefined);
          assert.equal(await readOwner(owner, h.destination.workspaceId), undefined);
        });
        assert.equal(queries, 0); assert.equal((await readOwner(owner, workspaceId))?.snapshot?.held, true);
      });
    });
    await test('forged public lease cannot impersonate the privately held actual owner', async () => {
      await guarded(async owner => {
        let fakeVerifications = 0;
        await withWorkspaceFileLifecycleLeases(new Map([[workspaceId, { active: true,
          verify: async () => { fakeVerifications++; return true; } }]]), async () => {
          assert.equal(await readOwner(owner, workspaceId), undefined);
        });
        assert.equal(fakeVerifications, 0); assert.equal((await readOwner(owner, workspaceId))?.snapshot?.held, true);
      });
    });
    await test('replaced genuine verifier is rejected before reading', async () => {
      await guarded(async owner => {
        const lease = getWorkspaceFileLifecycleLeases()?.get(workspaceId); assert(lease);
        const original = lease.verify; let replacements = 0;
        try {
          lease.verify = async () => { replacements++; return true; };
          assert.equal(await readOwner(owner, workspaceId), undefined); assert.equal(replacements, 0);
        } finally { lease.verify = original; }
        assert.equal((await readOwner(owner, workspaceId))?.snapshot?.held, true);
      });
    });
    await test('verifier replacement during a real reply is also rejected', async () => {
      await guarded(async owner => {
        const lease = getWorkspaceFileLifecycleLeases()?.get(workspaceId); assert(lease);
        const original = lease.verify; let observed = false;
        try {
          await h.withProbe(async event => {
            if (!snapshotSql(event.text)) return;
            assert.equal(event.result.rows[0]?.held, true); observed = true; lease.verify = async () => true;
          }, async () => assert.equal(await readOwner(owner, workspaceId), undefined));
        } finally { lease.verify = original; }
        assert(observed); assert.equal((await readOwner(owner, workspaceId))?.snapshot?.held, true);
      });
    });
    await test('actual search_path drift is freshly observed instead of hidden by a prior result', async () => {
      await guarded(async owner => {
        const first = await readOwner(owner, workspaceId); assert.equal(first?.snapshot?.schema, h.schema);
        try {
          await owner.run('SET search_path=pg_catalog');
          await assert.rejects(readOwner(owner, workspaceId), { code: '42P01' });
        } finally { await owner.run(`SET search_path="${h.schema}",pg_catalog`); }
        assert.equal((await readOwner(owner, workspaceId))?.snapshot?.schema, h.schema);
      });
    });
    await test('actual exclusive unlock invalidates a previous positive observation', async () => {
      await guarded(async owner => {
        assert.equal((await readOwner(owner, workspaceId))?.snapshot?.held, true);
        assert.equal((await owner.get('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [key]) as { unlocked: boolean }).unlocked, true);
        assert.equal((await readOwner(owner, workspaceId))?.snapshot?.held, false);
        assert.equal(getWorkspaceFileLifecycleLeases()?.get(workspaceId)?.active, false);
        await assert.rejects(readOwner(owner, workspaceId), { code: 'FILE_LIFECYCLE_SOURCE_INVALID' });
      });
    });
    await test('a real shared advisory lock cannot substitute for the exclusive owner lock', async () => {
      await guarded(async owner => {
        await owner.get('SELECT pg_advisory_unlock($1::bigint)', [key]);
        await owner.get('SELECT pg_advisory_lock_shared($1::bigint)', [key]);
        try { assert.equal((await readOwner(owner, workspaceId))?.snapshot?.held, false); }
        finally { await owner.get('SELECT pg_advisory_unlock_shared($1::bigint)', [key]); }
      });
    });
    await test('a retained async context and connection cannot read after owner closure', async () => {
      let retained: (() => ReturnType<typeof readOwner>) | undefined, closedOwner: SqlConnection | undefined;
      await guarded(async owner => {
        closedOwner = owner; retained = AsyncResource.bind(() => readOwner(owner, workspaceId));
        assert.equal((await retained())?.snapshot?.held, true);
      });
      assert(retained && closedOwner); assert.equal(await retained(), undefined);
      assert.equal(await readOwner(closedOwner, workspaceId), undefined);
    });
    await test('detached genuine reads are drained and fail before the owner session closes', async () => {
      let seen!: () => void, release!: () => void;
      const observed = new Promise<void>(resolve => { seen = resolve; });
      const barrier = new Promise<void>(resolve => { release = resolve; });
      let detached: ReturnType<typeof readOwner> | undefined, ownerRejected = false, readRejected = false;
      await h.withProbe(async event => {
        if (!snapshotSql(event.text)) return;
        assert.equal(event.result.rows[0]?.held, true); seen(); await barrier;
      }, async () => {
        const operation = guarded(async owner => {
          detached = readOwner(owner, workspaceId); void detached.catch(() => undefined);
          await observed;
          // Let the owner finish its callback while an actual reply is pending.
          setImmediate(release);
        });
        try { await operation; } catch (error) {
          assert.equal(Reflect.get(error as object, 'code'), 'FILE_LIFECYCLE_SOURCE_DETACHED'); ownerRejected = true;
        } finally { release(); }
        assert(detached);
        try { await detached; } catch (error) {
          assert.equal(Reflect.get(error as object, 'code'), 'FILE_LIFECYCLE_SOURCE_DETACHED'); readRejected = true;
        }
      });
      assert(ownerRejected && readRejected);
    });
    assert.deepEqual(await metadata(), before, 'Observations and rejected impersonations preserve native rows and xmin.');
    assert.equal(cases.length, 11);
    console.log('LIFECYCLE_OWNER_WORKSPACE_SNAPSHOT_PROOF', JSON.stringify({ cases: cases.length, realPostgres: true,
      freshStatementPerObservation: 1, nativeRowsAndXminUnchanged: true, allOwnerCallbacksClosed: true }));
  });
}
await lifecycleOwnerWorkspaceSnapshotPostgresTest();

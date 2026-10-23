import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, Pool } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import { COLLABORATION_ROOM_OWNER_UP_SQL, COLLABORATION_ROOM_RELEASE_UP_SQL } from '../app/lib/db/collaboration-room-owner-migration';
import { createCollaborationAdmissionService } from '../app/lib/collaboration/room-admission';
import { createCollaborationAdmissionQuiescenceService } from '../app/lib/collaboration/room-admission-quiescence';
import { createCollaborationAdmissionHandoffService, requireCollaborationAdmissionMutationRequest } from '../app/lib/collaboration/room-admission-handoff';
import { collaborationAdmissionActionDigest, collaborationAdmissionLockKey, type CollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { withWorkspaceFileLifecycleLeases } from '../app/lib/collaboration/file-lifecycle-admission-context';
import { createCollaborationRoomOwnerSession } from '../app/lib/collaboration/room-owner';
import { Y } from '../app/lib/collaboration/server-runtime';
import { hasCollaborationHandoffExecutionContext } from '../app/lib/collaboration/handoff-execution-context';
import { withWorkspaceMutationLock } from '../app/lib/files/workspace-mutation-lock';
import { withWorkspaceFileLifecycleGuard } from '../app/lib/files/workspace-file-lifecycle-guard';
import { withOwnedWorkspaceFileLifecycleSubwrites as owned, withOwnedLifecycleSubwriteTransactionOnConnection as subwrite,
  type OwnedLifecycleFileLockTarget } from '../app/lib/files/workspace-owned-lifecycle-subwrite';

let stage = 'private managed environment';
const code = (value: string) => (error: unknown) => (error as { code?: string })?.code === value;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function within<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Owned test exceeded its bounded deadline.')), 6000);
  })]); } finally { clearTimeout(timeout); }
}

async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  const envPath = process.env.CANVAS_OWNED_SUBWRITE_TEST_ENV_FILE; assert(envPath);
  assert.equal((await stat(envPath)).mode & 0o077, 0);
  const connectionString = parse(await readFile(envPath)).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `canvas_owned_subwrite_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^canvas_owned_subwrite_[a-f0-9]{32}$/u); assert(schema.length <= 63);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'canvas-owned-subwrite-'));
  const previousData = process.env.CANVAS_DATA_ROOT; process.env.CANVAS_DATA_ROOT = temporaryRoot;
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>(); let pool: Pool | undefined; let created = false;
  const newClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=2000 -c application_name=canvas-owned-subwrite-test` });
    client.on('error', () => undefined); clients.add(client); await client.connect(); return client;
  };
  const adapt = (client: Client): SqlConnection => ({
    get: async (sql, values) => (await client.query(sql, values)).rows[0],
    all: async (sql, values) => (await client.query(sql, values)).rows,
    run: async (sql, values) => ({ changes: (await client.query(sql, values)).rowCount ?? 0 }),
    close: async () => { await client.end(); clients.delete(client); },
  });
  const openConnection = async () => adapt(await newClient());
  try {
    await control.connect(); const server = (await control.query(`SELECT current_database() AS name,
      current_setting('server_version_num')::integer AS version,to_regclass('public.collaboration_yjs_states') IS NOT NULL AS states`)).rows[0];
    assert.equal(server.name, 'canvas_notebook'); assert.equal(Math.floor(server.version / 10000), 18); assert.equal(server.states, true);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    for (const table of ['file_locks', 'file_collaboration_lineages', 'collaboration_documents', 'collaboration_yjs_states'])
      await control.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=2000` });
    await pool.query(COLLABORATION_ROOM_OWNER_UP_SQL); await pool.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
    for (const sql of COLLABORATION_ADMISSION_STATEMENTS) await pool.query(sql);
    await pool.query('CREATE TABLE subwrite_fixture_values(lock_id text PRIMARY KEY,value text NOT NULL)');
    const actor = { userId: 'owned-fixture-owner', sessionId: 'owned-fixture-session' };
    const workspace: WorkspaceContext = { workspaceId: `owned-${randomUUID()}`, workspaceType: 'personal', organizationId: null,
      rootPath: temporaryRoot, legacy: false, status: 'active', actor: { userId: actor.userId, role: 'owner' },
      permissions: { canRead: true, canWrite: true, canDelete: true, canManageWorkspace: true, canCreatePublicLinks: true, canRunAgent: true } };
    const admission = createCollaborationAdmissionService({ openConnection });
    const seed = async (filePath: string, native = true, context = workspace): Promise<OwnedLifecycleFileLockTarget> => {
      const lineageId = `lineage-${randomUUID()}`, lockId = `lock-${randomUUID()}`, documentId = `doc-${randomUUID()}`;
      await pool!.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,$3,$4,$5,'active',100)`, [lineageId, context.workspaceId, context.workspaceType, context.organizationId, filePath]);
      await pool!.query(`INSERT INTO file_locks(id,workspace_id,workspace_type,organization_id,path,lineage_id,locked_by_user_id,
        locked_by_session_id,lock_type,status,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'upload','active',10000,100,100)`,
      [lockId, context.workspaceId, context.workspaceType, context.organizationId, filePath, lineageId, actor.userId, actor.sessionId]);
      if (native) {
        const doc = new Y.Doc(); doc.getText('content').insert(0, 'Actual persisted native body.');
        const update = Buffer.from(Y.encodeStateAsUpdate(doc)), vector = Buffer.from(Y.encodeStateVector(doc)); doc.destroy();
        await pool!.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
          state_version,yjs_state_lifecycle,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'yjs',7,'initialized','active',100,100)`,
        [documentId, lineageId, context.workspaceId, context.workspaceType, context.organizationId, filePath]);
        await pool!.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
          yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
          VALUES($1,$2,$3,$4,'plain_text',1,1,$5,$6,7,100,7,100,'fixture','fixture','lf',0,0,'active')`,
        [documentId, context.workspaceId, context.organizationId, filePath, update, vector]);
      }
      return Object.freeze({ kind: 'existing_file_lock', lockId, lineageId, workspaceId: context.workspaceId, organizationId: context.organizationId ?? null,
        path: filePath, lockedByUserId: actor.userId, lockedBySessionId: actor.sessionId, status: 'active',
        native: native ? Object.freeze({ documentId, lifecycleGeneration: 1, representation: 'plain_text', schemaVersion: 1 }) : null });
    };
    const read = async (target: OwnedLifecycleFileLockTarget) => (await pool!.query('SELECT value FROM subwrite_fixture_values WHERE lock_id=$1', [target.lockId])).rows[0]?.value;
    const write = (database: SqlConnection, target: OwnedLifecycleFileLockTarget, value: string) => subwrite(database, { target, operationId: randomUUID() }, async assertCurrent => {
      await assertCurrent();
      await database.run('INSERT INTO subwrite_fixture_values VALUES($1,$2) ON CONFLICT(lock_id) DO UPDATE SET value=excluded.value', [target.lockId, value]);
    });
    const run = <T>(target: OwnedLifecycleFileLockTarget, operation: (database: SqlConnection) => Promise<T>, factory = openConnection, context = workspace) =>
      owned({ workspace: context, actor, targets: [target] }, operation, factory);
    const request = (target: OwnedLifecycleFileLockTarget, filePath = target.path): CollaborationAdmissionRequest => {
      assert(target.native);
      const payload = JSON.stringify({ fixture: 'owned-subwrite', destination: 'after.md' });
      return { requestId: randomUUID(), actorId: actor.userId, action: 'move', actionPayloadText: payload,
        actionDigest: collaborationAdmissionActionDigest('move', payload),
        scopes: [{ workspaceId: target.workspaceId, organizationId: target.organizationId, path: filePath, kind: 'exact' }],
        expectedDocuments: filePath === target.path ? [{ ...target.native, workspaceId: target.workspaceId,
          organizationId: target.organizationId, path: target.path, status: 'active' }] : [] };
    };

    stage = 'actual unchanged guard factory, exact owner, serial RC/RW and existing nonnative lock';
    const first = await seed('first.md'), physical = await seed('office.docx', false);
    let opened = 0, closed = 0, ownerPid = 0;
    const trackedFactory = async () => {
      opened++; const client = await newClient(); ownerPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const original = adapt(client);
      return { ...original, close: async (error?: Error) => { closed++; assert.equal(closed, 1); assert(error); await original.close(error); } };
    };
    const nativeBefore = (await pool.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [first.native!.documentId])).rows[0];
    await owned({ workspace, actor, targets: [first, physical] }, async database => {
      await write(database, first, 'phase-one'); await write(database, physical, 'phase-two'); await write(database, first, 'phase-three');
      await subwrite(database, { target: physical, operationId: randomUUID() }, async assertCurrent => {
        await assertCurrent();
        const competitor = await newClient();
        try { assert.equal((await competitor.query('SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS locked',
          [workspace.workspaceId, physical.path])).rows[0].locked, false); }
        finally { await competitor.end(); clients.delete(competitor); }
        await database.run('UPDATE file_locks SET updated_at=101 WHERE id=$1', [physical.lockId]);
      });
      const probe = await newClient();
      try { assert.equal((await probe.query('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS locked',
        [collaborationAdmissionLockKey(workspace.workspaceId)])).rows[0].locked, false); }
      finally { await probe.end(); clients.delete(probe); }
      await assert.rejects(within(withWorkspaceFileLifecycleLeases(new Map(), () =>
        withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [first.path] },
          async () => assert.fail('Second guard callback ran.'), openConnection))), code('COLLABORATION_FILE_LIFECYCLE_BUSY'));
    }, trackedFactory).catch(error => { throw error; });
    assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(await read(first), 'phase-three'); assert.equal(await read(physical), 'phase-two');
    assert.equal((await pool.query('SELECT updated_at FROM file_locks WHERE id=$1', [physical.lockId])).rows[0].updated_at, '101');
    assert.deepEqual((await pool.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [first.native!.documentId])).rows[0], nativeBefore);
    assert.equal((await control.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS alive', [ownerPid])).rows[0].alive, false);
    await run(first, database => write(database, first, 'rights-remain-writer-duty'), openConnection,
      { ...workspace, permissions: { canRead: false, canWrite: false, canDelete: false, canManageWorkspace: false, canCreatePublicLinks: false, canRunAgent: false } });

    stage = 'actual active room, scope reservations and genuine SAME-workspace DA04 nesting reject';
    const roomClient = await newClient(), room = await createCollaborationRoomOwnerSession(roomClient);
    const roomScope = { ...first.native!, workspaceId: first.workspaceId, organizationId: first.organizationId, path: first.path };
    const roomFence = await room.acquire(roomScope);
    await assert.rejects(run(first, async () => assert.fail('Active room callback ran.')), code('COLLABORATION_FILE_LIFECYCLE_BUSY'));
    await room.release(roomFence, { releaseId: randomUUID(), yjsState: nativeBefore.yjs_state, stateVector: nativeBefore.state_vector });
    await room.close(); clients.delete(roomClient);
    const reserved = request(first); await admission.reserve(reserved);
    await assert.rejects(run(first, async () => assert.fail('Reserved callback ran.')), code('COLLABORATION_FILE_LIFECYCLE_BUSY'));
    await admission.cancel(reserved, 1);
    const independent = request(first); await admission.reserve(independent);
    await pool.query("UPDATE collaboration_admission_scopes SET path='independent.md' WHERE request_id=$1", [independent.requestId]);
    await assert.rejects(run(first, async () => assert.fail('Doc-ID reservation callback ran.')), code('OWNED_SUBWRITE_BUSY'));
    await pool.query('UPDATE collaboration_admission_scopes SET path=$2 WHERE request_id=$1', [independent.requestId, first.path]); await admission.cancel(independent, 1);
    const handoffRequest = request(first); await admission.reserve(handoffRequest);
    const quiescence = createCollaborationAdmissionQuiescenceService({ openConnection }); await quiescence.prove(handoffRequest, first.native!.documentId);
    const handoff = createCollaborationAdmissionHandoffService({ openConnection,
      withMutationLocks: (workspaceIds, operation) => { assert.deepEqual(workspaceIds, [workspace.workspaceId]); return withWorkspaceMutationLock(workspace.workspaceId, operation); } });
    let genuineHandoff = false;
    await assert.rejects(handoff.execute(handoffRequest, { authorize: async () => undefined, prepare: async () => undefined,
      mutate: async database => {
        assert.equal(requireCollaborationAdmissionMutationRequest(database, 'move').requestId, handoffRequest.requestId); genuineHandoff = true;
        await within(run(first, async () => assert.fail('Nested Owned callback ran.'))); return {};
      } }), code('OWNED_SUBWRITE_REENTRANT'));
    assert.equal(genuineHandoff, true); assert.equal(await handoff.readOutcome(handoffRequest), null);
    const aborted = await handoff.abort(handoffRequest, { authorize: async () => undefined, prepare: async () => undefined }, 'user_cancelled');
    assert.equal(aborted.version, 2);

    stage = 'genuine cross-workspace handoff context rejects entry before checkout, including retry and detached continuation';
    const otherWorkspace = { ...workspace, workspaceId: `other-${randomUUID()}` };
    const otherTarget = await seed('other.md', true, otherWorkspace);
    let nestedCheckouts = 0;
    const forbiddenEntry = () => run(otherTarget, async () => assert.fail('Cross-workspace callback ran.'),
      async () => { nestedCheckouts++; return openConnection(); }, otherWorkspace);
    const rejectEntry = async () => {
      assert.equal(hasCollaborationHandoffExecutionContext(), true);
      await assert.rejects(forbiddenEntry(), code('OWNED_SUBWRITE_REENTRANT'));
      assert.equal(nestedCheckouts, 0);
    };
    assert.equal(hasCollaborationHandoffExecutionContext(), false);
    const crossRequest = request(first); await admission.reserve(crossRequest);
    await quiescence.prove(crossRequest, first.native!.documentId);
    const continueDetached = deferred(); let escaped!: Promise<void>;
    const crossOutcome = await handoff.execute(crossRequest, {
      authorize: rejectEntry,
      prepare: rejectEntry,
      mutate: async database => {
        assert.equal(requireCollaborationAdmissionMutationRequest(database, 'move').requestId, crossRequest.requestId);
        await rejectEntry();
        escaped = (async () => { await continueDetached.promise; await rejectEntry(); })();
        return {};
      },
    });
    assert.equal(hasCollaborationHandoffExecutionContext(), false);
    continueDetached.resolve(); await escaped;
    assert.deepEqual(await handoff.execute(crossRequest, {
      authorize: rejectEntry,
      prepare: async () => assert.fail('Completed retry prepared twice.'),
      mutate: async () => assert.fail('Completed retry mutated twice.'),
    }), crossOutcome);
    const abortRequest = request(first); await admission.reserve(abortRequest);
    await quiescence.prove(abortRequest, first.native!.documentId);
    const abortOutcome = await handoff.abort(abortRequest, { authorize: rejectEntry, prepare: rejectEntry }, 'user_cancelled');
    assert.equal(abortOutcome.version, 2); assert.equal(nestedCheckouts, 0);
    assert.equal(hasCollaborationHandoffExecutionContext(), false);
    await run(otherTarget, database => write(database, otherTarget, 'ordinary outer entry remains available'), openConnection, otherWorkspace);
    assert.equal(await read(otherTarget), 'ordinary outer entry remains available');

    stage = 'stale scope, actual LockID/Lineage/Actor/Session/native identity and schema negatives';
    for (const target of [{ ...first, lockId: 'wrong-lock' }, { ...first, lineageId: 'wrong-lineage' },
      { ...first, path: 'wrong-path.md' }, { ...first, native: null }, { ...physical, native: first.native },
      { ...first, native: { ...first.native!, lifecycleGeneration: 2 } },
      { ...first, native: { ...first.native!, schemaVersion: 2 } },
      { ...first, native: { ...first.native!, representation: 'tiptap_xml' as const } }])
      await assert.rejects(run(target, async () => assert.fail('Stale target callback ran.')), code('OWNED_SUBWRITE_SCOPE_CHANGED'));
    for (const sql of ["UPDATE file_locks SET locked_by_user_id='other-user' WHERE id=$1", "UPDATE file_locks SET locked_by_session_id='other-session' WHERE id=$1",
      "UPDATE file_locks SET status='released' WHERE id=$1", "UPDATE file_locks SET path='changed.md' WHERE id=$1"])
      await assert.rejects(run(first, database => subwrite(database, { target: first, operationId: randomUUID() }, async assertCurrent => {
        // Real narrow SQL is checked on both sides; changing captured identity/status rolls back.
        await database.run(sql, [first.lockId]); await assertCurrent();
      })), code('OWNED_SUBWRITE_SCOPE_CHANGED'));
    assert.equal((await pool.query('SELECT status,path,locked_by_user_id,locked_by_session_id FROM file_locks WHERE id=$1', [first.lockId])).rows[0].status, 'active');
    for (const [sql, id] of [
      ['UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1', first.native!.documentId],
      ['UPDATE collaboration_yjs_states SET schema_version=2 WHERE document_id=$1', first.native!.documentId],
      ["UPDATE collaboration_yjs_states SET path='changed-native.md' WHERE document_id=$1", first.native!.documentId],
      ["UPDATE collaboration_documents SET yjs_state_lifecycle='legacy_unknown' WHERE id=$1", first.native!.documentId],
      ["UPDATE file_collaboration_lineages SET path='changed-lineage.md' WHERE id=$1", first.lineageId],
    ]) await assert.rejects(run(first, database => subwrite(database, { target: first, operationId: randomUUID() }, async () => {
      await database.run(sql, [id]);
    })), code('OWNED_SUBWRITE_SCOPE_CHANGED'));
    const organization = { ...workspace, workspaceId: `org-${randomUUID()}`, workspaceType: 'organization' as const, organizationId: 'owned-fixture-org' };
    const org = await seed('scoped.md', true, organization); await run(org, database => write(database, org, 'organization'), openConnection, organization);
    await assert.rejects(run({ ...org, organizationId: 'wrong-org' }, async () => assert.fail('Wrong org callback ran.'), openConnection,
      { ...organization, organizationId: 'wrong-org' }), code('OWNED_SUBWRITE_SCOPE_CHANGED'));

    stage = 'caught errors, wrong object/retained capability, serial phases and detached settlement';
    const poisoned = await seed('poisoned.md');
    await assert.rejects(run(poisoned, async database => {
      await subwrite(database, { target: poisoned, operationId: randomUUID() }, async () => {
        await database.run('INSERT INTO subwrite_fixture_values VALUES($1,\'partial\')', [poisoned.lockId]); throw new Error('Mutation failed after SQL.');
      }).catch(() => undefined);
    }), /Mutation failed after SQL/u); assert.equal(await read(poisoned), undefined);
    await assert.rejects(run(poisoned, async database => {
      await subwrite(database, { target: poisoned, operationId: randomUUID() }, async () => { throw undefined; }).catch(() => undefined);
    }), code('OWNED_SUBWRITE_REQUIRED'));
    await assert.rejects(run(poisoned, database => subwrite(database, { target: poisoned, operationId: randomUUID() }, async () => {
      await database.run('INSERT INTO subwrite_fixture_values VALUES($1,\'sql-partial\')', [poisoned.lockId]);
      await Promise.resolve(database.run('SELECT 1/0')).catch(() => undefined);
    })), error => (error as { code: string }).code === '22012'); assert.equal(await read(poisoned), undefined);
    for (const controlSql of ['COMMIT', 'ROLLBACK', 'BEGIN', 'SET TRANSACTION READ ONLY', 'SAVEPOINT other_phase',
      'SELECT 1; COMMIT', 'DO $$ BEGIN NULL; END $$', 'SELECT pg_advisory_unlock(0::bigint)']) {
      await assert.rejects(run(poisoned, database => subwrite(database, { target: poisoned, operationId: randomUUID() }, async () => {
        await database.run('INSERT INTO subwrite_fixture_values VALUES($1,\'control-partial\')', [poisoned.lockId]);
        await Promise.resolve(database.run(controlSql)).catch(() => undefined);
      })), code('OWNED_SUBWRITE_INVALID')); assert.equal(await read(poisoned), undefined);
    }
    await assert.rejects(run(poisoned, database => subwrite(database, { target: poisoned, operationId: randomUUID() }, async assertCurrent => {
      await database.run('INSERT INTO subwrite_fixture_values VALUES($1,\'lease-partial\')', [poisoned.lockId]);
      await withWorkspaceFileLifecycleLeases(new Map([[workspace.workspaceId, { active: true, verify: async () => true }]]),
        () => assertCurrent()).catch(() => undefined);
    })), code('OWNED_SUBWRITE_REQUIRED')); assert.equal(await read(poisoned), undefined);
    await assert.rejects(run(poisoned, async database => {
      await subwrite({ ...database }, { target: poisoned, operationId: randomUUID() }, async () => assert.fail('Wrapper cap ran.')).catch(() => undefined);
    }), code('OWNED_SUBWRITE_REQUIRED'));
    await assert.rejects(run(poisoned, async database => {
      await subwrite(database, { target: first, operationId: randomUUID() }, async () => assert.fail('Wrong scope ran.')).catch(() => undefined);
    }), code('OWNED_SUBWRITE_SCOPE_CHANGED'));
    let saved!: () => Promise<void>, savedDatabase!: SqlConnection;
    await run(poisoned, database => subwrite(database, { target: poisoned, operationId: randomUUID() }, async assertCurrent => { saved = assertCurrent; savedDatabase = database; await assertCurrent(); }));
    await assert.rejects(saved(), code('OWNED_SUBWRITE_REQUIRED'));
    await assert.rejects(write(savedDatabase, poisoned, 'retained'), code('OWNED_SUBWRITE_REQUIRED'));
    await assert.rejects(run(poisoned, async database => {
      await subwrite(database, { target: poisoned, operationId: randomUUID() }, async () => { await write(database, poisoned, 'nested').catch(() => undefined); });
    }), code('OWNED_SUBWRITE_REENTRANT'));
    await assert.rejects(run(poisoned, async () => {
      await owned({ workspace, actor, targets: [poisoned] }, async () => undefined, openConnection).catch(() => undefined);
    }), code('OWNED_SUBWRITE_REENTRANT'));
    const release = deferred(), entered = deferred(); let settled = false; let detached!: Promise<void>;
    const outer = run(poisoned, async database => {
      detached = subwrite(database, { target: poisoned, operationId: randomUUID() }, async () => { entered.resolve(); await release.promise; settled = true; });
      await entered.promise;
    });
    await within(entered.promise); setTimeout(release.resolve, 20);
    await assert.rejects(within(outer), code('OWNED_SUBWRITE_DETACHED')); await detached.catch(() => undefined); assert.equal(settled, true);
    for (const kind of ['sql', 'guard']) {
      let escaped!: Promise<unknown>, escapeSettled = false;
      await assert.rejects(run(poisoned, database => subwrite(database, { target: poisoned, operationId: randomUUID() }, async assertCurrent => {
        await database.run('INSERT INTO subwrite_fixture_values VALUES($1,\'detached-partial\')', [poisoned.lockId]);
        escaped = kind === 'sql' ? Promise.resolve(database.run('SELECT pg_sleep(0.05)')) : assertCurrent();
        void escaped.then(() => { escapeSettled = true; }, () => { escapeSettled = true; });
      })), code('OWNED_SUBWRITE_DETACHED'));
      await escaped.catch(() => undefined); assert.equal(escapeSettled, true); assert.equal(await read(poisoned), undefined);
    }
    await assert.rejects(run(poisoned, async database => {
      const results = await Promise.allSettled([write(database, poisoned, 'parallel-one'), write(database, poisoned, 'parallel-two')]);
      assert(results.every(result => result.status === 'rejected'));
    }), code('OWNED_SUBWRITE_REENTRANT')); assert.equal(await read(poisoned), undefined);

    stage = 'real pre-opened TX, backend/XID/searchpath drift and lost COMMIT disposal';
    await assert.rejects(run(poisoned, async () => assert.fail('Open TX entry ran.'), async () => {
      const client = await newClient(); await client.query('BEGIN'); return adapt(client);
    }), code('OWNED_SUBWRITE_SCOPE_CHANGED'));
    for (const begin of ['BEGIN READ ONLY', 'BEGIN ISOLATION LEVEL REPEATABLE READ', 'BEGIN ISOLATION LEVEL SERIALIZABLE'])
      await assert.rejects(run(poisoned, async () => assert.fail('Wrong TX entry ran.'), async () => {
        const client = await newClient(); await client.query(begin); return adapt(client);
      }), code('OWNED_SUBWRITE_SCOPE_CHANGED'));
    for (const drift of ['xid', 'schema', 'shadow', 'backend', 'owner-key']) {
      let client!: Client;
      await assert.rejects(run(poisoned, database => subwrite(database, { target: poisoned, operationId: randomUUID() }, async assertCurrent => {
        if (drift === 'xid') { await client.query('ROLLBACK'); await client.query('BEGIN'); }
        if (drift === 'schema') await client.query('SET LOCAL search_path=pg_catalog');
        if (drift === 'shadow') await client.query('CREATE TEMP TABLE file_locks(id text)');
        if (drift === 'backend') await client.end();
        if (drift === 'owner-key') await client.query('SELECT pg_advisory_unlock($1::bigint)', [collaborationAdmissionLockKey(workspace.workspaceId)]);
        await assertCurrent().catch(() => undefined);
      }), async () => { client = await newClient(); return adapt(client); }), error =>
        ['OWNED_SUBWRITE_SCOPE_CHANGED', 'OWNED_SUBWRITE_REQUIRED'].includes((error as { code: string }).code) || drift === 'backend');
    }
    for (const commit of ['before', 'after', 'after-close-error']) {
      const target = await seed(`commit-${commit}.md`); let closes = 0, commits = 0, pid = 0, published = false;
      await assert.rejects(run(target, async database => {
        await write(database, target, 'commit-evidence-is-not-recovery'); published = true;
      }, async () => {
        const client = await newClient(); pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const original = adapt(client);
        return { ...original, run: async (sql, values) => {
          if (sql === 'COMMIT' && ++commits === 2) {
            if (commit !== 'before') await original.run(sql, values);
            throw new Error('Injected lost COMMIT response.');
          }
          return original.run(sql, values);
        }, close: async (error?: Error) => {
          closes++; assert.equal(closes, 1); assert(error); await original.close(error);
          if (commit === 'after-close-error') throw new Error('Injected disposal response loss.');
        } };
      }), code('OWNED_SUBWRITE_COMMIT_UNCONFIRMED'));
      assert.equal(closes, 1); assert.equal(published, false);
      assert.equal(await read(target), commit === 'before' ? undefined : 'commit-evidence-is-not-recovery');
      assert.equal((await control.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS alive', [pid])).rows[0].alive, false);
    }

    stage = 'captured scope budgets, no ALS grant, true namingspaces and no directory/subtree';
    let factoryCalls = 0;
    const noFactory = async () => { factoryCalls++; return openConnection(); };
    for (const legacy of [true, undefined]) await assert.rejects(owned({ workspace: { ...workspace, legacy } as WorkspaceContext,
      actor, targets: [first] }, async () => assert.fail('Legacy/missing classification ran.'), noFactory), code('OWNED_SUBWRITE_INVALID'));
    await assert.rejects(withWorkspaceFileLifecycleLeases(new Map([[workspace.workspaceId, { active: true, verify: async () => true }]]),
      () => run(poisoned, async () => assert.fail('Forged ALS entry ran.'), noFactory)), code('OWNED_SUBWRITE_REENTRANT')); assert.equal(factoryCalls, 0);
    for (const targets of [[], Array.from({ length: 17 }, () => first), [first, first], [{ ...first, path: '' }],
      [{ ...first, path: '../escape' }], [{ ...first, workspaceId: 'wrong-workspace' }], [{ ...first, lockedByUserId: 'other-user' }],
      [{ ...first, lockedBySessionId: 'other-session' }], [first, { ...physical, path: `${first.path}/child.md` }]])
      await assert.rejects(owned({ workspace, actor, targets: targets as OwnedLifecycleFileLockTarget[] }, async () => assert.fail('Invalid scope ran.'), noFactory), code('OWNED_SUBWRITE_INVALID'));
    assert.equal(factoryCalls, 0);
    let reads = 0; const getter = { ...first }; Object.defineProperty(getter, 'path', { enumerable: true, get: () => { reads++; return first.path; } });
    await assert.rejects(run(getter, async () => assert.fail('Getter target ran.'), noFactory), code('OWNED_SUBWRITE_INVALID')); assert.equal(reads, 0);
    const spaces = await seed(' leading name / trailing.md '); await run(spaces, database => write(database, spaces, 'spaces-preserved'));
    assert.equal(await read(spaces), 'spaces-preserved'); await assert.rejects(run({ ...spaces, path: spaces.path.trim() }, async () => undefined), code('OWNED_SUBWRITE_SCOPE_CHANGED'));
    const directory = await seed('fake-directory', false); await seed('fake-directory/child.md');
    await assert.rejects(run(directory, async () => assert.fail('Descendant scope ran.')), code('OWNED_SUBWRITE_SCOPE_CHANGED'));
    console.log('Owned outer Legacyentry foundation: real PG18 owner factory, exclusive/RC identity, existing lock targets, reservations/room, genuine SAME/CROSS-workspace handoff rejection before checkout across authorize/prepare/mutate/abort/retry/detached phases, poisoning, drift and unknown-COMMIT disposal passed. No production writer activated.');
  } finally {
    for (const client of clients) await client.end().catch(() => undefined);
    await pool?.end(); if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    await control.end(); await rm(temporaryRoot, { recursive: true, force: true });
    if (previousData === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = previousData;
  }
}
main().catch(error => {
  console.error('Owned lifecycle subwrite fixture failed:', stage, (error as { name?: string })?.name,
    (error as { code?: string })?.code, error instanceof assert.AssertionError ? error.message : undefined);
  process.exitCode = 1;
});

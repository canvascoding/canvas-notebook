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
import { collaborationAdmissionActionDigest, collaborationAdmissionLockKey, type CollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { assertCollaborationRoomOwnerFence, createCollaborationRoomOwnerSession,
  type CollaborationRoomOwnerRow, type CollaborationRoomOwnerScope } from '../app/lib/collaboration/room-owner';
import { withWorkspaceFileLifecycleLeases } from '../app/lib/collaboration/file-lifecycle-admission-context';
import { Y } from '../app/lib/collaboration/server-runtime';
import { withWorkspaceSideEffectWriterFenceOnConnection as fence,
  withWorkspaceSideEffectWriterMutationOnConnection as mutate, type WorkspaceSideEffectWriterTarget } from '../app/lib/files/workspace-side-effect-writer-fence';

let stage = 'private managed environment';
const code = (expected: string) => (error: unknown) => (error as { code?: string })?.code === expected;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function within<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Owned test exceeded its bounded deadline.')), 6000);
  })]); } finally { clearTimeout(timeout); }
}

async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  const envPath = process.env.CANVAS_SIDE_EFFECT_WRITER_TEST_ENV_FILE; assert(envPath);
  assert.equal((await stat(envPath)).mode & 0o077, 0);
  const connectionString = parse(await readFile(envPath)).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `canvas_side_writer_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^canvas_side_writer_test_[a-f0-9]{32}$/u); assert(schema.length <= 63);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'canvas-side-writer-'));
  const previousData = process.env.CANVAS_DATA_ROOT; process.env.CANVAS_DATA_ROOT = temporaryRoot;
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>(); let pool: Pool | undefined; let created = false;
  const newClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=2000 -c application_name=canvas-side-writer-test` });
    clients.add(client); await client.connect(); return client;
  };
  const adapt = (client: Client): SqlConnection => ({
    get: async (sql, values) => (await client.query(sql, values)).rows[0],
    all: async (sql, values) => (await client.query(sql, values)).rows,
    run: async (sql, values) => ({ changes: (await client.query(sql, values)).rowCount ?? 0 }),
    close: async () => { await client.end(); clients.delete(client); },
  });
  const openConnection = async () => adapt(await newClient());
  const transaction = async <T>(operation: (database: SqlConnection) => Promise<T>, begin = 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE') => {
    const database = await openConnection();
    try { await database.run(begin); const result = await operation(database); await database.run('COMMIT'); return result; }
    catch (error) { try { await database.run('ROLLBACK'); } catch { /* Preserve the original guard/SQL error. */ } throw error; }
    finally { await database.close(); }
  };
  try {
    await control.connect(); const server = (await control.query(`SELECT current_database() AS name,
      current_setting('server_version_num')::integer AS version,to_regclass('public.collaboration_yjs_states') IS NOT NULL AS states`)).rows[0];
    assert.equal(server.name, 'canvas_notebook'); assert.equal(Math.floor(server.version / 10000), 18); assert.equal(server.states, true);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    for (const table of ['collaboration_documents', 'file_collaboration_lineages', 'collaboration_yjs_states'])
      await control.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=2000` });
    await pool.query(COLLABORATION_ROOM_OWNER_UP_SQL); await pool.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
    for (const sql of COLLABORATION_ADMISSION_STATEMENTS) await pool.query(sql);
    await pool.query('CREATE TABLE writer_fixture_titles(document_id text PRIMARY KEY,value text NOT NULL)');
    const workspace: WorkspaceContext = { workspaceId: `side-writer-${randomUUID()}`, workspaceType: 'personal', organizationId: null,
      rootPath: temporaryRoot, legacy: false, status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true,
        canManageWorkspace: true, canCreatePublicLinks: true, canRunAgent: true } };
    const admission = createCollaborationAdmissionService({ openConnection });
    const seed = async (filePath: string, context = workspace): Promise<WorkspaceSideEffectWriterTarget> => {
      const documentId = `doc-${randomUUID()}`, lineageId = `lineage-${randomUUID()}`;
      const doc = new Y.Doc(); doc.getText('content').insert(0, 'Existing native body.');
      const update = Buffer.from(Y.encodeStateAsUpdate(doc)), vector = Buffer.from(Y.encodeStateVector(doc)); doc.destroy();
      await pool!.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,$3,$4,$5,'active',100)`, [lineageId, context.workspaceId, context.workspaceType, context.organizationId, filePath]);
      await pool!.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
        state_version,yjs_state_lifecycle,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'yjs',7,'initialized','active',100,100)`,
      [documentId, lineageId, context.workspaceId, context.workspaceType, context.organizationId, filePath]);
      await pool!.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,$2,$3,$4,'plain_text',1,1,$5,$6,7,100,7,100,'fixture','fixture','lf',0,0,'active')`,
      [documentId, context.workspaceId, context.organizationId, filePath, update, vector]);
      return Object.freeze({ kind: 'native_file', documentId, lineageId, workspaceId: context.workspaceId, organizationId: context.organizationId ?? null,
        path: filePath, lifecycleGeneration: 1, representation: 'plain_text', schemaVersion: 1 });
    };
    const scope = (target: WorkspaceSideEffectWriterTarget): CollaborationRoomOwnerScope => ({ documentId: target.documentId,
      workspaceId: target.workspaceId, organizationId: target.organizationId, path: target.path, representation: target.representation,
      lifecycleGeneration: target.lifecycleGeneration, schemaVersion: target.schemaVersion });
    const request = (target: WorkspaceSideEffectWriterTarget, reservedPath = target.path, subtree = false): CollaborationAdmissionRequest => {
      const actionPayloadText = JSON.stringify({ fixture: 'writer-fence', destination: 'after.md' });
      return { requestId: randomUUID(), actorId: 'fixture-owner', action: 'move', actionPayloadText,
        actionDigest: collaborationAdmissionActionDigest('move', actionPayloadText),
        scopes: [{ workspaceId: target.workspaceId, organizationId: target.organizationId, path: reservedPath, kind: subtree ? 'subtree' : 'exact' }],
        expectedDocuments: reservedPath === target.path || subtree && target.path.startsWith(`${reservedPath}/`)
          ? [{ ...scope(target), status: 'active' }] : [] };
    };
    const title = async (database: SqlConnection, target: WorkspaceSideEffectWriterTarget, value: string) => mutate(database, target, async assertCurrent => {
      await assertCurrent();
      await database.run('INSERT INTO writer_fixture_titles(document_id,value) VALUES($1,$2) ON CONFLICT(document_id) DO UPDATE SET value=excluded.value', [target.documentId, value]);
    });
    const readTitle = async (target: WorkspaceSideEffectWriterTarget) => (await pool!.query('SELECT value FROM writer_fixture_titles WHERE document_id=$1', [target.documentId])).rows[0]?.value;
    const run = (target: WorkspaceSideEffectWriterTarget, operation?: (database: SqlConnection) => Promise<void>, context = workspace) => transaction(database =>
      fence(database, { workspace: context, targets: [target] }, () => operation ? operation(database) : title(database, target, 'accepted')));

    stage = 'caller-owned transaction, exact targets and content-independent live room';
    const first = await seed('first.md'), second = await seed('second.md');
    const ownerClient = await newClient(); const owner = await createCollaborationRoomOwnerSession(ownerClient);
    const ownerFence = await owner.acquire(scope(first));
    await transaction(database => fence(database, { workspace, targets: [first, second] }, async () => {
      await title(database, first, 'room-compatible');
      // A real owner may persist content without changing stable identity or being blocked by a Yjs row lock.
      await within((async () => {
        owner.assertActive(ownerFence); await ownerClient.query('BEGIN');
        const row = (await ownerClient.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1 FOR UPDATE', [first.documentId])).rows[0];
        await assertCollaborationRoomOwnerFence(adapt(ownerClient), row as CollaborationRoomOwnerRow, ownerFence);
        const current = new Y.Doc();
        try {
          Y.applyUpdate(current, row.yjs_state); current.getText('content').insert(current.getText('content').length, '\nRoom mutation.');
          await ownerClient.query(`UPDATE collaboration_yjs_states SET yjs_state=$2,state_vector=$3,
            document_sequence=document_sequence+1,persisted_at=101 WHERE document_id=$1`,
          [first.documentId, Buffer.from(Y.encodeStateAsUpdate(current)), Buffer.from(Y.encodeStateVector(current))]);
          await ownerClient.query('UPDATE collaboration_documents SET state_version=state_version+1 WHERE id=$1', [first.documentId]);
          await ownerClient.query('COMMIT');
        } finally { current.destroy(); }
      })());
      await title(database, second, 'second-target');
    }));
    assert.equal(await readTitle(first), 'room-compatible'); assert.equal(await readTitle(second), 'second-target');
    assert.equal((await pool.query('SELECT document_sequence,room_owner_token FROM collaboration_yjs_states WHERE document_id=$1', [first.documentId])).rows[0].document_sequence, '8');
    const roomContent = new Y.Doc();
    try {
      Y.applyUpdate(roomContent, (await pool.query('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1', [first.documentId])).rows[0].yjs_state);
      assert.equal(roomContent.getText('content').toString(), 'Existing native body.\nRoom mutation.');
    } finally { roomContent.destroy(); }
    await owner.close(); clients.delete(ownerClient);
    await run(second, undefined, { ...workspace, permissions: { ...workspace.permissions, canWrite: false, canDelete: false } });

    stage = 'actual shared/exclusive admission lock serialization';
    const serial = await seed('serialization.md'), entered = deferred(), release = deferred();
    const held = transaction(database => fence(database, { workspace, targets: [serial] }, async () => {
      entered.resolve(); await release.promise; await title(database, serial, 'serialized');
    }));
    await within(entered.promise);
    const exclusive = await newClient();
    await exclusive.query('BEGIN');
    assert.equal((await exclusive.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked', [collaborationAdmissionLockKey(workspace.workspaceId)])).rows[0].locked, false);
    await exclusive.query('ROLLBACK');
    const reserved = request(serial);
    await assert.rejects(admission.reserve(reserved), code('ADMISSION_CONFLICT'));
    const otherWorkspace = { ...workspace, workspaceId: `other-${randomUUID()}` }, otherTarget = await seed('other.md', otherWorkspace);
    await run(otherTarget, undefined, otherWorkspace);
    release.resolve(); await within(held);
    await exclusive.query('BEGIN');
    assert.equal((await exclusive.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked', [collaborationAdmissionLockKey(workspace.workspaceId)])).rows[0].locked, true);
    await assert.rejects(within(run(serial)), code('SIDE_EFFECT_WRITER_BUSY'));
    await exclusive.query('ROLLBACK'); await exclusive.end(); clients.delete(exclusive);
    assert.equal(await readTitle(serial), 'serialized');

    stage = 'committed exact/subtree/document reservations with fresh READ COMMITTED checks';
    await admission.reserve(reserved);
    await assert.rejects(run(serial), code('SIDE_EFFECT_WRITER_BUSY'));
    await run(second); // Unrelated path in the same workspace remains open.
    await admission.cancel(reserved, 1); await run(serial);
    const nested = await seed('folder/nested.md'), subtree = request(nested, 'folder', true);
    await admission.reserve(subtree); await assert.rejects(run(nested), code('SIDE_EFFECT_WRITER_BUSY')); await admission.cancel(subtree, 1);
    const docOnly = request(nested); await admission.reserve(docOnly);
    // Deliberately inconsistent scope fixture isolates the helper's document-target gate.
    await pool.query('UPDATE collaboration_admission_scopes SET path=\'unrelated.md\' WHERE request_id=$1', [docOnly.requestId]);
    await assert.rejects(run(nested), code('SIDE_EFFECT_WRITER_BUSY')); await admission.cancel(docOnly, 1);
    // A deliberately noncooperating fixture proves the guard does not retain an old admission snapshot.
    await assert.rejects(run(nested, async database => {
      const late = request(nested);
      await pool!.query(`INSERT INTO collaboration_admission_requests(request_id,request_digest,intent_text,status,revision,created_at)
        VALUES($1,'fixture','fixture','reserved',1,100)`, [late.requestId]);
      await pool!.query(`INSERT INTO collaboration_admission_scopes(request_id,ordinal,workspace_id,organization_id,path,kind)
        VALUES($1,0,$2,NULL,$3,'exact')`, [late.requestId, workspace.workspaceId, nested.path]);
      await title(database, nested, 'must-not-write');
    }), code('SIDE_EFFECT_WRITER_BUSY'));
    assert.equal(await readTitle(nested), undefined);

    stage = 'stable native identity, no physical or synthetic fallback';
    for (const patch of [{ documentId: 'unknown' }, { lineageId: 'unknown' }, { path: 'missing.md' }, { lifecycleGeneration: 2 },
      { representation: 'tiptap_xml' as const }, { schemaVersion: 2 }]) await assert.rejects(run({ ...second, ...patch }), code('SIDE_EFFECT_WRITER_SCOPE_CHANGED'));
    for (const sql of ['UPDATE collaboration_documents SET yjs_state_lifecycle=\'legacy_unknown\' WHERE id=$1',
      'UPDATE file_collaboration_lineages SET path=\'drift.md\' WHERE id=$1',
      'UPDATE collaboration_yjs_states SET organization_id=\'another-org\' WHERE document_id=$1',
      'DELETE FROM collaboration_yjs_states WHERE document_id=$1']) await assert.rejects(transaction(async database => {
      await database.run(sql, [sql.includes('file_collaboration_lineages') ? second.lineageId : second.documentId]);
      await fence(database, { workspace, targets: [second] }, () => title(database, second, 'must-not-write'));
    }), code('SIDE_EFFECT_WRITER_SCOPE_CHANGED'));
    await assert.rejects(run(second, async database => {
      await database.run('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1', [second.documentId]);
      await title(database, second, 'must-not-write');
    }), code('SIDE_EFFECT_WRITER_SCOPE_CHANGED'));
    assert.equal(await readTitle(second), 'accepted');
    const organization = { ...workspace, workspaceId: `org-${randomUUID()}`, workspaceType: 'organization' as const, organizationId: 'fixture-org' };
    const orgTarget = await seed('scoped.md', organization); await run(orgTarget, undefined, organization);
    await assert.rejects(run({ ...orgTarget, organizationId: 'other-org' }, undefined, { ...organization, organizationId: 'other-org' }), code('SIDE_EFFECT_WRITER_SCOPE_CHANGED'));

    stage = 'caller transaction boundaries, wrong Connection/backend/XID and schema';
    const outside = await openConnection();
    await assert.rejects(fence(outside, { workspace, targets: [second] }, async () => assert.fail('Autocommit callback ran.')), code('SIDE_EFFECT_WRITER_SCOPE_CHANGED'));
    await outside.close();
    for (const begin of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE', 'BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE', 'BEGIN READ ONLY'])
      await assert.rejects(transaction(database => fence(database, { workspace, targets: [second] }, async () => assert.fail('Wrong TX callback ran.')), begin),
        code('SIDE_EFFECT_WRITER_SCOPE_CHANGED'));
    await assert.rejects(run(second, async database => {
      await mutate({ ...database }, second, async () => assert.fail('Wrapper callback ran.'));
    }), code('SIDE_EFFECT_WRITER_REQUIRED'));
    const xidTarget = await seed('xid.md');
    await assert.rejects(run(xidTarget, database => mutate(database, xidTarget, async assertCurrent => {
      await database.run('ROLLBACK'); await database.run('BEGIN');
      await assertCurrent(); await database.run('INSERT INTO writer_fixture_titles VALUES($1,\'wrong-xid\')', [xidTarget.documentId]);
    })), code('SIDE_EFFECT_WRITER_SCOPE_CHANGED'));
    assert.equal(await readTitle(xidTarget), undefined);
    await assert.rejects(run(second, async database => {
      const replacement = await openConnection(); await replacement.run('BEGIN');
      const original = { ...database };
      try {
        database.get = replacement.get; database.all = replacement.all;
        await title(database, second, 'wrong-backend');
      } finally { database.get = original.get; database.all = original.all; await replacement.run('ROLLBACK'); await replacement.close(); }
    }), code('SIDE_EFFECT_WRITER_SCOPE_CHANGED'));
    await assert.rejects(run(second, async database => {
      await database.run('CREATE TEMP TABLE collaboration_admission_targets(document_id text,active boolean)');
      await title(database, second, 'shadowed-table');
    }), code('SIDE_EFFECT_WRITER_SCOPE_CHANGED'));
    await assert.rejects(run(second, async database => {
      await database.run('SET LOCAL search_path=pg_catalog'); await title(database, second, 'wrong-schema');
    }), code('SIDE_EFFECT_WRITER_SCOPE_CHANGED'));

    stage = 'same-session exact bigint tag and owned exclusive rejection without waiting';
    const unsigned = BigInt.asUintN(64, BigInt(collaborationAdmissionLockKey(workspace.workspaceId)));
    for (const mode of ['pg_advisory_xact_lock', 'pg_advisory_xact_lock_shared', 'pg_advisory_lock', 'pg_advisory_lock_shared'])
      await assert.rejects(transaction(async database => {
        await database.run(`SELECT ${mode}($1::bigint)`, [collaborationAdmissionLockKey(workspace.workspaceId)]);
        await within(fence(database, { workspace, targets: [second] }, async () => assert.fail('Preheld key callback ran.')));
      }), code('SIDE_EFFECT_WRITER_REENTRANT'));
    // The two-int lock tag has objsubid=2 and is genuinely a distinct PG key.
    await transaction(async database => {
      await database.run('SELECT pg_advisory_xact_lock($1::integer,$2::integer)',
        [Number(BigInt.asIntN(32, unsigned >> BigInt(32))), Number(BigInt.asIntN(32, unsigned & BigInt(0xffffffff)))]);
      await fence(database, { workspace, targets: [second] }, () => title(database, second, 'distinct-tag'));
    });
    await assert.rejects(transaction(database => withWorkspaceFileLifecycleLeases(new Map([[workspace.workspaceId,
      { active: true, verify: async () => true }]]), () => within(fence(database, { workspace, targets: [second] }, async () => assert.fail('ALS became a grant.'))))),
    code('SIDE_EFFECT_WRITER_REENTRANT'));
    const dedicated = await newClient(); await dedicated.query('SELECT pg_advisory_lock($1::bigint)', [collaborationAdmissionLockKey(workspace.workspaceId)]);
    await assert.rejects(within(run(second)), code('SIDE_EFFECT_WRITER_BUSY')); await dedicated.end(); clients.delete(dedicated);

    stage = 'failure poisoning, settled detached work, invalidated callbacks and reentrancy';
    const poisoned = await seed('poisoned.md');
    await assert.rejects(run(poisoned, async database => {
      await mutate(database, poisoned, async assertCurrent => {
        await assertCurrent(); await database.run('INSERT INTO writer_fixture_titles VALUES($1,\'partial\')', [poisoned.documentId]);
        throw new Error('Owned mutation failed after SQL.');
      }).catch(() => undefined);
    }), /Owned mutation failed after SQL/u);
    assert.equal(await readTitle(poisoned), undefined);
    await assert.rejects(run(poisoned, async database => { await mutate(database, poisoned, async () => { throw undefined; }).catch(() => undefined); }),
      code('SIDE_EFFECT_WRITER_REQUIRED'));
    await assert.rejects(run(poisoned, database => mutate(database, poisoned, async assertCurrent => {
      await database.run('CREATE TEMP TABLE collaboration_admission_targets(document_id text,active boolean)');
      await assertCurrent().catch(() => undefined);
      await database.run('DROP TABLE pg_temp.collaboration_admission_targets');
      // Restoring the schema cannot revive a capability after a caught guard error.
    })), code('SIDE_EFFECT_WRITER_SCOPE_CHANGED'));
    let saved: (() => Promise<void>) | undefined;
    await run(poisoned, database => mutate(database, poisoned, async assertCurrent => { saved = assertCurrent; await assertCurrent(); }));
    await assert.rejects(saved!(), code('SIDE_EFFECT_WRITER_REQUIRED'));
    const finishDetached = deferred(), detachedEntered = deferred(); let detachedFinished = false; let detached!: Promise<void>;
    const detachedFence = run(poisoned, async database => {
      detached = mutate(database, poisoned, async () => {
        detachedEntered.resolve(); await finishDetached.promise; detachedFinished = true;
      });
      await detachedEntered.promise;
    });
    await within(detachedEntered.promise); setTimeout(finishDetached.resolve, 20);
    await assert.rejects(within(detachedFence), code('SIDE_EFFECT_WRITER_DETACHED'));
    await detached.catch(() => undefined); assert.equal(detachedFinished, true);
    await assert.rejects(run(poisoned, async database => {
      await fence(database, { workspace, targets: [poisoned] }, async () => undefined).catch(() => undefined);
    }), code('SIDE_EFFECT_WRITER_REENTRANT'));
    await assert.rejects(run(poisoned, database => mutate(database, poisoned, async () => {
      await mutate(database, poisoned, async () => undefined).catch(() => undefined);
    })), code('SIDE_EFFECT_WRITER_REENTRANT'));
    await transaction(async database => {
      const one = fence(database, { workspace, targets: [poisoned] }, async () => assert.fail('Concurrent entry ran.'));
      const two = fence(database, { workspace, targets: [poisoned] }, async () => assert.fail('Concurrent entry ran.'));
      const results = await Promise.allSettled([one, two]);
      assert(results.every(result => result.status === 'rejected'));
    });
    await transaction(async database => {
      await fence(database, { workspace, targets: [poisoned] }, async () => undefined);
      await assert.rejects(mutate(database, poisoned, async () => assert.fail('Expired cap ran.')), code('SIDE_EFFECT_WRITER_REQUIRED'));
      await assert.rejects(fence(database, { workspace, targets: [poisoned] }, async () => undefined), code('SIDE_EFFECT_WRITER_REENTRANT'));
    });

    stage = 'scope budgets and descriptor capture before reads';
    for (const targets of [[], Array.from({ length: 17 }, () => second), [second, second], [second, { ...first, path: `${second.path}/child.md` }],
      [{ ...second, kind: 'physical_file' }], [{ ...second, path: '../escape.md' }], [{ ...second, workspaceId: 'wrong' }]])
      await assert.rejects(transaction(database => fence(database, { workspace, targets: targets as WorkspaceSideEffectWriterTarget[] }, async () => assert.fail('Invalid input callback ran.'))),
        code('SIDE_EFFECT_WRITER_INVALID'));
    let reads = 0;
    const getter = { ...second }; Object.defineProperty(getter, 'path', { enumerable: true, get: () => { reads++; return second.path; } });
    await assert.rejects(run(getter), code('SIDE_EFFECT_WRITER_INVALID')); assert.equal(reads, 0);
    const mutable = { ...second };
    await transaction(database => fence(database, { workspace, targets: [mutable] }, async () => {
      mutable.documentId = 'changed-after-capture'; await title(database, second, 'captured-original');
    }));
    assert.equal(await readTitle(second), 'captured-original');
    const spaces = await seed(' leading name / trailing.md ');
    await run(spaces); assert.equal(await readTitle(spaces), 'accepted');
    const spacedReservation = request(spaces); await admission.reserve(spacedReservation);
    await assert.rejects(run(spaces), code('SIDE_EFFECT_WRITER_BUSY')); await admission.cancel(spacedReservation, 1);
    await assert.rejects(run({ ...spaces, path: spaces.path.trim() }), code('SIDE_EFFECT_WRITER_SCOPE_CHANGED'));
    console.log('Workspace side-effect shared writer fence: real PG18 transaction/identity, lock serialization, reservations, room-compatible metadata, poisoning and scope regressions passed. No production writer activated.');
  } finally {
    for (const client of clients) await client.end().catch(() => undefined);
    await pool?.end();
    if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    await control.end(); await rm(temporaryRoot, { recursive: true, force: true });
    if (previousData === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = previousData;
  }
}
main().catch(error => {
  console.error('Owned shared writer fence fixture failed:', stage, (error as { name?: string }).name,
    (error as { code?: string }).code, error instanceof assert.AssertionError ? error.message : undefined);
  process.exitCode = 1;
});

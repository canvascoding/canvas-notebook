import assert from 'node:assert/strict';
import { Client } from 'pg';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

await withNativeCopyMetadataOwnerFixture(async h => {
  const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
  const { createCollaborationRoomOwnerOptions } = await import('../app/lib/collaboration/room-owner-options');
  const { openDb } = await import('../app/lib/db');
  const timeouts = async () => {
    const connection = await openDb();
    try { return [await connection.get('SHOW statement_timeout'), await connection.get('SHOW lock_timeout')]; }
    finally { await connection.close(); }
  };
  const initialTimeouts = await timeouts();
  const native = await h.upload('poll.md', Buffer.from('# Preserved poll source\n'));
  const before = (await h.admin.query('SELECT row_to_json(s) AS value,xmin::text FROM collaboration_yjs_states s WHERE document_id=$1',
    [native.documentId])).rows[0];
  const client = new Client({ connectionString: process.env.DATABASE_URL,
    options: process.env.PGOPTIONS, application_name: `${h.applicationName}-poll-owner`, connectionTimeoutMillis: 5000 });
  await client.connect();
  const owner = await createCollaborationRoomOwnerSession(client);
  try {
    const fence = await owner.acquire({ documentId: native.documentId, workspaceId: h.source.workspaceId,
      organizationId: h.source.organizationId ?? null, path: 'poll.md', representation: before.value.representation,
      lifecycleGeneration: native.lifecycleGeneration, schemaVersion: Number(before.value.schema_version) });
    const poll = createCollaborationRoomOwnerOptions().admission.pendingDrains;
    const clients = new Set<object>(), queries: string[] = [];
    await h.withProbe(async event => { clients.add(event.client); queries.push(event.text); }, async () => {
      assert.deepEqual(await poll([fence]), []);
    });
    console.log(JSON.stringify({ phase: 'empty-drain-poll', clients: clients.size, statements: queries.length }));
    assert.equal(clients.size, 1, 'A no-op poll must not discard a separate readiness-probe backend.');
    assert.equal(queries.length, 5, 'BEGIN, two local bounds, one readiness/drain observation and COMMIT.');
    assert.equal(queries.filter(sql => /collaboration_room_release_receipts/u.test(sql)).length, 1);
    let emptyQueries = 0;
    await h.withProbe(async () => { emptyQueries++; }, async () => { assert.deepEqual(await poll([]), []); });
    assert.equal(emptyQueries, 0, 'No room selectors require no database work.');

    for (const table of ['collaboration_admission_requests', 'collaboration_admission_targets', 'collaboration_room_release_receipts']) {
      // These are empty, owned fixture tables. Always restore their names.
      await h.admin.query(`ALTER TABLE "${h.schema}"."${table}" RENAME TO "${table}_absent"`);
      try { await assert.rejects(poll([fence]), { code: '42P01' }, `${table} remains mandatory even without pending drains`); }
      finally { await h.admin.query(`ALTER TABLE "${h.schema}"."${table}_absent" RENAME TO "${table}"`); }
    }
    await h.admin.query('BEGIN');
    try {
      await h.admin.query('LOCK TABLE collaboration_room_release_receipts IN ACCESS EXCLUSIVE MODE');
      const started = performance.now();
      await assert.rejects(poll([fence]), { code: '57014' }, 'The readiness relation must still be checked under a bounded wait.');
      assert(performance.now() - started < 6000, 'A schema lock must not stall the poll indefinitely.');
    } finally { await h.admin.query('ROLLBACK'); }
    assert.deepEqual(await poll([fence]), [], 'A bounded failed poll must release its transaction and permit the next observation.');
    assert.deepEqual(await timeouts(), initialTimeouts, 'Local poll bounds must not leak into the next pooled transaction.');
    await owner.release(fence);
    const after = (await h.admin.query('SELECT row_to_json(s) AS value FROM collaboration_yjs_states s WHERE document_id=$1',
      [native.documentId])).rows[0].value;
    // Acquiring/releasing the real owner intentionally changes only owner metadata.
    for (const field of ['room_owner_epoch', 'room_owner_token', 'room_owner_backend_pid', 'room_owner_backend_start']) {
      delete after[field]; delete before.value[field];
    }
    assert.deepEqual(after, before.value, 'Polling must not alter source bytes, versions, projections or quarantine state.');
    console.log(JSON.stringify({ suite: 'collaboration-drain-poll-postgres', passed: true, groups: 7,
      emptyPollStatements: queries.length, emptyPollClients: clients.size, missingTablesFailClosed: 3,
      actualSchemaLockTimeout: true, pooledTimeoutsPreserved: true, protectedNativeStatePreserved: true, compiledBrowser: false }));
  } finally { await owner.close(); }
});

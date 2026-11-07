import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

await withNativeCopyMetadataOwnerFixture(async h => {
  const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
  const { createCollaborationRoomOwnerOptions } = await import('../app/lib/collaboration/room-owner-options');
  const { createCollaborationRoomAdmissionWorker } = await import('../app/lib/collaboration/room-admission-worker');
  const { createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
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
    const state = (await h.admin.query('SELECT yjs_state,state_vector FROM collaboration_yjs_states WHERE document_id=$1',
      [native.documentId])).rows[0];
    assert(Buffer.isBuffer(state.yjs_state) && Buffer.isBuffer(state.state_vector));
    let owned = true;
    const emptyPolls: number[] = [], workerErrors: unknown[] = [];
    const worker = createCollaborationRoomAdmissionWorker({
      pollMs: createCollaborationRoomOwnerOptions().admission.pollMs,
      getOwnedFences: () => owned ? [fence] : [],
      pendingDrains: async fences => {
        const tickets = await poll(fences);
        if (!tickets.length) emptyPolls.push(performance.now());
        return tickets;
      },
      drain: async ticket => {
        await owner.release(fence, { releaseId: ticket.releaseId, admission: ticket,
          yjsState: state.yjs_state, stateVector: state.state_vector });
        owned = false;
      },
      onError: error => { workerErrors.push(error); },
    });
    const waitFor = async (probe: () => boolean) => {
      const deadline = performance.now() + 5000;
      while (!probe()) {
        assert(performance.now() < deadline, 'The real durable worker must make bounded progress.');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    let observedWithoutWake = false;
    try {
      await waitFor(() => emptyPolls.length >= 3);
      assert(emptyPolls[1] - emptyPolls[0] >= 450 && emptyPolls[2] - emptyPolls[1] >= 900,
        'Successful empty PostgreSQL observations must reach the bounded idle cadence.');
      const admission = createCollaborationAdmissionService({ openConnection: openDb });
      const request = { requestId: randomUUID(), actorId: 'member', action: 'move' as const,
        actionDigest: 'a'.repeat(64), scopes: [{ workspaceId: fence.scope.workspaceId,
          organizationId: fence.scope.organizationId, path: fence.scope.path, kind: 'exact' as const }],
        expectedDocuments: [{ ...fence.scope, status: 'active' as const }] };
      await admission.reserve(request);
      const ticket = await admission.startDrain(request, native.documentId);
      // Deliberately send no wake. Read the real durable queue and release the
      // genuine owner with its exact native state and atomic receipt/ack.
      await waitFor(() => !owned);
      assert.deepEqual(await admission.readDrain(ticket), { ticket, status: 'released' });
      assert.deepEqual(workerErrors, []);
      observedWithoutWake = true;
    } finally { worker.dispose(); }
    const after = (await h.admin.query('SELECT row_to_json(s) AS value FROM collaboration_yjs_states s WHERE document_id=$1',
      [native.documentId])).rows[0].value;
    // Acquiring/releasing the real owner intentionally changes only owner metadata.
    for (const field of ['room_owner_epoch', 'room_owner_token', 'room_owner_backend_pid', 'room_owner_backend_start']) {
      delete after[field]; delete before.value[field];
    }
    assert.deepEqual(after, before.value, 'Polling must not alter source bytes, versions, projections or quarantine state.');
    console.log(JSON.stringify({ suite: 'collaboration-drain-poll-postgres', passed: true, groups: 8,
      emptyPollStatements: queries.length, emptyPollClients: clients.size, missingTablesFailClosed: 3,
      actualSchemaLockTimeout: true, pooledTimeoutsPreserved: true, protectedNativeStatePreserved: true,
      idleBackoffObservedWithRealPostgres: true, durableDrainWithoutWake: observedWithoutWake, compiledBrowser: false }));
  } finally { await owner.close(); }
});

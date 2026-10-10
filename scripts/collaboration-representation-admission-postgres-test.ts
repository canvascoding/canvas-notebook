import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, Pool } from 'pg';

import { closeDatabaseConnections, type SqlConnection } from '../app/lib/db';
import { withWorkspaceMutationLock } from '../app/lib/files/workspace-mutation-lock';
import { assertWorkspaceFileLifecycleSqlAvailable, withWorkspaceFileLifecycleGuard } from '../app/lib/files/workspace-file-lifecycle-guard';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import { COLLABORATION_ROOM_OWNER_UP_SQL, COLLABORATION_ROOM_RELEASE_UP_SQL } from '../app/lib/db/collaboration-room-owner-migration';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createPlainTextYDoc, richMarkdownFromYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { changeCollaborationRepresentationInAdmissionHandoff, type PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { createRepresentationAdmissionRequest } from '../app/lib/collaboration/representation-admission-contract';
import { createRepresentationMigrationCoordinator } from '../app/lib/collaboration/representation-migration';
import { readRepresentationDrainRequest, refuseRepresentationAdmissionDrain } from '../app/lib/collaboration/representation-drain-refusal';
import type { RichMigrationRequest } from '../app/lib/collaboration/representation-migration-contract';
import { collaborationUpdateStateProof } from '../app/lib/collaboration/state-proof';
import { CollaborationAdmissionError, type CollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { createCollaborationAdmissionService } from '../app/lib/collaboration/room-admission';
import { createCollaborationRoomAdmissionWorker } from '../app/lib/collaboration/room-admission-worker';
import { createCollaborationRoomOwnerSession, type CollaborationRoomOwnerFence } from '../app/lib/collaboration/room-owner';

const schemaPattern = /^canvas_representation_test_[a-f0-9]{32}$/u;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function guardedUrl(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  let url: URL;
  try { url = new URL(process.env.DATABASE_URL); }
  catch { throw new Error('Invalid managed PostgreSQL test configuration.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)
    || url.port !== '55433' || url.pathname !== '/canvas_notebook') throw new Error('Only managed loopback PostgreSQL at 55433/canvas_notebook is accepted.');
  return url;
}

async function run(url: URL) {
  const schema = `canvas_representation_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, schemaPattern);
  const namespace = `"${schema}"`;
  const configuration = { connectionString: url.toString(), connectionTimeoutMillis: 3_000,
    options: '-c statement_timeout=10000 -c lock_timeout=5000' };
  const control = new Client({ ...configuration, application_name: 'canvas-representation-test-control' });
  await control.connect();
  let pool: Pool | null = null;
  const owners: Array<Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>> = [];
  const documents: Array<InstanceType<typeof Y.Doc>> = [];
  const workers: Array<ReturnType<typeof createCollaborationRoomAdmissionWorker>> = [];
  const temporaryData = await mkdtemp(path.join(tmpdir(), 'canvas-representation-locks-'));
  const previousData = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = temporaryData;
  try {
    const version = await control.query<{ database: string; version: string }>(
      "SELECT current_database() AS database,current_setting('server_version_num') AS version");
    assert.equal(version.rows[0]!.database, 'canvas_notebook');
    assert.equal(Math.floor(Number(version.rows[0]!.version) / 10_000), 18);
    await control.query(`CREATE SCHEMA ${namespace}`);
    for (const table of ['collaboration_yjs_states', 'collaboration_yjs_state_backups', 'collaboration_agent_operations', 'collaboration_file_projections']) {
      await control.query(`CREATE TABLE ${namespace}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    const migration = new Client({ ...configuration, options: `${configuration.options} -c search_path=${schema}` });
    await migration.connect();
    try {
      await migration.query(COLLABORATION_ROOM_OWNER_UP_SQL);
      await migration.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
      for (const statement of COLLABORATION_ADMISSION_STATEMENTS) await migration.query(statement);
    } finally { await migration.end(); }
    pool = new Pool({ ...configuration, options: `${configuration.options} -c search_path=${schema}`, max: 8 });
    const openConnection = async (): Promise<SqlConnection> => {
      const client = await pool!.connect();
      let closed = false;
      return {
        get: async (sql, params) => (await client.query(sql, params)).rows[0],
        all: async (sql, params) => (await client.query(sql, params)).rows,
        run: async (sql, params) => ({ changes: (await client.query(sql, params)).rowCount ?? 0 }),
        close: async error => { assert.equal(closed, false); closed = true; client.release(error); },
      };
    };
    const stateTable = `${namespace}.collaboration_yjs_states`;
    const projectionTable = `${namespace}.collaboration_file_projections`;
    const backupTable = `${namespace}.collaboration_yjs_state_backups`;
    const workspaceId = `representation-workspace-${randomUUID()}`;
    const content = '---\ntitle: Canvas Studios\naliases:\n  - Canvas\ntags:\n  - status/archived\n---\n\n# Canvas Studios\n\nFirst **bold** paragraph.\n\nSecond paragraph.\n';
    const seed = async (label: string, markdown = content) => {
      const documentId = `representation-${label}-${randomUUID()}`;
      const document = createPlainTextYDoc(markdown);
      documents.push(document);
      const hash = sha256(markdown), now = Date.now();
      await control.query(`INSERT INTO ${stateTable} (document_id,workspace_id,organization_id,path,representation,
        lifecycle_generation,schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpointed_at,
        checkpoint_sequence,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES ($1,$2,NULL,$3,'plain_text',1,1,$4,$5,1,$6,$6,1,$7,$7,'lf',0,0,'active')`,
      [documentId, workspaceId, `${documentId}.md`, Buffer.from(Y.encodeStateAsUpdate(document)), Buffer.from(Y.encodeStateVector(document)), now, hash]);
      await control.query(`INSERT INTO ${projectionTable} (document_id,lifecycle_generation,projected_sequence,
        revision_id,canonical_hash,serialized_hash,finalized,updated_at) VALUES ($1,1,1,$2,$3,$3,1,$4)`,
      [documentId, `revision-${documentId}`, hash, now]);
      return { documentId, document };
    };
    const readState = async (documentId: string): Promise<PersistedCollaborationState> => {
      const row = (await control.query(`SELECT * FROM ${stateTable} WHERE document_id=$1`, [documentId])).rows[0];
      assert.ok(row);
      return { documentId: row.document_id, workspaceId: row.workspace_id, organizationId: row.organization_id,
        path: row.path, representation: row.representation, lifecycleGeneration: Number(row.lifecycle_generation), schemaVersion: Number(row.schema_version),
        yjsState: row.yjs_state, stateVector: row.state_vector, documentSequence: Number(row.document_sequence),
        persistedAt: Number(row.persisted_at), checkpointedAt: Number(row.checkpointed_at), checkpointSequence: Number(row.checkpoint_sequence),
        canonicalHash: row.canonical_hash, serializedHash: row.serialized_hash, newlineStyle: row.newline_style,
        hasBom: row.has_bom === 1, degraded: row.degraded === 1, status: row.status };
    };
    const requestFor = async (documentId: string) => {
      const state = await readState(documentId), proof = collaborationUpdateStateProof(state.yjsState, Y);
      assert.ok(proof);
      return createRepresentationAdmissionRequest(state, 'representation-actor', { requestId: randomUUID(),
        expectedDocumentId: state.documentId, expectedLifecycleGeneration: state.lifecycleGeneration,
        documentSequence: state.documentSequence, stateProof: proof });
    };
    const countBackups = async (documentId: string) => Number((await control.query(
      `SELECT COUNT(*) AS count FROM ${backupTable} WHERE document_id=$1`, [documentId])).rows[0]!.count);
    const authorization = { authorize: async (request: CollaborationAdmissionRequest) => {
      assert.equal(request.actorId, 'representation-actor');
      assert.equal(request.scopes[0]!.workspaceId, workspaceId);
    } };
    const coordinator = createRepresentationMigrationCoordinator({ openConnection,
      withMutationLocks: async (ids, operation) => {
        assert.deepEqual(ids, [workspaceId]);
        return withWorkspaceMutationLock(workspaceId, operation);
      } });
    const admission = createCollaborationAdmissionService({ openConnection });
    const ownerFor = async (documentId: string) => {
      const state = await readState(documentId);
      const client = new Client({ ...configuration, options: `${configuration.options} -c search_path=${schema}` });
      await client.connect();
      const owner = await createCollaborationRoomOwnerSession(client);
      owners.push(owner);
      const fence = await owner.acquire({ documentId, workspaceId, organizationId: null, path: state.path,
        representation: state.representation, lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion });
      return { owner, fence };
    };
    const snapshotFor = async (documentId: string) => {
      const state = await readState(documentId);
      return { releaseId: randomUUID(), yjsState: state.yjsState, stateVector: state.stateVector };
    };

    const raw = await openConnection();
    await assert.rejects(changeCollaborationRepresentationInAdmissionHandoff(raw),
      error => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_RECOVERY_REQUIRED');
    await raw.close(new Error('Discarding direct unauthorized handoff probe.'));

    const cancelOnly = await seed('cancel-before-first-request');
    const cancelOnlyRequest = await requestFor(cancelOnly.documentId);
    assert.deepEqual(await coordinator.advance(cancelOnlyRequest, authorization, true), { status: 'completed', aborted: true });
    assert.equal((await admission.read(cancelOnlyRequest))!.status, 'cancelled');
    assert.deepEqual(await coordinator.advance(cancelOnlyRequest, authorization), { status: 'completed', aborted: true },
      'A delayed same-ID first request must replay the durable cancellation tombstone.');
    assert.equal(await countBackups(cancelOnly.documentId), 0);
    assert.equal((await readState(cancelOnly.documentId)).lifecycleGeneration, 1);

    const firstRace = await seed('first-request-cancel-race');
    const firstRaceRequest = await requestFor(firstRace.documentId);
    const firstRaceResults = await Promise.allSettled([
      coordinator.advance(firstRaceRequest, authorization), coordinator.advance(firstRaceRequest, authorization, true),
    ]);
    for (const attempt of firstRaceResults) if (attempt.status === 'rejected') {
      assert.ok(attempt.reason instanceof CollaborationAdmissionError
        && ['ADMISSION_STATE_CHANGED', 'ADMISSION_CONFLICT'].includes(attempt.reason.code));
    }
    const firstRaceReplay = await coordinator.advance(firstRaceRequest, authorization);
    assert.equal(firstRaceReplay.status, 'completed');
    assert.equal(await countBackups(firstRace.documentId), firstRaceReplay.status === 'completed' && firstRaceReplay.aborted ? 0 : 1,
      'A racing first request/cancel must leave exactly one durable terminal outcome.');

    const normal = await seed('normal-release');
    const originalState = await readState(normal.documentId);
    const normalOwner = await ownerFor(normal.documentId);
    await normalOwner.owner.release(normalOwner.fence, await snapshotFor(normal.documentId));
    const normalRequest = await requestFor(normal.documentId);
    assert.deepEqual(await coordinator.advance(normalRequest, authorization), { status: 'completed', aborted: false });
    const migrated = await readState(normal.documentId);
    assert.equal(migrated.representation, 'tiptap_blocks');
    assert.equal(migrated.lifecycleGeneration, 2);
    assert.equal(migrated.documentSequence, 2);
    assert.equal(migrated.checkpointSequence, 1, 'The new lifecycle must retain a visible projection gap.');
    const rich = new Y.Doc();
    try {
      Y.applyUpdate(rich, migrated.yjsState);
      assert.equal(validateRichMarkdownYDoc(rich).valid, true);
      assert.equal(richMarkdownFromYDoc(rich), content);
      assert.equal(rich.getText('frontmatter').toString(), content.slice(0, content.indexOf('# Canvas Studios')));
    } finally { rich.destroy(); }
    assert.equal(await countBackups(normal.documentId), 1);
    assert.deepEqual(await coordinator.advance(normalRequest, authorization), { status: 'completed', aborted: false });
    assert.equal(await countBackups(normal.documentId), 1);
    assert.equal((await readState(normal.documentId)).lifecycleGeneration, 2);
    const originalMigration = (JSON.parse(normalRequest.actionPayloadText!) as { migration: RichMigrationRequest }).migration;
    const changedRequest = createRepresentationAdmissionRequest(originalState, 'representation-actor', {
      ...originalMigration, stateProof: `yjs-snapshot-sha256-v1:${'0'.repeat(64)}`,
    });
    await assert.rejects(coordinator.advance(changedRequest, authorization),
      error => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_REQUEST_CHANGED');
    await assert.rejects(coordinator.advance(normalRequest, { authorize: async () => { throw new Error('Permission revoked'); } }), /Permission revoked/u);
    assert.equal(await countBackups(normal.documentId), 1);

    const uncertain = await seed('lost-commit-reply');
    const uncertainRequest = await requestFor(uncertain.documentId);
    let commitReplyLost = false;
    const uncertainCoordinator = createRepresentationMigrationCoordinator({
      openConnection: async () => {
        const connection = await openConnection();
        let committedHeader = false;
        return { ...connection, run: async (sql, values) => {
          const result = await connection.run(sql, values);
          if (sql.includes("UPDATE collaboration_admission_requests SET status = 'committed'")) committedHeader = true;
          if (sql === 'COMMIT' && committedHeader && !commitReplyLost) {
            commitReplyLost = true;
            throw new Error('Deliberate lost response after actual PostgreSQL COMMIT.');
          }
          return result;
        } };
      },
      withMutationLocks: async (ids, operation) => {
        assert.deepEqual(ids, [workspaceId]);
        return withWorkspaceMutationLock(workspaceId, operation);
      },
    });
    assert.deepEqual(await uncertainCoordinator.advance(uncertainRequest, authorization), { status: 'completed', aborted: false });
    assert.equal(commitReplyLost, true, 'The actual handoff COMMIT must succeed before losing its response.');
    assert.equal((await readState(uncertain.documentId)).lifecycleGeneration, 2);
    assert.equal(await countBackups(uncertain.documentId), 1);
    assert.deepEqual(await coordinator.advance(uncertainRequest, authorization), { status: 'completed', aborted: false });
    assert.equal(await countBackups(uncertain.documentId), 1, 'Fresh replay must read the durable outcome, not repeat migration.');

    const live = await seed('owner-drain');
    const liveOwner = await ownerFor(live.documentId);
    const liveRequest = await requestFor(live.documentId);
    assert.deepEqual(await coordinator.advance(liveRequest, authorization), { status: 'pending', phase: 'quiescence' });
    let ownedFence: CollaborationRoomOwnerFence | null = liveOwner.fence;
    const drainErrors: unknown[] = [];
    const worker = createCollaborationRoomAdmissionWorker({ pollMs: 10, getOwnedFences: () => ownedFence ? [ownedFence] : [],
      pendingDrains: admission.pendingDrains, onError: error => { drainErrors.push(error); }, drain: async ticket => {
        const snapshot = await snapshotFor(live.documentId);
        await liveOwner.owner.release(liveOwner.fence, { ...snapshot, releaseId: ticket.releaseId, admission: ticket });
        ownedFence = null;
      } });
    workers.push(worker);
    const deadline = Date.now() + 5_000;
    while (ownedFence && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(ownedFence, null, 'The real durable poller must consume the drain request.');
    assert.deepEqual(drainErrors, []);
    assert.deepEqual(await coordinator.advance(liveRequest, authorization), { status: 'completed', aborted: false });
    assert.equal((await readState(live.documentId)).lifecycleGeneration, 2);
    assert.equal(await countBackups(live.documentId), 1);
    worker.dispose();

    const busy = await seed('busy-owner-refusal');
    const busyState = await readState(busy.documentId);
    const busyOwner = await ownerFor(busy.documentId);
    const busyRequest = await requestFor(busy.documentId);
    assert.deepEqual(await coordinator.advance(busyRequest, authorization), { status: 'pending', phase: 'quiescence' });
    const busyTickets = await admission.pendingDrains([busyOwner.fence]);
    assert.equal(busyTickets.length, 1);
    const busyTicket = busyTickets[0]!;
    assert.deepEqual(await readRepresentationDrainRequest(busyTicket, openConnection), busyRequest);
    await assert.rejects(readRepresentationDrainRequest({ ...busyTicket, requestDigest: '0'.repeat(64) }, openConnection),
      error => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_REQUEST_CHANGED');
    await assert.rejects(refuseRepresentationAdmissionDrain(busyRequest,
      { ...busyTicket, fence: { ...busyTicket.fence, token: randomUUID() } }, openConnection),
    error => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_SCOPE_CHANGED');
    assert.equal((await admission.read(busyRequest))!.status, 'draining');
    await refuseRepresentationAdmissionDrain(busyRequest, busyTicket, openConnection);
    assert.equal((await admission.read(busyRequest))!.status, 'cancelled');
    const refusedTarget = (await control.query(`SELECT active,status,release_id,quiescence_kind,quiescence_text
      FROM ${namespace}.collaboration_admission_targets WHERE request_id=$1`, [busyRequest.requestId])).rows[0]!;
    assert.deepEqual(refusedTarget, { active: false, status: 'cancelled', release_id: null,
      quiescence_kind: null, quiescence_text: null });
    const refusedState = await readState(busy.documentId);
    assert.deepEqual(refusedState.yjsState, busyState.yjsState, 'Refusal must never rewrite document bytes.');
    assert.deepEqual(refusedState.stateVector, busyState.stateVector);
    assert.equal(refusedState.lifecycleGeneration, 1);
    assert.equal(refusedState.documentSequence, 1);
    assert.equal(await countBackups(busy.documentId), 0);
    const heldOwner = (await control.query(`SELECT room_owner_epoch,room_owner_token FROM ${stateTable}
      WHERE document_id=$1`, [busy.documentId])).rows[0]!;
    assert.equal(Number(heldOwner.room_owner_epoch), busyOwner.fence.epoch);
    assert.equal(heldOwner.room_owner_token, busyOwner.fence.token, 'Refusal must preserve the current owner token.');
    await busyOwner.owner.probe();
    assert.deepEqual(await coordinator.advance(busyRequest, authorization), { status: 'completed', aborted: true });
    assert.deepEqual(await coordinator.advance(busyRequest, authorization), { status: 'completed', aborted: true });
    await assert.rejects(refuseRepresentationAdmissionDrain(busyRequest, busyTicket, openConnection),
      error => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_STATE_CHANGED');
    await busyOwner.owner.release(busyOwner.fence, await snapshotFor(busy.documentId));

    const released = await seed('refusal-after-release');
    const releasedOwner = await ownerFor(released.documentId);
    const releasedRequest = await requestFor(released.documentId);
    assert.deepEqual(await coordinator.advance(releasedRequest, authorization), { status: 'pending', phase: 'quiescence' });
    const releasedTickets = await admission.pendingDrains([releasedOwner.fence]);
    assert.equal(releasedTickets.length, 1);
    const releasedTicket = releasedTickets[0]!;
    await releasedOwner.owner.release(releasedOwner.fence,
      { ...await snapshotFor(released.documentId), releaseId: releasedTicket.releaseId, admission: releasedTicket });
    await assert.rejects(refuseRepresentationAdmissionDrain(releasedRequest, releasedTicket, openConnection),
      error => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_STATE_CHANGED');
    assert.deepEqual(await coordinator.advance(releasedRequest, authorization), { status: 'completed', aborted: false });
    assert.equal(await countBackups(released.documentId), 1);

    const race = await seed('refusal-release-race');
    const raceOwner = await ownerFor(race.documentId);
    const raceRequest = await requestFor(race.documentId);
    assert.deepEqual(await coordinator.advance(raceRequest, authorization), { status: 'pending', phase: 'quiescence' });
    const raceTickets = await admission.pendingDrains([raceOwner.fence]);
    assert.equal(raceTickets.length, 1);
    const raceTicket = raceTickets[0]!;
    const raceSnapshot = await snapshotFor(race.documentId);
    const raceResults = await Promise.allSettled([
      refuseRepresentationAdmissionDrain(raceRequest, raceTicket, openConnection),
      raceOwner.owner.release(raceOwner.fence, { ...raceSnapshot, releaseId: raceTicket.releaseId, admission: raceTicket }),
    ]);
    assert.equal(raceResults.filter(result => result.status === 'fulfilled').length, 1,
      'Header/target/state locks must choose exactly one refusal or release winner.');
    const loser = raceResults.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.ok(loser.reason instanceof CollaborationAdmissionError && loser.reason.code === 'ADMISSION_STATE_CHANGED');
    const raceStatus = (await admission.read(raceRequest))!.status;
    assert.ok(raceStatus === 'cancelled' || raceStatus === 'draining');
    assert.deepEqual(await coordinator.advance(raceRequest, authorization),
      { status: 'completed', aborted: raceStatus === 'cancelled' });
    assert.equal(await countBackups(race.documentId), raceStatus === 'cancelled' ? 0 : 1);

    const stale = await seed('deletion-proof');
    const staleRequest = await requestFor(stale.documentId);
    const beforeVector = Y.encodeStateVector(stale.document);
    stale.document.getText('content').delete(content.indexOf('Second'), 'Second'.length);
    assert.deepEqual(Y.encodeStateVector(stale.document), beforeVector, 'Deletion-only update must retain the state vector.');
    const deletedMarkdown = stale.document.getText('content').toString();
    await control.query(`UPDATE ${stateTable} SET yjs_state=$2,canonical_hash=$3,serialized_hash=$3 WHERE document_id=$1`,
      [stale.documentId, Buffer.from(Y.encodeStateAsUpdate(stale.document)), sha256(deletedMarkdown)]);
    await control.query(`UPDATE ${projectionTable} SET canonical_hash=$2,serialized_hash=$2 WHERE document_id=$1`,
      [stale.documentId, sha256(deletedMarkdown)]);
    assert.deepEqual(await coordinator.advance(staleRequest, authorization), { status: 'completed', aborted: true });
    assert.equal(await countBackups(stale.documentId), 0);
    assert.equal((await readState(stale.documentId)).representation, 'plain_text');
    assert.equal((await admission.read(staleRequest))!.status, 'committed');
    assert.equal((await control.query(`SELECT active FROM ${namespace}.collaboration_admission_targets WHERE request_id=$1`,
      [staleRequest.requestId])).rows[0]!.active, false, 'Failed precondition must release the reservation.');

    const unfinalized = await seed('unfinalized-checkpoint');
    await control.query(`UPDATE ${projectionTable} SET finalized=0 WHERE document_id=$1`, [unfinalized.documentId]);
    assert.deepEqual(await coordinator.advance(await requestFor(unfinalized.documentId), authorization), { status: 'completed', aborted: true });
    assert.equal(await countBackups(unfinalized.documentId), 0);

    const other = await seed('same-path-new-document');
    const wrongIdentity = createRepresentationAdmissionRequest({ ...originalState, path: (await readState(other.documentId)).path },
      'representation-actor', { ...originalMigration, requestId: randomUUID() });
    await assert.rejects(coordinator.advance(wrongIdentity, authorization),
      error => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_SCOPE_CHANGED');
    assert.equal(await countBackups(other.documentId), 0);

    // A confirmed immutable historical outcome survives a subsequent closed-file rename.
    // This bypasses neither fresh canonical-path authorization nor a nonterminal mutation scope.
    for (const [label, fixture, historical, aborted, markdown] of [
      ['committed migration', normal, normalRequest, false, content],
      ['CAS cancellation', cancelOnly, cancelOnlyRequest, true, content],
      ['guarded abort', stale, staleRequest, true, deletedMarkdown],
    ] as const) {
      const before = await readState(fixture.documentId);
      const movedPath = `moved-${before.path}`;
      const originalFile = path.join(temporaryData, before.path), movedFile = path.join(temporaryData, movedPath);
      await writeFile(originalFile, markdown);
      await withWorkspaceFileLifecycleGuard({ workspaceId, paths: [before.path, movedPath] }, async () => {
        await rename(originalFile, movedFile);
        const database = await openConnection();
        try {
          await database.run('BEGIN');
          await assertWorkspaceFileLifecycleSqlAvailable(database, workspaceId, [before.path, movedPath]);
          await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1', [fixture.documentId, movedPath]);
          await database.run('COMMIT');
        } finally { await database.close(); }
      }, openConnection);
      const backupsBefore = await countBackups(fixture.documentId);
      let terminalCalls = 0;
      const movedAuthorization = {
        authorize: async () => { assert.fail('An old-path request may not receive fresh mutation authorization after move.'); },
        authorizeTerminal: async (request: CollaborationAdmissionRequest) => {
          terminalCalls += 1;
          assert.equal(request.requestId, historical.requestId);
          assert.equal(request.actorId, 'representation-actor');
          assert.equal(request.expectedDocuments[0].documentId, fixture.documentId);
          const canonical = await readState(fixture.documentId);
          assert.equal(canonical.workspaceId, workspaceId); assert.equal(canonical.organizationId, null);
          assert.equal(canonical.status, 'active'); assert.equal(canonical.path, movedPath);
        },
      };
      assert.deepEqual(await coordinator.advance(historical, movedAuthorization), { status: 'completed', aborted }, label);
      assert.equal(terminalCalls, 1);
      const after = await readState(fixture.documentId);
      assert.equal(after.path, movedPath); assert.equal(after.lifecycleGeneration, before.lifecycleGeneration);
      assert.equal(after.documentSequence, before.documentSequence);
      assert.deepEqual(after.yjsState, before.yjsState); assert.deepEqual(after.stateVector, before.stateVector);
      assert.equal(await countBackups(fixture.documentId), backupsBefore);
      assert.equal(await readFile(movedFile, 'utf8'), markdown);
      await assert.rejects(coordinator.advance(historical, { ...movedAuthorization,
        authorizeTerminal: async () => { throw new Error('Current path permission revoked'); } }), /Current path permission revoked/u);
      await assert.rejects(coordinator.advance({ ...historical, actorId: 'different-actor' }, movedAuthorization),
        error => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_REQUEST_CHANGED');
    }

    console.log('Representation admission PostgreSQL: passed (real codec, owner release/drain/poller, guarded refusal/replay/release race, lost COMMIT reply recovery, backup, ACL, deletion proof, finalized checkpoint, path identity and immutable terminal replay after guarded physical rename).');
  } finally {
    for (const worker of workers) worker.dispose();
    for (const owner of owners) await owner.close();
    for (const document of documents) document.destroy();
    await pool?.end();
    if (schemaPattern.test(schema)) await control.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
    await control.end();
    await closeDatabaseConnections();
    if (previousData === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousData;
    await rm(temporaryData, { recursive: true, force: true });
  }
}

const url = guardedUrl();
if (!url) console.log('Representation admission PostgreSQL: skipped (provide managed PostgreSQL environment).');
else run(url).catch(error => {
  console.error(String(error instanceof Error ? error.message : 'Representation integration failed.')
    .replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]'));
  process.exitCode = 1;
});

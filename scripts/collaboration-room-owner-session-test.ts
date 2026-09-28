import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Client } from 'pg';

import {
  CollaborationRoomOwnerError,
  createCollaborationRoomOwnerSession,
  type CollaborationRoomOwnerRow,
  type CollaborationRoomOwnerScope,
} from '../app/lib/collaboration/room-owner';

type QueryCall = { sql: string; values: unknown[] };
type QueryGate = { matches: (call: QueryCall) => boolean; entered: () => void; wait: Promise<void> };

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function scope(documentId: string): CollaborationRoomOwnerScope {
  return {
    documentId,
    workspaceId: 'workspace-a',
    organizationId: null,
    path: `${documentId}.txt`,
    representation: 'plain_text',
    lifecycleGeneration: 1,
    schemaVersion: 1,
  };
}

function rowFor(value: CollaborationRoomOwnerScope): CollaborationRoomOwnerRow {
  return {
    document_id: value.documentId,
    workspace_id: value.workspaceId,
    organization_id: value.organizationId,
    path: value.path,
    representation: value.representation,
    lifecycle_generation: value.lifecycleGeneration,
    schema_version: value.schemaVersion,
    status: 'active',
    room_owner_epoch: 0,
    room_owner_token: null,
    room_owner_backend_pid: null,
    room_owner_backend_start: null,
  };
}

/** In-memory fault-injection fake; it does not model PostgreSQL locking semantics. */
class FakePgClient extends EventEmitter {
  readonly calls: QueryCall[] = [];
  readonly rows = new Map<string, CollaborationRoomOwnerRow>();
  endCalls = 0;
  loseNextCommitReply = false;
  queryGate: QueryGate | null = null;

  constructor(scopes: CollaborationRoomOwnerScope[]) {
    super();
    for (const value of scopes) this.rows.set(value.documentId, rowFor(value));
  }

  async query(sql: string, values: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const call = { sql, values };
    this.calls.push(call);
    const currentGate = this.queryGate;
    if (currentGate?.matches(call)) {
      this.queryGate = null;
      currentGate.entered();
      await currentGate.wait;
    }

    if (sql.includes('FROM pg_stat_activity WHERE pid = pg_backend_pid()')) {
      return { rows: [{ pid: 4567, started: '1727370000.12345' }] };
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM collaboration_admission_scopes')
      && sql.includes('JOIN collaboration_admission_requests')) return { rows: [] };
    if (sql.includes('FROM collaboration_admission_targets')
      && sql.includes('document_id = $1') && sql.includes('active')) return { rows: [] };
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (sql.startsWith('SELECT * FROM collaboration_yjs_states')) {
      const value = this.rows.get(String(values[0]));
      return { rows: value ? [{ ...value }] : [] };
    }
    if (sql.startsWith('UPDATE collaboration_yjs_states')) {
      const value = this.rows.get(String(values[0]));
      if (value) {
        if (sql.includes('room_owner_token = NULL')) {
          value.room_owner_token = null;
          value.room_owner_backend_pid = null;
          value.room_owner_backend_start = null;
        } else {
          value.room_owner_epoch = Number(values[1]);
          value.room_owner_token = String(values[2]);
          value.room_owner_backend_pid = Number(values[3]);
          value.room_owner_backend_start = String(values[4]);
        }
      }
      return { rows: [] };
    }
    if (sql === 'COMMIT' && this.loseNextCommitReply) {
      this.loseNextCommitReply = false;
      // Fault injection models a committed transaction whose reply was lost.
      throw new Error('injected lost COMMIT reply');
    }
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql === 'SELECT 1') {
      return { rows: [] };
    }
    throw new Error(`Unexpected fake PostgreSQL query: ${sql}`);
  }

  async end(): Promise<void> {
    this.endCalls += 1;
  }
}

function fakeClient(...scopes: CollaborationRoomOwnerScope[]) {
  return new FakePgClient(scopes) as FakePgClient & Pick<Client, 'query' | 'on' | 'end'>;
}

function isOwnerError(error: unknown, code: CollaborationRoomOwnerError['code']): boolean {
  return error instanceof CollaborationRoomOwnerError && error.code === code;
}

async function testDuplicateAcquireDoesNotReenterSessionLock() {
  const firstScope = scope('duplicate');
  const client = fakeClient(firstScope);
  const session = await createCollaborationRoomOwnerSession(client);
  const fence = await session.acquire(firstScope);
  const lockQueries = () => client.calls.filter((call) => call.sql.includes('pg_try_advisory_lock')).length;
  assert.equal(lockQueries(), 1);
  await assert.rejects(session.acquire(firstScope), (error) => isOwnerError(error, 'ROOM_OWNER_BUSY'));
  assert.equal(lockQueries(), 1, 'duplicate local acquisition is rejected before PostgreSQL reenters its session lock');
  await session.release(fence);
  await session.close();
}

async function testScopeIsCopiedBeforeItsQueuedAcquireRuns() {
  const blockerScope = scope('queue-blocker');
  const queuedScope = scope('copied-before-queue');
  const client = fakeClient(blockerScope, queuedScope);
  const session = await createCollaborationRoomOwnerSession(client);
  const entered = gate();
  const unblock = gate();
  client.queryGate = {
    matches: ({ sql }) => sql === 'SELECT 1',
    entered: entered.resolve,
    wait: unblock.promise,
  };
  const blocker = session.probe();
  await entered.promise;

  const mutableInput = { ...queuedScope };
  const queuedAcquire = session.acquire(mutableInput);
  mutableInput.path = 'mutated-after-acquire.txt';
  mutableInput.workspaceId = 'other-workspace';
  unblock.resolve();

  await blocker;
  const fence = await queuedAcquire;
  assert.equal(fence.scope.path, queuedScope.path);
  assert.equal(fence.scope.workspaceId, queuedScope.workspaceId);
  assert.equal(client.rows.get(queuedScope.documentId)?.path, queuedScope.path,
    'the query validates the copied identity, not post-call caller mutations');
  await session.release(fence);
  await session.close();
}

async function testReleaseInvalidatesLocallyAndStaleReleaseKeepsReplacement() {
  const roomScope = scope('replace-after-release');
  const client = fakeClient(roomScope);
  const session = await createCollaborationRoomOwnerSession(client);
  const firstFence = await session.acquire(roomScope);
  const firstRelease = session.release(firstFence);

  assert.throws(() => session.assertActive(firstFence), (error) => isOwnerError(error, 'ROOM_OWNER_LOST'),
    'release invalidates the local handle before queued SQL completes');
  await firstRelease;
  const replacement = await session.acquire(roomScope);
  const unlockCountBeforeStaleRelease = client.calls.filter((call) => call.sql.includes('pg_advisory_unlock')).length;
  await assert.rejects(session.release(firstFence), (error) => isOwnerError(error, 'ROOM_OWNER_LOST'));
  session.assertActive(replacement);
  assert.equal(client.calls.filter((call) => call.sql.includes('pg_advisory_unlock')).length, unlockCountBeforeStaleRelease,
    'a stale repeated release cannot unlock the replacement owner');
  await session.release(replacement);
  await session.close();
}

async function testFullCommandQueueDoesNotLoseOwnerOnBusyRelease() {
  const roomScope = scope('full-command-queue');
  const client = fakeClient(roomScope);
  const session = await createCollaborationRoomOwnerSession(client);
  const fence = await session.acquire(roomScope);
  const entered = gate();
  const unblock = gate();
  client.queryGate = {
    matches: ({ sql }) => sql === 'SELECT 1',
    entered: entered.resolve,
    wait: unblock.promise,
  };
  const firstProbe = session.probe();
  await entered.promise;
  const queuedProbes = Array.from({ length: 255 }, () => session.probe());
  const callsBeforeBusyRelease = client.calls.length;

  await assert.rejects(session.release(fence), (error) => isOwnerError(error, 'ROOM_OWNER_BUSY'));
  session.assertActive(fence);
  assert.equal(client.calls.length, callsBeforeBusyRelease,
    'a capacity-rejected release does not issue SQL or discard the still-owned room handle');

  unblock.resolve();
  await Promise.all([firstProbe, ...queuedProbes]);
  await session.release(fence);
  await session.close();
}

async function testRejectedCommitReplyInvalidatesEveryHandleAndDropsQueuedCommands() {
  const firstScope = scope('existing-owner');
  const failingScope = scope('commit-reply-lost');
  const client = fakeClient(firstScope, failingScope);
  let invalidations = 0;
  const session = await createCollaborationRoomOwnerSession(client, () => { invalidations += 1; });
  const existingFence = await session.acquire(firstScope);
  const updateEntered = gate();
  const allowUpdate = gate();
  client.queryGate = {
    matches: ({ sql, values }) => sql.startsWith('UPDATE collaboration_yjs_states') && values[0] === failingScope.documentId,
    entered: updateEntered.resolve,
    wait: allowUpdate.promise,
  };

  const failingAcquire = session.acquire(failingScope);
  await updateEntered.promise;
  const queryCountBeforeQueue = client.calls.length;
  const queuedProbe = session.probe();
  const queuedProbeRejected = assert.rejects(queuedProbe, (error) => isOwnerError(error, 'ROOM_OWNER_LOST'));
  client.loseNextCommitReply = true;
  allowUpdate.resolve();

  await assert.rejects(failingAcquire, (error) => isOwnerError(error, 'ROOM_OWNER_UNAVAILABLE'));
  await queuedProbeRejected;
  assert.throws(() => session.assertActive(existingFence), (error) => isOwnerError(error, 'ROOM_OWNER_LOST'),
    'a failed transaction invalidates handles acquired earlier on this session');
  assert.equal(client.calls.length, queryCountBeforeQueue + 1,
    'the queued probe is discarded after session loss and does not reach the client');
  assert.equal(client.calls.some((call) => call.sql === 'SELECT 1'), false);
  await session.close();
  client.emit('error', new Error('duplicate failure notification'));
  client.emit('end');
  assert.equal(invalidations, 1);
  assert.equal(client.endCalls, 1);
}

async function testQueryRejectionAndUnexpectedSessionEventsInvalidate() {
  const queryScope = scope('query-failure');
  const queryClient = fakeClient(queryScope);
  let queryInvalidations = 0;
  const querySession = await createCollaborationRoomOwnerSession(queryClient, () => { queryInvalidations += 1; });
  const queryFence = await querySession.acquire(queryScope);
  queryClient.queryGate = {
    matches: ({ sql }) => sql === 'SELECT 1',
    entered: () => undefined,
    wait: Promise.reject(new Error('injected query rejection')),
  };
  await assert.rejects(querySession.probe(), (error) => isOwnerError(error, 'ROOM_OWNER_UNAVAILABLE'));
  assert.throws(() => querySession.assertActive(queryFence), (error) => isOwnerError(error, 'ROOM_OWNER_LOST'));
  await querySession.close();
  assert.equal(queryInvalidations, 1);
  assert.equal(queryClient.endCalls, 1);

  for (const event of ['error', 'end'] as const) {
    const eventScope = scope(`unexpected-${event}`);
    const eventClient = fakeClient(eventScope);
    let invalidations = 0;
    const eventSession = await createCollaborationRoomOwnerSession(eventClient, () => { invalidations += 1; });
    const fence = await eventSession.acquire(eventScope);
    if (event === 'error') eventClient.emit('error', new Error('injected client error'));
    else eventClient.emit('end');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.throws(() => eventSession.assertActive(fence), (error) => isOwnerError(error, 'ROOM_OWNER_LOST'));
    const callsAfterEvent = eventClient.calls.length;
    await assert.rejects(eventSession.probe(), (error) => isOwnerError(error, 'ROOM_OWNER_LOST'));
    assert.equal(eventClient.calls.length, callsAfterEvent, `${event} prevents further commands on the session`);
    assert.equal(invalidations, 1);
    if (event === 'error') assert.equal(eventClient.endCalls, 1);
  }
}

async function testSingleCommandTimeoutInvalidatesSession() {
  const timeoutScope = scope('single-timeout');
  const client = fakeClient(timeoutScope);
  let invalidations = 0;
  const session = await createCollaborationRoomOwnerSession(client, () => { invalidations += 1; });
  const fence = await session.acquire(timeoutScope);
  const stuck = gate();
  client.queryGate = { matches: ({ sql }) => sql === 'SELECT 1', entered: () => undefined, wait: stuck.promise };
  await assert.rejects(session.probe(), (error) => isOwnerError(error, 'ROOM_OWNER_UNAVAILABLE'));
  assert.throws(() => session.assertActive(fence), (error) => isOwnerError(error, 'ROOM_OWNER_LOST'));
  await session.close();
  assert.equal(invalidations, 1);
  assert.equal(client.endCalls, 1);
}

async function main() {
  await testDuplicateAcquireDoesNotReenterSessionLock();
  await testScopeIsCopiedBeforeItsQueuedAcquireRuns();
  await testReleaseInvalidatesLocallyAndStaleReleaseKeepsReplacement();
  await testFullCommandQueueDoesNotLoseOwnerOnBusyRelease();
  await testRejectedCommitReplyInvalidatesEveryHandleAndDropsQueuedCommands();
  await testQueryRejectionAndUnexpectedSessionEventsInvalidate();
  await testSingleCommandTimeoutInvalidatesSession();
  console.log('collaboration room-owner session fault-injection tests passed (7 scenarios)');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

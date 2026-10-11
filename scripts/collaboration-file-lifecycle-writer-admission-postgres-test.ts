import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, Pool } from 'pg';
import ts from 'typescript';

import * as Database from '../app/lib/db';
import type { SqlConnection } from '../app/lib/db';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import { COLLABORATION_ROOM_OWNER_UP_SQL, COLLABORATION_ROOM_RELEASE_UP_SQL } from '../app/lib/db/collaboration-room-owner-migration';
import {
  getWorkspaceFileLifecycleLeases,
  hasVerifiedWorkspaceFileLifecycleCollaborationWrite,
  withWorkspaceFileLifecycleCollaborationWrite,
} from '../app/lib/collaboration/file-lifecycle-admission-context';
import { tryLockFileLifecycleCollaborationWriterAdmission } from '../app/lib/collaboration/file-lifecycle-writer-admission';
import { assertCollaborationDocumentIdleReleaseProof } from '../app/lib/collaboration/document-idle-release';
import type * as Persistence from '../app/lib/collaboration/persistence';
import { assertCollaborationAdmissionOpen, createCollaborationAdmissionService, tryLockCollaborationAdmissionWorkspace } from '../app/lib/collaboration/room-admission';
import {
  collaborationAdmissionActionDigest,
  collaborationAdmissionLockKey,
  CollaborationAdmissionError,
  type CollaborationAdmissionRequest,
} from '../app/lib/collaboration/room-admission-contract';
import { createCollaborationRoomOwnerSession, CollaborationRoomOwnerError, lockIdentity,
  type CollaborationRoomOwnerScope } from '../app/lib/collaboration/room-owner';
import { Y } from '../app/lib/collaboration/server-runtime';
import { withWorkspaceFileLifecycleGuard } from '../app/lib/files/workspace-file-lifecycle-guard';

const SCHEMA_PATTERN = /^canvas_lifecycle_writer_test_[a-f0-9]{32}$/u;
let activeStage = 'managed environment and isolated schema';

function managedDatabaseUrl(): URL {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) {
    throw new Error('This regression requires the managed PostgreSQL environment; it cannot pass by skipping.');
  }
  let url: URL;
  try { url = new URL(process.env.DATABASE_URL); }
  catch { throw new Error('Invalid managed PostgreSQL configuration.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1'].includes(url.hostname)
    || url.port !== '55433' || url.pathname !== '/canvas_notebook') {
    throw new Error('Only managed loopback PostgreSQL at 55433/canvas_notebook is accepted.');
  }
  return url;
}

/** Substitute only the database checkout; initialization, merging, persistence and owner fences remain real. */
async function persistenceInSchema(openDb: () => Promise<SqlConnection>): Promise<typeof Persistence> {
  const filename = path.resolve('app/lib/collaboration/persistence.ts');
  const load = createRequire(filename);
  const source = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const compiledModule = { exports: {} };
  new Function('require', 'module', 'exports', source)(
    (name: string) => name === '@/app/lib/db' ? { ...Database, openDb } : load(name),
    compiledModule, compiledModule.exports,
  );
  return compiledModule.exports as typeof Persistence;
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(operation: Promise<T>, label: string, milliseconds = 6_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its bounded deadline.`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function admissionConflict(error: unknown): boolean {
  return error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_CONFLICT';
}

async function run(url: URL): Promise<void> {
  const schema = `canvas_lifecycle_writer_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, SCHEMA_PATTERN);
  const namespace = `"${schema}"`;
  const config = { connectionString: url.href, connectionTimeoutMillis: 3_000,
    options: '-c statement_timeout=10000 -c lock_timeout=4000' };
  const control = new Client(config);
  await control.connect();
  let pool: Pool | undefined;
  let owner: Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>> | undefined;
  const clients: Client[] = [];
  const documents: Array<InstanceType<typeof Y.Doc>> = [];
  const gates: Array<ReturnType<typeof barrier>> = [];
  const temporaryData = await mkdtemp(path.join(tmpdir(), 'canvas-lifecycle-writer-'));
  const previousData = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = temporaryData;
  let schemaCreated = false;
  try {
    const server = (await control.query(`SELECT current_database() AS name,
      current_setting('server_version_num') AS version,
      to_regclass('public.collaboration_yjs_states') IS NOT NULL AS has_states`)).rows[0];
    assert.equal(server.name, 'canvas_notebook');
    assert.equal(Math.floor(Number(server.version) / 10_000), 18);
    assert.equal(server.has_states, true);
    await control.query(`CREATE SCHEMA ${namespace}`);
    schemaCreated = true;
    await control.query(`CREATE TABLE ${namespace}.collaboration_yjs_states (LIKE public.collaboration_yjs_states INCLUDING ALL)`);
    const scoped = { ...config, options: `${config.options} -c search_path=${schema}` };
    const migration = new Client(scoped);
    await migration.connect();
    try {
      await migration.query(COLLABORATION_ROOM_OWNER_UP_SQL);
      await migration.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
      for (const statement of COLLABORATION_ADMISSION_STATEMENTS) await migration.query(statement);
    } finally { await migration.end(); }
    pool = new Pool({ ...scoped, max: 8 });
    const usedBackendPids = new Set<number>();
    const observedClients = new WeakSet<object>();
    const openConnection = async (): Promise<SqlConnection> => {
      const client = await pool!.connect();
      if (!observedClients.has(client)) {
        observedClients.add(client);
        client.on('error', () => undefined);
      }
      const backendPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      usedBackendPids.add(backendPid);
      let closed = false;
      return {
        get: async (sql, params) => (await client.query(sql, params)).rows[0],
        all: async (sql, params) => (await client.query(sql, params)).rows,
        run: async (sql, params) => ({ changes: (await client.query(sql, params)).rowCount ?? 0 }),
        close: async error => { assert.equal(closed, false); closed = true; client.release(error); },
      };
    };
    const table = `${namespace}.collaboration_yjs_states`;
    const workspaceId = `lifecycle-writer-${randomUUID()}`;
    const scope = (filePath: string): CollaborationRoomOwnerScope => ({
      documentId: `writer-${randomUUID()}`, workspaceId, organizationId: null,
      path: filePath, representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1,
    });
    const persistence = await persistenceInSchema(openConnection);
    const guard = <T>(paths: readonly string[], operation: () => Promise<T>, checkout = openConnection) =>
      withWorkspaceFileLifecycleGuard({ workspaceId, paths }, operation, checkout);
    const checkAdmission = async (input: CollaborationRoomOwnerScope, scopedWriter = true) => {
      const database = await openConnection();
      try {
        await database.run('BEGIN');
        const query = async (sql: string, params?: unknown[]) =>
          await database.all(sql, params) as Array<Record<string, unknown>>;
        if (scopedWriter) await tryLockFileLifecycleCollaborationWriterAdmission(query, input);
        else await tryLockCollaborationAdmissionWorkspace(query, input.workspaceId);
        await assertCollaborationAdmissionOpen(query, input);
        await database.run('COMMIT');
      } catch (error) {
        await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined);
        throw error;
      } finally { await database.close(); }
    };
    const ownerClient = new Client(scoped);
    await ownerClient.connect();
    owner = await createCollaborationRoomOwnerSession(ownerClient);

    // This exercises fresh initialization and a real room owner on separate SQL sessions under the retained guard.
    activeStage = 'real scoped initialization, ownership, persistence and release';
    const first = scope('fresh.md');
    let guardPid = 0;
    const observedGuardConnection = async () => {
      const database = await openConnection();
      guardPid = Number((await database.get('SELECT pg_backend_pid() AS pid') as { pid: number }).pid);
      return database;
    };
    await guard([first.path], () => withWorkspaceFileLifecycleCollaborationWrite(first, async () => {
      assert.equal(await hasVerifiedWorkspaceFileLifecycleCollaborationWrite(first), true);
      await checkAdmission(first);
      await assert.rejects(checkAdmission(first, false), admissionConflict,
        'The ordinary writer must still conflict with this same retained PG guard.');
      const initialized = await within(persistence.ensureCollaborationState({ ...first,
        initialContent: '[[B]]\n[link](B.md)\n' }), 'Scoped fresh-state initialization');
      assert.equal(initialized.documentSequence, 0);
      const fence = await within(owner!.acquire(first), 'Scoped owner acquisition');
      assert.notEqual(fence.backendPid, guardPid, 'Room acquisition must use a different PG backend from the guard.');
      const document = new Y.Doc();
      documents.push(document);
      Y.applyUpdate(document, initialized.yjsState);
      document.transact(() => {
        document.getText('content').delete(0, document.getText('content').length);
        document.getText('content').insert(0, '[[C]]\n[link](C.md)\n');
      });
      const saved = await persistence.persistCollaborationYDoc(first.documentId, 1, document, first, fence);
      assert.equal(saved.documentSequence, 1);
      const proof = async () => {
        const database = await openConnection();
        try {
          await database.run('BEGIN');
          await assertCollaborationDocumentIdleReleaseProof(database, first, fence);
          await database.run('COMMIT');
        } catch (error) {
          await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined);
          throw error;
        } finally { await database.close(); }
      };
      const ownerBusy = (error: unknown) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY';
      activeStage = 'idle proof refuses active real owner';
      await assert.rejects(proof(), ownerBusy, 'A real live owner cannot be proven released.');
      const row = (await control.query(`SELECT yjs_state FROM ${table} WHERE document_id=$1`, [first.documentId])).rows[0];
      const durable = new Y.Doc();
      try {
        Y.applyUpdate(durable, row.yjs_state);
        assert.equal(durable.getText('content').toString(), '[[C]]\n[link](C.md)\n');
      } finally { durable.destroy(); }
      await owner!.release(fence, { releaseId: randomUUID(), yjsState: Y.encodeStateAsUpdate(document),
        stateVector: Y.encodeStateVector(document) });
      const released = (await control.query(`SELECT room_owner_token FROM ${table} WHERE document_id=$1`, [first.documentId])).rows[0];
      assert.equal(released.room_owner_token, null, 'The internal owner is durably released before outer completion.');
      activeStage = 'idle proof validates exact real release receipt';
      await proof();
      // Cleared SQL owner columns and a real valid receipt still cannot hide a live document advisory holder.
      const key = lockIdentity(first.documentId);
      await control.query('SELECT pg_advisory_lock($1::bigint)', [key.key]);
      activeStage = 'idle proof refuses a separate advisory holder';
      try { await assert.rejects(proof(), ownerBusy, 'The real pg_locks query must refuse advisory ownership.'); }
      finally { await control.query('SELECT pg_advisory_unlock($1::bigint)', [key.key]); }
      activeStage = 'idle proof validates advisory vacancy after holder release';
      await proof();
    }), observedGuardConnection);
    assert.ok(usedBackendPids.size >= 2, 'The test must use distinct SQL sessions, not reentrant locks on one session.');
    assert.equal(await hasVerifiedWorkspaceFileLifecycleCollaborationWrite(first), false);

    // All seven scope dimensions must match the captured private grant. No public/workspace-wide bypass is accepted.
    activeStage = 'seven exact identity mismatch fences';
    const mismatch = scope('exact.md');
    const foreignWorkspace = `foreign-writer-${randomUUID()}`;
    const blocker = new Client(scoped);
    clients.push(blocker);
    await blocker.connect();
    await blocker.query('SELECT pg_advisory_lock($1::bigint)', [collaborationAdmissionLockKey(foreignWorkspace)]);
    try {
      await guard([mismatch.path], () => withWorkspaceFileLifecycleCollaborationWrite(mismatch, async () => {
        const wrong: Array<[string, CollaborationRoomOwnerScope]> = [
          ['document', { ...mismatch, documentId: 'different-document' }],
          ['path', { ...mismatch, path: 'different.md' }],
          ['workspace', { ...mismatch, workspaceId: foreignWorkspace }],
          ['organization', { ...mismatch, organizationId: 'different-organization' }],
          ['representation', { ...mismatch, representation: 'tiptap_xml' }],
          ['generation', { ...mismatch, lifecycleGeneration: 2 }],
          ['schema', { ...mismatch, schemaVersion: 2 }],
        ];
        for (const [label, input] of wrong) {
          assert.equal(await hasVerifiedWorkspaceFileLifecycleCollaborationWrite(input), false, label);
          await assert.rejects(checkAdmission(input), admissionConflict, `${label}: wrong scope must use the strict admission lock.`);
        }
        await checkAdmission(mismatch);
      }));
    } finally { await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [collaborationAdmissionLockKey(foreignWorkspace)]); }

    // A verified lease only shares the lock; reservations still deny the exact internal write.
    activeStage = 'existing pending reservation';
    const pending = scope('pending.md');
    const actionPayloadText = JSON.stringify({ fixture: randomUUID() });
    const request: CollaborationAdmissionRequest = {
      requestId: randomUUID(), actorId: 'lifecycle-writer-test', action: 'rename', actionPayloadText,
      actionDigest: collaborationAdmissionActionDigest('rename', actionPayloadText),
      scopes: [{ workspaceId, organizationId: null, path: pending.path, kind: 'exact' }], expectedDocuments: [],
    };
    const admission = createCollaborationAdmissionService({ openConnection });
    const reserved = await admission.reserve(request);
    await guard(['free.md'], () => withWorkspaceFileLifecycleCollaborationWrite(pending, async () => {
      await assert.rejects(checkAdmission(pending), admissionConflict,
        'A private matching grant must never override an existing reservation.');
      await assert.rejects(persistence.ensureCollaborationState({ ...pending,
        initialContent: 'reserved bytes must not be initialized\n' }), admissionConflict,
      'The real initializer must preserve pending-reservation admission under a matching grant.');
    }));
    assert.equal((await control.query(`SELECT count(*)::int AS count FROM ${table} WHERE document_id=$1`, [pending.documentId])).rows[0].count, 0);
    await admission.cancel(request, reserved.revision);

    // A promise that inherited ALS cannot reuse the grant after its callback returns, even while the outer lease remains active.
    activeStage = 'detached callback after grant lifetime';
    const afterGrant = scope('after-grant.md');
    const grantFinished = barrier();
    gates.push(grantFinished);
    let inheritedAfterGrant!: Promise<void>;
    await guard([afterGrant.path], async () => {
      await withWorkspaceFileLifecycleCollaborationWrite(afterGrant, async () => {
        inheritedAfterGrant = (async () => {
          await grantFinished.promise;
          await assert.rejects(hasVerifiedWorkspaceFileLifecycleCollaborationWrite(afterGrant), admissionConflict);
          await assert.rejects(checkAdmission(afterGrant), admissionConflict);
        })();
        void inheritedAfterGrant.catch(() => undefined);
      });
      grantFinished.resolve();
      await within(inheritedAfterGrant, 'Detached callback after scoped grant completion');
    });

    // The PG reply is real and says "held", but arrives after the private grant callback has completed.
    // Delay only delivery of that reply to reproduce lifetime invalidation during an awaited verification.
    activeStage = 'grant completion during in-flight PG verification';
    const grantRace = scope('grant-verification-race.md');
    const grantQueryCompleted = barrier(), deliverGrantReply = barrier();
    gates.push(grantQueryCompleted, deliverGrantReply);
    let pauseGrantReply = false;
    const delayedGrantConnection = async (): Promise<SqlConnection> => {
      const database = await openConnection();
      return { ...database, get: async (sql, params) => {
        const result = await database.get(sql, params);
        if (pauseGrantReply && sql.includes('pg_locks') && sql.includes('pid = pg_backend_pid()')) {
          pauseGrantReply = false;
          assert.equal((result as { held: boolean }).held, true, 'Delay a successful real PG holder verification.');
          grantQueryCompleted.resolve();
          await deliverGrantReply.promise;
        }
        return result;
      } };
    };
    let inFlightGrantWriter!: Promise<void>;
    await guard([grantRace.path], async () => {
      await withWorkspaceFileLifecycleCollaborationWrite(grantRace, async () => {
        pauseGrantReply = true;
        inFlightGrantWriter = checkAdmission(grantRace);
        void inFlightGrantWriter.catch(() => undefined);
        await within(grantQueryCompleted.promise, 'Real PG verification before grant completion');
      });
      deliverGrantReply.resolve();
      await assert.rejects(within(inFlightGrantWriter, 'Writer reply after grant completion'), admissionConflict,
        'A previously successful PG reply cannot revive an expired private grant.');
    }, delayedGrantConnection);

    // Independently verify that the actual guard lease does not return an old "held" result after it ends.
    activeStage = 'outer lease completion during in-flight PG verification';
    const leaseRace = scope('lease-verification-race.md');
    const leaseQueryCompleted = barrier(), deliverLeaseReply = barrier();
    gates.push(leaseQueryCompleted, deliverLeaseReply);
    let pauseLeaseReply = false;
    const delayedLeaseConnection = async (): Promise<SqlConnection> => {
      const database = await openConnection();
      return { ...database, get: async (sql, params) => {
        const result = await database.get(sql, params);
        if (pauseLeaseReply && sql.includes('pg_locks') && sql.includes('pid = pg_backend_pid()')) {
          pauseLeaseReply = false;
          assert.equal((result as { held: boolean }).held, true, 'Delay the actual lease holder reply.');
          leaseQueryCompleted.resolve();
          await deliverLeaseReply.promise;
        }
        return result;
      } };
    };
    let inFlightLeaseVerification!: Promise<boolean>;
    await guard([leaseRace.path], async () => {
      const actualLease = getWorkspaceFileLifecycleLeases()?.get(workspaceId);
      assert.ok(actualLease, 'Read the guard-created lease, never a fabricated context.');
      pauseLeaseReply = true;
      inFlightLeaseVerification = actualLease.verify();
      void inFlightLeaseVerification.catch(() => undefined);
      await within(leaseQueryCompleted.promise, 'Real PG verification before outer completion');
    }, delayedLeaseConnection);
    deliverLeaseReply.resolve();
    assert.equal(await within(inFlightLeaseVerification, 'Lease reply after outer completion'), false,
      'A guard that closed while verification was in flight cannot revive its authority.');

    // The same protection applies once the outer holder ends and a new independent holder owns its key.
    activeStage = 'detached callback after outer lease lifetime';
    const afterLease = scope('after-lease.md');
    const outerFinished = barrier();
    gates.push(outerFinished);
    let inheritedAfterLease!: Promise<void>;
    await guard([afterLease.path], () => withWorkspaceFileLifecycleCollaborationWrite(afterLease, async () => {
      inheritedAfterLease = (async () => {
        await outerFinished.promise;
        await assert.rejects(hasVerifiedWorkspaceFileLifecycleCollaborationWrite(afterLease), admissionConflict);
        await assert.rejects(checkAdmission(afterLease), admissionConflict);
      })();
      void inheritedAfterLease.catch(() => undefined);
    }));
    await blocker.query('SELECT pg_advisory_lock($1::bigint)', [collaborationAdmissionLockKey(workspaceId)]);
    try {
      outerFinished.resolve();
      await within(inheritedAfterLease, 'Detached callback after outer lease completion');
    } finally { await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [collaborationAdmissionLockKey(workspaceId)]); }

    // Terminate only our own dedicated PG guard backend. A stale ALS entry must not bypass a replacement holder.
    activeStage = 'terminated dedicated guard holder';
    const lost = scope('lost.md');
    let lostGuardPid = 0;
    const lostConnection = async () => {
      const database = await openConnection();
      lostGuardPid = Number((await database.get('SELECT pg_backend_pid() AS pid') as { pid: number }).pid);
      return database;
    };
    await guard([lost.path], () => withWorkspaceFileLifecycleCollaborationWrite(lost, async () => {
      assert.equal(await hasVerifiedWorkspaceFileLifecycleCollaborationWrite(lost), true);
      assert.ok(lostGuardPid > 0 && lostGuardPid !== guardPid);
      const terminated = (await control.query('SELECT pg_terminate_backend($1) AS terminated', [lostGuardPid])).rows[0];
      assert.equal(terminated.terminated, true);
      await blocker.query('SELECT pg_advisory_lock($1::bigint)', [collaborationAdmissionLockKey(workspaceId)]);
      try {
        await assert.rejects(hasVerifiedWorkspaceFileLifecycleCollaborationWrite(lost), admissionConflict);
        await assert.rejects(checkAdmission(lost), admissionConflict);
      } finally { await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [collaborationAdmissionLockKey(workspaceId)]); }
    }), lostConnection);

    // Ordinary admission remains live after all temporary leases and failed attempts are gone.
    activeStage = 'ordinary writer recovery';
    await checkAdmission(scope('ordinary-after.md'), false);
    console.log('File lifecycle writer admission PostgreSQL: passed (real initialization/owner/persist/release and exact receipt/advisory vacancy proof across separate sessions; strict foreign and seven-dimension mismatch fences; pending reservation; expired grant/outer context including delayed real PG verification replies; terminated dedicated holder and ordinary recovery).');
  } finally {
    for (const gate of gates) gate.resolve();
    await owner?.close();
    for (const client of clients) await client.end();
    for (const document of documents) document.destroy();
    await pool?.end();
    if (schemaCreated && SCHEMA_PATTERN.test(schema)) await control.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
    await control.end();
    await Database.closeDatabaseConnections();
    if (previousData === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousData;
    await rm(temporaryData, { recursive: true, force: true });
  }
}

run(managedDatabaseUrl()).catch(error => {
  console.error(`${activeStage}: ${String(error instanceof Error ? error.message : 'Scoped writer PostgreSQL regression failed.')}`
    .replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    .replace(/password\s*=\s*\S+/giu, 'password=[redacted]'));
  process.exitCode = 1;
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, Pool } from 'pg';
import ts from 'typescript';

import * as Database from '../app/lib/db';
import type { SqlConnection } from '../app/lib/db';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import { COLLABORATION_ROOM_OWNER_UP_SQL, COLLABORATION_ROOM_RELEASE_UP_SQL } from '../app/lib/db/collaboration-room-owner-migration';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import type * as Persistence from '../app/lib/collaboration/persistence';
import { createCollaborationAdmissionService } from '../app/lib/collaboration/room-admission';
import { collaborationAdmissionActionDigest, collaborationAdmissionLockKey, type CollaborationAdmissionDocument, type CollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { CollaborationRoomOwnerError, createCollaborationRoomOwnerSession, lockIdentity, type CollaborationRoomOwnerScope } from '../app/lib/collaboration/room-owner';
import { installCollaborationRoomInspector } from '../app/lib/collaboration/runtime-state';
import { Y } from '../app/lib/collaboration/server-runtime';
import { assertWorkspaceFileLifecycleSqlAvailable, withWorkspaceFileLifecycleGuard, WorkspaceFileLifecycleBusyError } from '../app/lib/files/workspace-file-lifecycle-guard';
import { withWorkspaceMutationLock } from '../app/lib/files/workspace-mutation-lock';

const schemaPattern = /^canvas_lifecycle_guard_test_[a-f0-9]{32}$/u;

function managedUrl(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  let url: URL;
  try { url = new URL(process.env.DATABASE_URL); } catch { throw new Error('Invalid managed PostgreSQL test configuration.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)
    || url.port !== '55433' || url.pathname !== '/canvas_notebook') throw new Error('Only managed loopback PostgreSQL at 55433/canvas_notebook is accepted.');
  return url;
}

/** Replace only the database checkout; every merge, owner fence and persistence query is production code. */
async function persistenceInSchema(openDb: () => Promise<SqlConnection>): Promise<typeof Persistence> {
  const filename = path.resolve('app/lib/collaboration/persistence.ts');
  const load = createRequire(filename);
  const source = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const compiledModule = { exports: {} };
  new Function('require', 'module', 'exports', source)(
    (name: string) => name === '@/app/lib/db' ? { ...Database, openDb } : load(name), compiledModule, compiledModule.exports,
  );
  return compiledModule.exports as typeof Persistence;
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(operation: Promise<T>, label: string, milliseconds = 4_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its bounded deadline.`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function run(url: URL) {
  const schema = `canvas_lifecycle_guard_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, schemaPattern);
  const namespace = `"${schema}"`;
  const configuration = { connectionString: url.href, connectionTimeoutMillis: 3_000,
    options: '-c statement_timeout=10000 -c lock_timeout=4000' };
  const control = new Client(configuration);
  await control.connect();
  let pool: Pool | undefined;
  let owner: Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>> | undefined;
  const clients: Client[] = [];
  const documents: Array<InstanceType<typeof Y.Doc>> = [];
  const gates: Array<ReturnType<typeof barrier>> = [];
  const directory = await mkdtemp(path.join(tmpdir(), 'canvas-lifecycle-guard-'));
  const previousData = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = directory;
  const busy = (error: unknown) => error instanceof WorkspaceFileLifecycleBusyError && error.code === 'COLLABORATION_FILE_LIFECYCLE_BUSY';
  try {
    await control.query(`CREATE SCHEMA ${namespace}`);
    await control.query(`CREATE TABLE ${namespace}.collaboration_yjs_states (LIKE public.collaboration_yjs_states INCLUDING ALL)`);
    const scoped = { ...configuration, options: `${configuration.options} -c search_path=${schema}` };
    const migration = new Client(scoped);
    await migration.connect();
    try {
      await migration.query(COLLABORATION_ROOM_OWNER_UP_SQL);
      await migration.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
      for (const statement of COLLABORATION_ADMISSION_STATEMENTS) await migration.query(statement);
    } finally { await migration.end(); }
    pool = new Pool({ ...scoped, max: 8 });
    const openConnection = async (): Promise<SqlConnection> => {
      const client = await pool!.connect();
      // This test deliberately terminates only its own borrowed guard backend.
      client.on('error', () => undefined);
      let closed = false;
      return { get: async (sql, params) => (await client.query(sql, params)).rows[0],
        all: async (sql, params) => (await client.query(sql, params)).rows,
        run: async (sql, params) => ({ changes: (await client.query(sql, params)).rowCount ?? 0 }),
        close: async error => { assert.equal(closed, false); closed = true; client.release(error); } };
    };
    const persistence = await persistenceInSchema(openConnection);
    const workspaceId = `lifecycle-guard-${randomUUID()}`;
    const table = `${namespace}.collaboration_yjs_states`;
    const seed = async (filePath: string) => {
      const documentId = `guard-${randomUUID()}`;
      const document = createPlainTextYDoc(`${filePath}:original\n`);
      documents.push(document);
      await control.query(`INSERT INTO ${table} (document_id,workspace_id,organization_id,path,representation,
        lifecycle_generation,schema_version,yjs_state,state_vector,document_sequence,persisted_at,newline_style,has_bom,degraded,status)
        VALUES ($1,$2,NULL,$3,'plain_text',1,1,$4,$5,1,$6,'lf',0,0,'active')`,
      [documentId, workspaceId, filePath, Buffer.from(Y.encodeStateAsUpdate(document)), Buffer.from(Y.encodeStateVector(document)), Date.now()]);
      const physicalPath = path.join(directory, filePath);
      await mkdir(path.dirname(physicalPath), { recursive: true });
      await writeFile(physicalPath, document.getText('content').toString());
      const scope: CollaborationRoomOwnerScope = { documentId, workspaceId, organizationId: null,
        path: filePath, representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1 };
      return { document, scope, physicalPath };
    };
    const target = await seed('source/target.txt');
    const sentinel = await seed('sentinel.txt');
    const closed = await seed('closed.txt');
    const ownerClient = new Client(scoped);
    await ownerClient.connect();
    owner = await createCollaborationRoomOwnerSession(ownerClient);
    const targetFence = await owner.acquire(target.scope);
    const sentinelFence = await owner.acquire(sentinel.scope);
    const guard = <T>(paths: readonly string[], operation: () => Promise<T>) =>
      withWorkspaceFileLifecycleGuard({ workspaceId, paths }, operation, openConnection);
    let sentinelSequence = 1;
    const saveSentinel = async (probe = true) => {
      sentinel.document.getText('content').insert(sentinel.document.getText('content').length, `saved-${sentinelSequence}\n`);
      const saved = await persistence.persistCollaborationYDoc(sentinel.scope.documentId, 1, sentinel.document, sentinel.scope, sentinelFence);
      assert.equal(saved.documentSequence, ++sentinelSequence);
      const row = (await control.query(`SELECT yjs_state FROM ${table} WHERE document_id=$1`, [sentinel.scope.documentId])).rows[0];
      const reconstructed = new Y.Doc();
      try { Y.applyUpdate(reconstructed, row.yjs_state); assert.equal(reconstructed.getText('content').toString(), sentinel.document.getText('content').toString()); }
      finally { reconstructed.destroy(); }
      if (probe) { owner!.assertActive(sentinelFence); await owner!.probe(); }
    };
    const original = await readFile(target.physicalPath, 'utf8');
    const physicalActions: Array<[string, () => Promise<unknown>]> = [
      ['rename', () => rename(target.physicalPath, path.join(directory, 'renamed.txt'))],
      ['move', () => rename(target.physicalPath, path.join(directory, 'moved.txt'))],
      ['trash', () => rm(target.physicalPath)],
      ['restore replacement', () => writeFile(target.physicalPath, 'restored bytes')],
      ['copy replacement', () => copyFile(closed.physicalPath, target.physicalPath)],
    ];
    for (const [name, action] of physicalActions) {
      let called = false;
      await assert.rejects(guard([target.scope.path], async () => { called = true; await action(); }), busy, `${name}: active owner must refuse before filesystem work.`);
      assert.equal(called, false);
      assert.equal(await readFile(target.physicalPath, 'utf8'), original);
      await saveSentinel();
    }
    await assert.rejects(guard(['source'], async () => assert.fail('Subtree with an owned descendant must not mutate.')), busy);
    await assert.rejects(guard([''], async () => assert.fail('Workspace-root scope must include active rooms.')), busy);
    assert.equal(await guard(['source-sibling'], async () => 'disjoint'), 'disjoint', 'Path-prefix siblings are not descendants.');

    const admission = createCollaborationAdmissionService({ openConnection });
    const reserve = async (filePath: string, kind: 'exact' | 'subtree') => {
      const actionPayloadText = JSON.stringify({ fixture: randomUUID() });
      const rows = (await control.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND status='active'
        AND (path=$2 OR ($3='subtree' AND ($2='' OR left(path,length($2)+1)=$2||'/')))`, [workspaceId, filePath, kind])).rows;
      const expectedDocuments: CollaborationAdmissionDocument[] = rows.map(row => ({ documentId: row.document_id,
        workspaceId, organizationId: null, path: row.path, representation: row.representation,
        lifecycleGeneration: Number(row.lifecycle_generation), schemaVersion: Number(row.schema_version), status: 'active' }));
      const request: CollaborationAdmissionRequest = { requestId: randomUUID(), actorId: 'guard-actor', action: 'rename',
        actionPayloadText, actionDigest: collaborationAdmissionActionDigest('rename', actionPayloadText),
        scopes: [{ workspaceId, organizationId: null, path: filePath, kind }], expectedDocuments };
      const result = await admission.reserve(request);
      return { request, revision: result.revision };
    };
    for (const [reservedPath, kind, deniedPath] of [
      ['pending/file.txt', 'exact', 'pending/file.txt'],
      ['pending/file.txt', 'exact', 'pending'],
      ['pending', 'subtree', 'pending/new.txt'],
      ['', 'subtree', 'any/new.txt'],
    ] as const) {
      const reservation = await reserve(reservedPath, kind);
      await assert.rejects(guard([deniedPath], async () => assert.fail('Pending admission must block the physical callback.')), busy);
      await saveSentinel();
      await admission.cancel(reservation.request, reservation.revision);
      assert.equal(await guard([deniedPath], async () => 'released'), 'released');
    }

    const corrupt = await seed('partial-owner.txt');
    await control.query(`UPDATE ${table} SET room_owner_backend_pid=pg_backend_pid() WHERE document_id=$1`, [corrupt.scope.documentId]);
    await assert.rejects(guard([corrupt.scope.path], async () => assert.fail('A partial owner tuple must fail closed.')), busy);
    await control.query(`UPDATE ${table} SET room_owner_backend_pid=NULL WHERE document_id=$1`, [corrupt.scope.documentId]);
    const held = await seed('held-key.txt');
    const holder = new Client(scoped); clients.push(holder); await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1::bigint)', [lockIdentity(held.scope.documentId).key]);
    await assert.rejects(guard([held.scope.path], async () => assert.fail('Held room key must block even with a null owner tuple.')), busy);
    await holder.query('SELECT pg_advisory_unlock($1::bigint)', [lockIdentity(held.scope.documentId).key]);
    const releaseInspector = installCollaborationRoomInspector(documentId => documentId === held.scope.documentId ? 1 : 0);
    try { await assert.rejects(guard([held.scope.path], async () => assert.fail('Retained local startup must block.')), busy); }
    finally { releaseInspector(); }

    const closedFence = await owner.acquire(closed.scope);
    await owner.release(closedFence, { releaseId: randomUUID(), yjsState: Y.encodeStateAsUpdate(closed.document), stateVector: Y.encodeStateVector(closed.document) });
    const releasedRow = (await control.query(`SELECT room_owner_epoch,room_owner_token FROM ${table} WHERE document_id=$1`, [closed.scope.documentId])).rows[0];
    assert.equal(Number(releasedRow.room_owner_epoch), 1);
    assert.equal(releasedRow.room_owner_token, null);
    await guard([closed.scope.path, 'closed-renamed.txt'], async () => {
      await rename(closed.physicalPath, path.join(directory, 'closed-renamed.txt'));
      const database = await openConnection();
      try {
        await database.run('BEGIN');
        await assertWorkspaceFileLifecycleSqlAvailable(database, workspaceId, [closed.scope.path, 'closed-renamed.txt']);
        await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1', [closed.scope.documentId, 'closed-renamed.txt']);
        await database.run('COMMIT');
      } finally { await database.close(); }
    });
    await assert.rejects(owner.acquire(closed.scope), error => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_SCOPE_CHANGED');
    await saveSentinel();
    const renamedFence = await owner.acquire({ ...closed.scope, path: 'closed-renamed.txt' });
    await owner.release(renamedFence, { releaseId: randomUUID(), yjsState: Y.encodeStateAsUpdate(closed.document), stateVector: Y.encodeStateVector(closed.document) });
    await guard(['closed-renamed.txt', 'closed-copy.txt'], async () => copyFile(path.join(directory, 'closed-renamed.txt'), path.join(directory, 'closed-copy.txt')));
    await guard(['closed-copy.txt'], async () => rename(path.join(directory, 'closed-copy.txt'), path.join(directory, 'closed-trash.txt')));
    await guard(['closed-copy.txt'], async () => rename(path.join(directory, 'closed-trash.txt'), path.join(directory, 'closed-copy.txt')));
    assert.equal(await readFile(path.join(directory, 'closed-copy.txt'), 'utf8'), closed.document.getText('content').toString());

    // Keep the dedicated PG guard through physical and metadata work: an old authenticated scope must lose to the rename.
    const racy = await seed('racy.txt');
    const entered = barrier(), finish = barrier(); gates.push(entered, finish);
    const renameInFlight = guard([racy.scope.path, 'racy-renamed.txt'], async () => {
      entered.resolve(); await finish.promise;
      await rename(racy.physicalPath, path.join(directory, 'racy-renamed.txt'));
      await control.query(`UPDATE ${table} SET path='racy-renamed.txt' WHERE document_id=$1`, [racy.scope.documentId]);
    });
    await within(entered.promise, 'Guard entry');
    let settled = false;
    const staleClaim = owner.acquire(racy.scope).finally(() => { settled = true; });
    void staleClaim.catch(() => {});
    await new Promise<void>(done => setTimeout(done, 50));
    assert.equal(settled, false, 'Owner claim may not cross the workspace guard during physical work.');
    finish.resolve(); await within(renameInFlight, 'Guarded rename');
    await assert.rejects(staleClaim, error => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_SCOPE_CHANGED');
    await saveSentinel();

    // Kernel-first wrappers do not retain PG authority while queued behind a legacy local-first writer.
    const localEntered = barrier(), trySql = barrier(); gates.push(localEntered, trySql);
    const localFirst = withWorkspaceMutationLock(workspaceId, async () => {
      localEntered.resolve(); await trySql.promise;
      const database = await openConnection();
      try { await database.run('BEGIN'); await assertWorkspaceFileLifecycleSqlAvailable(database, workspaceId, ['free.txt']); }
      finally { await database.run('ROLLBACK'); await database.close(); }
    });
    await within(localEntered.promise, 'Legacy local lock');
    let pgHeld = false;
    const observedConnection = async () => {
      const database = await openConnection();
      return { ...database, get: async (sql: string, params?: unknown[]) => {
        const result = await database.get(sql, params);
        if (sql.includes('pg_try_advisory_lock') && (result as { locked?: boolean })?.locked) pgHeld = true;
        return result;
      } };
    };
    const guardedNext = withWorkspaceFileLifecycleGuard({ workspaceId, paths: ['free.txt'] }, async () => 'completed', observedConnection);
    await new Promise<void>(done => setTimeout(done, 50));
    assert.equal(pgHeld, false, 'A waiting lifecycle wrapper must not own the PG workspace key.');
    trySql.resolve();
    await within(localFirst, 'Legacy SQL completion');
    assert.equal(await within(guardedNext, 'Wrapper after local release'), 'completed');
    assert.equal(pgHeld, true);
    assert.equal(await guard(['free.txt'], () => guard(['free.txt'], async () => 'nested')), 'nested');

    // Kill only this test's dedicated PG guard backend after the physical step.
    // The kernel fence must still exclude new owners/reservations until metadata is complete.
    const lost = await seed('lost-during-fs.txt');
    const lostEntered = barrier(), metadataFinish = barrier(); gates.push(lostEntered, metadataFinish);
    let guardBackend = 0;
    const lossConnection = async () => {
      const database = await openConnection();
      guardBackend = Number((await database.get('SELECT pg_backend_pid() AS pid') as { pid: number }).pid);
      assert.ok(guardBackend > 0 && guardBackend !== sentinelFence.backendPid);
      return database;
    };
    const lossBlocker = new Client(scoped); clients.push(lossBlocker); await lossBlocker.connect();
    const lostGuard = withWorkspaceFileLifecycleGuard({ workspaceId, paths: [lost.scope.path, 'lost-renamed.txt'] }, async () => {
      await rename(lost.physicalPath, path.join(directory, 'lost-renamed.txt'));
      assert.equal((await control.query('SELECT pg_terminate_backend($1) AS terminated', [guardBackend])).rows[0].terminated, true);
      await lossBlocker.query('SELECT pg_advisory_lock($1::bigint)', [collaborationAdmissionLockKey(workspaceId)]);
      const refusedMetadata = await openConnection();
      try {
        await refusedMetadata.run('BEGIN');
        await assert.rejects(assertWorkspaceFileLifecycleSqlAvailable(refusedMetadata, workspaceId, [lost.scope.path, 'lost-renamed.txt']), busy,
          'A lost PG lease must not authorize an ALS bypass of a different workspace holder.');
      } finally { await refusedMetadata.run('ROLLBACK'); await refusedMetadata.close(); }
      await lossBlocker.query('SELECT pg_advisory_unlock($1::bigint)', [collaborationAdmissionLockKey(workspaceId)]);
      lostEntered.resolve(); await metadataFinish.promise;
      const metadata = await openConnection();
      try {
        await metadata.run('BEGIN');
        await assertWorkspaceFileLifecycleSqlAvailable(metadata, workspaceId, [lost.scope.path, 'lost-renamed.txt']);
        await metadata.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1', [lost.scope.documentId, 'lost-renamed.txt']);
        await metadata.run('COMMIT');
      } finally { await metadata.close(); }
    }, lossConnection);
    void lostGuard.catch(() => {});
    await within(lostEntered.promise, 'Lost guard callback');
    const actionPayloadText = JSON.stringify({ fixture: randomUUID(), phase: 'after-lost-guard' });
    const freshRequest: CollaborationAdmissionRequest = { requestId: randomUUID(), actorId: 'guard-actor', action: 'rename', actionPayloadText,
      actionDigest: collaborationAdmissionActionDigest('rename', actionPayloadText),
      scopes: [{ workspaceId, organizationId: null, path: 'lost-renamed.txt', kind: 'exact' }],
      expectedDocuments: [{ ...lost.scope, path: 'lost-renamed.txt', status: 'active' }] };
    let ownerSettled = false, reserveSettled = false;
    const competingOwner = owner.acquire(lost.scope).finally(() => { ownerSettled = true; });
    const competingReservation = admission.reserve(freshRequest).finally(() => { reserveSettled = true; });
    void competingOwner.catch(() => {}); void competingReservation.catch(() => {});
    await new Promise<void>(done => setTimeout(done, 50));
    assert.equal(ownerSettled, false, 'A new owner must wait for FS and metadata even after PG guard loss.');
    assert.equal(reserveSettled, false, 'A new reservation must wait for FS and metadata even after PG guard loss.');
    await saveSentinel(false);
    metadataFinish.resolve(); await within(lostGuard, 'FS and metadata after guard backend loss');
    await assert.rejects(competingOwner, error => error instanceof CollaborationRoomOwnerError
      && ['ROOM_OWNER_SCOPE_CHANGED', 'ROOM_OWNER_BUSY'].includes(error.code));
    const freshReservation = await within(competingReservation, 'Reservation after finalization');
    assert.equal(freshReservation.status, 'reserved');
    assert.equal(freshReservation.targets[0].document.path, 'lost-renamed.txt');
    await admission.cancel(freshRequest, freshReservation.revision);
    await saveSentinel();

    // A child promise can retain ALS after the guarded callback finishes; that stale context must not bypass a new holder.
    const delayedGate = barrier(); gates.push(delayedGate);
    let delayed!: Promise<unknown>;
    let detachedCalled = false;
    await guard(['free.txt'], async () => {
      delayed = (async () => { await delayedGate.promise; return guard(['free.txt'], async () => { detachedCalled = true; }); })();
      void delayed.catch(() => {});
    });
    const blocker = new Client(scoped); clients.push(blocker); await blocker.connect();
    await blocker.query('SELECT pg_advisory_lock($1::bigint)', [collaborationAdmissionLockKey(workspaceId)]);
    try {
      delayedGate.resolve();
      await assert.rejects(within(delayed, 'Detached scope rejection'), busy);
      assert.equal(detachedCalled, false, 'An expired ALS context must reacquire authority before filesystem work.');
    } finally { await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [collaborationAdmissionLockKey(workspaceId)]); }
    await saveSentinel();
    await owner.release(targetFence, { releaseId: randomUUID(), yjsState: Y.encodeStateAsUpdate(target.document), stateVector: Y.encodeStateVector(target.document) });
    await owner.release(sentinelFence, { releaseId: randomUUID(), yjsState: Y.encodeStateAsUpdate(sentinel.document), stateVector: Y.encodeStateVector(sentinel.document) });
    console.log('File lifecycle guard PostgreSQL: passed (physical callbacks denied before FS, owned/pending/subtree/root scopes, retained/partial/advisory authority, release, stale claim, shared sentinel persistence, kernel/PG order, nested/expired ALS, own PG-backend loss during FS and competing claims/reservations).');
  } finally {
    for (const gate of gates) gate.resolve();
    await owner?.close();
    for (const client of clients) await client.end();
    for (const document of documents) document.destroy();
    await pool?.end();
    if (schemaPattern.test(schema)) await control.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
    await control.end();
    await Database.closeDatabaseConnections();
    if (previousData === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousData;
    await rm(directory, { recursive: true, force: true });
  }
}

const url = managedUrl();
if (!url) console.log('File lifecycle guard PostgreSQL: skipped (provide managed PostgreSQL environment).');
else run(url).catch(error => {
  console.error(String(error instanceof Error ? error.message : 'File lifecycle integration failed.')
    .replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]'));
  process.exitCode = 1;
});

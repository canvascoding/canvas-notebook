/** Actual PG18/lease/lock acceptance. Starts no application, browser, or container. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import * as Y from 'yjs';
import type { SqlConnection } from '../app/lib/db';
import type { CollaborationAdmissionDocument, CollaborationAdmissionRequest }
  from '../app/lib/collaboration/room-admission-contract';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { NativeFileOperationBundle } from '../app/lib/markdown/native-file-operation-handoff';

const prefix = 'canvas_borrowed_handoff_';
const schemaPattern = /^canvas_borrowed_handoff_[0-9a-f]{32}(?:_alt)?$/u;
let stage = 'private managed configuration';
let settled = false;
let completed = false;
const incomplete = (reason: string) => {
  if (!settled && !completed) {
    console.error(`Borrowed handoff PostgreSQL INCOMPLETE (${reason}) at ${stage}; resource closure is unconfirmed.`);
    process.exitCode = 1;
  }
};
process.once('beforeExit', () => incomplete('beforeExit'));
process.once('exit', () => incomplete('exit'));
const watchdog = setTimeout(() => { incomplete('watchdog'); process.exit(1); }, 180_000);
watchdog.ref();
const normalized = (sql: string) => sql.replace(/\s+/gu, ' ').trim().toUpperCase();
const transactionControl = /^(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|END|ABORT|SAVEPOINT|RELEASE)\b/u;

function quoteSchema(schema: string): string {
  assert.match(schema, schemaPattern);
  assert(schema.length <= 63);
  return `"${schema}"`;
}

async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  const envPath = process.env.CANVAS_BORROWED_HANDOFF_TEST_ENV_FILE;
  assert(envPath, 'A private managed ENV file must be selected explicitly.');
  const envStat = await lstat(envPath);
  assert(envStat.isFile() && !envStat.isSymbolicLink() && (envStat.mode & 0o077) === 0);
  const connectionString = parse(await readFile(envPath)).DATABASE_URL;
  assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook');
  assert.equal(url.search, ''); assert.equal(url.hash, '');
  const nonce = randomUUID().replaceAll('-', '');
  const schema = `${prefix}${nonce}`, alternate = `${schema}_alt`, quoted = quoteSchema(schema);
  const application = `canvas-borrowed-handoff-${nonce}`;
  const previousEnv = { ...process.env };
  const clients = new Set<Client>(), pids = new Set<number>(), asyncErrors: unknown[] = [];
  const ownedSchemas = new Map<string, { oid: string; owner: string; marker: string }>();
  const checks: string[] = [], cleanupErrors: unknown[] = [];
  let control: Client | undefined, dataRoot: string | undefined;
  let dataBirth: Awaited<ReturnType<typeof lstat>> | undefined;
  let forbiddenTransactions = 0, forbiddenCloses = 0;
  let scopeNumber = 0;
  const close = async (client: Client) => {
    if (!clients.has(client)) return;
    await client.end(); clients.delete(client);
  };
  const connect = async (label: string, scoped = true) => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 12000,
      application_name: `${application}-${label}`, options: `-c statement_timeout=10000 -c lock_timeout=4000${
        scoped ? ` -c search_path=${schema},pg_catalog` : ''}` });
    clients.add(client);
    client.on('error', error => { asyncErrors.push(error); });
    await client.connect();
    const row = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0];
    assert(Number.isSafeInteger(row.pid)); pids.add(row.pid);
    return client;
  };
  type Handle = { client: Client; route: Client; database: SqlConnection; coreDepth: number;
    trace: string[]; closeCalls: number; afterQuery?: (sql: string) => Promise<void> };
  const handle = async (label: string): Promise<Handle> => {
    const client = await connect(label);
    const captured = { client, route: client, coreDepth: 0, trace: [] as string[], closeCalls: 0 } as Handle;
    const query = async (sql: string, values: unknown[] = []) => {
      if (captured.coreDepth) {
        captured.trace.push(normalized(sql));
        if (transactionControl.test(normalized(sql))) {
          forbiddenTransactions++;
          assert.fail('The borrowed handoff must leave all transaction control to its caller.');
        }
      }
      const result = await captured.route.query(sql, values);
      // Optional actual-query acknowledgement barrier. Every statement still
      // reaches PostgreSQL; no fabricated rows or lock observations are used.
      await captured.afterQuery?.(sql);
      return result;
    };
    captured.database = Object.freeze({
      get: async (sql: string, values?: unknown[]) => (await query(sql, values)).rows[0],
      all: async (sql: string, values?: unknown[]) => (await query(sql, values)).rows,
      run: async (sql: string, values?: unknown[]) => ({ changes: (await query(sql, values)).rowCount ?? 0 }),
      close: async () => {
        captured.closeCalls++;
        if (captured.coreDepth) {
          forbiddenCloses++;
          assert.fail('The borrowed handoff must not close the caller connection.');
        }
        await close(client);
      },
    });
    return captured;
  };
  const identity = async (client: Client) => (await client.query(`SELECT pg_backend_pid() AS pid,
    extract(epoch FROM a.backend_start)::text AS start,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database,
    to_regnamespace(current_schema())::oid::text AS schema,current_setting('search_path') AS search_path,
    pg_current_xact_id()::text AS transaction FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`)).rows[0];
  const begin = (client: Client, suffix = 'ISOLATION LEVEL READ COMMITTED READ WRITE') => client.query(`BEGIN ${suffix}`);
  try {
    stage = 'actual managed PG18 and private schema';
    control = await connect('control', false);
    const realm = (await control.query(`SELECT current_database() AS name,current_user AS role,
      d.oid::text AS oid,pg_get_userbyid(d.datdba) AS owner,current_setting('server_version_num') AS version,
      to_regclass('public.collaboration_yjs_states') IS NOT NULL AS source
      FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
    assert.equal(realm.name, 'canvas_notebook'); assert.equal(realm.role, realm.owner);
    assert.equal(realm.role, decodeURIComponent(url.username));
    assert.equal(Math.floor(Number(realm.version) / 10_000), 18); assert.equal(realm.source, true);
    for (const name of [schema, alternate]) {
      await control.query(`CREATE SCHEMA ${quoteSchema(name)}`);
      const marker = `canvas.borrowed-handoff.test.v1:${nonce}:${name}`;
      await control.query(`COMMENT ON SCHEMA ${quoteSchema(name)} IS '${marker}'`);
      const binding: { oid: string; owner: string; marker: string } = (await control.query(`SELECT oid::text AS oid,nspowner::text AS owner,
        obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=$1`, [name])).rows[0];
      assert.equal(binding.marker, marker); ownedSchemas.set(name, binding);
    }
    for (const table of ['collaboration_yjs_states', 'collaboration_documents', 'file_collaboration_lineages',
      'collaboration_file_projections', 'collaboration_agent_operations', 'workspace_file_metadata',
      'workspace_file_user_states', 'file_guest_invitations', 'public_file_shares', 'file_locks']) {
      await control.query(`CREATE TABLE ${quoted}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-borrowed-handoff-'));
    await chmod(dataRoot, 0o700); dataBirth = await lstat(dataRoot);
    console.log(JSON.stringify({ diagnostic: 'borrowed-handoff-fixture', processId: process.pid,
      applicationPrefix: application, databaseOid: realm.oid, schemas: Array.from(ownedSchemas, ([name, binding]) => ({ name, ...binding })),
      dataRoot, dataDevice: dataBirth.dev, dataInode: dataBirth.ino }));
    Object.assign(process.env, { DATABASE_URL: connectionString, CANVAS_DATABASE_PROVIDER: 'postgres',
      CANVAS_POSTGRES_MODE: 'external', CANVAS_DATABASE_MIGRATIONS_COMPLETED: 'true', CANVAS_POSTGRES_VECTOR_ENABLED: 'false',
      CANVAS_MCP_DIRECT_ENABLED: 'false', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot,
      PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=10000` });
    const { reserveCollaborationAdmissionOnConnection } = await import('../app/lib/collaboration/room-admission');
    const { proveCollaborationAdmissionQuiescenceOnConnection } = await import('../app/lib/collaboration/room-admission-quiescence');
    const { executeCollaborationAdmissionHandoffOnConnection, requireCollaborationAdmissionMutationRequest,
      claimCollaborationAdmissionMutation, withCollaborationAdmissionMutation }
      = await import('../app/lib/collaboration/room-admission-handoff');
    const { collaborationAdmissionActionDigest, collaborationAdmissionLockKey, CollaborationAdmissionError }
      = await import('../app/lib/collaboration/room-admission-contract');
    const { lockIdentity, createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
    const { withWorkspaceFileLifecycleGuard } = await import('../app/lib/files/workspace-file-lifecycle-guard');
    const { getWorkspaceFileLifecycleLeases } = await import('../app/lib/collaboration/file-lifecycle-admission-context');
    const { COLLABORATION_ADMISSION_STATEMENTS } = await import('../app/lib/db/collaboration-admission-migration');
    const { COLLABORATION_ROOM_OWNER_UP_SQL, COLLABORATION_ROOM_RELEASE_UP_SQL }
      = await import('../app/lib/db/collaboration-room-owner-migration');
    const { runNativeFileOperationHandoffMigration } = await import('../app/lib/db/native-file-operation-handoff-migration');
    const { runNativeFileOperationSideEffectMigration } = await import('../app/lib/db/native-file-operation-side-effects-migration');
    const { runFileGuestTargetBindingMigration } = await import('../app/lib/db/file-guest-target-migration');
    const { runPublicFileShareTargetBindingMigration } = await import('../app/lib/db/public-file-share-target-migration');
    type Domain = Parameters<typeof executeCollaborationAdmissionHandoffOnConnection>[2];
    const migration = await connect('migration');
    await migration.query(COLLABORATION_ROOM_OWNER_UP_SQL); await migration.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
    for (const statement of COLLABORATION_ADMISSION_STATEMENTS) await migration.query(statement);
    const migrationDatabase = { run: async (sql: string, values: unknown[] = []) => ({ changes: (await migration.query(sql, values)).rowCount ?? 0 }) };
    await runNativeFileOperationHandoffMigration(migrationDatabase);
    await runFileGuestTargetBindingMigration(migrationDatabase); await runPublicFileShareTargetBindingMigration(migrationDatabase);
    await runNativeFileOperationSideEffectMigration(migrationDatabase);
    await close(migration);
    const admissionError = (...codes: InstanceType<typeof CollaborationAdmissionError>['code'][]) => (error: unknown) => {
      assert(error instanceof CollaborationAdmissionError, 'The borrowed guard must return its domain error.');
      if (codes.length) assert(codes.includes(error.code), `Unexpected admission error: ${error.code}`);
      return true;
    };
    const check = async (label: string, operation: () => Promise<void>) => {
      stage = label; await operation(); checks.push(label);
      console.log(`Borrowed handoff PG18 passed: ${label}`);
    };
    const seed = async (label: string, count = 1) => {
      const workspaceId = `borrowed-${++scopeNumber}-${nonce}`;
      const documents: CollaborationAdmissionDocument[] = [];
      for (let index = 0; index < count; index++) {
        const document: CollaborationAdmissionDocument = { documentId: `${workspaceId}-doc-${index}`, workspaceId,
          organizationId: null, path: `${label}-${index}.md`, representation: 'plain_text',
          lifecycleGeneration: 1, schemaVersion: 1, status: 'active' };
        const doc = new Y.Doc();
        try {
          doc.getText('content').insert(0, document.documentId);
          await control!.query(`INSERT INTO ${quoted}.collaboration_yjs_states(document_id,workspace_id,organization_id,path,
            representation,lifecycle_generation,schema_version,yjs_state,state_vector,document_sequence,persisted_at,
            checkpointed_at,checkpoint_sequence,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
            VALUES($1,$2,NULL,$3,'plain_text',1,1,$4,$5,0,100,100,0,NULL,NULL,'lf',0,0,'active')`,
          [document.documentId, workspaceId, document.path, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))]);
        } finally { doc.destroy(); }
        documents.push(document);
      }
      const destinations = documents.map(document => `moved-${document.path}`);
      const actionPayloadText = JSON.stringify({ destinations });
      const request: CollaborationAdmissionRequest = { requestId: randomUUID(), actorId: `actor-${nonce}`, action: 'move',
        actionPayloadText, actionDigest: collaborationAdmissionActionDigest('move', actionPayloadText),
        scopes: [...documents.map(document => document.path), ...destinations].map(filePath => ({ workspaceId,
          organizationId: null, path: filePath, kind: 'exact' as const })), expectedDocuments: documents };
      return { request, documents, destinations, workspaceId };
    };
    type Scenario = Awaited<ReturnType<typeof seed>>;
    const row = async (documentId: string, client = control!) => (await client.query(
      `SELECT * FROM ${quoted}.collaboration_yjs_states WHERE document_id=$1`, [documentId])).rows[0];
    const header = async (scenario: Scenario) => (await control!.query(
      `SELECT * FROM ${quoted}.collaboration_admission_requests WHERE request_id=$1`, [scenario.request.requestId])).rows[0];
    const rawSessionLocks = async (captured: Handle, scenario: Scenario, workspace = true, rooms = true) => {
      if (workspace) await captured.client.query('SELECT pg_advisory_lock($1::bigint)', [collaborationAdmissionLockKey(scenario.workspaceId)]);
      if (rooms) for (const doc of scenario.documents) await captured.client.query('SELECT pg_advisory_lock($1::bigint)', [lockIdentity(doc.documentId).key]);
    };
    const reserve = async (captured: Handle, scenario: Scenario, beforeReserve?: (captured: Handle) => Promise<void>) => {
      await begin(captured.client);
      const before = await identity(captured.client);
      await beforeReserve?.(captured);
      const admission = await reserveCollaborationAdmissionOnConnection(captured.database, scenario.request);
      for (const doc of scenario.documents) {
        const proof = await proveCollaborationAdmissionQuiescenceOnConnection(captured.database, scenario.request, doc.documentId);
        assert.equal(proof.kind, 'vacant');
      }
      assert.deepEqual(await identity(captured.client), before);
      assert.equal(admission.status, 'reserved'); assert.equal(await header(scenario), undefined);
      await captured.client.query('COMMIT');
      assert.equal((await header(scenario)).status, 'draining');
      return before;
    };
    const invoke = async (captured: Handle, scenario: Scenario, domain: Domain) => {
      captured.coreDepth++;
      try { return await executeCollaborationAdmissionHandoffOnConnection(captured.database, scenario.request, domain); }
      finally { captured.coreDepth--; }
    };
    const apply = (scenario: Scenario, overrides: Partial<Extract<Domain, { kind: 'apply' }>> = {}): Domain => ({
      kind: 'apply', authorize: async request => { assert.equal(request.requestId, scenario.request.requestId); },
      prepare: async database => { assert.throws(() => requireCollaborationAdmissionMutationRequest(database, 'move'), admissionError('ADMISSION_RECOVERY_REQUIRED')); },
      mutate: async database => {
        assert.equal(requireCollaborationAdmissionMutationRequest(database, 'move').requestId, scenario.request.requestId);
        for (const [index, doc] of scenario.documents.entries()) {
          const current = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [doc.documentId]) as Record<string, unknown> | undefined;
          assert(current); claimCollaborationAdmissionMutation(database, 'move', current);
          await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1', [doc.documentId, scenario.destinations[index]]);
        }
        return { destinationPath: scenario.destinations[0] };
      }, ...overrides,
    });
    const guarded = async <T>(scenario: Scenario, operation: (captured: Handle) => Promise<T>,
      beforeReserve?: (captured: Handle) => Promise<void>) => {
      const captured = await handle(`guard-${scopeNumber}`);
      let opens = 0;
      try {
        return await withWorkspaceFileLifecycleGuard({ workspaceId: scenario.workspaceId,
          paths: scenario.request.scopes.map(scope => scope.path) }, async () => {
          assert.equal(opens, 1);
          const lease = getWorkspaceFileLifecycleLeases()?.get(scenario.workspaceId);
          assert(lease?.active); assert.equal(await lease.verify(), true);
          await rawSessionLocks(captured, scenario, false);
          await reserve(captured, scenario, beforeReserve);
          return operation(captured);
        }, async () => { opens++; assert.equal(opens, 1); return captured.database; });
      } finally {
        assert.equal(captured.coreDepth, 0); assert.equal(captured.closeCalls, 1);
        await close(captured.client);
      }
    };
    const assertPending = async (scenario: Scenario) => {
      const value = await header(scenario);
      assert.equal(value.status, 'draining'); assert.equal(value.outcome_text, null);
      const targets = (await control!.query(`SELECT status,active,outcome_snapshot_text FROM ${quoted}.collaboration_admission_targets
        WHERE request_id=$1 ORDER BY document_id`, [scenario.request.requestId])).rows;
      assert.equal(targets.length, scenario.documents.length);
      for (const target of targets) {
        assert.equal(target.status, 'released'); assert.equal(target.active, true); assert.equal(target.outcome_snapshot_text, null);
      }
    };

    let committedScenario: Scenario | undefined;
    let committedOutcome: Awaited<ReturnType<typeof executeCollaborationAdmissionHandoffOnConnection>> | undefined;
    await check('real B1 commit, retained session fences, B2 same B and exact callback authority', async () => {
      const scenario = await seed('positive', 2); committedScenario = scenario;
      const originalRows = await Promise.all(scenario.documents.map(doc => row(doc.documentId)));
      let retainedDatabase: SqlConnection | undefined, retainedAssert: (() => void) | undefined;
      let mutationCalls = 0;
      committedOutcome = await guarded(scenario, async captured => {
        // No file projection is touched in this intentional B1-to-B2 gap.
        assert.equal((await captured.client.query('SELECT 1 AS boundary')).rows[0].boundary, 1);
        const peer = await connect('positive-lock-probe');
        for (const key of [collaborationAdmissionLockKey(scenario.workspaceId), ...scenario.documents.map(doc => lockIdentity(doc.documentId).key)]) {
          assert.equal((await peer.query('SELECT pg_try_advisory_lock($1::bigint) AS held', [key])).rows[0].held, false);
        }
        await close(peer);
        await begin(captured.client); const before = await identity(captured.client);
        const outcome = await invoke(captured, scenario, apply(scenario, {
          mutate: async (database, proofs) => {
            mutationCalls++; assert.equal(database, captured.database); assert.equal(proofs.length, 2);
            retainedDatabase = database;
            const wrapper: SqlConnection = { ...database };
            assert.throws(() => requireCollaborationAdmissionMutationRequest(wrapper, 'move'), admissionError('ADMISSION_RECOVERY_REQUIRED'));
            await withCollaborationAdmissionMutation(database, 'move', async assertActive => {
              assertActive(); retainedAssert = assertActive;
              for (const [index, doc] of scenario.documents.entries()) {
                const current = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [doc.documentId]) as Record<string, unknown> | undefined;
                assert(current); claimCollaborationAdmissionMutation(database, 'move', current);
                await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1', [doc.documentId, scenario.destinations[index]]);
              }
            });
            return { destinationPath: scenario.destinations[0] };
          },
        }));
        assert.deepEqual(await identity(captured.client), before, 'DA04 must preserve actual B and caller XID.');
        assert.equal(captured.closeCalls, 0);
        assert.equal((await header(scenario)).status, 'draining', 'Returning an outcome does not commit it.');
        assert.throws(() => requireCollaborationAdmissionMutationRequest(retainedDatabase!, 'move'), admissionError('ADMISSION_RECOVERY_REQUIRED'));
        assert.throws(() => retainedAssert!(), admissionError('ADMISSION_RECOVERY_REQUIRED'));
        await captured.client.query('COMMIT'); return outcome;
      });
      assert.equal(mutationCalls, 1); assert(Object.isFrozen(committedOutcome));
      assert(Object.isFrozen(committedOutcome.result)); assert(Object.isFrozen(committedOutcome.targets));
      assert.equal((await header(scenario)).status, 'committed');
      for (const [index, doc] of scenario.documents.entries()) {
        const after = await row(doc.documentId);
        assert.equal(after.path, scenario.destinations[index]);
        assert.deepEqual(after.yjs_state, originalRows[index].yjs_state); assert.deepEqual(after.state_vector, originalRows[index].state_vector);
        assert.equal(after.room_owner_epoch, originalRows[index].room_owner_epoch);
      }
      assert.throws(() => retainedAssert!(), admissionError('ADMISSION_RECOVERY_REQUIRED'));
    });

    await check('fresh vacant 52 unchanged and 2 changed rows retain full actual-B outcomes', async () => {
      const scenario = await seed('vacant-postrow', 54);
      const destinations = new Map(scenario.documents.map((document, index) => [document.documentId, scenario.destinations[index]]));
      scenario.documents.sort((left, right) => Buffer.compare(Buffer.from(left.documentId), Buffer.from(right.documentId)));
      scenario.destinations.splice(0, scenario.destinations.length, ...scenario.documents.map(document => destinations.get(document.documentId)!));
      scenario.request = { ...scenario.request, scopes: [{ workspaceId: scenario.workspaceId, organizationId: null, path: '', kind: 'subtree' }] };
      const originals = await Promise.all(scenario.documents.map(document => row(document.documentId)));
      const { captureCollaborationAdmissionRequest } = await import('../app/lib/collaboration/room-admission-contract');
      const { captureCollaborationAdmissionOutcomeSnapshot } = await import('../app/lib/collaboration/room-admission-outcome');
      const canonical = captureCollaborationAdmissionRequest(scenario.request);
      const outcome = await guarded(scenario, async captured => {
        await begin(captured.client); const before = await identity(captured.client);
        const startedAt = performance.now();
        const observed = await invoke(captured, scenario, apply(scenario, { mutate: async (database, proofs) => {
          assert.equal(proofs.length, 54);
          for (const [index, proof] of proofs.entries()) {
            assert.equal(proof.kind, 'vacant'); assert(Object.isFrozen(proof));
            const facts = JSON.parse(proof.proofText);
            assert.equal(facts.current.document.documentId, scenario.documents[index].documentId);
            assert.equal(facts.current.ownerEpoch, 0); assert.equal(facts.current.ownerToken, null);
          }
          for (const index of [0, 1]) await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1',
            [scenario.documents[index].documentId, scenario.destinations[index]]);
          return { destinationPath: scenario.destinations[0] };
        } }));
        console.log(JSON.stringify({ diagnostic: 'vacant-postrow-actual', targets: 54, unchanged: 52, changed: 2, elapsedMs: Math.round(performance.now() - startedAt) }));
        assert.deepEqual(await identity(captured.client), before);
        const rereads = captured.trace.filter(sql => sql === 'SELECT * FROM COLLABORATION_YJS_STATES WHERE DOCUMENT_ID = $1 FOR UPDATE');
        assert.equal(rereads.length, 108, 'All 54 genuine proof reads and all 54 genuine post-mutation row reads remain.');
        for (const [index, document] of scenario.documents.entries()) {
          const actual = await row(document.documentId, captured.client);
          assert.deepEqual(JSON.parse(observed.targets[index].snapshotText), captureCollaborationAdmissionOutcomeSnapshot(actual, canonical),
            'The optimized outcome equals the full existing parser over actual same-B bytes.');
          if (index >= 2) assert.deepEqual(actual, originals[index]);
        }
        assert.equal((await row(scenario.documents[0].documentId, captured.client)).path, scenario.destinations[0]);
        assert.equal((await row(scenario.documents[1].documentId, captured.client)).path, scenario.destinations[1]);
        assert.equal((await header(scenario)).status, 'draining');
        await captured.client.query('COMMIT'); return observed;
      });
      assert.equal((await header(scenario)).status, 'committed'); assert.equal(outcome.targets.length, 54);
      for (const [index, document] of scenario.documents.entries()) if (index >= 2) assert.deepEqual(await row(document.documentId), originals[index]);
    });

    for (const drift of ['update', 'vector', 'scope', 'owner'] as const) await check(`fresh vacant post-row ${drift} drift retains full rejection and caller rollback`, async () => {
      const scenario = await seed('vacant-drift-' + drift), original = await row(scenario.documents[0].documentId);
      let mutations = 0;
      await guarded(scenario, async captured => {
        await begin(captured.client); const before = await identity(captured.client);
        await assert.rejects(invoke(captured, scenario, apply(scenario, { mutate: async (database, proofs) => {
          mutations++; assert.equal(proofs.length, 1); assert.equal(proofs[0].kind, 'vacant');
          assert.equal(JSON.parse(proofs[0].proofText).current.documentSequence, Number(original.document_sequence));
          if (drift === 'update' || drift === 'vector') {
            const column = drift === 'update' ? 'yjs_state' : 'state_vector';
            await database.run(`UPDATE collaboration_yjs_states SET ${column}=$2 WHERE document_id=$1`,
              [scenario.documents[0].documentId, Buffer.from([255])]);
          } else if (drift === 'scope') await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1',
            [scenario.documents[0].documentId, 'outside-reserved-scope.md']);
          else await database.run('UPDATE collaboration_yjs_states SET room_owner_epoch=1 WHERE document_id=$1',
            [scenario.documents[0].documentId]);
          return {};
        } })), admissionError(drift === 'scope' ? 'ADMISSION_INVALID_REQUEST' : 'ADMISSION_SCOPE_CHANGED'));
        assert.equal(mutations, 1, 'Fault follows the genuine same-B vacant inspection, not an invented proof.');
        assert.deepEqual(await identity(captured.client), before);
        assert.deepEqual(await row(scenario.documents[0].documentId), original);
        await captured.client.query('ROLLBACK'); await assertPending(scenario);
      });
      assert.deepEqual(await row(scenario.documents[0].documentId), original);
    });

    await check('historical retry reauthorizes without prepare, guards, mutation or owner displacement', async () => {
      assert(committedScenario && committedOutcome);
      const scenario = committedScenario;
      const ownerClient = await connect('new-legitimate-owner');
      const owner = await createCollaborationRoomOwnerSession(ownerClient);
      try {
        const fence = await owner.acquire({ ...scenario.documents[0], path: scenario.destinations[0] });
        assert(fence.epoch > 0);
        const captured = await handle('historical-retry');
        let authorizations = 0;
        try {
          assert.equal(getWorkspaceFileLifecycleLeases(), undefined);
          await begin(captured.client); const before = await identity(captured.client);
          const outcome = await invoke(captured, scenario, apply(scenario, {
            authorize: async () => { authorizations++; },
            prepare: async () => { assert.fail('Historical retry must not prepare.'); },
            mutate: async () => { assert.fail('Historical retry must not mutate.'); },
          }));
          assert.deepEqual(outcome, committedOutcome); assert.equal(authorizations, 1);
          assert.deepEqual(await identity(captured.client), before);
          assert.throws(() => requireCollaborationAdmissionMutationRequest(captured.database, 'move'), admissionError('ADMISSION_RECOVERY_REQUIRED'));
          await captured.client.query('COMMIT');
          assert.equal((await row(scenario.documents[0].documentId)).room_owner_token, fence.token);
          const revoked = new Error('fixture authorization revoked');
          await begin(captured.client);
          await assert.rejects(invoke(captured, scenario, apply(scenario, { authorize: async () => { throw revoked; } })), error => error === revoked);
          await captured.client.query('ROLLBACK');
        } finally { await close(captured.client); }
      } finally { await owner.close(); clients.delete(ownerClient); }
    });

    for (const mode of ['absent', 'read-only', 'repeatable-read'] as const) await check(`reject ${mode} caller transaction`, async () => {
      const scenario = await seed(`transaction-${mode}`);
      await guarded(scenario, async captured => {
        if (mode !== 'absent') await begin(captured.client, mode === 'read-only'
          ? 'ISOLATION LEVEL READ COMMITTED READ ONLY' : 'ISOLATION LEVEL REPEATABLE READ READ WRITE');
        let calls = 0;
        await assert.rejects(invoke(captured, scenario, apply(scenario, {
          authorize: async () => { calls++; }, prepare: async () => { calls++; }, mutate: async () => { calls++; return {}; },
        })), admissionError());
        assert.equal(calls, 0, 'Invalid caller transactions cannot invoke external callbacks.');
        if (mode !== 'absent') await captured.client.query('ROLLBACK');
        await assertPending(scenario);
      });
    });

    await check('reject missing active lifecycle lease despite real same-B workspace and room locks', async () => {
      const scenario = await seed('missing-lease'), captured = await handle('missing-lease');
      try {
        await rawSessionLocks(captured, scenario); await reserve(captured, scenario); await begin(captured.client);
        let mutations = 0;
        await assert.rejects(invoke(captured, scenario, apply(scenario, { mutate: async () => { mutations++; return {}; } })), admissionError());
        assert.equal(mutations, 0); await captured.client.query('ROLLBACK'); await assertPending(scenario);
      } finally { await close(captured.client); }
    });

    await check('reject missing room-session fence after the B1 transaction releases its proof locks', async () => {
      const scenario = await seed('missing-room');
      await guarded(scenario, async captured => {
        assert.equal((await captured.client.query('SELECT pg_advisory_unlock($1::bigint) AS released',
          [lockIdentity(scenario.documents[0].documentId).key])).rows[0].released, true);
        await begin(captured.client); let mutations = 0;
        await assert.rejects(invoke(captured, scenario, apply(scenario, { mutate: async () => { mutations++; return {}; } })), admissionError());
        assert.equal(mutations, 0); await captured.client.query('ROLLBACK'); await assertPending(scenario);
      });
    });

    await check('reject foreign B borrowing another actual lease and another B workspace fence', async () => {
      const scenario = await seed('foreign-connection');
      await guarded(scenario, async original => {
        const foreign = await handle('foreign-connection');
        try {
          assert.notEqual((await identity(foreign.client)).pid, (await identity(original.client)).pid);
          await begin(foreign.client); let mutations = 0;
          await assert.rejects(invoke(foreign, scenario, apply(scenario, { mutate: async () => { mutations++; return {}; } })), admissionError());
          assert.equal(mutations, 0); await foreign.client.query('ROLLBACK'); await assertPending(scenario);
        } finally { await close(foreign.client); }
      });
    });

    await check('reject missing same-B workspace fence before entering prepare', async () => {
      const scenario = await seed('missing-workspace');
      await guarded(scenario, async captured => {
        assert.equal((await captured.client.query('SELECT pg_advisory_unlock($1::bigint) AS released',
          [collaborationAdmissionLockKey(scenario.workspaceId)])).rows[0].released, true);
        await begin(captured.client); let prepares = 0, mutations = 0;
        await assert.rejects(invoke(captured, scenario, apply(scenario, {
          prepare: async () => { prepares++; }, mutate: async () => { mutations++; return {}; },
        })), admissionError('ADMISSION_RECOVERY_REQUIRED'));
        assert.equal(prepares, 0); assert.equal(mutations, 0);
        await captured.client.query('ROLLBACK'); await assertPending(scenario);
      });
    });

    for (const callback of ['authorize', 'prepare', 'mutate'] as const) await check(`caught nested borrowed entry poisons outer ${callback}`, async () => {
      const scenario = await seed(`nested-${callback}`);
      await guarded(scenario, async captured => {
        await begin(captured.client); let nestedCallbacks = 0, mutations = 0;
        const nested = async () => {
          await assert.rejects(invoke(captured, scenario, apply(scenario, {
            authorize: async () => { nestedCallbacks++; }, prepare: async () => { nestedCallbacks++; },
            mutate: async () => { nestedCallbacks++; return {}; },
          })), admissionError('ADMISSION_RECOVERY_REQUIRED'));
        };
        await assert.rejects(invoke(captured, scenario, apply(scenario, {
          mutate: async () => { mutations++; return {}; },
          ...(callback === 'authorize' ? { authorize: nested } : callback === 'prepare' ? { prepare: nested }
            : { mutate: async () => { mutations++; await nested(); return {}; } }),
        })), admissionError('ADMISSION_RECOVERY_REQUIRED'));
        assert.equal(nestedCallbacks, 0); assert.equal(mutations, callback === 'mutate' ? 1 : 0);
        await captured.client.query('ROLLBACK'); await assertPending(scenario);
      });
    });

    await check('detached persistence loses authority immediately when mutate returns', async () => {
      const scenario = await seed('detached-persistence');
      await guarded(scenario, async captured => {
        await begin(captured.client);
        let release!: () => void;
        const barrier = new Promise<void>(resolve => { release = resolve; });
        let detached: Promise<unknown> | undefined, retainedAssert: (() => void) | undefined;
        let returned = false, writes = 0;
        captured.afterQuery = async () => {
          if (returned) {
            // A real post-callback query would give detached work time to finish.
            // It must encounter a revoked grant even at that acknowledgement.
            release(); await detached;
          }
        };
        try {
          await assert.rejects(invoke(captured, scenario, apply(scenario, { mutate: async database => {
            detached = withCollaborationAdmissionMutation(database, 'move', async assertActive => {
              retainedAssert = assertActive; assertActive(); await barrier; assertActive();
              writes++;
              await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1',
                [scenario.documents[0].documentId, scenario.destinations[0]]);
            }).then(() => undefined, error => error);
            returned = true; return {};
          } })), admissionError('ADMISSION_RECOVERY_REQUIRED'));
          assert.throws(() => retainedAssert!(), admissionError('ADMISSION_RECOVERY_REQUIRED'));
          release(); assert(await detached instanceof CollaborationAdmissionError); assert.equal(writes, 0);
          assert.throws(() => requireCollaborationAdmissionMutationRequest(captured.database, 'move'), admissionError('ADMISSION_RECOVERY_REQUIRED'));
        } finally { captured.afterQuery = undefined; release(); await detached; }
        await captured.client.query('ROLLBACK'); await assertPending(scenario);
      });
    });

    await check('retained callback cannot start another borrowed phase after confirmed completion', async () => {
      const scenario = await seed('retained-nested');
      let release!: () => void, retained: Promise<unknown> | undefined;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      try {
        await guarded(scenario, async captured => {
          await begin(captured.client);
          await invoke(captured, scenario, apply(scenario, { mutate: async database => {
            retained = (async () => { await barrier; return invoke(captured, scenario, apply(scenario)); })()
              .then(() => undefined, error => error);
            await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1',
              [scenario.documents[0].documentId, scenario.destinations[0]]);
            return { destinationPath: scenario.destinations[0] };
          } }));
          await captured.client.query('COMMIT');
        });
        release();
        const failure = await retained;
        assert(failure instanceof CollaborationAdmissionError); assert.equal(failure.code, 'ADMISSION_RECOVERY_REQUIRED');
        assert.equal((await header(scenario)).status, 'committed');
      } finally { release(); await retained; }
    });

    for (const boundary of ['last-identity', 'lease-verify'] as const) await check(`caught nested entry at final ${boundary} acknowledgement still poisons completion`, async () => {
      const scenario = await seed(`late-poison-${boundary}`);
      await guarded(scenario, async captured => {
        await begin(captured.client);
        let completionWritten = false, injected = false, nestedCallbacks = 0, identityReplies = 0;
        captured.afterQuery = async sql => {
          const text = normalized(sql);
          if (text.startsWith('UPDATE COLLABORATION_ADMISSION_REQUESTS SET STATUS = \'COMMITTED\'')) completionWritten = true;
          if (completionWritten && text.includes('PG_CURRENT_XACT_ID_IF_ASSIGNED()')) identityReplies++;
          const selected = boundary === 'last-identity'
            ? text.includes('PG_CURRENT_XACT_ID_IF_ASSIGNED()') && identityReplies === 2
            : text.startsWith('SELECT EXISTS (SELECT 1 FROM PG_LOCKS') && text.includes('AS HELD');
          if (completionWritten && !injected && selected) {
            injected = true;
            await assert.rejects(invoke(captured, scenario, apply(scenario, {
              authorize: async () => { nestedCallbacks++; },
            })), admissionError('ADMISSION_RECOVERY_REQUIRED'));
          }
        };
        try {
          await assert.rejects(invoke(captured, scenario, apply(scenario)), admissionError('ADMISSION_RECOVERY_REQUIRED'));
          assert.equal(completionWritten, true); assert.equal(injected, true); assert.equal(nestedCallbacks, 0);
        } finally { captured.afterQuery = undefined; }
        await captured.client.query('ROLLBACK'); await assertPending(scenario);
      });
    });

    await check('same-B sibling entry during the initial real identity acknowledgement poisons both', async () => {
      const scenario = await seed('sibling-entry');
      await guarded(scenario, async captured => {
        await begin(captured.client);
        let entered!: () => void, release!: () => void, first = true, callbacks = 0;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const barrier = new Promise<void>(resolve => { release = resolve; });
        captured.afterQuery = async () => {
          if (first) { first = false; entered(); await barrier; }
        };
        const domain = apply(scenario, { authorize: async () => { callbacks++; } });
        const pending = invoke(captured, scenario, domain).then(value => ({ value }), error => ({ error }));
        try {
          await started;
          // This continuation comes from the caller, outside the first phase's
          // private async frame. Only genuine per-B ownership can reject it.
          await assert.rejects(invoke(captured, scenario, domain), admissionError('ADMISSION_RECOVERY_REQUIRED'));
        } finally { release(); }
        const result = await pending;
        captured.afterQuery = undefined;
        assert('error' in result); admissionError('ADMISSION_RECOVERY_REQUIRED')(result.error);
        assert.equal(callbacks, 0);
        await captured.client.query('ROLLBACK'); await assertPending(scenario);
        await begin(captured.client); await invoke(captured, scenario, apply(scenario)); await captured.client.query('COMMIT');
      });
    });

    for (const callback of ['authorize', 'prepare', 'mutate'] as const) await check(`reject actual transaction replacement inside ${callback}`, async () => {
      const scenario = await seed(`tx-drift-${callback}`);
      await guarded(scenario, async captured => {
        await begin(captured.client); const before = await identity(captured.client);
        let mutations = 0;
        const drift = async () => {
          await captured.client.query(callback === 'authorize' ? 'ROLLBACK' : 'COMMIT');
          await begin(captured.client);
          assert.notEqual((await identity(captured.client)).transaction, before.transaction);
        };
        const domain = apply(scenario, { mutate: async () => { mutations++; return {}; },
          ...(callback === 'authorize' ? { authorize: drift } : callback === 'prepare' ? { prepare: drift }
            : { mutate: async () => { mutations++; await drift(); return {}; } }),
        });
        await assert.rejects(invoke(captured, scenario, domain), admissionError());
        assert.equal(mutations, callback === 'mutate' ? 1 : 0);
        await captured.client.query('ROLLBACK'); await assertPending(scenario);
      });
    });

    for (const callback of ['authorize', 'prepare', 'mutate'] as const) await check(`reject actual search-path/schema drift inside ${callback}`, async () => {
      const scenario = await seed(`schema-drift-${callback}`);
      await guarded(scenario, async captured => {
        await begin(captured.client); let mutations = 0;
        const drift = async () => { await captured.client.query(`SET LOCAL search_path=${alternate},pg_catalog`); };
        await assert.rejects(invoke(captured, scenario, apply(scenario, {
          mutate: async () => { mutations++; return {}; },
          ...(callback === 'authorize' ? { authorize: drift } : callback === 'prepare' ? { prepare: drift }
            : { mutate: async () => { mutations++; await drift(); return {}; } }),
        })), admissionError());
        assert.equal(mutations, callback === 'mutate' ? 1 : 0);
        await captured.client.query('ROLLBACK'); await assertPending(scenario);
      });
    });

    await check('reject real backend replacement behind an unchanged SqlConnection object', async () => {
      const scenario = await seed('backend-drift');
      await guarded(scenario, async captured => {
        const foreign = await connect('backend-drift-peer');
        try {
          await begin(captured.client); await begin(foreign);
          assert.notEqual((await identity(captured.client)).pid, (await identity(foreign)).pid);
          let mutations = 0;
          await assert.rejects(invoke(captured, scenario, apply(scenario, {
            authorize: async () => { captured.route = foreign; }, mutate: async () => { mutations++; return {}; },
          })), admissionError());
          assert.equal(mutations, 0); captured.route = captured.client;
          await captured.client.query('ROLLBACK'); await foreign.query('ROLLBACK'); await assertPending(scenario);
        } finally { captured.route = captured.client; await close(foreign); }
      });
    });

    for (const lost of ['workspace', 'room'] as const) await check(`reject actual ${lost} fence loss after prepare`, async () => {
      const scenario = await seed(`lost-${lost}`);
      await guarded(scenario, async captured => {
        await begin(captured.client); let mutations = 0;
        await assert.rejects(invoke(captured, scenario, apply(scenario, {
          prepare: async () => {
            const key = lost === 'workspace' ? collaborationAdmissionLockKey(scenario.workspaceId) : lockIdentity(scenario.documents[0].documentId).key;
            assert.equal((await captured.client.query('SELECT pg_advisory_unlock($1::bigint) AS released', [key])).rows[0].released, true);
          }, mutate: async () => { mutations++; return {}; },
        })), admissionError());
        assert.equal(mutations, 0); await captured.client.query('ROLLBACK'); await assertPending(scenario);
      });
    });

    await check('caller rollback discards a successful returned outcome and permits a real retry', async () => {
      const scenario = await seed('rollback-outcome');
      await guarded(scenario, async captured => {
        await begin(captured.client);
        const first = await invoke(captured, scenario, apply(scenario));
        assert.equal(first.result.destinationPath, scenario.destinations[0]);
        assert.equal((await row(scenario.documents[0].documentId, captured.client)).path, scenario.destinations[0]);
        assert.equal((await row(scenario.documents[0].documentId)).path, scenario.documents[0].path);
        await captured.client.query('ROLLBACK'); await assertPending(scenario);
        await begin(captured.client); await invoke(captured, scenario, apply(scenario)); await captured.client.query('COMMIT');
      });
      assert.equal((await header(scenario)).status, 'committed');
      assert.equal((await row(scenario.documents[0].documentId)).path, scenario.destinations[0]);
    });

    await check('shared core still rejects a changed original native target before mutation', async () => {
      const scenario = await seed('target-drift');
      await guarded(scenario, async captured => {
        await control!.query(`UPDATE ${quoted}.collaboration_yjs_states SET document_sequence=document_sequence+1
          WHERE document_id=$1`, [scenario.documents[0].documentId]);
        await begin(captured.client); let mutations = 0;
        await assert.rejects(invoke(captured, scenario, apply(scenario, {
          mutate: async () => { mutations++; return {}; },
        })), admissionError('ADMISSION_STATE_CHANGED', 'ADMISSION_SCOPE_CHANGED'));
        assert.equal(mutations, 0); await captured.client.query('ROLLBACK'); await assertPending(scenario);
      });
    });

    await check('shared core requires the exact retained B1 quiescence proof', async () => {
      const scenario = await seed('missing-quiescence');
      await guarded(scenario, async captured => {
        await control!.query(`UPDATE ${quoted}.collaboration_admission_targets SET status='reserved',release_id=NULL,
          quiescence_kind=NULL,quiescence_text=NULL,source_outcome_request_id=NULL WHERE request_id=$1`, [scenario.request.requestId]);
        await begin(captured.client); let mutations = 0;
        await assert.rejects(invoke(captured, scenario, apply(scenario, {
          mutate: async () => { mutations++; return {}; },
        })), admissionError('ADMISSION_RECOVERY_REQUIRED'));
        assert.equal(mutations, 0); await captured.client.query('ROLLBACK');
        assert.equal((await header(scenario)).outcome_text, null);
      });
    });

    await check('callbacks and operation kind are captured before the first caller await', async () => {
      const scenario = await seed('domain-capture');
      await guarded(scenario, async captured => {
        await begin(captured.client);
        let entered!: () => void, resume!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const barrier = new Promise<void>(resolve => { resume = resolve; });
        let authorizations = 0, prepares = 0, mutations = 0, replacements = 0, firstQuery = true;
        const original = apply(scenario);
        assert.equal(original.kind, 'apply');
        const domain: Domain = { ...original, authorize: async () => { authorizations++; },
          prepare: async database => { prepares++; await original.prepare(database); },
          mutate: async (database, proofs) => { mutations++; return original.mutate(database, proofs); } };
        captured.afterQuery = async () => {
          if (firstQuery) { firstQuery = false; entered(); await barrier; }
        };
        const execution = invoke(captured, scenario, domain);
        try {
          await started;
          Reflect.set(domain, 'kind', 'abort'); Reflect.set(domain, 'reasonCode', 'user_cancelled');
          Reflect.set(domain, 'authorize', async () => { replacements++; });
          Reflect.set(domain, 'prepare', async () => { replacements++; });
          Reflect.set(domain, 'mutate', async () => { replacements++; return {}; });
        } finally { resume(); }
        let outcome: Awaited<typeof execution>;
        try { outcome = await execution; } finally { captured.afterQuery = undefined; }
        assert.equal(outcome.version, 1); assert.equal(authorizations, 1);
        assert.equal(prepares, 1); assert.equal(mutations, 1); assert.equal(replacements, 0);
        await captured.client.query('COMMIT');
      });
    });

    await check('request scope and actor are captured before external authorization yields', async () => {
      const scenario = await seed('request-capture');
      const originalActor = scenario.request.actorId, originalPath = scenario.documents[0].path;
      await guarded(scenario, async captured => {
        await begin(captured.client);
        await invoke(captured, scenario, apply(scenario, { authorize: async received => {
          assert(Object.isFrozen(received)); assert(Object.isFrozen(received.expectedDocuments));
          Reflect.set(scenario.request, 'actorId', 'changed-caller-actor');
          Reflect.set(scenario.documents[0], 'path', 'changed-caller-path.md');
          assert.equal(received.actorId, originalActor); assert.equal(received.expectedDocuments[0].path, originalPath);
        } }));
        await captured.client.query('COMMIT');
      });
      const stored = JSON.parse((await header(scenario)).intent_text);
      assert.equal(stored.actorId, originalActor); assert.equal(stored.expectedDocuments[0].path, originalPath);
      assert.equal((await row(scenario.documents[0].documentId)).path, scenario.destinations[0]);
    });

    await check('every requested workspace needs its own genuine active lifecycle lease', async () => {
      const scenario = await seed('missing-second-lease'), otherWorkspace = `other-${nonce}`;
      Reflect.set(scenario.request, 'scopes', [...scenario.request.scopes,
        { workspaceId: otherWorkspace, organizationId: null, path: 'other-destination.md', kind: 'exact' }]);
      await guarded(scenario, async captured => {
        await captured.client.query('SELECT pg_advisory_lock($1::bigint)', [collaborationAdmissionLockKey(otherWorkspace)]);
        await begin(captured.client); let prepares = 0;
        await assert.rejects(invoke(captured, scenario, apply(scenario, { prepare: async () => { prepares++; } })),
          admissionError('ADMISSION_RECOVERY_REQUIRED'));
        assert.equal(prepares, 0); await captured.client.query('ROLLBACK'); await assertPending(scenario);
      });
    });

    await check('borrowed phase rejects a transaction wrapper rather than transferring authority', async () => {
      const scenario = await seed('transaction-wrapper');
      await guarded(scenario, async captured => {
        await begin(captured.client); let wrappers = 0;
        const invalid = { ...apply(scenario), withMutationTransaction: async () => { wrappers++; } } as unknown as Domain;
        await assert.rejects(invoke(captured, scenario, invalid), admissionError('ADMISSION_INVALID_REQUEST'));
        assert.equal(wrappers, 0); await captured.client.query('ROLLBACK'); await assertPending(scenario);
      });
    });

    await check('borrowed domain capture rejects accessors without evaluating them', async () => {
      const scenario = await seed('domain-accessor');
      await guarded(scenario, async captured => {
        await begin(captured.client); let reads = 0;
        const invalid = { ...apply(scenario) };
        Object.defineProperty(invalid, 'prepare', { enumerable: true, get: () => { reads++; return async () => undefined; } });
        await assert.rejects(invoke(captured, scenario, invalid), admissionError('ADMISSION_INVALID_REQUEST'));
        assert.equal(reads, 0); await captured.client.query('ROLLBACK'); await assertPending(scenario);
      });
    });

    for (const callback of ['authorize', 'prepare', 'mutate'] as const) await check(`preserve ${callback} failure and caller rollback ownership`, async () => {
      const scenario = await seed(`callback-failure-${callback}`), failure = new Error(`fixture ${callback} failure`);
      await guarded(scenario, async captured => {
        await begin(captured.client); const before = await identity(captured.client);
        const fail = async () => { throw failure; };
        await assert.rejects(invoke(captured, scenario, apply(scenario, callback === 'mutate' ? {
          mutate: async database => { await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1',
            [scenario.documents[0].documentId, scenario.destinations[0]]); throw failure; },
        } : { [callback]: fail })), error => error === failure);
        assert.deepEqual(await identity(captured.client), before);
        assert.equal((await row(scenario.documents[0].documentId)).path, scenario.documents[0].path);
        assert.throws(() => requireCollaborationAdmissionMutationRequest(captured.database, 'move'), admissionError('ADMISSION_RECOVERY_REQUIRED'));
        await captured.client.query('ROLLBACK'); await assertPending(scenario);
        await begin(captured.client); await invoke(captured, scenario, apply(scenario)); await captured.client.query('COMMIT');
      });
    });

    for (const disposition of ['committed', 'rolled-back'] as const) await check(`caller lost ${disposition} acknowledgement and authoritative retry`, async () => {
      const scenario = await seed(`lost-ack-${disposition}`), lostAck = new Error('fixture lost caller transaction reply');
      let mutations = 0;
      await guarded(scenario, async captured => {
        const domain = apply(scenario, { mutate: async database => {
          mutations++;
          await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1', [scenario.documents[0].documentId, scenario.destinations[0]]);
          return { destinationPath: scenario.destinations[0] };
        } });
        await begin(captured.client);
        const attempted = await invoke(captured, scenario, domain);
        await assert.rejects((async () => {
          // The real PG terminal statement runs first. Only its acknowledgement is lost.
          await captured.client.query(disposition === 'committed' ? 'COMMIT' : 'ROLLBACK'); throw lostAck;
        })(), error => error === lostAck);
        assert.throws(() => requireCollaborationAdmissionMutationRequest(captured.database, 'move'), admissionError('ADMISSION_RECOVERY_REQUIRED'));
        if (disposition === 'rolled-back') await assertPending(scenario);
        await begin(captured.client);
        const retried = await invoke(captured, scenario, domain);
        assert.deepEqual(retried, attempted);
        await captured.client.query('COMMIT');
      });
      assert.equal(mutations, disposition === 'committed' ? 1 : 2);
      assert.equal((await header(scenario)).status, 'committed');
    });

    await check('explicit abort commits an immutable unchanged-input outcome and reauthorizes retry', async () => {
      const scenario = await seed('abort'), before = await row(scenario.documents[0].documentId);
      let authorizations = 0;
      const outcome = await guarded(scenario, async captured => {
        await begin(captured.client);
        const value = await invoke(captured, scenario, { kind: 'abort', reasonCode: 'precondition_failed',
          authorize: async () => { authorizations++; }, prepare: async () => undefined });
        assert.equal(value.version, 2);
        if (value.version === 2) { assert.equal(value.disposition, 'aborted'); assert.equal(value.reasonCode, 'precondition_failed'); }
        await captured.client.query('COMMIT'); return value;
      });
      assert.deepEqual(await row(scenario.documents[0].documentId), before);
      const retry = await handle('abort-retry');
      try {
        await begin(retry.client);
        assert.deepEqual(await invoke(retry, scenario, { kind: 'abort', reasonCode: 'precondition_failed',
          authorize: async () => { authorizations++; }, prepare: async () => { assert.fail('Abort retry must not prepare.'); } }), outcome);
        await retry.client.query('COMMIT'); assert.equal(authorizations, 3);
      } finally { await close(retry.client); }
    });

    const { createRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { inspectPersistedDocumentLinks, nativeLinkJsonProof } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { prepareNativeLinkMutations } = await import('../app/lib/markdown/workspace-native-link-mutations');
    const { loadCollaborationStateOnConnection } = await import('../app/lib/collaboration/persistence');
    const { stageNativeFileOperationBundleOnConnection, applyNativeFileOperationMutationOnConnection,
      nativeFileOperationReceiptSetProofOnConnection, readStagedNativeFileOperationBindingOnConnection,
      readCommittedNativeFileOperationReceiptOnConnection } = await import('../app/lib/markdown/native-file-operation-handoff');
    const { captureNativeFileOperationSideEffectsOnConnection, applyNativeFileOperationSideEffectsOnConnection,
      readCommittedNativeFileOperationSideEffectsOnConnection } = await import('../app/lib/markdown/native-file-operation-side-effects');
    const nativeSeed = async (label: string) => {
      const scenario = await seed(label, 2), states: PersistedCollaborationState[] = [];
      const workspace: WorkspaceContext = { workspaceId: scenario.workspaceId, workspaceType: 'personal',
        organizationId: null, rootPath: dataRoot!, legacy: false, status: 'active',
        permissions: { canRead: true, canWrite: true, canDelete: true, canManageWorkspace: true,
          canCreatePublicLinks: true, canRunAgent: true } };
      const mutations: NativeFileOperationBundle['mutations'] = [];
      scenario.destinations[1] = scenario.documents[1].path;
      for (const [index, document] of scenario.documents.entries()) {
        const lineageId = `native-lineage-${randomUUID()}`, mutationId = randomUUID();
        const rich = createRichMarkdownYDoc('[Native link](target.md)\n\nKeep this paragraph.', 'tiptap_blocks');
        let state: PersistedCollaborationState;
        try {
          state = { ...document, representation: 'tiptap_blocks', yjsState: Y.encodeStateAsUpdate(rich),
            stateVector: Y.encodeStateVector(rich), documentSequence: 7, persistedAt: 100, checkpointSequence: 7,
            checkpointedAt: 100, canonicalHash: 'old', serializedHash: 'old', hasBom: false, newlineStyle: 'lf', degraded: false };
        } finally { rich.destroy(); }
        Reflect.set(document, 'representation', 'tiptap_blocks');
        states.push(state);
        await control!.query(`UPDATE ${quoted}.collaboration_yjs_states SET representation='tiptap_blocks',
          yjs_state=$2,state_vector=$3,document_sequence=7,checkpoint_sequence=7,canonical_hash='old',serialized_hash='old'
          WHERE document_id=$1`, [document.documentId, Buffer.from(state.yjsState), Buffer.from(state.stateVector)]);
        await control!.query(`INSERT INTO ${quoted}.file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
          VALUES($1,$2,'personal',NULL,$3,'active',100)`, [lineageId, workspace.workspaceId, document.path]);
        await control!.query(`INSERT INTO ${quoted}.collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
          state_version,yjs_state_lifecycle,status,created_at,updated_at) VALUES($1,$2,$3,'personal',NULL,$4,'yjs',7,'initialized','active',100,100)`,
        [document.documentId, lineageId, workspace.workspaceId, document.path]);
        await control!.query(`INSERT INTO ${quoted}.collaboration_file_projections(document_id,lifecycle_generation,projected_sequence,revision_id,
          canonical_hash,serialized_hash,finalized,updated_at) VALUES($1,1,7,'old-revision','old','old',1,100)`, [document.documentId]);
        const inventory = inspectPersistedDocumentLinks(state), native = authoritativeNativeCollaborationSnapshot(state);
        assert.equal(inventory.links.length, 1);
        const prepared = prepareNativeLinkMutations({ state, operationId: mutationId, recipes: [{
          linkId: inventory.links[0].id, source: inventory.document, sourceVersion: inventory.version,
          destinationWorkspaceId: workspace.workspaceId, sourcePathAfter: scenario.destinations[index], cloneSelection: null,
          reference: inventory.links[0].ref, action: 'rewrite', nextValue: 'renamed-target.md', expectedTargetIdentity: 'owned-fixture-target',
        }] });
        mutations.push({ mutationId, kind: index === 0 ? 'move' : 'link', source: inventory.document, lineageId,
          registryStateVersion: 7, before: { ...native.version, binaryHash: createHash('sha256').update(state.yjsState).digest('hex') },
          destinationPath: index === 0 ? scenario.destinations[index] : null, trashEntryId: null, prepared });
      }
      const bundle: NativeFileOperationBundle = { version: 1, operationId: randomUUID(), requestId: scenario.request.requestId,
        action: 'move', actor: { actorUserId: 'fixture-owner', actorId: scenario.request.actorId, actorType: 'agent', actorSessionId: 'fixture-session' },
        reviewDigest: nativeLinkJsonProof({ label }), mutations };
      await control!.query(`INSERT INTO ${quoted}.workspace_file_metadata(workspace_id,path,title,created_at,updated_at)
        VALUES($1,$2,'Preserved native title',100,101),($1,'unrelated.md','Unrelated exact sentinel',102,103)`,
      [workspace.workspaceId, scenario.documents[0].path]);
      await control!.query(`INSERT INTO ${quoted}.workspace_file_user_states(workspace_id,user_id,path,is_favorite,pinned_at,created_at,updated_at)
        VALUES($1,'fixture-owner',$2,1,250,100,101)`, [workspace.workspaceId, scenario.documents[0].path]);
      return { scenario, workspace, bundle, states };
    };
    const nativeRows = async (item: Awaited<ReturnType<typeof nativeSeed>>) => {
      const workspaceId = item.workspace.workspaceId;
      const result: Record<string, unknown[]> = {};
      for (const [table, order] of [['collaboration_yjs_states', 'document_id'], ['collaboration_documents', 'id'],
        ['file_collaboration_lineages', 'id'], ['workspace_file_metadata', 'path'], ['workspace_file_user_states', 'path,user_id']] as const) {
        result[table] = (await control!.query(`SELECT * FROM ${quoted}.${table} WHERE workspace_id=$1 ORDER BY ${order}`, [workspaceId])).rows;
      }
      result.collaboration_file_projections = (await control!.query(`SELECT * FROM ${quoted}.collaboration_file_projections
        WHERE document_id=ANY($1::text[]) ORDER BY document_id`, [item.states.map(state => state.documentId)])).rows;
      return result;
    };
    const nativeCounts = async (item: Awaited<ReturnType<typeof nativeSeed>>) => {
      const result: Record<string, number> = {};
      for (const table of ['collaboration_native_file_operation_intents', 'collaboration_native_file_operation_receipts',
        'collaboration_native_file_operation_side_effect_stages', 'collaboration_native_file_operation_side_effect_receipts']) {
        result[table] = Number((await control!.query(`SELECT count(*) AS n FROM ${quoted}.${table} WHERE operation_id=$1`,
          [item.bundle.operationId])).rows[0].n);
      }
      return result;
    };
    for (const terminal of ['rollback', 'lost-commit-ack'] as const) await check(`real native move/link/sideeffect consumer with ${terminal}`, async () => {
      const item = await nativeSeed(`native-consumer-${terminal}`), { scenario, workspace, bundle } = item;
      const before = await nativeRows(item);
      let authorizations = 0, nativeApplications = 0, sideApplications = 0;
      let firstB2Identity: Awaited<ReturnType<typeof identity>> | undefined;
      const order: string[] = [];
      const authorizeDomain = async (request: CollaborationAdmissionRequest) => {
        authorizations++; order.push('authorize');
        assert.equal(request.actorId, bundle.actor.actorId); assert.equal(request.action, 'move');
        assert.equal(workspace.permissions.canWrite, true); assert.equal(workspace.permissions.canDelete, true);
      };
      const outcome = await guarded(scenario, async captured => {
        assert.equal((await nativeCounts(item)).collaboration_native_file_operation_intents, 1);
        // Deliberately no physical Markdown is created or edited in this gap.
        const executeB2 = async () => {
          await begin(captured.client);
          const originalIdentity = await identity(captured.client);
          await authorizeDomain(scenario.request);
          order.push('sideeffect-capture');
          assert.deepEqual(await captureNativeFileOperationSideEffectsOnConnection(captured.database,
            { workspace, request: scenario.request, operationId: bundle.operationId }), { version: 1, executionReady: false });
          const capturedIdentity = await identity(captured.client);
          assert.equal(capturedIdentity.pid, originalIdentity.pid); assert.equal(capturedIdentity.start, originalIdentity.start);
          assert.equal(capturedIdentity.database, originalIdentity.database); assert.equal(capturedIdentity.schema, originalIdentity.schema);
          assert.equal(capturedIdentity.transaction, originalIdentity.transaction);
          assert.notEqual(capturedIdentity.search_path, originalIdentity.search_path, 'The original trigger really canonicalizes literal search_path.');
          firstB2Identity ??= capturedIdentity;
          const evidenceDirectory = process.env.CANVAS_BORROWED_HANDOFF_TEST_EVIDENCE_DIR;
          if (evidenceDirectory && terminal === 'lost-commit-ack') {
            const directory = await lstat(evidenceDirectory);
            assert(directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o077) === 0);
            await writeFile(path.join(evidenceDirectory, 'native-consumer-search-path.json'), JSON.stringify({
              before: originalIdentity, after: capturedIdentity, domainAuthorizationBeforeCapture: true,
              sameBackendTransactionAndEffectiveSchema: true, originalOwnerCompatible: false,
              limitation: 'The fixed job owner must explicitly handle trigger canonicalization before adoption.',
            }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          }
          const value = await invoke(captured, scenario, { kind: 'apply', authorize: authorizeDomain,
            prepare: async database => {
              order.push('prepare');
              assert.equal(database, captured.database);
              const binding = await readStagedNativeFileOperationBindingOnConnection(database, { request: scenario.request, operationId: bundle.operationId });
              assert.equal(binding.mutations.length, 2); assert.equal(binding.reviewDigest, bundle.reviewDigest);
            }, mutate: async database => {
              order.push('native-apply'); assert.equal(database, captured.database);
              for (const mutation of bundle.mutations) {
                const applied = await applyNativeFileOperationMutationOnConnection(database,
                  { workspace, action: bundle.action, operationId: bundle.operationId, mutationId: mutation.mutationId });
                nativeApplications++; assert.equal(applied.executionReady, false);
                assert.equal(applied.receipt.after.clock.documentSequence, 8);
              }
              order.push('sideeffect-apply');
              const applied = await applyNativeFileOperationSideEffectsOnConnection(database, { workspace, operationId: bundle.operationId });
              sideApplications++; assert.equal(applied.executionReady, false);
              return { nativeFileReceiptSetProof: await nativeFileOperationReceiptSetProofOnConnection(database, bundle.action, bundle.operationId),
                nativeFileSideEffectSetProof: applied.nativeFileSideEffectSetProof };
            } });
          assert.deepEqual(await identity(captured.client), capturedIdentity, 'The actual consumer must retain Borrowed B2/XID/schema/search_path.');
          assert.deepEqual(await nativeRows(item), before, 'All original native and annotation rows remain invisible before caller COMMIT.');
          assert.deepEqual(await nativeCounts(item), { collaboration_native_file_operation_intents: 1, collaboration_native_file_operation_receipts: 0,
            collaboration_native_file_operation_side_effect_stages: 0, collaboration_native_file_operation_side_effect_receipts: 0 });
          return value;
        };
        let value = await executeB2();
        if (terminal === 'rollback') {
          await captured.client.query('ROLLBACK'); await assertPending(scenario);
          assert.deepEqual(await nativeRows(item), before);
          value = await executeB2(); await captured.client.query('COMMIT');
        } else {
          const lost = new Error('fixture real native caller lost COMMIT acknowledgement');
          await assert.rejects((async () => { await captured.client.query('COMMIT'); throw lost; })(), error => error === lost);
        }
        return value;
      }, async captured => {
        const staged = await stageNativeFileOperationBundleOnConnection(captured.database, bundle);
        assert.equal(staged.executionReady, false);
        Reflect.set(scenario.request, 'actionPayloadText', staged.actionPayloadText);
        Reflect.set(scenario.request, 'actionDigest', collaborationAdmissionActionDigest('move', staged.actionPayloadText));
        assert.equal((await nativeCounts(item)).collaboration_native_file_operation_intents, 0, 'B1 staging must use its actual uncommitted B.');
      });
      assert(firstB2Identity); assert.equal(nativeApplications, terminal === 'rollback' ? 4 : 2);
      assert.equal(sideApplications, terminal === 'rollback' ? 2 : 1);
      assert.deepEqual(order.slice(0, 6), ['authorize', 'sideeffect-capture', 'authorize', 'prepare', 'native-apply', 'sideeffect-apply']);
      const observer = await handle(`native-consumer-read-${terminal}`);
      try {
        await begin(observer.client);
        const freshIdentity = await identity(observer.client);
        assert.notEqual(freshIdentity.pid, firstB2Identity.pid, 'Durable receipt recovery uses a fresh actual backend.');
        for (const [index, state] of item.states.entries()) {
          const current = await loadCollaborationStateOnConnection(observer.database, state.documentId, true);
          assert(current); assert.equal(current.path, scenario.destinations[index]); assert.equal(current.documentSequence, 8);
          assert.equal(inspectPersistedDocumentLinks(current).links[0].literal, 'renamed-target.md');
          const receipt = await readCommittedNativeFileOperationReceiptOnConnection(observer.database,
            { request: scenario.request, operationId: bundle.operationId, mutationId: bundle.mutations[index].mutationId });
          assert(receipt); assert.equal(receipt.receipt.after.identity.path, scenario.destinations[index]);
          assert.equal(receipt.receipt.after.clock.documentSequence, 8);
          const registry = (await observer.client.query('SELECT path,state_version FROM collaboration_documents WHERE id=$1', [state.documentId])).rows[0];
          assert.equal(registry.path, scenario.destinations[index]); assert.equal(Number(registry.state_version), index === 0 ? 0 : 7);
        }
        const side = await readCommittedNativeFileOperationSideEffectsOnConnection(observer.database,
          { request: scenario.request, operationId: bundle.operationId, actor: bundle.actor });
        assert(side); assert.equal(side.nativeFileSideEffectSetProof, outcome.result.nativeFileSideEffectSetProof);
        assert.deepEqual(await invoke(observer, scenario, { kind: 'apply', authorize: authorizeDomain,
          prepare: async () => { assert.fail('Native consumer committed retry must not prepare.'); },
          mutate: async () => { assert.fail('Native consumer committed retry must not apply again.'); } }), outcome);
        await observer.client.query('COMMIT');
      } finally { await close(observer.client); }
      assert.equal(authorizations, terminal === 'rollback' ? 5 : 3);
      assert.deepEqual(await nativeCounts(item), { collaboration_native_file_operation_intents: 1, collaboration_native_file_operation_receipts: 2,
        collaboration_native_file_operation_side_effect_stages: 1, collaboration_native_file_operation_side_effect_receipts: 1 });
      const after = await nativeRows(item);
      const metadata = after.workspace_file_metadata as Array<{ path: string; title: string }>;
      assert.equal(metadata.find(entry => entry.path === scenario.destinations[0])?.title, 'Preserved native title');
      assert.equal(metadata.some(entry => entry.path === scenario.documents[0].path), false);
      assert.deepEqual(metadata.find(entry => entry.path === 'unrelated.md'),
        (before.workspace_file_metadata as Array<{ path: string }>).find(entry => entry.path === 'unrelated.md'));
      const favorite = after.workspace_file_user_states as Array<{ path: string; is_favorite: number; pinned_at: string | number }>;
      assert.equal(favorite.length, 1); assert.equal(favorite[0].path, scenario.destinations[0]);
      assert.equal(Number(favorite[0].is_favorite), 1); assert.equal(Number(favorite[0].pinned_at), 250);
    });

    assert.equal(forbiddenTransactions, 0); assert.equal(forbiddenCloses, 0); assert.equal(asyncErrors.length, 0);
    stage = 'all acceptance cases complete; resource closure pending';
    console.log(JSON.stringify({ suite: 'collaboration-borrowed-admission-handoff-postgres', cases: checks.length,
      checks, forbiddenTransactions, forbiddenCloses, actualPgMajor: 18, privateSchema: true, cleanup: 'pending' }));
  } finally {
    for (const client of [...clients]) if (client !== control) {
      try { await close(client); } catch (error) { cleanupErrors.push(error); }
    }
    if (control && clients.has(control)) {
      try {
        const sessions = (await control.query(`SELECT pid FROM pg_stat_activity
          WHERE pid<>pg_backend_pid() AND (application_name LIKE $1 OR pid=ANY($2::integer[]))`, [`${application}%`, [...pids]])).rows;
        assert.equal(sessions.length, 0, 'Every exact owned backend must be closed before schema disposal.');
        for (const [name, binding] of [...ownedSchemas].reverse()) {
          const current: { oid: string; owner: string; marker: string } = (await control.query(`SELECT oid::text AS oid,nspowner::text AS owner,
            obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=$1`, [name])).rows[0];
          assert.deepEqual(current, binding, 'Only the exact newly owned schema may be dropped.');
          await control.query(`DROP SCHEMA ${quoteSchema(name)} CASCADE`);
          assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS absent', [name])).rows[0].absent, true);
        }
      } catch (error) { cleanupErrors.push(error); }
      try { await close(control); } catch (error) { cleanupErrors.push(error); }
    }
    if (dataRoot && dataBirth) try {
      const current = await lstat(dataRoot);
      assert.equal(current.dev, dataBirth.dev); assert.equal(current.ino, dataBirth.ino);
      assert(current.isDirectory() && !current.isSymbolicLink());
      await rm(dataRoot, { recursive: true });
      await assert.rejects(lstat(dataRoot), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    } catch (error) { cleanupErrors.push(error); }
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previousEnv, key)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    assert.equal(clients.size, 0, 'All owned Client lifetimes must end.');
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Borrowed handoff resource closure failed.');
    console.log(JSON.stringify({ suite: 'collaboration-borrowed-admission-handoff-postgres', resourcesClosed: true,
      ownedSchemasRemoved: ownedSchemas.size, ownedBackendsClosed: true, privateDataRemoved: dataRoot !== undefined }));
  }
  completed = true;
  console.log(JSON.stringify({ suite: 'collaboration-borrowed-admission-handoff-postgres', passed: true,
    cases: checks.length, ownedSchemasRemoved: ownedSchemas.size, ownedBackendsClosed: true, privateDataRemoved: true }));
}

main().catch(error => {
  const candidate = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown } : {};
  console.error(`Borrowed handoff PostgreSQL failed at ${stage}: ${String(candidate.name ?? 'Error')} ${String(candidate.code ?? '')}`);
  // Assertion messages identify the invariant without serializing SQL parameters, rows, or ENV values.
  if (error instanceof assert.AssertionError) console.error(error.message);
  else if (error instanceof Error) {
    console.error(error.stack?.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]'));
    if (error.cause instanceof Error) {
      const cause = error.cause as Error & { code?: unknown };
      console.error(`Cause: ${cause.name} ${String(cause.code ?? '')}: ${cause.message.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')}`);
    }
  }
  process.exitCode = 1;
}).finally(() => { settled = true; clearTimeout(watchdog); });

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

import type { SqlConnection } from '../app/lib/db';
import { WORKSPACE_OPERATION_JOURNAL_STATEMENTS } from '../app/lib/db/workspace-operation-journal-migration';
import { persistNativeWorkspaceCopiesOnConnection, type NativeCopyRequest } from '../app/lib/collaboration/native-copy-persistence';
import { captureWorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import { beginWorkspaceOperationStepOnConnection, completeWorkspaceOperationOnConnection,
  failWorkspaceOperationOnConnection, finishWorkspaceOperationStepOnConnection, prepareWorkspaceOperationOnConnection,
  readWorkspaceOperationJournalOnConnection, resumeWorkspaceOperationOnConnection, serializeWorkspaceOperationRequest,
  WorkspaceOperationJournal, WorkspaceOperationJournalConflictError, WorkspaceOperationJournalTransactionError,
  WorkspaceOperationJournalUncertainCommitError, type WorkspaceOperationPrepareInput, type WorkspaceOperationBeginStepInput,
  type WorkspaceOperationFinishStepInput, type WorkspaceOperationWithSteps } from '../app/lib/files/workspace-operation-journal';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

// Mechanical transaction/receipt tests only. An original Copy context is data,
// never a replacement for a current caller principal, permission or job claim.
const PREFIX = 'canvas_journal_borrowed_';
const SCHEMA = new RegExp(`^${PREFIX}[0-9a-f]{32}$`, 'u');
type Fault = 'none' | 'before' | 'after';
type Witness = { pid: number; start: string; xid: string; schema: string; searchPath: string };
type Fixture = { pool: Pool; journal: WorkspaceOperationJournal; schema: string;
  openConnection: () => Promise<SqlConnection>; fault: (fault: Fault) => void;
  metrics: () => { opened: number; closed: number; discarded: number } };

function managedDatabase(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  const url = new URL(process.env.DATABASE_URL);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.port === '55433' && decodeURIComponent(url.pathname) === '/canvas_notebook' && !url.search && !url.hash,
  'Borrowed journal fixtures require managed loopback PostgreSQL 18 at 55433/canvas_notebook.');
  return url;
}
function identifier(schema: string): string {
  assert(SCHEMA.test(schema), 'Only the generated private journal schema may be addressed.');
  return `"${schema}"`;
}
function workspace(id: string): WorkspaceContext {
  return { workspaceId: id, workspaceType: 'personal', rootPath: `/unused-journal-borrowed/${id}`,
    rootRelativePath: `users/${id}`, organizationId: null, customerId: null, projectId: null,
    ownerUserId: 'journal-original-user', legacy: false, status: 'active', permissions: {
      canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false, canManageWorkspace: true, canRunAgent: true } };
}
function prepare(count = 2): WorkspaceOperationPrepareInput {
  const source = workspace('journal-source'), destination = workspace('journal-destination');
  return { operationId: randomUUID(), planId: 'a'.repeat(64), expectedStepCount: count,
    sourceWorkspaceId: source.workspaceId, destinationWorkspaceId: destination.workspaceId,
    actor: { type: 'agent', id: 'journal-original-user' }, request: { kind: 'copy',
      selections: [{ sourcePath: 'source.md', destinationPath: 'copies/source.md' }],
      origin: captureWorkspaceOperationCopyOrigin({ actor: { type: 'agent', userId: 'journal-original-user',
        actorId: 'pi-original-agent', sessionId: 'original-session' }, sourceWorkspace: source, destinationWorkspace: destination }) } };
}
function step(operationId: string, phase: 'path' | 'link' = 'path'): WorkspaceOperationBeginStepInput {
  return { operationId, phase, stepKey: `${phase}:source.md`, beforeFence: `sha256:${phase}-before`,
    afterFence: `sha256:${phase}-after`, ...(phase === 'path' ? { backupRef: 'durable-backup:original' } : {}) };
}
function finish(intent: WorkspaceOperationBeginStepInput): WorkspaceOperationFinishStepInput {
  return { operationId: intent.operationId, stepKey: intent.stepKey, beforeFence: intent.beforeFence,
    afterFence: intent.afterFence, receipt: { status: 'applied', proof: { value: 'original-proof' } } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function borrowed(client: PoolClient) {
  const sql: string[] = [];
  let nextResult: ((sql: string) => Promise<void>) | undefined;
  const query = async (statement: string, values: unknown[] = []) => {
    assert(!/^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT|SET\s+LOCAL)\b/iu.test(statement),
      'Borrowed journal must not control/close its transaction or replace owner timeouts.');
    sql.push(statement);
    const rows = (await client.query(statement, values)).rows;
    if (nextResult) { const after = nextResult; nextResult = undefined; await after(statement); }
    return rows;
  };
  const database: SqlConnection = { run: query, all: query, get: async (statement, values) => (await query(statement, values))[0],
    close: async () => { assert.fail('Borrowed journal must not release the caller connection.'); } };
  return { database, sql, afterNextResult: (after: NonNullable<typeof nextResult>) => { assert.equal(nextResult, undefined); nextResult = after; } };
}
async function witness(client: PoolClient): Promise<Witness> {
  const row = (await client.query(`SELECT pg_backend_pid() AS pid,a.backend_start::text AS start,
    pg_current_xact_id()::text AS xid,current_schema() AS schema,current_setting('search_path') AS search_path
    FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`)).rows[0];
  return { pid: row.pid, start: row.start, xid: row.xid, schema: row.schema, searchPath: row.search_path };
}
async function transaction<T>(h: Fixture, run: (b: ReturnType<typeof borrowed>, client: PoolClient, identity: Witness) => Promise<T>,
  commit = true): Promise<T> {
  const client = await h.pool.connect(); let ended = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
    const before = await witness(client); assert.equal(before.schema, h.schema);
    const b = borrowed(client), opened = h.metrics().opened;
    const result = await run(b, client, before);
    assert.deepEqual(await witness(client), before, 'Same actual backend/start/schema/search_path/XID through the borrowed phase.');
    assert.equal(h.metrics().opened, opened, 'No standalone Journal checkout is used by borrowed APIs.');
    await client.query(commit ? 'COMMIT' : 'ROLLBACK'); ended = true; return result;
  } finally { if (!ended) await client.query('ROLLBACK'); client.release(); }
}
async function snapshot(h: Fixture): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const table of ['workspace_file_operations', 'workspace_file_operation_steps']) {
    result[table] = (await h.pool.query(`SELECT row_to_json(t)::text AS row FROM ${table} t
      ORDER BY row_to_json(t)::text COLLATE "C"`)).rows.map(row => row.row);
  }
  return result;
}
async function fullFlow(database: SqlConnection, input: WorkspaceOperationPrepareInput): Promise<WorkspaceOperationWithSteps> {
  await prepareWorkspaceOperationOnConnection(database, input);
  const path = step(input.operationId), link = step(input.operationId, 'link');
  await beginWorkspaceOperationStepOnConnection(database, path);
  await finishWorkspaceOperationStepOnConnection(database, finish(path));
  await beginWorkspaceOperationStepOnConnection(database, link);
  await finishWorkspaceOperationStepOnConnection(database, finish(link));
  await completeWorkspaceOperationOnConnection(database, input.operationId);
  const result = await readWorkspaceOperationJournalOnConnection(database, input.operationId, { forUpdate: true });
  assert(result); return result;
}
function transactionConflict(error: unknown): boolean {
  return error instanceof WorkspaceOperationJournalTransactionError && error.code === 'JOURNAL_TRANSACTION_CHANGED' && error.status === 409;
}

async function withFixture(run: (h: Fixture) => Promise<number>): Promise<void> {
  const url = managedDatabase();
  if (!url) { console.log('SKIP borrowed journal PostgreSQL: managed PG18 connection not supplied.'); return; }
  const schema = `${PREFIX}${randomUUID().replaceAll('-', '')}`, applicationName = `journal-borrowed-${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3_000,
    allowExitOnIdle: true, application_name: `${applicationName}-admin` });
  let pool: Pool | undefined, schemaOid: string | undefined, created = false, failed = false, primary: unknown;
  let opened = 0, closed = 0, discarded = 0, groups = 0, fault: Fault = 'none';
  try {
    const server = (await admin.query(`SELECT current_setting('server_version_num')::int AS version,current_database() AS database`)).rows[0];
    assert.equal(Math.floor(server.version / 10_000), 18); assert.equal(server.database, 'canvas_notebook');
    await admin.query(`CREATE SCHEMA ${identifier(schema)}`); created = true;
    const identity = (await admin.query(`SELECT oid::text AS oid,pg_get_userbyid(nspowner)=current_user AS owned
      FROM pg_namespace WHERE nspname=$1`, [schema])).rows[0];
    assert.equal(identity.owned, true); schemaOid = identity.oid;
    console.log(JSON.stringify({ fixture: 'journal-borrowed', schema, schemaOid, applicationName }));
    pool = new Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 3_000, allowExitOnIdle: true,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=4000`, application_name: applicationName });
    assert.equal((await pool.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    for (let pass = 0; pass < 2; pass++) for (const statement of WORKSPACE_OPERATION_JOURNAL_STATEMENTS) await pool.query(statement);
    const fixturePool = pool;
    const openConnection = async (): Promise<SqlConnection> => {
      const client = await fixturePool.connect(); opened += 1; let released = false;
      const query = async (statement: string, values: unknown[] = []) => {
        assert.equal(released, false);
        if (statement === 'COMMIT' && fault !== 'none') {
          const current = fault; fault = 'none';
          if (current === 'after') await client.query(statement, values);
          throw new Error(`Synthetic ${current} Journal COMMIT acknowledgement loss.`);
        }
        return client.query(statement, values);
      };
      return { get: async (statement, values) => (await query(statement, values)).rows[0],
        all: async (statement, values) => (await query(statement, values)).rows,
        run: async (statement, values) => ({ changes: (await query(statement, values)).rowCount ?? 0 }), close: async error => {
          assert.equal(released, false); released = true; closed += 1; if (error) discarded += 1; client.release(error);
        } };
    };
    groups = await run({ pool, schema, openConnection, journal: new WorkspaceOperationJournal({ openConnection }),
      metrics: () => ({ opened, closed, discarded }), fault: value => { assert.equal(fault, 'none'); fault = value; } });
    assert.equal(opened, closed); assert.equal(pool.waitingCount, 0);
  } catch (error) { failed = true; primary = error; }
  finally {
    const cleanup: unknown[] = [];
    try { await pool?.end(); } catch (error) { cleanup.push(error); }
    try { assert.equal((await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1',
      [applicationName])).rows[0].count, 0); } catch (error) { cleanup.push(error); }
    if (created) try {
      const actual = (await admin.query(`SELECT oid::text AS oid,pg_get_userbyid(nspowner)=current_user AS owned
        FROM pg_namespace WHERE nspname=$1`, [schema])).rows[0];
      assert.equal(actual?.oid, schemaOid); assert.equal(actual?.owned, true);
      await admin.query(`DROP SCHEMA ${identifier(schema)} CASCADE`);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM pg_namespace WHERE nspname=$1 OR oid::text=$2',
        [schema, schemaOid])).rows[0].count, 0);
    } catch (error) { cleanup.push(error); }
    try { await admin.end(); } catch (error) { cleanup.push(error); }
    if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'Owned borrowed-journal fixture cleanup failed.');
    if (failed) throw primary;
  }
  console.log(JSON.stringify({ test: 'workspace-operation-journal-borrowed-postgres-test', groups,
    schema, schemaOid, applicationName, schemaRemoved: true, poolClosed: true, opened, closed, discarded }));
}

async function atFirstAck<T>(b: ReturnType<typeof borrowed>, invoke: () => Promise<T>, mutate: () => void): Promise<T> {
  const entered = deferred(), release = deferred();
  b.afterNextResult(async () => { entered.resolve(); await release.promise; });
  const pending = invoke(); await entered.promise;
  try { mutate(); } finally { release.resolve(); }
  return pending;
}

async function main(): Promise<void> {
  await withFixture(async h => {
    let groups = 0;
    const group = async (label: string, run: () => Promise<void>) => {
      await run(); groups += 1; console.log(`PASS borrowed-journal ${groups}: ${label}`);
    };
    await group('complete Copy-origin prepare/path/link/complete share one B/XID and vanish on outer rollback', async () => {
      const input = prepare(), before = await snapshot(h), serialized = serializeWorkspaceOperationRequest(input.request);
      await transaction(h, async (b, _client, identity) => {
        const complete = await fullFlow(b.database, input);
        assert.equal(complete.status, 'completed'); assert.equal(complete.revision, 6);
        assert.equal(complete.requestJson, serialized.requestJson); assert.equal(complete.requestHash, serialized.requestHash);
        assert.equal(JSON.parse(complete.requestJson).origin.actor.actorId, 'pi-original-agent');
        assert.equal(JSON.parse(complete.requestJson).origin.actor.sessionId, 'original-session');
        assert.equal(complete.steps.length, 2); assert(complete.steps.every(row => row.status === 'applied'));
        const xmins = await b.database.all(`SELECT xmin::text AS xmin FROM workspace_file_operations WHERE operation_id=$1
          UNION ALL SELECT xmin::text FROM workspace_file_operation_steps WHERE operation_id=$1`, [input.operationId]) as Array<{ xmin: string }>;
        assert.equal(xmins.length, 3); assert(xmins.every(row => row.xmin === (BigInt(identity.xid) % BigInt('4294967296')).toString()));
        assert.deepEqual(await snapshot(h), before, 'Independent observer cannot see any uncommitted header/step.');
      }, false);
      assert.deepEqual(await snapshot(h), before);
      assert.equal(await h.journal.get(input.operationId), null);
    });

    await group('committed borrowed rows interoperate exactly with all original class retry readers', async () => {
      const input = prepare(), complete = await transaction(h, b => fullFlow(b.database, input));
      assert.deepEqual(await h.journal.get(input.operationId), complete, 'Original nontransactional get reads the exact borrowed result.');
      const { steps: _steps, ...header } = complete;
      assert.deepEqual(await h.journal.prepare(input), header);
      for (const phase of ['path', 'link'] as const) {
        const intent = step(input.operationId, phase), expected = complete.steps.find(row => row.stepKey === intent.stepKey)!;
        assert.deepEqual(await h.journal.beginStep(intent), expected);
        assert.deepEqual(await h.journal.finishStep(finish(intent)), expected);
      }
      assert.deepEqual(await h.journal.complete(input.operationId), header);
    });

    await group('actual outer SQL failure after completed journal flow rolls back every header and step', async () => {
      const before = await snapshot(h), input = prepare();
      await assert.rejects(transaction(h, async (b, client) => {
        await fullFlow(b.database, input); await client.query('SELECT 1/0');
      }), (error: unknown) => error instanceof Error && (error as Error & { code?: unknown }).code === '22012');
      assert.deepEqual(await snapshot(h), before);
    });

    await group('original plan/request/origin, step order/count, fences and canonical receipt conflicts remain exact', async () => {
      const input = prepare(), path = step(input.operationId), link = step(input.operationId, 'link');
      await transaction(h, async b => {
        await prepareWorkspaceOperationOnConnection(b.database, input);
        const changed = structuredClone(input); (changed.request.origin!.actor as { sessionId: string }).sessionId = 'different-session';
        for (const mismatch of [changed, { ...input, planId: 'b'.repeat(64) }, { ...input, expectedStepCount: 3 },
          { ...input, actor: { type: 'user' as const, id: 'other-user' } }]) {
          await assert.rejects(prepareWorkspaceOperationOnConnection(b.database, mismatch), WorkspaceOperationJournalConflictError);
        }
        await assert.rejects(beginWorkspaceOperationStepOnConnection(b.database, link), WorkspaceOperationJournalConflictError);
        await assert.rejects(completeWorkspaceOperationOnConnection(b.database, input.operationId), WorkspaceOperationJournalConflictError);
        const intent = await beginWorkspaceOperationStepOnConnection(b.database, path);
        assert.deepEqual(await beginWorkspaceOperationStepOnConnection(b.database, path), intent);
        await assert.rejects(beginWorkspaceOperationStepOnConnection(b.database, { ...path, afterFence: 'wrong' }), WorkspaceOperationJournalConflictError);
        await assert.rejects(finishWorkspaceOperationStepOnConnection(b.database, { ...finish(path), beforeFence: 'wrong' }), WorkspaceOperationJournalConflictError);
        const applied = await finishWorkspaceOperationStepOnConnection(b.database, finish(path));
        assert.deepEqual(await finishWorkspaceOperationStepOnConnection(b.database, { ...finish(path),
          receipt: { proof: { value: 'original-proof' }, status: 'applied' } }), applied);
        await assert.rejects(finishWorkspaceOperationStepOnConnection(b.database, { ...finish(path), receipt: { status: 'different' } }),
          WorkspaceOperationJournalConflictError);
        await beginWorkspaceOperationStepOnConnection(b.database, link);
        await assert.rejects(beginWorkspaceOperationStepOnConnection(b.database, { ...path, stepKey: 'path:late.md' }), WorkspaceOperationJournalConflictError);
        await finishWorkspaceOperationStepOnConnection(b.database, finish(link));
        await assert.rejects(beginWorkspaceOperationStepOnConnection(b.database, { ...link, stepKey: 'link:extra.md' }), WorkspaceOperationJournalConflictError);
        await completeWorkspaceOperationOnConnection(b.database, input.operationId);
        await assert.rejects(failWorkspaceOperationOnConnection(b.database, { operationId: input.operationId,
          errorCode: 'too_late', recoveryRequired: true }), WorkspaceOperationJournalConflictError);
      });
      assert.equal((await h.journal.get(input.operationId))!.status, 'completed');
    });

    await group('failure/recovery status, revision CAS and terminal failure contracts are preserved', async () => {
      const input = prepare(1), path = step(input.operationId);
      await transaction(h, async b => {
        await prepareWorkspaceOperationOnConnection(b.database, input);
        await beginWorkspaceOperationStepOnConnection(b.database, path);
        const failure = { operationId: input.operationId, errorCode: 'verified_external_conflict', recoveryRequired: true };
        const failed = await failWorkspaceOperationOnConnection(b.database, failure);
        assert.equal(failed.status, 'recovery_required'); assert.equal(failed.revision, 3);
        assert.deepEqual(await failWorkspaceOperationOnConnection(b.database, failure), failed);
        await assert.rejects(failWorkspaceOperationOnConnection(b.database, { ...failure, errorCode: 'other_error' }), WorkspaceOperationJournalConflictError);
        await assert.rejects(resumeWorkspaceOperationOnConnection(b.database, { operationId: input.operationId,
          expectedRevision: failed.revision - 1 }), WorkspaceOperationJournalConflictError);
        const resumed = await resumeWorkspaceOperationOnConnection(b.database, { operationId: input.operationId, expectedRevision: failed.revision });
        assert.equal(resumed.status, 'running'); assert.equal(resumed.revision, failed.revision + 1); assert.equal(resumed.errorCode, null);
        await assert.rejects(resumeWorkspaceOperationOnConnection(b.database, { operationId: input.operationId,
          expectedRevision: failed.revision }), WorkspaceOperationJournalConflictError);
        await finishWorkspaceOperationStepOnConnection(b.database, finish(path));
        await completeWorkspaceOperationOnConnection(b.database, input.operationId);
        const terminal = prepare(1); await prepareWorkspaceOperationOnConnection(b.database, terminal);
        const stopped = await failWorkspaceOperationOnConnection(b.database, { operationId: terminal.operationId,
          errorCode: 'unrecoverable', recoveryRequired: false });
        assert.equal(stopped.status, 'failed');
        await assert.rejects(resumeWorkspaceOperationOnConnection(b.database, { operationId: terminal.operationId,
          expectedRevision: stopped.revision }), WorkspaceOperationJournalConflictError);
      });
    });

    await group('prepare captures all identity primitives, actor, origin and selections before the first actual SQL await', async () => {
      const input = structuredClone(prepare(1)), expected = structuredClone(input), encoded = serializeWorkspaceOperationRequest(input.request);
      await transaction(h, async b => {
        const result = await atFirstAck(b, () => prepareWorkspaceOperationOnConnection(b.database, input), () => {
          input.operationId = randomUUID(); input.actor.id = 'later-user'; input.actor.type = 'user'; input.planId = 'b'.repeat(64);
          input.sourceWorkspaceId = 'later-source'; input.destinationWorkspaceId = 'later-destination'; input.expectedStepCount = 8;
          (input.request.origin!.actor as { sessionId: string }).sessionId = 'later-session';
          (input.request.origin!.sourceScope as { rootPath: string }).rootPath = '/later-root';
          (input.request.selections as Array<{ sourcePath: string; destinationPath: string }>)[0].sourcePath = 'later.md';
        });
        assert.equal(result.operationId, expected.operationId); assert.deepEqual(result.actor, expected.actor);
        assert.equal(result.planId, expected.planId); assert.equal(result.expectedStepCount, 1);
        assert.equal(result.sourceWorkspaceId, expected.sourceWorkspaceId); assert.equal(result.destinationWorkspaceId, expected.destinationWorkspaceId);
        assert.equal(result.requestJson, encoded.requestJson); assert.equal(result.requestHash, encoded.requestHash);
      });
      assert.equal(await h.journal.get(input.operationId), null);
    });

    await group('beginStep captures identity, phase, fences and backup reference before the first actual SQL await', async () => {
      const input = prepare(1); await h.journal.prepare(input);
      const intent = step(input.operationId), expected = structuredClone(intent);
      await transaction(h, async b => {
        const result = await atFirstAck(b, () => beginWorkspaceOperationStepOnConnection(b.database, intent), () => {
          intent.operationId = randomUUID(); intent.stepKey = 'link:later.md'; intent.phase = 'link';
          intent.beforeFence = 'later-before'; intent.afterFence = 'later-after'; intent.backupRef = 'later-backup';
        });
        assert.equal(result.operationId, expected.operationId); assert.equal(result.stepKey, expected.stepKey);
        assert.equal(result.phase, expected.phase); assert.equal(result.beforeFence, expected.beforeFence);
        assert.equal(result.afterFence, expected.afterFence); assert.equal(result.backupRef, expected.backupRef);
      });
    });

    await group('finishStep captures identity, fences and nested canonical receipt before the first actual SQL await', async () => {
      const input = prepare(1), intent = step(input.operationId); await h.journal.prepare(input); await h.journal.beginStep(intent);
      const receipt = finish(intent), expected = structuredClone(receipt);
      await transaction(h, async b => {
        const result = await atFirstAck(b, () => finishWorkspaceOperationStepOnConnection(b.database, receipt), () => {
          receipt.operationId = randomUUID(); receipt.stepKey = 'later-step'; receipt.beforeFence = 'later-before'; receipt.afterFence = 'later-after';
          (receipt.receipt as { proof: { value: string } }).proof.value = 'later-proof';
          receipt.receipt = { entirely: 'later-receipt' };
        });
        assert.equal(result.operationId, expected.operationId); assert.equal(result.stepKey, expected.stepKey);
        assert.equal(result.beforeFence, expected.beforeFence); assert.equal(result.afterFence, expected.afterFence);
        assert.equal(result.receiptJson, '{"proof":{"value":"original-proof"},"status":"applied"}');
      });
    });

    await group('fail captures operation, error code and recovery flag before the first actual SQL await', async () => {
      const input = prepare(1); await h.journal.prepare(input);
      const failure = { operationId: input.operationId, errorCode: 'original_failure', recoveryRequired: true };
      await transaction(h, async b => {
        const result = await atFirstAck(b, () => failWorkspaceOperationOnConnection(b.database, failure), () => {
          failure.operationId = randomUUID(); failure.errorCode = 'later_failure'; failure.recoveryRequired = false;
        });
        assert.equal(result.operationId, input.operationId); assert.equal(result.errorCode, 'original_failure'); assert.equal(result.status, 'recovery_required');
      });
    });

    await group('resume captures operation and expected revision before the first actual SQL await', async () => {
      const input = prepare(1); await h.journal.prepare(input);
      const failed = await h.journal.fail({ operationId: input.operationId, errorCode: 'recoverable', recoveryRequired: true });
      const resume = { operationId: input.operationId, expectedRevision: failed.revision };
      await transaction(h, async b => {
        const result = await atFirstAck(b, () => resumeWorkspaceOperationOnConnection(b.database, resume), () => {
          resume.operationId = randomUUID(); resume.expectedRevision = 999;
        });
        assert.equal(result.operationId, input.operationId); assert.equal(result.revision, failed.revision + 1);
        assert.equal(result.status, 'running'); assert.equal(result.errorCode, null);
      });
    });

    await group('complete retains its primitive original operation ID across the first actual SQL await', async () => {
      const input = prepare(1), intent = step(input.operationId); await h.journal.prepare(input);
      await h.journal.beginStep(intent); await h.journal.finishStep(finish(intent));
      const holder = { operationId: input.operationId };
      await transaction(h, async b => {
        const result = await atFirstAck(b, () => completeWorkspaceOperationOnConnection(b.database, holder.operationId), () => { holder.operationId = randomUUID(); });
        assert.equal(result.operationId, input.operationId); assert.equal(result.status, 'completed');
      });
      assert.equal(await h.journal.get(holder.operationId), null);
    });

    await group('read retains its primitive ID and captures forUpdate before the first actual SQL await', async () => {
      const input = prepare(1); await h.journal.prepare(input);
      const holder = { operationId: input.operationId }, options = { forUpdate: false };
      await transaction(h, async b => {
        const result = await atFirstAck(b, () => readWorkspaceOperationJournalOnConnection(b.database, holder.operationId, options), () => {
          holder.operationId = randomUUID(); options.forUpdate = true;
        });
        assert.equal(result?.operationId, input.operationId);
        assert(b.sql.filter(sql => sql.includes('workspace_file_operations')).every(sql => !/FOR\s+UPDATE/iu.test(sql)));
      });
    });

    await group('all seven borrowed APIs reject autocommit, read-only and repeatable-read before domain SQL', async () => {
      const pending = prepare(2), pendingStep = step(pending.operationId), ready = prepare(1), readyStep = step(ready.operationId), recoverable = prepare(1);
      await h.journal.prepare(pending); await h.journal.beginStep(pendingStep);
      await h.journal.prepare(ready); await h.journal.beginStep(readyStep); await h.journal.finishStep(finish(readyStep));
      await h.journal.prepare(recoverable);
      const failed = await h.journal.fail({ operationId: recoverable.operationId, errorCode: 'recoverable', recoveryRequired: true });
      const operations: Array<{ label: string; run: (database: SqlConnection) => Promise<unknown> }> = [
        { label: 'read', run: database => readWorkspaceOperationJournalOnConnection(database, pending.operationId, { forUpdate: true }) },
        { label: 'prepare', run: database => prepareWorkspaceOperationOnConnection(database, prepare(1)) },
        { label: 'begin', run: database => beginWorkspaceOperationStepOnConnection(database, pendingStep) },
        { label: 'finish', run: database => finishWorkspaceOperationStepOnConnection(database, finish(pendingStep)) },
        { label: 'complete', run: database => completeWorkspaceOperationOnConnection(database, ready.operationId) },
        { label: 'fail', run: database => failWorkspaceOperationOnConnection(database, { operationId: pending.operationId, errorCode: 'other', recoveryRequired: true }) },
        { label: 'resume', run: database => resumeWorkspaceOperationOnConnection(database, { operationId: recoverable.operationId, expectedRevision: failed.revision }) },
      ];
      const before = await snapshot(h);
      for (const begin of [null, 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY', 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE']) {
        for (const operation of operations) {
          const client = await h.pool.connect();
          try {
            if (begin) await client.query(begin);
            const b = borrowed(client);
            await assert.rejects(operation.run(b.database), transactionConflict, `${operation.label}: ${begin ?? 'autocommit'}`);
            assert(b.sql.every(sql => !/\bworkspace_file_operation(?:s|_steps)\b/iu.test(sql)), 'Wrong transaction is rejected before original domain SQL.');
          } finally { if (begin) await client.query('ROLLBACK'); client.release(); }
        }
      }
      assert.deepEqual(await snapshot(h), before);
    });

    await group('actual XID and literal search_path drift during initial SQL ACK reject before original header writes', async () => {
      const before = await snapshot(h);
      for (const drift of ['transaction', 'search_path'] as const) {
        const client = await h.pool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
          const identity = await witness(client), b = borrowed(client), input = prepare(1);
          b.afterNextResult(async () => {
            if (drift === 'transaction') {
              await client.query('COMMIT'); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
              assert.notEqual((await witness(client)).xid, identity.xid);
            } else {
              await client.query(`SET LOCAL search_path=${identifier(h.schema)},pg_catalog,pg_temp`);
              const after = await witness(client); assert.equal(after.schema, h.schema); assert.notEqual(after.searchPath, identity.searchPath);
            }
          });
          await assert.rejects(prepareWorkspaceOperationOnConnection(b.database, input), transactionConflict);
          assert(b.sql.every(sql => !/\bworkspace_file_operation(?:s|_steps)\b/iu.test(sql)));
        } finally { await client.query('ROLLBACK'); client.release(); }
      }
      assert.deepEqual(await snapshot(h), before);
    });

    await group('post-INSERT literal search_path drift rejects successful domain writes and outer rollback removes them', async () => {
      const before = await snapshot(h), input = prepare(1); let inserted = false;
      await assert.rejects(transaction(h, async (b, client) => {
        const afterResult = async (sql: string): Promise<void> => {
          if (/^\s*INSERT INTO workspace_file_operations\b/iu.test(sql)) {
            inserted = true; await client.query(`SET LOCAL search_path=${identifier(h.schema)},pg_catalog,pg_temp`);
          } else b.afterNextResult(afterResult);
        };
        b.afterNextResult(afterResult);
        await prepareWorkspaceOperationOnConnection(b.database, input);
      }), transactionConflict);
      assert.equal(inserted, true); assert.deepEqual(await snapshot(h), before);
    });

    await group('overlapping prepare/read on the identical B poison both initial calls before domain SQL', async () => {
      const before = await snapshot(h), input = prepare(1), entered = deferred(), release = deferred();
      await transaction(h, async b => {
        b.afterNextResult(async () => { entered.resolve(); await release.promise; });
        const first = prepareWorkspaceOperationOnConnection(b.database, input); await entered.promise;
        try { await assert.rejects(readWorkspaceOperationJournalOnConnection(b.database, input.operationId), transactionConflict); }
        finally { release.resolve(); }
        await assert.rejects(first, transactionConflict);
        assert(b.sql.every(sql => !/\bworkspace_file_operation(?:s|_steps)\b/iu.test(sql)));
      }, false);
      assert.deepEqual(await snapshot(h), before);
    });

    await group('caught sibling during the final actual witness ACK still rejects and rolls back the inserted original header', async () => {
      const before = await snapshot(h), input = prepare(1); let identities = 0, inserted = false, lateSibling = false;
      await assert.rejects(transaction(h, async b => {
        const afterResult = async (sql: string): Promise<void> => {
          if (/^\s*INSERT INTO workspace_file_operations\b/iu.test(sql)) inserted = true;
          if (sql.includes('pg_backend_pid()') && ++identities === 3) {
            assert.equal(inserted, true); lateSibling = true;
            await assert.rejects(readWorkspaceOperationJournalOnConnection(b.database, input.operationId), transactionConflict);
          } else b.afterNextResult(afterResult);
        };
        b.afterNextResult(afterResult);
        await prepareWorkspaceOperationOnConnection(b.database, input);
      }), transactionConflict);
      assert.equal(lateSibling, true); assert.deepEqual(await snapshot(h), before);
    });

    await group('shared B rejects cross-domain Journal/Copy overlap in both directions with each original domain error', async () => {
      // This legal asset-only request is capture-only in this negative guard
      // probe. It makes no successful native-document clone assertion.
      const copy: NativeCopyRequest = { operationId: `cross-copy-${randomUUID()}`, actorUserId: 'journal-original-user',
        actorSessionId: 'original-session', kind: 'native_clone', sourceWorkspace: workspace('journal-source'),
        targetWorkspace: workspace('journal-destination'), targetScopes: ['asset-scope'], copies: [], expectedTargets: [],
        publicationFingerprint: 'c'.repeat(64) };
      const nativeConflict = (error: unknown) => error instanceof Error
        && (error as Error & { code?: unknown; status?: unknown }).code === 'NATIVE_DOCUMENT_RECOVERY_UNAVAILABLE'
        && (error as Error & { status?: unknown }).status === 409;
      const before = await snapshot(h);
      for (const held of ['journal', 'copy'] as const) {
        const entered = deferred(), release = deferred(), input = prepare(1);
        await transaction(h, async b => {
          b.afterNextResult(async () => { entered.resolve(); await release.promise; });
          const first = held === 'journal' ? prepareWorkspaceOperationOnConnection(b.database, input)
            : persistNativeWorkspaceCopiesOnConnection(b.database, copy);
          await entered.promise;
          try {
            if (held === 'journal') await assert.rejects(persistNativeWorkspaceCopiesOnConnection(b.database, copy), nativeConflict);
            else await assert.rejects(readWorkspaceOperationJournalOnConnection(b.database, input.operationId), transactionConflict);
          } finally { release.resolve(); }
          await assert.rejects(first, held === 'journal' ? transactionConflict : nativeConflict);
          assert(b.sql.every(sql => !/\b(?:workspace_file_operations|workspace_file_operation_steps|collaboration_native_copy_receipts)\b/iu.test(sql)),
            'Cross-domain poison is observed before any original domain SQL, including receipt reads.');
        }, false);
      }
      assert.deepEqual(await snapshot(h), before);
    });

    await group('original class retains exact lost-COMMIT-before/after recovery for all six mutation operations', async () => {
      const input = prepare(1), intent = step(input.operationId), before = h.metrics();
      h.fault('before'); await assert.rejects(h.journal.prepare(input), WorkspaceOperationJournalUncertainCommitError);
      assert.equal(await h.journal.get(input.operationId), null);
      h.fault('after'); const prepared = await h.journal.prepare(input);
      assert.equal(prepared.requestHash, serializeWorkspaceOperationRequest(input.request).requestHash);
      h.fault('after'); assert.equal((await h.journal.beginStep(intent)).status, 'intent');
      h.fault('before'); await assert.rejects(h.journal.finishStep(finish(intent)), WorkspaceOperationJournalUncertainCommitError);
      assert.equal((await h.journal.get(input.operationId))!.steps[0].status, 'intent');
      h.fault('after'); assert.equal((await h.journal.finishStep(finish(intent))).status, 'applied');
      const failure = { operationId: input.operationId, errorCode: 'recoverable', recoveryRequired: true };
      h.fault('after'); const failed = await h.journal.fail(failure);
      assert.equal(failed.status, 'recovery_required');
      h.fault('before'); await assert.rejects(h.journal.resume({ operationId: input.operationId, expectedRevision: failed.revision }),
        WorkspaceOperationJournalUncertainCommitError);
      assert.equal((await h.journal.get(input.operationId))!.status, 'recovery_required');
      h.fault('after'); const resumed = await h.journal.resume({ operationId: input.operationId, expectedRevision: failed.revision });
      assert.equal(resumed.status, 'running'); assert.equal(resumed.revision, failed.revision + 1);
      h.fault('after'); assert.equal((await h.journal.complete(input.operationId)).status, 'completed');
      assert.equal(h.metrics().discarded - before.discarded, 9, 'Every unacknowledged class COMMIT discards that actual connection.');
      const originalClassResult = await h.journal.get(input.operationId);
      await transaction(h, async b => {
        assert.deepEqual(await readWorkspaceOperationJournalOnConnection(b.database, input.operationId), originalClassResult);
      });
    });
    return groups;
  });
}

function failureDetails(error: unknown): unknown {
  if (!(error instanceof Error)) return 'Borrowed journal fixture failed with a non-Error value.';
  return { name: error.name, stack: (error.stack ?? error.message).replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]'),
    ...(error.cause === undefined ? {} : { cause: failureDetails(error.cause) }),
    ...(error instanceof AggregateError ? { errors: error.errors.map(failureDetails) } : {}) };
}
main().catch(error => {
  console.error(JSON.stringify(failureDetails(error), null, 2));
  process.exitCode = 1;
});

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import type { SqlConnection } from '../app/lib/db';
import { WORKSPACE_OPERATION_JOURNAL_STATEMENTS } from '../app/lib/db/workspace-operation-journal-migration';
import { assertWorkspaceOperationCopyOriginCurrent, captureWorkspaceOperationCopyOrigin, captureWorkspaceOperationCopyMcpOrigin,
  type WorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import { serializeWorkspaceOperationRequest, WorkspaceOperationJournal, WorkspaceOperationJournalConflictError,
  WorkspaceOperationJournalUncertainCommitError, type WorkspaceOperationRequest } from '../app/lib/files/workspace-operation-journal';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

// This suite proves durable original request DATA. Current authorization and
// native-copy mutation authority remain the real caller's separate obligations.
const PREFIX = 'canvas_copy_origin_test_';
const SCHEMA = new RegExp(`^${PREFIX}[0-9a-f]{32}$`, 'u');
type Fault = 'none' | 'before' | 'after';
type Prepare = Parameters<WorkspaceOperationJournal['prepare']>[0];

function managedDatabase(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  const url = new URL(process.env.DATABASE_URL);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.port === '55433' && decodeURIComponent(url.pathname) === '/canvas_notebook' && !url.search && !url.hash,
  'Copy-origin tests require managed loopback PostgreSQL at 55433/canvas_notebook.');
  return url;
}

function identifier(schema: string): string {
  assert(SCHEMA.test(schema), 'Only the generated private copy-origin schema may be addressed.');
  return `"${schema}"`;
}

function workspace(id: string): WorkspaceContext {
  return { workspaceId: id, workspaceType: 'personal', organizationId: null, customerId: null, projectId: null,
    ownerUserId: 'copy-origin-user', rootPath: `/unused-copy-origin/${id}`, rootRelativePath: `users/${id}`,
    legacy: false, status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true,
      canCreatePublicLinks: false, canManageWorkspace: true, canRunAgent: true } };
}

function origin(source: WorkspaceContext, destination: WorkspaceContext,
  sessionId: string | null = 'original-session'): WorkspaceOperationCopyOrigin {
  return captureWorkspaceOperationCopyOrigin({ actor: { type: 'agent', userId: 'copy-origin-user',
    actorId: 'pi-original-agent', sessionId }, sourceWorkspace: source, destinationWorkspace: destination });
}

function input(source: WorkspaceContext, destination: WorkspaceContext): Prepare {
  return { operationId: randomUUID(), planId: 'a'.repeat(64), actor: { type: 'agent', id: 'copy-origin-user' },
    request: { kind: 'copy', selections: [{ sourcePath: 'notes/source.md', destinationPath: 'copies/source.md' }],
      origin: origin(source, destination) }, sourceWorkspaceId: source.workspaceId,
    destinationWorkspaceId: destination.workspaceId, expectedStepCount: 1 };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function withFixture(run: (fixture: {
  journal: WorkspaceOperationJournal; source: WorkspaceContext; destination: WorkspaceContext;
  fault: (value: Fault) => void; metrics: () => { opened: number; closed: number; discarded: number };
  gateNextCheckout: (entered: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>) => void;
  openConnection: () => Promise<SqlConnection>; pool: Pool;
}) => Promise<number>): Promise<void> {
  const url = managedDatabase();
  if (!url) { console.log('SKIP copy-origin PostgreSQL: managed PG18 connection not supplied.'); return; }
  const schema = `${PREFIX}${randomUUID().replaceAll('-', '')}`;
  const applicationName = `copy-origin-${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3_000,
    allowExitOnIdle: true, application_name: `${applicationName}-admin` });
  let pool: Pool | undefined, schemaOid: string | undefined, created = false, failed = false, primary: unknown;
  let opened = 0, closed = 0, discarded = 0, completed = 0, fault: Fault = 'none';
  let gate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  try {
    const identity = (await admin.query(`SELECT current_setting('server_version_num')::int AS version,
      current_database() AS database`)).rows[0];
    assert.equal(Math.floor(identity.version / 10_000), 18);
    assert.equal(identity.database, 'canvas_notebook');
    await admin.query(`CREATE SCHEMA ${identifier(schema)}`); created = true;
    const actual = (await admin.query(`SELECT oid::text AS oid,pg_get_userbyid(nspowner)=current_user AS owned
      FROM pg_namespace WHERE nspname=$1`, [schema])).rows[0];
    assert.equal(actual.owned, true); schemaOid = actual.oid;
    console.log(JSON.stringify({ fixture: 'copy-origin-journal', schema, schemaOid, applicationName }));
    pool = new Pool({ connectionString: url.toString(), max: 3, connectionTimeoutMillis: 3_000,
      allowExitOnIdle: true, application_name: applicationName,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=4000` });
    assert.equal((await pool.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    for (let pass = 0; pass < 2; pass++) {
      for (const statement of WORKSPACE_OPERATION_JOURNAL_STATEMENTS) await pool.query(statement);
    }
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind='r'`, [schema])).rows[0].count, 2);
    const fixturePool = pool;
    const openConnection = async (): Promise<SqlConnection> => {
      if (gate) { const held = gate; gate = undefined; held.entered.resolve(); await held.release.promise; }
      const client = await fixturePool.connect(); opened += 1;
      let released = false;
      const query = async (sql: string, values: unknown[] = []) => {
        assert.equal(released, false, 'Closed journal connection must not be reused.');
        if (sql === 'COMMIT' && fault !== 'none') {
          const current = fault; fault = 'none';
          if (current === 'after') await client.query(sql, values);
          throw new Error(`Synthetic ${current} journal COMMIT acknowledgement loss.`);
        }
        return client.query(sql, values);
      };
      return { get: async (sql, values) => (await query(sql, values)).rows[0],
        all: async (sql, values) => (await query(sql, values)).rows,
        run: async (sql, values) => ({ changes: (await query(sql, values)).rowCount ?? 0 }),
        close: async error => {
          assert.equal(released, false, 'Each checkout must close exactly once.');
          released = true; closed += 1;
          if (error) discarded += 1;
          client.release(error);
        } };
    };
    completed = await run({ pool, journal: new WorkspaceOperationJournal({ openConnection }), openConnection,
      source: workspace('origin-source'), destination: workspace('origin-destination'),
      fault: value => { assert.equal(fault, 'none'); fault = value; }, metrics: () => ({ opened, closed, discarded }),
      gateNextCheckout: (entered, release) => { assert.equal(gate, undefined); gate = { entered, release }; } });
    assert.equal(opened, closed, 'All original Journal and commit-recovery checkouts closed.');
    assert.equal(pool.waitingCount, 0);
  } catch (error) { failed = true; primary = error; }
  finally {
    const cleanup: unknown[] = [];
    try { await pool?.end(); } catch (error) { cleanup.push(error); }
    try {
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1',
        [applicationName])).rows[0].count, 0, 'No private test-pool backends remain.');
    } catch (error) { cleanup.push(error); }
    if (created) try {
      const actual = (await admin.query(`SELECT oid::text AS oid,pg_get_userbyid(nspowner)=current_user AS owned
        FROM pg_namespace WHERE nspname=$1`, [schema])).rows[0];
      assert.equal(actual?.oid, schemaOid); assert.equal(actual?.owned, true);
      await admin.query(`DROP SCHEMA ${identifier(schema)} CASCADE`);
      assert.equal((await admin.query(`SELECT count(*)::int AS count FROM pg_namespace
        WHERE nspname=$1 OR oid::text=$2`, [schema, schemaOid])).rows[0].count, 0);
    } catch (error) { cleanup.push(error); }
    try { await admin.end(); } catch (error) { cleanup.push(error); }
    if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'Owned copy-origin fixture cleanup failed.');
    if (failed) throw primary;
  }
  console.log(JSON.stringify({ test: 'workspace-operation-copy-origin-postgres-test', groups: completed,
    schema, schemaOid, applicationName, schemaRemoved: true, poolClosed: true, opened, closed, discarded }));
}

async function main(): Promise<void> {
  await withFixture(async h => {
    let groups = 0;
    const group = async (label: string, run: () => Promise<void>) => {
      await run(); groups += 1; console.log(`PASS copy-origin ${groups}: ${label}`);
    };
    const original = input(h.source, h.destination);
    await group('actual Journal persists canonical original scope, agent, session and request hash', async () => {
      const expected = serializeWorkspaceOperationRequest(original.request);
      const prepared = await h.journal.prepare(original);
      assert.equal(prepared.requestJson, expected.requestJson); assert.equal(prepared.requestHash, expected.requestHash);
      assert.equal(prepared.requestHash, createHash('sha256').update(prepared.requestJson).digest('hex'));
      const stored = await h.journal.get(original.operationId);
      assert.equal(stored?.requestJson, expected.requestJson);
      assert.deepEqual(JSON.parse(stored!.requestJson).origin, original.request.origin);
      assert.deepEqual(stored?.actor, { type: 'agent', id: 'copy-origin-user' });
      const reordered: WorkspaceOperationRequest = { selections: [{ destinationPath: 'copies/source.md', sourcePath: 'notes/source.md' }],
        origin: original.request.origin, kind: 'copy' };
      assert.deepEqual(await h.journal.prepare({ ...original, request: reordered }), prepared);
      assert.equal((await h.pool.query('SELECT count(*)::int AS count FROM workspace_file_operations')).rows[0].count, 1);
    });

    await group('new-session recovery keeps the original data through the real origin helper and Journal retry', async () => {
      const before = await h.journal.get(original.operationId);
      const storedRequest = JSON.parse(before!.requestJson) as WorkspaceOperationRequest;
      const preserved = assertWorkspaceOperationCopyOriginCurrent(storedRequest.origin, origin(h.source, h.destination, 'new-session'));
      assert.equal(preserved.actor.sessionId, 'original-session'); assert.equal(preserved.actor.actorId, 'pi-original-agent');
      assert.equal(Object.isFrozen(preserved.actor), true);
      const restarted = new WorkspaceOperationJournal({ openConnection: h.openConnection });
      const retried = await restarted.prepare({ ...original, request: { ...storedRequest, origin: preserved } });
      assert.equal(retried.requestJson, before!.requestJson); assert.equal(retried.requestHash, before!.requestHash);
      assert.deepEqual(await restarted.get(original.operationId), before);
      await assert.rejects(restarted.prepare({ ...original,
        request: { ...storedRequest, origin: origin(h.source, h.destination, 'new-session') } }), WorkspaceOperationJournalConflictError);
    });

    await group('agent, actor type, all scope fields and durable request substitutions conflict', async () => {
      const current = original.request.origin!;
      const changes: Array<{ label: string; value: WorkspaceOperationCopyOrigin }> = [
        { label: 'agent id', value: { ...current, actor: { ...current.actor, actorId: 'other-agent' } } },
        { label: 'user actor', value: { ...current, actor: { ...current.actor, type: 'user', actorId: 'copy-origin-user' } } },
      ];
      for (const field of ['sourceScope', 'destinationScope'] as const) {
        for (const [key, value] of Object.entries({ workspaceType: 'team', organizationId: 'other-org', customerId: 'other-customer',
          projectId: 'other-project', ownerUserId: 'other-owner', rootPath: '/other-root', rootRelativePath: 'other/path', legacy: true })) {
          changes.push({ label: `${field}.${key}`, value: { ...current, [field]: { ...current[field], [key]: value } } });
        }
      }
      for (const change of changes) {
        assert.throws(() => assertWorkspaceOperationCopyOriginCurrent(current, change.value), { code: 'COPY_ORIGIN_CHANGED' }, change.label);
        await assert.rejects(h.journal.prepare({ ...original, actor: { ...original.actor, type: change.value.actor.type },
          request: { ...original.request, origin: change.value } }), WorkspaceOperationJournalConflictError, change.label);
      }
      await assert.rejects(h.journal.prepare({ ...original, request: { ...original.request,
        selections: [{ sourcePath: 'other.md', destinationPath: 'copies/source.md' }] } }), WorkspaceOperationJournalConflictError);
      await assert.rejects(h.journal.prepare({ ...original, planId: 'b'.repeat(64) }), WorkspaceOperationJournalConflictError);
      assert.equal((await h.journal.get(original.operationId))!.requestHash, serializeWorkspaceOperationRequest(original.request).requestHash);
    });

    await group('malformed origin and actor/scope header mismatch reject before any SQL checkout', async () => {
      const mutations: Array<(candidate: Prepare) => void> = [
        candidate => { candidate.actor = { type: 'agent', id: 'other-user' }; },
        candidate => { candidate.actor = { type: 'user', id: 'copy-origin-user' }; },
        candidate => { candidate.sourceWorkspaceId = 'other-source'; },
        candidate => { candidate.destinationWorkspaceId = 'other-destination'; },
        candidate => { (candidate.request.origin as unknown as { version: number }).version = 2; },
        candidate => { (candidate.request.origin!.actor as unknown as { sessionId: number }).sessionId = 123; },
        candidate => { Object.assign(candidate.request.origin!, { unexpected: true }); },
        candidate => { candidate.request.kind = 'move'; },
      ];
      for (const mutate of mutations) {
        const candidate = structuredClone(original); candidate.operationId = randomUUID(); mutate(candidate);
        const opened = h.metrics().opened;
        await assert.rejects(h.journal.prepare(candidate));
        assert.equal(h.metrics().opened, opened, 'Invalid input never checked out a mutation connection.');
      }
      let getterCalls = 0;
      const accessor = structuredClone(original);
      Object.defineProperty(accessor.request, 'origin', { enumerable: true, get: () => { getterCalls += 1; return original.request.origin; } });
      await assert.rejects(h.journal.prepare(accessor)); assert.equal(getterCalls, 0);
    });

    await group('unacknowledged prepare before actual COMMIT is not reported as durable', async () => {
      const candidate = input(h.source, h.destination), before = h.metrics();
      h.fault('before');
      await assert.rejects(h.journal.prepare(candidate), WorkspaceOperationJournalUncertainCommitError);
      assert.equal(await h.journal.get(candidate.operationId), null);
      assert.equal(h.metrics().discarded, before.discarded + 1);
      const prepared = await h.journal.prepare(candidate);
      assert.equal(prepared.requestHash, serializeWorkspaceOperationRequest(candidate.request).requestHash);
    });

    await group('lost acknowledgement after real prepare COMMIT is recovered with exact original pins on a fresh checkout', async () => {
      const candidate = input(h.source, h.destination), before = h.metrics();
      h.fault('after');
      const prepared = await h.journal.prepare(candidate);
      assert.equal(prepared.status, 'prepared'); assert.equal(h.metrics().discarded, before.discarded + 1);
      assert.equal(h.metrics().opened, before.opened + 2, 'Mutation and durable recovery use separate actual checkouts.');
      assert.equal(prepared.requestJson, serializeWorkspaceOperationRequest(candidate.request).requestJson);
      assert.equal(JSON.parse((await h.journal.get(candidate.operationId))!.requestJson).origin.actor.sessionId, 'original-session');
    });

    await group('request origin and all prepare identity primitives are captured before the real checkout resolves', async () => {
      const candidate = structuredClone(input(h.source, h.destination)), expected = serializeWorkspaceOperationRequest(candidate.request);
      const entered = deferred(), release = deferred(); h.gateNextCheckout(entered, release);
      const operationId = candidate.operationId, sourceWorkspaceId = candidate.sourceWorkspaceId,
        destinationWorkspaceId = candidate.destinationWorkspaceId, promise = h.journal.prepare(candidate);
      await entered.promise;
      candidate.actor.id = 'later-user'; candidate.actor.type = 'user'; candidate.operationId = randomUUID();
      candidate.sourceWorkspaceId = 'later-source'; candidate.destinationWorkspaceId = 'later-destination';
      candidate.planId = 'b'.repeat(64); candidate.expectedStepCount = 2;
      (candidate.request.origin!.actor as { sessionId: string | null }).sessionId = 'later-session';
      (candidate.request.origin!.destinationScope as { rootPath: string }).rootPath = '/later-root';
      (candidate.request.selections as Array<{ sourcePath: string; destinationPath: string }>)[0].destinationPath = 'later.md';
      release.resolve();
      const prepared = await promise;
      assert.equal(prepared.requestJson, expected.requestJson); assert.equal(prepared.requestHash, expected.requestHash);
      assert.equal(prepared.operationId, operationId);
      assert.deepEqual(prepared.actor, { type: 'agent', id: 'copy-origin-user' });
      assert.equal(prepared.sourceWorkspaceId, sourceWorkspaceId);
      assert.equal(prepared.destinationWorkspaceId, destinationWorkspaceId);
      assert.equal(prepared.planId, 'a'.repeat(64)); assert.equal(prepared.expectedStepCount, 1);
      assert.equal((await h.journal.get(operationId))!.requestJson, expected.requestJson);
      assert.equal(await h.journal.get(candidate.operationId), null);
    });

    await group('legacy requests remain byte-compatible and recovery never invents original context', async () => {
      const candidate = input(h.source, h.destination);
      candidate.request = { kind: 'copy', selections: [{ sourcePath: 'old.md', destinationPath: 'copy.md' }] };
      const expectedJson = '{"kind":"copy","selections":[{"destinationPath":"copy.md","sourcePath":"old.md"}]}';
      const serialized = serializeWorkspaceOperationRequest(candidate.request);
      assert.equal(serialized.requestJson, expectedJson);
      assert.equal(serialized.requestHash, createHash('sha256').update(expectedJson).digest('hex'));
      h.fault('after'); const prepared = await h.journal.prepare(candidate);
      assert.equal(prepared.requestJson, expectedJson);
      assert.equal(Object.hasOwn(JSON.parse((await h.journal.get(candidate.operationId))!.requestJson), 'origin'), false);
      assert.deepEqual(await h.journal.prepare(candidate), prepared);
      await assert.rejects(h.journal.prepare({ ...candidate, request: { ...candidate.request, origin: original.request.origin } }),
        WorkspaceOperationJournalConflictError, 'A later retry cannot upgrade a legacy durable request by inventing origin.');
    });

    await group('MCP journal retry retains OriginalA, full client identity and every stored byte including xmin', async () => {
      const makeMcpOrigin = (sessionId: string, clientId = 'copy-origin-oauth-client') => captureWorkspaceOperationCopyMcpOrigin({
        userId: 'copy-origin-user', clientId, sessionId, sourceWorkspace: h.source, destinationWorkspace: h.destination });
      const candidate = input(h.source, h.destination); candidate.request.origin = makeMcpOrigin('SID_A');
      const serialized = serializeWorkspaceOperationRequest(candidate.request);
      await h.journal.prepare(candidate);
      const snapshot = async () => (await h.pool.query('SELECT *,xmin::text AS xmin FROM workspace_file_operations WHERE operation_id=$1',
        [candidate.operationId])).rows;
      const before = await snapshot(); assert.equal(before.length, 1);
      const stored = JSON.parse(before[0].request_json) as WorkspaceOperationRequest;
      const retained = assertWorkspaceOperationCopyOriginCurrent(stored.origin, makeMcpOrigin('SID_B'));
      assert.equal(retained.version, 2); assert.equal(retained.actor.sessionId, 'SID_A');
      const retried = await h.journal.prepare({ ...candidate, request: { ...stored, origin: retained } });
      assert.equal(retried.requestJson, serialized.requestJson); assert.equal(retried.requestHash, serialized.requestHash);
      assert.deepEqual(await snapshot(), before);
      // A fresh SID is current authorization data, not a replacement for the
      // immutable journal intent. This proves data binding, not OAuth rights.
      await assert.rejects(h.journal.prepare({ ...candidate, request: { ...stored, origin: makeMcpOrigin('SID_B') } }),
        WorkspaceOperationJournalConflictError);
      await assert.rejects(h.journal.prepare({ ...candidate, request: { ...stored, origin: makeMcpOrigin('SID_A', 'foreign-client') } }),
        WorkspaceOperationJournalConflictError);
      assert.throws(() => assertWorkspaceOperationCopyOriginCurrent(stored.origin, makeMcpOrigin('SID_B', 'foreign-client')),
        { code: 'COPY_ORIGIN_CHANGED' });
      assert.deepEqual(await snapshot(), before);
    });
    return groups;
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });

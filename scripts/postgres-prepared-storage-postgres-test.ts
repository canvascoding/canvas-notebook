import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Query, type PoolClient, type QueryResult } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Real adapter / PG18 / fixed storage binders. This is a catalogue/read/lifetime
// test, not a Claim, actor authorization, Owner completion or performance proof.
let stage = 'setup', groups = 0, completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

export async function postgresPreparedStoragePostgresTest(): Promise<void> {
  const originalBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    const { openDb } = await import('../app/lib/db');
    const { bindWorkspaceOperationOriginalDeleteStorageOnConnection } = await import('../app/lib/files/workspace-operation-original-delete-storage');
    const { bindWorkspaceOperationOriginalMoveHandoffStorageOnConnection } = await import('../app/lib/files/workspace-operation-original-move-handoff-storage');
    assert.match(h.schema, /^copy_metadata_[a-f0-9]{32}$/u);
    const database: SqlConnection = await openDb();
    let began = false, closed = false, failed = false, primary: unknown;
    const trace: { client?: PoolClient; rows: MetadataSqlEvent[] } = { rows: [] };
    const identitySql = `SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
      pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema_name,
      to_regnamespace(current_schema())::oid::text AS schema_oid,datid::text AS database_oid
      FROM pg_stat_activity WHERE pid=pg_backend_pid()`;
    try {
      assert.equal(typeof database.getPrepared, 'function');
      stage = 'same actual B/XID and get/getPrepared value parity';
      const idleBefore = await database.get(identitySql) as Record<string, unknown>;
      assert.equal(idleBefore.xid, null); assert.equal(idleBefore.schema_name, h.schema); assert.equal(idleBefore.schema_oid, h.schemaOid);
      assert.deepEqual(await database.getPrepared!(identitySql), idleBefore, 'Prepared SELECT cannot assign a transaction ID.');
      await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
      const assigned = await database.get('SELECT pg_current_xact_id()::text AS xid') as { xid: string };
      assert.match(assigned.xid, /^[1-9][0-9]*$/u);
      const identity = await database.get(identitySql) as Record<string, unknown>;
      assert.equal(identity.pid, idleBefore.pid); assert.equal(identity.start, idleBefore.start); assert.equal(identity.xid, assigned.xid);
      const sql = `SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
        pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema_name,
        $1::text AS marker,$2::bigint AS integer_value,$2::bigint::text AS exact_integer,
        $3::jsonb AS object_value,$4::bytea AS binary_value,$5::text AS nullable_value,
        $6::boolean AS boolean_value,current_timestamp AS transaction_time
        FROM pg_stat_activity WHERE pid=pg_backend_pid()`;
      const originalPalette: unknown[][] = [
        [`A-${crypto.randomUUID()}`, '9007199254740993', JSON.stringify({ text: 'ä漢🙂', nested: [null, true, 7] }), Buffer.from([0, 255, 127, 1]), null, true],
        [`B-${crypto.randomUUID()}`, '-9007199254740993', JSON.stringify({ text: 'different', nested: [false, 8] }), Buffer.from([4, 0, 128]), 'present', false],
      ];
      await h.withProbe(async event => {
        if (event.text !== sql) return;
        if (trace.client === undefined) trace.client = event.client; else assert.equal(event.client, trace.client);
        assert(trace.rows.length < 32); trace.rows.push(event);
      }, async () => {
        for (const values of originalPalette) {
          const ordinary = await database.get(sql, values), prepared = await database.getPrepared!(sql, values);
          assert.deepEqual(prepared, ordinary);
          assert.equal(prepared, trace.rows.at(-1)!.result.rows[0], 'Probe and caller see the original actual query result.');
          const value = prepared as Record<string, unknown>;
          assert.equal(value.pid, identity.pid); assert.equal(value.start, identity.start); assert.equal(value.xid, identity.xid);
          assert.equal(value.schema_name, h.schema); assert.equal(value.marker, values[0]); assert.equal(value.exact_integer, values[1]);
          assert.deepEqual(value.object_value, JSON.parse(values[2] as string)); assert.deepEqual(value.binary_value, values[3]);
          assert.equal(value.nullable_value, values[4]); assert.equal(value.boolean_value, values[5]);
        }
      });
      assert.equal(trace.rows.length, 4); assert(trace.client);
      assert.deepEqual(trace.rows.map(event => event.values), [originalPalette[0], originalPalette[0], originalPalette[1], originalPalette[1]]);
      groups++; console.log(`PASS prepared storage ${groups}: actual adapter B/XID and original typed values`);

      stage = 'actual server named-statement reuse without result caching';
      const before = await database.all(`SELECT name,statement,from_sql,parameter_types::text AS parameter_types,
        generic_plans::text AS generic_plans,custom_plans::text AS custom_plans FROM pg_prepared_statements WHERE statement=$1`, [sql]) as Array<Record<string, unknown>>;
      assert.equal(before.length, 1); assert.equal(before[0].from_sql, false); assert.equal(before[0].statement, sql);
      assert.equal(typeof before[0].name, 'string'); assert((before[0].name as string).startsWith('canvas_sql_'));
      assert.equal(typeof before[0].parameter_types, 'string');
      for (let index = 0; index < 8; index++) {
        const values = [...originalPalette[index % 2]]; values[0] = `fresh-${index}-${crypto.randomUUID()}`;
        const prepared = await database.getPrepared!(sql, values) as Record<string, unknown>;
        assert.equal(prepared.marker, values[0]); assert.equal(prepared.xid, identity.xid);
        assert.deepEqual(prepared, await database.get(sql, values));
      }
      const after = await database.all(`SELECT name,statement,from_sql,parameter_types::text AS parameter_types,
        generic_plans::text AS generic_plans,custom_plans::text AS custom_plans FROM pg_prepared_statements WHERE statement=$1`, [sql]) as Array<Record<string, unknown>>;
      assert.equal(after.length, 1); assert.equal(after[0].name, before[0].name); assert.equal(after[0].statement, before[0].statement);
      assert.equal(after[0].from_sql, false); assert.equal(after[0].parameter_types, before[0].parameter_types);
      const beforeExecutions = BigInt(before[0].generic_plans as string) + BigInt(before[0].custom_plans as string);
      const afterExecutions = BigInt(after[0].generic_plans as string) + BigInt(after[0].custom_plans as string);
      assert.equal(afterExecutions - beforeExecutions, BigInt(8));
      console.log(JSON.stringify({ preparedPlanCounters: { generic: after[0].generic_plans, custom: after[0].custom_plans }, performanceClaim: false }));
      groups++; console.log(`PASS prepared storage ${groups}: actual session statement reused; every execution reads its parameters`);

      stage = 'fresh full and fingerprint catalogues see same-TX DDL and exact rollback restoration';
      const source = { schemaName: h.schema, schemaOid: Number(identity.schema_oid), databaseOid: Number(identity.database_oid) };
      assert(Number.isSafeInteger(source.schemaOid) && source.schemaOid > 0); assert(Number.isSafeInteger(source.databaseOid) && source.databaseOid > 0);
      const catalogues = new Map<string, number>();
      const specifications = [
        { kind: 'delete', bind: bindWorkspaceOperationOriginalDeleteStorageOnConnection,
          table: 'workspace_file_operation_delete_intents', column: 'plan_id', procedure: 'reject_workspace_file_operation_delete_mutation', error: 'ORIGINAL_DELETE_STORAGE_CHANGED' },
        { kind: 'handoff', bind: bindWorkspaceOperationOriginalMoveHandoffStorageOnConnection,
          table: 'collaboration_native_file_operation_intents', column: 'request_id', procedure: 'immutable_native_file_operation_record', error: 'ORIGINAL_MOVE_STORAGE_CHANGED' },
      ] as const;
      await h.withProbe(async event => {
        if (!event.text.includes('WITH current_relations AS MATERIALIZED') && !event.text.includes('WITH observed_relations AS MATERIALIZED')) return;
        assert.equal(event.client, trace.client); assert(catalogues.size < 8 || catalogues.has(event.text));
        catalogues.set(event.text, (catalogues.get(event.text) ?? 0) + 1);
        const own = (await event.raw(identitySql)).rows[0];
        assert.equal(own.pid, identity.pid); assert.equal(own.start, identity.start); assert.equal(own.xid, identity.xid);
      }, async () => {
        for (const spec of specifications) {
          const bound = await spec.bind(database, source); await bound.assertCurrent(); await bound.assertCurrent();
          // The original binder's locks precede every SAVEPOINT. Rolling back a
          // fault must not release those locks and manufacture a restore failure.
          for (const fault of ['procedure', 'constraint', 'column'] as const) {
            stage = `${spec.kind} ${fault} same-B catalogue fault`;
            await database.run('SAVEPOINT prepared_storage_drift');
            try {
              if (fault === 'procedure') {
                const rows = await database.all(`SELECT p.oid::text AS oid,p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname=$1 AND p.proname=$2 AND p.pronargs=0 ORDER BY p.oid LIMIT 2`, [h.schema, spec.procedure]) as Array<{ oid: string; prosrc: string }>;
                assert.equal(rows.length, 1); assert.equal(typeof rows[0].prosrc, 'string');
                const tag = `$prepared_${crypto.randomBytes(8).toString('hex')}$`; assert(!rows[0].prosrc.includes(tag));
                await database.run(`CREATE OR REPLACE FUNCTION "${h.schema}"."${spec.procedure}"() RETURNS trigger LANGUAGE plpgsql AS ${tag}${rows[0].prosrc}\n-- prepared fresh-catalogue fault\n${tag}`);
              } else if (fault === 'constraint') {
                // Every target is an existing genuine FK; no name is guessed.
                const target = spec.kind === 'delete' ? spec.table : 'collaboration_native_file_operation_receipts';
                const constraints = await database.all(`SELECT c.conname,c.condeferrable,c.condeferred FROM pg_constraint c
                  WHERE c.conrelid=to_regclass($1) AND c.contype='f' ORDER BY c.oid LIMIT 1`, [`"${h.schema}"."${target}"`]) as Array<{ conname: string; condeferrable: boolean; condeferred: boolean }>;
                assert.equal(constraints.length, 1); assert.equal(constraints[0].condeferrable, false); assert.equal(constraints[0].condeferred, false);
                const identifier = `"${constraints[0].conname.replaceAll('"', '""')}"`;
                await database.run(`ALTER TABLE "${h.schema}"."${target}" ALTER CONSTRAINT ${identifier} DEFERRABLE INITIALLY DEFERRED`);
              } else await database.run(`ALTER TABLE "${h.schema}"."${spec.table}" ALTER COLUMN "${spec.column}" DROP NOT NULL`);
              await assert.rejects(bound.assertCurrent(), { code: spec.error, status: 409 });
              await assert.rejects(spec.bind(database, source), { code: spec.error, status: 409 });
            } finally {
              await database.run('ROLLBACK TO SAVEPOINT prepared_storage_drift'); await database.run('RELEASE SAVEPOINT prepared_storage_drift');
            }
            await bound.assertCurrent();
            const restored = await database.get(identitySql) as Record<string, unknown>;
            assert.equal(restored.pid, identity.pid); assert.equal(restored.start, identity.start); assert.equal(restored.xid, identity.xid);
          }
        }
      });
      assert.equal(catalogues.size, 4, 'Both real binders must execute separate initial/full and fresh/fingerprint SQL.');
      const statements = await database.all(`SELECT name,statement,from_sql,generic_plans::text AS generic_plans,custom_plans::text AS custom_plans
        FROM pg_prepared_statements WHERE statement=ANY($1::text[]) ORDER BY name`, [[...catalogues.keys()]]) as Array<Record<string, unknown>>;
      assert.equal(statements.length, catalogues.size); assert.equal(new Set(statements.map(row => row.name)).size, catalogues.size);
      for (const statement of statements) {
        assert.equal(statement.from_sql, false); assert(catalogues.has(statement.statement as string));
        assert.equal(typeof statement.name, 'string'); assert((statement.name as string).startsWith('canvas_sql_'));
        assert((catalogues.get(statement.statement as string) ?? 0) > 1);
      }
      groups++; console.log(`PASS prepared storage ${groups}: all six real DDL faults reject fresh/full checks and rollback restores the same locked catalogue`);

      stage = 'actual QueryConfig, callback, Query-object and string probe transparency';
      const raw = trace.client; assert(raw);
      const marker = `overload-${crypto.randomUUID()}`;
      const overloadSql = 'SELECT $1::text AS marker,$2::integer AS number';
      let overloadObservations = 0, callbacks = 0;
      await h.withProbe(async event => {
        if (event.text === overloadSql) overloadObservations++;
      }, async () => {
        const rows = await raw.query({ text: overloadSql, values: [marker, 7], rowMode: 'array' });
        assert.deepEqual(rows.rows, [[marker, 7]]); assert.equal(overloadObservations, 0, 'Unknown Config overload is forwarded rather than rewritten.');
        const callbackRows = await new Promise<QueryResult>((resolve, reject) => {
          raw.query({ text: overloadSql, values: [marker, 8] }, (error, value) => {
            callbacks++; if (error) reject(error); else resolve(value);
          });
        });
        assert.equal(callbacks, 1); assert.deepEqual(callbackRows.rows, [{ marker, number: 8 }]); assert.equal(overloadObservations, 0);
        const query = new Query<{ marker: string; number: number }>({ text: overloadSql, values: [marker, 9] });
        const streamedRows: Array<{ marker: string; number: number }> = [];
        await new Promise<void>((resolve, reject) => {
          query.on('row', row => { streamedRows.push(row); }); query.once('end', () => resolve()); query.once('error', error => reject(error));
          assert.equal(raw.query(query), query, 'Actual Query object return identity remains intact.');
        });
        assert.deepEqual(streamedRows, [{ marker, number: 9 }]); assert.equal(overloadObservations, 0);
        assert.deepEqual(await database.get(overloadSql, [marker, 10]), { marker, number: 10 }); assert.equal(overloadObservations, 1);
        assert.deepEqual(await database.getPrepared!(overloadSql, [marker, 11]), { marker, number: 11 }); assert.equal(overloadObservations, 2);
      });
      await database.run('ROLLBACK'); began = false;
      const idleAfter = await database.getPrepared!(identitySql) as Record<string, unknown>;
      assert.equal(idleAfter.pid, identity.pid); assert.equal(idleAfter.start, identity.start); assert.equal(idleAfter.xid, null);
      await database.close(); closed = true;
      await assert.rejects(async () => database.getPrepared!('SELECT 1'), /closed/iu); await database.close();
      // A pool checkout can reuse the same backend or select another healthy
      // one; neither is invented as a forced fresh-backend/performance proof.
      const next = await openDb();
      try {
        assert.equal(typeof next.getPrepared, 'function');
        const actual = await next.getPrepared!(identitySql) as Record<string, unknown>;
        assert.equal(actual.schema_name, h.schema); assert.equal(actual.schema_oid, h.schemaOid); assert.equal(actual.xid, null);
        assert(Number.isSafeInteger(actual.pid) && Number(actual.pid) > 0);
        console.log(JSON.stringify({ healthyCheckout: true, reusedSameBackend: actual.pid === identity.pid && actual.start === identity.start }));
      } finally { await next.close(); }
      groups++; console.log(`PASS prepared storage ${groups}: real pg overloads, legacy/probe forwarding and closed-lease rejection`);
    } catch (error) { failed = true; primary = error; throw error; }
    finally {
      const cleanup: unknown[] = [];
      if (began) try { await database.run('ROLLBACK'); } catch (error) { cleanup.push(error); }
      if (!closed) try { await database.close(failed ? primary instanceof Error ? primary : new Error('Prepared storage fixture failed.') : undefined); }
      catch (error) { cleanup.push(error); }
      if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'Prepared storage owned connection cleanup failed.');
    }
  }); completed = true;
  } finally { if (originalBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = originalBase; }
  assert.equal(groups, 4);
  console.log(JSON.stringify({ test: 'postgres-prepared-storage', groups, scope: 'actual PG18 adapter/catalogue/overloads only; no authority, Owner, OAuth, browser or performance acceptance' }));
}

void postgresPreparedStoragePostgresTest().catch(error => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  console.error(JSON.stringify({ test: 'postgres-prepared-storage', failed: true, stage, groups,
    name: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(error.name) ? error.name : 'UnknownError',
    code: typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(code) ? code : null }));
  process.exitCode = 1;
});

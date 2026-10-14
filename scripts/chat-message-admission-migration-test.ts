import assert from 'node:assert/strict';
import { getTableConfig } from 'drizzle-orm/pg-core';

import { CHAT_MESSAGE_ADMISSION_MAX_PRIVATE_PAYLOAD_BYTES,
  runChatMessageAdmissionMigration } from '../app/lib/db/chat-message-admission-migration';
import { createTableSql, runPostgresMigrations } from '../app/lib/db/postgres';
import { piMessageDeliveryReceipts } from '../app/lib/db/schema';
import { createSharedConnectionTestDatabase } from './helpers/shared-connection-test-database';

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
const admissionColumns = ['payload_version', 'private_payload', 'execution_phase', 'execution_revision'];
const phases = ['queued', 'dispatching', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown'];
const maxRevision = '9007199254740991';

async function constraintDefinitions(database: Queryable): Promise<Record<string, unknown>[]> {
  return (await database.query(`SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid = 'pi_message_delivery_receipts'::regclass AND contype = 'c'
    ORDER BY conname`)).rows;
}

async function main(): Promise<void> {
  // Native mode uses the existing managed loopback PostgreSQL and only the
  // helper's own nonce database. Otherwise this is actual in-memory PostgreSQL.
  const fixture = await createSharedConnectionTestDatabase();
  const database = fixture.getPostgresRuntimeQueryable() as unknown as Queryable;
  const startup = () => runPostgresMigrations(database as unknown as Parameters<typeof runPostgresMigrations>[0]);
  try {
    const schemaConfig = getTableConfig(piMessageDeliveryReceipts);
    const freshSql = createTableSql(piMessageDeliveryReceipts);
    for (const check of schemaConfig.checks) assert(freshSql.includes(`CONSTRAINT "${check.name}"`), check.name);
    const freshConstraints = await constraintDefinitions(database);
    assert.equal(freshConstraints.length, 3);
    assert.match(String(freshConstraints.find(row => row.conname === 'pi_message_delivery_receipts_state_check')?.definition),
      /dispatching.*accepted/u);
    const columns = (await database.query(`SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_name = 'pi_message_delivery_receipts'
      AND column_name = ANY($1) ORDER BY column_name`, [admissionColumns])).rows;
    assert.deepEqual(columns, [
      { column_name: 'execution_phase', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'execution_revision', data_type: 'bigint', is_nullable: 'YES', column_default: null },
      { column_name: 'payload_version', data_type: 'bigint', is_nullable: 'YES', column_default: null },
      { column_name: 'private_payload', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
    await database.query(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
      VALUES ('admission-owner','Admission owner','admission-owner@example.test',1,1,1)`);
    const session = (await database.query(`INSERT INTO pi_sessions
      (session_id,user_id,agent_id,provider,model,created_at,updated_at)
      VALUES ('admission-session','admission-owner','main','test','test',1,1) RETURNING id::text AS id`)).rows[0];
    assert(session);
    const sessionId = session.id;
    let ordinal = 0;
    const insert = (values: unknown[], state = 'accepted') => database.query(`INSERT INTO pi_message_delivery_receipts
      (pi_session_db_id,client_message_id,payload_hash,runtime_token,state,payload_version,private_payload,
        execution_phase,execution_revision,created_at,updated_at)
      VALUES ($1,$2,'payload-hash','runtime-token',$3,$4,$5,$6,$7,1,1)`,
    [sessionId, `receipt-${++ordinal}`, state, ...values]);
    await insert([null, null, null, null], 'dispatching');
    await insert([null, null, null, null]);
    const legacyRows = (await database.query('SELECT * FROM pi_message_delivery_receipts ORDER BY client_message_id')).rows;

    // Model an actual old deployment: its two historical states have no new
    // columns at all. Repeated real startup must restore columns, not rows.
    for (const column of admissionColumns) await database.query(`ALTER TABLE pi_message_delivery_receipts DROP COLUMN ${column}`);
    await startup();
    await startup();
    assert.deepEqual(await constraintDefinitions(database), freshConstraints);
    assert.deepEqual((await database.query('SELECT * FROM pi_message_delivery_receipts ORDER BY client_message_id')).rows, legacyRows);

    // A partially applied additive installation is equally repeatable.
    for (const column of admissionColumns) await database.query(`ALTER TABLE pi_message_delivery_receipts DROP COLUMN ${column}`);
    await database.query('ALTER TABLE pi_message_delivery_receipts ADD COLUMN payload_version bigint');
    await runChatMessageAdmissionMigration(database);
    await startup();
    assert.deepEqual(await constraintDefinitions(database), freshConstraints);
    assert.deepEqual((await database.query('SELECT * FROM pi_message_delivery_receipts ORDER BY client_message_id')).rows, legacyRows);

    // SQL CHECK accepts NULL unless the shape explicitly closes that branch.
    // Exercise every partial-null subset instead of only one missing column.
    const complete = [1, '{}', 'queued', 1];
    for (let mask = 1; mask < 15; mask += 1) {
      const partial = complete.map((value, index) => mask & (1 << index) ? value : null);
      await assert.rejects(insert(partial), { code: '23514' });
    }
    for (const phase of phases) await insert([1, '{}', phase, 1]);
    for (const version of [-1, 0, 2]) await assert.rejects(insert([version, '{}', 'queued', 1]), { code: '23514' });
    await assert.rejects(insert([1, '{}', 'unknown-phase', 1]), { code: '23514' });
    for (const revision of ['-1', '0', '9007199254740992']) {
      await assert.rejects(insert([1, '{}', 'queued', revision]), { code: '23514' });
    }
    await assert.rejects(insert(complete, 'dispatching'), { code: '23514' });
    await assert.rejects(insert([null, null, null, null], 'running'), { code: '23514' });

    // Size is UTF-8 octets, not JavaScript characters. This payload's character
    // count is below the limit even after its bytes exceed the database budget.
    assert.equal(CHAT_MESSAGE_ADMISSION_MAX_PRIVATE_PAYLOAD_BYTES, 4 * 1024 * 1024);
    await database.query(`INSERT INTO pi_message_delivery_receipts
      (pi_session_db_id,client_message_id,payload_hash,runtime_token,state,payload_version,private_payload,
        execution_phase,execution_revision,created_at,updated_at)
      VALUES ($1,'byte-boundary','hash','runtime','accepted',1,repeat('é',$2),'queued',1,1,1)`,
    [sessionId, CHAT_MESSAGE_ADMISSION_MAX_PRIVATE_PAYLOAD_BYTES / 2]);
    assert.equal((await database.query(`SELECT octet_length(private_payload) AS bytes
      FROM pi_message_delivery_receipts WHERE client_message_id='byte-boundary'`)).rows[0]?.bytes,
    CHAT_MESSAGE_ADMISSION_MAX_PRIVATE_PAYLOAD_BYTES);
    await assert.rejects(database.query(`UPDATE pi_message_delivery_receipts
      SET private_payload=private_payload || 'é' WHERE client_message_id='byte-boundary'`), { code: '23514' });

    const cas = await database.query(`UPDATE pi_message_delivery_receipts SET execution_revision=execution_revision+1,
      execution_phase='running' WHERE client_message_id='byte-boundary' AND execution_revision=1
      RETURNING execution_revision::text AS revision`);
    assert.deepEqual(cas.rows, [{ revision: '2' }]);
    assert.deepEqual((await database.query(`UPDATE pi_message_delivery_receipts SET execution_revision=3
      WHERE client_message_id='byte-boundary' AND execution_revision=1 RETURNING client_message_id`)).rows, []);
    await database.query(`UPDATE pi_message_delivery_receipts SET execution_revision=$1
      WHERE client_message_id='byte-boundary'`, [maxRevision]);
    await assert.rejects(database.query(`UPDATE pi_message_delivery_receipts SET execution_revision=execution_revision+1
      WHERE client_message_id='byte-boundary'`), { code: '23514' });
    assert.equal((await database.query(`SELECT execution_revision::text AS revision
      FROM pi_message_delivery_receipts WHERE client_message_id='byte-boundary'`)).rows[0]?.revision, maxRevision);
    await startup();
    assert.deepEqual(await constraintDefinitions(database), freshConstraints);
    await database.query('DELETE FROM pi_sessions WHERE id=$1', [sessionId]);
    assert.equal((await database.query('SELECT COUNT(*)::integer AS count FROM pi_message_delivery_receipts')).rows[0]?.count, 0);
    console.log(`chat-message-admission-migration-test: PASS (${fixture.native ? 'native PostgreSQL' : 'PGlite'}; fresh/repeated/legacy/partial/null-shapes/phases/UTF-8/CAS/cascade)`);
  } finally { await fixture.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

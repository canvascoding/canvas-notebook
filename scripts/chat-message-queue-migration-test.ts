import assert from 'node:assert/strict';
import { getTableConfig } from 'drizzle-orm/pg-core';

import { runChatMessageQueueMigration } from '../app/lib/db/chat-message-queue-migration';
import { createTableSql, runPostgresMigrations } from '../app/lib/db/postgres';
import { piMessageDeliveryReceipts, piSessions } from '../app/lib/db/schema';
import { createSharedConnectionTestDatabase } from './helpers/shared-connection-test-database';

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
const queueColumns = ['queue_lane', 'queue_ordinal', 'queue_disposition'];
const columnTypes = ['text', 'bigint', 'text'];
const phases = ['queued', 'dispatching', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown'];
const queueConstraint = 'pi_message_delivery_receipts_queue_shape_check';
const queueIndex = 'idx_pi_message_delivery_receipts_queue_ordinal';

async function constraints(database: Queryable): Promise<Record<string, unknown>[]> {
  return (await database.query(`SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='pi_message_delivery_receipts'::regclass AND contype='c'
    ORDER BY conname`)).rows;
}

async function indexes(database: Queryable): Promise<Record<string, unknown>[]> {
  return (await database.query(`SELECT indexname, indexdef FROM pg_indexes
    WHERE tablename='pi_message_delivery_receipts' ORDER BY indexname`)).rows;
}

async function columns(database: Queryable): Promise<Record<string, unknown>[]> {
  return (await database.query(`SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_name='pi_message_delivery_receipts'
    AND column_name=ANY($1) ORDER BY column_name`, [queueColumns])).rows;
}

async function main(): Promise<void> {
  // Native opt-in is guarded by the existing helper: only its owned nonce DB
  // on the managed loopback PostgreSQL. The default uses real PGlite storage.
  const fixture = await createSharedConnectionTestDatabase();
  const database = fixture.getPostgresRuntimeQueryable() as unknown as Queryable;
  const startup = () => runPostgresMigrations(database as unknown as Parameters<typeof runPostgresMigrations>[0]);
  try {
    const config = getTableConfig(piMessageDeliveryReceipts);
    const freshSql = createTableSql(piMessageDeliveryReceipts);
    for (const check of config.checks) assert(freshSql.includes(`CONSTRAINT "${check.name}"`), check.name);
    assert(config.checks.some(check => check.name === queueConstraint));
    assert(config.indexes.some(index => index.config.name === queueIndex && index.config.unique && index.config.where));
    const freshConstraints = await constraints(database);
    const freshIndexes = await indexes(database);
    assert.equal(freshConstraints.length, config.checks.length);
    assert(freshConstraints.some(row => row.conname === queueConstraint));
    assert.match(String(freshIndexes.find(row => row.indexname === queueIndex)?.indexdef),
      /CREATE UNIQUE INDEX.*\(pi_session_db_id, queue_ordinal\).*WHERE \(queue_ordinal IS NOT NULL\)/u);
    assert.deepEqual(await columns(database), [
      { column_name: 'queue_disposition', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'queue_lane', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'queue_ordinal', data_type: 'bigint', is_nullable: 'YES', column_default: null },
    ]);
    const counterColumn = async () => (await database.query(`SELECT data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_name='pi_sessions' AND column_name='message_queue_ordinal'`)).rows;
    const counterConstraints = async () => (await database.query(`SELECT conname,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='pi_sessions'::regclass AND conname='pi_sessions_message_queue_ordinal_check'`)).rows;
    const freshCounterColumn = await counterColumn();
    const freshCounterConstraints = await counterConstraints();
    assert.equal(freshCounterColumn.length, 1);
    assert.equal(freshCounterColumn[0]?.data_type, 'bigint');
    assert.equal(freshCounterColumn[0]?.is_nullable, 'NO');
    assert.match(String(freshCounterColumn[0]?.column_default), /^'?0'?(?:::bigint)?$/u);
    assert.equal(freshCounterConstraints.length, 1);
    assert(createTableSql(piSessions).includes('CONSTRAINT "pi_sessions_message_queue_ordinal_check"'));

    await database.query(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
      VALUES ('queue-owner','Queue owner','queue-owner@example.test',1,1,1)`);
    const sessions = (await database.query(`INSERT INTO pi_sessions
      (session_id,user_id,agent_id,provider,model,created_at,updated_at) VALUES
      ('queue-first','queue-owner','main','test','test',1,1),
      ('queue-second','queue-owner','main','test','test',1,1) RETURNING id::text AS id,session_id`)).rows;
    const session = sessions.find(row => row.session_id === 'queue-first')?.id;
    const otherSession = sessions.find(row => row.session_id === 'queue-second')?.id;
    assert.equal(typeof session, 'string'); assert.equal(typeof otherSession, 'string');
    let serial = 0;
    const insert = (queue: unknown[], options: { phase?: string; legacy?: boolean; state?: string; session?: unknown } = {}) =>
      database.query(`INSERT INTO pi_message_delivery_receipts
        (pi_session_db_id,client_message_id,payload_hash,runtime_token,state,payload_version,private_payload,
          execution_phase,execution_revision,queue_lane,queue_ordinal,queue_disposition,created_at,updated_at)
        VALUES ($1,$2,'immutable-hash','original-runtime',$3,$4,$5,$6,$7,$8,$9,$10,1,1)
        RETURNING client_message_id`, [options.session ?? session, `receipt-${++serial}`, options.state ?? 'accepted',
        options.legacy ? null : 1, options.legacy ? null : '{not JSON; migration must not parse}',
        options.legacy ? null : options.phase ?? 'queued', options.legacy ? null : 1, ...queue]);
    await insert([null, null, null], { legacy: true, state: 'dispatching' });
    await insert([null, null, null], { legacy: true });
    for (const phase of phases) await insert([null, null, null], { phase });
    const oldRows = (await database.query('SELECT * FROM pi_message_delivery_receipts ORDER BY client_message_id')).rows;
    const assertUnchanged = async () => {
      assert.deepEqual((await database.query('SELECT * FROM pi_message_delivery_receipts ORDER BY client_message_id')).rows, oldRows);
      assert.deepEqual(await constraints(database), freshConstraints);
      assert.deepEqual(await indexes(database), freshIndexes);
    };
    const dropQueueColumns = async () => {
      for (const column of queueColumns) await database.query(`ALTER TABLE pi_message_delivery_receipts DROP COLUMN ${column}`);
    };

    // True old-table upgrade and repeated real startup preserve every legacy
    // and V1 phase, including uncertain/in-flight admissions, without replay.
    await dropQueueColumns();
    await database.query('ALTER TABLE pi_sessions DROP COLUMN message_queue_ordinal');
    await startup(); await startup();
    await assertUnchanged();
    assert.deepEqual(await counterColumn(), freshCounterColumn);
    assert.deepEqual(await counterConstraints(), freshCounterConstraints);
    assert.deepEqual((await database.query(`SELECT message_queue_ordinal FROM pi_sessions ORDER BY session_id`)).rows,
      [{ message_queue_ordinal: 0 }, { message_queue_ordinal: 0 }]);
    await database.query(`ALTER TABLE pi_sessions ALTER COLUMN message_queue_ordinal DROP NOT NULL,
      ALTER COLUMN message_queue_ordinal DROP DEFAULT`);
    await database.query('UPDATE pi_sessions SET message_queue_ordinal=NULL');
    await startup();
    assert.deepEqual(await counterColumn(), freshCounterColumn);
    assert.deepEqual((await database.query('SELECT message_queue_ordinal FROM pi_sessions ORDER BY session_id')).rows,
      [{ message_queue_ordinal: 0 }, { message_queue_ordinal: 0 }]);
    await assertUnchanged();
    for (let mask = 1; mask < 7; mask += 1) {
      await dropQueueColumns();
      for (let index = 0; index < queueColumns.length; index += 1) {
        if (mask & (1 << index)) {
          await database.query(`ALTER TABLE pi_message_delivery_receipts ADD COLUMN ${queueColumns[index]} ${columnTypes[index]}`);
        }
      }
      await runChatMessageQueueMigration(database);
      await runChatMessageQueueMigration(database);
      await assertUnchanged();
    }

    // A corrupt partial deployment fails atomically instead of rewriting a
    // row or silently declaring it recoverable. Added columns roll back too.
    await dropQueueColumns();
    await database.query('ALTER TABLE pi_message_delivery_receipts ADD COLUMN queue_lane text');
    await database.query(`UPDATE pi_message_delivery_receipts SET queue_lane='prompt' WHERE execution_phase='queued'`);
    await assert.rejects(runChatMessageQueueMigration(database), { code: '23514' });
    assert.deepEqual((await columns(database)).map(row => row.column_name), ['queue_lane']);
    assert.equal((await database.query(`SELECT queue_lane FROM pi_message_delivery_receipts WHERE execution_phase='queued'`)).rows[0]?.queue_lane, 'prompt');
    await database.query('UPDATE pi_message_delivery_receipts SET queue_lane=NULL');
    await runChatMessageQueueMigration(database);
    await assertUnchanged();

    const complete = ['prompt', 1, 'ready'];
    for (let mask = 1; mask < 7; mask += 1) {
      await assert.rejects(insert(complete.map((value, index) => mask & (1 << index) ? value : null)), { code: '23514' });
    }
    await assert.rejects(insert(complete, { legacy: true }), { code: '23514' });
    await assert.rejects(insert(complete, { legacy: true, state: 'dispatching' }), { code: '23514' });
    await assert.rejects(insert(complete, { state: 'dispatching' }), { code: '23514' });
    for (const lane of ['', 'message', 'follow-up', 'PROMPT']) {
      await assert.rejects(insert([lane, 1, 'ready']), { code: '23514' });
    }
    for (const disposition of ['', 'queued', 'READY']) {
      await assert.rejects(insert(['prompt', 1, disposition]), { code: '23514' });
    }
    for (const ordinal of ['-1', '0', '9007199254740992']) {
      await assert.rejects(insert(['prompt', ordinal, 'ready']), { code: '23514' });
    }
    let ordinal = 0;
    for (const phase of phases) {
      for (const lane of ['prompt', 'follow_up', 'steer']) {
        for (const disposition of ['ready', 'suspended']) await insert([lane, ++ordinal, disposition], { phase });
      }
    }
    await insert(['steer', '9007199254740991', 'ready']);
    await assert.rejects(insert(['follow_up', 1, 'suspended']), { code: '23505' });
    await insert(['follow_up', 1, 'suspended'], { session: otherSession });

    // Queue controls are independent of immutable intent and execution CAS.
    // SQL permits the writer to update disposition/order with the same CAS;
    // the storage migration does not itself grant execution or alter payload.
    const positioned = (await database.query(`SELECT client_message_id,payload_hash,private_payload,runtime_token,
      execution_phase,execution_revision FROM pi_message_delivery_receipts
      WHERE pi_session_db_id=$1 AND queue_ordinal=1`, [session])).rows[0];
    assert(positioned);
    const changed = (await database.query(`UPDATE pi_message_delivery_receipts SET queue_lane='steer',queue_disposition='suspended',
      execution_revision=execution_revision+1 WHERE pi_session_db_id=$1 AND client_message_id=$2 AND execution_revision=1
      RETURNING execution_revision::text AS revision`, [session, positioned.client_message_id])).rows;
    assert.deepEqual(changed, [{ revision: '2' }]);
    assert.deepEqual((await database.query(`UPDATE pi_message_delivery_receipts SET queue_disposition='ready'
      WHERE pi_session_db_id=$1 AND client_message_id=$2 AND execution_revision=1 RETURNING client_message_id`,
    [session, positioned.client_message_id])).rows, []);
    const after = (await database.query(`SELECT client_message_id,payload_hash,private_payload,runtime_token,
      execution_phase,execution_revision FROM pi_message_delivery_receipts
      WHERE pi_session_db_id=$1 AND client_message_id=$2`, [session, positioned.client_message_id])).rows[0];
    assert.deepEqual(after, { ...positioned, execution_revision: 2 });
    await startup();
    assert.deepEqual(await constraints(database), freshConstraints);
    assert.deepEqual(await indexes(database), freshIndexes);
    assert.equal((await database.query('SELECT message_queue_ordinal::text AS ordinal FROM pi_sessions WHERE id=$1', [session])).rows[0]?.ordinal,
      '9007199254740991');
    assert.equal((await database.query('SELECT message_queue_ordinal::text AS ordinal FROM pi_sessions WHERE id=$1', [otherSession])).rows[0]?.ordinal, '1');
    const beforeCounterRepair = (await database.query('SELECT * FROM pi_message_delivery_receipts ORDER BY client_message_id')).rows;
    await database.query('ALTER TABLE pi_sessions ALTER COLUMN message_queue_ordinal DROP NOT NULL');
    await database.query('UPDATE pi_sessions SET message_queue_ordinal=NULL');
    await runChatMessageQueueMigration(database);
    assert.deepEqual(await counterColumn(), freshCounterColumn);
    assert.equal((await database.query('SELECT message_queue_ordinal::text AS ordinal FROM pi_sessions WHERE id=$1', [session])).rows[0]?.ordinal,
      '9007199254740991');
    assert.equal((await database.query('SELECT message_queue_ordinal::text AS ordinal FROM pi_sessions WHERE id=$1', [otherSession])).rows[0]?.ordinal, '1');
    assert.deepEqual((await database.query('SELECT * FROM pi_message_delivery_receipts ORDER BY client_message_id')).rows, beforeCounterRepair);

    // The session high-water mark survives row deletion. Recovery of a
    // partially installed counter may increase it, but must never lower it.
    await database.query('UPDATE pi_sessions SET message_queue_ordinal=19 WHERE id=$1', [otherSession]);
    await runChatMessageQueueMigration(database);
    assert.equal((await database.query('SELECT message_queue_ordinal::text AS ordinal FROM pi_sessions WHERE id=$1', [otherSession])).rows[0]?.ordinal, '19');
    await database.query('DELETE FROM pi_message_delivery_receipts WHERE pi_session_db_id=$1', [otherSession]);
    await runChatMessageQueueMigration(database);
    const allocated = (await database.query(`UPDATE pi_sessions SET message_queue_ordinal=message_queue_ordinal+1
      WHERE id=$1 AND message_queue_ordinal<9007199254740991 RETURNING message_queue_ordinal::text AS ordinal`, [otherSession])).rows;
    assert.deepEqual(allocated, [{ ordinal: '20' }]);
    assert.deepEqual((await database.query(`UPDATE pi_sessions SET message_queue_ordinal=message_queue_ordinal+1
      WHERE id=$1 AND message_queue_ordinal<9007199254740991 RETURNING message_queue_ordinal`, [session])).rows, []);
    for (const counter of ['-1', '9007199254740992']) {
      await assert.rejects(database.query('UPDATE pi_sessions SET message_queue_ordinal=$1 WHERE id=$2', [counter, otherSession]), { code: '23514' });
    }
    await assert.rejects(database.query('UPDATE pi_sessions SET message_queue_ordinal=NULL WHERE id=$1', [otherSession]), { code: '23502' });
    await database.query('ALTER TABLE pi_sessions DROP CONSTRAINT pi_sessions_message_queue_ordinal_check');
    for (const counter of ['-1', '9007199254740992']) {
      await database.query('UPDATE pi_sessions SET message_queue_ordinal=$1 WHERE id=$2', [counter, otherSession]);
      await assert.rejects(runChatMessageQueueMigration(database), { code: '23514' });
      assert.equal((await database.query('SELECT message_queue_ordinal::text AS ordinal FROM pi_sessions WHERE id=$1', [otherSession])).rows[0]?.ordinal, counter);
    }
    await database.query('UPDATE pi_sessions SET message_queue_ordinal=20 WHERE id=$1', [otherSession]);
    await runChatMessageQueueMigration(database);
    assert.deepEqual(await counterConstraints(), freshCounterConstraints);
    await database.query('DELETE FROM pi_sessions WHERE user_id=$1', ['queue-owner']);
    assert.equal((await database.query('SELECT COUNT(*)::integer AS count FROM pi_message_delivery_receipts')).rows[0]?.count, 0);
    console.log(`chat-message-queue-migration-test: PASS (${fixture.native ? 'native PostgreSQL' : 'PGlite'}; schema/startup/repeat/legacy+V1-unmodified/partial/atomic-failure/null-shapes/lanes+phases/range/session-unique/CAS/monotonic-counter/cascade)`);
  } finally { await fixture.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

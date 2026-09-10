import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresEpochMillisecondsBackfill } from '../app/lib/db/postgres';
import { toDatabaseTimestamp } from '../app/lib/db/timestamps';

type PgQueryable = Parameters<typeof runPostgresEpochMillisecondsBackfill>[0];

const legacySeconds = 1_767_392_800;
const canonicalMilliseconds = legacySeconds * 1_000;
const currentMilliseconds = 1_767_392_800_123;

function numberValue(value: unknown): number {
  return Number(value);
}

async function main(): Promise<void> {
  const exactDate = new Date('2026-01-05T12:34:56.789Z');
  assert.equal(toDatabaseTimestamp(exactDate), exactDate.getTime(), 'raw SQL timestamp writes preserve epoch milliseconds');

  const postgres = new PGlite();
  try {
    await postgres.exec(`
      CREATE TABLE canvas_data_migrations (
        migration_key text PRIMARY KEY,
        completed_at bigint NOT NULL,
        metadata_json text
      );
      CREATE TABLE automation_jobs (
        id text PRIMARY KEY,
        next_run_at bigint,
        created_at bigint,
        updated_at bigint
      );
      CREATE TABLE session (
        id text PRIMARY KEY,
        expires_at bigint NOT NULL,
        created_at bigint,
        updated_at bigint
      );
      CREATE TABLE todo_items (
        id text PRIMARY KEY,
        due_at bigint,
        email_notification_sent_at bigint,
        created_at bigint,
        updated_at bigint
      );
      CREATE TABLE pi_sessions (
        id text PRIMARY KEY,
        created_at bigint,
        updated_at bigint,
        summary_through_timestamp bigint
      );
      CREATE TABLE pi_messages (
        id text PRIMARY KEY,
        timestamp bigint NOT NULL
      );
      CREATE TABLE pi_usage_events (
        id text PRIMARY KEY,
        assistant_timestamp bigint NOT NULL
      );
      CREATE TABLE email_cache_messages (
        id text PRIMARY KEY,
        message_date bigint,
        created_at bigint,
        updated_at bigint
      );
      CREATE TABLE email_inbox_events (
        id text PRIMARY KEY,
        received_at bigint,
        next_attempt_at bigint,
        created_at bigint,
        updated_at bigint
      );
      CREATE TABLE timestamp_exceptions (
        id text PRIMARY KEY,
        auth_time bigint,
        ban_expires bigint,
        dismissed_until bigint,
        lease_until bigint,
        revoked bigint,
        scheduled_for bigint
      );
    `);
    await postgres.exec(`
      INSERT INTO automation_jobs (id, next_run_at, created_at, updated_at)
      VALUES
        ('seconds-schedule', ${legacySeconds}, ${legacySeconds}, ${legacySeconds}),
        ('milliseconds-schedule', ${currentMilliseconds}, ${currentMilliseconds}, ${currentMilliseconds}),
        ('corrupt-schedule', 12000000000, ${legacySeconds}, ${legacySeconds});
      INSERT INTO session (id, expires_at, created_at, updated_at)
      VALUES ('legacy-session', ${legacySeconds}, ${legacySeconds}, ${legacySeconds}), ('canonical-session', ${currentMilliseconds}, ${currentMilliseconds}, ${currentMilliseconds});
      INSERT INTO todo_items (id, due_at, email_notification_sent_at, created_at, updated_at)
      VALUES ('todo-1', ${legacySeconds}, ${legacySeconds}, ${legacySeconds}, ${legacySeconds});
      INSERT INTO pi_sessions (id, created_at, updated_at, summary_through_timestamp)
      VALUES ('pi-session-1', ${legacySeconds}, ${legacySeconds}, ${legacySeconds});
      INSERT INTO pi_messages (id, timestamp) VALUES ('pi-message-1', ${legacySeconds});
      INSERT INTO pi_usage_events (id, assistant_timestamp) VALUES ('usage-1', ${legacySeconds});
      INSERT INTO email_cache_messages (id, message_date, created_at, updated_at)
      VALUES ('email-1', ${legacySeconds}, ${legacySeconds}, ${legacySeconds});
      INSERT INTO email_inbox_events (id, received_at, next_attempt_at, created_at, updated_at)
      VALUES ('inbox-1', ${legacySeconds}, ${legacySeconds}, ${legacySeconds}, ${legacySeconds});
      INSERT INTO timestamp_exceptions (id, auth_time, ban_expires, dismissed_until, lease_until, revoked, scheduled_for)
      VALUES ('exceptions-1', ${legacySeconds}, ${legacySeconds}, ${legacySeconds}, ${legacySeconds}, ${legacySeconds}, ${legacySeconds});
    `);

    const beforeBackfill = Date.now();
    await runPostgresEpochMillisecondsBackfill(postgres as unknown as PgQueryable);
    const afterBackfill = Date.now();

    const schedules = await postgres.query<{ id: string; next_run_at: number }>(
      'SELECT id, next_run_at FROM automation_jobs ORDER BY id',
    );
    const scheduleValues = new Map(schedules.rows.map((row) => [row.id, numberValue(row.next_run_at)]));
    assert.equal(scheduleValues.get('seconds-schedule'), canonicalMilliseconds, 'legacy seconds scale to milliseconds');
    assert.equal(scheduleValues.get('milliseconds-schedule'), currentMilliseconds, 'canonical milliseconds are never rescaled');
    const repairedCursor = scheduleValues.get('corrupt-schedule') ?? 0;
    assert.ok(
      repairedCursor >= beforeBackfill - 1_000 && repairedCursor <= afterBackfill + 1_000,
      'a corrupt legacy scheduler cursor is re-anchored once at migration time',
    );

    const timestampRows = await postgres.query<{
      session_expires_at: number;
      todo_due_at: number;
      todo_email_notification_sent_at: number;
      summary_through_timestamp: number;
      message_timestamp: number;
      assistant_timestamp: number;
      message_date: number;
      received_at: number;
      next_attempt_at: number;
      auth_time: number;
      ban_expires: number;
      dismissed_until: number;
      lease_until: number;
      revoked: number;
      scheduled_for: number;
    }>(`
      SELECT
        (SELECT expires_at FROM session WHERE id = 'legacy-session') AS session_expires_at,
        (SELECT due_at FROM todo_items WHERE id = 'todo-1') AS todo_due_at,
        (SELECT email_notification_sent_at FROM todo_items WHERE id = 'todo-1') AS todo_email_notification_sent_at,
        (SELECT summary_through_timestamp FROM pi_sessions WHERE id = 'pi-session-1') AS summary_through_timestamp,
        (SELECT timestamp FROM pi_messages WHERE id = 'pi-message-1') AS message_timestamp,
        (SELECT assistant_timestamp FROM pi_usage_events WHERE id = 'usage-1') AS assistant_timestamp,
        (SELECT message_date FROM email_cache_messages WHERE id = 'email-1') AS message_date,
        (SELECT received_at FROM email_inbox_events WHERE id = 'inbox-1') AS received_at,
        (SELECT next_attempt_at FROM email_inbox_events WHERE id = 'inbox-1') AS next_attempt_at,
        (SELECT auth_time FROM timestamp_exceptions WHERE id = 'exceptions-1') AS auth_time,
        (SELECT ban_expires FROM timestamp_exceptions WHERE id = 'exceptions-1') AS ban_expires,
        (SELECT dismissed_until FROM timestamp_exceptions WHERE id = 'exceptions-1') AS dismissed_until,
        (SELECT lease_until FROM timestamp_exceptions WHERE id = 'exceptions-1') AS lease_until,
        (SELECT revoked FROM timestamp_exceptions WHERE id = 'exceptions-1') AS revoked,
        (SELECT scheduled_for FROM timestamp_exceptions WHERE id = 'exceptions-1') AS scheduled_for
    `);
    assert.deepEqual(
      Object.values(timestampRows.rows[0] ?? {}).map(numberValue),
      Array(15).fill(canonicalMilliseconds),
      'sessions, todos, email, Pi, scheduler, and exceptional timestamp names are normalized together',
    );

    const beforeSecondRun = await postgres.query<{
      next_run_at: number;
      expires_at: number;
      assistant_timestamp: number;
    }>(`
      SELECT
        (SELECT next_run_at FROM automation_jobs WHERE id = 'corrupt-schedule') AS next_run_at,
        (SELECT expires_at FROM session WHERE id = 'legacy-session') AS expires_at,
        (SELECT assistant_timestamp FROM pi_usage_events WHERE id = 'usage-1') AS assistant_timestamp
    `);
    await runPostgresEpochMillisecondsBackfill(postgres as unknown as PgQueryable);
    const afterSecondRun = await postgres.query<{
      next_run_at: number;
      expires_at: number;
      assistant_timestamp: number;
    }>(`
      SELECT
        (SELECT next_run_at FROM automation_jobs WHERE id = 'corrupt-schedule') AS next_run_at,
        (SELECT expires_at FROM session WHERE id = 'legacy-session') AS expires_at,
        (SELECT assistant_timestamp FROM pi_usage_events WHERE id = 'usage-1') AS assistant_timestamp
    `);
    assert.deepEqual(afterSecondRun.rows, beforeSecondRun.rows, 'the migration marker makes backfill idempotent');
    const migrations = await postgres.query<{ migration_key: string; completed_at: number }>(
      "SELECT migration_key, completed_at FROM canvas_data_migrations WHERE migration_key = 'postgres-epoch-milliseconds-v1'",
    );
    assert.equal(migrations.rows.length, 1, 'the completed migration is recorded exactly once');
    assert.ok(numberValue(migrations.rows[0]?.completed_at) >= beforeBackfill - 1_000);
  } finally {
    await postgres.close();
  }

  console.log('postgres-epoch-milliseconds-backfill-test: ok');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

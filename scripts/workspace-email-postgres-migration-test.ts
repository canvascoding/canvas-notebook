import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

async function main() {
  const postgres = new PGlite();
  try {
    const migrationTarget = postgres as unknown as PgQueryable;
    await runPostgresMigrations(migrationTarget);
    const first = await postgres.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('workspace_email_mailboxes', 'email_inbox_events', 'email_inbox_cases', 'email_drafts')
      ORDER BY table_name, ordinal_position
    `);
    const columns = new Map<string, string[]>();
    for (const row of first.rows) columns.set(row.table_name, [...(columns.get(row.table_name) || []), row.column_name]);
    assert.ok(columns.get('workspace_email_mailboxes')?.includes('email_account_id'));
    assert.ok(columns.get('email_inbox_events')?.includes('idempotency_key'));
    assert.deepEqual(columns.get('email_inbox_cases'), [
      'id', 'workspace_id', 'mailbox_id', 'provider_thread_id', 'latest_provider_message_id',
      'requester_address', 'requester_name', 'subject', 'status', 'priority', 'assignee_user_id',
      'closed_at', 'created_at', 'updated_at',
    ]);
    assert.ok(columns.get('email_drafts')?.includes('outbox_status'));

    const indexes = await postgres.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'email_inbox_cases'
      ORDER BY indexname
    `);
    assert.ok(indexes.rows.some((row) => row.indexname === 'idx_email_inbox_cases_mailbox_thread'));
    assert.ok(indexes.rows.some((row) => row.indexname === 'idx_email_inbox_cases_workspace_status'));

    const snapshot = JSON.stringify({ columns: first.rows, indexes: indexes.rows });
    await runPostgresMigrations(migrationTarget);
    const repeated = await postgres.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('workspace_email_mailboxes', 'email_inbox_events', 'email_inbox_cases', 'email_drafts')
      ORDER BY table_name, ordinal_position
    `);
    const repeatedIndexes = await postgres.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'email_inbox_cases'
      ORDER BY indexname
    `);
    assert.equal(JSON.stringify({ columns: repeated.rows, indexes: repeatedIndexes.rows }), snapshot);
  } finally {
    await postgres.close();
  }
  console.log('workspace-email-postgres-migration-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

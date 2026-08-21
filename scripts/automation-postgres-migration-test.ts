import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

async function automationColumns(postgres: PGlite): Promise<string[]> {
  const result = await postgres.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'automation_jobs'
    ORDER BY ordinal_position
  `);
  return result.rows.map((row) => row.column_name);
}

async function main(): Promise<void> {
  const postgres = new PGlite();
  try {
    const migrationTarget = postgres as unknown as PgQueryable;
    await runPostgresMigrations(migrationTarget);

    // Simulate an installation that predates the lifecycle and integrity fields.
    await postgres.exec(`
      DROP INDEX IF EXISTS idx_automation_jobs_integrity_status;
      ALTER TABLE automation_jobs DROP COLUMN integrity_status;
      ALTER TABLE automation_jobs DROP COLUMN integrity_reason;
      ALTER TABLE automation_jobs DROP COLUMN revision;
      ALTER TABLE automation_jobs DROP COLUMN deleted_at;
      ALTER TABLE automation_jobs DROP COLUMN deleted_by_user_id;
    `);

    await runPostgresMigrations(migrationTarget);
    const columns = await automationColumns(postgres);
    assert.deepEqual(
      ['integrity_status', 'integrity_reason', 'revision', 'deleted_at', 'deleted_by_user_id'].every((column) => columns.includes(column)),
      true,
    );

    const indexes = await postgres.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'automation_jobs'
    `);
    assert.ok(indexes.rows.some((row) => row.indexname === 'idx_automation_jobs_integrity_status'));
  } finally {
    await postgres.close();
  }
  console.log('automation-postgres-migration-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

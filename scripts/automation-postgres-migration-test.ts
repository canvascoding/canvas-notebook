import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import { fromDatabaseTimestamp } from '../app/lib/db/timestamps';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];
const LEGACY_TIMESTAMP_UNIT_ENV = 'CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT';

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

async function assertCanonicalMillisecondsAreNeverGuessed(): Promise<void> {
  const postgres = new PGlite();
  try {
    const migrationTarget = postgres as unknown as PgQueryable;
    await runPostgresMigrations(migrationTarget);

    await postgres.exec(`
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES
        ('epoch-zero', 'Epoch Zero', 'epoch-zero@example.test', 1, 0, 0),
        ('early-milliseconds', 'Early Milliseconds', 'early-milliseconds@example.test', 1, 5000000000, 5000000000);
    `);
    await runPostgresMigrations(migrationTarget);

    const timestamps = await postgres.query<{ id: string; created_at: number; updated_at: number }>(`
      SELECT id, created_at, updated_at
      FROM "user"
      WHERE id IN ('epoch-zero', 'early-milliseconds')
      ORDER BY id
    `);
    assert.deepEqual(timestamps.rows, [
      { id: 'early-milliseconds', created_at: 5000000000, updated_at: 5000000000 },
      { id: 'epoch-zero', created_at: 0, updated_at: 0 },
    ]);
    assert.equal(fromDatabaseTimestamp(5_000_000_000).toISOString(), '1970-02-27T20:53:20.000Z');
  } finally {
    await postgres.close();
  }
}

async function main(): Promise<void> {
  const previousLegacyTimestampUnit = process.env[LEGACY_TIMESTAMP_UNIT_ENV];
  delete process.env[LEGACY_TIMESTAMP_UNIT_ENV];
  try {
    await assertCanonicalMillisecondsAreNeverGuessed();

    const postgres = new PGlite();
    try {
      const migrationTarget = postgres as unknown as PgQueryable;
      await runPostgresMigrations(migrationTarget);

      await postgres.exec(`
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('automation-owner', 'Automation Owner', 'automation-owner@example.test', 1, 1700000000, 1700000000);
      INSERT INTO canvas_organization_settings (organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at)
      VALUES ('automation-org', 'automation-owner', 'team', 1, 1700000000, 1700000000);
      INSERT INTO canvas_workspaces (
        id, organization_id, type, root_relative_path, display_name, workspace_icon, status, is_default, created_at, updated_at
      ) VALUES (
        'automation-workspace', 'automation-org', 'organization', 'workspaces/automation-org/files', 'Automation', 'users-round', 'active', 0, 1700000000, 1700000000
      );
      INSERT INTO automation_jobs (
        id, name, status, scope, job_scope, organization_id, workspace_id, workspace_type,
        owner_user_id, responsible_user_id, prompt, preferred_skill, workspace_context_paths_json,
        schedule_kind, schedule_config_json, time_zone, next_run_at, last_run_at, created_by_user_id, created_at, updated_at
      ) VALUES (
        'legacy-invalid-job', 'Legacy invalid job', 'active', 'personal', 'personal:automation-owner:automation-workspace',
        'automation-org', 'automation-workspace', 'organization', 'automation-owner', 'automation-owner',
        'Run legacy automation', 'canvas-agent', '[]', 'daily', '{"times":["09:00"]}', 'UTC', 1700003600, 1700000000, 'automation-owner', 1700000000, 1700000000
      ), (
        'current-milliseconds-job', 'Current milliseconds job', 'paused', 'personal', 'personal:automation-owner:automation-workspace',
        'automation-org', 'automation-workspace', 'organization', 'automation-owner', 'automation-owner',
        'Keep milliseconds intact', 'canvas-agent', '[]', 'daily', '{"times":["09:00"]}', 'UTC', 1700003600000, 1700000000000, 'automation-owner', 1700000000000, 1700000000000
      );
      INSERT INTO pi_usage_events (
        fingerprint, user_id, agent_id, session_id, provider, model, assistant_timestamp,
        stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        total_tokens, input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, created_at
      ) VALUES (
        'legacy-pi-usage-timestamp', 'automation-owner', 'bradley', 'legacy-session', 'openai', 'gpt-test', 1700000000,
        'stop', 1, 1, 0, 0, 2, 0, 0, 0, 0, 0, 1700000000
      );
    `);

      // Simulate an installation that predates the lifecycle and integrity fields.
      await postgres.exec(`
      DROP INDEX IF EXISTS idx_automation_jobs_integrity_status;
      ALTER TABLE automation_jobs DROP COLUMN integrity_status;
      ALTER TABLE automation_jobs DROP COLUMN integrity_reason;
      ALTER TABLE automation_jobs DROP COLUMN revision;
      ALTER TABLE automation_jobs DROP COLUMN deleted_at;
      ALTER TABLE automation_jobs DROP COLUMN deleted_by_user_id;
    `);

      process.env[LEGACY_TIMESTAMP_UNIT_ENV] = 'seconds';
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

      const legacyJob = await postgres.query<{ integrity_status: string; integrity_reason: string }>(`
      SELECT integrity_status, integrity_reason
      FROM automation_jobs
      WHERE id = 'legacy-invalid-job'
      `);
      assert.deepEqual(legacyJob.rows, [{
      integrity_status: 'quarantined',
      integrity_reason: 'invalid_personal_binding',
      }]);

      const timestamps = await postgres.query<{
      id: string;
      next_run_at: number;
      last_run_at: number;
      created_at: number;
      updated_at: number;
      }>(`
      SELECT id, next_run_at, last_run_at, created_at, updated_at
      FROM automation_jobs
      WHERE id IN ('legacy-invalid-job', 'current-milliseconds-job')
      ORDER BY id
      `);
      assert.deepEqual(timestamps.rows, [
      {
        id: 'current-milliseconds-job',
        next_run_at: 1700003600000,
        last_run_at: 1700000000000,
        created_at: 1700000000000,
        updated_at: 1700000000000,
      },
      {
        id: 'legacy-invalid-job',
        next_run_at: 1700003600000,
        last_run_at: 1700000000000,
        created_at: 1700000000000,
        updated_at: 1700000000000,
      },
      ]);

      // The explicit legacy-source migration is deliberately repeatable: its
      // durable marker prevents a second run from scaling values again.
      await runPostgresMigrations(migrationTarget);
      const repeated = await postgres.query<{ next_run_at: number; created_at: number }>(`
      SELECT next_run_at, created_at
      FROM automation_jobs
      WHERE id = 'legacy-invalid-job'
      `);
      assert.deepEqual(repeated.rows, [{ next_run_at: 1700003600000, created_at: 1700000000000 }]);
      const usageTimestamp = await postgres.query<{ assistant_timestamp: number; created_at: number }>(`
      SELECT assistant_timestamp, created_at
      FROM pi_usage_events
      WHERE fingerprint = 'legacy-pi-usage-timestamp'
      `);
      assert.deepEqual(usageTimestamp.rows, [{ assistant_timestamp: 1700000000000, created_at: 1700000000000 }]);
      const migrationMarkers = await postgres.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM canvas_data_migrations
        WHERE migration_key = 'epoch-seconds-to-milliseconds-v2'
      `);
      assert.equal(migrationMarkers.rows[0]?.count, '1');
    } finally {
      await postgres.close();
    }
  } finally {
    if (previousLegacyTimestampUnit === undefined) delete process.env[LEGACY_TIMESTAMP_UNIT_ENV];
    else process.env[LEGACY_TIMESTAMP_UNIT_ENV] = previousLegacyTimestampUnit;
  }
  console.log('automation-postgres-migration-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

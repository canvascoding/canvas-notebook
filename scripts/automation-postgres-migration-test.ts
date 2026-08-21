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
        schedule_kind, schedule_config_json, time_zone, created_by_user_id, created_at, updated_at
      ) VALUES (
        'legacy-invalid-job', 'Legacy invalid job', 'active', 'personal', 'personal:automation-owner:automation-workspace',
        'automation-org', 'automation-workspace', 'organization', 'automation-owner', 'automation-owner',
        'Run legacy automation', 'canvas-agent', '[]', 'daily', '{"times":["09:00"]}', 'UTC', 'automation-owner', 1700000000, 1700000000
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
  } finally {
    await postgres.close();
  }
  console.log('automation-postgres-migration-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

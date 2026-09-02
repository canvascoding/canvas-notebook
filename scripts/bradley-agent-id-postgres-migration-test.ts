import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

async function main(): Promise<void> {
  const postgres = new PGlite();
  try {
    const migrationTarget = postgres as unknown as PgQueryable;
    await runPostgresMigrations(migrationTarget);
    await postgres.exec(`
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('bradley-pg-user', 'Bradley Migration', 'bradley-pg@example.test', 1, 1700000000, 1700000000);

      UPDATE agents SET agent_id = 'canvas-agent' WHERE agent_id = 'bradley';

      INSERT INTO pi_sessions (
        session_id, user_id, agent_id, provider, model, title, created_at, updated_at
      ) VALUES (
        'legacy-bradley-session', 'bradley-pg-user', 'canvas-agent',
        'test', 'test-model', 'Legacy Bradley session', 1700000000, 1700000000
      );

      INSERT INTO automation_jobs (
        id, name, status, owner_user_id, prompt, preferred_skill,
        workspace_context_paths_json, schedule_kind, schedule_config_json,
        time_zone, created_by_user_id, agent_id, delivery_mode,
        delivery_session_mode, created_at, updated_at
      ) VALUES (
        'legacy-bradley-job', 'Legacy Bradley automation', 'paused', 'bradley-pg-user',
        'Verify the canonical Bradley agent ID.', '', '[]', 'manual', '{}', 'UTC',
        'bradley-pg-user', 'canvas-agent', 'web', 'new_session', 1700000000, 1700000000
      );
    `);

    await runPostgresMigrations(migrationTarget);

    const profiles = await postgres.query<{ agent_id: string; name: string }>(`
      SELECT agent_id, name FROM agents WHERE type = 'main' ORDER BY agent_id
    `);
    assert.deepEqual(profiles.rows, [{ agent_id: 'bradley', name: 'Bradley' }]);

    const sessions = await postgres.query<{ agent_id: string }>(`
      SELECT agent_id FROM pi_sessions WHERE session_id = 'legacy-bradley-session'
    `);
    assert.deepEqual(sessions.rows, [{ agent_id: 'bradley' }]);

    const jobs = await postgres.query<{ agent_id: string }>(`
      SELECT agent_id FROM automation_jobs WHERE id = 'legacy-bradley-job'
    `);
    assert.deepEqual(jobs.rows, [{ agent_id: 'bradley' }]);

    const defaults = await postgres.query<{ column_default: string | null }>(`
      SELECT column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'pi_sessions'
        AND column_name = 'agent_id'
    `);
    assert.match(defaults.rows[0]?.column_default ?? '', /bradley/u);
    assert.doesNotMatch(defaults.rows[0]?.column_default ?? '', /canvas-agent/u);
  } finally {
    await postgres.close();
  }

  console.log('bradley-agent-id-postgres-migration-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

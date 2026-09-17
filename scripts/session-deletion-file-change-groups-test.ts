import assert from 'node:assert/strict';
import Module from 'node:module';

import { createPiTestDatabase } from './helpers/pi-test-database';

async function createTestDatabase() {
  const configured = process.env.CANVAS_TEST_POSTGRES_URL;
  if (!configured) return createPiTestDatabase();

  const parsed = new URL(configured);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  assert.match(databaseName, /^canvas_session_deletion_test_[a-z0-9_]+$/u,
    'PostgreSQL verification requires a dedicated canvas_session_deletion_test_* database');
  const [{ Pool }, { drizzle }, schema, postgresModule] = await Promise.all([
    import('pg'),
    import('drizzle-orm/node-postgres'),
    import('../app/lib/db/schema'),
    import('../app/lib/db/postgres'),
  ]);
  const pool = new Pool({ connectionString: configured, max: 4 });
  await postgresModule.runPostgresMigrations(pool);
  const db = drizzle(pool, { schema });
  return {
    db,
    getDatabaseProvider: () => 'postgres' as const,
    getDatabaseInitializationError: () => null,
    assertDatabaseAvailable: () => {},
    ensureDatabaseReady: async () => {},
    getPostgresRuntimeQueryable: () => pool,
    openDb: async () => ({
      get: async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0],
      all: async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows,
      run: async (sql: string, params: unknown[] = []) => ({ changes: (await pool.query(sql, params)).rowCount ?? 0 }),
      close: async () => {},
    }),
    close: () => pool.end(),
  };
}

async function main(): Promise<void> {
  const database = await createTestDatabase();
  const connection = await database.openDb();
  const modules = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = modules._load;
  const deletedToolOutputSessions: string[] = [];
  modules._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/db' || request.endsWith('/app/lib/db')) return database;
    if (request === '@/app/lib/pi/tool-output-store' || request.endsWith('/pi/tool-output-store')) {
      return {
        deleteToolOutputs: async (identity: { sessionId: string }) => {
          deletedToolOutputSessions.push(identity.sessionId);
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    await connection.run(`
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('session-owner', 'Owner', 'session-owner@example.test', 1, 1, 1)
    `);
    await connection.run(`
      INSERT INTO canvas_organization_settings (
        organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
      ) VALUES ('session-org', 'session-owner', 'team', 1, 1, 1)
    `);
    await connection.run(`
      INSERT INTO canvas_workspaces (
        id, organization_id, type, owner_user_id, root_relative_path,
        display_name, workspace_icon, status, is_default, created_at, updated_at
      ) VALUES (
        'session-workspace', 'session-org', 'personal', 'session-owner', 'workspaces/session-owner',
        'Session workspace', 'user-round', 'active', 1, 1, 1
      )
    `);
    await connection.run(`
      INSERT INTO pi_sessions (
        session_id, user_id, agent_id, provider, model, workspace_id,
        workspace_type, created_at, updated_at
      ) VALUES (
        'session-with-review', 'session-owner', 'main', 'test', 'test',
        'session-workspace', 'personal', 1, 1
      )
    `);
    const session = await connection.get(
      `SELECT id FROM pi_sessions WHERE session_id = $1`,
      ['session-with-review'],
    ) as { id: number };
    await connection.run(`
      INSERT INTO pi_messages (pi_session_db_id, role, content, timestamp, sequence)
      VALUES ($1, 'assistant', 'stored', 1, 1)
    `, [session.id]);
    await connection.run(`
      INSERT INTO file_change_groups (
        group_id, workspace_id, user_id, source_session_id, pi_session_db_id,
        tool_call_id, payload_hash, operation, status, created_at, updated_at
      ) VALUES (
        'session-group', 'session-workspace', 'session-owner', 'session-with-review', $1,
        'tool-call', $2, 'write', 'review_required', 1, 1
      )
    `, [session.id, 'a'.repeat(64)]);
    await connection.run(`
      INSERT INTO file_change_group_entries (
        entry_id, change_group_id, workspace_id, ordinal, path_hint, outcome, created_at
      ) VALUES (
        'session-entry', 'session-group', 'session-workspace', 0,
        'notes.md', 'review_required', 1
      )
    `);
    await connection.run(`
      CREATE TABLE session_deletion_blocker (
        session_id bigint PRIMARY KEY REFERENCES pi_sessions(id) ON DELETE RESTRICT
      )
    `);
    await connection.run(`INSERT INTO session_deletion_blocker (session_id) VALUES ($1)`, [session.id]);

    const { deletePiSessionsByDbIds } = await import('../app/lib/pi/session-deletion');
    await assert.rejects(deletePiSessionsByDbIds([session.id]));
    assert.equal((await connection.get(
      `SELECT COUNT(*)::text AS count FROM pi_messages WHERE pi_session_db_id = $1`,
      [session.id],
    ) as { count: string }).count, '1', 'a failed deletion rolls message removal back');
    assert.equal((await connection.get(
      `SELECT pi_session_db_id FROM file_change_groups WHERE group_id = 'session-group'`,
    ) as { pi_session_db_id: number }).pi_session_db_id, session.id,
    'a failed deletion rolls change-group detachment back');
    assert.deepEqual(deletedToolOutputSessions, [], 'filesystem cleanup waits for database commit');

    await connection.run(`DROP TABLE session_deletion_blocker`);
    assert.deepEqual(await deletePiSessionsByDbIds([session.id]), {
      sessionCount: 1,
      messageCount: 1,
      channelLinkCount: 0,
      activeSessionCount: 0,
    });
    assert.equal((await connection.get(
      `SELECT COUNT(*)::text AS count FROM pi_sessions WHERE id = $1`,
      [session.id],
    ) as { count: string }).count, '0');
    assert.equal((await connection.get(
      `SELECT pi_session_db_id FROM file_change_groups WHERE group_id = 'session-group'`,
    ) as { pi_session_db_id: number | null }).pi_session_db_id, null);
    assert.equal((await connection.get(
      `SELECT COUNT(*)::text AS count FROM file_change_group_entries WHERE change_group_id = 'session-group'`,
    ) as { count: string }).count, '1', 'durable review evidence survives chat deletion');
    assert.deepEqual(deletedToolOutputSessions, ['session-with-review']);
    assert.equal((await deletePiSessionsByDbIds([session.id])).sessionCount, 0, 'retry is idempotent');
    assert.deepEqual(deletedToolOutputSessions, ['session-with-review']);
    console.log('session-deletion-file-change-groups-test: ok');
  } finally {
    modules._load = originalLoad;
    await connection.close();
    await database.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

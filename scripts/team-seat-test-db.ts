import { PGlite } from '@electric-sql/pglite';
import type { SqlConnection } from '../app/lib/db';
import { runPostgresMigrations } from '../app/lib/db/postgres';

export function teamSeatTestConnection(postgres: PGlite): SqlConnection {
  const normalize = (sql: string) => {
    let index = 0;
    return sql.replaceAll('?', () => `$${++index}`);
  };
  return {
    get: async (sql, params = []) => (await postgres.query(normalize(sql), params)).rows[0],
    run: async (sql, params = []) => {
      const result = await postgres.query(normalize(sql), params);
      return { changes: result.affectedRows ?? 0 };
    },
    all: async (sql, params = []) => (await postgres.query(normalize(sql), params)).rows,
    close: () => undefined,
  };
}

export async function withTeamSeatTestDatabase<T>(run: (database: SqlConnection) => Promise<T>): Promise<T> {
  const postgres = new PGlite();
  try {
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    return await run(teamSeatTestConnection(postgres));
  } finally {
    await postgres.close();
  }
}

export async function seedTeamSeatOrganization(database: SqlConnection, organizationId: string, now: number): Promise<void> {
  const ownerId = `owner-${organizationId}`;
  await database.run(`
    INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
    VALUES ($1, 'Test Owner', $2, 1, 'admin', $3, $3)
  `, [ownerId, `${organizationId}@example.test`, now]);
  await database.run(`
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ($1, $2, 'team', 1, $3, $3)
  `, [organizationId, ownerId, now]);
}

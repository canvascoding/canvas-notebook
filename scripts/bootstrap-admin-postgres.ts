import { createRequire } from 'node:module';

import { hashPassword } from 'better-auth/crypto';
import type { PoolClient } from 'pg';

import {
  createPostgresPool,
  runPostgresMigrations,
} from '../app/lib/db/postgres';
import {
  ensurePostgresCredentialPassword,
  ensurePostgresOrganizationBootstrapForUser,
  findPostgresBootstrapTargetUser,
  findPostgresUserByEmail,
  insertPostgresAuthUser,
  type PostgresRuntimeDb,
  updatePostgresAuthUser,
} from '../app/lib/workspaces/postgres-runtime';

const require = createRequire(import.meta.url);
const { loadAppEnv } = require('../server/load-app-env.js') as {
  loadAppEnv: (cwd?: string) => string | null;
};

loadAppEnv(process.cwd());

function normalizeEmail(email: string | undefined): string | null {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return normalized || null;
}

function getBootstrapAdminConfig() {
  const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = (process.env.BOOTSTRAP_ADMIN_NAME || 'Administrator').trim() || 'Administrator';
  if (!email || !password) return null;
  return { email, password, name };
}

function translateSqlitePlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function createPostgresRuntimeDb(client: PoolClient): PostgresRuntimeDb {
  const query = (sql: string, params?: unknown[]) => client.query(translateSqlitePlaceholders(sql), params);

  return {
    get: async (sql: string, params?: unknown[]) => {
      const result = await query(sql, params);
      return result.rows[0];
    },
    run: async (sql: string, params?: unknown[]) => {
      const result = await query(sql, params);
      return { changes: result.rowCount ?? 0 };
    },
    all: async (sql: string, params?: unknown[]) => {
      const result = await query(sql, params);
      return result.rows;
    },
  };
}

async function main() {
  const bootstrapAdmin = getBootstrapAdminConfig();
  if (!bootstrapAdmin) {
    console.log('[bootstrap-admin] Skipped (BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD not set).');
    return;
  }

  const pool = createPostgresPool();
  await runPostgresMigrations(pool);
  const client = await pool.connect();
  const database = createPostgresRuntimeDb(client);
  console.log('[bootstrap-admin] Using Postgres database.');

  try {
    const { email, password, name } = bootstrapAdmin;
    const passwordHash = await hashPassword(password);
    await database.run('BEGIN');

    const existingUser = await findPostgresUserByEmail(database, email);
    if (existingUser) {
      await updatePostgresAuthUser(database, { userId: existingUser.id, email, name });
      await ensurePostgresCredentialPassword(database, { userId: existingUser.id, passwordHash });
      await ensurePostgresOrganizationBootstrapForUser(database, existingUser.id);
      await database.run('COMMIT');
      console.log(`[bootstrap-admin] Synced bootstrap admin user: ${email}`);
      return;
    }

    const targetUser = await findPostgresBootstrapTargetUser(database);
    if (targetUser) {
      await updatePostgresAuthUser(database, { userId: targetUser.id, email, name });
      await ensurePostgresCredentialPassword(database, { userId: targetUser.id, passwordHash });
      await ensurePostgresOrganizationBootstrapForUser(database, targetUser.id);
      await database.run('COMMIT');
      console.log(`[bootstrap-admin] Updated existing admin credentials: ${targetUser.email} -> ${email}`);
      return;
    }

    const userId = await insertPostgresAuthUser(database, { email, name });
    await ensurePostgresCredentialPassword(database, { userId, passwordHash });
    await ensurePostgresOrganizationBootstrapForUser(database, userId);
    await database.run('COMMIT');
    console.log(`[bootstrap-admin] Created admin user: ${email}`);
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Ignore rollback errors; the original error is more useful.
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[bootstrap-admin] Failed:', error);
  process.exit(1);
});

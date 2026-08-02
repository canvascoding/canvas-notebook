import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';
import Database from 'better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import { runMigrations } from '../app/lib/db/migrate';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import { oauthClient } from '../app/lib/db/schema';

const OAUTH_TABLES = [
  'jwks',
  'oauth_access_token',
  'oauth_client',
  'oauth_consent',
  'oauth_refresh_token',
] as const;

const REQUIRED_COLUMNS: Record<(typeof OAUTH_TABLES)[number], string[]> = {
  jwks: ['id', 'public_key', 'private_key', 'created_at', 'expires_at'],
  oauth_client: [
    'id',
    'client_id',
    'client_secret',
    'disabled',
    'skip_consent',
    'enable_end_session',
    'subject_type',
    'scopes',
    'user_id',
    'created_at',
    'updated_at',
    'name',
    'uri',
    'icon',
    'contacts',
    'tos',
    'policy',
    'software_id',
    'software_version',
    'software_statement',
    'redirect_uris',
    'post_logout_redirect_uris',
    'token_endpoint_auth_method',
    'grant_types',
    'response_types',
    'public',
    'type',
    'require_pkce',
    'reference_id',
    'metadata',
  ],
  oauth_refresh_token: [
    'id',
    'token',
    'client_id',
    'session_id',
    'user_id',
    'reference_id',
    'expires_at',
    'created_at',
    'revoked',
    'auth_time',
    'scopes',
  ],
  oauth_access_token: [
    'id',
    'token',
    'client_id',
    'session_id',
    'user_id',
    'reference_id',
    'refresh_id',
    'expires_at',
    'created_at',
    'scopes',
  ],
  oauth_consent: [
    'id',
    'client_id',
    'user_id',
    'reference_id',
    'scopes',
    'created_at',
    'updated_at',
  ],
};

function sqliteSchemaSnapshot(sqlite: Database.Database): string {
  const rows = sqlite.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master
    WHERE tbl_name IN (${OAUTH_TABLES.map(() => '?').join(', ')})
    ORDER BY type, name
  `).all(...OAUTH_TABLES);
  return JSON.stringify(rows);
}

function assertSqliteSchema(sqlite: Database.Database): void {
  for (const table of OAUTH_TABLES) {
    const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    assert.deepEqual(
      columns.map((column) => column.name),
      REQUIRED_COLUMNS[table],
      `Unexpected SQLite columns for ${table}`,
    );
  }

  const clientIndexes = sqlite.prepare('PRAGMA index_list("oauth_client")').all() as Array<{
    name: string;
    unique: number;
  }>;
  assert.equal(clientIndexes.some((index) => index.name === 'idx_oauth_client_user'), true);
  assert.equal(clientIndexes.some((index) => index.unique === 1), true);

  const accessForeignKeys = sqlite.prepare('PRAGMA foreign_key_list("oauth_access_token")').all() as Array<{
    table: string;
    from: string;
    on_delete: string;
  }>;
  assert.equal(
    accessForeignKeys.some((key) => (
      key.table === 'oauth_refresh_token'
      && key.from === 'refresh_id'
      && key.on_delete === 'CASCADE'
    )),
    true,
  );
  assert.equal(
    accessForeignKeys.some((key) => (
      key.table === 'session'
      && key.from === 'session_id'
      && key.on_delete === 'SET NULL'
    )),
    true,
  );
}

function seedSqliteAuthData(sqlite: Database.Database): void {
  sqlite.prepare(`
    INSERT INTO user (
      id, name, email, email_verified, role, banned, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'oauth-schema-user',
    'OAuth Schema User',
    'oauth-schema@example.test',
    1,
    'user',
    0,
    1_700_000_000,
    1_700_000_000,
  );
  sqlite.prepare(`
    INSERT INTO session (
      id, expires_at, token, created_at, updated_at, user_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'oauth-schema-session',
    1_800_000_000,
    'existing-session-token',
    1_700_000_000,
    1_700_000_000,
    'oauth-schema-user',
  );
  sqlite.prepare(`
    INSERT INTO account (
      id, account_id, provider_id, user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'oauth-schema-account',
    'oauth-schema-user',
    'credential',
    'oauth-schema-user',
    1_700_000_000,
    1_700_000_000,
  );
}

function assertSqliteFreshIdempotentAndUpgrade(): void {
  const oauthClientConfig = getTableConfig(oauthClient);
  for (const columnName of [
    'scopes',
    'contacts',
    'redirect_uris',
    'post_logout_redirect_uris',
    'grant_types',
    'response_types',
    'metadata',
  ]) {
    const column = oauthClientConfig.columns.find(
      (candidate) => candidate.name === columnName,
    );
    assert.equal(
      column?.columnType,
      'SQLiteText',
      `${columnName} must remain plain text because Better Auth owns serialization.`,
    );
  }

  const sqlite = new Database(':memory:');
  try {
    runMigrations(sqlite);
    assertSqliteSchema(sqlite);
    const firstSnapshot = sqliteSchemaSnapshot(sqlite);

    runMigrations(sqlite);
    assert.equal(sqliteSchemaSnapshot(sqlite), firstSnapshot);

    seedSqliteAuthData(sqlite);
    sqlite.exec(`
      DROP TABLE oauth_access_token;
      DROP TABLE oauth_consent;
      DROP TABLE oauth_refresh_token;
      DROP TABLE oauth_client;
      DROP TABLE jwks;
    `);

    runMigrations(sqlite);
    assertSqliteSchema(sqlite);
    assert.deepEqual(
      sqlite.prepare(`
        SELECT user.id AS userId, session.id AS sessionId, account.id AS accountId
        FROM user
        INNER JOIN session ON session.user_id = user.id
        INNER JOIN account ON account.user_id = user.id
        WHERE user.id = ?
      `).get('oauth-schema-user'),
      {
        userId: 'oauth-schema-user',
        sessionId: 'oauth-schema-session',
        accountId: 'oauth-schema-account',
      },
    );
  } finally {
    sqlite.close();
  }
}

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

async function postgresOAuthSchemaSnapshot(postgres: PGlite): Promise<string> {
  const columns = await postgres.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (${OAUTH_TABLES.map((table) => `'${table}'`).join(', ')})
    ORDER BY table_name, ordinal_position
  `);
  const indexes = await postgres.query<{
    tablename: string;
    indexname: string;
    indexdef: string;
  }>(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN (${OAUTH_TABLES.map((table) => `'${table}'`).join(', ')})
    ORDER BY tablename, indexname
  `);
  const constraints = await postgres.query<{
    table_name: string;
    constraint_name: string;
    constraint_type: string;
  }>(`
    SELECT table_name, constraint_name, constraint_type
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name IN (${OAUTH_TABLES.map((table) => `'${table}'`).join(', ')})
    ORDER BY table_name, constraint_name
  `);
  return JSON.stringify({
    columns: columns.rows,
    indexes: indexes.rows,
    constraints: constraints.rows,
  });
}

async function assertPostgresSchema(postgres: PGlite): Promise<void> {
  for (const table of OAUTH_TABLES) {
    const result = await postgres.query<{ column_name: string }>(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `,
      [table],
    );
    assert.deepEqual(
      result.rows.map((column) => column.column_name),
      REQUIRED_COLUMNS[table],
      `Unexpected PostgreSQL columns for ${table}`,
    );
  }

  const foreignKeys = await postgres.query<{
    table_name: string;
    column_name: string;
    foreign_table_name: string;
    delete_rule: string;
  }>(`
    SELECT
      tc.table_name,
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    INNER JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.constraint_schema = kcu.constraint_schema
    INNER JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.constraint_schema = ccu.constraint_schema
    INNER JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name
     AND tc.constraint_schema = rc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = 'oauth_access_token'
  `);
  assert.equal(
    foreignKeys.rows.some((key) => (
      key.column_name === 'refresh_id'
      && key.foreign_table_name === 'oauth_refresh_token'
      && key.delete_rule === 'CASCADE'
    )),
    true,
  );
  assert.equal(
    foreignKeys.rows.some((key) => (
      key.column_name === 'session_id'
      && key.foreign_table_name === 'session'
      && key.delete_rule === 'SET NULL'
    )),
    true,
  );
}

async function seedPostgresAuthData(postgres: PGlite): Promise<void> {
  await postgres.query(`
    INSERT INTO "user" (
      id, name, email, email_verified, role, banned, created_at, updated_at
    ) VALUES (
      'oauth-schema-user',
      'OAuth Schema User',
      'oauth-schema@example.test',
      1,
      'user',
      0,
      1700000000,
      1700000000
    )
  `);
  await postgres.query(`
    INSERT INTO session (
      id, expires_at, token, created_at, updated_at, user_id
    ) VALUES (
      'oauth-schema-session',
      1800000000,
      'existing-session-token',
      1700000000,
      1700000000,
      'oauth-schema-user'
    )
  `);
  await postgres.query(`
    INSERT INTO account (
      id, account_id, provider_id, user_id, created_at, updated_at
    ) VALUES (
      'oauth-schema-account',
      'oauth-schema-user',
      'credential',
      'oauth-schema-user',
      1700000000,
      1700000000
    )
  `);
}

async function assertPostgresFreshIdempotentAndUpgrade(): Promise<void> {
  const postgres = new PGlite();
  try {
    const migrationTarget = postgres as unknown as PgQueryable;
    await runPostgresMigrations(migrationTarget);
    await assertPostgresSchema(postgres);
    const firstSnapshot = await postgresOAuthSchemaSnapshot(postgres);

    await runPostgresMigrations(migrationTarget);
    assert.equal(await postgresOAuthSchemaSnapshot(postgres), firstSnapshot);

    await seedPostgresAuthData(postgres);
    await postgres.exec(`
      DROP TABLE oauth_access_token CASCADE;
      DROP TABLE oauth_consent CASCADE;
      DROP TABLE oauth_refresh_token CASCADE;
      DROP TABLE oauth_client CASCADE;
      DROP TABLE jwks CASCADE;
    `);

    await runPostgresMigrations(migrationTarget);
    await assertPostgresSchema(postgres);
    const preservedAuth = await postgres.query<{
      user_id: string;
      session_id: string;
      account_id: string;
    }>(`
      SELECT
        "user".id AS user_id,
        session.id AS session_id,
        account.id AS account_id
      FROM "user"
      INNER JOIN session ON session.user_id = "user".id
      INNER JOIN account ON account.user_id = "user".id
      WHERE "user".id = 'oauth-schema-user'
    `);
    assert.deepEqual(preservedAuth.rows, [{
      user_id: 'oauth-schema-user',
      session_id: 'oauth-schema-session',
      account_id: 'oauth-schema-account',
    }]);
  } finally {
    await postgres.close();
  }
}

async function main(): Promise<void> {
  assertSqliteFreshIdempotentAndUpgrade();
  await assertPostgresFreshIdempotentAndUpgrade();
  console.log('mcp-server-oauth-schema-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { createTableSql, getPostgresSchemaTables } from '../app/lib/db/postgres';

async function main() {
  const table = getPostgresSchemaTables().find((entry) => {
    const sql = createTableSql(entry);
    return sql.includes('managed_team_pending_identities');
  });
  assert.ok(table, 'pending identity table must be included in startup migrations');
  const pg = new PGlite();
  try {
    await pg.exec(createTableSql(table));
    await pg.exec(createTableSql(table));
    await pg.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_team_pending_user ON managed_team_pending_identities (pending_user_id)');
    await pg.query(`
      INSERT INTO managed_team_pending_identities
        (local_identity_key, organization_id, pending_user_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $4)
      ON CONFLICT (local_identity_key) DO NOTHING
    `, ['membership-1', 'organization-1', 'user-1', Date.now()]);
    await pg.query(`
      INSERT INTO managed_team_pending_identities
        (local_identity_key, organization_id, pending_user_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $4)
      ON CONFLICT (local_identity_key) DO NOTHING
    `, ['membership-1', 'organization-1', 'user-2', Date.now()]);
    const binding = await pg.query<{ pending_user_id: string }>(
      `SELECT pending_user_id FROM managed_team_pending_identities WHERE local_identity_key = $1`,
      ['membership-1'],
    );
    assert.equal(binding.rows[0].pending_user_id, 'user-1');
    await assert.rejects(pg.query(`
      INSERT INTO managed_team_pending_identities
        (local_identity_key, organization_id, pending_user_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $4)
    `, ['membership-2', 'organization-1', 'user-1', Date.now()]));
    console.info('managed pending identity startup migration and idempotent binding passed');
  } finally {
    await pg.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

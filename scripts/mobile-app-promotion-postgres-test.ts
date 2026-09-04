import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

async function main() {
  const postgres = new PGlite();
  try {
    await runPostgresMigrations(postgres as unknown as PgQueryable);

    const columns = await postgres.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mobile_app_promotion_states'
      ORDER BY ordinal_position
    `);
    assert.deepEqual(columns.rows.map((row) => row.column_name), [
      'user_id',
      'promotion_version',
      'impression_count',
      'dismissal_count',
      'last_shown_at',
      'dismissed_until',
      'permanently_dismissed_at',
      'cta_clicked_at',
      'last_action',
      'created_at',
      'updated_at',
    ]);

    const indexes = await postgres.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'mobile_app_promotion_states'
    `);
    assert.ok(indexes.rows.some((row) => row.indexname === 'idx_mobile_app_promotion_dismissed_until'));
  } finally {
    await postgres.close();
  }

  console.log('mobile-app-promotion-postgres-test: ok');
}

void main();

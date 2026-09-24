import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';

import { runPostgresMigrations } from '../app/lib/db/postgres';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

async function main() {
  const postgres = new PGlite();
  const originalPool = { query: Pool.prototype.query, connect: Pool.prototype.connect };
  const previousProvider = process.env.CANVAS_DATABASE_PROVIDER;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  process.env.DATABASE_URL = 'postgresql://promotion-test.invalid/canvas';
  const query = async (input: string | { text: string; rowMode?: string }, values?: unknown[]) => {
    const result = await postgres.query<Record<string, unknown>>(typeof input === 'string' ? input : input.text, values);
    return {
      ...result,
      rowCount: result.affectedRows ?? result.rows.length,
      rows: typeof input !== 'string' && input.rowMode === 'array'
        ? result.rows.map((row) => result.fields.map((field) => row[field.name]))
        : result.rows,
    };
  };
  Object.defineProperty(Pool.prototype, 'query', { configurable: true, writable: true, value: query });
  Object.defineProperty(Pool.prototype, 'connect', {
    configurable: true,
    writable: true,
    value: async () => ({ query, release() {} }),
  });
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

    const { db } = await import('../app/lib/db');
    const { mobileAppPromotionStates, user } = await import('../app/lib/db/schema');
    const { MOBILE_APP_PROMOTION_REPEAT_DELAY_MS } = await import('../app/lib/mobile/promotion-contract');
    const { recordMobileAppPromotionAction } = await import('../app/lib/mobile/promotion-state');
    const now = new Date('2026-09-24T12:00:00.123Z');
    const accountCreatedAt = new Date('2026-08-01T12:00:00.000Z');

    for (const userId of ['repeat-shown', 'dismissed', 'opted-out', 'cta-clicked']) {
      await db.insert(user).values({
        id: userId,
        name: userId,
        email: `${userId}@example.test`,
        emailVerified: true,
        createdAt: accountCreatedAt,
        updatedAt: accountCreatedAt,
      });
      await recordMobileAppPromotionAction({ userId, action: { action: 'shown' }, now, rolloutEnabled: true });
    }

    const later = new Date(now.getTime() + MOBILE_APP_PROMOTION_REPEAT_DELAY_MS + 123);
    const repeated = await recordMobileAppPromotionAction({
      userId: 'repeat-shown', action: { action: 'shown' }, now: later, rolloutEnabled: true,
    });
    assert.equal(repeated.recorded, true);
    const [shownRow] = await db.select().from(mobileAppPromotionStates)
      .where(eq(mobileAppPromotionStates.userId, 'repeat-shown'));
    assert.equal(shownRow?.updatedAt.getTime(), later.getTime(), 'repeated impressions update the audit timestamp');

    await recordMobileAppPromotionAction({
      userId: 'dismissed', action: { action: 'dismissed', source: 'dialog' }, now, rolloutEnabled: true,
    });
    const [dismissedRow] = await db.select().from(mobileAppPromotionStates)
      .where(eq(mobileAppPromotionStates.userId, 'dismissed'));
    assert.equal(dismissedRow?.dismissedUntil?.getTime(), now.getTime() + MOBILE_APP_PROMOTION_REPEAT_DELAY_MS);

    await recordMobileAppPromotionAction({
      userId: 'opted-out', action: { action: 'permanently_dismissed' }, now, rolloutEnabled: true,
    });
    const [optedOutRow] = await db.select().from(mobileAppPromotionStates)
      .where(eq(mobileAppPromotionStates.userId, 'opted-out'));
    assert.equal(optedOutRow?.permanentlyDismissedAt?.getTime(), now.getTime());

    await recordMobileAppPromotionAction({
      userId: 'cta-clicked', action: { action: 'cta_clicked', kind: 'copy-link' }, now, rolloutEnabled: true,
    });
    const [clickedRow] = await db.select().from(mobileAppPromotionStates)
      .where(eq(mobileAppPromotionStates.userId, 'cta-clicked'));
    assert.equal(clickedRow?.ctaClickedAt?.getTime(), now.getTime());
  } finally {
    Object.assign(Pool.prototype, originalPool);
    if (previousProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = previousProvider;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await postgres.close();
  }

  console.log('mobile-app-promotion-postgres-test: ok');
}

void main();

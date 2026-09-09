import type { SqlConnection } from '@/app/lib/db';

export type PublicRateLimitBucket = { key: string; limit: number; windowMs: number };
export type PublicRateLimitDecision = { ok: true } | { ok: false; retryAfter: number };

/** Atomic PostgreSQL counters shared by every app process. */
export function createPublicRateLimitStore(
  connect: () => Promise<SqlConnection>,
) {
  let schemaReady = false;
  let lastCleanupAt = 0;

  return async (buckets: PublicRateLimitBucket[], now = Date.now()): Promise<PublicRateLimitDecision> => {
    const database = await connect();
    try {
      if (!schemaReady) {
        await database.run('BEGIN');
        try {
          await database.get("SELECT pg_advisory_xact_lock(hashtext('canvas-public-rate-limit-schema'))");
          await database.run(`CREATE TABLE IF NOT EXISTS security_public_rate_limits (
            bucket_key TEXT PRIMARY KEY,
            count BIGINT NOT NULL,
            reset_at BIGINT NOT NULL
          )`);
          await database.run('CREATE INDEX IF NOT EXISTS idx_security_public_rate_limits_expiry ON security_public_rate_limits (reset_at)');
          await database.run('COMMIT');
          schemaReady = true;
        } catch (error) {
          try { await database.run('ROLLBACK'); } catch { /* Preserve the original error. */ }
          throw error;
        }
      }

      if (now - lastCleanupAt >= 60_000) {
        await database.run('DELETE FROM security_public_rate_limits WHERE reset_at <= $1', [now]);
        lastCleanupAt = now;
      }

      // A rejected client still consumes the larger global abuse budget. It
      // cannot generate unbounded per-token rows by rotating invalid tokens.
      for (const bucket of buckets) {
        const row = await database.get(`
          INSERT INTO security_public_rate_limits (bucket_key, count, reset_at)
          VALUES ($1, 1, $2)
          ON CONFLICT (bucket_key) DO UPDATE SET
            count = CASE WHEN security_public_rate_limits.reset_at <= $3 THEN 1 ELSE security_public_rate_limits.count + 1 END,
            reset_at = CASE WHEN security_public_rate_limits.reset_at <= $4 THEN excluded.reset_at ELSE security_public_rate_limits.reset_at END
          WHERE security_public_rate_limits.reset_at <= $5 OR security_public_rate_limits.count < $6
          RETURNING reset_at
        `, [bucket.key, now + bucket.windowMs, now, now, now, bucket.limit]);
        if (!row) {
          const existing = await database.get('SELECT reset_at FROM security_public_rate_limits WHERE bucket_key = $1', [bucket.key]) as { reset_at: number | string } | undefined;
          return { ok: false, retryAfter: Math.max(1, Math.ceil((Number(existing?.reset_at ?? now + bucket.windowMs) - now) / 1000)) };
        }
      }
      return { ok: true };
    } finally {
      await database.close();
    }
  };
}

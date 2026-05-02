type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type RateLimitConfig = {
  limit: number;
  windowMs: number;
};

const DEFAULT_CONFIGS: Record<string, RateLimitConfig> = {
  send_message: { limit: 20, windowMs: 60_000 },
  control: { limit: 30, windowMs: 60_000 },
  get_status: { limit: 120, windowMs: 60_000 },
  subscribe_session: { limit: 30, windowMs: 60_000 },
};

const buckets = new Map<string, RateLimitBucket>();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
}, 60_000);

export function checkWsRateLimit(
  messageType: string,
  userId: string,
  config?: RateLimitConfig
): { ok: true } | { ok: false; retryAfterMs: number } {
  const cfg = config ?? DEFAULT_CONFIGS[messageType] ?? { limit: 60, windowMs: 60_000 };
  const key = `${messageType}:${userId}`;
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now > existing.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + cfg.windowMs });
    return { ok: true };
  }

  if (existing.count >= cfg.limit) {
    const retryAfterMs = existing.resetAt - now;
    return { ok: false, retryAfterMs };
  }

  existing.count += 1;
  return { ok: true };
}
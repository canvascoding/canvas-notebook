import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getRequestRateLimitIdentity } from './request-identity';
import { createPublicRateLimitStore, type PublicRateLimitBucket } from './public-rate-limit-store';

const consume = createPublicRateLimitStore(
  async () => (await import('@/app/lib/db')).openDb(),
);

export type PublicRateLimitOptions = {
  keyPrefix: string;
  limit: number;
  windowMs: number;
  globalLimit: number;
};

function hashIdentity(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

async function checkBuckets(buckets: PublicRateLimitBucket[]) {
  try {
    const decision = await consume(buckets);
    if (decision.ok) return { ok: true } as const;
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'Too many requests' }, {
        status: 429,
        headers: { 'Retry-After': String(decision.retryAfter), 'Cache-Control': 'no-store' },
      }),
    } as const;
  } catch {
    // Never silently disable public abuse protection when the shared store fails.
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'Service temporarily unavailable' }, {
        status: 503, headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' },
      }),
    } as const;
  }
}

/** Anonymous budgets deliberately ignore even a valid signed-in session. */
export function publicRateLimit(options: PublicRateLimitOptions) {
  const client = getRequestRateLimitIdentity()?.clientAddress ?? 'unknown';
  return checkBuckets([
    { key: `${options.keyPrefix}:global`, limit: options.globalLimit, windowMs: options.windowMs },
    { key: `${options.keyPrefix}:client:${hashIdentity(client)}`, limit: options.limit, windowMs: options.windowMs },
  ]);
}

/** Apply after client/global admission, with a stable operation prefix. */
export function publicResourceRateLimit(options: Omit<PublicRateLimitOptions, 'globalLimit'>, resource: string) {
  return checkBuckets([
    { key: `${options.keyPrefix}:resource:${hashIdentity(resource)}`, limit: options.limit, windowMs: options.windowMs },
  ]);
}

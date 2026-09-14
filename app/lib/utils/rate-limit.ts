import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getRequestRateLimitIdentity } from '@/app/lib/security/request-identity';

interface RateLimitOptions {
  limit: number;
  windowMs: number;
  keyPrefix: string;
  /** Only pass an ID obtained from an already verified server-side session. */
  verifiedUserId?: string;
}

interface DualRateLimitOptions {
  perUserLimit: number;
  perIpLimit: number;
  windowMs: number;
  keyPrefix: string;
  /** Must be obtained from an already verified server-side session. */
  verifiedUserId: string;
}

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const MAX_BUCKETS = 20_000;
const buckets = new Map<string, RateLimitBucket>();

const globalRateLimitStore = globalThis as typeof globalThis & { __canvasRateLimitCleanupStarted?: boolean };

if (!globalRateLimitStore.__canvasRateLimitCleanupStarted) {
  globalRateLimitStore.__canvasRateLimitCleanupStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now > bucket.resetAt) buckets.delete(key);
    }
  }, 60_000).unref?.();
}

function getClientId(_request: NextRequest, verifiedUserId?: string) {
  const identity = getRequestRateLimitIdentity();
  const userId = verifiedUserId || identity?.verifiedUserId;
  const key = userId ? `user:${userId}` : `client:${identity?.clientAddress ?? 'unknown'}`;
  return createHash('sha256').update(key).digest('base64url');
}

function rateLimitBucket(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now > existing.resetAt) {
    if (!existing && buckets.size >= MAX_BUCKETS) {
      for (const [bucketKey, bucket] of buckets) {
        if (now > bucket.resetAt) buckets.delete(bucketKey);
      }
      if (buckets.size >= MAX_BUCKETS) {
        return {
          ok: false,
          response: NextResponse.json({ success: false, error: 'Too many requests' }, {
            status: 429, headers: { 'Retry-After': '60' },
          }),
        } as const;
      }
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true } as const;
  }

  if (existing.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': retryAfter.toString() } },
      ),
    } as const;
  }

  existing.count += 1;
  buckets.set(key, existing);
  return { ok: true } as const;
}

export function rateLimit(request: NextRequest, options: RateLimitOptions) {
  const clientId = getClientId(request, options.verifiedUserId);
  const key = `${options.keyPrefix}:${clientId}`;
  return rateLimitBucket(key, options.limit, options.windowMs);
}

/**
 * Applies independent authenticated-user and transport-IP budgets. The
 * established rateLimit() auto-selection contract remains unchanged for
 * callers that need one identity dimension only.
 */
export function dualRateLimit(request: NextRequest, options: DualRateLimitOptions) {
  const identity = getRequestRateLimitIdentity();
  const ipIdentity = createHash('sha256')
    .update(`client:${identity?.clientAddress ?? 'unknown'}`)
    .digest('base64url');
  const userIdentity = createHash('sha256')
    .update(`user:${options.verifiedUserId}`)
    .digest('base64url');
  const ipResult = rateLimitBucket(
    `${options.keyPrefix}:ip:${ipIdentity}`,
    options.perIpLimit,
    options.windowMs,
  );
  if (!ipResult.ok) return ipResult;
  return rateLimitBucket(
    `${options.keyPrefix}:user:${userIdentity}`,
    options.perUserLimit,
    options.windowMs,
  );
}

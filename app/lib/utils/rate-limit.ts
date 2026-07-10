import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

interface RateLimitOptions {
  limit: number;
  windowMs: number;
  keyPrefix: string;
}

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

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

function getClientId(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  if (sessionCookie) {
    // This opaque value is only used as an in-memory bucket key. Route handlers
    // still validate the session separately before serving protected resources.
    return `session:${createHash('sha256').update(sessionCookie).digest('base64url')}`;
  }

  // Forwarded IP headers are client-controlled unless an ingress proxy strips
  // and overwrites them. Keep anonymous routes in a shared bucket; deployments
  // that need IP-based anonymous limits should enforce them at the ingress.
  return 'anonymous';
}

export function rateLimit(request: NextRequest, options: RateLimitOptions) {
  const clientId = getClientId(request);
  const key = `${options.keyPrefix}:${clientId}`;
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now > existing.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return { ok: true } as const;
  }

  if (existing.count >= options.limit) {
    const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Too many requests' },
        {
          status: 429,
          headers: {
            'Retry-After': retryAfter.toString(),
          },
        }
      ),
    } as const;
  }

  existing.count += 1;
  buckets.set(key, existing);
  return { ok: true } as const;
}

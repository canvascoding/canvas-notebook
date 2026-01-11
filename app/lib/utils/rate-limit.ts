import { NextRequest, NextResponse } from 'next/server';

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

function getClientId(request: NextRequest) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp;
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

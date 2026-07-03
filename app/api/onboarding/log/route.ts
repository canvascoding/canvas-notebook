import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { writeOnboardingLog } from '@/app/lib/onboarding/logging';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function jsonWithRequestId(requestId: string, body: Record<string, unknown>, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('X-Request-Id', requestId);
  return NextResponse.json(body, { ...init, headers });
}

function normalizeLogLevel(value: unknown): 'debug' | 'error' | 'info' | 'warn' {
  return value === 'debug' || value === 'error' || value === 'warn' ? value : 'info';
}

function normalizeEvent(value: unknown): string {
  if (typeof value !== 'string') return 'client.event';
  const normalized = value.trim().replace(/[^\w:.-]+/gu, '_').slice(0, 120);
  return normalized || 'client.event';
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const limited = rateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: 'onboarding-client-log',
  });
  if (!limited.ok) {
    await writeOnboardingLog('warn', 'client-log.rate-limited', { requestId });
    return limited.response;
  }

  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const level = normalizeLogLevel(payload.level);
  const event = normalizeEvent(payload.event);

  await writeOnboardingLog(level, event, {
    requestId,
    userId: session?.user?.id ?? null,
    pathname: payload.pathname,
    locale: payload.locale,
    details: payload.details,
    userAgent: request.headers.get('user-agent'),
  });

  return jsonWithRequestId(requestId, { success: true, requestId });
}

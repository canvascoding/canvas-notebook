import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';

function hasAuthPathSegment(pathname: string, segment: string): boolean {
  return new RegExp(`/${segment}(?:/|$)`).test(pathname);
}

function authAuditAction(pathname: string): string | null {
  if (hasAuthPathSegment(pathname, 'sign-in')) return 'auth.sign_in';
  if (hasAuthPathSegment(pathname, 'sign-out')) return 'auth.sign_out';
  if (hasAuthPathSegment(pathname, 'sign-up')) return 'auth.sign_up';
  return null;
}

function authAuditStatus(status: number): 'success' | 'failure' | 'blocked' {
  if (status === 403) return 'blocked';
  return status < 400 ? 'success' : 'failure';
}

async function getCurrentAuthUserId(request: NextRequest): Promise<string | null> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

function readUserIdFromPayload(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const directUserId = typeof record.userId === 'string' ? record.userId.trim() : '';
  if (directUserId) return directUserId;

  const userValue = record.user;
  if (!userValue || typeof userValue !== 'object') return null;
  const userId = (userValue as Record<string, unknown>).id;
  return typeof userId === 'string' && userId.trim() ? userId.trim() : null;
}

async function getAuthResponseUserId(response: Response): Promise<string | null> {
  if (response.status >= 400) return null;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) return null;

  try {
    return readUserIdFromPayload(await response.clone().json());
  } catch {
    return null;
  }
}

async function resolveAuthAuditUserId(request: NextRequest, action: string, response: Response, beforeUserId: string | null): Promise<string | null> {
  if (action === 'auth.sign_out') return beforeUserId;
  if (action === 'auth.sign_in') return (await getAuthResponseUserId(response)) ?? null;
  return beforeUserId;
}

async function recordAuthRequestAudit(
  request: NextRequest,
  action: string,
  response: Response,
  beforeUserId: string | null,
) {
  await recordAuditEvent({
    userId: await resolveAuthAuditUserId(request, action, response, beforeUserId),
    source: 'auth',
    eventType: 'auth',
    entityType: 'auth_request',
    action,
    status: authAuditStatus(response.status),
    summary: `${action} returned HTTP ${response.status}.`,
    metadata: {
      endpoint: request.nextUrl.pathname,
      statusCode: response.status,
    },
  });
}

export async function GET(request: NextRequest) {
  return auth.handler(request);
}

export async function POST(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const action = authAuditAction(pathname);
  const beforeUserId = action ? await getCurrentAuthUserId(request) : null;

  if (hasAuthPathSegment(pathname, 'sign-up')) {
    const response = NextResponse.json({ message: 'Sign up is disabled' }, { status: 403 });
    if (action) await recordAuthRequestAudit(request, action, response, beforeUserId);
    return response;
  }

  const response = await auth.handler(request);
  if (action) await recordAuthRequestAudit(request, action, response, beforeUserId);
  return response;
}

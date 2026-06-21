import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';

function authAuditAction(pathname: string): string | null {
  if (pathname.includes('/sign-in')) return 'auth.sign_in';
  if (pathname.includes('/sign-out')) return 'auth.sign_out';
  if (pathname.includes('/sign-up')) return 'auth.sign_up';
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

async function recordAuthRequestAudit(request: NextRequest, action: string, response: Response) {
  await recordAuditEvent({
    userId: await getCurrentAuthUserId(request),
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

  if (pathname.includes('/sign-up')) {
    const response = NextResponse.json({ message: 'Sign up is disabled' }, { status: 403 });
    if (action) await recordAuthRequestAudit(request, action, response);
    return response;
  }

  const response = await auth.handler(request);
  if (action) await recordAuthRequestAudit(request, action, response);
  return response;
}

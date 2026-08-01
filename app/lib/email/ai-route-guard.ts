import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';

export type EmailAiRouteSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

export async function requireEmailAiRouteSession(
  request: NextRequest,
): Promise<EmailAiRouteSession | NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  return session;
}

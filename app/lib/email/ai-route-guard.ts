import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { getLicenseStatus } from '@/app/lib/license';

export type EmailAiRouteSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

export async function requireEmailAiRouteSession(
  request: NextRequest,
): Promise<EmailAiRouteSession | NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  // These routes deliberately bypass proxy.ts so their bodies are not cloned
  // into the proxy's large upload buffer. Preserve the proxy's license gate in
  // the route handler before any request body is consumed.
  const license = await getLicenseStatus();
  if (!license.licensed) {
    return NextResponse.json(
      { success: false, error: 'License activation required', code: 'LICENSE_REQUIRED' },
      { status: 402 },
    );
  }

  return session;
}

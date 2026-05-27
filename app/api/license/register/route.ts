import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getLicenseControlPlaneUrl } from '@/app/lib/license';
import { getLicenseInstanceId, getRequestOrigin } from '@/app/lib/license/instance';

const LOG_PREFIX = '[license/register]';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    console.warn(`${LOG_PREFIX} unauthorized request`);
    return NextResponse.json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as { email?: string };
  const email = body.email?.trim() || session.user.email;
  if (!email || !email.includes('@')) {
    console.warn(`${LOG_PREFIX} invalid email request`);
    return NextResponse.json({ success: false, error: 'Valid email is required', code: 'INVALID_REQUEST' }, { status: 400 });
  }

  try {
    const controlPlaneUrl = getLicenseControlPlaneUrl();
    const instanceId = getLicenseInstanceId();
    const activationUrl = `${getRequestOrigin(request)}/settings?tab=license`;
    const response = await fetch(`${controlPlaneUrl}/v1/license/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, instanceId, activationUrl }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn(`${LOG_PREFIX} control plane rejected registration`, {
        status: response.status,
        code: typeof payload.code === 'string' ? payload.code : 'LICENSE_REGISTRATION_FAILED',
        instanceId,
      });
      return NextResponse.json(
        {
          success: false,
          error: payload.error || 'License registration failed',
          code: typeof payload.code === 'string' ? payload.code : 'LICENSE_REGISTRATION_FAILED',
        },
        { status: response.status },
      );
    }
    console.info(`${LOG_PREFIX} registration requested`, { instanceId });
    return NextResponse.json({ success: true, email, ...payload });
  } catch (error) {
    console.error(`${LOG_PREFIX} control plane request failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'License registration failed',
        code: 'LICENSE_CONTROL_PLANE_UNREACHABLE',
      },
      { status: 503 },
    );
  }
}

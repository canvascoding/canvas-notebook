import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import {
  LicenseControlPlaneError,
  requestCommunityLicenseRegistration,
} from '@/app/lib/license/control-plane';
import { getRequestOrigin } from '@/app/lib/license/instance';

const LOG_PREFIX = '[license/register]';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    console.warn(`${LOG_PREFIX} unauthorized request`);
    return NextResponse.json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as { email?: string; activationPath?: string; marketingOptIn?: boolean };
  const email = body.email?.trim() || session.user.email;
  if (!email || !email.includes('@')) {
    console.warn(`${LOG_PREFIX} invalid email request`);
    return NextResponse.json({ success: false, error: 'Valid email is required', code: 'INVALID_REQUEST' }, { status: 400 });
  }

  try {
    const activationPath = body.activationPath?.trim();
    const safeActivationPath = activationPath && activationPath.startsWith('/') && !activationPath.startsWith('//')
      ? activationPath
      : '/settings?tab=license';
    const activationUrl = `${getRequestOrigin(request)}${safeActivationPath}`;
    const marketingOptIn = body.marketingOptIn === true;
    const registration = await requestCommunityLicenseRegistration({ email, activationUrl, marketingOptIn });
    console.info(`${LOG_PREFIX} registration requested`);
    return NextResponse.json({ success: true, email, ...registration });
  } catch (error) {
    if (error instanceof LicenseControlPlaneError) {
      console.warn(`${LOG_PREFIX} control plane rejected registration`, {
        status: error.status,
        code: error.code,
      });
      return NextResponse.json(
        { success: false, error: error.message, code: error.code },
        { status: error.status },
      );
    }
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

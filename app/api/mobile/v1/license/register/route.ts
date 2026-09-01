import { NextRequest, NextResponse } from 'next/server';

import { isAdminUser } from '@/app/lib/admin-auth';
import { auth } from '@/app/lib/auth';
import {
  LicenseControlPlaneError,
  requestCommunityLicenseRegistration,
} from '@/app/lib/license/control-plane';
import { savePendingLicenseEmailActivation } from '@/app/lib/license/email-activation-storage';
import { getLicenseInstanceId, getRequestOrigin } from '@/app/lib/license/instance';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401, headers: responseHeaders },
    );
  }
  if (!isAdminUser(session.user)) {
    return NextResponse.json(
      { success: false, error: 'Only an instance administrator can request a license.', code: 'LICENSE_ADMIN_REQUIRED' },
      { status: 403, headers: responseHeaders },
    );
  }
  const limited = rateLimit(request, { limit: 3, windowMs: 60_000, keyPrefix: 'mobile-license-register' });
  if (!limited.ok) return limited.response;

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : session.user.email?.trim().toLowerCase();
  if (!email || email.length > 320 || !/^\S+@\S+\.\S+$/u.test(email)) {
    return NextResponse.json(
      { success: false, error: 'Valid email is required.', code: 'INVALID_REQUEST' },
      { status: 400, headers: responseHeaders },
    );
  }

  try {
    const registration = await requestCommunityLicenseRegistration({
      email,
      activationUrl: `${getRequestOrigin(request)}/settings?tab=license&source=mobile`,
      marketingOptIn: body.marketingOptIn === true,
    });
    if (registration.activation) {
      await savePendingLicenseEmailActivation({
        ...registration.activation,
        instanceId: getLicenseInstanceId(),
      });
    }
    const { activation, ...publicRegistration } = registration;
    return NextResponse.json(
      {
        success: true,
        email,
        delivery: 'email',
        ...publicRegistration,
        activation: activation
          ? {
              state: 'authorization_pending',
              expiresAt: activation.expiresAt,
              pollIntervalSeconds: activation.pollIntervalSeconds,
            }
          : null,
      },
      { status: 202, headers: responseHeaders },
    );
  } catch (error) {
    if (error instanceof LicenseControlPlaneError) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code },
        { status: error.status, headers: responseHeaders },
      );
    }
    console.error('[API] Mobile license registration failed:', error);
    return NextResponse.json(
      { success: false, error: 'License registration failed.', code: 'LICENSE_REGISTRATION_FAILED' },
      { status: 500, headers: responseHeaders },
    );
  }
}

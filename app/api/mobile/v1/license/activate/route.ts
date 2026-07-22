import { NextRequest, NextResponse } from 'next/server';

import { isAdminUser } from '@/app/lib/admin-auth';
import { auth } from '@/app/lib/auth';
import { isManagedLicenseConfigured } from '@/app/lib/license';
import { activateInstanceLicense, LicenseControlPlaneError } from '@/app/lib/license/control-plane';
import { setLicenseGateCookie } from '@/app/lib/license/gate-cookie';
import { mobileLicenseStatus } from '@/app/lib/mobile/license';
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
      { success: false, error: 'Only an instance administrator can activate a license.', code: 'LICENSE_ADMIN_REQUIRED' },
      { status: 403, headers: responseHeaders },
    );
  }
  const limited = rateLimit(request, { limit: 8, windowMs: 60_000, keyPrefix: 'mobile-license-activate' });
  if (!limited.ok) return limited.response;

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (key.length < 16 || key.length > 96) {
    return NextResponse.json(
      { success: false, error: 'A valid activation key is required.', code: 'INVALID_REQUEST' },
      { status: 400, headers: responseHeaders },
    );
  }

  try {
    const status = await activateInstanceLicense(key);
    const response = NextResponse.json(
      mobileLicenseStatus({
        status,
        canManage: true,
        managedConfigured: isManagedLicenseConfigured(),
      }),
      { headers: responseHeaders },
    );
    setLicenseGateCookie(response, status);
    return response;
  } catch (error) {
    if (error instanceof LicenseControlPlaneError) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code },
        { status: error.status, headers: responseHeaders },
      );
    }
    console.error('[API] Mobile license activation failed:', error);
    return NextResponse.json(
      { success: false, error: 'License activation failed.', code: 'LICENSE_ACTIVATION_FAILED' },
      { status: 500, headers: responseHeaders },
    );
  }
}

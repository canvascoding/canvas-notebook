import { NextResponse } from 'next/server';

import { isAdminUser } from '@/app/lib/admin-auth';
import { auth } from '@/app/lib/auth';
import { getLicenseStatus, isManagedLicenseConfigured } from '@/app/lib/license';
import { mobileLicenseStatus } from '@/app/lib/mobile/license';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401, headers: responseHeaders },
    );
  }
  try {
    const status = await getLicenseStatus();
    return NextResponse.json(
      mobileLicenseStatus({
        status,
        canManage: isAdminUser(session.user),
        managedConfigured: isManagedLicenseConfigured(),
      }),
      { headers: responseHeaders },
    );
  } catch (error) {
    console.error('[API] Mobile license status failed:', error);
    return NextResponse.json(
      { success: false, error: 'The license status could not be checked.', code: 'LICENSE_STATUS_FAILED' },
      { status: 500, headers: responseHeaders },
    );
  }
}

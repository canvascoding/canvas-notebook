import { NextResponse } from 'next/server';

import { getLicenseStatus } from '@/app/lib/license';
import { codeFromLicenseError } from '@/app/lib/license/error-codes';
import { setLicenseGateCookie } from '@/app/lib/license/gate-cookie';
import { logLicenseInfoThrottled } from '@/app/lib/license/logging';

export async function GET() {
  const status = await getLicenseStatus();
  const code = codeFromLicenseError(status.error);
  logLicenseInfoThrottled('[license/status/api]', 'returning license status', {
    licensed: status.licensed,
    plan: status.plan,
    source: status.source,
    instanceId: status.instanceId,
    expiresAt: status.expiresAt,
    error: status.error,
    code,
  });
  const response = NextResponse.json({ success: true, ...status, code });
  setLicenseGateCookie(response, status);
  return response;
}

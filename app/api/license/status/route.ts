import { NextResponse } from 'next/server';

import { getLicenseStatus } from '@/app/lib/license';
import { setLicenseGateCookie } from '@/app/lib/license/gate-cookie';

export async function GET() {
  const status = await getLicenseStatus();
  const response = NextResponse.json({ success: true, ...status });
  setLicenseGateCookie(response, status);
  return response;
}

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { activateLicenseCert, getLicenseControlPlaneUrl } from '@/app/lib/license';
import { setLicenseGateCookie } from '@/app/lib/license/gate-cookie';
import { getLicenseInstanceId } from '@/app/lib/license/instance';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as { key?: string };
  const key = body.key?.trim();
  if (!key) {
    return NextResponse.json({ success: false, error: 'Activation key is required' }, { status: 400 });
  }

  try {
    const controlPlaneUrl = getLicenseControlPlaneUrl();
    const instanceId = getLicenseInstanceId();
    const upstream = await fetch(`${controlPlaneUrl}/v1/license/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, instanceId }),
    });
    const payload = await upstream.json().catch(() => ({})) as { license?: string; error?: string };
    if (!upstream.ok || !payload.license) {
      return NextResponse.json(
        { success: false, error: payload.error || 'License activation failed' },
        { status: upstream.status || 400 },
      );
    }

    const status = await activateLicenseCert(payload.license);
    const response = NextResponse.json({ success: true, ...status });
    setLicenseGateCookie(response, status);
    return response;
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'License activation failed' },
      { status: 503 },
    );
  }
}

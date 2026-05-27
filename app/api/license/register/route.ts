import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getLicenseControlPlaneUrl } from '@/app/lib/license';
import { getLicenseInstanceId, getRequestOrigin } from '@/app/lib/license/instance';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as { email?: string };
  const email = body.email?.trim() || session.user.email;
  if (!email || !email.includes('@')) {
    return NextResponse.json({ success: false, error: 'Valid email is required' }, { status: 400 });
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
      return NextResponse.json(
        { success: false, error: payload.error || 'License registration failed' },
        { status: response.status },
      );
    }
    return NextResponse.json({ success: true, email, ...payload });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'License registration failed' },
      { status: 503 },
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { activateLicenseCert, getLicenseControlPlaneUrl } from '@/app/lib/license';
import { codeFromLicenseError, licenseActivationFailureCode } from '@/app/lib/license/error-codes';
import { setLicenseGateCookie } from '@/app/lib/license/gate-cookie';
import { getLicenseInstanceId } from '@/app/lib/license/instance';

const LOG_PREFIX = '[license/activate]';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    console.warn(`${LOG_PREFIX} unauthorized request`);
    return NextResponse.json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as { key?: string };
  const key = body.key?.trim();
  if (!key) {
    console.warn(`${LOG_PREFIX} missing activation key`);
    return NextResponse.json({ success: false, error: 'Activation key is required', code: 'INVALID_REQUEST' }, { status: 400 });
  }

  try {
    const controlPlaneUrl = getLicenseControlPlaneUrl();
    const instanceId = getLicenseInstanceId();
    const upstream = await fetch(`${controlPlaneUrl}/v1/license/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, instanceId }),
    });
    const payload = await upstream.json().catch(() => ({})) as { license?: string; error?: string; code?: string };
    if (!upstream.ok || !payload.license) {
      const code = payload.code || licenseActivationFailureCode(payload.error || '');
      console.warn(`${LOG_PREFIX} control plane rejected activation`, {
        status: upstream.status,
        code,
        instanceId,
      });
      return NextResponse.json(
        { success: false, error: payload.error || 'License activation failed', code },
        { status: upstream.status || 400 },
      );
    }

    const status = await activateLicenseCert(payload.license);
    console.info(`${LOG_PREFIX} license activated`, { instanceId, plan: status.plan, source: status.source });
    const response = NextResponse.json({ success: true, ...status, code: codeFromLicenseError(status.error) });
    setLicenseGateCookie(response, status);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'License activation failed';
    const code = message.includes('invalid for this instance') ? 'LICENSE_INVALID' : 'LICENSE_CONTROL_PLANE_UNREACHABLE';
    console.error(`${LOG_PREFIX} activation failed`, {
      error: message,
      code,
    });
    return NextResponse.json(
      {
        success: false,
        error: message,
        code,
      },
      { status: code === 'LICENSE_INVALID' ? 400 : 503 },
    );
  }
}

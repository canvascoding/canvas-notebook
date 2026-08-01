import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { activateInstanceLicense, LicenseControlPlaneError } from '@/app/lib/license/control-plane';
import { codeFromLicenseError } from '@/app/lib/license/error-codes';
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
    const instanceId = getLicenseInstanceId();
    const status = await activateInstanceLicense(key);
    console.info(`${LOG_PREFIX} license activated`, { instanceId, plan: status.plan, source: status.source });
    return NextResponse.json({ success: true, ...status, code: codeFromLicenseError(status.error) });
  } catch (error) {
    if (error instanceof LicenseControlPlaneError) {
      console.warn(`${LOG_PREFIX} control plane rejected activation`, {
        status: error.status,
        code: error.code,
      });
      return NextResponse.json(
        { success: false, error: error.message, code: error.code },
        { status: error.status },
      );
    }
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

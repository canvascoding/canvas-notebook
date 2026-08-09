import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { redactTeamControlPlaneLogText } from '@/app/lib/control-plane/team-client';
import { activateInstanceLicense, LicenseControlPlaneError } from '@/app/lib/license/control-plane';
import { codeFromLicenseStatus } from '@/app/lib/license/error-codes';
import { getLicenseInstanceId } from '@/app/lib/license/instance';
import { logLicenseError } from '@/app/lib/license/logging';
import { publicLicenseStatus } from '@/app/lib/license/status-response';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const LOG_PREFIX = '[license/activate]';

export async function POST(request: NextRequest) {
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    console.warn(`${LOG_PREFIX} unauthorized request`);
    return NextResponse.json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 10 * 60_000,
    keyPrefix: 'license-activation',
  });
  if (!limited.ok) return limited.response;

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
    return NextResponse.json({
      success: true,
      ...publicLicenseStatus(status, codeFromLicenseStatus(status)),
    });
  } catch (error) {
    if (error instanceof LicenseControlPlaneError) {
      const message = redactTeamControlPlaneLogText(error.message, [key]);
      logLicenseError(LOG_PREFIX, 'control plane rejected activation', {
        status: error.status,
        code: error.code,
      }, error, { knownSecrets: [key] });
      return NextResponse.json(
        { success: false, error: message, code: error.code },
        { status: error.status },
      );
    }
    const message = redactTeamControlPlaneLogText(
      error instanceof Error ? error.message : 'License activation failed',
      [key],
    );
    const code = message.includes('invalid for this instance') ? 'LICENSE_INVALID' : 'LICENSE_CONTROL_PLANE_UNREACHABLE';
    logLicenseError(LOG_PREFIX, 'activation failed', {
      code,
    }, error, { knownSecrets: [key] });
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

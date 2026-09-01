import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { redactTeamControlPlaneLogText } from '@/app/lib/control-plane/team-client';
import {
  LicenseControlPlaneError,
  requestCommunityLicenseRegistration,
} from '@/app/lib/license/control-plane';
import { getLicenseInstanceId, getRequestOrigin } from '@/app/lib/license/instance';
import { logLicenseError } from '@/app/lib/license/logging';
import { savePendingLicenseEmailActivation } from '@/app/lib/license/email-activation-storage';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const LOG_PREFIX = '[license/register]';

export async function POST(request: NextRequest) {
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    console.warn(`${LOG_PREFIX} unauthorized request`);
    return NextResponse.json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 5,
    windowMs: 10 * 60_000,
    keyPrefix: 'license-registration',
  });
  if (!limited.ok) return limited.response;

  const body = await request.json().catch(() => ({})) as { email?: string; activationPath?: string; marketingOptIn?: boolean };
  const email = body.email?.trim() || session.user.email;
  if (!email || !email.includes('@')) {
    console.warn(`${LOG_PREFIX} invalid email request`);
    return NextResponse.json({ success: false, error: 'Valid email is required', code: 'INVALID_REQUEST' }, { status: 400 });
  }

  try {
    const activationPath = body.activationPath?.trim();
    const safeActivationPath = activationPath && activationPath.startsWith('/') && !activationPath.startsWith('//')
      ? activationPath
      : '/settings?tab=license';
    const activationUrl = `${getRequestOrigin(request)}${safeActivationPath}`;
    const marketingOptIn = body.marketingOptIn === true;
    const registration = await requestCommunityLicenseRegistration({ email, activationUrl, marketingOptIn });
    if (registration.activation) {
      await savePendingLicenseEmailActivation({
        ...registration.activation,
        instanceId: getLicenseInstanceId(),
      });
    }
    const { activation, ...publicRegistration } = registration;
    console.info(`${LOG_PREFIX} registration requested`);
    return NextResponse.json({
      success: true,
      email,
      ...publicRegistration,
      activation: activation
        ? {
            state: 'authorization_pending',
            expiresAt: activation.expiresAt,
            pollIntervalSeconds: activation.pollIntervalSeconds,
          }
        : null,
    });
  } catch (error) {
    if (error instanceof LicenseControlPlaneError) {
      const message = redactTeamControlPlaneLogText(error.message, [email]);
      logLicenseError(LOG_PREFIX, 'control plane rejected registration', {
        status: error.status,
        code: error.code,
      }, error, { knownSecrets: [email] });
      return NextResponse.json(
        { success: false, error: message, code: error.code },
        { status: error.status },
      );
    }
    const message = redactTeamControlPlaneLogText(
      error instanceof Error ? error.message : 'License registration failed',
      [email],
    );
    logLicenseError(LOG_PREFIX, 'control plane request failed', {}, error, {
      knownSecrets: [email],
    });
    return NextResponse.json(
      {
        success: false,
        error: message,
        code: 'LICENSE_CONTROL_PLANE_UNREACHABLE',
      },
      { status: 503 },
    );
  }
}

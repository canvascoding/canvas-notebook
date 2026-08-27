import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  LicenseControlPlaneError,
  pollPendingLicenseEmailActivation,
} from '@/app/lib/license/control-plane';
import { logLicenseError } from '@/app/lib/license/logging';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const LOG_PREFIX = '[license/email-activation]';
const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};

export async function POST(request: NextRequest) {
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401, headers: responseHeaders },
    );
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'license-email-activation-poll',
  });
  if (!limited.ok) return limited.response;

  try {
    const activation = await pollPendingLicenseEmailActivation();
    return NextResponse.json(
      { success: true, activation },
      { headers: responseHeaders },
    );
  } catch (error) {
    if (error instanceof LicenseControlPlaneError) {
      if (error.status >= 500) {
        logLicenseError(LOG_PREFIX, 'license activation status failed', {
          status: error.status,
          code: error.code,
        }, error);
      }
      return NextResponse.json(
        {
          success: false,
          error: error.message,
          code: error.code,
          retryable: error.retryable,
        },
        { status: error.status, headers: responseHeaders },
      );
    }
    logLicenseError(LOG_PREFIX, 'license activation status failed', {}, error);
    return NextResponse.json(
      {
        success: false,
        error: 'License activation status could not be loaded.',
        code: 'LICENSE_EMAIL_ACTIVATION_FAILED',
      },
      { status: 500, headers: responseHeaders },
    );
  }
}

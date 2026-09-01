import { NextResponse } from 'next/server';

import { jsonServerError } from '@/app/lib/api/route-helpers';
import { auth } from '@/app/lib/auth';
import {
  LicenseEntitlementError,
  licenseEntitlementErrorPayload,
} from '@/app/lib/license/entitlements';
import { getLicenseInstanceId } from '@/app/lib/license/instance';
import {
  assertUserSeatAccess,
  SeatLimitGuardError,
} from '@/app/lib/license/seat-limit';
import { createMobileBootstrap } from '@/app/lib/mobile/bootstrap';
import { createMobileCompatibility } from '@/app/lib/mobile/compatibility';
import { resolveMobileUserProfile } from '@/app/lib/mobile/user-profile';
import { getCurrentAppVersion } from '@/app/lib/migration/app-version';
import { getDeploymentMode } from '@/app/lib/organization/bootstrap';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import {
  loadWorkspaceListingForActor,
  WorkspaceListingError,
} from '@/app/lib/workspaces/listing-action';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
        { status: 401, headers: responseHeaders },
      );
    }
    await assertUserSeatAccess({ userId: session.user.id });

    const actor = resolveWorkspaceActor({
      id: session.user.id,
      email: session.user.email,
      role: session.user.role,
    });
    const listing = await loadWorkspaceListingForActor(actor);
    const compatibility = createMobileCompatibility({
      rawInstanceId: getLicenseInstanceId(),
      instanceName: process.env.CANVAS_INSTANCE_NAME,
      serverVersion: getCurrentAppVersion(),
      deploymentMode: getDeploymentMode(),
    });
    const profile = await resolveMobileUserProfile({
      userId: session.user.id,
      name: session.user.name,
      email: session.user.email,
    });

    return NextResponse.json(
      createMobileBootstrap({ compatibility, request, user: session.user, profile, listing }),
      { headers: responseHeaders },
    );
  } catch (error) {
    if (error instanceof LicenseEntitlementError) {
      return NextResponse.json(
        licenseEntitlementErrorPayload(error),
        { status: error.statusCode, headers: responseHeaders },
      );
    }
    if (error instanceof SeatLimitGuardError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
          code: error.code,
          ...error.details,
        },
        { status: error.status, headers: responseHeaders },
      );
    }
    if (error instanceof WorkspaceListingError) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code },
        { status: error.status, headers: responseHeaders },
      );
    }
    return jsonServerError(
      '[API] Mobile bootstrap error:',
      error,
      'Could not bootstrap Canvas Notebook Mobile',
    );
  }
}

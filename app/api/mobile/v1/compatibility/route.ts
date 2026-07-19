import { NextResponse } from 'next/server';

import { getLicenseInstanceId } from '@/app/lib/license/instance';
import { createMobileCompatibility } from '@/app/lib/mobile/compatibility';
import { getCurrentAppVersion } from '@/app/lib/migration/app-version';
import { getDeploymentMode } from '@/app/lib/organization/bootstrap';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    createMobileCompatibility({
      rawInstanceId: getLicenseInstanceId(),
      instanceName: process.env.CANVAS_INSTANCE_NAME,
      serverVersion: getCurrentAppVersion(),
      deploymentMode: getDeploymentMode(),
    }),
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}

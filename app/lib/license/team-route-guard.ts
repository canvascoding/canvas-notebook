import 'server-only';

import { NextResponse } from 'next/server';

import {
  LicenseEntitlementError,
  licenseEntitlementErrorPayload,
  requireTeamRuntimeLicense,
} from './entitlements';

export async function requireTeamRuntimeRoute(): Promise<NextResponse | null> {
  try {
    await requireTeamRuntimeLicense();
    return null;
  } catch (error) {
    if (error instanceof LicenseEntitlementError) {
      return NextResponse.json(
        licenseEntitlementErrorPayload(error),
        { status: error.statusCode },
      );
    }
    throw error;
  }
}

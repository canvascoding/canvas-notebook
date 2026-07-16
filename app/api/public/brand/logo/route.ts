import { NextResponse } from 'next/server';

import {
  ORGANIZATION_BRAND_LOGO_PATH,
  readOrganizationBrandLogo,
} from '@/app/lib/workspaces/brand-logo-service';
import { readPrimaryOrganizationBrandProfile } from '@/app/lib/workspaces/brand-profile-service';

function notFoundResponse() {
  return NextResponse.json(
    { success: false, error: 'Public brand logo not found.' },
    {
      status: 404,
      headers: { 'Cache-Control': 'public, no-cache' },
    },
  );
}

export async function GET() {
  try {
    const state = await readPrimaryOrganizationBrandProfile();
    if (
      !state
      || !state.profile.appearance.enabled
      || state.profile.logoPath !== ORGANIZATION_BRAND_LOGO_PATH
    ) {
      return notFoundResponse();
    }

    const logo = await readOrganizationBrandLogo(state.organizationId);
    if (!logo) return notFoundResponse();

    return new NextResponse(new Uint8Array(logo.buffer), {
      status: 200,
      headers: {
        'Content-Type': logo.mimeType,
        'Content-Length': String(logo.size),
        'Cache-Control': 'public, no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[API] Public brand logo read failed:', error);
    return NextResponse.json(
      { success: false, error: 'Could not load public brand logo.' },
      {
        status: 500,
        headers: { 'Cache-Control': 'public, no-cache' },
      },
    );
  }
}

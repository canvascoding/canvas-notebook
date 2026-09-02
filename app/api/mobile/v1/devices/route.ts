import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  getMobilePushDeviceStatus,
  MobilePushDeviceError,
  parseMobileInstallationId,
  parseMobilePushPreferenceUpdate,
  parseMobilePushRegistration,
  registerMobilePushDevice,
  updateMobilePushDevicePreference,
  unregisterMobilePushDevice,
} from '@/app/lib/mobile/push-devices';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};

function unauthorized() {
  return NextResponse.json(
    { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
    { status: 401, headers: responseHeaders },
  );
}

function errorResponse(error: unknown) {
  if (error instanceof MobilePushDeviceError) {
    console.warn('[API] Mobile push device request rejected:', {
      code: error.code,
      status: error.status,
    });
    return NextResponse.json(
      { success: false, error: error.message, code: error.code },
      { status: error.status, headers: responseHeaders },
    );
  }
  console.error('[API] Mobile push device error:', error);
  return NextResponse.json(
    { success: false, error: 'Could not update this mobile device.', code: 'DEVICE_UPDATE_FAILED' },
    { status: 500, headers: responseHeaders },
  );
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return unauthorized();
  try {
    const installationId = parseMobileInstallationId(request.nextUrl.searchParams.get('installationId'));
    const device = await getMobilePushDeviceStatus({ userId: session.user.id, installationId });
    return NextResponse.json({ success: true, device }, { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  console.info('[API] Mobile push device POST received:', { path: request.nextUrl.pathname });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return unauthorized();
  try {
    const registration = parseMobilePushRegistration(await request.json().catch(() => null));
    console.info('[API] Mobile push device registration parsed:', {
      userId: session.user.id,
      installationId: registration.installationId,
      platform: registration.platform,
      appVariant: registration.appVariant,
      reactivate: registration.reactivate,
      preferences: registration.preferences,
    });
    const device = await registerMobilePushDevice({
      userId: session.user.id,
      authSessionId: session.session.id,
      registration,
    });
    return NextResponse.json({ success: true, device }, { status: 201, headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  console.info('[API] Mobile push preference PATCH received:', { path: request.nextUrl.pathname });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return unauthorized();
  try {
    const update = parseMobilePushPreferenceUpdate(await request.json().catch(() => null));
    console.info('[API] Mobile push preference update parsed:', {
      userId: session.user.id,
      installationId: update.installationId,
      key: update.key,
      enabled: update.enabled,
    });
    const device = await updateMobilePushDevicePreference({ userId: session.user.id, update });
    return NextResponse.json({ success: true, device }, { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return unauthorized();
  try {
    const body = await request.json().catch(() => null);
    const installationId = parseMobileInstallationId(
      body && typeof body === 'object' && 'installationId' in body
        ? (body as { installationId?: unknown }).installationId
        : null,
    );
    await unregisterMobilePushDevice({ userId: session.user.id, installationId });
    return NextResponse.json({ success: true }, { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

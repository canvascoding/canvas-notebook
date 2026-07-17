import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { clearComposioGatewayCaches } from '@/app/lib/composio/composio-gateway';
import { toPublicComposioProfile } from '@/app/lib/composio/composio-context';
import {
  archiveComposioProfile,
  ComposioProfileError,
  renameComposioProfile,
} from '@/app/lib/composio/composio-profiles';

function errorResponse(error: unknown) {
  return NextResponse.json({
    success: false,
    code: error instanceof ComposioProfileError ? error.code : 'COMPOSIO_PROFILE_UPDATE_FAILED',
    error: error instanceof Error ? error.message : 'Could not update the connection profile.',
  }, { status: error instanceof ComposioProfileError ? error.status : 500 });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ profileId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  try {
    const payload = await request.json().catch(() => null) as { name?: unknown } | null;
    const profile = await renameComposioProfile({
      ownerUserId: session.user.id,
      profileId: (await params).profileId,
      name: payload?.name,
    });
    clearComposioGatewayCaches();
    return NextResponse.json({ success: true, profile: toPublicComposioProfile(profile) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ profileId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  try {
    await archiveComposioProfile({
      ownerUserId: session.user.id,
      profileId: (await params).profileId,
    });
    clearComposioGatewayCaches();
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}

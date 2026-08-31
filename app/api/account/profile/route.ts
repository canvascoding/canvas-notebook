import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import {
  resolveUserProfile,
  selectUserProfileIcon,
  selectUserProfileInitials,
  UserProfileError,
} from '@/app/lib/user-profile/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function profileResponse(data: Awaited<ReturnType<typeof resolveUserProfile>>) {
  return NextResponse.json(
    { success: true, data },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    return profileResponse(await resolveUserProfile({
      userId: session.user.id,
      name: session.user.name,
      email: session.user.email,
    }));
  } catch (error) {
    console.error('[UserProfile] Failed to read the current user profile.', error);
    return NextResponse.json({ success: false, error: 'Could not load the user profile.' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return origin.response;
  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'user-profile-update',
  });
  if (!limited.ok) return limited.response;

  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload || Array.isArray(payload)) {
    return NextResponse.json({ success: false, error: 'Invalid profile update.' }, { status: 400 });
  }

  try {
    if (payload.avatarKind === 'icon') {
      await selectUserProfileIcon({ userId: session.user.id, iconId: payload.iconId });
    } else if (payload.avatarKind === 'initials') {
      await selectUserProfileInitials(session.user.id);
    } else {
      return NextResponse.json(
        { success: false, error: 'Choose a supported icon or the initials fallback.' },
        { status: 400 },
      );
    }

    return profileResponse(await resolveUserProfile({
      userId: session.user.id,
      name: session.user.name,
      email: session.user.email,
    }));
  } catch (error) {
    if (error instanceof UserProfileError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error('[UserProfile] Failed to update the current user profile.', error);
    return NextResponse.json({ success: false, error: 'Could not update the user profile.' }, { status: 500 });
  }
}

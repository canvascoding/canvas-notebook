import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { resolveMobileUserProfile } from '@/app/lib/mobile/user-profile';
import {
  selectUserProfileIcon,
  selectUserProfileInitials,
  UserProfileError,
} from '@/app/lib/user-profile/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};

function errorResponse(error: string, code: string, status: number) {
  return NextResponse.json(
    { success: false, error, code },
    { status, headers: responseHeaders },
  );
}

async function profileResponse(user: { id: string; name?: string | null; email?: string | null }) {
  const data = await resolveMobileUserProfile({
    userId: user.id,
    name: user.name,
    email: user.email,
  });
  return NextResponse.json({ success: true, data }, { headers: responseHeaders });
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return errorResponse('Unauthorized', 'UNAUTHORIZED', 401);

  try {
    return await profileResponse(session.user);
  } catch (error) {
    console.error('[MobileUserProfile] Failed to read the current user profile.', error);
    return errorResponse(
      'Could not load the user profile.',
      'ACCOUNT_PROFILE_UNAVAILABLE',
      500,
    );
  }
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return errorResponse('Unauthorized', 'UNAUTHORIZED', 401);

  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'mobile-user-profile-update',
  });
  if (!limited.ok) return limited.response;

  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload || Array.isArray(payload)) {
    return errorResponse('Invalid profile update.', 'INVALID_PROFILE_UPDATE', 400);
  }

  try {
    if (payload.avatarKind === 'icon') {
      await selectUserProfileIcon({ userId: session.user.id, iconId: payload.iconId });
    } else if (payload.avatarKind === 'initials') {
      await selectUserProfileInitials(session.user.id);
    } else {
      return errorResponse(
        'Choose a supported icon or the initials fallback.',
        'INVALID_PROFILE_CHOICE',
        400,
      );
    }
    return await profileResponse(session.user);
  } catch (error) {
    if (error instanceof UserProfileError) {
      return errorResponse(error.message, 'INVALID_PROFILE_CHOICE', error.status);
    }
    console.error('[MobileUserProfile] Failed to update the current user profile.', error);
    return errorResponse(
      'Could not update the user profile.',
      'ACCOUNT_PROFILE_UPDATE_FAILED',
      500,
    );
  }
}

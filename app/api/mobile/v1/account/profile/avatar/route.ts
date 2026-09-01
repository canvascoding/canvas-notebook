import { createHash } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import { parseMultipartFormData } from '@/app/lib/api/form-data';
import { auth } from '@/app/lib/auth';
import { resolveMobileUserProfile } from '@/app/lib/mobile/user-profile';
import {
  readUserProfileImage,
  saveUserProfileImage,
  selectUserProfileInitials,
  UserProfileError,
} from '@/app/lib/user-profile/service';
import {
  normalizeUserProfileUpload,
  USER_PROFILE_AVATAR_MAX_UPLOAD_BYTES,
  UserProfileUploadError,
} from '@/app/lib/user-profile/upload';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const MULTIPART_OVERHEAD_ALLOWANCE_BYTES = 64 * 1024;

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

function mutationLimit(request: NextRequest) {
  return rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'mobile-user-profile-avatar-mutation',
  });
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return errorResponse('Unauthorized', 'UNAUTHORIZED', 401);

  try {
    const image = await readUserProfileImage(session.user.id);
    if (!image) return errorResponse('Profile image not found.', 'PROFILE_IMAGE_NOT_FOUND', 404);

    const etag = `"${createHash('sha256').update(image.buffer).digest('base64url')}"`;
    if (request.headers.get('if-none-match') === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': 'private, max-age=31536000, immutable',
          Vary: 'Cookie',
        },
      });
    }

    return new NextResponse(new Uint8Array(image.buffer), {
      status: 200,
      headers: {
        'Content-Type': 'image/webp',
        'Content-Length': String(image.buffer.length),
        'Cache-Control': 'private, max-age=31536000, immutable',
        ETag: etag,
        ...(image.updatedAt ? { 'Last-Modified': new Date(image.updatedAt).toUTCString() } : {}),
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        Vary: 'Cookie',
      },
    });
  } catch (error) {
    console.error('[MobileUserProfile] Failed to read the current user avatar.', error);
    return errorResponse('Could not load the profile image.', 'PROFILE_IMAGE_UNAVAILABLE', 500);
  }
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return errorResponse('Unauthorized', 'UNAUTHORIZED', 401);
  const limited = mutationLimit(request);
  if (!limited.ok) return limited.response;

  const contentLength = Number(request.headers.get('content-length'));
  if (
    Number.isFinite(contentLength)
    && contentLength > USER_PROFILE_AVATAR_MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE_BYTES
  ) {
    return errorResponse(
      'Profile image is too large. Maximum size is 5 MB.',
      'PROFILE_IMAGE_TOO_LARGE',
      413,
    );
  }

  try {
    const parsed = await parseMultipartFormData(request);
    if (!parsed.ok) return parsed.response;
    const files = parsed.formData.getAll('avatar').filter((value): value is File => value instanceof File);
    if (files.length !== 1) {
      return errorResponse('Upload exactly one profile image.', 'INVALID_PROFILE_IMAGE', 400);
    }
    if (files[0].size > USER_PROFILE_AVATAR_MAX_UPLOAD_BYTES) {
      return errorResponse(
        'Profile image is too large. Maximum size is 5 MB.',
        'PROFILE_IMAGE_TOO_LARGE',
        413,
      );
    }

    const normalized = await normalizeUserProfileUpload(Buffer.from(await files[0].arrayBuffer()));
    await saveUserProfileImage({ userId: session.user.id, buffer: normalized });
    return await profileResponse(session.user);
  } catch (error) {
    if (error instanceof UserProfileUploadError || error instanceof UserProfileError) {
      return errorResponse(error.message, 'INVALID_PROFILE_IMAGE', error.status);
    }
    console.error('[MobileUserProfile] Failed to upload the current user avatar.', error);
    return errorResponse(
      'Could not upload the profile image.',
      'PROFILE_IMAGE_UPLOAD_FAILED',
      500,
    );
  }
}

export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return errorResponse('Unauthorized', 'UNAUTHORIZED', 401);
  const limited = mutationLimit(request);
  if (!limited.ok) return limited.response;

  try {
    await selectUserProfileInitials(session.user.id);
    return await profileResponse(session.user);
  } catch (error) {
    if (error instanceof UserProfileError) {
      return errorResponse(error.message, 'PROFILE_IMAGE_REMOVE_FAILED', error.status);
    }
    console.error('[MobileUserProfile] Failed to remove the current user avatar.', error);
    return errorResponse(
      'Could not remove the profile image.',
      'PROFILE_IMAGE_REMOVE_FAILED',
      500,
    );
  }
}

import { createHash } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import { parseMultipartFormData } from '@/app/lib/api/form-data';
import { auth } from '@/app/lib/auth';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import {
  readUserProfileImage,
  resolveUserProfile,
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

function mutationLimit(request: NextRequest) {
  return rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'user-profile-avatar-mutation',
  });
}

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
    const image = await readUserProfileImage(session.user.id);
    if (!image) {
      return NextResponse.json({ success: false, error: 'Profile image not found.' }, { status: 404 });
    }
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
    console.error('[UserProfile] Failed to read the current user avatar.', error);
    return NextResponse.json({ success: false, error: 'Could not load the profile image.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return origin.response;
  const limited = mutationLimit(request);
  if (!limited.ok) return limited.response;

  const contentLength = Number(request.headers.get('content-length'));
  if (
    Number.isFinite(contentLength)
    && contentLength > USER_PROFILE_AVATAR_MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE_BYTES
  ) {
    return NextResponse.json(
      { success: false, error: 'Profile image is too large. Maximum size is 5 MB.' },
      { status: 413 },
    );
  }

  try {
    const parsed = await parseMultipartFormData(request);
    if (!parsed.ok) return parsed.response;
    const files = parsed.formData.getAll('avatar').filter((value): value is File => value instanceof File);
    if (files.length !== 1) {
      return NextResponse.json(
        { success: false, error: 'Upload exactly one profile image.' },
        { status: 400 },
      );
    }
    if (files[0].size > USER_PROFILE_AVATAR_MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { success: false, error: 'Profile image is too large. Maximum size is 5 MB.' },
        { status: 413 },
      );
    }

    const normalized = await normalizeUserProfileUpload(Buffer.from(await files[0].arrayBuffer()));
    await saveUserProfileImage({ userId: session.user.id, buffer: normalized });
    return profileResponse(await resolveUserProfile({
      userId: session.user.id,
      name: session.user.name,
      email: session.user.email,
    }));
  } catch (error) {
    if (error instanceof UserProfileUploadError || error instanceof UserProfileError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error('[UserProfile] Failed to upload the current user avatar.', error);
    return NextResponse.json({ success: false, error: 'Could not upload the profile image.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return origin.response;
  const limited = mutationLimit(request);
  if (!limited.ok) return limited.response;

  try {
    await selectUserProfileInitials(session.user.id);
    return profileResponse(await resolveUserProfile({
      userId: session.user.id,
      name: session.user.name,
      email: session.user.email,
    }));
  } catch (error) {
    if (error instanceof UserProfileError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error('[UserProfile] Failed to remove the current user avatar.', error);
    return NextResponse.json({ success: false, error: 'Could not remove the profile image.' }, { status: 500 });
  }
}

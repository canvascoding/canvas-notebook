import { createHash } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import { getWorkspacePresenceSnapshot } from '@/app/lib/collaboration/presence';
import { readUserProfileImage } from '@/app/lib/user-profile/service';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;

  const userId = request.nextUrl.searchParams.get('userId')?.trim();
  if (!userId) {
    return NextResponse.json({ success: false, error: 'Missing collaborator.' }, { status: 400 });
  }

  const activeCollaborator = getWorkspacePresenceSnapshot(workspaceResult.workspace.workspaceId).entries.some((entry) => (
    entry.actorType === 'user' && entry.userId === userId
  ));
  if (!activeCollaborator) {
    return NextResponse.json({ success: false, error: 'Collaborator avatar not found.' }, { status: 404 });
  }

  const image = await readUserProfileImage(userId);
  if (!image) {
    return NextResponse.json({ success: false, error: 'Profile image not found.' }, { status: 404 });
  }

  const etag = `"${createHash('sha256').update(image.buffer).digest('base64url')}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': 'private, max-age=31536000, immutable', Vary: 'Cookie' },
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
}

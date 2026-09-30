import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { applyTodoRateLimit, requireTodoSession } from '@/app/lib/todos/api';
import { getTodo, TodoStoreError } from '@/app/lib/todos/store';
import { readUserProfileImage } from '@/app/lib/user-profile/service';

function unavailableAvatar() {
  return NextResponse.json({ success: false, error: 'Profile image not found.' }, {
    status: 404, headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, response } = await requireTodoSession(request);
  if (!session || response) return response;
  const limited = applyTodoRateLimit(request, 'todo-avatar-get');
  if (!limited.ok) return limited.response;
  try {
    const { id } = await context.params;
    const todo = await getTodo(session.user.id, id);
    const targets = request.nextUrl.searchParams.getAll('userId');
    if (!todo || targets.length !== 1 || !targets[0]
      || ![todo.createdBy?.id, todo.assignee?.id].includes(targets[0])) return unavailableAvatar();
    const image = await readUserProfileImage(targets[0]);
    if (!image) return unavailableAvatar();
    const etag = `"${createHash('sha256').update(image.buffer).digest('base64url')}"`;
    const headers = {
      ETag: etag,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    // Reauthorize access before responding to a conditional request.
    if (request.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers });
    return new NextResponse(new Uint8Array(image.buffer), {
      headers: { ...headers, 'Content-Type': 'image/webp', 'Content-Length': String(image.buffer.length),
        ...(image.updatedAt ? { 'Last-Modified': new Date(image.updatedAt).toUTCString() } : {}) },
    });
  } catch (error) {
    if (error instanceof TodoStoreError && error.code === 'TODO_NOT_FOUND') return unavailableAvatar();
    console.error('[Todos] Failed to read a Todo profile image.', error);
    return NextResponse.json({ success: false, error: 'Could not load the profile image.' }, {
      status: 500, headers: { 'Cache-Control': 'no-store' },
    });
  }
}

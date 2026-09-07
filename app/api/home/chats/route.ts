import { NextRequest } from 'next/server';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import { applyRateLimit, jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { listHomeChats } from '@/app/lib/home/recent-chats';

export async function GET(request: NextRequest) {
  if (!request.nextUrl.searchParams.get('workspaceId')?.trim()) return jsonError('Workspace is required', 400);
  const result = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (result.response) return result.response;
  const limited = applyRateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'home-chats' });
  if (limited) return limited;
  const limit = Number(request.nextUrl.searchParams.get('limit') || 10);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) return jsonError('Invalid limit', 400);
  try {
    const data = await listHomeChats(result.session.user.id, result.workspace, (request.nextUrl.searchParams.get('q') || '').trim().slice(0, 256), limit);
    return jsonSuccess({ data }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return jsonServerError('[Home chats]', error, 'Failed to load recent chats');
  }
}

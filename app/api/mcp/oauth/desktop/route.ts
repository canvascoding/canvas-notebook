import { NextRequest, NextResponse } from 'next/server';

import { mcpErrorStatus } from '@/app/lib/mcp/access';
import { cancelMcpDesktopOAuth, finalizeMcpDesktopOAuth, getMcpDesktopOAuthStatus } from '@/app/lib/mcp/desktop-oauth';
import { requireMcpRequestActor } from '@/app/lib/mcp/request-access';
import { isSecretReadinessError } from '@/app/lib/secrets/readiness';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function failure(error: unknown): NextResponse {
  const code = (error as { code?: string })?.code;
  return NextResponse.json({
    success: false, error: error instanceof Error ? error.message : 'Desktop sign-in failed.', code,
    ...(isSecretReadinessError(error) ? { settingsUrl: '/settings?tab=secrets' } : {}),
  }, { status: mcpErrorStatus(error, 400), headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: NextRequest) {
  const actor = await requireMcpRequestActor(request);
  if (actor instanceof NextResponse) return actor;
  const limited = rateLimit(request, { limit: 90, windowMs: 60_000, keyPrefix: 'mcp-desktop-oauth-status', verifiedUserId: actor.userId });
  if (!limited.ok) return limited.response;
  try {
    const state = request.nextUrl.searchParams.get('state') || '';
    const data = await getMcpDesktopOAuthStatus(state, actor.userId);
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  const actor = await requireMcpRequestActor(request);
  if (actor instanceof NextResponse) return actor;
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'mcp-desktop-oauth-action', verifiedUserId: actor.userId });
  if (!limited.ok) return limited.response;
  try {
    const payload = await request.json().catch(() => null) as { state?: unknown; action?: unknown } | null;
    if (!payload || typeof payload.state !== 'string' || typeof payload.action !== 'string' || !['finalize', 'cancel'].includes(payload.action)) {
      return NextResponse.json({ success: false, error: 'A desktop sign-in state and action are required.' }, { status: 400 });
    }
    const data = payload.action === 'cancel'
      ? await cancelMcpDesktopOAuth(payload.state, actor.userId)
      : await finalizeMcpDesktopOAuth(payload.state, actor.userId);
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}

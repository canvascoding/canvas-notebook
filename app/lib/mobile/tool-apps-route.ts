import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { AutomationMutationError } from '@/app/lib/automations/mutation-errors';
import { McpAccessError } from '@/app/lib/mcp/access';
import { isMcpAppsEnabled } from '@/app/lib/mcp/apps-config';
import { requireMcpAppChatAccess, type McpAppChat } from '@/app/lib/mcp/apps-host';
import { MobileChatError, requireMobileChatSession } from './chat';
import { MobileFileReviewError, mobileFileReviewWorkspaceId, readMobileFileReviewJson } from './file-review-route';

export const MOBILE_TOOL_APPS_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Vary: 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

export async function requireMobileToolAppChat(request: NextRequest, sessionId: string): Promise<{ chat: McpAppChat; workspaceId: string; authSession: { id: string; expiresAt: Date } }> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new McpAccessError('Sign in to use cards.', 401, 'UNAUTHORIZED');
  if (!isMcpAppsEnabled()) throw new McpAccessError('Cards are disabled.', 404, 'TOOL_APPS_DISABLED');
  const workspaceId = mobileFileReviewWorkspaceId(request);
  const owned = await requireMobileChatSession({ userId: session.user.id, workspaceId, sessionId });
  const chat = { userId: session.user.id, sessionId, agentId: owned.session.agentId };
  if (await requireMcpAppChatAccess(chat) !== workspaceId) {
    throw new McpAccessError('The chat does not belong to the active workspace.', 403, 'WORKSPACE_MISMATCH');
  }
  return { chat, workspaceId, authSession: session.session };
}

export function readMobileToolAppJson(request: NextRequest, maxBytes = 65536): Promise<Record<string, unknown>> {
  return readMobileFileReviewJson(request, maxBytes);
}

export function mobileToolAppErrorResponse(error: unknown): NextResponse {
  if (error instanceof McpAccessError || error instanceof MobileChatError
    || error instanceof MobileFileReviewError || error instanceof AutomationMutationError) {
    return NextResponse.json({ success: false, contractVersion: 1, code: error.code, error: error.message },
      { status: error.status, headers: MOBILE_TOOL_APPS_HEADERS });
  }
  console.error('[Mobile] Builtin card request failed:', error);
  return NextResponse.json({ success: false, contractVersion: 1, code: 'INTERNAL_ERROR', error: 'Cards are unavailable.' },
    { status: 500, headers: MOBILE_TOOL_APPS_HEADERS });
}

import { NextRequest, NextResponse } from 'next/server';

import { closeMcpServer } from '@/app/lib/mcp/manager';
import { mcpErrorStatus } from '@/app/lib/mcp/access';
import { completeMcpOAuthCallback, rejectMcpOAuthCallback } from '@/app/lib/mcp/oauth';
import { requireMcpRequestActor } from '@/app/lib/mcp/request-access';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlResponse(title: string, message: string, status = 200) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head><body><h1>${safeTitle}</h1><p>${safeMessage}</p></body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  );
}

export async function GET(request: NextRequest) {
  const actor = await requireMcpRequestActor(request);
  if (actor instanceof NextResponse) return htmlResponse('MCP OAuth failed', 'You must remain signed in with an active membership to complete MCP authorization.', actor.status);
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const error = request.nextUrl.searchParams.get('error');
  const responseIssuer = request.nextUrl.searchParams.get('iss');

  if (error) {
    if (!state) {
      return htmlResponse('MCP OAuth failed', 'Missing OAuth state.', 400);
    }
    try {
      await rejectMcpOAuthCallback(state, responseIssuer, { userId: actor.userId });
      return htmlResponse('MCP OAuth failed', `Provider returned: ${error}`, 400);
    } catch (callbackError) {
      const message = callbackError instanceof Error ? callbackError.message : 'OAuth callback failed.';
      return htmlResponse('MCP OAuth failed', message, mcpErrorStatus(callbackError, 400));
    }
  }
  if (!code || !state) {
    return htmlResponse('MCP OAuth failed', 'Missing authorization code or state.', 400);
  }

  try {
    const token = await completeMcpOAuthCallback(code, state, responseIssuer, { userId: actor.userId });
    await closeMcpServer(token.connectionId || token.serverName, { userId: actor.userId });
    return htmlResponse('MCP OAuth complete', `Authorization saved for ${token.serverName}. You can close this window.`);
  } catch (callbackError) {
    const message = callbackError instanceof Error ? callbackError.message : 'OAuth callback failed.';
    return htmlResponse('MCP OAuth failed', message, mcpErrorStatus(callbackError, 400));
  }
}

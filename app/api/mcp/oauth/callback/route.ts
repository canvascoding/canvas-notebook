import { NextRequest, NextResponse } from 'next/server';

import { completeMcpOAuthCallback } from '@/app/lib/mcp/oauth';

function htmlResponse(title: string, message: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`,
    {
      status,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    },
  );
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const error = request.nextUrl.searchParams.get('error');

  if (error) {
    return htmlResponse('MCP OAuth failed', `Provider returned: ${error}`, 400);
  }
  if (!code || !state) {
    return htmlResponse('MCP OAuth failed', 'Missing authorization code or state.', 400);
  }

  try {
    const token = await completeMcpOAuthCallback(code, state);
    return htmlResponse('MCP OAuth complete', `Authorization saved for ${token.serverName}. You can close this window.`);
  } catch (callbackError) {
    const message = callbackError instanceof Error ? callbackError.message : 'OAuth callback failed.';
    return htmlResponse('MCP OAuth failed', message, 400);
  }
}

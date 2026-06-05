import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { startMcpOAuth } from '@/app/lib/mcp/oauth';
import { rateLimit } from '@/app/lib/utils/rate-limit';

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
      },
    },
  );
}

function getRequestOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const proto = (forwardedProto || request.nextUrl.protocol.replace(/:$/u, '') || 'http').split(',')[0];
  const host = forwardedHost || request.headers.get('host');
  if (host) return `${proto}://${host.split(',')[0]}`;
  return request.nextUrl.origin;
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return htmlResponse('MCP OAuth failed', 'You must be signed in to authorize this MCP server.', 401);
  }

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'mcp-oauth-start',
  });
  if (!limited.ok) return limited.response;

  const server = request.nextUrl.searchParams.get('server')?.trim();
  if (!server) {
    return htmlResponse('MCP OAuth failed', 'MCP server is required.', 400);
  }

  try {
    const started = await startMcpOAuth(server, getRequestOrigin(request));
    return NextResponse.redirect(started.authorizationUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start MCP OAuth.';
    return htmlResponse('MCP OAuth failed', message, 400);
  }
}

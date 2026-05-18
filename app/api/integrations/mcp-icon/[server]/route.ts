import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { readMcpServerIconFile } from '@/app/lib/mcp/icons';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ server: string }> },
) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const limited = rateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: 'integrations-mcp-icon',
  });
  if (!limited.ok) return limited.response;

  const { server } = await context.params;
  const serverName = decodeURIComponent(server || '').trim();
  if (!serverName) {
    return NextResponse.json({ success: false, error: 'MCP server is required' }, { status: 400 });
  }

  const icon = await readMcpServerIconFile(serverName);
  if (!icon) {
    return NextResponse.json({ success: false, error: 'MCP icon not found' }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(icon.buffer), {
    headers: {
      'Content-Type': icon.contentType,
      'Cache-Control': 'private, max-age=86400',
    },
  });
}

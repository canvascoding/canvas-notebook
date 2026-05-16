import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { buildDirectMcpTools } from '@/app/lib/mcp/direct-tools';
import { getMcpRuntimeStatus } from '@/app/lib/mcp/manager';
import { getMcpOAuthStatus } from '@/app/lib/mcp/oauth';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  try {
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'integrations-mcp-status',
    });
    if (!limited.ok) return limited.response;

    const runtime = await getMcpRuntimeStatus();
    const oauth = await Promise.all(runtime.servers.map((server) => getMcpOAuthStatus(server.name)));
    const direct = await buildDirectMcpTools();
    return NextResponse.json({
      success: true,
      data: {
        ...runtime,
        oauth,
        directTools: direct.tools.map((tool) => ({
          name: tool.name,
          label: tool.label,
          description: tool.description,
        })),
        warnings: direct.warnings,
      },
    });
  } catch (error) {
    console.error('[API] integrations/mcp-status GET error:', error);
    const message = error instanceof Error ? error.message : 'Failed to read MCP status';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

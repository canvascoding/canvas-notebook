import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  McpConfigValidationError,
  readMcpConfigState,
  writeMcpConfigRaw,
} from '@/app/lib/mcp/config';
import { rateLimit } from '@/app/lib/utils/rate-limit';

interface PutPayload {
  rawContent?: string;
}

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const unauthorized = await requireSession(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'integrations-mcp-config-get',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const state = await readMcpConfigState();
    return NextResponse.json({ success: true, data: state });
  } catch (error) {
    console.error('[API] integrations/mcp-config GET error:', error);
    const message = error instanceof Error ? error.message : 'Failed to read MCP config file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const unauthorized = await requireSession(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const limited = rateLimit(request, {
      limit: 30,
      windowMs: 60_000,
      keyPrefix: 'integrations-mcp-config-put',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const payload = (await request.json()) as PutPayload;
    const state = await writeMcpConfigRaw(payload.rawContent ?? '');
    return NextResponse.json({ success: true, data: state });
  } catch (error) {
    if (error instanceof McpConfigValidationError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    console.error('[API] integrations/mcp-config PUT error:', error);
    const message = error instanceof Error ? error.message : 'Failed to update MCP config file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

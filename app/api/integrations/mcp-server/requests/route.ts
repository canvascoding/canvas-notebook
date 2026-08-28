import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import {
  DIRECT_MCP_REQUEST_HISTORY_MAX_ENTRIES,
  DIRECT_MCP_REQUEST_HISTORY_RETENTION_HOURS,
  listRecentDirectMcpRequestHistory,
} from '@/app/lib/mcp/server/request-history';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'integrations-mcp-server-requests',
  });
  if (!limited.ok) return limited.response;

  try {
    const entries = await listRecentDirectMcpRequestHistory();
    return NextResponse.json({
      success: true,
      data: {
        retentionHours: DIRECT_MCP_REQUEST_HISTORY_RETENTION_HOURS,
        maxEntries: DIRECT_MCP_REQUEST_HISTORY_MAX_ENTRIES,
        entries: entries.map((entry) => ({
          requestId: entry.requestId,
          serverVersion: entry.serverVersion,
          phase: entry.phase,
          httpMethod: entry.httpMethod,
          operation: entry.operation,
          toolName: entry.toolName,
          outcome: entry.outcome,
          statusCode: entry.statusCode,
          code: entry.code,
          durationMs: entry.durationMs,
          createdAt: entry.createdAt.toISOString(),
        })),
      },
    }, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Direct MCP request history is unavailable.' },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}

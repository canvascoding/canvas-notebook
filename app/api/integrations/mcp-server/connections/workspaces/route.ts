import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import { resolveOwnedDirectMcpConnectionClientId } from '@/app/lib/mcp/server/connection-management';
import {
  listDirectMcpAllowedWorkspaceIds,
  listDirectMcpSelectableWorkspaces,
  replaceDirectMcpAllowedWorkspaces,
} from '@/app/lib/mcp/server/workspace-access-policy';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'cache-control': 'no-store' };
const MAX_CONNECTION_REFERENCE_LENGTH = 2048;
const MAX_ALLOWED_WORKSPACES = 200;
const MAX_WORKSPACE_ID_LENGTH = 200;

function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { success: false, code: 'MCP_WORKSPACE_ACCESS_UNAVAILABLE', error: 'MCP workspace access is temporarily unavailable.' },
    { status: 503, headers: NO_STORE_HEADERS },
  );
}

async function requireUser(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401, headers: NO_STORE_HEADERS },
      ),
    };
  }
  return { ok: true as const, userId: session.user.id };
}

async function resolveConnection(userId: string, connectionId: string) {
  if (!connectionId || connectionId.length > MAX_CONNECTION_REFERENCE_LENGTH) return null;
  return resolveOwnedDirectMcpConnectionClientId(userId, connectionId);
}

function parseWorkspaceIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ALLOWED_WORKSPACES) return null;
  const workspaceIds = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const workspaceId = item.trim();
    if (!workspaceId || workspaceId.length > MAX_WORKSPACE_ID_LENGTH) return null;
    workspaceIds.add(workspaceId);
  }
  return [...workspaceIds];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await requireUser(request);
  if (!user.ok) return user.response;

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'integrations-mcp-server-workspace-access-list',
  });
  if (!limited.ok) return limited.response;

  const connectionId = request.nextUrl.searchParams.get('connection_id') || '';
  try {
    const clientId = await resolveConnection(user.userId, connectionId);
    if (!clientId) {
      return NextResponse.json(
        { success: false, error: 'MCP connection not found.' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    const [workspaces, allowedWorkspaceIds] = await Promise.all([
      listDirectMcpSelectableWorkspaces(user.userId),
      listDirectMcpAllowedWorkspaceIds({ clientId, userId: user.userId }),
    ]);
    const currentWorkspaceIds = new Set(workspaces.map((workspace) => workspace.workspaceId));
    return NextResponse.json({
      success: true,
      data: {
        connectionId,
        workspaces,
        allowedWorkspaceIds: [...allowedWorkspaceIds].filter((workspaceId) => currentWorkspaceIds.has(workspaceId)),
      },
    }, { headers: NO_STORE_HEADERS });
  } catch {
    return unavailableResponse();
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const user = await requireUser(request);
  if (!user.ok) return user.response;

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'integrations-mcp-server-workspace-access-update',
  });
  if (!limited.ok) return limited.response;

  let connectionId = '';
  let workspaceIds: string[] | null = null;
  try {
    const payload = await request.json() as { connectionId?: unknown; workspaceIds?: unknown };
    connectionId = typeof payload.connectionId === 'string' ? payload.connectionId : '';
    workspaceIds = parseWorkspaceIds(payload.workspaceIds);
  } catch {
    // A malformed request is a validation error, not a service outage.
  }
  if (!connectionId || connectionId.length > MAX_CONNECTION_REFERENCE_LENGTH || !workspaceIds) {
    return NextResponse.json(
      { success: false, error: 'A valid MCP connection and workspace selection are required.' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const clientId = await resolveConnection(user.userId, connectionId);
    if (!clientId) {
      return NextResponse.json(
        { success: false, error: 'MCP connection not found.' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    const result = await replaceDirectMcpAllowedWorkspaces({
      clientId,
      userId: user.userId,
      workspaceIds,
    });
    if (result.status === 'invalid_workspace') {
      return NextResponse.json(
        { success: false, error: 'One or more selected workspaces are no longer available to you.' },
        { status: 422, headers: NO_STORE_HEADERS },
      );
    }

    await recordAuditEvent({
      userId: user.userId,
      source: 'direct_mcp',
      eventType: 'workspace_access',
      entityType: 'mcp_connection',
      entityId: 'direct',
      action: 'direct_mcp.connection.workspace_access.update',
      status: 'success',
      summary: 'Direct MCP workspace access updated by the signed-in user.',
      metadata: { allowedWorkspaceCount: result.allowedWorkspaceCount },
    });
    return NextResponse.json({
      success: true,
      data: { allowedWorkspaceCount: result.allowedWorkspaceCount },
    }, { headers: NO_STORE_HEADERS });
  } catch {
    return unavailableResponse();
  }
}

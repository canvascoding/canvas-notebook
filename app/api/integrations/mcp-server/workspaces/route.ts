import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import {
  listDirectMcpWorkspaceConfigurations,
  setDirectMcpWorkspaceEnabled,
} from '@/app/lib/mcp/server/workspace-access-policy';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'cache-control': 'no-store' };
const MAX_WORKSPACE_ID_LENGTH = 200;

function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { success: false, code: 'MCP_WORKSPACE_SETTINGS_UNAVAILABLE', error: 'MCP workspace settings are temporarily unavailable.' },
    { status: 503, headers: NO_STORE_HEADERS },
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'integrations-mcp-server-workspace-settings-list',
  });
  if (!limited.ok) return limited.response;

  const rawWorkspaceId = request.nextUrl.searchParams.get('workspace_id');
  const workspaceId = rawWorkspaceId === null ? null : rawWorkspaceId.trim();
  if (workspaceId !== null && (!workspaceId || workspaceId.length > MAX_WORKSPACE_ID_LENGTH)) {
    return NextResponse.json(
      { success: false, error: 'A valid workspace is required.' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const workspaces = await listDirectMcpWorkspaceConfigurations(session.user.id);
    if (workspaceId === null) {
      return NextResponse.json({ success: true, data: { workspaces } }, { headers: NO_STORE_HEADERS });
    }
    const workspace = workspaces.find((candidate) => candidate.workspaceId === workspaceId);
    if (!workspace) {
      return NextResponse.json(
        { success: false, error: 'Workspace not found.' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json({ success: true, data: { workspace } }, { headers: NO_STORE_HEADERS });
  } catch {
    return unavailableResponse();
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'integrations-mcp-server-workspace-settings-update',
  });
  if (!limited.ok) return limited.response;

  let workspaceId = '';
  let enabled: boolean | null = null;
  try {
    const payload = await request.json() as { workspaceId?: unknown; enabled?: unknown };
    workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId.trim() : '';
    enabled = typeof payload.enabled === 'boolean' ? payload.enabled : null;
  } catch {
    // A malformed request is a validation error, not a service outage.
  }
  if (!workspaceId || workspaceId.length > MAX_WORKSPACE_ID_LENGTH || enabled === null) {
    return NextResponse.json(
      { success: false, error: 'A workspace and enabled value are required.' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const result = await setDirectMcpWorkspaceEnabled({
      userId: session.user.id,
      workspaceId,
      enabled,
    });
    if (result.status === 'not_found') {
      return NextResponse.json(
        { success: false, error: 'Workspace not found.' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    if (result.status === 'forbidden') {
      return NextResponse.json(
        { success: false, error: 'You do not have permission to configure MCP access for this workspace.' },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }

    await recordAuditEvent({
      workspaceId,
      userId: session.user.id,
      source: 'direct_mcp',
      eventType: 'workspace_access',
      entityType: 'workspace',
      entityId: workspaceId,
      action: 'direct_mcp.workspace_access.update',
      status: 'success',
      summary: 'Direct MCP workspace access updated by a workspace manager.',
      metadata: { enabled: result.enabled },
    });
    return NextResponse.json({
      success: true,
      data: { enabled: result.enabled },
    }, { headers: NO_STORE_HEADERS });
  } catch {
    return unavailableResponse();
  }
}

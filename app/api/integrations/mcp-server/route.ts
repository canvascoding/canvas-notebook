import { NextRequest, NextResponse } from 'next/server';

import { isAdminUser } from '@/app/lib/admin-auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import { getDirectMcpServerSettingsStatus } from '@/app/lib/mcp/server/settings-status';
import { setDirectMcpServerPreferences } from '@/app/lib/server-settings';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    return NextResponse.json({
      success: true,
      data: await getDirectMcpServerSettingsStatus(),
    });
  } catch (error) {
    console.error('[MCP Server Settings] GET failed:', error);
    return NextResponse.json(
      { success: false, error: errorMessage(error, 'Failed to read MCP server settings.') },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isAdminUser(session.user)) {
    return NextResponse.json({ success: false, error: 'Forbidden: admin only' }, { status: 403 });
  }

  try {
    const payload = await request.json().catch(() => null) as {
      enabled?: unknown;
      tools?: unknown;
    } | null;
    if (!payload || typeof payload.enabled !== 'boolean' || !Array.isArray(payload.tools)) {
      return NextResponse.json(
        { success: false, error: 'Expected enabled and tools settings.' },
        { status: 400 },
      );
    }

    const current = await getDirectMcpServerSettingsStatus();
    if (
      current.activationManagedByEnvironment
      && payload.enabled !== current.runtimeEnabled
    ) {
      return NextResponse.json(
        {
          success: false,
          code: 'ACTIVATION_MANAGED_BY_ENVIRONMENT',
          error: 'MCP server activation is managed by the deployment environment.',
        },
        { status: 409 },
      );
    }
    const requestedTools = [...new Set(payload.tools.filter(
      (tool): tool is string => typeof tool === 'string',
    ))].sort();
    const runtimeTools = current.capabilities
      .filter((capability) => capability.available && capability.enabled)
      .map((capability) => capability.id)
      .sort();
    if (
      current.capabilitiesManagedByEnvironment
      && (requestedTools.length !== runtimeTools.length
        || requestedTools.some((tool, index) => tool !== runtimeTools[index]))
    ) {
      return NextResponse.json(
        {
          success: false,
          code: 'CAPABILITIES_MANAGED_BY_ENVIRONMENT',
          error: 'MCP server capabilities are managed by the deployment environment.',
        },
        { status: 409 },
      );
    }

    await setDirectMcpServerPreferences(session.user.id, {
      enabled: payload.enabled,
      tools: payload.tools,
    });
    const status = await getDirectMcpServerSettingsStatus();
    await recordAuditEvent({
      userId: session.user.id,
      source: 'settings',
      eventType: 'admin',
      entityType: 'mcp_server',
      entityId: 'direct',
      action: 'mcp_server.settings.update',
      status: 'success',
      summary: 'Direct MCP server settings updated.',
      metadata: {
        enabled: status.desiredEnabled,
        enabledTools: status.capabilities
          .filter((capability) => capability.available && capability.enabled)
          .map((capability) => capability.id),
        restartRequired: status.restartRequired,
      },
    });

    return NextResponse.json({ success: true, data: status });
  } catch (error) {
    console.error('[MCP Server Settings] PATCH failed:', error);
    await recordAuditEvent({
      userId: session.user.id,
      source: 'settings',
      eventType: 'admin',
      entityType: 'mcp_server',
      entityId: 'direct',
      action: 'mcp_server.settings.update',
      status: 'error',
      summary: 'Direct MCP server settings update failed.',
      metadata: { error: errorMessage(error, 'Unknown error') },
    });
    return NextResponse.json(
      { success: false, error: errorMessage(error, 'Failed to update MCP server settings.') },
      { status: 400 },
    );
  }
}

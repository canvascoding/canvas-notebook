import { NextRequest, NextResponse } from 'next/server';

import {
  getGatewayStatus,
  refreshGatewayToolkit,
} from '@/app/lib/composio/composio-gateway';
import { readComposioOAuthFlowState } from '@/app/lib/composio/composio-oauth-state';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ flowId: string }> },
) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  const { flowId: rawFlowId } = await context.params;
  const flowId = decodeURIComponent(rawFlowId).trim();
  const flow = await readComposioOAuthFlowState({
    state: flowId,
    userId: contextResult.session.user.id,
  });
  if (
    !flow
    || flow.workspaceId !== contextResult.composioContext.workspaceId
    || flow.profileId !== contextResult.composioContext.profileId
  ) {
    return NextResponse.json({ success: false, error: 'Connection flow not found' }, { status: 404 });
  }

  let connectionStatus = '';
  try {
    const refresh = recordValue(
      await refreshGatewayToolkit(flow.toolkitSlug, contextResult.composioContext),
    );
    connectionStatus = typeof refresh.status === 'string' ? refresh.status.toUpperCase() : '';
    if (!connectionStatus) {
      const status = await getGatewayStatus(contextResult.composioContext);
      connectionStatus = status.connectedAccounts.some(
        (account) => account.toolkit.slug === flow.toolkitSlug,
      ) ? 'ACTIVE' : '';
    }
  } catch {
  }

  const expired = flow.expiresAt.getTime() <= Date.now();
  const failed = ['FAILED', 'EXPIRED', 'INACTIVE', 'REVOKED'].includes(connectionStatus);
  const state = connectionStatus === 'ACTIVE'
    ? 'active'
    : failed
      ? 'failed'
      : expired
        ? 'expired'
        : 'pending';
  return NextResponse.json({
    success: true,
    connection: {
      flowId,
      toolkit: flow.toolkitSlug,
      status: state,
      callbackReceived: Boolean(flow.consumedAt),
      expiresAt: flow.expiresAt.toISOString(),
    },
  }, {
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' },
  });
}

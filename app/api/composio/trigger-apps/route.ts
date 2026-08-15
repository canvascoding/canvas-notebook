import { NextRequest, NextResponse } from 'next/server';
import { getGatewayTriggerApps } from '@/app/lib/composio/composio-gateway';
import { toPublicEffectiveComposioContext } from '@/app/lib/composio/composio-context';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';

export async function GET(request: NextRequest) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    const result = await getGatewayTriggerApps(contextResult.composioContext);
    return NextResponse.json({
      ...result,
      status: {
        ...result.status,
        effectiveProfile: toPublicEffectiveComposioContext(contextResult.composioContext),
      },
      workspace: {
        id: contextResult.workspace.workspaceId,
        name: contextResult.workspace.displayName || null,
      },
    });
  } catch (error) {
    console.error('[Composio Trigger Apps API] Failed to load trigger apps', error);
    return NextResponse.json({
      apps: [],
      totalCount: 0,
      status: { configured: true, apiKeyValid: false, mode: 'disabled', connectedAccounts: [] },
    }, { status: 500 });
  }
}

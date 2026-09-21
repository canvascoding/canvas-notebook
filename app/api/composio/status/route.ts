import { NextRequest, NextResponse } from 'next/server';
import { getComposioGatewayMode, getGatewayStatus } from '@/app/lib/composio/composio-gateway';
import { toPublicEffectiveComposioContext } from '@/app/lib/composio/composio-context';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';

export async function GET(request: NextRequest) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    return NextResponse.json({
      ...await getGatewayStatus(contextResult.composioContext),
      effectiveProfile: toPublicEffectiveComposioContext(contextResult.composioContext),
      workspace: {
        id: contextResult.workspace.workspaceId,
        name: contextResult.workspace.displayName || null,
        type: contextResult.workspace.workspaceType,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const mode = await getComposioGatewayMode(contextResult.composioContext).catch(() => 'disabled' as const);
    return NextResponse.json({ configured: mode !== 'disabled', apiKeyValid: false, apiKeyState: 'unknown', providerHealthy: false, mode, connectedAccounts: [], error: message }, { status: 500 });
  }
}

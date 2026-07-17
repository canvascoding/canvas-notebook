import { NextRequest, NextResponse } from 'next/server';
import { getGatewayStatus } from '@/app/lib/composio/composio-gateway';
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
    return NextResponse.json({ configured: true, apiKeyValid: false, mode: 'disabled', connectedAccounts: [], error: message }, { status: 500 });
  }
}

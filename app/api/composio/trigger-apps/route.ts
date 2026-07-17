import { NextRequest, NextResponse } from 'next/server';
import { getGatewayTriggerApps } from '@/app/lib/composio/composio-gateway';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';

export async function GET(request: NextRequest) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    return NextResponse.json(await getGatewayTriggerApps(contextResult.composioContext));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({
      apps: [],
      totalCount: 0,
      status: { configured: true, apiKeyValid: false, mode: 'disabled', connectedAccounts: [] },
      error: message,
    }, { status: 500 });
  }
}

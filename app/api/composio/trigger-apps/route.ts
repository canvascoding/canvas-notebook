import { NextResponse } from 'next/server';
import { getGatewayTriggerApps } from '@/app/lib/composio/composio-gateway';

export async function GET() {
  try {
    return NextResponse.json(await getGatewayTriggerApps());
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

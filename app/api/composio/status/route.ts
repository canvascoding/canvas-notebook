import { NextResponse } from 'next/server';
import { getGatewayStatus } from '@/app/lib/composio/composio-gateway';

export async function GET() {
  try {
    return NextResponse.json(await getGatewayStatus());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ configured: true, apiKeyValid: false, mode: 'disabled', connectedAccounts: [], error: message }, { status: 500 });
  }
}

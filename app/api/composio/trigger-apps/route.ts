import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getGatewayTriggerApps } from '@/app/lib/composio/composio-gateway';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({
      apps: [],
      totalCount: 0,
      status: { configured: false, apiKeyValid: false, mode: 'disabled', connectedAccounts: [] },
      error: 'Unauthorized',
    }, { status: 401 });
  }

  try {
    return NextResponse.json(await getGatewayTriggerApps({ userId: session.user.id }));
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

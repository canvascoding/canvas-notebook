import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { clearComposioGatewayCaches, disconnectGatewayToolkit, getComposioGatewayMode } from '@/app/lib/composio/composio-gateway';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ toolkit: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const storageScope = { userId: session.user.id };
    if ((await getComposioGatewayMode(storageScope)) === 'disabled') {
      return NextResponse.json({ error: 'Composio not configured' }, { status: 400 });
    }

    const { toolkit } = await params;
    if (!toolkit) {
      return NextResponse.json({ error: 'Toolkit slug is required' }, { status: 400 });
    }

    await disconnectGatewayToolkit(toolkit, storageScope);
    clearComposioGatewayCaches();
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

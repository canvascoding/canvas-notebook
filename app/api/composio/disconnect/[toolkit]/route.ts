import { NextRequest, NextResponse } from 'next/server';
import { clearComposioGatewayCaches, disconnectGatewayToolkit, getComposioGatewayMode } from '@/app/lib/composio/composio-gateway';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ toolkit: string }> },
) {
  try {
    if ((await getComposioGatewayMode()) === 'disabled') {
      return NextResponse.json({ error: 'Composio not configured' }, { status: 400 });
    }

    const { toolkit } = await params;
    if (!toolkit) {
      return NextResponse.json({ error: 'Toolkit slug is required' }, { status: 400 });
    }

    await disconnectGatewayToolkit(toolkit);
    clearComposioGatewayCaches();
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

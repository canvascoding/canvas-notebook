import { NextRequest, NextResponse } from 'next/server';
import { clearComposioGatewayCaches, disconnectGatewayToolkit, getComposioGatewayMode } from '@/app/lib/composio/composio-gateway';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ toolkit: string }> },
) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    const composioContext = contextResult.composioContext;
    if ((await getComposioGatewayMode(composioContext)) === 'disabled') {
      return NextResponse.json({ error: 'Composio not configured' }, { status: 400 });
    }

    const { toolkit } = await params;
    if (!toolkit) {
      return NextResponse.json({ error: 'Toolkit slug is required' }, { status: 400 });
    }

    await disconnectGatewayToolkit(toolkit, composioContext);
    clearComposioGatewayCaches(composioContext);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

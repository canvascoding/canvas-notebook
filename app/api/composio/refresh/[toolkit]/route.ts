import { NextRequest, NextResponse } from 'next/server';
import { clearComposioGatewayCaches, getComposioGatewayMode, refreshGatewayToolkit } from '@/app/lib/composio/composio-gateway';

export async function POST(
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

    const result = await refreshGatewayToolkit(toolkit);
    clearComposioGatewayCaches();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

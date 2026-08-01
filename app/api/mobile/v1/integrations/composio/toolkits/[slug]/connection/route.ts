import { NextRequest, NextResponse } from 'next/server';

import {
  clearComposioGatewayCaches,
  disconnectGatewayToolkit,
} from '@/app/lib/composio/composio-gateway';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    const { slug: rawSlug } = await context.params;
    const slug = decodeURIComponent(rawSlug).trim().toLowerCase();
    await disconnectGatewayToolkit(slug, contextResult.composioContext);
    clearComposioGatewayCaches(contextResult.composioContext);
    return NextResponse.json({ success: true, toolkit: slug }, {
      headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' },
    });
  } catch (error) {
    console.error('[Mobile Composio Disconnect API] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to disconnect app' }, { status: 500 });
  }
}

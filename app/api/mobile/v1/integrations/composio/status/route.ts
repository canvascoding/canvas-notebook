import { NextRequest, NextResponse } from 'next/server';

import { getGatewayStatus } from '@/app/lib/composio/composio-gateway';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';
import { toPublicEffectiveComposioContext } from '@/app/lib/composio/composio-context';
import { serializeMobileComposioStatus } from '@/app/lib/mobile/composio';

export async function GET(request: NextRequest) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    const status = await getGatewayStatus(contextResult.composioContext);
    return NextResponse.json({
      success: true,
      status: serializeMobileComposioStatus(
        status,
        toPublicEffectiveComposioContext(contextResult.composioContext),
      ),
    }, {
      headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' },
    });
  } catch (error) {
    console.error('[Mobile Composio Status API] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load connected apps status' }, { status: 500 });
  }
}

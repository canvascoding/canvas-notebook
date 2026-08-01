import { NextRequest, NextResponse } from 'next/server';

import { getGatewayStatus, getGatewayToolkits } from '@/app/lib/composio/composio-gateway';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';
import {
  connectedComposioStatusBySlug,
  serializeMobileComposioToolkit,
} from '@/app/lib/mobile/composio';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    const { slug: rawSlug } = await context.params;
    const slug = decodeURIComponent(rawSlug).trim().toLowerCase();
    const [status, result] = await Promise.all([
      getGatewayStatus(contextResult.composioContext),
      getGatewayToolkits(contextResult.composioContext),
    ]);
    const connectedBySlug = connectedComposioStatusBySlug(status);
    const toolkit = (Array.isArray(result.toolkits) ? result.toolkits : [])
      .map((entry) => serializeMobileComposioToolkit(entry, connectedBySlug))
      .find((entry) => entry?.slug === slug);
    if (!toolkit) {
      return NextResponse.json({ success: false, error: 'App not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, toolkit }, {
      headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' },
    });
  } catch (error) {
    console.error('[Mobile Composio Toolkit Detail API] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load app details' }, { status: 500 });
  }
}

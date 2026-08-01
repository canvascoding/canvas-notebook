import { NextRequest, NextResponse } from 'next/server';

import { getGatewayToolkitTools } from '@/app/lib/composio/composio-gateway';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';
import { serializeMobileComposioTool } from '@/app/lib/mobile/composio';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    const { slug: rawSlug } = await context.params;
    const slug = decodeURIComponent(rawSlug).trim().toLowerCase();
    const search = (request.nextUrl.searchParams.get('q') || '').trim();
    const result = await getGatewayToolkitTools(slug, search, contextResult.composioContext);
    const tools = (Array.isArray(result.tools) ? result.tools : [])
      .map(serializeMobileComposioTool)
      .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
      .slice(0, 30);
    return NextResponse.json({
      success: true,
      tools,
      totalCount: typeof result.totalCount === 'number' ? result.totalCount : tools.length,
      hasMore: result.hasMore === true || Number(result.totalCount || 0) > tools.length,
    }, {
      headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' },
    });
  } catch (error) {
    console.error('[Mobile Composio Toolkit Tools API] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load app actions' }, { status: 500 });
  }
}

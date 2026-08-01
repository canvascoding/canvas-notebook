import { NextRequest, NextResponse } from 'next/server';

import { getGatewayStatus, getGatewayToolkits } from '@/app/lib/composio/composio-gateway';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';
import {
  connectedComposioStatusBySlug,
  serializeMobileComposioToolkit,
} from '@/app/lib/mobile/composio';

function positiveInteger(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export async function GET(request: NextRequest) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    const [status, result] = await Promise.all([
      getGatewayStatus(contextResult.composioContext),
      getGatewayToolkits(contextResult.composioContext),
    ]);
    const connectedBySlug = connectedComposioStatusBySlug(status);
    const query = (request.nextUrl.searchParams.get('q') || '').trim().toLowerCase();
    const connectedOnly = request.nextUrl.searchParams.get('connectedOnly') === '1';
    const pageSize = positiveInteger(request.nextUrl.searchParams.get('pageSize'), 30, 50);
    const page = positiveInteger(request.nextUrl.searchParams.get('page'), 1, 100_000);
    const toolkits = (Array.isArray(result.toolkits) ? result.toolkits : [])
      .map((toolkit) => serializeMobileComposioToolkit(toolkit, connectedBySlug))
      .filter((toolkit): toolkit is NonNullable<typeof toolkit> => Boolean(toolkit))
      .filter((toolkit) => !connectedOnly || toolkit.connected)
      .filter((toolkit) => !query || [
        toolkit.slug,
        toolkit.name,
        toolkit.description,
        toolkit.category,
      ].join(' ').toLowerCase().includes(query))
      .sort((left, right) => Number(right.connected) - Number(left.connected) || left.name.localeCompare(right.name));
    const totalPages = Math.max(1, Math.ceil(toolkits.length / pageSize));
    const normalizedPage = Math.min(page, totalPages);
    const offset = (normalizedPage - 1) * pageSize;

    return NextResponse.json({
      success: true,
      toolkits: toolkits.slice(offset, offset + pageSize),
      pagination: {
        page: normalizedPage,
        pageSize,
        totalItems: toolkits.length,
        totalPages,
        hasNextPage: normalizedPage < totalPages,
      },
    }, {
      headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' },
    });
  } catch (error) {
    console.error('[Mobile Composio Toolkits API] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load connected apps' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getGatewayToolkitTools } from '@/app/lib/composio/composio-gateway';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const url = new URL(request.url);
    const search = url.searchParams.get('search') || '';
    return NextResponse.json(await getGatewayToolkitTools(slug, search));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ tools: [], totalCount: 0, error: message }, { status: 500 });
  }
}

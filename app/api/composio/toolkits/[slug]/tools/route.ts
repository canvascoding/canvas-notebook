import { NextRequest, NextResponse } from 'next/server';
import { isComposioConfigured, getComposio } from '@/app/lib/composio/composio-client';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const configured = await isComposioConfigured();
    if (!configured) {
      return NextResponse.json({ tools: [], totalCount: 0 });
    }

    const { slug } = await params;
    const composio = await getComposio();
    if (!composio) {
      return NextResponse.json({ tools: [], totalCount: 0 });
    }

    const url = new URL(request.url);
    const search = url.searchParams.get('search') || '';

    const queryParams: Parameters<typeof composio.tools.getRawComposioTools>[0] = {
      toolkits: [slug],
      limit: 500,
      important: false,
    };

    if (search) {
      queryParams.search = search;
    }

    const results = await composio.tools.getRawComposioTools(queryParams);

    const toolList = Array.isArray(results) ? results : [];
    const tools = toolList.map((tool: Record<string, unknown>) => {
      const toolkit = (tool.toolkit ?? {}) as Record<string, unknown>;
      return {
        slug: String(tool.slug ?? tool.name ?? ''),
        name: String(tool.name ?? tool.slug ?? ''),
        description: typeof tool.description === 'string' ? tool.description : '',
        toolkit: String(toolkit.slug ?? tool.toolkitSlug ?? ''),
      };
    });

    return NextResponse.json({
      tools,
      totalCount: tools.length,
      hasMore: toolList.length >= 500,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ tools: [], totalCount: 0, error: message }, { status: 500 });
  }
}
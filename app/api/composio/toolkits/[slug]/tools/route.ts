import { NextRequest, NextResponse } from 'next/server';
import { isComposioConfigured, getComposio } from '@/app/lib/composio/composio-client';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const configured = await isComposioConfigured();
    if (!configured) {
      return NextResponse.json({ tools: [] });
    }

    const { slug } = await params;
    const composio = await getComposio();
    if (!composio) {
      return NextResponse.json({ tools: [] });
    }

    const results = await composio.tools.getRawComposioTools({
      search: '',
      toolkits: [slug],
    } as Parameters<typeof composio.tools.getRawComposioTools>[0]);

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

    return NextResponse.json({ tools });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ tools: [], error: message }, { status: 500 });
  }
}
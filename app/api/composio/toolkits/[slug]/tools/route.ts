import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getGatewayToolkitTools } from '@/app/lib/composio/composio-gateway';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ tools: [], totalCount: 0, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { slug } = await params;
    const url = new URL(request.url);
    const search = url.searchParams.get('search') || '';
    return NextResponse.json(await getGatewayToolkitTools(slug, search, { userId: session.user.id }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ tools: [], totalCount: 0, error: message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { loadAgentConnectionOptions } from '@/app/lib/agents/capability-options';
import { paginateItems, parsePositiveInteger } from '@/app/lib/utils/pagination';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'agents-connection-options',
  });
  if (!limited.ok) return limited.response;

  try {
    const query = request.nextUrl.searchParams.get('query')?.trim().toLowerCase() || '';
    const page = parsePositiveInteger(request.nextUrl.searchParams.get('page'), 1);
    const limit = parsePositiveInteger(request.nextUrl.searchParams.get('limit'), DEFAULT_LIMIT, MAX_LIMIT);
    const options = await loadAgentConnectionOptions({ query });
    const { items, pagination } = paginateItems(options, page, limit);

    return NextResponse.json({
      success: true,
      data: {
        connections: items,
        pagination,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load agent connection options.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { listAgentProfiles } from '@/app/lib/agents/registry';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'agents-list-get',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const agents = await listAgentProfiles();
    return NextResponse.json({ success: true, data: { agents } });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to list agents.' },
      { status: 500 },
    );
  }
}


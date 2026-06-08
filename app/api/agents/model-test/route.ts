import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { testAgentModelConnection } from '@/app/lib/agents/model-test';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'agents-model-test',
  });
  if (!limited.ok) {
    return limited.response;
  }

  const payload = (await request.json().catch(() => ({}))) as { agentId?: unknown };
  const agentId = typeof payload.agentId === 'string' ? payload.agentId : DEFAULT_MANAGED_AGENT_ID;
  const result = await testAgentModelConnection({ agentId });

  return NextResponse.json(result, { status: result.success ? 200 : 400 });
}

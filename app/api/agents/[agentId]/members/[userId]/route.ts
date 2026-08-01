import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { AgentAccessError, removeAgentMemberForManager } from '@/app/lib/agents/access';
import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type RouteContext = {
  params: Promise<{ agentId: string; userId: string }>;
};

export async function DELETE(request: NextRequest, context: RouteContext) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return licenseResponse;

  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'agent-members-delete' });
  if (!limited.ok) return limited.response;

  try {
    const { agentId, userId } = await context.params;
    await removeAgentMemberForManager({ agentId, userId, actorUserId: session.user.id });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof AgentAccessError) {
      return NextResponse.json(
        { success: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to remove agent member.' },
      { status: 500 },
    );
  }
}

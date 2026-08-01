import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  AgentAccessError,
  listAgentMembersForManager,
  upsertAgentMemberForManager,
} from '@/app/lib/agents/access';
import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type RouteContext = {
  params: Promise<{ agentId: string }>;
};

function accessErrorResponse(error: AgentAccessError) {
  return NextResponse.json(
    { success: false, code: error.code, error: error.message },
    { status: error.status },
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return licenseResponse;

  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'agent-members-get' });
  if (!limited.ok) return limited.response;

  try {
    const { agentId } = await context.params;
    const result = await listAgentMembersForManager(agentId, session.user.id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof AgentAccessError) return accessErrorResponse(error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to load agent members.' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return licenseResponse;

  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'agent-members-post' });
  if (!limited.ok) return limited.response;

  try {
    const { agentId } = await context.params;
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    const member = await upsertAgentMemberForManager({
      agentId,
      actorUserId: session.user.id,
      userId: payload.userId,
      canUse: payload.canUse,
      canEdit: payload.canEdit,
      canManage: payload.canManage,
    });
    return NextResponse.json({ success: true, member });
  } catch (error) {
    if (error instanceof AgentAccessError) return accessErrorResponse(error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to update agent member.' },
      { status: 500 },
    );
  }
}

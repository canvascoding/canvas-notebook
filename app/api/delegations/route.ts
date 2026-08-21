import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { listOwnedPiDelegations, piDelegationToolsets } from '@/app/lib/pi/delegation-store';
import { prepareUserDelegation } from '@/app/lib/pi/delegation-actions';
import { enqueueDelegatedTask } from '@/app/lib/pi/delegation-dispatcher';
import { requireDelegationSource } from '@/app/lib/pi/delegation-policy';
import { listManagedAgents } from '@/app/lib/agents/management-actions';
import { DELEGATABLE_PI_TOOLSETS, PI_TOOLSETS } from '@/app/lib/pi/toolsets';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: 'delegations-list-get',
  });
  if (!limited.ok) return limited.response;

  const sourceSessionId = request.nextUrl.searchParams.get('sourceSessionId')?.trim() || undefined;
  if (request.nextUrl.searchParams.get('options') === 'true') {
    if (!sourceSessionId) {
      return NextResponse.json({ success: false, error: 'sourceSessionId is required.' }, { status: 400 });
    }
    try {
      const source = await requireDelegationSource({ userId: session.user.id, sourceSessionId });
      const agents = await listManagedAgents({
        userId: session.user.id,
        sessionId: session.session.id,
        source: 'api',
        organizationId: source.organizationId,
        workspaceId: source.workspaceId,
        projectId: source.projectId,
      });
      return NextResponse.json({
        success: true,
        agents: agents
          .filter((agent) => agent.agentId !== source.sourceAgentId)
          .map((agent) => ({ agentId: agent.agentId, name: agent.name, iconId: agent.iconId })),
        toolsets: [...DELEGATABLE_PI_TOOLSETS].map((name) => ({
          name,
          label: PI_TOOLSETS[name].label,
          description: PI_TOOLSETS[name].description,
        })),
      });
    } catch (error) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Delegation is unavailable.' }, { status: 403 });
    }
  }
  const delegations = await listOwnedPiDelegations({
    userId: session.user.id,
    sourceSessionId,
    limit: 100,
  });

  return NextResponse.json({
    success: true,
    delegations: delegations.map((record) => ({
      id: record.id,
      sourceSessionId: record.sourceSessionId,
      sourceAgentId: record.sourceAgentId,
      workerSessionId: record.workerSessionId,
      targetAgentId: record.targetAgentId,
      workerType: record.workerType,
      goal: record.goal,
      workerRole: record.workerRole,
      toolsets: piDelegationToolsets(record),
      status: record.status,
      resultStatus: record.resultStatus,
      resultText: record.resultText,
      errorText: record.errorText,
      deliveryStatus: record.deliveryStatus,
      deliveryErrorText: record.deliveryErrorText,
      attemptCount: record.attemptCount,
      cancelRequestedAt: record.cancelRequestedAt?.toISOString() ?? null,
      startedAt: record.startedAt?.toISOString() ?? null,
      completedAt: record.completedAt?.toISOString() ?? null,
      deliveredAt: record.deliveredAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    })),
  });
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'delegations-create-post' });
  if (!limited.ok) return limited.response;
  try {
    const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
    const prepared = await prepareUserDelegation({
      userId: session.user.id,
      sourceSessionId: typeof payload?.sourceSessionId === 'string' ? payload.sourceSessionId : '',
      targetAgentId: typeof payload?.targetAgentId === 'string' ? payload.targetAgentId : '',
      goal: payload?.goal,
      context: payload?.context,
      toolsets: payload?.toolsets,
    });
    const delegation = await enqueueDelegatedTask(prepared);
    return NextResponse.json({ success: true, delegation }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Could not start delegation.' }, { status: 400 });
  }
}

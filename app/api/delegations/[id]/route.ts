import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { cancelDelegatedTask } from '@/app/lib/pi/delegation-dispatcher';
import { getOwnedPiDelegation, piDelegationToolsets } from '@/app/lib/pi/delegation-store';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const { id } = await context.params;
  const delegation = await getOwnedPiDelegation(id.trim(), session.user.id);
  if (!delegation) return NextResponse.json({ success: false, error: 'Delegation task not found.' }, { status: 404 });
  return NextResponse.json({
    success: true,
    delegation: {
      id: delegation.id,
      sourceSessionId: delegation.sourceSessionId,
      targetAgentId: delegation.targetAgentId,
      workerType: delegation.workerType,
      workerSessionId: delegation.workerSessionId,
      goal: delegation.goal,
      context: delegation.context,
      toolsets: piDelegationToolsets(delegation),
      status: delegation.status,
      resultText: delegation.resultText,
      errorText: delegation.errorText,
      createdAt: delegation.createdAt.toISOString(),
      startedAt: delegation.startedAt?.toISOString() ?? null,
      completedAt: delegation.completedAt?.toISOString() ?? null,
    },
  });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'delegations-cancel-delete',
  });
  if (!limited.ok) return limited.response;

  const { id } = await context.params;
  const delegationId = id.trim();
  if (!delegationId) {
    return NextResponse.json({ success: false, error: 'Delegation task ID is required.' }, { status: 400 });
  }

  const record = await cancelDelegatedTask(delegationId, session.user.id);
  if (!record) {
    return NextResponse.json({ success: false, error: 'Delegation task not found.' }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    delegation: {
      id: record.id,
      status: record.status,
      cancelRequestedAt: record.cancelRequestedAt?.toISOString() ?? null,
      completedAt: record.completedAt?.toISOString() ?? null,
    },
  });
}

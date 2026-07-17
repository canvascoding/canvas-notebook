import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { listOwnedPiDelegations, piDelegationToolsets } from '@/app/lib/pi/delegation-store';
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

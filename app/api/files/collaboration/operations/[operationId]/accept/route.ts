import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { acceptAgentOperation } from '@/app/lib/collaboration/agent-operations';
import { readCollaborationOperationIdempotencyKey } from '@/app/lib/collaboration/operation-route';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export async function POST(request: NextRequest, context: { params: Promise<{ operationId: string }> }) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'collaboration-operation-accept' });
  if (limited) return limited;
  const body = await readCollaborationOperationIdempotencyKey(request);
  if (body.response) return body.response;
  try {
    const { operationId } = await context.params;
    const operation = await acceptAgentOperation({
      operationId,
      workspace: workspaceResult.workspace,
      userId: workspaceResult.session.user.id,
      idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json({ success: true, operation });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Accept failed.' }, { status: 409 });
  }
}

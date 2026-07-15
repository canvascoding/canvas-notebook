import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import { acceptAgentOperation } from '@/app/lib/collaboration/agent-operations';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export async function POST(request: NextRequest, context: { params: Promise<{ operationId: string }> }) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'collaboration-operation-accept' });
  if (limited) return limited;
  const body = await readJsonBody<{ idempotencyKey?: string }>(request);
  if (!body.idempotencyKey?.trim()) return NextResponse.json({ success: false, error: 'idempotencyKey is required.' }, { status: 400 });
  try {
    const { operationId } = await context.params;
    const operation = await acceptAgentOperation({
      operationId,
      workspace: workspaceResult.workspace,
      userId: workspaceResult.session.user.id,
      idempotencyKey: body.idempotencyKey.trim(),
    });
    return NextResponse.json({ success: true, operation });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Accept failed.' }, { status: 409 });
  }
}

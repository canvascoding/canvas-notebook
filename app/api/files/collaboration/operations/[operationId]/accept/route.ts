import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { acceptAgentOperation, AgentProposalChangedError } from '@/app/lib/collaboration/agent-operations';
import { readCollaborationOperationApproval } from '@/app/lib/collaboration/operation-route';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export async function POST(request: NextRequest, context: { params: Promise<{ operationId: string }> }) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'collaboration-operation-accept' });
  if (limited) return limited;
  const body = await readCollaborationOperationApproval(request);
  if (body.response) return body.response;
  try {
    const { operationId } = await context.params;
    const operation = await acceptAgentOperation({
      operationId,
      workspace: workspaceResult.workspace,
      userId: workspaceResult.session.user.id,
      idempotencyKey: body.idempotencyKey,
      proposalVersion: body.proposalVersion,
    });
    return NextResponse.json({ success: true, operation });
  } catch (error) {
    if (error instanceof AgentProposalChangedError) {
      return NextResponse.json({ success: false, code: error.code,
        error: 'This proposal has changed or can no longer be applied. Reload the current proposal before approving.' }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Accept failed.' }, { status: 409 });
  }
}

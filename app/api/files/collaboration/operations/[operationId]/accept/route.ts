import { NextRequest, NextResponse } from 'next/server';

import { acceptAgentOperation, AgentProposalChangedError } from '@/app/lib/collaboration/agent-operations';
import { readCollaborationOperationApproval } from '@/app/lib/collaboration/operation-route';
import { observeFileVersionCenter } from '@/app/lib/file-version-center/observability';
import { FILE_VERSION_CENTER_RATE_LIMITS_V1 } from '@/app/lib/file-version-center/policy-v1';
import { withFileVersionCenterPrivateHeaders } from '@/app/lib/file-version-center/route-adapter';
import { dualRateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export async function POST(request: NextRequest, context: { params: Promise<{ operationId: string }> }) {
  const startedAt = Date.now();
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) {
    observeFileVersionCenter({ operation: 'accept', outcome: 'denied', startedAt });
    return withFileVersionCenterPrivateHeaders(workspaceResult.response);
  }
  const limited = dualRateLimit(request, {
    perUserLimit: FILE_VERSION_CENTER_RATE_LIMITS_V1.reviewMutation.perUserPerMinute,
    perIpLimit: FILE_VERSION_CENTER_RATE_LIMITS_V1.reviewMutation.perIpPerMinute,
    windowMs: 60_000,
    keyPrefix: 'file-version-center:accept',
    verifiedUserId: workspaceResult.session.user.id,
  });
  if (!limited.ok) {
    observeFileVersionCenter({ operation: 'accept', outcome: 'rate_limited', startedAt });
    return withFileVersionCenterPrivateHeaders(limited.response);
  }
  const body = await readCollaborationOperationApproval(request);
  if (body.response) {
    observeFileVersionCenter({ operation: 'accept', outcome: 'invalid', startedAt });
    return withFileVersionCenterPrivateHeaders(body.response);
  }
  try {
    const { operationId } = await context.params;
    const reauthorization = await requireRequestWorkspace(request, {
      workspaceId: workspaceResult.workspace.workspaceId,
      permissions: 'canWrite',
    });
    if (reauthorization.response) {
      observeFileVersionCenter({ operation: 'accept', outcome: 'denied', startedAt });
      return withFileVersionCenterPrivateHeaders(reauthorization.response);
    }
    const operation = await acceptAgentOperation({
      operationId,
      workspace: reauthorization.workspace,
      userId: reauthorization.session.user.id,
      idempotencyKey: body.idempotencyKey,
      proposalVersion: body.proposalVersion,
    });
    observeFileVersionCenter({ operation: 'accept', outcome: 'success', startedAt });
    return withFileVersionCenterPrivateHeaders(NextResponse.json({ success: true, operation }));
  } catch (error) {
    if (error instanceof AgentProposalChangedError) {
      observeFileVersionCenter({ operation: 'accept', outcome: 'conflict', startedAt });
      return withFileVersionCenterPrivateHeaders(NextResponse.json({ success: false, code: error.code,
        error: 'This proposal has changed or can no longer be applied. Reload the current proposal before approving.' }, { status: 409 }));
    }
    observeFileVersionCenter({ operation: 'accept', outcome: 'failure', startedAt });
    return withFileVersionCenterPrivateHeaders(NextResponse.json({
      success: false,
      error: 'The agent proposal could not be accepted.',
    }, { status: 409 }));
  }
}

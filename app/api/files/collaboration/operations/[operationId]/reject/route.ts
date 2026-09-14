import { NextRequest, NextResponse } from 'next/server';

import { rejectAgentOperation } from '@/app/lib/collaboration/agent-operations';
import { readCollaborationOperationIdempotencyKey } from '@/app/lib/collaboration/operation-route';
import { observeFileVersionCenter } from '@/app/lib/file-version-center/observability';
import { FILE_VERSION_CENTER_RATE_LIMITS_V1 } from '@/app/lib/file-version-center/policy-v1';
import { withFileVersionCenterPrivateHeaders } from '@/app/lib/file-version-center/route-adapter';
import { dualRateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export async function POST(request: NextRequest, context: { params: Promise<{ operationId: string }> }) {
  const startedAt = Date.now();
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) {
    observeFileVersionCenter({ operation: 'reject', outcome: 'denied', startedAt });
    return withFileVersionCenterPrivateHeaders(workspaceResult.response);
  }
  const limited = dualRateLimit(request, {
    perUserLimit: FILE_VERSION_CENTER_RATE_LIMITS_V1.reviewMutation.perUserPerMinute,
    perIpLimit: FILE_VERSION_CENTER_RATE_LIMITS_V1.reviewMutation.perIpPerMinute,
    windowMs: 60_000,
    keyPrefix: 'file-version-center:reject',
    verifiedUserId: workspaceResult.session.user.id,
  });
  if (!limited.ok) {
    observeFileVersionCenter({ operation: 'reject', outcome: 'rate_limited', startedAt });
    return withFileVersionCenterPrivateHeaders(limited.response);
  }
  const body = await readCollaborationOperationIdempotencyKey(request);
  if (body.response) {
    observeFileVersionCenter({ operation: 'reject', outcome: 'invalid', startedAt });
    return withFileVersionCenterPrivateHeaders(body.response);
  }
  try {
    const { operationId } = await context.params;
    const reauthorization = await requireRequestWorkspace(request, {
      workspaceId: workspaceResult.workspace.workspaceId,
      permissions: 'canWrite',
    });
    if (reauthorization.response) {
      observeFileVersionCenter({ operation: 'reject', outcome: 'denied', startedAt });
      return withFileVersionCenterPrivateHeaders(reauthorization.response);
    }
    const operation = await rejectAgentOperation({
      operationId,
      workspace: reauthorization.workspace,
      userId: reauthorization.session.user.id,
      idempotencyKey: body.idempotencyKey,
    });
    observeFileVersionCenter({ operation: 'reject', outcome: 'success', startedAt });
    return withFileVersionCenterPrivateHeaders(NextResponse.json({ success: true, operation }));
  } catch {
    observeFileVersionCenter({ operation: 'reject', outcome: 'failure', startedAt });
    return withFileVersionCenterPrivateHeaders(NextResponse.json({
      success: false,
      error: 'The agent proposal could not be rejected.',
    }, { status: 409 }));
  }
}

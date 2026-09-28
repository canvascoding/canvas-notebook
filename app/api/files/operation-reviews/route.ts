import { NextRequest } from 'next/server';

import { applyRateLimit, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { listWorkspaceOperationReviews } from '@/app/lib/files/workspace-operation-review-service';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export async function GET(request: NextRequest) {
  const authorized = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (authorized.response) return authorized.response;
  const limited = applyRateLimit(request, { limit: 60, windowMs: 60_000,
    keyPrefix: 'workspace-operation-reviews-list' });
  if (limited) return limited;
  try {
    const reviews = await listWorkspaceOperationReviews(authorized.workspace.workspaceId);
    return jsonSuccess({ reviews }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonServerError('[API] Workspace operation reviews list error:', error,
      'Could not read file operation reviews');
  }
}

import { NextRequest } from 'next/server';
import { auth } from '@/app/lib/auth';
import { applyRateLimit, jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { requireSessionWorkspace } from '@/app/lib/workspaces/request';
import { createWorkspacePathOperationProblemStore } from '@/app/lib/files/workspace-path-operation-problems';

type RouteContext = { params: Promise<{ problemId: string }> };

/** Problem details belong to their currently readable workspace, independently of the Review Center experiment. */
export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const noStore = (response: Response) => { response.headers.set('Cache-Control', 'no-store'); return response; };
  const limited = applyRateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'workspace-path-operation-problem' });
  if (limited) return noStore(limited);
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return noStore(jsonError('Unauthorized', 401));
    const problem = await createWorkspacePathOperationProblemStore().get((await context.params).problemId);
    if (!problem) return noStore(jsonError('File action problem not found', 404));
    const authorized = await requireSessionWorkspace(session, { workspaceId: problem.workspaceId, permissions: 'canRead' });
    if (authorized.response) return noStore(authorized.response);
    if (authorized.workspace.workspaceId !== problem.workspaceId || authorized.workspace.status !== 'active'
      || !authorized.workspace.permissions.canRead) return noStore(jsonError('Forbidden', 403));
    return noStore(jsonSuccess({ problem: { problemId: problem.problemId, workspaceId: problem.workspaceId,
      kind: problem.kind, selections: problem.selections, errorCode: problem.errorCode,
      createdAt: problem.createdAt, updatedAt: problem.updatedAt } }));
  } catch (error) {
    return noStore(jsonServerError('[API] File action problem read failed:', error, 'Could not read file action problem'));
  }
}

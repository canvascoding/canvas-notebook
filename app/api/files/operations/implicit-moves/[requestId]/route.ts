import { NextRequest } from 'next/server';
import { jsonError, jsonServerError } from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import { readWorkspaceImplicitMoveOperation, resumeWorkspaceImplicitMoveOperation } from '@/app/lib/files/workspace-implicit-move-operation';
import { workspaceImplicitMoveResponse } from '@/app/lib/files/workspace-implicit-move-response';

type RouteContext = { params: Promise<{ requestId: string }> };

async function execute(request: NextRequest, context: RouteContext, resume: boolean): Promise<Response> {
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const current = await requireRequestWorkspace(original, { permissions: ['canRead','canWrite','canDelete'] });
  if (current.response) return current.response;
  const { requestId } = await context.params;
  try {
    const lookup = { workspaceId: current.workspace.workspaceId, requestId };
    // GET is strictly SQL-only. POST resumes the same immutable saved selection;
    // request body coordinates cannot replace its original paths or operation ID.
    return await workspaceImplicitMoveResponse(resume ? await resumeWorkspaceImplicitMoveOperation(original, lookup)
      : await readWorkspaceImplicitMoveOperation(original, lookup), !resume);
  } catch (error) {
    const failure = error as { code?: string; status?: number; operationId?: string; requestId?: string };
    if (failure?.status && [400,401,403,409,413,422,503].includes(failure.status)) {
      return jsonError('The original file preparation could not be confirmed.', failure.status, {
        code: failure.code ?? 'IMPLICIT_MOVE_UNAVAILABLE',
        ...(failure.operationId ? { operationId: failure.operationId } : {}),
        requestId: failure.requestId ?? requestId });
    }
    return jsonServerError('[API] Implicit Move preparation status:', error, 'File preparation could not be confirmed.');
  }
}
export function GET(request: NextRequest, context: RouteContext): Promise<Response> { return execute(request, context, false); }
export function POST(request: NextRequest, context: RouteContext): Promise<Response> { return execute(request, context, true); }

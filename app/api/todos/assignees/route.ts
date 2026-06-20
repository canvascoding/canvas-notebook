import { and, asc, eq, ne } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/app/lib/db';
import { organizationUserPermissions, user } from '@/app/lib/db/schema';
import { applyTodoRateLimit, requireTodoSession } from '@/app/lib/todos/api';
import { requireSessionWorkspace } from '@/app/lib/workspaces/request';

type AssigneeCandidate = {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
};

export async function GET(request: NextRequest) {
  const { session, response } = await requireTodoSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyTodoRateLimit(request, 'todo-assignees-get');
  if (!limited.ok) {
    return limited.response;
  }

  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get('workspaceId');
  const workspaceResult = await requireSessionWorkspace(session, {
    workspaceId,
    permissions: 'canRead',
  });
  if (workspaceResult.response) {
    return workspaceResult.response;
  }

  const workspace = workspaceResult.workspace;
  if (workspace.workspaceType !== 'team') {
    const candidate: AssigneeCandidate = {
      id: session.user.id,
      name: session.user.name ?? null,
      email: session.user.email ?? null,
      role: session.user.role ?? null,
    };
    return NextResponse.json({ success: true, data: [candidate] });
  }

  if (!workspace.organizationId) {
    return NextResponse.json({ success: false, error: 'Team workspace is missing organization scope.' }, { status: 409 });
  }

  const candidates = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: organizationUserPermissions.role,
    })
    .from(organizationUserPermissions)
    .innerJoin(user, eq(user.id, organizationUserPermissions.userId))
    .where(and(
      eq(organizationUserPermissions.organizationId, workspace.organizationId),
      ne(organizationUserPermissions.role, 'external'),
    ))
    .orderBy(asc(user.name), asc(user.email));

  return NextResponse.json({ success: true, data: candidates });
}

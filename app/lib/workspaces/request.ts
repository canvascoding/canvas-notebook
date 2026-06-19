import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { createLegacyPersonalWorkspaceContext, resolveWorkspaceActor } from './context';
import { assertWorkspacePermission } from './permissions';
import type { WorkspaceContext, WorkspacePermissions } from './types';

export type RequestWorkspaceSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
export type RequestWorkspacePermission = keyof WorkspacePermissions;

export interface RequestWorkspace {
  session: RequestWorkspaceSession;
  workspace: WorkspaceContext;
}

type RequestWorkspaceResult =
  | (RequestWorkspace & { response: null })
  | { session: null; workspace: null; response: NextResponse };

function normalizePermissions(
  permissions?: RequestWorkspacePermission | RequestWorkspacePermission[]
): RequestWorkspacePermission[] {
  if (!permissions) return [];
  return Array.isArray(permissions) ? permissions : [permissions];
}

export async function requireRequestWorkspace(
  request: NextRequest,
  options: { permissions?: RequestWorkspacePermission | RequestWorkspacePermission[] } = {}
): Promise<RequestWorkspaceResult> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      session: null,
      workspace: null,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const actor = resolveWorkspaceActor({
    id: session.user.id,
    email: session.user.email,
    role: session.user.role,
  });
  const workspace = createLegacyPersonalWorkspaceContext(actor);

  try {
    for (const permission of normalizePermissions(options.permissions)) {
      assertWorkspacePermission(workspace.permissions, permission);
    }
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error
      ? Number(error.status)
      : 403;
    const message = error instanceof Error ? error.message : 'Workspace permission denied';
    return {
      session: null,
      workspace: null,
      response: NextResponse.json({ success: false, error: message }, { status }),
    };
  }

  return { session, workspace, response: null };
}

export function workspaceFileOptions(workspace: WorkspaceContext) {
  return { workspace };
}

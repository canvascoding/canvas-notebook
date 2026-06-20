import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { createLegacyPersonalWorkspaceContext, resolveWorkspaceActor } from './context';
import { WORKSPACE_ID_HEADER } from './constants';
import {
  ensureOrganizationBootstrapForUser,
  openOrganizationBootstrapDatabase,
} from '@/app/lib/organization/bootstrap';
import { assertWorkspacePermission } from './permissions';
import { resolveWorkspaceContextById } from './service';
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

type SessionWorkspaceResult =
  | (RequestWorkspace & { response: null })
  | { session: RequestWorkspaceSession; workspace: null; response: NextResponse };

function normalizePermissions(
  permissions?: RequestWorkspacePermission | RequestWorkspacePermission[]
): RequestWorkspacePermission[] {
  if (!permissions) return [];
  return Array.isArray(permissions) ? permissions : [permissions];
}

function requestedWorkspaceIdFromRequest(request: NextRequest): string | null {
  const headerValue = request.headers.get(WORKSPACE_ID_HEADER)?.trim();
  if (headerValue) return headerValue;

  const queryValue = request.nextUrl.searchParams.get('workspaceId')?.trim();
  return queryValue || null;
}

function assertWorkspacePermissions(
  workspace: WorkspaceContext,
  permissions?: RequestWorkspacePermission | RequestWorkspacePermission[]
): NextResponse | null {
  try {
    for (const permission of normalizePermissions(permissions)) {
      assertWorkspacePermission(workspace.permissions, permission);
    }
    return null;
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error
      ? Number(error.status)
      : 403;
    const message = error instanceof Error ? error.message : 'Workspace permission denied';
    return NextResponse.json({ success: false, error: message }, { status });
  }
}

export async function requireSessionWorkspace(
  session: RequestWorkspaceSession,
  options: {
    workspaceId?: string | null;
    permissions?: RequestWorkspacePermission | RequestWorkspacePermission[];
  } = {}
): Promise<SessionWorkspaceResult> {
  const actor = resolveWorkspaceActor({
    id: session.user.id,
    email: session.user.email,
    role: session.user.role,
  });

  const requestedWorkspaceId = options.workspaceId?.trim() || null;
  let workspace: WorkspaceContext | null = null;

  if (!requestedWorkspaceId) {
    workspace = createLegacyPersonalWorkspaceContext(actor);
  } else {
    const sqlite = openOrganizationBootstrapDatabase();
    try {
      sqlite.exec('BEGIN IMMEDIATE');
      const status = ensureOrganizationBootstrapForUser(sqlite, session.user.id);
      if (!status.organizationId) {
        sqlite.exec('ROLLBACK');
        return {
          session,
          workspace: null,
          response: NextResponse.json({ success: false, error: 'Organization is not configured' }, { status: 409 }),
        };
      }

      workspace = resolveWorkspaceContextById(sqlite, {
        actor,
        workspaceId: requestedWorkspaceId,
      });
      sqlite.exec('COMMIT');
    } catch (error) {
      if (sqlite.inTransaction) {
        sqlite.exec('ROLLBACK');
      }
      const message = error instanceof Error ? error.message : 'Could not resolve workspace';
      return {
        session,
        workspace: null,
        response: NextResponse.json({ success: false, error: message }, { status: 500 }),
      };
    } finally {
      sqlite.close();
    }

    if (!workspace) {
      return {
        session,
        workspace: null,
        response: NextResponse.json({ success: false, error: 'Workspace not found or inaccessible' }, { status: 404 }),
      };
    }
  }

  const permissionResponse = assertWorkspacePermissions(workspace, options.permissions);
  if (permissionResponse) {
    return {
      session,
      workspace: null,
      response: permissionResponse,
    };
  }

  return { session, workspace, response: null };
}

export async function requireRequestWorkspace(
  request: NextRequest,
  options: {
    workspaceId?: string | null;
    permissions?: RequestWorkspacePermission | RequestWorkspacePermission[];
  } = {}
): Promise<RequestWorkspaceResult> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      session: null,
      workspace: null,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const result = await requireSessionWorkspace(session, {
    workspaceId: options.workspaceId ?? requestedWorkspaceIdFromRequest(request),
    permissions: options.permissions,
  });
  if (result.response) {
    return {
      session: null,
      workspace: null,
      response: result.response,
    };
  }

  return result;
}

export function workspaceFileOptions(workspace: WorkspaceContext) {
  return { workspace };
}

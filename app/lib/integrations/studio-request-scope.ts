import 'server-only';

import type { NextRequest } from 'next/server';

import { createStudioScope } from '@/app/lib/integrations/studio-scope';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { getPostgresWorkspaceState } from '@/app/lib/workspaces/postgres-runtime';
import { requireSessionWorkspace } from '@/app/lib/workspaces/request';
import { ensureStudioWorkspaceFilesMigrated } from '@/app/lib/integrations/studio-workspace-file-migration';

type AuthSession = Parameters<typeof requireSessionWorkspace>[0];
type WorkspacePermission = NonNullable<Parameters<typeof requireSessionWorkspace>[1]>['permissions'];

export const STUDIO_WORKSPACE_HEADER = 'x-canvas-workspace-id';

export function studioWorkspaceIdFromRequest(request: NextRequest): string | null {
  const queryWorkspaceId = request.nextUrl.searchParams.get('workspaceId')?.trim();
  if (queryWorkspaceId) return queryWorkspaceId;
  return request.headers.get(STUDIO_WORKSPACE_HEADER)?.trim() || null;
}

async function defaultStudioWorkspaceId(session: AuthSession): Promise<string | null> {
  const actor = resolveWorkspaceActor({
    id: session.user.id,
    email: session.user.email,
    role: session.user.role,
  });

  const state = await getPostgresWorkspaceState(actor);
  return state.defaultWorkspace?.workspaceId ?? null;
}

export async function requireStudioRequestScope(
  request: NextRequest,
  session: AuthSession,
  options: { permissions?: WorkspacePermission } = {},
) {
  const requestedWorkspaceId = studioWorkspaceIdFromRequest(request)
    ?? await defaultStudioWorkspaceId(session);
  const result = await requireSessionWorkspace(session, {
    workspaceId: requestedWorkspaceId,
    permissions: options.permissions ?? 'canRead',
  });

  if (result.response || !result.workspace) {
    return {
      ...result,
      scope: null,
    };
  }

  const scope = createStudioScope(session.user.id, result.workspace);
  await ensureStudioWorkspaceFilesMigrated(scope);

  return {
    ...result,
    scope,
  };
}

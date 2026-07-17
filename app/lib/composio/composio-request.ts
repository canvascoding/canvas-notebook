import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import { requireRequestWorkspace, type RequestWorkspaceSession } from '@/app/lib/workspaces/request';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { resolveComposioContext, type ResolvedComposioContext } from './composio-context';
import { ComposioProfileError } from './composio-profiles';

type ComposioRequestResult =
  | {
      session: RequestWorkspaceSession;
      workspace: WorkspaceContext;
      composioContext: ResolvedComposioContext;
      response: null;
    }
  | { session: null; workspace: null; composioContext: null; response: NextResponse };

export async function requireComposioRequestContext(
  request: NextRequest,
  options: { workspaceId?: string | null } = {},
): Promise<ComposioRequestResult> {
  const workspaceResult = await requireRequestWorkspace(request, {
    workspaceId: options.workspaceId,
    permissions: 'canRead',
  });
  if (workspaceResult.response) {
    return { session: null, workspace: null, composioContext: null, response: workspaceResult.response };
  }

  try {
    const workspace = workspaceResult.workspace.legacy
      ? await resolveAgentSessionWorkspaceForUser({
          userId: workspaceResult.session.user.id,
          permissions: ['canRead'],
        })
      : workspaceResult.workspace;
    const composioContext = await resolveComposioContext({
      userId: workspaceResult.session.user.id,
      workspaceId: workspace.workspaceId,
    });
    return {
      session: workspaceResult.session,
      workspace,
      composioContext,
      response: null,
    };
  } catch (error) {
    const status = error instanceof ComposioProfileError ? error.status : 500;
    const code = error instanceof ComposioProfileError ? error.code : 'COMPOSIO_CONTEXT_FAILED';
    return {
      session: null,
      workspace: null,
      composioContext: null,
      response: NextResponse.json({
        success: false,
        code,
        error: error instanceof Error ? error.message : 'Could not resolve Composio context.',
      }, { status }),
    };
  }
}

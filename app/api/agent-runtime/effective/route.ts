import { NextRequest, NextResponse } from 'next/server';

import {
  resolveEffectiveAgentRuntime,
  type AiRuntimeResolutionContext,
} from '@/app/lib/agent-runtime-policy/runtime-resolver';
import { runtimeErrorResponse } from '@/app/lib/agent-runtime-policy/runtime-service';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { AgentAccessError, requireAgentAccess } from '@/app/lib/agents/access';
import {
  findOwnedPiSessionForRuntime,
  isPiSessionInWorkspace,
} from '@/app/lib/pi/session-runtime-access';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

function normalizedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

function routeError(error: unknown) {
  if (error instanceof AgentAccessError) {
    return NextResponse.json(
      { success: false, code: error.code, error: error.message },
      { status: error.status },
    );
  }
  if (error instanceof Error && error.message === 'Agent not found.') {
    return NextResponse.json(
      { success: false, code: 'AGENT_NOT_FOUND', error: 'Agent not found.' },
      { status: 404 },
    );
  }
  const response = runtimeErrorResponse(error);
  if (response.status >= 500) {
    console.error('[agent-runtime/effective] Request failed.', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  return NextResponse.json(
    { success: false, code: response.code, error: response.message, ...(response.details ?? {}) },
    { status: response.status },
  );
}

export async function GET(request: NextRequest) {
  const workspaceId = normalizedString(request.nextUrl.searchParams.get('workspaceId'));
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, code: 'WORKSPACE_ID_REQUIRED', error: 'workspaceId is required.' },
      { status: 400 },
    );
  }

  const access = await requireRequestWorkspace(request, {
    workspaceId,
    permissions: ['canRead', 'canRunAgent'],
  });
  if (access.response) return access.response;
  if (!access.workspace.organizationId) {
    return NextResponse.json(
      { success: false, code: 'ORGANIZATION_SETUP_REQUIRED', error: 'Complete the app setup first.' },
      { status: 409 },
    );
  }

  const limited = rateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-effective-get:${access.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  let agentId: string;
  try {
    agentId = normalizeManagedAgentId(normalizedString(request.nextUrl.searchParams.get('agentId')));
  } catch {
    return NextResponse.json(
      { success: false, code: 'INVALID_AGENT_ID', error: 'agentId is invalid.' },
      { status: 400 },
    );
  }
  const sessionId = normalizedString(request.nextUrl.searchParams.get('sessionId'));
  if (sessionId) {
    const ownedSession = await findOwnedPiSessionForRuntime({
      sessionId,
      userId: access.session.user.id,
      agentId,
    });
    if (!ownedSession) {
      return NextResponse.json(
        { success: false, code: 'SESSION_NOT_FOUND', error: 'Session not found.' },
        { status: 404 },
      );
    }
    if (!isPiSessionInWorkspace(ownedSession, access.workspace)) {
      return NextResponse.json(
        { success: false, code: 'SESSION_WORKSPACE_MISMATCH', error: 'Session is outside the active workspace.' },
        { status: 403 },
      );
    }
  }

  try {
    await requireAgentAccess(access.session.user.id, agentId, 'canUse');
    const context: AiRuntimeResolutionContext = {
      organizationId: access.workspace.organizationId,
      userId: access.session.user.id,
      workspaceId: access.workspace.workspaceId,
      workspaceType: access.workspace.workspaceType,
      agentId,
      sessionId,
      requestedSelection: null,
    };
    const resolution = await resolveEffectiveAgentRuntime(context);
    return NextResponse.json({
      success: true,
      data: resolution,
      resolution,
      runtime: resolution.effectiveSelection,
    });
  } catch (error) {
    return routeError(error);
  }
}

import { NextRequest, NextResponse } from 'next/server';

import { AgentAccessError, requireAgentAccessForWorkspace } from '@/app/lib/agents/access';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import {
  getUserProviderGrant,
  parseUserProviderGrantUpdate,
  revokeUserProviderGrant,
  runtimeErrorResponse,
  setUserProviderGrant,
} from '@/app/lib/agent-runtime-policy/runtime-service';
import type { AiRuntimeResolutionContext } from '@/app/lib/agent-runtime-policy/runtime-resolver';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireSessionWorkspace } from '@/app/lib/workspaces/request';

const INSTALLATION_ID_PATTERN = /^aip_[a-f0-9]{24}$/u;

function stringParam(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function routeError(error: unknown) {
  if (error instanceof AgentAccessError) {
    return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
  }
  if (error instanceof Error && error.message === 'INVALID_AGENT_ID') {
    return NextResponse.json({ success: false, code: 'INVALID_AGENT_ID', error: 'agentId is invalid.' }, { status: 400 });
  }
  const response = runtimeErrorResponse(error);
  if (response.status >= 500) {
    console.error('[agent-runtime/user-credential-grants] Request failed.', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  return NextResponse.json(
    { success: false, code: response.code, error: response.message, ...(response.details ?? {}) },
    { status: response.status },
  );
}

async function requireGrantContext(request: NextRequest, input: {
  workspaceId: string | null;
  agentId: string | null;
}) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return { response: NextResponse.json({ success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' }, { status: 401 }) };
  }
  if (!input.workspaceId || !input.agentId) {
    return { response: NextResponse.json({ success: false, code: 'INVALID_RUNTIME_INPUT', error: 'workspaceId and agentId are required.' }, { status: 400 }) };
  }
  let agentId: string;
  try {
    agentId = normalizeManagedAgentId(input.agentId);
  } catch {
    return { response: NextResponse.json({ success: false, code: 'INVALID_AGENT_ID', error: 'agentId is invalid.' }, { status: 400 }) };
  }
  const access = await requireSessionWorkspace(session, {
    workspaceId: input.workspaceId,
    permissions: ['canRead', 'canRunAgent'],
  });
  if (access.response) return { response: access.response };
  if (!access.workspace.organizationId) {
    return { response: NextResponse.json({ success: false, code: 'ORGANIZATION_SETUP_REQUIRED', error: 'Complete the app setup first.' }, { status: 409 }) };
  }
  try {
    await requireAgentAccessForWorkspace(session.user.id, agentId, 'canUse', access.workspace);
  } catch (error) {
    return { response: routeError(error) };
  }
  const context: AiRuntimeResolutionContext = {
    organizationId: access.workspace.organizationId,
    userId: session.user.id,
    workspaceId: access.workspace.workspaceId,
    workspaceType: access.workspace.workspaceType,
    agentId,
    sessionId: null,
    requestedSelection: null,
    executionMode: 'interactive',
    principal: {
      type: 'user',
      userId: session.user.id,
      credentialSubjectUserId: session.user.id,
    },
  };
  return { session, context };
}

function validInstallationId(value: string | null): value is string {
  return Boolean(value && INSTALLATION_ID_PATTERN.test(value));
}

export async function GET(request: NextRequest) {
  const contextResult = await requireGrantContext(request, {
    workspaceId: stringParam(request.nextUrl.searchParams.get('workspaceId')),
    agentId: stringParam(request.nextUrl.searchParams.get('agentId')),
  });
  if ('response' in contextResult) return contextResult.response;
  const providerInstallationId = stringParam(request.nextUrl.searchParams.get('providerInstallationId'));
  if (!validInstallationId(providerInstallationId)) {
    return NextResponse.json({ success: false, code: 'INVALID_RUNTIME_INPUT', error: 'providerInstallationId is invalid.' }, { status: 400 });
  }
  const limited = rateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-user-grant-get:${contextResult.session.user.id}`,
  });
  if (!limited.ok) return limited.response;
  try {
    const grant = await getUserProviderGrant({ context: contextResult.context, providerInstallationId });
    return NextResponse.json({ success: true, data: { grant } });
  } catch (error) {
    return routeError(error);
  }
}

export async function PUT(request: NextRequest) {
  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  const contextResult = await requireGrantContext(request, {
    workspaceId: stringParam(payload?.workspaceId),
    agentId: stringParam(payload?.agentId),
  });
  if ('response' in contextResult) return contextResult.response;
  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-user-grant-put:${contextResult.session.user.id}`,
  });
  if (!limited.ok) return limited.response;
  try {
    const grant = await setUserProviderGrant({
      context: contextResult.context,
      update: parseUserProviderGrantUpdate(payload),
    });
    return NextResponse.json({ success: true, data: { grant } });
  } catch (error) {
    return routeError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const contextResult = await requireGrantContext(request, {
    workspaceId: stringParam(request.nextUrl.searchParams.get('workspaceId')),
    agentId: stringParam(request.nextUrl.searchParams.get('agentId')),
  });
  if ('response' in contextResult) return contextResult.response;
  const providerInstallationId = stringParam(request.nextUrl.searchParams.get('providerInstallationId'));
  const expectedRevisionValue = stringParam(request.nextUrl.searchParams.get('expectedRevision'));
  const expectedRevision = expectedRevisionValue === null
    ? undefined
    : /^\d+$/u.test(expectedRevisionValue) ? Number(expectedRevisionValue) : null;
  if (!validInstallationId(providerInstallationId) || expectedRevision === null || (expectedRevision !== undefined && !Number.isSafeInteger(expectedRevision))) {
    return NextResponse.json({ success: false, code: 'INVALID_RUNTIME_INPUT', error: 'Grant parameters are invalid.' }, { status: 400 });
  }
  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-user-grant-delete:${contextResult.session.user.id}`,
  });
  if (!limited.ok) return limited.response;
  try {
    const grant = await revokeUserProviderGrant({
      context: contextResult.context,
      providerInstallationId,
      expectedRevision,
    });
    return NextResponse.json({ success: true, data: { grant } });
  } catch (error) {
    return routeError(error);
  }
}

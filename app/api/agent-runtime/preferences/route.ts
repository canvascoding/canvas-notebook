import { NextRequest, NextResponse } from 'next/server';

import { resolveEffectiveAgentRuntime, type AiRuntimeResolutionContext } from '@/app/lib/agent-runtime-policy/runtime-resolver';
import {
  parseUserPreferenceUpdate,
  resetUserRuntimePreference,
  runtimeErrorResponse,
  setUserRuntimePreference,
} from '@/app/lib/agent-runtime-policy/runtime-service';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { AgentAccessError, requireAgentAccessForWorkspace } from '@/app/lib/agents/access';
import { auth } from '@/app/lib/auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireSessionWorkspace } from '@/app/lib/workspaces/request';

function normalizedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function requestedAgentId(value: unknown): string {
  try {
    return normalizeManagedAgentId(normalizedString(value));
  } catch {
    throw new Error('INVALID_AGENT_ID');
  }
}

function runtimeContext(input: {
  organizationId: string;
  userId: string;
  workspaceId: string;
  workspaceType: AiRuntimeResolutionContext['workspaceType'];
  agentId: string;
}): AiRuntimeResolutionContext {
  return { ...input, sessionId: null, requestedSelection: null };
}

function routeError(error: unknown) {
  if (error instanceof AgentAccessError) {
    return NextResponse.json(
      { success: false, code: error.code, error: error.message },
      { status: error.status },
    );
  }
  if (error instanceof Error && error.message === 'INVALID_AGENT_ID') {
    return NextResponse.json(
      { success: false, code: 'INVALID_AGENT_ID', error: 'agentId is invalid.' },
      { status: 400 },
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
    console.error('[agent-runtime/preferences] Request failed.', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  return NextResponse.json(
    {
      success: false,
      code: response.code,
      error: response.message,
      ...(response.details ?? {}),
    },
    { status: response.status },
  );
}

function requiredWorkspaceId(value: unknown): string | null {
  return normalizedString(value);
}

async function requireRuntimeWorkspace(request: NextRequest, workspaceId: string | null) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      session: null,
      workspace: null,
      response: NextResponse.json(
        { success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' },
        { status: 401 },
      ),
    };
  }
  if (!workspaceId) {
    return {
      session,
      workspace: null,
      response: NextResponse.json(
        { success: false, code: 'WORKSPACE_ID_REQUIRED', error: 'workspaceId is required.' },
        { status: 400 },
      ),
    };
  }
  return requireSessionWorkspace(session, {
    workspaceId,
    permissions: ['canRead', 'canRunAgent'],
  });
}

function parseOptionalExpectedRevision(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  if (!/^\d+$/u.test(value)) throw new Error('INVALID_EXPECTED_REVISION');
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) throw new Error('INVALID_EXPECTED_REVISION');
  return revision;
}

export async function GET(request: NextRequest) {
  const workspaceId = requiredWorkspaceId(request.nextUrl.searchParams.get('workspaceId'));
  const access = await requireRuntimeWorkspace(request, workspaceId);
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
    keyPrefix: `agent-runtime-preferences-get:${access.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const agentId = requestedAgentId(request.nextUrl.searchParams.get('agentId'));
    await requireAgentAccessForWorkspace(access.session.user.id, agentId, 'canUse', access.workspace);
    const resolution = await resolveEffectiveAgentRuntime(runtimeContext({
      organizationId: access.workspace.organizationId,
      userId: access.session.user.id,
      workspaceId: access.workspace.workspaceId,
      workspaceType: access.workspace.workspaceType,
      agentId,
    }));
    return NextResponse.json({ success: true, data: resolution });
  } catch (error) {
    return routeError(error);
  }
}

export async function PATCH(request: NextRequest) {
  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  const workspaceId = requiredWorkspaceId(payload?.workspaceId);
  const access = await requireRuntimeWorkspace(request, workspaceId);
  if (access.response) return access.response;
  if (!access.workspace.organizationId) {
    return NextResponse.json(
      { success: false, code: 'ORGANIZATION_SETUP_REQUIRED', error: 'Complete the app setup first.' },
      { status: 409 },
    );
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-preferences-patch:${access.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const agentId = requestedAgentId(payload?.agentId);
    await requireAgentAccessForWorkspace(access.session.user.id, agentId, 'canUse', access.workspace);
    const context = runtimeContext({
      organizationId: access.workspace.organizationId,
      userId: access.session.user.id,
      workspaceId: access.workspace.workspaceId,
      workspaceType: access.workspace.workspaceType,
      agentId,
    });
    const update = parseUserPreferenceUpdate(payload);
    const resolution = await setUserRuntimePreference({ context, update });
    await recordAuditEvent({
      organizationId: context.organizationId,
      workspaceId: context.workspaceId,
      userId: context.userId,
      agentId: context.agentId,
      source: 'agent-runtime',
      eventType: 'user',
      entityType: 'ai_user_model_preference',
      entityId: `${context.userId}:${context.workspaceId}:${context.agentId}`,
      action: 'ai_user_model_preference.update',
      status: 'success',
      summary: 'User AI runtime preference updated.',
      metadata: {
        revision: resolution.preference?.revision ?? null,
        catalogRevision: resolution.catalogRevision,
        policyRevision: resolution.policyRevision,
        selection: update.selection,
      },
    });
    return NextResponse.json({ success: true, data: resolution });
  } catch (error) {
    return routeError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const workspaceId = requiredWorkspaceId(request.nextUrl.searchParams.get('workspaceId'));
  const access = await requireRuntimeWorkspace(request, workspaceId);
  if (access.response) return access.response;
  if (!access.workspace.organizationId) {
    return NextResponse.json(
      { success: false, code: 'ORGANIZATION_SETUP_REQUIRED', error: 'Complete the app setup first.' },
      { status: 409 },
    );
  }

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-preferences-delete:${access.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const agentId = requestedAgentId(request.nextUrl.searchParams.get('agentId'));
    await requireAgentAccessForWorkspace(access.session.user.id, agentId, 'canUse', access.workspace);
    const expectedRevision = parseOptionalExpectedRevision(request.nextUrl.searchParams.get('expectedRevision'));
    const context = runtimeContext({
      organizationId: access.workspace.organizationId,
      userId: access.session.user.id,
      workspaceId: access.workspace.workspaceId,
      workspaceType: access.workspace.workspaceType,
      agentId,
    });
    const resolution = await resetUserRuntimePreference({ context, expectedRevision });
    await recordAuditEvent({
      organizationId: context.organizationId,
      workspaceId: context.workspaceId,
      userId: context.userId,
      agentId: context.agentId,
      source: 'agent-runtime',
      eventType: 'user',
      entityType: 'ai_user_model_preference',
      entityId: `${context.userId}:${context.workspaceId}:${context.agentId}`,
      action: 'ai_user_model_preference.reset',
      status: 'success',
      summary: 'User AI runtime preference reset to inherited default.',
      metadata: {
        catalogRevision: resolution.catalogRevision,
        policyRevision: resolution.policyRevision,
        inheritedSource: resolution.source,
      },
    });
    return NextResponse.json({ success: true, data: resolution });
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_EXPECTED_REVISION') {
      return NextResponse.json(
        { success: false, code: 'INVALID_EXPECTED_REVISION', error: 'expectedRevision is invalid.' },
        { status: 400 },
      );
    }
    return routeError(error);
  }
}

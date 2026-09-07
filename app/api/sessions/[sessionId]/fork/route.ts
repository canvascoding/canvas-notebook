import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { requireAgentAccess } from '@/app/lib/agents/access';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { runtimeErrorResponse } from '@/app/lib/agent-runtime-policy/runtime-service';
import { prepareSessionRuntimeSnapshot } from '@/app/lib/agent-runtime-policy/session-runtime-service';
import { auth } from '@/app/lib/auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  PiSessionForkError,
  forkPiSession,
} from '@/app/lib/pi/session-fork';
import {
  findOwnedPiSessionForRuntime,
  isPiSessionInWorkspace,
} from '@/app/lib/pi/session-runtime-access';
import {
  getActiveRuntimeStatusSummaries,
  withRuntimeSessionOperation,
} from '@/app/lib/pi/runtime-service';
import { ensurePiSessionSystemPromptSnapshot } from '@/app/lib/pi/system-prompt-snapshot';
import {
  resolveAgentSessionWorkspaceForUser,
  storedPiSessionWorkspaceToSummary,
} from '@/app/lib/pi/session-workspace-context';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

type ForkSessionPayload = {
  agentId?: unknown;
  throughSequence?: unknown;
  workspaceId?: unknown;
  clientRequestId?: unknown;
};

function normalizeRequiredString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function forkErrorResponse(error: unknown): NextResponse {
  if (error instanceof PiSessionForkError) {
    return NextResponse.json(
      { success: false, code: error.code, error: error.message },
      { status: error.status },
    );
  }

  const runtimeError = runtimeErrorResponse(error);
  if (runtimeError.status < 500) {
    return NextResponse.json(
      {
        success: false,
        code: runtimeError.code,
        error: runtimeError.message,
        ...(runtimeError.details ?? {}),
      },
      { status: runtimeError.status },
    );
  }

  console.error('[API Session Fork] Failed to fork session.', {
    errorType: error instanceof Error ? error.name : 'UnknownError',
  });
  return NextResponse.json(
    { success: false, code: 'SESSION_FORK_FAILED', error: 'Could not fork the session.' },
    { status: 500 },
  );
}

export async function POST(request: NextRequest, context: RouteContext) {
  const authSession = await auth.api.getSession({ headers: request.headers });
  if (!authSession) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: `sessions-fork:${authSession.user.id}`,
  });
  if (!limited.ok) return limited.response;

  const { sessionId: rawSessionId } = await context.params;
  const sourceSessionId = normalizeRequiredString(rawSessionId, 500);
  const rawPayload = await request.json().catch(() => null) as unknown;
  if (!sourceSessionId || !rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return NextResponse.json(
      { success: false, code: 'INVALID_FORK_INPUT', error: 'A valid fork request is required.' },
      { status: 400 },
    );
  }

  const payload = rawPayload as ForkSessionPayload;
  const workspaceId = normalizeRequiredString(payload.workspaceId, 200);
  const clientRequestId = normalizeRequiredString(payload.clientRequestId, 200);
  const throughSequence = payload.throughSequence;
  if (
    !workspaceId
    || !clientRequestId
    || typeof throughSequence !== 'number'
    || !Number.isSafeInteger(throughSequence)
    || throughSequence < 1
  ) {
    return NextResponse.json(
      { success: false, code: 'INVALID_FORK_INPUT', error: 'workspaceId, clientRequestId, and throughSequence are required.' },
      { status: 400 },
    );
  }

  let agentId: string;
  try {
    agentId = normalizeManagedAgentId(normalizeRequiredString(payload.agentId, 200));
  } catch {
    return NextResponse.json(
      { success: false, code: 'INVALID_FORK_INPUT', error: 'Invalid agentId.' },
      { status: 400 },
    );
  }

  const source = await findOwnedPiSessionForRuntime({
    sessionId: sourceSessionId,
    userId: authSession.user.id,
    agentId,
  });
  if (!source) {
    return NextResponse.json(
      { success: false, code: 'SESSION_NOT_FOUND', error: 'Session not found.' },
      { status: 404 },
    );
  }
  if (source.sessionKind !== 'conversation') {
    return NextResponse.json(
      { success: false, code: 'SESSION_NOT_FORKABLE', error: 'Only conversation sessions can be forked.' },
      { status: 409 },
    );
  }

  let workspace: Awaited<ReturnType<typeof resolveAgentSessionWorkspaceForUser>>;
  try {
    workspace = await resolveAgentSessionWorkspaceForUser({
      userId: authSession.user.id,
      workspaceId,
      permissions: ['canRead', 'canRunAgent'],
    });
  } catch {
    return NextResponse.json(
      { success: false, code: 'WORKSPACE_ACCESS_DENIED', error: 'Workspace not found or inaccessible.' },
      { status: 403 },
    );
  }
  if (!isPiSessionInWorkspace(source, workspace)) {
    return NextResponse.json(
      { success: false, code: 'SESSION_WORKSPACE_MISMATCH', error: 'Session is outside the active workspace.' },
      { status: 403 },
    );
  }
  if (!workspace.organizationId) {
    return NextResponse.json(
      { success: false, code: 'ORGANIZATION_SETUP_REQUIRED', error: 'Complete the app setup first.' },
      { status: 409 },
    );
  }

  try {
    await requireAgentAccess(authSession.user.id, agentId, 'canUse', {
      organizationId: workspace.organizationId,
      workspaceId: workspace.workspaceId,
      projectId: workspace.projectId,
    });
  } catch {
    return NextResponse.json(
      { success: false, code: 'AGENT_ACCESS_DENIED', error: 'Agent access denied.' },
      { status: 403 },
    );
  }

  try {
    const result = await withRuntimeSessionOperation(sourceSessionId, authSession.user.id, async () => {
      const activeStatuses = await getActiveRuntimeStatusSummaries({
        userId: authSession.user.id,
        sessionIds: [sourceSessionId],
      });
      if (activeStatuses[sourceSessionId]) {
        throw new PiSessionForkError(
          'SESSION_NOT_FORKABLE',
          'Wait for the agent to finish before forking this session.',
          409,
        );
      }

      const prepared = await prepareSessionRuntimeSnapshot({
        context: {
          organizationId: workspace.organizationId!,
          userId: authSession.user.id,
          workspaceId: workspace.workspaceId,
          workspaceType: workspace.workspaceType,
          agentId,
          sessionId: sourceSessionId,
          requestedSelection: null,
        },
      });
      const promptSnapshot = await ensurePiSessionSystemPromptSnapshot(source);

      return forkPiSession({
        sourceSessionId,
        targetSessionId: `sess-${Date.now()}-${randomUUID()}`,
        clientRequestId,
        userId: authSession.user.id,
        agentId,
        workspaceId: workspace.workspaceId,
        workspaceType: workspace.workspaceType,
        throughSequence,
        runtimeSnapshot: prepared.snapshot,
        systemPromptSnapshot: promptSnapshot,
      });
    });

    if (result.created) {
      await recordAuditEvent({
        organizationId: workspace.organizationId,
        customerId: workspace.customerId,
        projectId: workspace.projectId,
        workspaceId: workspace.workspaceId,
        userId: authSession.user.id,
        agentId,
        sessionId: result.session.sessionId,
        source: 'agent-runtime',
        eventType: 'user',
        entityType: 'pi_session',
        entityId: result.session.sessionId,
        action: 'pi_session.fork',
        status: 'success',
        summary: 'Chat session forked from a completed assistant response.',
        metadata: {
          sourceSessionId,
          throughSequence,
          copiedMessageCount: result.copiedMessageCount,
        },
      });
    }

    return NextResponse.json({
      success: true,
      created: result.created,
      copiedMessageCount: result.copiedMessageCount,
      throughSequence: result.throughSequence,
      session: {
        ...result.session,
        engine: 'pi',
        workspace: storedPiSessionWorkspaceToSummary(result.session),
        creator: {
          name: authSession.user.name || null,
          email: authSession.user.email || null,
        },
      },
    }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return forkErrorResponse(error);
  }
}

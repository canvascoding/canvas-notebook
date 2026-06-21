import { NextRequest, NextResponse } from 'next/server';

import {
  applyAutomationRateLimit,
  getAutomationRouteErrorStatus,
  requireAutomationSession,
} from '@/app/lib/automations/api';
import { assertCanAccessAutomationJob } from '@/app/lib/automations/policy';
import { deleteAutomationJob, getAutomationJob, updateAutomationJob } from '@/app/lib/automations/store';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { deleteGatewayTrigger, updateGatewayTrigger } from '@/app/lib/composio/composio-gateway';

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyAutomationRateLimit(request, 'automations-job-get');
  if (!limited.ok) {
    return limited.response;
  }

  const { jobId } = await context.params;
  const job = await getAutomationJob(jobId);
  if (!job) {
    return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
  }
  try {
    assertCanAccessAutomationJob(session.user.id, job);
  } catch {
    return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
  }

  return NextResponse.json({ success: true, data: job });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyAutomationRateLimit(request, 'automations-job-patch', 30);
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = await request.json();
    const { jobId } = await context.params;
    const existing = await getAutomationJob(jobId);
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
    }
    try {
      assertCanAccessAutomationJob(session.user.id, existing);
    } catch {
      return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && ('scope' in payload || 'workspaceId' in payload)) {
      return NextResponse.json(
        { success: false, error: 'Automation scope and workspace cannot be changed after creation.' },
        { status: 400 },
      );
    }
    if (existing.composioTriggerId && (payload?.status === 'active' || payload?.status === 'paused')) {
      await updateGatewayTrigger(existing.composioTriggerId, { status: payload.status }, { userId: session.user.id });
    }
    const updated = await updateAutomationJob(jobId, payload, { actorUserId: session.user.id });
    if (!updated) {
      return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
    }
    await recordAuditEvent({
      organizationId: updated.organizationId,
      workspaceId: updated.workspaceId,
      userId: session.user.id,
      agentId: updated.agentId,
      source: 'automations',
      eventType: 'automation',
      entityType: 'automation_job',
      entityId: updated.id,
      action: 'automation_job.update',
      status: 'success',
      summary: `Automation job ${updated.id} updated.`,
      metadata: {
        scope: updated.scope,
        jobScope: updated.jobScope,
        status: updated.status,
        changedFields: payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload) : [],
      },
    });
    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    const status = getAutomationRouteErrorStatus(error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to update automation.' },
      { status },
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyAutomationRateLimit(request, 'automations-job-delete', 20);
  if (!limited.ok) {
    return limited.response;
  }

  const { jobId } = await context.params;
  const existing = await getAutomationJob(jobId);
  if (!existing) {
    return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
  }
  try {
    assertCanAccessAutomationJob(session.user.id, existing);
  } catch {
    return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
  }
  if (existing.composioTriggerId) {
    await deleteGatewayTrigger(existing.composioTriggerId, { userId: session.user.id });
  }
  const deleted = await deleteAutomationJob(jobId);
  if (!deleted) {
    return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
  }
  await recordAuditEvent({
    organizationId: existing.organizationId,
    workspaceId: existing.workspaceId,
    userId: session.user.id,
    agentId: existing.agentId,
    source: 'automations',
    eventType: 'automation',
    entityType: 'automation_job',
    entityId: existing.id,
    action: 'automation_job.delete',
    status: 'success',
    summary: `Automation job ${existing.id} deleted.`,
    metadata: {
      scope: existing.scope,
      jobScope: existing.jobScope,
      status: existing.status,
      hadComposioTrigger: Boolean(existing.composioTriggerId),
    },
  });

  return NextResponse.json({ success: true });
}

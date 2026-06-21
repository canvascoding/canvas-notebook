import { NextRequest, NextResponse } from 'next/server';

import {
  applyAutomationRateLimit,
  assertCanCreateRequestedAutomation,
  getAutomationRouteErrorStatus,
  requireAutomationSession,
} from '@/app/lib/automations/api';
import { createAutomationJob, listAutomationJobs } from '@/app/lib/automations/store';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';

export async function GET(request: NextRequest) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyAutomationRateLimit(request, 'automations-jobs-get');
  if (!limited.ok) {
    return limited.response;
  }

  const jobs = await listAutomationJobs(session.user.id);
  return NextResponse.json({ success: true, data: jobs });
}

export async function POST(request: NextRequest) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyAutomationRateLimit(request, 'automations-jobs-post', 20);
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = await request.json();
    assertCanCreateRequestedAutomation(payload, session.user);
    const job = await createAutomationJob(payload, session.user);
    await recordAuditEvent({
      organizationId: job.organizationId,
      workspaceId: job.workspaceId,
      userId: session.user.id,
      agentId: job.agentId,
      source: 'automations',
      eventType: 'automation',
      entityType: 'automation_job',
      entityId: job.id,
      action: 'automation_job.create',
      status: 'success',
      summary: `Automation job ${job.id} created.`,
      metadata: {
        scope: job.scope,
        jobScope: job.jobScope,
        workspaceType: job.workspaceType,
        scheduleKind: job.schedule.kind,
        status: job.status,
        responsibleUserId: job.responsibleUserId,
        serviceActorId: job.serviceActorId,
        deliveryMode: job.deliveryMode,
      },
    });
    return NextResponse.json({ success: true, data: job }, { status: 201 });
  } catch (error) {
    const status = getAutomationRouteErrorStatus(error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to create automation.' },
      { status },
    );
  }
}

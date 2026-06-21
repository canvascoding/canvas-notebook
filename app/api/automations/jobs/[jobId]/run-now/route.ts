import { NextRequest, NextResponse } from 'next/server';

import { requireAutomationSession, applyAutomationRateLimit } from '@/app/lib/automations/api';
import { assertCanAccessAutomationJob } from '@/app/lib/automations/policy';
import { dispatchAutomationRunExecution } from '@/app/lib/automations/dispatch';
import { getAutomationJob, scheduleAutomationJobRun } from '@/app/lib/automations/store';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyAutomationRateLimit(request, 'automations-run-now-post', 20);
  if (!limited.ok) {
    return limited.response;
  }

  try {
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

    const run = await scheduleAutomationJobRun(jobId, 'manual', new Date(), { actorUserId: session.user.id });
    if (!run) {
      return NextResponse.json({ success: false, error: 'Automation already has an in-flight run.' }, { status: 409 });
    }
    dispatchAutomationRunExecution(run.id);
    await recordAuditEvent({
      organizationId: run.organizationId,
      workspaceId: run.workspaceId,
      userId: session.user.id,
      agentId: job.agentId,
      source: 'automations',
      eventType: 'automation',
      entityType: 'automation_run',
      entityId: run.id,
      action: 'automation_run.queue_manual',
      status: 'queued',
      summary: `Automation run ${run.id} queued manually.`,
      metadata: {
        jobId: job.id,
        scope: run.scope,
        jobScope: run.jobScope,
        triggerType: run.triggerType,
        actorType: run.actorType,
        actorUserId: run.actorUserId,
      },
    });
    return NextResponse.json({ success: true, data: run }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to queue automation run.' },
      { status: 409 },
    );
  }
}

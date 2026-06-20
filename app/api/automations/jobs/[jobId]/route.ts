import { NextRequest, NextResponse } from 'next/server';

import {
  applyAutomationRateLimit,
  assertCanCreateRequestedAutomation,
  getAutomationRouteErrorStatus,
  requireAutomationSession,
} from '@/app/lib/automations/api';
import { deleteAutomationJob, getAutomationJob, updateAutomationJob } from '@/app/lib/automations/store';
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
  if (!job || job.createdByUserId !== session.user.id) {
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
    if (!existing || existing.createdByUserId !== session.user.id) {
      return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
    }
    assertCanCreateRequestedAutomation(payload, session.user);
    if (existing.composioTriggerId && (payload?.status === 'active' || payload?.status === 'paused')) {
      await updateGatewayTrigger(existing.composioTriggerId, { status: payload.status }, { userId: session.user.id });
    }
    const updated = await updateAutomationJob(jobId, payload);
    if (!updated) {
      return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
    }
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
  if (!existing || existing.createdByUserId !== session.user.id) {
    return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
  }
  if (existing.composioTriggerId) {
    await deleteGatewayTrigger(existing.composioTriggerId, { userId: session.user.id });
  }
  const deleted = await deleteAutomationJob(jobId);
  if (!deleted) {
    return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}

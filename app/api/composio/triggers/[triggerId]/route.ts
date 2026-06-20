import { NextRequest, NextResponse } from 'next/server';

import { requireAutomationSession } from '@/app/lib/automations/api';
import { deleteAutomationJob, getAutomationJobByComposioTriggerId, updateAutomationJob } from '@/app/lib/automations/store';
import { deleteGatewayTrigger, updateGatewayTrigger } from '@/app/lib/composio/composio-gateway';

function logTriggerRoute(message: string, details?: Record<string, unknown>): void {
  if (details) {
    console.log(`[Composio Triggers API] ${message}`, details);
  } else {
    console.log(`[Composio Triggers API] ${message}`);
  }
}

function logTriggerRouteError(message: string, error: unknown, details?: Record<string, unknown>): void {
  console.error(`[Composio Triggers API] ${message}`, {
    ...details,
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ triggerId: string }> },
) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) return response;

  const { triggerId } = await params;
  const job = await getAutomationJobByComposioTriggerId(triggerId);
  if (!job || job.createdByUserId !== session.user.id) {
    return NextResponse.json({ success: false, error: 'Trigger not found.' }, { status: 404 });
  }

  const storageScope = { userId: session.user.id };
  try {
    const payload = await request.json();
    const status = payload?.status === 'paused' ? 'paused' : payload?.status === 'active' ? 'active' : undefined;
    logTriggerRoute('PATCH started', { triggerId, status: status || null });
    const updatedTrigger = await updateGatewayTrigger(triggerId, {
      status,
      triggerConfig: payload?.triggerConfig && typeof payload.triggerConfig === 'object' && !Array.isArray(payload.triggerConfig) ? payload.triggerConfig : undefined,
      notebookWebhookUrl: typeof payload?.notebookWebhookUrl === 'string' ? payload.notebookWebhookUrl : undefined,
    }, storageScope);
    const updatedJob = status ? await updateAutomationJob(job.id, { status }) : job;
    logTriggerRoute('PATCH completed', { triggerId, jobId: job.id, status: status || null });
    return NextResponse.json({ success: true, data: { trigger: updatedTrigger.trigger, job: updatedJob } });
  } catch (error) {
    logTriggerRouteError('PATCH failed', error, { triggerId });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to update trigger.' },
      { status: 400 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ triggerId: string }> },
) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) return response;

  const { triggerId } = await params;
  const job = await getAutomationJobByComposioTriggerId(triggerId);
  if (!job || job.createdByUserId !== session.user.id) {
    return NextResponse.json({ success: false, error: 'Trigger not found.' }, { status: 404 });
  }

  const storageScope = { userId: session.user.id };
  try {
    logTriggerRoute('DELETE started', { triggerId, jobId: job.id });
    await deleteGatewayTrigger(triggerId, storageScope);
    await deleteAutomationJob(job.id);
    logTriggerRoute('DELETE completed', { triggerId, jobId: job.id });
    return NextResponse.json({ success: true });
  } catch (error) {
    logTriggerRouteError('DELETE failed', error, { triggerId, jobId: job.id });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to delete trigger.' },
      { status: 400 },
    );
  }
}

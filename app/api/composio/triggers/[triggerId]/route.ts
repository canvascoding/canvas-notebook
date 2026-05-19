import { NextRequest, NextResponse } from 'next/server';

import { requireAutomationSession } from '@/app/lib/automations/api';
import { deleteAutomationJob, getAutomationJobByComposioTriggerId, updateAutomationJob } from '@/app/lib/automations/store';
import { deleteGatewayTrigger, updateGatewayTrigger } from '@/app/lib/composio/composio-gateway';

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

  try {
    const payload = await request.json();
    const status = payload?.status === 'paused' ? 'paused' : payload?.status === 'active' ? 'active' : undefined;
    const updatedTrigger = await updateGatewayTrigger(triggerId, {
      status,
      triggerConfig: payload?.triggerConfig && typeof payload.triggerConfig === 'object' && !Array.isArray(payload.triggerConfig) ? payload.triggerConfig : undefined,
      notebookWebhookUrl: typeof payload?.notebookWebhookUrl === 'string' ? payload.notebookWebhookUrl : undefined,
    });
    const updatedJob = status ? await updateAutomationJob(job.id, { status }) : job;
    return NextResponse.json({ success: true, data: { trigger: updatedTrigger.trigger, job: updatedJob } });
  } catch (error) {
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

  try {
    await deleteGatewayTrigger(triggerId);
    await deleteAutomationJob(job.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to delete trigger.' },
      { status: 400 },
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';

import { applyAutomationRateLimit, requireAutomationSession } from '@/app/lib/automations/api';
import {
  AutomationJobStateError,
  getAutomationJobState,
  listAutomationJobState,
  mutateAutomationJobState,
} from '@/app/lib/automations/job-state-store';
import { getAutomationJob } from '@/app/lib/automations/store';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';

type RouteContext = { params: Promise<{ jobId: string }> };

function stateErrorResponse(error: unknown): NextResponse {
  if (error instanceof AutomationJobStateError) {
    const status = error.code === 'ACCESS_DENIED' ? 404
      : error.code === 'REVISION_CONFLICT' || error.code === 'MUTATION_CONFLICT' ? 409 : 400;
    const message = error.code === 'ACCESS_DENIED' ? 'Automation not found.' : error.message;
    return NextResponse.json({ success: false, error: message }, { status });
  }
  return NextResponse.json({ success: false, error: 'Automation state request failed.' }, { status: 500 });
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) return response;

  const limited = applyAutomationRateLimit(request, 'automations-job-state-get');
  if (!limited.ok) return limited.response;

  const { jobId } = await context.params;
  const key = request.nextUrl.searchParams.get('key');
  try {
    if (key === null) {
      return NextResponse.json({ success: true, data: await listAutomationJobState(jobId, {
        kind: 'user', userId: session.user.id,
      }) });
    }
    const entry = await getAutomationJobState(jobId, key, { kind: 'user', userId: session.user.id });
    if (!entry) return NextResponse.json({ success: false, error: 'State key not found.' }, { status: 404 });
    return NextResponse.json({ success: true, data: entry });
  } catch (error) {
    return stateErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) return response;

  const limited = applyAutomationRateLimit(request, 'automations-job-state-delete', 20);
  if (!limited.ok) return limited.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ success: false, error: 'Invalid state reset request.' }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  if (typeof input.key !== 'string' || typeof input.mutationId !== 'string'
    || typeof input.expectedRevision !== 'number' || Object.keys(input).some((key) =>
      key !== 'key' && key !== 'expectedRevision' && key !== 'mutationId')) {
    return NextResponse.json({ success: false, error: 'Invalid state reset request.' }, { status: 400 });
  }

  const { jobId } = await context.params;
  try {
    const result = await mutateAutomationJobState({
      jobId,
      key: input.key,
      action: 'delete',
      expectedRevision: input.expectedRevision,
      mutationId: input.mutationId,
      access: { kind: 'user', userId: session.user.id },
    });
    const job = await getAutomationJob(jobId);
    await recordAuditEvent({
      organizationId: job?.organizationId,
      workspaceId: job?.workspaceId,
      userId: session.user.id,
      agentId: job?.agentId,
      source: 'automations',
      eventType: 'automation',
      entityType: 'automation_job_state',
      entityId: jobId,
      action: 'automation_job_state.delete',
      status: 'success',
      summary: 'Automation state key reset.',
      metadata: { key: input.key, previousRevision: input.expectedRevision,
        mutationId: input.mutationId },
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return stateErrorResponse(error);
  }
}

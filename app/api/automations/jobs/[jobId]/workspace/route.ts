import { NextRequest, NextResponse } from 'next/server';

import {
  applyAutomationRateLimit,
  getAutomationRouteErrorStatus,
  requireAutomationSession,
} from '@/app/lib/automations/api';
import { assertCanAccessAutomationJob } from '@/app/lib/automations/policy';
import {
  AutomationWorkspaceChangeConflictError,
  getAutomationJob,
} from '@/app/lib/automations/store';
import {
  applyAutomationWorkspaceChange,
  previewAutomationWorkspaceChange,
} from '@/app/lib/automations/workspace-change';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

function workspaceIdFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const value = (payload as Record<string, unknown>).workspaceId;
  return typeof value === 'string' ? value.trim() : '';
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) return response;

  const limited = applyAutomationRateLimit(request, 'automations-job-workspace-post', 20);
  if (!limited.ok) return limited.response;

  try {
    const payload = await request.json();
    const targetWorkspaceId = workspaceIdFromPayload(payload);
    if (!targetWorkspaceId) {
      return NextResponse.json(
        { success: false, error: 'workspaceId is required.' },
        { status: 400 },
      );
    }

    const { jobId } = await context.params;
    const existing = await getAutomationJob(jobId);
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
    }
    try {
      await assertCanAccessAutomationJob(session.user.id, existing);
    } catch {
      return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
    }

    const confirm = Boolean(
      payload && typeof payload === 'object' && !Array.isArray(payload)
      && (payload as Record<string, unknown>).confirm === true,
    );
    if (!confirm) {
      const preview = await previewAutomationWorkspaceChange(existing, targetWorkspaceId, session.user);
      return NextResponse.json({ success: true, data: preview });
    }

    const result = await applyAutomationWorkspaceChange(jobId, targetWorkspaceId, session.user);
    await recordAuditEvent({
      organizationId: result.job.organizationId,
      workspaceId: result.job.workspaceId,
      userId: session.user.id,
      agentId: result.job.agentId,
      source: 'automations',
      eventType: 'automation',
      entityType: 'automation_job',
      entityId: result.job.id,
      action: 'automation_job.workspace_change',
      status: 'success',
      summary: `Automation job ${result.job.id} moved to workspace ${result.job.workspaceId}.`,
      metadata: {
        sourceWorkspaceId: existing.workspaceId,
        sourceWorkspaceType: existing.workspaceType,
        targetWorkspaceId: result.job.workspaceId,
        targetWorkspaceType: result.job.workspaceType,
        sourceScope: existing.scope,
        targetScope: result.job.scope,
        resetPreferredSkill: result.preview.changes.resetPreferredSkill,
        resetFixedDeliverySession: result.preview.changes.resetFixedDeliverySession,
        warnings: result.preview.issues
          .filter((entry) => entry.severity === 'warning' || entry.severity === 'change')
          .map((entry) => entry.code),
      },
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const status = error instanceof AutomationWorkspaceChangeConflictError
      ? error.status
      : getAutomationRouteErrorStatus(error);
    return NextResponse.json(
      {
        success: false,
        code: error instanceof AutomationWorkspaceChangeConflictError ? error.code : undefined,
        error: error instanceof Error ? error.message : 'Failed to change the automation workspace.',
      },
      { status },
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';

import { requireAutomationSession, applyAutomationRateLimit } from '@/app/lib/automations/api';
import { assertCanAccessAutomationJob, canAccessAutomationRun } from '@/app/lib/automations/policy';
import { projectAutomationRunForApi } from '@/app/lib/automations/public-run';
import { getAutomationJob, listAutomationRuns, listAutomationScheduleSkipDiagnostics } from '@/app/lib/automations/store';

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyAutomationRateLimit(request, 'automations-job-runs-get');
  if (!limited.ok) {
    return limited.response;
  }

  const { jobId } = await context.params;
  const job = await getAutomationJob(jobId);
  if (!job) {
    return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
  }
  try {
    await assertCanAccessAutomationJob(session.user.id, job);
  } catch {
    return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
  }

  const canReadCurrentWorkspace = await canAccessAutomationRun(session.user.id, {
    scope: job.scope,
    organizationId: job.organizationId,
    workspaceId: job.workspaceId,
    actorUserId: job.ownerUserId || job.createdByUserId,
  });

  const [runs, diagnostics] = await Promise.all([
    listAutomationRuns(jobId),
    canReadCurrentWorkspace ? listAutomationScheduleSkipDiagnostics(job) : Promise.resolve([]),
  ]);
  const visibleRuns = (await Promise.all(runs.map(async (run) => (
    await canAccessAutomationRun(session.user.id, run) ? run : null
  )))).filter((run): run is NonNullable<typeof run> => run !== null);
  return NextResponse.json({ success: true, data: visibleRuns.map(projectAutomationRunForApi), diagnostics });
}

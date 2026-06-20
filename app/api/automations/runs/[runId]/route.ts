import { NextRequest, NextResponse } from 'next/server';

import { requireAutomationSession, applyAutomationRateLimit } from '@/app/lib/automations/api';
import { assertCanAccessAutomationJob } from '@/app/lib/automations/policy';
import { getAutomationJob, getAutomationRun } from '@/app/lib/automations/store';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyAutomationRateLimit(request, 'automations-run-get');
  if (!limited.ok) {
    return limited.response;
  }

  const { runId } = await context.params;
  const run = await getAutomationRun(runId);
  if (!run) {
    return NextResponse.json({ success: false, error: 'Automation run not found.' }, { status: 404 });
  }
  const job = await getAutomationJob(run.jobId);
  if (!job) {
    return NextResponse.json({ success: false, error: 'Automation run not found.' }, { status: 404 });
  }
  try {
    assertCanAccessAutomationJob(session.user.id, job);
  } catch {
    return NextResponse.json({ success: false, error: 'Automation run not found.' }, { status: 404 });
  }

  return NextResponse.json({ success: true, data: run });
}

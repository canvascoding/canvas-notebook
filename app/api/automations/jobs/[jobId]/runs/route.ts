import { NextRequest, NextResponse } from 'next/server';

import { requireAutomationSession, applyAutomationRateLimit } from '@/app/lib/automations/api';
import { getAutomationJob, listAutomationRuns } from '@/app/lib/automations/store';

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

  const runs = await listAutomationRuns(jobId);
  return NextResponse.json({ success: true, data: runs });
}

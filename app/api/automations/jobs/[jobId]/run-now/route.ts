import { NextRequest, NextResponse } from 'next/server';

import { requireAutomationSession, applyAutomationRateLimit } from '@/app/lib/automations/api';
import { createPendingAutomationRun, getAutomationJob } from '@/app/lib/automations/store';

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

    const run = await createPendingAutomationRun(jobId, 'manual');
    return NextResponse.json({ success: true, data: run }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to queue automation run.' },
      { status: 400 },
    );
  }
}

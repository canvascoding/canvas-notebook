import { NextRequest, NextResponse } from 'next/server';

import { requireAutomationSession, applyAutomationRateLimit } from '@/app/lib/automations/api';
import { createAutomationJob, listAutomationJobs } from '@/app/lib/automations/store';

export async function GET(request: NextRequest) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyAutomationRateLimit(request, 'automations-jobs-get');
  if (!limited.ok) {
    return limited.response;
  }

  const jobs = await listAutomationJobs(session.user.id);
  return NextResponse.json({ success: true, data: jobs });
}

export async function POST(request: NextRequest) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyAutomationRateLimit(request, 'automations-jobs-post', 20);
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = await request.json();
    const job = await createAutomationJob(payload, session.user.id);
    return NextResponse.json({ success: true, data: job }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to create automation.' },
      { status: 400 },
    );
  }
}

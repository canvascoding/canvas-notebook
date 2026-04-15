import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { listAutomationJobs } from '@/app/lib/automations/store';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 30,
      windowMs: 60_000,
      keyPrefix: 'workflow-automation-list',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const jobs = await listAutomationJobs(session.user.id);

    const sanitizedJobs = jobs.map(job => ({
      id: job.id,
      name: job.name,
      status: job.status,
      prompt: job.prompt,
      preferredSkill: job.preferredSkill,
      schedule: job.schedule,
      targetOutputPath: job.targetOutputPath,
      effectiveTargetOutputPath: job.effectiveTargetOutputPath,
      workspaceContextPaths: job.workspaceContextPaths,
      nextRunAt: job.nextRunAt,
      lastRunAt: job.lastRunAt,
      lastRunStatus: job.lastRunStatus,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }));

    return NextResponse.json({
      success: true,
      data: {
        jobs: sanitizedJobs,
        count: sanitizedJobs.length,
      },
    });
  } catch (error) {
    console.error('[API] workflow-automation/jobs GET error:', error);
    const message = error instanceof Error ? error.message : 'Failed to list automation jobs';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

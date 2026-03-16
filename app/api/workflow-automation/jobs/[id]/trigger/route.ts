import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getAutomationJob, scheduleAutomationJobRun } from '@/app/lib/automations/store';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  const skillsToken = request.headers.get('x-canvas-skills-token');
  const isSkillsCall = !!skillsToken && skillsToken === process.env.CANVAS_SKILLS_TOKEN;
  
  if (!session && !isSkillsCall) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ success: false, error: 'Job ID is required' }, { status: 400 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 10,
      windowMs: 60_000,
      keyPrefix: 'workflow-automation-trigger',
    });
    if (!limited.ok) {
      return limited.response;
    }

    // Check if job exists
    const job = await getAutomationJob(id);
    if (!job) {
      return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    }

    // Schedule the run
    const run = await scheduleAutomationJobRun(id, 'manual', new Date());

    return NextResponse.json({
      success: true,
      data: {
        message: 'Automation job triggered successfully',
        run: {
          id: run.id,
          jobId: run.jobId,
          status: run.status,
          triggerType: run.triggerType,
          scheduledFor: run.scheduledFor,
          attemptNumber: run.attemptNumber,
          createdAt: run.createdAt,
        },
      },
    }, { status: 202 });
  } catch (error) {
    console.error('[API] workflow-automation/jobs/[id]/trigger error:', error);
    const message = error instanceof Error ? error.message : 'Failed to trigger automation job';
    return NextResponse.json({ success: false, error: message }, { status: 409 });
  }
}

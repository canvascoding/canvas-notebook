import { NextRequest, NextResponse } from 'next/server';
import { listDueAutomationJobs, scheduleAutomationJobRun, advanceAutomationJobSchedule } from '@/app/lib/automations/store';
import { isValidCanvasInternalToken } from '@/app/lib/internal-auth';

export async function POST(request: NextRequest) {
  const isValid = isValidCanvasInternalToken(request.headers.get('x-canvas-internal-token'));
  if (!isValid) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const now = new Date();
    const dueJobs = await listDueAutomationJobs(now);
    const queued: string[] = [];

    for (const job of dueJobs) {
      const anchor = job.nextRunAt ? new Date(job.nextRunAt) : now;
      try {
        await scheduleAutomationJobRun(job.id, 'scheduled', now);
        await advanceAutomationJobSchedule(job.id, anchor);
        queued.push(job.id);
      } catch (error) {
        console.warn(`[Scheduler API] Failed to queue job ${job.id}:`, error instanceof Error ? error.message : error);
      }
    }

    return NextResponse.json({ success: true, queued });
  } catch (error) {
    console.error('[Scheduler API] Error queuing due jobs:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to queue due jobs' },
      { status: 500 }
    );
  }
}

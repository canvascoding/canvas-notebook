import { NextRequest, NextResponse } from 'next/server';
import {
  claimDueScheduledAutomationJobRun,
  discardMissedScheduledAutomationRuns,
  listDueAutomationJobs,
} from '@/app/lib/automations/store';
import { isValidCanvasInternalToken } from '@/app/lib/internal-auth';
import { sendDueTodoReminders } from '@/app/lib/todos/reminders';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const isValid = isValidCanvasInternalToken(request.headers.get('x-canvas-internal-token'));
  if (!isValid) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const now = new Date();
    const skipped = await discardMissedScheduledAutomationRuns(now);
    const [dueJobs, todoReminders] = await Promise.all([listDueAutomationJobs(now), sendDueTodoReminders(now)]);
    const queued: string[] = [];

    for (const job of dueJobs) {
      try {
        const run = await claimDueScheduledAutomationJobRun(job.id, now);
        if (run) {
          queued.push(job.id);
        }
      } catch (error) {
        console.warn(`[Scheduler API] Failed to queue job ${job.id}:`, error instanceof Error ? error.message : error);
      }
    }

    if (queued.length > 0) {
      console.log(`[Scheduler API] Queued ${queued.length} due job(s)`);
    }

    return NextResponse.json({ success: true, queued, skipped, todoReminders });
  } catch (error) {
    console.error('[Scheduler API] Error queuing due jobs:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to queue due jobs' },
      { status: 500 }
    );
  }
}

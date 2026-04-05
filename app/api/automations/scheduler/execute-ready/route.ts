import { NextRequest, NextResponse } from 'next/server';
import { dispatchAutomationRunExecution } from '@/app/lib/automations/dispatch';
import { listExecutableAutomationRuns } from '@/app/lib/automations/store';
import { isValidCanvasInternalToken } from '@/app/lib/internal-auth';

export async function POST(request: NextRequest) {
  const isValid = isValidCanvasInternalToken(request.headers.get('x-canvas-internal-token'));
  if (!isValid) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const now = new Date();
    const runs = await listExecutableAutomationRuns(now);
    const executed: string[] = [];

    for (const run of runs) {
      try {
        const didDispatch = dispatchAutomationRunExecution(run.id);
        if (!didDispatch) {
          throw new Error('Run is already being dispatched.');
        }

        executed.push(run.id);
      } catch (error) {
        console.error(`[Scheduler API] Failed to execute run ${run.id}:`, error);
      }
    }

    return NextResponse.json({ success: true, executed });
  } catch (error) {
    console.error('[Scheduler API] Error executing ready runs:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to execute ready runs' },
      { status: 500 }
    );
  }
}

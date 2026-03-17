import { NextRequest, NextResponse } from 'next/server';
import { listExecutableAutomationRuns } from '@/app/lib/automations/store';
import { getCanvasInternalToken, isValidCanvasInternalToken } from '@/app/lib/internal-auth';

export async function POST(request: NextRequest) {
  const isValid = isValidCanvasInternalToken(request.headers.get('x-canvas-internal-token'));
  if (!isValid) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const now = new Date();
    const runs = await listExecutableAutomationRuns(now);
    // Scheduler always connects to internal port 3000, never external port
    const baseUrl = 'http://127.0.0.1:3000';
    const internalToken = getCanvasInternalToken();

    const executed: string[] = [];

    for (const run of runs) {
      try {
        const response = await fetch(`${baseUrl}/api/automations/execute`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-canvas-internal-token': internalToken,
          },
          body: JSON.stringify({ runId: run.id }),
        });

        if (!response.ok) {
          const payload = await response.text();
          throw new Error(`Internal execution request failed (${response.status}): ${payload}`);
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

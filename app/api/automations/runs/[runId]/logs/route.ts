import { NextRequest, NextResponse } from 'next/server';

import { requireAutomationSession, applyAutomationRateLimit } from '@/app/lib/automations/api';
import { getAutomationRun } from '@/app/lib/automations/store';

type RouteContext = {
  params: Promise<{ runId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyAutomationRateLimit(request, 'automations-run-logs-get');
  if (!limited.ok) {
    return limited.response;
  }

  const { runId } = await context.params;
  const run = await getAutomationRun(runId);
  if (!run) {
    return NextResponse.json({ success: false, error: 'Automation run not found.' }, { status: 404 });
  }

  // Return events log from database instead of file
  const content = run.eventsLog ? run.eventsLog.join('\n') + '\n' : '';

  return NextResponse.json({
    success: true,
    data: {
      logPath: run.logPath,
      content,
    },
  });
}

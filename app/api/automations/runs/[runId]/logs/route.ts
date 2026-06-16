import { NextRequest, NextResponse } from 'next/server';

import { requireAutomationSession, applyAutomationRateLimit } from '@/app/lib/automations/api';
import { getAutomationRunLogSnapshot } from '@/app/lib/automations/store';

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
  const snapshot = await getAutomationRunLogSnapshot(runId);
  if (!snapshot) {
    return NextResponse.json({ success: false, error: 'Automation run not found.' }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    data: {
      logPath: snapshot.logPath,
      content: snapshot.content,
      truncated: snapshot.truncated,
    },
  });
}

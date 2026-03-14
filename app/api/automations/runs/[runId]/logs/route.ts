import { NextRequest, NextResponse } from 'next/server';

import { requireAutomationSession, applyAutomationRateLimit } from '@/app/lib/automations/api';
import { getAutomationRun } from '@/app/lib/automations/store';
import { readFile } from '@/app/lib/filesystem/workspace-files';

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

  return NextResponse.json({
    success: true,
    data: {
      logPath: run.logPath,
      content: run.logPath ? (await readFile(run.logPath)).toString('utf8') : '',
    },
  });
}

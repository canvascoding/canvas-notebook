import { NextRequest, NextResponse } from 'next/server';

import { executeAutomationRun } from '@/app/lib/automations/runner';

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    const runId = typeof payload?.runId === 'string' ? payload.runId : '';
    if (!runId) {
      return NextResponse.json({ success: false, error: 'runId is required.' }, { status: 400 });
    }

    await executeAutomationRun(runId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Execution failed.' },
      { status: 500 },
    );
  }
}

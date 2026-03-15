import { NextRequest, NextResponse } from 'next/server';

import { executeAutomationRun } from '@/app/lib/automations/runner';
import { isValidInternalToken } from '@/app/lib/security/internal-token';

export async function POST(request: NextRequest) {
  try {
    const internalToken = request.headers.get('x-canvas-internal-token');
    const authorized = await isValidInternalToken(internalToken);
    if (!authorized) {
      return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }

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

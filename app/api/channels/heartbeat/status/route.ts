import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getHeartbeatJob } from '@/app/lib/automations/store';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const job = await getHeartbeatJob();

    if (!job) {
      return NextResponse.json({
        success: true,
        enabled: false,
        nextRunAt: null,
        lastRunAt: null,
        lastRunStatus: null,
      });
    }

    return NextResponse.json({
      success: true,
      enabled: job.status === 'active',
      nextRunAt: job.nextRunAt,
      lastRunAt: job.lastRunAt,
      lastRunStatus: job.lastRunStatus,
    });
  } catch (error) {
    console.error('[API] heartbeat/status error:', error);
    return NextResponse.json({ success: false, error: 'Failed to get heartbeat status' }, { status: 500 });
  }
}
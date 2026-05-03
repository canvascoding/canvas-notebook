import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getHeartbeatJob, upsertHeartbeatJob } from '@/app/lib/automations/store';
import { validateFriendlySchedule } from '@/app/lib/automations/schedule';

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
        configured: false,
        enabled: false,
        schedule: null,
        nextRunAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        jobId: null,
      });
    }

    return NextResponse.json({
      success: true,
      configured: true,
      enabled: job.status === 'active',
      schedule: job.schedule,
      nextRunAt: job.nextRunAt,
      lastRunAt: job.lastRunAt,
      lastRunStatus: job.lastRunStatus,
      jobId: job.id,
    });
  } catch (error) {
    console.error('[API] heartbeat/config GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to get heartbeat config' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { enabled, schedule: scheduleInput } = body as {
      enabled?: boolean;
      schedule?: Record<string, unknown>;
    };

    if (scheduleInput === undefined && enabled === undefined) {
      return NextResponse.json({ success: false, error: 'Must provide enabled or schedule' }, { status: 400 });
    }

    const existing = await getHeartbeatJob();

    let schedule: Record<string, unknown>;
    if (scheduleInput) {
      const { schedule: validated, error } = validateFriendlySchedule(scheduleInput);
      if (!validated || error) {
        return NextResponse.json({ success: false, error: error || 'Invalid schedule' }, { status: 400 });
      }
      schedule = validated as unknown as Record<string, unknown>;
    } else if (existing) {
      schedule = existing.schedule as unknown as Record<string, unknown>;
    } else {
      return NextResponse.json({ success: false, error: 'Schedule is required when creating heartbeat' }, { status: 400 });
    }

    const isEnabled = enabled !== undefined ? enabled : (existing ? existing.status === 'active' : false);

    const job = await upsertHeartbeatJob({
      enabled: isEnabled,
      schedule: schedule as import('@/app/lib/automations/types').FriendlySchedule,
      userId: session.user.id,
    });

    return NextResponse.json({
      success: true,
      configured: true,
      enabled: job.status === 'active',
      schedule: job.schedule,
      nextRunAt: job.nextRunAt,
      lastRunAt: job.lastRunAt,
      lastRunStatus: job.lastRunStatus,
      jobId: job.id,
    });
  } catch (error) {
    console.error('[API] heartbeat/config PUT error:', error);
    return NextResponse.json({ success: false, error: 'Failed to save heartbeat config' }, { status: 500 });
  }
}
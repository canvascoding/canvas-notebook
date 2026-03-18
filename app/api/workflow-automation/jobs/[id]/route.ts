import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { updateAutomationJob, deleteAutomationJob, getAutomationJob } from '@/app/lib/automations/store';
import { type AutomationPreferredSkill, type FriendlySchedule, type AutomationWeekday, type AutomationIntervalUnit, type AutomationJobStatus } from '@/app/lib/automations/types';

interface UpdateWorkflowRequest {
  name?: string;
  prompt?: string;
  schedule?: FriendlySchedule;
  preferredSkill?: AutomationPreferredSkill;
  targetOutputPath?: string | null;
  workspaceContextPaths?: string[];
  status?: AutomationJobStatus;
}

function sanitizeString(value: unknown, field: string, maxLength = 4000): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} cannot be empty.`);
  }
  return trimmed.slice(0, maxLength);
}

function validateSchedule(schedule: unknown): FriendlySchedule {
  if (!schedule || typeof schedule !== 'object') {
    throw new Error('Schedule must be an object.');
  }

  const s = schedule as Record<string, unknown>;
  const kind = s.kind;

  if (!kind || typeof kind !== 'string') {
    throw new Error('Schedule kind is required.');
  }

  const validKinds = ['once', 'daily', 'weekly', 'interval'];
  if (!validKinds.includes(kind)) {
    throw new Error(`Invalid schedule kind. Must be one of: ${validKinds.join(', ')}`);
  }

  const timeZone = s.timeZone || 'UTC';
  if (typeof timeZone !== 'string') {
    throw new Error('timeZone must be a string.');
  }

  switch (kind) {
    case 'once': {
      const date = s.date;
      const time = s.time;
      if (!date || typeof date !== 'string') {
        throw new Error('Schedule date is required for once schedule.');
      }
      if (!time || typeof time !== 'string') {
        throw new Error('Schedule time is required for once schedule.');
      }
      return { kind: 'once', date, time, timeZone };
    }
    case 'daily': {
      const time = s.time;
      if (!time || typeof time !== 'string') {
        throw new Error('Schedule time is required for daily schedule.');
      }
      return { kind: 'daily', time, timeZone };
    }
    case 'weekly': {
      const days = s.days;
      const time = s.time;
      if (!Array.isArray(days) || days.length === 0) {
        throw new Error('Schedule days array is required for weekly schedule.');
      }
      if (!time || typeof time !== 'string') {
        throw new Error('Schedule time is required for weekly schedule.');
      }
      const validDays: AutomationWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
      const normalizedDays = days.filter((d): d is AutomationWeekday => typeof d === 'string' && validDays.includes(d as AutomationWeekday));
      if (normalizedDays.length === 0) {
        throw new Error('At least one valid day is required for weekly schedule.');
      }
      return { kind: 'weekly', days: normalizedDays, time, timeZone };
    }
    case 'interval': {
      const every = s.every;
      const unit = s.unit;
      if (typeof every !== 'number' || every < 1) {
        throw new Error('Schedule every must be a positive number for interval schedule.');
      }
      if (!unit || typeof unit !== 'string') {
        throw new Error('Schedule unit is required for interval schedule.');
      }
      const validUnits: AutomationIntervalUnit[] = ['minutes', 'hours', 'days'];
      if (!validUnits.includes(unit as AutomationIntervalUnit)) {
        throw new Error(`Invalid interval unit. Must be one of: ${validUnits.join(', ')}`);
      }
      return { kind: 'interval', every, unit: unit as AutomationIntervalUnit, timeZone };
    }
    default:
      throw new Error('Invalid schedule configuration.');
  }
}

const VALID_PREFERRED_SKILLS: AutomationPreferredSkill[] = [
  'auto',
  'image_generation',
  'video_generation',
  'ad_localization',
  'qmd',
  'qmd_search',
];

function normalizePreferredSkill(value: unknown): AutomationPreferredSkill {
  const normalized = typeof value === 'string' ? value.trim() : 'auto';
  if (normalized === 'qmd_search') {
    return 'qmd';
  }
  if (VALID_PREFERRED_SKILLS.includes(normalized as AutomationPreferredSkill)) {
    return normalized as AutomationPreferredSkill;
  }
  return 'auto';
}

function normalizeWorkspaceContextPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().replace(/^\/+|^\.\/+/, ''))
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeTargetOutputPath(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error('Target output path must be a string.');
  }
  const normalized = value.trim().replace(/^\/+|^\.\/+/, '').replace(/\/+$/, '');
  return normalized || null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ success: false, error: 'Job ID is required' }, { status: 400 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'workflow-automation-update',
    });
    if (!limited.ok) {
      return limited.response;
    }

    // Check if job exists
    const existingJob = await getAutomationJob(id);
    if (!existingJob) {
      return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    }

    let body: UpdateWorkflowRequest;
    try {
      body = (await request.json()) as UpdateWorkflowRequest;
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON payload.' }, { status: 400 });
    }

    // Build update input
    const updateInput: Partial<UpdateWorkflowRequest> = {};

    if (body.name !== undefined) {
      updateInput.name = sanitizeString(body.name, 'Name', 120);
    }

    if (body.prompt !== undefined) {
      updateInput.prompt = sanitizeString(body.prompt, 'Prompt', 12000);
    }

    if (body.schedule !== undefined) {
      updateInput.schedule = validateSchedule(body.schedule);
    }

    if (body.preferredSkill !== undefined) {
      updateInput.preferredSkill = normalizePreferredSkill(body.preferredSkill);
    }

    if (body.targetOutputPath !== undefined) {
      updateInput.targetOutputPath = normalizeTargetOutputPath(body.targetOutputPath);
    }

    if (body.workspaceContextPaths !== undefined) {
      updateInput.workspaceContextPaths = normalizeWorkspaceContextPaths(body.workspaceContextPaths);
    }

    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'paused') {
        return NextResponse.json({ success: false, error: 'Status must be "active" or "paused"' }, { status: 400 });
      }
      updateInput.status = body.status;
    }

    const updatedJob = await updateAutomationJob(id, updateInput);

    if (!updatedJob) {
      return NextResponse.json({ success: false, error: 'Failed to update job' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      data: {
        job: {
          id: updatedJob.id,
          name: updatedJob.name,
          status: updatedJob.status,
          prompt: updatedJob.prompt,
          preferredSkill: updatedJob.preferredSkill,
          schedule: updatedJob.schedule,
          targetOutputPath: updatedJob.targetOutputPath,
          effectiveTargetOutputPath: updatedJob.effectiveTargetOutputPath,
          workspaceContextPaths: updatedJob.workspaceContextPaths,
          nextRunAt: updatedJob.nextRunAt,
          lastRunAt: updatedJob.lastRunAt,
          lastRunStatus: updatedJob.lastRunStatus,
          updatedAt: updatedJob.updatedAt,
        },
      },
    });
  } catch (error) {
    console.error('[API] workflow-automation/jobs/[id] PATCH error:', error);
    const message = error instanceof Error ? error.message : 'Failed to update automation job';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ success: false, error: 'Job ID is required' }, { status: 400 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'workflow-automation-delete',
    });
    if (!limited.ok) {
      return limited.response;
    }

    // Check if job exists
    const existingJob = await getAutomationJob(id);
    if (!existingJob) {
      return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    }

    const deleted = await deleteAutomationJob(id);

    if (!deleted) {
      return NextResponse.json({ success: false, error: 'Failed to delete job' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      data: {
        message: 'Job deleted successfully',
        deletedJobId: id,
      },
    });
  } catch (error) {
    console.error('[API] workflow-automation/jobs/[id] DELETE error:', error);
    const message = error instanceof Error ? error.message : 'Failed to delete automation job';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

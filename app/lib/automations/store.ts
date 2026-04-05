import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, lte, notInArray, or } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { automationJobs, automationRuns, piSessions } from '@/app/lib/db/schema';
import { validatePath } from '@/app/lib/filesystem/workspace-files';

import { getEffectiveAutomationTargetOutputPath } from './paths';
import { computeNextRunAt, validateFriendlySchedule } from './schedule';
import {
  type AutomationJobRecord,
  type AutomationPreferredSkill,
  type AutomationRunRecord,
  type AutomationRunStatus,
  type CreateAutomationJobInput,
  type FriendlySchedule,
  type UpdateAutomationJobInput,
} from './types';

const VALID_PREFERRED_SKILLS = new Set<AutomationPreferredSkill>([
  'auto',
  'image_generation',
  'video_generation',
  'ad_localization',
  'qmd',
  'qmd_search',
]);
const STALE_AUTOMATION_RUN_TTL_MS = 15 * 60_000;

type AutomationSessionMetadata = {
  sessionId: string;
  title: string | null;
};

function toIsoString(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function normalizeString(value: unknown, field: string, maxLength = 4000): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} is required.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required.`);
  }
  return trimmed.slice(0, maxLength);
}

function normalizePreferredSkill(value: unknown): AutomationPreferredSkill {
  const normalized = typeof value === 'string' ? value.trim() : 'auto';
  if (normalized === 'qmd_search') {
    return 'qmd';
  }
  if (VALID_PREFERRED_SKILLS.has(normalized as AutomationPreferredSkill)) {
    return normalized as AutomationPreferredSkill;
  }
  return 'auto';
}

function normalizeWorkspaceContextPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const paths = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().replace(/^\/+/, '').replace(/^\.\/+/, ''))
    .filter(Boolean)
    .slice(0, 20);

  for (const candidate of paths) {
    validatePath(candidate);
  }

  return Array.from(new Set(paths));
}

function normalizeTargetOutputPath(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error('Target output path must be a string.');
  }

  const normalized = value.trim().replace(/^\/+/, '').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!normalized) {
    return null;
  }

  validatePath(normalized);
  return normalized;
}

function mapJobRow(row: typeof automationJobs.$inferSelect): AutomationJobRecord {
  const schedule = JSON.parse(row.scheduleConfigJson) as FriendlySchedule;
  const workspaceContextPaths = JSON.parse(row.workspaceContextPathsJson) as string[];
  const targetOutputPath = row.targetOutputPath;

  return {
    id: row.id,
    name: row.name,
    status: row.status as AutomationJobRecord['status'],
    prompt: row.prompt,
    preferredSkill: normalizePreferredSkill(row.preferredSkill),
    workspaceContextPaths,
    targetOutputPath,
    effectiveTargetOutputPath: getEffectiveAutomationTargetOutputPath({ name: row.name, targetOutputPath }),
    schedule,
    timeZone: row.timeZone,
    nextRunAt: toIsoString(row.nextRunAt),
    lastRunAt: toIsoString(row.lastRunAt),
    lastRunStatus: (row.lastRunStatus as AutomationRunStatus | null) ?? null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapRunRow(
  row: typeof automationRuns.$inferSelect,
  sessionMetadata?: AutomationSessionMetadata | null,
): AutomationRunRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    status: row.status as AutomationRunRecord['status'],
    triggerType: row.triggerType as AutomationRunRecord['triggerType'],
    scheduledFor: toIsoString(row.scheduledFor),
    startedAt: toIsoString(row.startedAt),
    finishedAt: toIsoString(row.finishedAt),
    attemptNumber: row.attemptNumber,
    outputDir: row.outputDir,
    targetOutputPath: row.targetOutputPath,
    effectiveTargetOutputPath: row.effectiveTargetOutputPath,
    logPath: row.logPath,
    resultPath: row.resultPath,
    errorMessage: row.errorMessage,
    piSessionId: row.piSessionId,
    piSessionTitle: sessionMetadata?.title ?? null,
    hasPersistedSession: Boolean(row.piSessionId && sessionMetadata),
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadAutomationSessionMetadata(sessionIds: string[]): Promise<Map<string, AutomationSessionMetadata>> {
  const uniqueSessionIds = Array.from(new Set(sessionIds.filter(Boolean)));
  if (uniqueSessionIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      sessionId: piSessions.sessionId,
      title: piSessions.title,
    })
    .from(piSessions)
    .where(inArray(piSessions.sessionId, uniqueSessionIds));

  return new Map(
    rows.map((row) => [
      row.sessionId,
      {
        sessionId: row.sessionId,
        title: row.title,
      },
    ]),
  );
}

async function mapRunRows(rows: Array<typeof automationRuns.$inferSelect>): Promise<AutomationRunRecord[]> {
  const sessionMetadata = await loadAutomationSessionMetadata(
    rows.map((row) => row.piSessionId).filter((value): value is string => Boolean(value)),
  );

  return rows.map((row) => mapRunRow(row, row.piSessionId ? sessionMetadata.get(row.piSessionId) ?? null : null));
}

export async function listAutomationJobs(): Promise<AutomationJobRecord[]> {
  const rows = await db
    .select()
    .from(automationJobs)
    .orderBy(asc(automationJobs.name), asc(automationJobs.createdAt));

  return rows.map(mapJobRow);
}

export async function getAutomationJob(jobId: string): Promise<AutomationJobRecord | null> {
  const row = await db.query.automationJobs.findFirst({
    where: eq(automationJobs.id, jobId),
  });

  return row ? mapJobRow(row) : null;
}

export async function listAutomationRuns(jobId: string): Promise<AutomationRunRecord[]> {
  const rows = await db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.jobId, jobId))
    .orderBy(desc(automationRuns.createdAt))
    .limit(100);

  return mapRunRows(rows);
}

export async function getAutomationRun(runId: string): Promise<AutomationRunRecord | null> {
  const row = await db.query.automationRuns.findFirst({
    where: eq(automationRuns.id, runId),
  });

  if (!row) {
    return null;
  }

  const sessionMetadata = row.piSessionId ? await loadAutomationSessionMetadata([row.piSessionId]) : new Map();
  return mapRunRow(row, row.piSessionId ? sessionMetadata.get(row.piSessionId) ?? null : null);
}

export async function createAutomationJob(input: CreateAutomationJobInput, userId: string): Promise<AutomationJobRecord> {
  const name = normalizeString(input.name, 'Name', 120);
  const prompt = normalizeString(input.prompt, 'Prompt', 12_000);
  const preferredSkill = normalizePreferredSkill(input.preferredSkill);
  const workspaceContextPaths = normalizeWorkspaceContextPaths(input.workspaceContextPaths);
  const targetOutputPath = normalizeTargetOutputPath(input.targetOutputPath);
  const { schedule, error } = validateFriendlySchedule(input.schedule);
  if (!schedule || error) {
    throw new Error(error || 'Schedule is invalid.');
  }

  const now = new Date();
  const nextRunAt = input.status === 'paused' ? null : computeNextRunAt(schedule, { from: now });
  const id = `job-${randomUUID()}`;

  const [inserted] = await db
    .insert(automationJobs)
    .values({
      id,
      name,
      status: input.status || 'active',
      prompt,
      preferredSkill,
      workspaceContextPathsJson: JSON.stringify(workspaceContextPaths),
      targetOutputPath,
      scheduleKind: schedule.kind,
      scheduleConfigJson: JSON.stringify(schedule),
      timeZone: schedule.timeZone,
      nextRunAt,
      lastRunAt: null,
      lastRunStatus: null,
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return mapJobRow(inserted);
}

export async function updateAutomationJob(jobId: string, input: UpdateAutomationJobInput): Promise<AutomationJobRecord | null> {
  const existing = await db.query.automationJobs.findFirst({
    where: eq(automationJobs.id, jobId),
  });
  if (!existing) {
    return null;
  }

  const currentSchedule = JSON.parse(existing.scheduleConfigJson) as FriendlySchedule;
  const scheduleCandidate = input.schedule ?? currentSchedule;
  const { schedule, error } = validateFriendlySchedule(scheduleCandidate);
  if (!schedule || error) {
    throw new Error(error || 'Schedule is invalid.');
  }

  const status = input.status ?? (existing.status as AutomationJobRecord['status']);
  const nextRunAt = status === 'paused'
    ? null
    : computeNextRunAt(schedule, { from: new Date(), lastRunAt: existing.lastRunAt });

  const [updated] = await db
    .update(automationJobs)
    .set({
      name: input.name ? normalizeString(input.name, 'Name', 120) : existing.name,
      prompt: input.prompt ? normalizeString(input.prompt, 'Prompt', 12_000) : existing.prompt,
      preferredSkill: input.preferredSkill ? normalizePreferredSkill(input.preferredSkill) : (existing.preferredSkill as AutomationPreferredSkill),
      workspaceContextPathsJson: input.workspaceContextPaths
        ? JSON.stringify(normalizeWorkspaceContextPaths(input.workspaceContextPaths))
        : existing.workspaceContextPathsJson,
      targetOutputPath: input.targetOutputPath === undefined
        ? existing.targetOutputPath
        : normalizeTargetOutputPath(input.targetOutputPath),
      status,
      scheduleKind: schedule.kind,
      scheduleConfigJson: JSON.stringify(schedule),
      timeZone: schedule.timeZone,
      nextRunAt,
      lastRunStatus: input.lastRunStatus === undefined ? existing.lastRunStatus : input.lastRunStatus,
      updatedAt: new Date(),
    })
    .where(eq(automationJobs.id, jobId))
    .returning();

  return mapJobRow(updated);
}

export async function deleteAutomationJob(jobId: string): Promise<boolean> {
  await db.delete(automationRuns).where(eq(automationRuns.jobId, jobId));
  const existing = await getAutomationJob(jobId);
  if (!existing) {
    return false;
  }
  await db.delete(automationJobs).where(eq(automationJobs.id, jobId));
  return true;
}

export async function createPendingAutomationRun(jobId: string, triggerType: AutomationRunRecord['triggerType']): Promise<AutomationRunRecord> {
  const job = await db.query.automationJobs.findFirst({
    where: eq(automationJobs.id, jobId),
  });
  if (!job) {
    throw new Error('Automation job not found.');
  }

  const now = new Date();
  const [inserted] = await db
    .insert(automationRuns)
    .values({
      id: `run-${randomUUID()}`,
      jobId,
      status: 'pending',
      triggerType,
      scheduledFor: now,
      startedAt: null,
      finishedAt: null,
      attemptNumber: 1,
      outputDir: null,
      targetOutputPath: null,
      effectiveTargetOutputPath: null,
      logPath: null,
      resultPath: null,
      errorMessage: null,
      piSessionId: null,
      createdAt: now,
    })
    .returning();

  await db
    .update(automationJobs)
    .set({
      lastRunStatus: 'pending',
      updatedAt: now,
    })
    .where(and(eq(automationJobs.id, jobId), eq(automationJobs.status, job.status)));

  return mapRunRow(inserted, null);
}

export async function listDueAutomationJobs(now = new Date()): Promise<AutomationJobRecord[]> {
  const rows = await db
    .select()
    .from(automationJobs)
    .where(
      and(
        eq(automationJobs.status, 'active'),
        lte(automationJobs.nextRunAt, now),
      ),
    )
    .orderBy(asc(automationJobs.nextRunAt));

  return rows.map(mapJobRow);
}

export async function listExecutableAutomationRuns(now = new Date()): Promise<AutomationRunRecord[]> {
  const rows = await db
    .select()
    .from(automationRuns)
    .where(
      and(
        or(eq(automationRuns.status, 'pending'), eq(automationRuns.status, 'retry_scheduled')),
        lte(automationRuns.scheduledFor, now),
      ),
    )
    .orderBy(asc(automationRuns.createdAt));

  return mapRunRows(rows);
}

async function failStaleAutomationRuns(jobId: string, now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - STALE_AUTOMATION_RUN_TTL_MS);
  const staleRuns = await db
    .select()
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.jobId, jobId),
        eq(automationRuns.status, 'running'),
        lte(automationRuns.startedAt, staleBefore),
      ),
    );

  for (const run of staleRuns) {
    await db
      .update(automationRuns)
      .set({
        status: 'failed',
        errorMessage: 'Automation run was marked stale before a new run could start.',
        finishedAt: now,
      })
      .where(eq(automationRuns.id, run.id));

    await db
      .update(automationJobs)
      .set({
        lastRunAt: now,
        lastRunStatus: 'failed',
        updatedAt: now,
      })
      .where(eq(automationJobs.id, run.jobId));
  }

  return staleRuns.length;
}

export async function hasInFlightAutomationRun(jobId: string): Promise<boolean> {
  const row = await db.query.automationRuns.findFirst({
    where: and(
      eq(automationRuns.jobId, jobId),
      notInArray(automationRuns.status, ['success', 'failed']),
    ),
  });

  return Boolean(row);
}

export async function scheduleAutomationJobRun(jobId: string, triggerType: AutomationRunRecord['triggerType'], scheduledFor: Date): Promise<AutomationRunRecord> {
  await failStaleAutomationRuns(jobId);
  const inFlight = await hasInFlightAutomationRun(jobId);
  if (inFlight) {
    throw new Error('Automation already has an in-flight run.');
  }

  const now = new Date();
  const [inserted] = await db
    .insert(automationRuns)
    .values({
      id: `run-${randomUUID()}`,
      jobId,
      status: 'pending',
      triggerType,
      scheduledFor,
      startedAt: null,
      finishedAt: null,
      attemptNumber: 1,
      outputDir: null,
      targetOutputPath: null,
      effectiveTargetOutputPath: null,
      logPath: null,
      resultPath: null,
      errorMessage: null,
      piSessionId: null,
      createdAt: now,
    })
    .returning();

  await db
    .update(automationJobs)
    .set({
      lastRunStatus: 'pending',
      updatedAt: now,
    })
    .where(eq(automationJobs.id, jobId));

  return mapRunRow(inserted, null);
}

export async function advanceAutomationJobSchedule(jobId: string, anchor = new Date()): Promise<void> {
  const job = await getAutomationJob(jobId);
  if (!job) {
    return;
  }

  const nextRunAt = job.status === 'paused'
    ? null
    : computeNextRunAt(job.schedule, { from: anchor, lastRunAt: job.lastRunAt ? new Date(job.lastRunAt) : null });

  await db
    .update(automationJobs)
    .set({
      nextRunAt,
      updatedAt: new Date(),
    })
    .where(eq(automationJobs.id, jobId));
}

export async function markAutomationRunStarted(
  runId: string,
  values: {
    outputDir: string;
    targetOutputPath: string | null;
    effectiveTargetOutputPath: string;
    logPath: string;
    resultPath: string;
    piSessionId: string;
  },
): Promise<AutomationRunRecord | null> {
  const [updated] = await db
    .update(automationRuns)
    .set({
      status: 'running',
      startedAt: new Date(),
      finishedAt: null,
      outputDir: values.outputDir,
      targetOutputPath: values.targetOutputPath,
      effectiveTargetOutputPath: values.effectiveTargetOutputPath,
      logPath: values.logPath,
      resultPath: values.resultPath,
      errorMessage: null,
      piSessionId: values.piSessionId,
    })
    .where(
      and(
        eq(automationRuns.id, runId),
        or(eq(automationRuns.status, 'pending'), eq(automationRuns.status, 'retry_scheduled')),
      ),
    )
    .returning();

  return updated ? mapRunRow(updated, null) : null;
}

export async function markAutomationRunRetryScheduled(
  runId: string,
  nextAttemptAt: Date,
  errorMessage: string,
): Promise<AutomationRunRecord | null> {
  const current = await db.query.automationRuns.findFirst({
    where: eq(automationRuns.id, runId),
  });
  if (!current) {
    return null;
  }

  const [updated] = await db
    .update(automationRuns)
    .set({
      status: 'retry_scheduled',
      scheduledFor: nextAttemptAt,
      errorMessage,
      finishedAt: new Date(),
      attemptNumber: current.attemptNumber + 1,
    })
    .where(eq(automationRuns.id, runId))
    .returning();

  await db
    .update(automationJobs)
    .set({
      lastRunStatus: 'retry_scheduled',
      updatedAt: new Date(),
    })
    .where(eq(automationJobs.id, current.jobId));

  return updated ? mapRunRow(updated, null) : null;
}

export async function markAutomationRunFinished(
  runId: string,
  values: {
    status: 'success' | 'failed';
    errorMessage?: string | null;
  },
): Promise<AutomationRunRecord | null> {
  const current = await db.query.automationRuns.findFirst({
    where: eq(automationRuns.id, runId),
  });
  if (!current) {
    return null;
  }

  const now = new Date();
  const [updated] = await db
    .update(automationRuns)
    .set({
      status: values.status,
      errorMessage: values.errorMessage ?? null,
      finishedAt: now,
    })
    .where(eq(automationRuns.id, runId))
    .returning();

  await db
    .update(automationJobs)
    .set({
      lastRunAt: now,
      lastRunStatus: values.status,
      updatedAt: now,
    })
    .where(eq(automationJobs.id, current.jobId));

  return updated ? mapRunRow(updated, null) : null;
}

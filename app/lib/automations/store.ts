import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { automationJobs, automationRuns } from '@/app/lib/db/schema';
import { validatePath } from '@/app/lib/filesystem/workspace-files';

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
  'qmd_search',
]);

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

function mapJobRow(row: typeof automationJobs.$inferSelect): AutomationJobRecord {
  const schedule = JSON.parse(row.scheduleConfigJson) as FriendlySchedule;
  const workspaceContextPaths = JSON.parse(row.workspaceContextPathsJson) as string[];

  return {
    id: row.id,
    name: row.name,
    status: row.status as AutomationJobRecord['status'],
    prompt: row.prompt,
    preferredSkill: row.preferredSkill as AutomationPreferredSkill,
    workspaceContextPaths,
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

function mapRunRow(row: typeof automationRuns.$inferSelect): AutomationRunRecord {
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
    logPath: row.logPath,
    resultPath: row.resultPath,
    errorMessage: row.errorMessage,
    piSessionId: row.piSessionId,
    createdAt: row.createdAt.toISOString(),
  };
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

  return rows.map(mapRunRow);
}

export async function getAutomationRun(runId: string): Promise<AutomationRunRecord | null> {
  const row = await db.query.automationRuns.findFirst({
    where: eq(automationRuns.id, runId),
  });

  return row ? mapRunRow(row) : null;
}

export async function createAutomationJob(input: CreateAutomationJobInput, userId: string): Promise<AutomationJobRecord> {
  const name = normalizeString(input.name, 'Name', 120);
  const prompt = normalizeString(input.prompt, 'Prompt', 12_000);
  const preferredSkill = normalizePreferredSkill(input.preferredSkill);
  const workspaceContextPaths = normalizeWorkspaceContextPaths(input.workspaceContextPaths);
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

  return mapRunRow(inserted);
}

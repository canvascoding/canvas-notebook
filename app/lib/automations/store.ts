import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, lte, notInArray, or } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { automationJobs, automationRuns, composioWebhookEvents, piSessions } from '@/app/lib/db/schema';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { validatePath } from '@/app/lib/filesystem/workspace-files';

import { getEffectiveAutomationTargetOutputPath } from './paths';
import { computeNextRunAt, validateFriendlySchedule } from './schedule';
import {
  type AutomationJobRecord,
  type AutomationJobStatus,
  type AutomationJobType,
  type AutomationPreferredSkill,
  type AutomationRunRecord,
  type AutomationRunStatus,
  type CreateAutomationJobInput,
  type CreateWebhookAutomationJobInput,
  type FriendlySchedule,
  type UpdateAutomationJobInput,
} from './types';

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

function ensurePreferredSkill(value: unknown): AutomationPreferredSkill {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return 'auto';
  return normalized.slice(0, 120);
}

function normalizeAgentId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) {
    return DEFAULT_MANAGED_AGENT_ID;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error('Agent ID is invalid.');
  }
  return normalized;
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

function parseOptionalJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
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
    preferredSkill: ensurePreferredSkill(row.preferredSkill),
    workspaceContextPaths,
    targetOutputPath,
    effectiveTargetOutputPath: getEffectiveAutomationTargetOutputPath({ name: row.name, targetOutputPath }),
    schedule,
    timeZone: row.timeZone,
    nextRunAt: toIsoString(row.nextRunAt),
    lastRunAt: toIsoString(row.lastRunAt),
    lastRunStatus: (row.lastRunStatus as AutomationRunStatus | null) ?? null,
    createdByUserId: row.createdByUserId,
    agentId: row.agentId || DEFAULT_MANAGED_AGENT_ID,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    jobType: (row.jobType as AutomationJobType) || 'default',
    channelId: row.channelId ?? null,
    composioTriggerId: row.composioTriggerId ?? null,
    composioTriggerSlug: row.composioTriggerSlug ?? null,
    composioToolkitSlug: row.composioToolkitSlug ?? null,
    composioConnectedAccountId: row.composioConnectedAccountId ?? null,
    composioUserId: row.composioUserId ?? null,
    webhookTriggerConfig: parseOptionalJsonObject(row.webhookTriggerConfigJson),
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
    resultText: row.resultText ?? null,
    createdAt: row.createdAt.toISOString(),
    // Parse metadata from JSON strings
    eventsLog: row.eventsLog ? (JSON.parse(row.eventsLog) as string[]) : null,
    metadataJson: row.metadataJson ? (JSON.parse(row.metadataJson) as Record<string, unknown>) : null,
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

export async function listAutomationJobs(userId: string): Promise<AutomationJobRecord[]> {
  const rows = await db
    .select()
    .from(automationJobs)
    .where(
      and(
        eq(automationJobs.createdByUserId, userId),
        or(
          eq(automationJobs.jobType, 'default'),
          eq(automationJobs.jobType, 'webhook'),
        ),
      ),
    )
    .orderBy(asc(automationJobs.name), asc(automationJobs.createdAt));

  return rows.map(mapJobRow);
}

export async function getAutomationJobByComposioTriggerId(triggerId: string): Promise<AutomationJobRecord | null> {
  const row = await db.query.automationJobs.findFirst({
    where: eq(automationJobs.composioTriggerId, triggerId),
  });

  return row ? mapJobRow(row) : null;
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
  const preferredSkill = ensurePreferredSkill(input.preferredSkill);
  const agentId = normalizeAgentId(input.agentId);
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
      agentId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  console.log(`[Automationen] Created job "${name}" (${id}, schedule=${schedule.kind}, nextRunAt=${nextRunAt?.toISOString() ?? 'null'})`);
  return mapJobRow(inserted);
}

export async function createWebhookAutomationJob(input: CreateWebhookAutomationJobInput, userId: string): Promise<AutomationJobRecord> {
  const name = normalizeString(input.name, 'Name', 120);
  const prompt = normalizeString(input.prompt, 'Prompt', 12_000);
  const preferredSkill = ensurePreferredSkill(input.preferredSkill);
  const agentId = normalizeAgentId(input.agentId);
  const workspaceContextPaths = normalizeWorkspaceContextPaths(input.workspaceContextPaths);
  const targetOutputPath = normalizeTargetOutputPath(input.targetOutputPath);
  const composioTriggerId = normalizeString(input.composioTriggerId, 'Composio trigger ID', 500);
  const composioTriggerSlug = normalizeString(input.composioTriggerSlug, 'Composio trigger slug', 500);
  const composioToolkitSlug = normalizeString(input.composioToolkitSlug, 'Composio toolkit slug', 120);
  const composioConnectedAccountId = normalizeString(input.composioConnectedAccountId, 'Composio connected account ID', 500);
  const composioUserId = normalizeString(input.composioUserId, 'Composio user ID', 500);
  const now = new Date();
  const id = `job-${randomUUID()}`;
  const schedule: FriendlySchedule = {
    kind: 'webhook',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };

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
      scheduleKind: 'webhook',
      scheduleConfigJson: JSON.stringify(schedule),
      timeZone: schedule.timeZone,
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: null,
      createdByUserId: userId,
      agentId,
      createdAt: now,
      updatedAt: now,
      jobType: 'webhook',
      composioTriggerId,
      composioTriggerSlug,
      composioToolkitSlug,
      composioConnectedAccountId,
      composioUserId,
      webhookTriggerConfigJson: JSON.stringify(input.webhookTriggerConfig || {}),
    })
    .returning();

  console.log(`[Automationen] Created webhook job "${name}" (${id}, trigger=${composioTriggerId})`);
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
      preferredSkill: input.preferredSkill === undefined
        ? ensurePreferredSkill(existing.preferredSkill)
        : ensurePreferredSkill(input.preferredSkill),
      workspaceContextPathsJson: input.workspaceContextPaths
        ? JSON.stringify(normalizeWorkspaceContextPaths(input.workspaceContextPaths))
        : existing.workspaceContextPathsJson,
      targetOutputPath: input.targetOutputPath === undefined
        ? existing.targetOutputPath
        : normalizeTargetOutputPath(input.targetOutputPath),
      agentId: input.agentId === undefined ? existing.agentId : normalizeAgentId(input.agentId),
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

  console.log(`[Automationen] Updated job ${jobId} (status=${status}, schedule=${schedule.kind})`);
  return mapJobRow(updated);
}

export async function deleteAutomationJob(jobId: string): Promise<boolean> {
  return db.transaction((tx) => {
    const existing = tx.select().from(automationJobs).where(eq(automationJobs.id, jobId)).limit(1).get();
    if (!existing) {
      return false;
    }
    tx.delete(automationRuns).where(eq(automationRuns.jobId, jobId)).run();
    tx.delete(automationJobs).where(eq(automationJobs.id, jobId)).run();

    console.log(`[Automationen] Deleted job ${jobId} and associated runs`);
    return true;
  });
}

export async function createPendingAutomationRun(
  jobId: string,
  triggerType: AutomationRunRecord['triggerType'],
  options: { metadataJson?: Record<string, unknown> } = {},
): Promise<AutomationRunRecord> {
  return db.transaction((tx) => {
    const job = tx.query.automationJobs.findFirst({
      where: eq(automationJobs.id, jobId),
    }).sync();
    if (!job) {
      throw new Error('Automation job not found.');
    }

    const now = new Date();
    const [inserted] = tx
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
        resultText: null,
        metadataJson: options.metadataJson ? JSON.stringify(options.metadataJson) : null,
        createdAt: now,
      })
      .returning()
      .all();

    tx
      .update(automationJobs)
      .set({
        lastRunStatus: 'pending',
        updatedAt: now,
      })
      .where(and(eq(automationJobs.id, jobId), eq(automationJobs.status, job.status)))
      .run();

    return mapRunRow(inserted, null);
  });
}

export async function getComposioWebhookEventByKeys(keys: { eventId?: string | null; webhookId?: string | null }) {
  const clauses = [
    keys.eventId ? eq(composioWebhookEvents.eventId, keys.eventId) : null,
    keys.webhookId ? eq(composioWebhookEvents.webhookId, keys.webhookId) : null,
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (clauses.length === 0) return null;
  const row = await db.query.composioWebhookEvents.findFirst({
    where: clauses.length === 1 ? clauses[0] : or(...clauses),
  });
  return row ?? null;
}

export async function recordComposioWebhookEvent(input: {
  eventId?: string | null;
  webhookId?: string | null;
  triggerId?: string | null;
  jobId?: string | null;
  runId?: string | null;
  source: string;
  status: string;
  error?: string | null;
  metadataJson?: Record<string, unknown> | null;
}) {
  const now = new Date();
  const [inserted] = await db
    .insert(composioWebhookEvents)
    .values({
      id: `composio-event-${randomUUID()}`,
      eventId: input.eventId || null,
      webhookId: input.webhookId || null,
      triggerId: input.triggerId || null,
      jobId: input.jobId || null,
      runId: input.runId || null,
      source: input.source,
      status: input.status,
      error: input.error || null,
      metadataJson: input.metadataJson ? JSON.stringify(input.metadataJson) : null,
      receivedAt: now,
      updatedAt: now,
    })
    .returning();
  return inserted;
}

export async function markComposioWebhookEventDispatched(id: string, runId: string) {
  await db
    .update(composioWebhookEvents)
    .set({
      runId,
      status: 'dispatched',
      updatedAt: new Date(),
    })
    .where(eq(composioWebhookEvents.id, id));
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

  if (staleRuns.length > 0) {
    console.warn(`[Automationen] Marking ${staleRuns.length} stale run(s) as failed for job ${jobId}`);
    db.transaction((tx) => {
      for (const run of staleRuns) {
        tx
          .update(automationRuns)
          .set({
            status: 'failed',
            errorMessage: 'Automation run was marked stale before a new run could start.',
            finishedAt: now,
          })
          .where(eq(automationRuns.id, run.id))
          .run();

        tx
          .update(automationJobs)
          .set({
            lastRunAt: now,
            lastRunStatus: 'failed',
            updatedAt: now,
          })
          .where(eq(automationJobs.id, run.jobId))
          .run();
      }
    });
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

export async function scheduleAutomationJobRun(jobId: string, triggerType: AutomationRunRecord['triggerType'], scheduledFor: Date): Promise<AutomationRunRecord | null> {
  await failStaleAutomationRuns(jobId);

  return db.transaction((tx) => {
    const job = tx.query.automationJobs.findFirst({
      where: eq(automationJobs.id, jobId),
    }).sync();
    if (!job) {
      throw new Error('Automation job not found.');
    }

    const inFlightRun = tx.query.automationRuns.findFirst({
      where: and(
        eq(automationRuns.jobId, jobId),
        notInArray(automationRuns.status, ['success', 'failed']),
      ),
    }).sync();
    if (inFlightRun) {
      console.log(`[Automationen] Skipping run creation for job ${jobId}: in-flight run ${inFlightRun.id} already exists`);
      return null;
    }

    const now = new Date();
    const [inserted] = tx
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
        resultText: null,
        createdAt: now,
      })
      .returning()
      .all();

    tx
      .update(automationJobs)
      .set({
        lastRunStatus: 'pending',
        updatedAt: now,
      })
      .where(eq(automationJobs.id, jobId))
      .run();

    return mapRunRow(inserted, null);
  });
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
    outputDir: string | null;
    targetOutputPath: string | null;
    effectiveTargetOutputPath: string | null;
    logPath: string;
    resultPath: string | null;
    piSessionId: string;
    eventsLog: string[];
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
      resultText: null,
      eventsLog: JSON.stringify(values.eventsLog),
    })
    .where(
      and(
        eq(automationRuns.id, runId),
        or(eq(automationRuns.status, 'pending'), eq(automationRuns.status, 'retry_scheduled')),
      ),
    )
    .returning();

  if (!updated) {
    console.warn(`[Automationen] markAutomationRunStarted: run ${runId} not in pending/retry_scheduled state, skipping`);
  } else {
    console.log(`[Automationen] Run ${runId} started (piSessionId=${values.piSessionId})`);
  }

  return updated ? mapRunRow(updated, null) : null;
}

export async function markAutomationRunRetryScheduled(
  runId: string,
  nextAttemptAt: Date,
  errorMessage: string,
  eventsLog: string[],
  metadataJson: Record<string, unknown>,
  resultText?: string | null,
): Promise<AutomationRunRecord | null> {
  return db.transaction((tx) => {
    const current = tx.query.automationRuns.findFirst({
      where: eq(automationRuns.id, runId),
    }).sync();
    if (!current) {
      return null;
    }

    const [updated] = tx
      .update(automationRuns)
      .set({
        status: 'retry_scheduled',
        scheduledFor: nextAttemptAt,
        errorMessage,
        resultText: resultText ?? current.resultText,
        finishedAt: new Date(),
        attemptNumber: current.attemptNumber + 1,
        eventsLog: JSON.stringify(eventsLog),
        metadataJson: JSON.stringify({
          ...(current.metadataJson ? JSON.parse(current.metadataJson) as Record<string, unknown> : {}),
          ...metadataJson,
        }),
      })
      .where(eq(automationRuns.id, runId))
      .returning()
      .all();

    tx
      .update(automationJobs)
      .set({
        lastRunStatus: 'retry_scheduled',
        updatedAt: new Date(),
      })
      .where(eq(automationJobs.id, current.jobId))
      .run();

    console.warn(`[Automationen] Run ${runId} marked as retry_scheduled (attempt=${current.attemptNumber + 1}, nextAttemptAt=${nextAttemptAt.toISOString()})`);

    return updated ? mapRunRow(updated, null) : null;
  });
}

export async function markAutomationRunFinished(
  runId: string,
  values: {
    status: 'success' | 'failed';
    errorMessage?: string | null;
    piSessionId?: string | null;
    resultText?: string | null;
    eventsLog: string[];
    metadataJson: Record<string, unknown>;
  },
): Promise<AutomationRunRecord | null> {
  return db.transaction((tx) => {
    const current = tx.query.automationRuns.findFirst({
      where: eq(automationRuns.id, runId),
    }).sync();
    if (!current) {
      return null;
    }

    const now = new Date();
    const [updated] = tx
      .update(automationRuns)
      .set({
        status: values.status,
        errorMessage: values.errorMessage ?? null,
        piSessionId: values.piSessionId ?? current.piSessionId,
        resultText: values.resultText ?? current.resultText,
        finishedAt: now,
        eventsLog: JSON.stringify(values.eventsLog),
        metadataJson: JSON.stringify({
          ...(current.metadataJson ? JSON.parse(current.metadataJson) as Record<string, unknown> : {}),
          ...values.metadataJson,
        }),
      })
      .where(eq(automationRuns.id, runId))
      .returning()
      .all();

    tx
      .update(automationJobs)
      .set({
        lastRunAt: now,
        lastRunStatus: values.status,
        updatedAt: now,
      })
      .where(eq(automationJobs.id, current.jobId))
      .run();

    console.log(`[Automationen] Run ${runId} finished (status=${values.status}, job=${current.jobId})`);

    return updated ? mapRunRow(updated, null) : null;
  });
}

export async function getHeartbeatJob(): Promise<AutomationJobRecord | null> {
  const row = await db.query.automationJobs.findFirst({
    where: eq(automationJobs.jobType, 'heartbeat'),
  });

  return row ? mapJobRow(row) : null;
}

export async function upsertHeartbeatJob(data: {
  enabled: boolean;
  schedule: FriendlySchedule;
  userId: string;
}): Promise<AutomationJobRecord> {
  const existing = await getHeartbeatJob();

  const status: AutomationJobStatus = data.enabled ? 'active' : 'paused';
  const nextRunAt = data.enabled
    ? computeNextRunAt(data.schedule, { from: new Date() })
    : null;

  if (existing) {
    const [updated] = await db
      .update(automationJobs)
      .set({
        status,
        scheduleKind: data.schedule.kind,
        scheduleConfigJson: JSON.stringify(data.schedule),
        timeZone: data.schedule.timeZone,
        nextRunAt,
        updatedAt: new Date(),
      })
      .where(eq(automationJobs.id, existing.id))
      .returning();

    console.log(`[Heartbeat] Updated heartbeat job ${existing.id} (status=${status}, schedule=${data.schedule.kind}, nextRunAt=${nextRunAt?.toISOString() ?? 'null'})`);
    return mapJobRow(updated);
  }

  const id = `job-heartbeat-${Date.now()}`;
  const now = new Date();

  const [inserted] = await db
    .insert(automationJobs)
    .values({
      id,
      name: 'Telegram Heartbeat',
      status,
      prompt: 'Heartbeat',
      preferredSkill: 'auto',
      workspaceContextPathsJson: '[]',
      targetOutputPath: null,
      scheduleKind: data.schedule.kind,
      scheduleConfigJson: JSON.stringify(data.schedule),
      timeZone: data.schedule.timeZone,
      nextRunAt,
      lastRunAt: null,
      lastRunStatus: null,
      createdByUserId: data.userId,
      createdAt: now,
      updatedAt: now,
      jobType: 'heartbeat',
      channelId: 'telegram',
    })
    .returning();

  console.log(`[Heartbeat] Created heartbeat job ${id} (status=${status}, schedule=${data.schedule.kind}, nextRunAt=${nextRunAt?.toISOString() ?? 'null'})`);
  return mapJobRow(inserted);
}

import { randomBytes, randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, lte, notInArray, or, sql } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { automationJobs, automationRuns, automationWebhookEvents, automationWebhookTriggers, composioWebhookEvents, piSessions } from '@/app/lib/db/schema';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { validatePath } from '@/app/lib/filesystem/workspace-files';
import { getUserPreferredTimeZone } from '@/app/lib/user-preferences';

import { getEffectiveAutomationTargetOutputPath } from './paths';
import { computeNextRunAt, validateFriendlySchedule } from './schedule';
import { generateAutomationWebhookSecret } from './webhook-secret';
import {
  assertCanAccessAutomationJob,
  getAutomationListAccess,
  resolveAutomationScopeForCreate,
  type AutomationPolicyUser,
} from './policy';
import {
  type AutomationJobRecord,
  type AutomationJobStatus,
  type AutomationActorType,
  type AutomationDeliveryMode,
  type AutomationDeliverySessionMode,
  type AutomationJobType,
  type AutomationPreferredSkill,
  type AutomationRunRecord,
  type AutomationRunStatus,
  type AutomationScope,
  type AutomationWorkspaceType,
  type CreateCustomWebhookAutomationJobInput,
  type CreateAutomationJobInput,
  type CreateWebhookAutomationJobInput,
  type FriendlySchedule,
  type UpdateAutomationJobInput,
} from './types';

const STALE_AUTOMATION_RUN_TTL_MS = 15 * 60_000;
const DEFAULT_DELIVERY_MODE: AutomationDeliveryMode = 'web';
const DEFAULT_DELIVERY_SESSION_MODE: AutomationDeliverySessionMode = 'new_session';
const DELIVERY_MODES = new Set<AutomationDeliveryMode>(['web', 'origin', 'session', 'channel_home', 'last_active', 'silent']);
const DELIVERY_SESSION_MODES = new Set<AutomationDeliverySessionMode>(['new_session', 'channel_active', 'fixed_session']);
const AUTOMATION_RUN_RESULT_PREVIEW_LENGTH = 1000;
const AUTOMATION_RUN_LOG_MAX_JSON_LENGTH = 250_000;

function stripLeadingPathDecorators(value: string): string {
  let next = value;
  while (next.startsWith('/')) {
    next = next.slice(1);
  }
  while (next.startsWith('./')) {
    next = next.slice(2);
  }
  return next;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

type AutomationSessionMetadata = {
  sessionId: string;
  title: string | null;
};

type AutomationWebhookTriggerRow = typeof automationWebhookTriggers.$inferSelect;
type AutomationRunMappableRow = Omit<typeof automationRuns.$inferSelect, 'eventsLog' | 'metadataJson'> & {
  eventsLog?: string | null;
  metadataJson?: string | null;
};
type AutomationPolicyPrincipal = AutomationPolicyUser | string;

export type AutomationWebhookTriggerRecord = {
  id: string;
  jobId: string;
  secretHash: string;
  secretPreview: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  rotatedAt: string | null;
};

export type AutomationWebhookEventRecord = typeof automationWebhookEvents.$inferSelect;

function toIsoString(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function normalizePolicyUser(user: AutomationPolicyPrincipal): AutomationPolicyUser {
  return typeof user === 'string' ? { id: user } : user;
}

function normalizeAutomationScope(value: unknown): AutomationScope {
  return value === 'organization' ? 'organization' : 'personal';
}

function normalizeAutomationWorkspaceType(value: unknown): AutomationWorkspaceType {
  if (value === 'team' || value === 'project') return value;
  return 'personal';
}

function normalizeAutomationActorType(value: unknown): AutomationActorType {
  return value === 'service' ? 'service' : 'user';
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

function generateAutomationWebhookId(): string {
  return `wh_${randomBytes(16).toString('hex')}`;
}

function normalizeOptionalShortString(value: unknown, maxLength = 500): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error('Expected a string value.');
  }
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeDeliveryMode(value: unknown): AutomationDeliveryMode {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return DEFAULT_DELIVERY_MODE;
  }
  if (!DELIVERY_MODES.has(normalized as AutomationDeliveryMode)) {
    throw new Error('Delivery mode is invalid.');
  }
  return normalized as AutomationDeliveryMode;
}

function normalizeDeliverySessionMode(value: unknown): AutomationDeliverySessionMode {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return DEFAULT_DELIVERY_SESSION_MODE;
  }
  if (!DELIVERY_SESSION_MODES.has(normalized as AutomationDeliverySessionMode)) {
    throw new Error('Delivery session mode is invalid.');
  }
  return normalized as AutomationDeliverySessionMode;
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

  const normalized = stripTrailingSlashes(stripLeadingPathDecorators(value.trim()));
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

function applyDefaultScheduleTimeZone(input: unknown, timeZone: string): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }

  const schedule = input as Record<string, unknown>;
  const existingTimeZone = typeof schedule.timeZone === 'string' ? schedule.timeZone.trim() : '';
  return {
    ...schedule,
    timeZone: existingTimeZone || timeZone,
  };
}

function mapAutomationWebhookTriggerRow(row: AutomationWebhookTriggerRow): AutomationWebhookTriggerRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    secretHash: row.secretHash,
    secretPreview: row.secretPreview,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    rotatedAt: toIsoString(row.rotatedAt),
  };
}

function mapJobRow(
  row: typeof automationJobs.$inferSelect,
  customWebhookTrigger?: AutomationWebhookTriggerRow | null,
): AutomationJobRecord {
  const schedule = JSON.parse(row.scheduleConfigJson) as FriendlySchedule;
  const workspaceContextPaths = JSON.parse(row.workspaceContextPathsJson) as string[];
  const targetOutputPath = row.targetOutputPath;

  return {
    id: row.id,
    name: row.name,
    status: row.status as AutomationJobRecord['status'],
    scope: normalizeAutomationScope(row.scope),
    organizationId: row.organizationId ?? null,
    workspaceId: row.workspaceId ?? null,
    workspaceType: normalizeAutomationWorkspaceType(row.workspaceType),
    ownerUserId: row.ownerUserId ?? (row.scope === 'organization' ? null : row.createdByUserId),
    responsibleUserId: row.responsibleUserId ?? row.createdByUserId,
    serviceActorId: row.serviceActorId ?? null,
    approvedByUserId: row.approvedByUserId ?? null,
    lastEditedByUserId: row.lastEditedByUserId ?? row.createdByUserId,
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
    deliveryMode: normalizeDeliveryMode(row.deliveryMode),
    deliveryChannelId: row.deliveryChannelId ?? null,
    deliverySessionMode: normalizeDeliverySessionMode(row.deliverySessionMode),
    deliverySessionId: row.deliverySessionId ?? null,
    deliveryChannelSessionKey: row.deliveryChannelSessionKey ?? null,
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
    customWebhookId: customWebhookTrigger?.id ?? null,
    customWebhookSecretPreview: customWebhookTrigger?.secretPreview ?? null,
    customWebhookStatus: customWebhookTrigger?.status ?? null,
    customWebhookCreatedAt: toIsoString(customWebhookTrigger?.createdAt),
    customWebhookRotatedAt: toIsoString(customWebhookTrigger?.rotatedAt),
  };
}

function mapRunRow(
  row: AutomationRunMappableRow,
  sessionMetadata?: AutomationSessionMetadata | null,
): AutomationRunRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    status: row.status as AutomationRunRecord['status'],
    scope: normalizeAutomationScope(row.scope),
    organizationId: row.organizationId ?? null,
    workspaceId: row.workspaceId ?? null,
    workspaceType: normalizeAutomationWorkspaceType(row.workspaceType),
    actorType: normalizeAutomationActorType(row.actorType),
    actorUserId: row.actorUserId ?? null,
    serviceActorId: row.serviceActorId ?? null,
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

async function mapRunRows(rows: AutomationRunMappableRow[]): Promise<AutomationRunRecord[]> {
  const sessionMetadata = await loadAutomationSessionMetadata(
    rows.map((row) => row.piSessionId).filter((value): value is string => Boolean(value)),
  );

  return rows.map((row) => mapRunRow(row, row.piSessionId ? sessionMetadata.get(row.piSessionId) ?? null : null));
}

async function loadAutomationWebhookTriggersByJobIds(jobIds: string[]): Promise<Map<string, AutomationWebhookTriggerRow>> {
  const uniqueJobIds = Array.from(new Set(jobIds.filter(Boolean)));
  if (uniqueJobIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select()
    .from(automationWebhookTriggers)
    .where(inArray(automationWebhookTriggers.jobId, uniqueJobIds));

  return new Map(rows.map((row) => [row.jobId, row]));
}

async function mapJobRowWithWebhookTrigger(row: typeof automationJobs.$inferSelect): Promise<AutomationJobRecord> {
  const triggers = await loadAutomationWebhookTriggersByJobIds([row.id]);
  return mapJobRow(row, triggers.get(row.id) ?? null);
}

export async function listAutomationJobs(userId: string): Promise<AutomationJobRecord[]> {
  const access = getAutomationListAccess(userId);
  const personalAccess = or(
    eq(automationJobs.ownerUserId, userId),
    eq(automationJobs.createdByUserId, userId),
  );
  const organizationAccess = access.canReadOrganizationAutomations && access.organizationId
    ? and(
        eq(automationJobs.scope, 'organization'),
        eq(automationJobs.organizationId, access.organizationId),
      )
    : null;

  const rows = await db
    .select()
    .from(automationJobs)
    .where(
      and(
        organizationAccess ? or(personalAccess, organizationAccess) : personalAccess,
        or(
          eq(automationJobs.jobType, 'default'),
          eq(automationJobs.jobType, 'webhook'),
        ),
      ),
    )
    .orderBy(asc(automationJobs.name), asc(automationJobs.createdAt));

  const customWebhookTriggers = await loadAutomationWebhookTriggersByJobIds(rows.map((row) => row.id));
  return rows.map((row) => mapJobRow(row, customWebhookTriggers.get(row.id) ?? null));
}

export async function getAutomationJobByComposioTriggerId(triggerId: string): Promise<AutomationJobRecord | null> {
  const row = await db.query.automationJobs.findFirst({
    where: eq(automationJobs.composioTriggerId, triggerId),
  });

  return row ? mapJobRowWithWebhookTrigger(row) : null;
}

export async function getAutomationJob(jobId: string): Promise<AutomationJobRecord | null> {
  const row = await db.query.automationJobs.findFirst({
    where: eq(automationJobs.id, jobId),
  });

  return row ? mapJobRowWithWebhookTrigger(row) : null;
}

export async function listAutomationRuns(jobId: string): Promise<AutomationRunRecord[]> {
  const rows = await db
    .select({
      id: automationRuns.id,
      jobId: automationRuns.jobId,
      status: automationRuns.status,
      scope: automationRuns.scope,
      organizationId: automationRuns.organizationId,
      workspaceId: automationRuns.workspaceId,
      workspaceType: automationRuns.workspaceType,
      actorType: automationRuns.actorType,
      actorUserId: automationRuns.actorUserId,
      serviceActorId: automationRuns.serviceActorId,
      triggerType: automationRuns.triggerType,
      scheduledFor: automationRuns.scheduledFor,
      startedAt: automationRuns.startedAt,
      finishedAt: automationRuns.finishedAt,
      attemptNumber: automationRuns.attemptNumber,
      outputDir: automationRuns.outputDir,
      targetOutputPath: automationRuns.targetOutputPath,
      effectiveTargetOutputPath: automationRuns.effectiveTargetOutputPath,
      logPath: automationRuns.logPath,
      resultPath: automationRuns.resultPath,
      errorMessage: automationRuns.errorMessage,
      piSessionId: automationRuns.piSessionId,
      resultText: sql<string | null>`substr(${automationRuns.resultText}, 1, ${AUTOMATION_RUN_RESULT_PREVIEW_LENGTH})`,
      eventsLog: sql<string | null>`NULL`,
      metadataJson: sql<string | null>`NULL`,
      createdAt: automationRuns.createdAt,
    })
    .from(automationRuns)
    .where(eq(automationRuns.jobId, jobId))
    .orderBy(desc(automationRuns.createdAt))
    .limit(100);

  return mapRunRows(rows);
}

export async function getAutomationRun(runId: string): Promise<AutomationRunRecord | null> {
  const [row] = await db
    .select({
      id: automationRuns.id,
      jobId: automationRuns.jobId,
      status: automationRuns.status,
      scope: automationRuns.scope,
      organizationId: automationRuns.organizationId,
      workspaceId: automationRuns.workspaceId,
      workspaceType: automationRuns.workspaceType,
      actorType: automationRuns.actorType,
      actorUserId: automationRuns.actorUserId,
      serviceActorId: automationRuns.serviceActorId,
      triggerType: automationRuns.triggerType,
      scheduledFor: automationRuns.scheduledFor,
      startedAt: automationRuns.startedAt,
      finishedAt: automationRuns.finishedAt,
      attemptNumber: automationRuns.attemptNumber,
      outputDir: automationRuns.outputDir,
      targetOutputPath: automationRuns.targetOutputPath,
      effectiveTargetOutputPath: automationRuns.effectiveTargetOutputPath,
      logPath: automationRuns.logPath,
      resultPath: automationRuns.resultPath,
      errorMessage: automationRuns.errorMessage,
      piSessionId: automationRuns.piSessionId,
      resultText: automationRuns.resultText,
      eventsLog: sql<string | null>`NULL`,
      metadataJson: automationRuns.metadataJson,
      createdAt: automationRuns.createdAt,
    })
    .from(automationRuns)
    .where(eq(automationRuns.id, runId))
    .limit(1);

  if (!row) {
    return null;
  }

  const sessionMetadata = row.piSessionId ? await loadAutomationSessionMetadata([row.piSessionId]) : new Map();
  return mapRunRow(row, row.piSessionId ? sessionMetadata.get(row.piSessionId) ?? null : null);
}

export async function getAutomationRunLogSnapshot(runId: string): Promise<{
  logPath: string | null;
  content: string;
  truncated: boolean;
} | null> {
  const [row] = await db
    .select({
      logPath: automationRuns.logPath,
      eventsLogLength: sql<number | null>`length(${automationRuns.eventsLog})`,
      eventsLog: sql<string | null>`
        CASE
          WHEN length(${automationRuns.eventsLog}) <= ${AUTOMATION_RUN_LOG_MAX_JSON_LENGTH}
          THEN ${automationRuns.eventsLog}
          ELSE NULL
        END
      `,
    })
    .from(automationRuns)
    .where(eq(automationRuns.id, runId))
    .limit(1);

  if (!row) {
    return null;
  }

  const isOversized = Boolean(row.eventsLogLength && row.eventsLogLength > AUTOMATION_RUN_LOG_MAX_JSON_LENGTH);
  if (isOversized) {
    return {
      logPath: row.logPath,
      content: `Run log is too large to load safely in the browser (${row.eventsLogLength} characters stored in SQLite).\nOpen the persisted chat session for the full conversation, or inspect the database directly.\n`,
      truncated: true,
    };
  }

  return {
    logPath: row.logPath,
    content: row.eventsLog ? (JSON.parse(row.eventsLog) as string[]).join('\n') + '\n' : '',
    truncated: false,
  };
}

export async function createAutomationJob(input: CreateAutomationJobInput, user: AutomationPolicyPrincipal): Promise<AutomationJobRecord> {
  const policyUser = normalizePolicyUser(user);
  const userId = policyUser.id;
  const name = normalizeString(input.name, 'Name', 120);
  const prompt = normalizeString(input.prompt, 'Prompt', 12_000);
  const preferredSkill = ensurePreferredSkill(input.preferredSkill);
  const agentId = normalizeAgentId(input.agentId);
  const deliveryMode = normalizeDeliveryMode(input.deliveryMode);
  const deliverySessionMode = normalizeDeliverySessionMode(input.deliverySessionMode);
  const workspaceContextPaths = normalizeWorkspaceContextPaths(input.workspaceContextPaths);
  const targetOutputPath = normalizeTargetOutputPath(input.targetOutputPath);
  const preferredTimeZone = await getUserPreferredTimeZone(userId);
  const { schedule, error } = validateFriendlySchedule(applyDefaultScheduleTimeZone(input.schedule, preferredTimeZone));
  if (!schedule || error) {
    throw new Error(error || 'Schedule is invalid.');
  }

  const automationScope = await resolveAutomationScopeForCreate(input, policyUser);
  const now = new Date();
  const nextRunAt = input.status === 'paused' ? null : computeNextRunAt(schedule, { from: now });
  const id = `job-${randomUUID()}`;

  const [inserted] = await db
    .insert(automationJobs)
    .values({
      id,
      name,
      status: input.status || 'active',
      scope: automationScope.scope,
      organizationId: automationScope.organizationId,
      workspaceId: automationScope.workspaceId,
      workspaceType: automationScope.workspaceType,
      ownerUserId: automationScope.ownerUserId,
      responsibleUserId: automationScope.responsibleUserId,
      serviceActorId: automationScope.serviceActorId,
      approvedByUserId: automationScope.approvedByUserId,
      lastEditedByUserId: automationScope.lastEditedByUserId,
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
      deliveryMode,
      deliveryChannelId: normalizeOptionalShortString(input.deliveryChannelId, 120),
      deliverySessionMode,
      deliverySessionId: normalizeOptionalShortString(input.deliverySessionId, 500),
      deliveryChannelSessionKey: normalizeOptionalShortString(input.deliveryChannelSessionKey, 500),
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  console.log(`[Automationen] Created job "${name}" (${id}, scope=${automationScope.scope}, workspace=${automationScope.workspaceId ?? 'legacy'}, schedule=${schedule.kind}, nextRunAt=${nextRunAt?.toISOString() ?? 'null'})`);
  return mapJobRow(inserted, null);
}

export async function createWebhookAutomationJob(input: CreateWebhookAutomationJobInput, user: AutomationPolicyPrincipal): Promise<AutomationJobRecord> {
  const policyUser = normalizePolicyUser(user);
  const userId = policyUser.id;
  const name = normalizeString(input.name, 'Name', 120);
  const prompt = normalizeString(input.prompt, 'Prompt', 12_000);
  const preferredSkill = ensurePreferredSkill(input.preferredSkill);
  const agentId = normalizeAgentId(input.agentId);
  const deliveryMode = normalizeDeliveryMode(input.deliveryMode);
  const deliverySessionMode = normalizeDeliverySessionMode(input.deliverySessionMode);
  const workspaceContextPaths = normalizeWorkspaceContextPaths(input.workspaceContextPaths);
  const targetOutputPath = normalizeTargetOutputPath(input.targetOutputPath);
  const composioTriggerId = normalizeString(input.composioTriggerId, 'Composio trigger ID', 500);
  const composioTriggerSlug = normalizeString(input.composioTriggerSlug, 'Composio trigger slug', 500);
  const composioToolkitSlug = normalizeString(input.composioToolkitSlug, 'Composio toolkit slug', 120);
  const composioConnectedAccountId = normalizeString(input.composioConnectedAccountId, 'Composio connected account ID', 500);
  const composioUserId = normalizeString(input.composioUserId, 'Composio user ID', 500);
  const now = new Date();
  const id = `job-${randomUUID()}`;
  const preferredTimeZone = await getUserPreferredTimeZone(userId);
  const automationScope = await resolveAutomationScopeForCreate(input, policyUser);
  const schedule: FriendlySchedule = {
    kind: 'webhook',
    timeZone: preferredTimeZone,
  };

  const [inserted] = await db
    .insert(automationJobs)
    .values({
      id,
      name,
      status: input.status || 'active',
      scope: automationScope.scope,
      organizationId: automationScope.organizationId,
      workspaceId: automationScope.workspaceId,
      workspaceType: automationScope.workspaceType,
      ownerUserId: automationScope.ownerUserId,
      responsibleUserId: automationScope.responsibleUserId,
      serviceActorId: automationScope.serviceActorId,
      approvedByUserId: automationScope.approvedByUserId,
      lastEditedByUserId: automationScope.lastEditedByUserId,
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
      deliveryMode,
      deliveryChannelId: normalizeOptionalShortString(input.deliveryChannelId, 120),
      deliverySessionMode,
      deliverySessionId: normalizeOptionalShortString(input.deliverySessionId, 500),
      deliveryChannelSessionKey: normalizeOptionalShortString(input.deliveryChannelSessionKey, 500),
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

  console.log(`[Automationen] Created webhook job "${name}" (${id}, scope=${automationScope.scope}, workspace=${automationScope.workspaceId ?? 'legacy'}, trigger=${composioTriggerId})`);
  return mapJobRow(inserted, null);
}

export async function createCustomWebhookAutomationJob(
  input: CreateCustomWebhookAutomationJobInput,
  user: AutomationPolicyPrincipal,
): Promise<{ job: AutomationJobRecord; secret: string }> {
  const policyUser = normalizePolicyUser(user);
  const userId = policyUser.id;
  const name = normalizeString(input.name, 'Name', 120);
  const prompt = normalizeString(input.prompt, 'Prompt', 12_000);
  const preferredSkill = ensurePreferredSkill(input.preferredSkill);
  const agentId = normalizeAgentId(input.agentId);
  const deliveryMode = normalizeDeliveryMode(input.deliveryMode);
  const deliverySessionMode = normalizeDeliverySessionMode(input.deliverySessionMode);
  const workspaceContextPaths = normalizeWorkspaceContextPaths(input.workspaceContextPaths);
  const targetOutputPath = normalizeTargetOutputPath(input.targetOutputPath);
  const now = new Date();
  const id = `job-${randomUUID()}`;
  const webhookId = generateAutomationWebhookId();
  const secret = generateAutomationWebhookSecret();
  const preferredTimeZone = await getUserPreferredTimeZone(userId);
  const automationScope = await resolveAutomationScopeForCreate(input, policyUser);
  const schedule: FriendlySchedule = {
    kind: 'webhook',
    timeZone: preferredTimeZone,
  };

  return db.transaction((tx) => {
    const [insertedJob] = tx
      .insert(automationJobs)
      .values({
        id,
        name,
        status: input.status || 'active',
        scope: automationScope.scope,
        organizationId: automationScope.organizationId,
        workspaceId: automationScope.workspaceId,
        workspaceType: automationScope.workspaceType,
        ownerUserId: automationScope.ownerUserId,
        responsibleUserId: automationScope.responsibleUserId,
        serviceActorId: automationScope.serviceActorId,
        approvedByUserId: automationScope.approvedByUserId,
        lastEditedByUserId: automationScope.lastEditedByUserId,
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
        deliveryMode,
        deliveryChannelId: normalizeOptionalShortString(input.deliveryChannelId, 120),
        deliverySessionMode,
        deliverySessionId: normalizeOptionalShortString(input.deliverySessionId, 500),
        deliveryChannelSessionKey: normalizeOptionalShortString(input.deliveryChannelSessionKey, 500),
        createdAt: now,
        updatedAt: now,
        jobType: 'webhook',
        webhookTriggerConfigJson: JSON.stringify({ provider: 'custom' }),
      })
      .returning()
      .all();

    const [insertedTrigger] = tx
      .insert(automationWebhookTriggers)
      .values({
        id: webhookId,
        jobId: id,
        secretHash: secret.secretHash,
        secretPreview: secret.secretPreview,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        rotatedAt: null,
      })
      .returning()
      .all();

    console.log(`[Automationen] Created custom webhook job "${name}" (${id}, scope=${automationScope.scope}, workspace=${automationScope.workspaceId ?? 'legacy'}, webhook=${webhookId})`);
    return {
      job: mapJobRow(insertedJob, insertedTrigger),
      secret: secret.secret,
    };
  });
}

export async function updateAutomationJob(
  jobId: string,
  input: UpdateAutomationJobInput,
  options: { actorUserId?: string | null } = {},
): Promise<AutomationJobRecord | null> {
  const existing = await db.query.automationJobs.findFirst({
    where: eq(automationJobs.id, jobId),
  });
  if (!existing) {
    return null;
  }

  const currentSchedule = JSON.parse(existing.scheduleConfigJson) as FriendlySchedule;
  const scheduleCandidate = input.schedule ?? currentSchedule;
  const defaultTimeZone = currentSchedule.timeZone || await getUserPreferredTimeZone(existing.createdByUserId);
  const { schedule, error } = validateFriendlySchedule(applyDefaultScheduleTimeZone(scheduleCandidate, defaultTimeZone));
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
      deliveryMode: input.deliveryMode === undefined ? existing.deliveryMode : normalizeDeliveryMode(input.deliveryMode),
      deliveryChannelId: input.deliveryChannelId === undefined
        ? existing.deliveryChannelId
        : normalizeOptionalShortString(input.deliveryChannelId, 120),
      deliverySessionMode: input.deliverySessionMode === undefined
        ? existing.deliverySessionMode
        : normalizeDeliverySessionMode(input.deliverySessionMode),
      deliverySessionId: input.deliverySessionId === undefined
        ? existing.deliverySessionId
        : normalizeOptionalShortString(input.deliverySessionId, 500),
      deliveryChannelSessionKey: input.deliveryChannelSessionKey === undefined
        ? existing.deliveryChannelSessionKey
        : normalizeOptionalShortString(input.deliveryChannelSessionKey, 500),
      status,
      scheduleKind: schedule.kind,
      scheduleConfigJson: JSON.stringify(schedule),
      timeZone: schedule.timeZone,
      nextRunAt,
      lastRunStatus: input.lastRunStatus === undefined ? existing.lastRunStatus : input.lastRunStatus,
      lastEditedByUserId: options.actorUserId === undefined ? existing.lastEditedByUserId : options.actorUserId,
      updatedAt: new Date(),
    })
    .where(eq(automationJobs.id, jobId))
    .returning();

  console.log(`[Automationen] Updated job ${jobId} (status=${status}, schedule=${schedule.kind})`);
  return mapJobRowWithWebhookTrigger(updated);
}

export async function deleteAutomationJob(jobId: string): Promise<boolean> {
  return db.transaction((tx) => {
    const existing = tx.select().from(automationJobs).where(eq(automationJobs.id, jobId)).limit(1).get();
    if (!existing) {
      return false;
    }
    tx.delete(automationWebhookEvents).where(eq(automationWebhookEvents.jobId, jobId)).run();
    tx.delete(automationWebhookTriggers).where(eq(automationWebhookTriggers.jobId, jobId)).run();
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
    const jobScope = normalizeAutomationScope(job.scope);
    const [inserted] = tx
      .insert(automationRuns)
      .values({
        id: `run-${randomUUID()}`,
        jobId,
        status: 'pending',
        scope: jobScope,
        organizationId: job.organizationId ?? null,
        workspaceId: job.workspaceId ?? null,
        workspaceType: normalizeAutomationWorkspaceType(job.workspaceType),
        actorType: jobScope === 'organization' ? 'service' : 'user',
        actorUserId: job.responsibleUserId ?? job.ownerUserId ?? job.createdByUserId,
        serviceActorId: jobScope === 'organization' ? job.serviceActorId ?? null : null,
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

export async function getAutomationWebhookTriggerWithJob(webhookId: string): Promise<{
  trigger: AutomationWebhookTriggerRecord;
  job: AutomationJobRecord;
} | null> {
  const trigger = await db.query.automationWebhookTriggers.findFirst({
    where: eq(automationWebhookTriggers.id, webhookId),
  });
  if (!trigger) return null;

  const jobRow = await db.query.automationJobs.findFirst({
    where: eq(automationJobs.id, trigger.jobId),
  });
  if (!jobRow) return null;

  return {
    trigger: mapAutomationWebhookTriggerRow(trigger),
    job: mapJobRow(jobRow, trigger),
  };
}

export async function rotateAutomationWebhookSecret(webhookId: string, userId: string): Promise<{
  job: AutomationJobRecord;
  secret: string;
} | null> {
  const triggerWithJob = await getAutomationWebhookTriggerWithJob(webhookId);
  if (!triggerWithJob) {
    return null;
  }
  try {
    assertCanAccessAutomationJob(userId, triggerWithJob.job);
  } catch {
    return null;
  }

  const secret = generateAutomationWebhookSecret();
  const now = new Date();
  const [updatedTrigger] = await db
    .update(automationWebhookTriggers)
    .set({
      secretHash: secret.secretHash,
      secretPreview: secret.secretPreview,
      updatedAt: now,
      rotatedAt: now,
    })
    .where(eq(automationWebhookTriggers.id, webhookId))
    .returning();

  const jobRow = await db.query.automationJobs.findFirst({
    where: eq(automationJobs.id, triggerWithJob.job.id),
  });
  if (!updatedTrigger || !jobRow) return null;

  return {
    job: mapJobRow(jobRow, updatedTrigger),
    secret: secret.secret,
  };
}

export async function getAutomationWebhookEventByKeys(keys: {
  webhookId: string;
  eventId?: string | null;
  idempotencyKey?: string | null;
}) {
  const clauses = [
    keys.eventId ? eq(automationWebhookEvents.eventId, keys.eventId) : null,
    keys.idempotencyKey ? eq(automationWebhookEvents.idempotencyKey, keys.idempotencyKey) : null,
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (clauses.length === 0) return null;

  const row = await db.query.automationWebhookEvents.findFirst({
    where: and(
      eq(automationWebhookEvents.webhookId, keys.webhookId),
      clauses.length === 1 ? clauses[0] : or(...clauses),
    ),
  });
  return row ?? null;
}

export async function recordAutomationWebhookEvent(input: {
  webhookId: string;
  jobId: string;
  eventId?: string | null;
  idempotencyKey?: string | null;
  runId?: string | null;
  status: string;
  error?: string | null;
  metadataJson?: Record<string, unknown> | null;
}): Promise<AutomationWebhookEventRecord> {
  const now = new Date();
  const [inserted] = await db
    .insert(automationWebhookEvents)
    .values({
      id: `webhook-event-${randomUUID()}`,
      webhookId: input.webhookId,
      jobId: input.jobId,
      eventId: input.eventId || null,
      idempotencyKey: input.idempotencyKey || null,
      runId: input.runId || null,
      status: input.status,
      error: input.error || null,
      metadataJson: input.metadataJson ? JSON.stringify(input.metadataJson) : null,
      receivedAt: now,
      updatedAt: now,
    })
    .returning();
  return inserted;
}

export async function markAutomationWebhookEventDispatched(id: string, runId: string) {
  await db
    .update(automationWebhookEvents)
    .set({
      runId,
      status: 'dispatched',
      updatedAt: new Date(),
    })
    .where(eq(automationWebhookEvents.id, id));
}

export async function markAutomationWebhookEventStatus(id: string, status: string, error?: string | null) {
  await db
    .update(automationWebhookEvents)
    .set({
      status,
      error: error || null,
      updatedAt: new Date(),
    })
    .where(eq(automationWebhookEvents.id, id));
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

  return rows.map((row) => mapJobRow(row));
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

export async function markStaleAutomationRunsFailed(now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - STALE_AUTOMATION_RUN_TTL_MS);
  const staleRuns = await db
    .select()
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.status, 'running'),
        lte(automationRuns.startedAt, staleBefore),
      ),
    );

  if (staleRuns.length > 0) {
    console.warn(`[Automationen] Marking ${staleRuns.length} stale run(s) as failed globally`);
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

export async function scheduleAutomationJobRun(
  jobId: string,
  triggerType: AutomationRunRecord['triggerType'],
  scheduledFor: Date,
  options: { metadataJson?: Record<string, unknown> } = {},
): Promise<AutomationRunRecord | null> {
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
    const jobScope = normalizeAutomationScope(job.scope);
    const [inserted] = tx
      .insert(automationRuns)
      .values({
        id: `run-${randomUUID()}`,
        jobId,
        status: 'pending',
        scope: jobScope,
        organizationId: job.organizationId ?? null,
        workspaceId: job.workspaceId ?? null,
        workspaceType: normalizeAutomationWorkspaceType(job.workspaceType),
        actorType: jobScope === 'organization' ? 'service' : 'user',
        actorUserId: job.responsibleUserId ?? job.ownerUserId ?? job.createdByUserId,
        serviceActorId: jobScope === 'organization' ? job.serviceActorId ?? null : null,
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

  const scheduleLastRunAt = job.schedule.kind === 'interval'
    ? null
    : job.lastRunAt ? new Date(job.lastRunAt) : null;
  const nextRunAt = job.status === 'paused'
    ? null
    : computeNextRunAt(job.schedule, { from: anchor, lastRunAt: scheduleLastRunAt });

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

export async function getHeartbeatJob(input: {
  userId: string;
  agentId?: string | null;
}): Promise<AutomationJobRecord | null> {
  const agentId = normalizeAgentId(input.agentId);
  const row = await db.query.automationJobs.findFirst({
    where: and(
      eq(automationJobs.createdByUserId, input.userId),
      eq(automationJobs.agentId, agentId),
      eq(automationJobs.jobType, 'heartbeat'),
    ),
  });

  return row ? mapJobRow(row) : null;
}

export async function upsertHeartbeatJob(data: {
  userId: string;
  agentId?: string | null;
  enabled: boolean;
  schedule: FriendlySchedule;
  deliveryMode?: AutomationDeliveryMode;
  deliveryChannelId?: string | null;
  deliverySessionMode?: AutomationDeliverySessionMode;
  deliverySessionId?: string | null;
  deliveryChannelSessionKey?: string | null;
}): Promise<AutomationJobRecord> {
  const agentId = normalizeAgentId(data.agentId);
  const existing = await getHeartbeatJob({ userId: data.userId, agentId });

  const status: AutomationJobStatus = data.enabled ? 'active' : 'paused';
  const defaultTimeZone = existing?.timeZone || await getUserPreferredTimeZone(data.userId);
  const { schedule, error } = validateFriendlySchedule(applyDefaultScheduleTimeZone(data.schedule, defaultTimeZone));
  if (!schedule || error) {
    throw new Error(error || 'Schedule is invalid.');
  }
  const nextRunAt = data.enabled
    ? computeNextRunAt(schedule, { from: new Date(), lastRunAt: existing?.lastRunAt ? new Date(existing.lastRunAt) : null })
    : null;
  const deliveryMode = normalizeDeliveryMode(data.deliveryMode ?? existing?.deliveryMode);
  const deliverySessionMode = normalizeDeliverySessionMode(data.deliverySessionMode ?? existing?.deliverySessionMode);
  const deliveryChannelId = data.deliveryChannelId === undefined
    ? existing?.deliveryChannelId ?? (deliveryMode === 'web' ? 'web' : null)
    : normalizeOptionalShortString(data.deliveryChannelId, 120);
  const deliverySessionId = data.deliverySessionId === undefined
    ? existing?.deliverySessionId ?? null
    : normalizeOptionalShortString(data.deliverySessionId, 500);
  const deliveryChannelSessionKey = data.deliveryChannelSessionKey === undefined
    ? existing?.deliveryChannelSessionKey ?? null
    : normalizeOptionalShortString(data.deliveryChannelSessionKey, 500);

  if (existing) {
    const [updated] = await db
      .update(automationJobs)
      .set({
        status,
        scheduleKind: schedule.kind,
        scheduleConfigJson: JSON.stringify(schedule),
        timeZone: schedule.timeZone,
        nextRunAt,
        deliveryMode,
        deliveryChannelId,
        deliverySessionMode,
        deliverySessionId,
        deliveryChannelSessionKey,
        updatedAt: new Date(),
      })
      .where(eq(automationJobs.id, existing.id))
      .returning();

    console.log(`[Heartbeat] Updated heartbeat job ${existing.id} (agent=${agentId}, status=${status}, schedule=${schedule.kind}, nextRunAt=${nextRunAt?.toISOString() ?? 'null'})`);
    return mapJobRow(updated);
  }

  const id = `job-heartbeat-${agentId}-${Date.now()}`;
  const now = new Date();

  const [inserted] = await db
    .insert(automationJobs)
    .values({
      id,
      name: 'Heartbeat',
      status,
      prompt: 'Heartbeat',
      preferredSkill: 'auto',
      workspaceContextPathsJson: '[]',
      targetOutputPath: null,
      scheduleKind: schedule.kind,
      scheduleConfigJson: JSON.stringify(schedule),
      timeZone: schedule.timeZone,
      nextRunAt,
      lastRunAt: null,
      lastRunStatus: null,
      createdByUserId: data.userId,
      agentId,
      deliveryMode,
      deliveryChannelId,
      deliverySessionMode,
      deliverySessionId,
      deliveryChannelSessionKey,
      createdAt: now,
      updatedAt: now,
      jobType: 'heartbeat',
      channelId: deliveryChannelId,
    })
    .returning();

  console.log(`[Heartbeat] Created heartbeat job ${id} (agent=${agentId}, status=${status}, schedule=${schedule.kind}, nextRunAt=${nextRunAt?.toISOString() ?? 'null'})`);
  return mapJobRow(inserted);
}

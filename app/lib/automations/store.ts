import { randomBytes, randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, lte, ne, notInArray, or, sql } from 'drizzle-orm';

import { db, getDatabaseProvider } from '@/app/lib/db';
import { automationJobs, automationRuns, automationWebhookEvents, automationWebhookTriggers, composioWebhookEvents, piSessions } from '@/app/lib/db/schema';
import {
  DEFAULT_MANAGED_AGENT_ID,
  readLegacyHeartbeatInstructions,
  removeLegacyHeartbeatInstructions,
} from '@/app/lib/agents/storage';
import { validatePath } from '@/app/lib/filesystem/workspace-files';
import { getServerPreferredTimeZone } from '@/app/lib/server-settings';
import { requireActiveWorkspaceMailboxForAutomation } from '@/app/lib/email/account-store';

import { assertAutomationChatTarget, AutomationChatTargetError } from './chat-targets';
import { inlineLegacyAutomationPaths } from './legacy-paths';
import { computeNextRunAt, validateFriendlySchedule } from './schedule';
import { generateAutomationWebhookSecret } from './webhook-secret';
import {
  assertCanAccessAutomationJob,
  assertEmailAutomationAgentCompatible,
  canAccessAutomationJob,
  getAutomationListAccess,
  resolveAutomationScopeForCreate,
  type ResolvedAutomationScope,
  type AutomationPolicyUser,
} from './policy';
import {
  type AutomationJobRecord,
  type AutomationJobStatus,
  type AutomationJobTriggerKind,
  type AutomationActorType,
  type AutomationDeliveryMode,
  type AutomationDeliverySessionMode,
  type AutomationJobType,
  type AutomationPreferredSkill,
  type AutomationRunRecord,
  type AutomationRunStatus,
  type AutomationResultPolicy,
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
const DEFAULT_AUTOMATION_RESULT_POLICY: AutomationResultPolicy = 'deliver_all';
const DELIVERY_MODES = new Set<AutomationDeliveryMode>(['web', 'origin', 'session', 'channel_home', 'last_active', 'silent']);
const DELIVERY_SESSION_MODES = new Set<AutomationDeliverySessionMode>(['new_session', 'channel_active', 'fixed_session']);
const AUTOMATION_JOB_TRIGGER_KINDS = new Set<AutomationJobTriggerKind>(['schedule', 'event', 'webhook', 'manual']);
const AUTOMATION_RESULT_POLICIES = new Set<AutomationResultPolicy>(['deliver_all', 'deliver_relevant_only', 'record_only']);
const AUTOMATION_RUN_RESULT_PREVIEW_LENGTH = 1000;
const AUTOMATION_RUN_LOG_MAX_JSON_LENGTH = 250_000;

type AutomationRunCreateOptions = {
  metadataJson?: Record<string, unknown>;
  actorUserId?: string | null;
};

type AutomationStoreTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type AutomationJobRow = typeof automationJobs.$inferSelect;
type AutomationRunRow = typeof automationRuns.$inferSelect;
export type AutomationRunTransitionExpectation = {
  status: AutomationRunStatus;
  attemptNumber: number;
};

const isPostgresRuntime = getDatabaseProvider() === 'postgres';

function runAutomationTransaction<T>(
  sqliteCallback: (tx: AutomationStoreTransaction) => T,
  postgresCallback: (tx: AutomationStoreTransaction) => Promise<T>,
): T | Promise<T> {
  if (isPostgresRuntime) {
    return (db as unknown as {
      transaction<Result>(callback: (tx: AutomationStoreTransaction) => Promise<Result>): Promise<Result>;
    }).transaction(postgresCallback);
  }

  return db.transaction(sqliteCallback);
}

function resolveAutomationRunActor(
  job: typeof automationJobs.$inferSelect,
  jobScope: AutomationScope,
  options: AutomationRunCreateOptions,
): {
  actorType: AutomationActorType;
  actorUserId: string | null;
  serviceActorId: string | null;
} {
  const explicitActorUserId = options.actorUserId?.trim() || null;
  if (explicitActorUserId) {
    return {
      actorType: 'user',
      actorUserId: explicitActorUserId,
      serviceActorId: null,
    };
  }

  if (jobScope === 'organization') {
    return {
      actorType: 'service',
      actorUserId: job.responsibleUserId ?? job.ownerUserId ?? job.createdByUserId,
      serviceActorId: job.serviceActorId ?? null,
    };
  }

  return {
    actorType: 'user',
    actorUserId: job.ownerUserId ?? job.createdByUserId,
    serviceActorId: null,
  };
}

function normalizeJobScopePart(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  return (normalized || fallback).replace(/[:\s]+/g, '_');
}

function buildAutomationJobScope(input: {
  scope: AutomationScope;
  organizationId?: string | null;
  workspaceId?: string | null;
  workspaceType?: string | null;
  ownerUserId?: string | null;
  responsibleUserId?: string | null;
  createdByUserId?: string | null;
  actorUserId?: string | null;
}): string {
  const workspacePart = normalizeJobScopePart(input.workspaceId || input.workspaceType, 'legacy');
  if (input.scope === 'organization') {
    return `organization:${normalizeJobScopePart(input.organizationId, 'legacy')}:${workspacePart}`;
  }

  return `personal:${normalizeJobScopePart(input.ownerUserId || input.responsibleUserId || input.actorUserId || input.createdByUserId, 'unknown')}:${workspacePart}`;
}

function resolveStoredJobScope(job: typeof automationJobs.$inferSelect, scope = normalizeAutomationScope(job.scope)): string {
  return job.jobScope || buildAutomationJobScope({
    scope,
    organizationId: job.organizationId ?? null,
    workspaceId: job.workspaceId ?? null,
    workspaceType: job.workspaceType ?? null,
    ownerUserId: job.ownerUserId ?? null,
    responsibleUserId: job.responsibleUserId ?? null,
    createdByUserId: job.createdByUserId,
  });
}

function getAutomationJobRowSync(tx: AutomationStoreTransaction, jobId: string): AutomationJobRow | undefined {
  return tx.select().from(automationJobs).where(eq(automationJobs.id, jobId)).limit(1).get();
}

async function getAutomationJobRowAsync(tx: AutomationStoreTransaction, jobId: string): Promise<AutomationJobRow | undefined> {
  const rows = await tx.select().from(automationJobs).where(eq(automationJobs.id, jobId)).limit(1);
  return rows[0];
}

function getAutomationRunRowSync(tx: AutomationStoreTransaction, runId: string): AutomationRunRow | undefined {
  return tx.select().from(automationRuns).where(eq(automationRuns.id, runId)).limit(1).get();
}

async function getAutomationRunRowAsync(tx: AutomationStoreTransaction, runId: string): Promise<AutomationRunRow | undefined> {
  const rows = await tx.select().from(automationRuns).where(eq(automationRuns.id, runId)).limit(1);
  return rows[0];
}

function getInFlightAutomationRunSync(tx: AutomationStoreTransaction, jobId: string): AutomationRunRow | undefined {
  return tx
    .select()
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.jobId, jobId),
        notInArray(automationRuns.status, ['success', 'failed']),
      ),
    )
    .limit(1)
    .get();
}

async function getInFlightAutomationRunAsync(tx: AutomationStoreTransaction, jobId: string): Promise<AutomationRunRow | undefined> {
  const rows = await tx
    .select()
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.jobId, jobId),
        notInArray(automationRuns.status, ['success', 'failed']),
      ),
    )
    .limit(1);
  return rows[0];
}

function buildPendingAutomationRunValues(
  job: AutomationJobRow,
  jobId: string,
  triggerType: AutomationRunRecord['triggerType'],
  scheduledFor: Date,
  options: AutomationRunCreateOptions,
  now = new Date(),
): typeof automationRuns.$inferInsert {
  const jobScope = normalizeAutomationScope(job.scope);
  const storedJobScope = resolveStoredJobScope(job, jobScope);
  const runActor = resolveAutomationRunActor(job, jobScope, options);
  return {
    id: `run-${randomUUID()}`,
    jobId,
    status: 'pending',
    scope: jobScope,
    jobScope: storedJobScope,
    organizationId: job.organizationId ?? null,
    workspaceId: job.workspaceId ?? null,
    workspaceType: normalizeAutomationWorkspaceType(job.workspaceType),
    actorType: runActor.actorType,
    actorUserId: runActor.actorUserId,
    serviceActorId: runActor.serviceActorId,
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
  };
}

function mergeAutomationRunMetadata(current: AutomationRunRow, metadataJson: Record<string, unknown>): string {
  return JSON.stringify({
    ...(current.metadataJson ? JSON.parse(current.metadataJson) as Record<string, unknown> : {}),
    ...metadataJson,
  });
}

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
  if (value === 'organization' || value === 'team' || value === 'project') return value;
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

function normalizeAutomationJobTriggerKind(value: unknown, fallback: AutomationJobTriggerKind): AutomationJobTriggerKind {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return fallback;
  if (!AUTOMATION_JOB_TRIGGER_KINDS.has(normalized as AutomationJobTriggerKind)) {
    throw new Error('Automation trigger kind is invalid.');
  }
  return normalized as AutomationJobTriggerKind;
}

function normalizeAutomationResultPolicy(value: unknown): AutomationResultPolicy {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return DEFAULT_AUTOMATION_RESULT_POLICY;
  if (!AUTOMATION_RESULT_POLICIES.has(normalized as AutomationResultPolicy)) {
    throw new Error('Automation result policy is invalid.');
  }
  return normalized as AutomationResultPolicy;
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

function normalizeEmailInboxEventConfig(value: unknown): { eventType: 'email_inbox_event'; mailboxId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Email inbox event configuration is required.');
  }
  const config = value as Record<string, unknown>;
  const eventType = typeof config.eventType === 'string' ? config.eventType.trim() : '';
  const mailboxId = typeof config.mailboxId === 'string' ? config.mailboxId.trim() : '';
  if (eventType !== 'email_inbox_event' || !mailboxId) {
    throw new Error('Email inbox event configuration requires a mailbox.');
  }
  return { eventType: 'email_inbox_event', mailboxId };
}

/**
 * A mailbox is deliberately handled by one live triage automation at a time.
 * Several active agents would otherwise independently prepare competing drafts
 * for the same incoming message.
 */
async function assertNoConflictingActiveEmailInboxAutomation(input: {
  workspaceId: string;
  mailboxId: string;
  excludeJobId?: string;
}): Promise<void> {
  const conditions = [
    eq(automationJobs.workspaceId, input.workspaceId),
    eq(automationJobs.triggerKind, 'event'),
    eq(automationJobs.status, 'active'),
  ];
  if (input.excludeJobId) {
    conditions.push(ne(automationJobs.id, input.excludeJobId));
  }
  const jobs = await db.select({ id: automationJobs.id, eventConfigJson: automationJobs.eventConfigJson })
    .from(automationJobs)
    .where(and(...conditions));
  const conflict = jobs.some((job) => {
    try {
      return normalizeEmailInboxEventConfig(parseOptionalJsonObject(job.eventConfigJson)).mailboxId === input.mailboxId;
    } catch {
      return false;
    }
  });
  if (conflict) {
    throw new Error('An active email inbox automation is already configured for this mailbox. Pause it or choose another mailbox first.');
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
    integrityStatus: row.integrityStatus === 'quarantined' ? 'quarantined' : 'valid',
    integrityReason: row.integrityReason ?? null,
    revision: row.revision,
    scope: normalizeAutomationScope(row.scope),
    jobScope: resolveStoredJobScope(row),
    organizationId: row.organizationId ?? null,
    workspaceId: row.workspaceId ?? null,
    workspaceType: normalizeAutomationWorkspaceType(row.workspaceType),
    ownerUserId: row.ownerUserId ?? (row.scope === 'organization' ? null : row.createdByUserId),
    responsibleUserId: row.responsibleUserId ?? row.createdByUserId,
    serviceActorId: row.serviceActorId ?? null,
    approvedByUserId: row.approvedByUserId ?? null,
    lastEditedByUserId: row.lastEditedByUserId ?? row.createdByUserId,
    prompt: inlineLegacyAutomationPaths({ prompt: row.prompt, workspaceContextPaths, targetOutputPath }),
    preferredSkill: ensurePreferredSkill(row.preferredSkill),
    workspaceContextPaths: [],
    targetOutputPath: null,
    effectiveTargetOutputPath: '',
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
    deletedAt: toIsoString(row.deletedAt),
    jobType: (row.jobType as AutomationJobType) || 'default',
    triggerKind: normalizeAutomationJobTriggerKind(row.triggerKind, row.scheduleKind === 'webhook' ? 'webhook' : 'schedule'),
    resultPolicy: normalizeAutomationResultPolicy(row.resultPolicy),
    eventConfig: parseOptionalJsonObject(row.eventConfigJson),
    channelId: row.channelId ?? null,
    composioTriggerId: row.composioTriggerId ?? null,
    composioTriggerSlug: row.composioTriggerSlug ?? null,
    composioToolkitSlug: row.composioToolkitSlug ?? null,
    composioConnectedAccountId: row.composioConnectedAccountId ?? null,
    composioProfileId: row.composioProfileId ?? null,
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
    jobScope: row.jobScope,
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
  await migrateLegacyHeartbeatJobs();
  await migrateLegacyAutomationPaths();
  const access = await getAutomationListAccess(userId);
  const personalAccess = and(
    or(
      eq(automationJobs.ownerUserId, userId),
      and(
        sql`${automationJobs.ownerUserId} IS NULL`,
        eq(automationJobs.createdByUserId, userId),
      ),
    ),
    ne(automationJobs.scope, 'organization'),
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

  const accessibleRows = organizationAccess
    ? (await Promise.all(rows.map(async (row) => (
        row.scope !== 'organization' || await canAccessAutomationJob(userId, row) ? row : null
      )))).filter((row): row is typeof automationJobs.$inferSelect => Boolean(row))
    : rows;
  const customWebhookTriggers = await loadAutomationWebhookTriggersByJobIds(accessibleRows.map((row) => row.id));
  return accessibleRows.map((row) => mapJobRow(row, customWebhookTriggers.get(row.id) ?? null));
}

export async function getAutomationJobByComposioTriggerId(triggerId: string): Promise<AutomationJobRecord | null> {
  const row = await db.query.automationJobs.findFirst({
    where: eq(automationJobs.composioTriggerId, triggerId),
  });

  return row ? mapJobRowWithWebhookTrigger(row) : null;
}

export async function listComposioTriggerJobsForResponsibleWorkspace(input: {
  userId: string;
  workspaceId: string;
}): Promise<AutomationJobRecord[]> {
  const rows = await db
    .select()
    .from(automationJobs)
    .where(and(
      eq(automationJobs.workspaceId, input.workspaceId),
      or(
        eq(automationJobs.responsibleUserId, input.userId),
        and(
          sql`${automationJobs.responsibleUserId} IS NULL`,
          eq(automationJobs.createdByUserId, input.userId),
        ),
      ),
      sql`${automationJobs.composioTriggerId} IS NOT NULL`,
    ));
  return rows.map((row) => mapJobRow(row, null));
}

export async function updateComposioAutomationTriggerBinding(input: {
  jobId: string;
  actorUserId: string;
  status: AutomationJobStatus;
  triggerId: string;
  connectedAccountId: string;
  profileId: string;
  composioUserId: string;
}): Promise<AutomationJobRecord | null> {
  const [updated] = await db
    .update(automationJobs)
    .set({
      status: input.status,
      nextRunAt: null,
      composioTriggerId: normalizeString(input.triggerId, 'Composio trigger ID', 500),
      composioConnectedAccountId: normalizeString(input.connectedAccountId, 'Composio connected account ID', 500),
      composioProfileId: normalizeString(input.profileId, 'Composio profile ID', 500),
      composioUserId: normalizeString(input.composioUserId, 'Composio user ID', 500),
      lastEditedByUserId: input.actorUserId,
      updatedAt: new Date(),
    })
    .where(eq(automationJobs.id, input.jobId))
    .returning();
  return updated ? mapJobRow(updated, null) : null;
}

export async function getAutomationJob(jobId: string): Promise<AutomationJobRecord | null> {
  await migrateLegacyAutomationPaths(jobId);
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
      jobScope: automationRuns.jobScope,
      organizationId: automationRuns.organizationId,
      customerId: automationRuns.customerId,
      projectId: automationRuns.projectId,
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
      jobScope: automationRuns.jobScope,
      organizationId: automationRuns.organizationId,
      customerId: automationRuns.customerId,
      projectId: automationRuns.projectId,
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
  const prompt = inlineLegacyAutomationPaths({
    prompt: normalizeString(input.prompt, 'Prompt', 32_000),
    workspaceContextPaths: normalizeWorkspaceContextPaths(input.workspaceContextPaths),
    targetOutputPath: normalizeTargetOutputPath(input.targetOutputPath),
  });
  const preferredSkill = ensurePreferredSkill(input.preferredSkill);
  const agentId = normalizeAgentId(input.agentId);
  const deliveryMode = normalizeDeliveryMode(input.deliveryMode);
  const deliverySessionMode = normalizeDeliverySessionMode(input.deliverySessionMode);
  const resultPolicy = normalizeAutomationResultPolicy(input.resultPolicy);
  const triggerKind = normalizeAutomationJobTriggerKind(input.triggerKind, 'schedule');
  const preferredTimeZone = await getServerPreferredTimeZone();
  const { schedule, error } = validateFriendlySchedule(applyDefaultScheduleTimeZone(input.schedule, preferredTimeZone));
  if (!schedule || error) {
    throw new Error(error || 'Schedule is invalid.');
  }

  const automationScope = await resolveAutomationScopeForCreate(input, policyUser);
  const eventConfig = triggerKind === 'event' ? normalizeEmailInboxEventConfig(input.eventConfig) : null;
  if (eventConfig) {
    if (!automationScope.workspaceId) throw new Error('Email inbox automations require a workspace.');
    await requireActiveWorkspaceMailboxForAutomation({
      emailAccountId: eventConfig.mailboxId,
      workspaceId: automationScope.workspaceId,
    });
    await assertEmailAutomationAgentCompatible({
      userId,
      agentId,
      workspace: automationScope.workspace,
    });
    if ((input.status || 'active') === 'active') {
      await assertNoConflictingActiveEmailInboxAutomation({
        workspaceId: automationScope.workspaceId,
        mailboxId: eventConfig.mailboxId,
      });
    }
  }
  await assertAutomationChatTarget({
    deliverySessionMode, deliverySessionId: input.deliverySessionId,
    userId: automationScope.responsibleUserId || userId, agentId,
    workspaceId: automationScope.workspaceId, workspaceType: automationScope.workspaceType,
  });
  const jobScope = buildAutomationJobScope({ ...automationScope, createdByUserId: userId });
  const now = new Date();
  const nextRunAt = input.status === 'paused' || triggerKind !== 'schedule' ? null : computeNextRunAt(schedule, { from: now });
  const id = `job-${randomUUID()}`;

  const [inserted] = await db
    .insert(automationJobs)
    .values({
      id,
      name,
      status: input.status || 'active',
      integrityStatus: 'valid',
      integrityReason: null,
      revision: 1,
      scope: automationScope.scope,
      jobScope,
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
      workspaceContextPathsJson: '[]',
      targetOutputPath: null,
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
      triggerKind,
      resultPolicy,
      eventConfigJson: eventConfig ? JSON.stringify(eventConfig) : null,
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
  const prompt = inlineLegacyAutomationPaths({
    prompt: normalizeString(input.prompt, 'Prompt', 32_000),
    workspaceContextPaths: normalizeWorkspaceContextPaths(input.workspaceContextPaths),
    targetOutputPath: normalizeTargetOutputPath(input.targetOutputPath),
  });
  const preferredSkill = ensurePreferredSkill(input.preferredSkill);
  const agentId = normalizeAgentId(input.agentId);
  const deliveryMode = normalizeDeliveryMode(input.deliveryMode);
  const deliverySessionMode = normalizeDeliverySessionMode(input.deliverySessionMode);
  const composioTriggerId = normalizeString(input.composioTriggerId, 'Composio trigger ID', 500);
  const composioTriggerSlug = normalizeString(input.composioTriggerSlug, 'Composio trigger slug', 500);
  const composioToolkitSlug = normalizeString(input.composioToolkitSlug, 'Composio toolkit slug', 120);
  const composioConnectedAccountId = normalizeString(input.composioConnectedAccountId, 'Composio connected account ID', 500);
  const composioProfileId = normalizeString(input.composioProfileId, 'Composio profile ID', 500);
  const composioUserId = normalizeString(input.composioUserId, 'Composio user ID', 500);
  const now = new Date();
  const id = `job-${randomUUID()}`;
  const preferredTimeZone = await getServerPreferredTimeZone();
  const automationScope = await resolveAutomationScopeForCreate(input, policyUser);
  await assertAutomationChatTarget({
    deliverySessionMode, deliverySessionId: input.deliverySessionId,
    userId: automationScope.responsibleUserId || userId, agentId,
    workspaceId: automationScope.workspaceId, workspaceType: automationScope.workspaceType,
  });
  const jobScope = buildAutomationJobScope({ ...automationScope, createdByUserId: userId });
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
      integrityStatus: 'valid',
      integrityReason: null,
      revision: 1,
      scope: automationScope.scope,
      jobScope,
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
      workspaceContextPathsJson: '[]',
      targetOutputPath: null,
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
      triggerKind: 'webhook',
      resultPolicy: 'deliver_all',
      createdAt: now,
      updatedAt: now,
      jobType: 'webhook',
      composioTriggerId,
      composioTriggerSlug,
      composioToolkitSlug,
      composioConnectedAccountId,
      composioProfileId,
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
  const prompt = inlineLegacyAutomationPaths({
    prompt: normalizeString(input.prompt, 'Prompt', 32_000),
    workspaceContextPaths: normalizeWorkspaceContextPaths(input.workspaceContextPaths),
    targetOutputPath: normalizeTargetOutputPath(input.targetOutputPath),
  });
  const preferredSkill = ensurePreferredSkill(input.preferredSkill);
  const agentId = normalizeAgentId(input.agentId);
  const deliveryMode = normalizeDeliveryMode(input.deliveryMode);
  const deliverySessionMode = normalizeDeliverySessionMode(input.deliverySessionMode);
  const now = new Date();
  const id = `job-${randomUUID()}`;
  const webhookId = generateAutomationWebhookId();
  const secret = generateAutomationWebhookSecret();
  const preferredTimeZone = await getServerPreferredTimeZone();
  const automationScope = await resolveAutomationScopeForCreate(input, policyUser);
  await assertAutomationChatTarget({
    deliverySessionMode, deliverySessionId: input.deliverySessionId,
    userId: automationScope.responsibleUserId || userId, agentId,
    workspaceId: automationScope.workspaceId, workspaceType: automationScope.workspaceType,
  });
  const jobScope = buildAutomationJobScope({ ...automationScope, createdByUserId: userId });
  const schedule: FriendlySchedule = {
    kind: 'webhook',
    timeZone: preferredTimeZone,
  };

  const jobValues = {
    id,
    name,
    status: input.status || 'active',
    integrityStatus: 'valid',
    integrityReason: null,
    revision: 1,
    scope: automationScope.scope,
    jobScope,
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
    workspaceContextPathsJson: '[]',
    targetOutputPath: null,
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
    triggerKind: 'webhook',
    resultPolicy: 'deliver_all',
    createdAt: now,
    updatedAt: now,
    jobType: 'webhook',
    webhookTriggerConfigJson: JSON.stringify({ provider: 'custom' }),
  } satisfies typeof automationJobs.$inferInsert;
  const triggerValues = {
    id: webhookId,
    jobId: id,
    secretHash: secret.secretHash,
    secretPreview: secret.secretPreview,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    rotatedAt: null,
  } satisfies typeof automationWebhookTriggers.$inferInsert;

  const finish = (insertedJob: AutomationJobRow, insertedTrigger: AutomationWebhookTriggerRow) => {
    console.log(`[Automationen] Created custom webhook job "${name}" (${id}, scope=${automationScope.scope}, workspace=${automationScope.workspaceId ?? 'legacy'}, webhook=${webhookId})`);
    return {
      job: mapJobRow(insertedJob, insertedTrigger),
      secret: secret.secret,
    };
  };

  return runAutomationTransaction(
    (tx) => {
      const [insertedJob] = tx
        .insert(automationJobs)
        .values(jobValues)
        .returning()
        .all();

      const [insertedTrigger] = tx
        .insert(automationWebhookTriggers)
        .values(triggerValues)
        .returning()
        .all();

      return finish(insertedJob, insertedTrigger);
    },
    async (tx) => {
      const [insertedJob] = await tx
        .insert(automationJobs)
        .values(jobValues)
        .returning();

      const [insertedTrigger] = await tx
        .insert(automationWebhookTriggers)
        .values(triggerValues)
        .returning();

      return finish(insertedJob, insertedTrigger);
    },
  );
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

  const deliverySessionMode = normalizeDeliverySessionMode(input.deliverySessionMode ?? existing.deliverySessionMode);
  const deliverySessionId = input.deliverySessionId === undefined ? existing.deliverySessionId : input.deliverySessionId;
  const agentId = normalizeAgentId(input.agentId ?? existing.agentId);
  const targetChanged = deliverySessionMode !== existing.deliverySessionMode
    || deliverySessionId !== existing.deliverySessionId || agentId !== existing.agentId;
  const executorId = existing.responsibleUserId || existing.ownerUserId || existing.createdByUserId;
  if (deliverySessionMode === 'fixed_session' && targetChanged && options.actorUserId && options.actorUserId !== executorId) {
    throw new AutomationChatTargetError();
  }
  if (targetChanged || input.status === 'active' || input.prompt !== undefined) {
    await assertAutomationChatTarget({
      deliverySessionMode, deliverySessionId, userId: executorId, agentId,
      workspaceId: existing.workspaceId, workspaceType: normalizeAutomationWorkspaceType(existing.workspaceType),
    });
  }

  const currentSchedule = JSON.parse(existing.scheduleConfigJson) as FriendlySchedule;
  const scheduleCandidate = input.schedule ?? currentSchedule;
  const defaultTimeZone = currentSchedule.timeZone || await getServerPreferredTimeZone();
  const { schedule, error } = validateFriendlySchedule(applyDefaultScheduleTimeZone(scheduleCandidate, defaultTimeZone));
  if (!schedule || error) {
    throw new Error(error || 'Schedule is invalid.');
  }

  const status = input.status ?? (existing.status as AutomationJobRecord['status']);
  const triggerKind = input.triggerKind === undefined
    ? normalizeAutomationJobTriggerKind(existing.triggerKind, existing.scheduleKind === 'webhook' ? 'webhook' : 'schedule')
    : normalizeAutomationJobTriggerKind(input.triggerKind, 'schedule');
  const eventConfig = triggerKind === 'event'
    ? normalizeEmailInboxEventConfig(input.eventConfig ?? parseOptionalJsonObject(existing.eventConfigJson))
    : null;
  if (eventConfig && existing.workspaceId) {
    await requireActiveWorkspaceMailboxForAutomation({
      emailAccountId: eventConfig.mailboxId,
      workspaceId: existing.workspaceId,
    });
    if (status === 'active') {
      await assertNoConflictingActiveEmailInboxAutomation({
        workspaceId: existing.workspaceId,
        mailboxId: eventConfig.mailboxId,
        excludeJobId: existing.id,
      });
    }
  }
  const nextRunAt = status === 'paused' || triggerKind !== 'schedule'
    ? null
    : computeNextRunAt(schedule, { from: new Date(), lastRunAt: existing.lastRunAt });

  const [updated] = await db
    .update(automationJobs)
    .set({
      name: input.name ? normalizeString(input.name, 'Name', 120) : existing.name,
      prompt: inlineLegacyAutomationPaths({
        prompt: input.prompt === undefined ? existing.prompt : normalizeString(input.prompt, 'Prompt', 32_000),
        workspaceContextPaths: input.workspaceContextPaths === undefined
          ? JSON.parse(existing.workspaceContextPathsJson)
          : normalizeWorkspaceContextPaths(input.workspaceContextPaths),
        targetOutputPath: input.targetOutputPath === undefined ? existing.targetOutputPath : normalizeTargetOutputPath(input.targetOutputPath),
      }),
      preferredSkill: input.preferredSkill === undefined
        ? ensurePreferredSkill(existing.preferredSkill)
        : ensurePreferredSkill(input.preferredSkill),
      workspaceContextPathsJson: '[]',
      targetOutputPath: null,
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
      resultPolicy: input.resultPolicy === undefined
        ? normalizeAutomationResultPolicy(existing.resultPolicy)
        : normalizeAutomationResultPolicy(input.resultPolicy),
      triggerKind,
      eventConfigJson: eventConfig ? JSON.stringify(eventConfig) : null,
      status,
      scheduleKind: schedule.kind,
      scheduleConfigJson: JSON.stringify(schedule),
      timeZone: schedule.timeZone,
      nextRunAt,
      lastRunStatus: input.lastRunStatus === undefined ? existing.lastRunStatus : input.lastRunStatus,
      lastEditedByUserId: options.actorUserId === undefined ? existing.lastEditedByUserId : options.actorUserId,
      revision: existing.revision + 1,
      updatedAt: new Date(),
    })
    .where(eq(automationJobs.id, jobId))
    .returning();

  console.log(`[Automationen] Updated job ${jobId} (status=${status}, schedule=${schedule.kind})`);
  return mapJobRowWithWebhookTrigger(updated);
}

export class AutomationWorkspaceChangeConflictError extends Error {
  readonly status = 409;
  readonly code = 'AUTOMATION_WORKSPACE_CHANGE_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'AutomationWorkspaceChangeConflictError';
  }
}

export async function moveAutomationJobToWorkspace(
  jobId: string,
  target: ResolvedAutomationScope,
  options: {
    actorUserId: string;
    responsibleUserId: string;
    resetPreferredSkill?: boolean;
    resetFixedDeliverySession?: boolean;
  },
): Promise<AutomationJobRecord> {
  const targetWorkspaceId = target.workspaceId || target.workspace.workspaceId;
  const moveRow = (
    tx: AutomationStoreTransaction,
    existing: AutomationJobRow,
  ): AutomationJobRow => {
    if (existing.workspaceId === targetWorkspaceId) {
      throw new AutomationWorkspaceChangeConflictError('Automation already uses this workspace.');
    }
    const inFlight = getInFlightAutomationRunSync(tx, jobId);
    if (inFlight) {
      throw new AutomationWorkspaceChangeConflictError(
        'Wait until the current automation run has finished before changing the workspace.',
      );
    }

    const scope = target.scope;
    const ownerUserId = scope === 'personal' ? options.actorUserId : null;
    const responsibleUserId = scope === 'personal' ? options.actorUserId : options.responsibleUserId;
    const [updated] = tx
      .update(automationJobs)
      .set({
        scope,
        jobScope: buildAutomationJobScope({
          scope,
          organizationId: target.organizationId,
          workspaceId: targetWorkspaceId,
          workspaceType: target.workspaceType,
          ownerUserId,
          responsibleUserId,
          createdByUserId: existing.createdByUserId,
          actorUserId: options.actorUserId,
        }),
        organizationId: target.organizationId,
        customerId: target.workspace.customerId ?? null,
        projectId: target.workspace.projectId ?? null,
        workspaceId: targetWorkspaceId,
        workspaceType: target.workspaceType,
        ownerUserId,
        responsibleUserId,
        serviceActorId: scope === 'organization' ? target.serviceActorId : null,
        approvedByUserId: scope === 'organization' ? options.actorUserId : null,
        lastEditedByUserId: options.actorUserId,
        revision: existing.revision + 1,
        preferredSkill: options.resetPreferredSkill ? 'auto' : existing.preferredSkill,
        deliverySessionMode: options.resetFixedDeliverySession ? 'new_session' : existing.deliverySessionMode,
        deliverySessionId: options.resetFixedDeliverySession ? null : existing.deliverySessionId,
        updatedAt: new Date(),
      })
      .where(eq(automationJobs.id, jobId))
      .returning()
      .all();

    if (!updated) {
      throw new Error('Automation job not found.');
    }
    return updated;
  };

  const updated = await runAutomationTransaction(
    (tx) => {
      const existing = getAutomationJobRowSync(tx, jobId);
      if (!existing) throw new Error('Automation job not found.');
      return moveRow(tx, existing);
    },
    async (tx) => {
      const existing = await getAutomationJobRowAsync(tx, jobId);
      if (!existing) throw new Error('Automation job not found.');
      if (existing.workspaceId === targetWorkspaceId) {
        throw new AutomationWorkspaceChangeConflictError('Automation already uses this workspace.');
      }
      const inFlight = await getInFlightAutomationRunAsync(tx, jobId);
      if (inFlight) {
        throw new AutomationWorkspaceChangeConflictError(
          'Wait until the current automation run has finished before changing the workspace.',
        );
      }

      const scope = target.scope;
      const ownerUserId = scope === 'personal' ? options.actorUserId : null;
      const responsibleUserId = scope === 'personal' ? options.actorUserId : options.responsibleUserId;
      const [next] = await tx
        .update(automationJobs)
        .set({
          scope,
          jobScope: buildAutomationJobScope({
            scope,
            organizationId: target.organizationId,
            workspaceId: targetWorkspaceId,
            workspaceType: target.workspaceType,
            ownerUserId,
            responsibleUserId,
            createdByUserId: existing.createdByUserId,
            actorUserId: options.actorUserId,
          }),
          organizationId: target.organizationId,
          customerId: target.workspace.customerId ?? null,
          projectId: target.workspace.projectId ?? null,
          workspaceId: targetWorkspaceId,
          workspaceType: target.workspaceType,
          ownerUserId,
          responsibleUserId,
          serviceActorId: scope === 'organization' ? target.serviceActorId : null,
          approvedByUserId: scope === 'organization' ? options.actorUserId : null,
          lastEditedByUserId: options.actorUserId,
          revision: existing.revision + 1,
          preferredSkill: options.resetPreferredSkill ? 'auto' : existing.preferredSkill,
          deliverySessionMode: options.resetFixedDeliverySession ? 'new_session' : existing.deliverySessionMode,
          deliverySessionId: options.resetFixedDeliverySession ? null : existing.deliverySessionId,
          updatedAt: new Date(),
        })
        .where(eq(automationJobs.id, jobId))
        .returning();
      if (!next) throw new Error('Automation job not found.');
      return next;
    },
  );

  console.log(
    `[Automationen] Moved job ${jobId} to workspace ${targetWorkspaceId} (scope=${target.scope})`,
  );
  return mapJobRowWithWebhookTrigger(updated);
}

export async function deleteAutomationJob(jobId: string): Promise<boolean> {
  const finish = () => {
    console.log(`[Automationen] Deleted job ${jobId} and associated runs`);
    return true;
  };

  return runAutomationTransaction(
    (tx) => {
      const existing = getAutomationJobRowSync(tx, jobId);
      if (!existing) {
        return false;
      }
      tx.delete(automationWebhookEvents).where(eq(automationWebhookEvents.jobId, jobId)).run();
      tx.delete(automationWebhookTriggers).where(eq(automationWebhookTriggers.jobId, jobId)).run();
      tx.delete(automationRuns).where(eq(automationRuns.jobId, jobId)).run();
      tx.delete(automationJobs).where(eq(automationJobs.id, jobId)).run();

      return finish();
    },
    async (tx) => {
      const existing = await getAutomationJobRowAsync(tx, jobId);
      if (!existing) {
        return false;
      }
      await tx.delete(automationWebhookEvents).where(eq(automationWebhookEvents.jobId, jobId));
      await tx.delete(automationWebhookTriggers).where(eq(automationWebhookTriggers.jobId, jobId));
      await tx.delete(automationRuns).where(eq(automationRuns.jobId, jobId));
      await tx.delete(automationJobs).where(eq(automationJobs.id, jobId));

      return finish();
    },
  );
}

export async function createPendingAutomationRun(
  jobId: string,
  triggerType: AutomationRunRecord['triggerType'],
  options: AutomationRunCreateOptions = {},
): Promise<AutomationRunRecord> {
  return runAutomationTransaction(
    (tx) => {
      const job = getAutomationJobRowSync(tx, jobId);
      if (!job) {
        throw new Error('Automation job not found.');
      }

      const now = new Date();
      const [inserted] = tx
        .insert(automationRuns)
        .values(buildPendingAutomationRunValues(job, jobId, triggerType, now, options, now))
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
    },
    async (tx) => {
      const job = await getAutomationJobRowAsync(tx, jobId);
      if (!job) {
        throw new Error('Automation job not found.');
      }

      const now = new Date();
      const [inserted] = await tx
        .insert(automationRuns)
        .values(buildPendingAutomationRunValues(job, jobId, triggerType, now, options, now))
        .returning();

      await tx
        .update(automationJobs)
        .set({
          lastRunStatus: 'pending',
          updatedAt: now,
        })
        .where(and(eq(automationJobs.id, jobId), eq(automationJobs.status, job.status)));

      return mapRunRow(inserted, null);
    },
  );
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
    await assertCanAccessAutomationJob(userId, triggerWithJob.job);
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
  await migrateLegacyHeartbeatJobs();
  await migrateLegacyAutomationPaths();
  const rows = await db
    .select()
    .from(automationJobs)
    .where(
      and(
        eq(automationJobs.status, 'active'),
        eq(automationJobs.integrityStatus, 'valid'),
        eq(automationJobs.triggerKind, 'schedule'),
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
    const failedCount = await markStaleAutomationRunRowsFailed(staleRuns, now);
    if (failedCount > 0) {
      console.warn(`[Automationen] Marked ${failedCount} stale run(s) as failed globally`);
    }
    return failedCount;
  }

  return 0;
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
    const failedCount = await markStaleAutomationRunRowsFailed(staleRuns, now);
    if (failedCount > 0) {
      console.warn(`[Automationen] Marked ${failedCount} stale run(s) as failed for job ${jobId}`);
    }
    return failedCount;
  }

  return 0;
}

async function markStaleAutomationRunRowsFailed(staleRuns: AutomationRunRow[], now: Date): Promise<number> {
  return runAutomationTransaction(
    (tx) => {
      let failedCount = 0;
      for (const run of staleRuns) {
        if (!run.startedAt) continue;
        const [updated] = tx
          .update(automationRuns)
          .set({
            status: 'failed',
            errorMessage: 'Automation run was marked stale before a new run could start.',
            finishedAt: now,
          })
          .where(and(
            eq(automationRuns.id, run.id),
            eq(automationRuns.status, 'running'),
            eq(automationRuns.attemptNumber, run.attemptNumber),
            eq(automationRuns.startedAt, run.startedAt),
          ))
          .returning({ id: automationRuns.id })
          .all();

        if (updated) {
          failedCount += 1;
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
      }
      return failedCount;
    },
    async (tx) => {
      let failedCount = 0;
      for (const run of staleRuns) {
        if (!run.startedAt) continue;
        const [updated] = await tx
          .update(automationRuns)
          .set({
            status: 'failed',
            errorMessage: 'Automation run was marked stale before a new run could start.',
            finishedAt: now,
          })
          .where(and(
            eq(automationRuns.id, run.id),
            eq(automationRuns.status, 'running'),
            eq(automationRuns.attemptNumber, run.attemptNumber),
            eq(automationRuns.startedAt, run.startedAt),
          ))
          .returning({ id: automationRuns.id });

        if (updated) {
          failedCount += 1;
          await tx
            .update(automationJobs)
            .set({
              lastRunAt: now,
              lastRunStatus: 'failed',
              updatedAt: now,
            })
            .where(eq(automationJobs.id, run.jobId));
        }
      }
      return failedCount;
    },
  );
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
  options: AutomationRunCreateOptions = {},
): Promise<AutomationRunRecord | null> {
  await failStaleAutomationRuns(jobId);

  const skipInFlight = (run: AutomationRunRow) => {
    console.log(`[Automationen] Skipping run creation for job ${jobId}: in-flight run ${run.id} already exists`);
    return null;
  };

  return runAutomationTransaction(
    (tx) => {
      const job = getAutomationJobRowSync(tx, jobId);
      if (!job) {
        throw new Error('Automation job not found.');
      }
      if (job.status !== 'active' || job.integrityStatus !== 'valid' || job.deletedAt) {
        throw new Error('Automation job is not active with a valid workspace scope.');
      }

      const inFlightRun = getInFlightAutomationRunSync(tx, jobId);
      if (inFlightRun) {
        return skipInFlight(inFlightRun);
      }

      const now = new Date();
      const [inserted] = tx
        .insert(automationRuns)
        .values(buildPendingAutomationRunValues(job, jobId, triggerType, scheduledFor, options, now))
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
    },
    async (tx) => {
      const job = await getAutomationJobRowAsync(tx, jobId);
      if (!job) {
        throw new Error('Automation job not found.');
      }
      if (job.status !== 'active' || job.integrityStatus !== 'valid' || job.deletedAt) {
        throw new Error('Automation job is not active with a valid workspace scope.');
      }

      const inFlightRun = await getInFlightAutomationRunAsync(tx, jobId);
      if (inFlightRun) {
        return skipInFlight(inFlightRun);
      }

      const now = new Date();
      const [inserted] = await tx
        .insert(automationRuns)
        .values(buildPendingAutomationRunValues(job, jobId, triggerType, scheduledFor, options, now))
        .returning();

      await tx
        .update(automationJobs)
        .set({
          lastRunStatus: 'pending',
          updatedAt: now,
        })
        .where(eq(automationJobs.id, jobId));

      return mapRunRow(inserted, null);
    },
  );
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
    expectedAttemptNumber: number;
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
        eq(automationRuns.attemptNumber, values.expectedAttemptNumber),
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

export async function revalidateAutomationRunClaim(
  runId: string,
  expectation: Pick<AutomationRunTransitionExpectation, 'attemptNumber'>,
): Promise<AutomationRunRecord | null> {
  const [updated] = await db
    .update(automationRuns)
    .set({ startedAt: new Date() })
    .where(and(
      eq(automationRuns.id, runId),
      eq(automationRuns.status, 'running'),
      eq(automationRuns.attemptNumber, expectation.attemptNumber),
    ))
    .returning();

  if (!updated) {
    console.warn(`[Automationen] Run ${runId} lost its claim while waiting for session execution`);
    return null;
  }
  return mapRunRow(updated, null);
}

export async function markAutomationRunRetryScheduled(
  runId: string,
  nextAttemptAt: Date,
  errorMessage: string,
  eventsLog: string[],
  metadataJson: Record<string, unknown>,
  expectation: AutomationRunTransitionExpectation,
  resultText?: string | null,
): Promise<AutomationRunRecord | null> {
  const finish = (current: AutomationRunRow, updated: AutomationRunRow | undefined) => {
    if (!updated) {
      console.warn(`[Automationen] Run ${runId} retry transition lost its status/attempt CAS; leaving the current state unchanged`);
      return null;
    }
    console.warn(`[Automationen] Run ${runId} marked as retry_scheduled (attempt=${current.attemptNumber + 1}, nextAttemptAt=${nextAttemptAt.toISOString()})`);
    return updated ? mapRunRow(updated, null) : null;
  };

  return runAutomationTransaction(
    (tx) => {
      const current = getAutomationRunRowSync(tx, runId);
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
          metadataJson: mergeAutomationRunMetadata(current, metadataJson),
        })
        .where(and(
          eq(automationRuns.id, runId),
          eq(automationRuns.status, expectation.status),
          eq(automationRuns.attemptNumber, expectation.attemptNumber),
        ))
        .returning()
        .all();

      if (updated) {
        tx
          .update(automationJobs)
          .set({
            lastRunStatus: 'retry_scheduled',
            updatedAt: new Date(),
          })
          .where(eq(automationJobs.id, current.jobId))
          .run();
      }

      return finish(current, updated);
    },
    async (tx) => {
      const current = await getAutomationRunRowAsync(tx, runId);
      if (!current) {
        return null;
      }

      const [updated] = await tx
        .update(automationRuns)
        .set({
          status: 'retry_scheduled',
          scheduledFor: nextAttemptAt,
          errorMessage,
          resultText: resultText ?? current.resultText,
          finishedAt: new Date(),
          attemptNumber: current.attemptNumber + 1,
          eventsLog: JSON.stringify(eventsLog),
          metadataJson: mergeAutomationRunMetadata(current, metadataJson),
        })
        .where(and(
          eq(automationRuns.id, runId),
          eq(automationRuns.status, expectation.status),
          eq(automationRuns.attemptNumber, expectation.attemptNumber),
        ))
        .returning();

      if (updated) {
        await tx
          .update(automationJobs)
          .set({
            lastRunStatus: 'retry_scheduled',
            updatedAt: new Date(),
          })
          .where(eq(automationJobs.id, current.jobId));
      }

      return finish(current, updated);
    },
  );
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
    expectation: AutomationRunTransitionExpectation;
  },
): Promise<AutomationRunRecord | null> {
  const finish = (current: AutomationRunRow, updated: AutomationRunRow | undefined) => {
    if (!updated) {
      console.warn(`[Automationen] Run ${runId} finish transition lost its status/attempt CAS; leaving the current state unchanged`);
      return null;
    }
    console.log(`[Automationen] Run ${runId} finished (status=${values.status}, job=${current.jobId})`);
    return updated ? mapRunRow(updated, null) : null;
  };

  return runAutomationTransaction(
    (tx) => {
      const current = getAutomationRunRowSync(tx, runId);
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
          metadataJson: mergeAutomationRunMetadata(current, values.metadataJson),
        })
        .where(and(
          eq(automationRuns.id, runId),
          eq(automationRuns.status, values.expectation.status),
          eq(automationRuns.attemptNumber, values.expectation.attemptNumber),
        ))
        .returning()
        .all();

      if (updated) {
        tx
          .update(automationJobs)
          .set({
            lastRunAt: now,
            lastRunStatus: values.status,
            updatedAt: now,
          })
          .where(eq(automationJobs.id, current.jobId))
          .run();
      }

      return finish(current, updated);
    },
    async (tx) => {
      const current = await getAutomationRunRowAsync(tx, runId);
      if (!current) {
        return null;
      }

      const now = new Date();
      const [updated] = await tx
        .update(automationRuns)
        .set({
          status: values.status,
          errorMessage: values.errorMessage ?? null,
          piSessionId: values.piSessionId ?? current.piSessionId,
          resultText: values.resultText ?? current.resultText,
          finishedAt: now,
          eventsLog: JSON.stringify(values.eventsLog),
          metadataJson: mergeAutomationRunMetadata(current, values.metadataJson),
        })
        .where(and(
          eq(automationRuns.id, runId),
          eq(automationRuns.status, values.expectation.status),
          eq(automationRuns.attemptNumber, values.expectation.attemptNumber),
        ))
        .returning();

      if (updated) {
        await tx
          .update(automationJobs)
          .set({
            lastRunAt: now,
            lastRunStatus: values.status,
            updatedAt: now,
          })
          .where(eq(automationJobs.id, current.jobId));
      }

      return finish(current, updated);
    },
  );
}

function buildMigratedHeartbeatPrompt(instructions: string): string {
  const trimmedInstructions = instructions.trim();
  if (!trimmedInstructions) {
    return 'Review this workspace for changes that need the user\'s attention. Report only a concrete, relevant update.';
  }

  return [
    'Run the following migrated workspace-review instructions.',
    '',
    trimmedInstructions,
  ].join('\n');
}

/**
 * Converts legacy heartbeat jobs in place. The original job ID, schedule,
 * delivery target, and run history remain intact; only the obsolete heartbeat
 * type and file-backed instruction source are replaced.
 */
export async function migrateLegacyHeartbeatJobs(): Promise<number> {
  const legacyJobs = await db
    .select()
    .from(automationJobs)
    .where(eq(automationJobs.jobType, 'heartbeat'));

  if (legacyJobs.length === 0) return 0;

  const instructionByJobId = new Map<string, string>();
  for (const job of legacyJobs) {
    const userId = job.responsibleUserId || job.ownerUserId || job.createdByUserId;
    instructionByJobId.set(job.id, await readLegacyHeartbeatInstructions({
      userId,
      agentId: job.agentId,
    }));
  }

  const migratedFileKeys = new Map<string, { userId: string; agentId: string }>();
  let migratedCount = 0;

  for (const job of legacyJobs) {
    const userId = job.responsibleUserId || job.ownerUserId || job.createdByUserId;
    try {
      const scope = await resolveAutomationScopeForCreate(
        { scope: 'personal' },
        { id: userId },
      );
      const jobScope = buildAutomationJobScope({ ...scope, createdByUserId: job.createdByUserId });
      const [updated] = await db
        .update(automationJobs)
        .set({
          name: 'Regelmäßige Workspace-Prüfung',
          prompt: buildMigratedHeartbeatPrompt(instructionByJobId.get(job.id) || ''),
          scope: scope.scope,
          jobScope,
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
          workspaceType: scope.workspaceType,
          ownerUserId: scope.ownerUserId,
          responsibleUserId: scope.responsibleUserId,
          serviceActorId: scope.serviceActorId,
          approvedByUserId: scope.approvedByUserId,
          lastEditedByUserId: scope.lastEditedByUserId,
          jobType: 'default',
          triggerKind: 'schedule',
          resultPolicy: 'deliver_relevant_only',
          updatedAt: new Date(),
        })
        .where(and(eq(automationJobs.id, job.id), eq(automationJobs.jobType, 'heartbeat')))
        .returning();

      if (!updated) continue;

      await db
        .update(automationRuns)
        .set({
          scope: scope.scope,
          jobScope,
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
          workspaceType: scope.workspaceType,
          actorUserId: scope.responsibleUserId,
          serviceActorId: scope.serviceActorId,
        })
        .where(eq(automationRuns.jobId, job.id));

      migratedCount += 1;
      migratedFileKeys.set(`${userId}:${job.agentId}`, { userId, agentId: job.agentId });
    } catch (error) {
      console.warn(`[Automationen] Could not migrate legacy heartbeat ${job.id}:`, error instanceof Error ? error.message : error);
    }
  }

  for (const file of migratedFileKeys.values()) {
    await removeLegacyHeartbeatInstructions(file);
  }

  if (migratedCount > 0) {
    console.log(`[Automationen] Migrated ${migratedCount} legacy heartbeat job(s) to workspace automations.`);
  }
  return migratedCount;
}

/** Idempotent data migration; compare the original values to avoid overwriting an edit. */
export async function migrateLegacyAutomationPaths(jobId?: string): Promise<number> {
  const rows = await db.select().from(automationJobs).where(and(
    jobId ? eq(automationJobs.id, jobId) : undefined,
    or(ne(automationJobs.workspaceContextPathsJson, '[]'), sql`${automationJobs.targetOutputPath} IS NOT NULL`),
  ));
  let count = 0;
  for (const row of rows) {
    const prompt = inlineLegacyAutomationPaths({
      prompt: row.prompt,
      workspaceContextPaths: JSON.parse(row.workspaceContextPathsJson),
      targetOutputPath: row.targetOutputPath,
    });
    const updated = await db.update(automationJobs).set({
      prompt,
      workspaceContextPathsJson: '[]',
      targetOutputPath: null,
      revision: row.revision + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(automationJobs.id, row.id),
      eq(automationJobs.revision, row.revision),
      eq(automationJobs.prompt, row.prompt),
      eq(automationJobs.workspaceContextPathsJson, row.workspaceContextPathsJson),
      row.targetOutputPath === null ? sql`${automationJobs.targetOutputPath} IS NULL` : eq(automationJobs.targetOutputPath, row.targetOutputPath),
    )).returning({ id: automationJobs.id });
    count += updated.length;
  }
  return count;
}

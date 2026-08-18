import 'server-only';

import { createHash } from 'node:crypto';

import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';

import { scheduleAutomationJobRun } from '@/app/lib/automations/store';
import type { AutomationJobRecord, AutomationRunRecord } from '@/app/lib/automations/types';
import { db } from '@/app/lib/db';
import { automationJobs, emailAccounts, emailInboxEvents, workspaceEmailMailboxes } from '@/app/lib/db/schema';

type InboxEventRow = typeof emailInboxEvents.$inferSelect;

const EMAIL_EVENT_QUEUE_MAX_ATTEMPTS = 3;
const EMAIL_EVENT_QUEUE_RETRY_BASE_MS = 60_000;

export type WorkspaceEmailAutomationEventContext = {
  eventId: string;
  mailboxId: string;
  providerMessageId: string;
  providerThreadId: string | null;
  folder: string;
  receivedAt: string;
  hasAttachments: boolean;
  sessionId: string;
};

export type WorkspaceEmailAutomationQueueResult = {
  checked: number;
  queued: number;
  deferred: number;
  ignored: number;
  failed: number;
};

/**
 * Removes the retired outboundMode field. Email event automations always
 * prepare drafts for human review; no configuration can enable auto-send.
 */
export async function migrateWorkspaceEmailAutomationJobs(): Promise<number> {
  const jobs = await db.select({ id: automationJobs.id, eventConfigJson: automationJobs.eventConfigJson })
    .from(automationJobs)
    .where(eq(automationJobs.triggerKind, 'event'));
  let migrated = 0;

  for (const job of jobs) {
    if (!job.eventConfigJson) continue;
    try {
      const config = JSON.parse(job.eventConfigJson) as Record<string, unknown>;
      if (config.eventType !== 'email_inbox_event' || !Object.hasOwn(config, 'outboundMode')) continue;
      const { outboundMode: _retiredOutboundMode, ...normalized } = config;
      await db.update(automationJobs).set({
        eventConfigJson: JSON.stringify(normalized),
        updatedAt: new Date(),
      }).where(eq(automationJobs.id, job.id));
      migrated += 1;
    } catch {
      // Invalid event configuration remains the responsibility of the job validator.
    }
  }
  return migrated;
}

function eventConfigMatchesMailbox(value: string | null, emailAccountId: string): boolean {
  if (!value) return false;
  try {
    const config = JSON.parse(value) as Record<string, unknown>;
    return config.eventType === 'email_inbox_event' && config.mailboxId === emailAccountId;
  } catch {
    return false;
  }
}

function emailEventMetadata(value: string | null): { folder: string; hasAttachments: boolean } {
  if (!value) return { folder: 'INBOX', hasAttachments: false };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      folder: typeof parsed.folder === 'string' && parsed.folder.trim() ? parsed.folder.trim() : 'INBOX',
      hasAttachments: parsed.hasAttachments === true,
    };
  } catch {
    return { folder: 'INBOX', hasAttachments: false };
  }
}

function emailThreadSessionId(input: { jobId: string; mailboxId: string; providerThreadId: string | null; providerMessageId: string }): string {
  const threadKey = input.providerThreadId || input.providerMessageId;
  const digest = createHash('sha256')
    .update(`${input.jobId}:${input.mailboxId}:${threadKey}`)
    .digest('hex')
    .slice(0, 32);
  return `automation-email:${digest}`;
}

async function findEventAutomationJob(event: InboxEventRow): Promise<typeof automationJobs.$inferSelect | null> {
  const [mailbox] = await db.select({
    workspaceId: workspaceEmailMailboxes.workspaceId,
    accountId: emailAccounts.id,
  }).from(workspaceEmailMailboxes)
    .innerJoin(emailAccounts, eq(emailAccounts.id, workspaceEmailMailboxes.emailAccountId))
    .where(and(eq(workspaceEmailMailboxes.id, event.mailboxId), eq(workspaceEmailMailboxes.status, 'active')))
    .limit(1);
  if (!mailbox || mailbox.workspaceId !== event.workspaceId) return null;

  const jobs = await db.select().from(automationJobs).where(and(
    eq(automationJobs.workspaceId, event.workspaceId),
    eq(automationJobs.triggerKind, 'event'),
    eq(automationJobs.status, 'active'),
  )).orderBy(asc(automationJobs.createdAt));
  return jobs.find((job) => eventConfigMatchesMailbox(job.eventConfigJson, mailbox.accountId)) || null;
}

async function markEvent(event: InboxEventRow, input: { status: 'queued' | 'ignored' | 'failed'; errorCode?: string | null }) {
  await db.update(emailInboxEvents).set({
    status: input.status,
    processedAt: input.status === 'ignored' ? new Date() : null,
    errorCode: input.errorCode || null,
    attemptCount: event.attemptCount + 1,
    nextAttemptAt: null,
    updatedAt: new Date(),
  }).where(and(eq(emailInboxEvents.id, event.id), eq(emailInboxEvents.status, 'pending')));
}

async function retryOrFailEventQueueing(event: InboxEventRow, errorCode: string): Promise<'deferred' | 'failed'> {
  const attemptCount = event.attemptCount + 1;
  const isFinalAttempt = attemptCount >= EMAIL_EVENT_QUEUE_MAX_ATTEMPTS;
  const nextAttemptAt = isFinalAttempt
    ? null
    : new Date(Date.now() + EMAIL_EVENT_QUEUE_RETRY_BASE_MS * (2 ** Math.max(attemptCount - 1, 0)));
  await db.update(emailInboxEvents).set({
    status: isFinalAttempt ? 'failed' : 'pending',
    processedAt: null,
    attemptCount,
    nextAttemptAt,
    errorCode: errorCode.slice(0, 250),
    updatedAt: new Date(),
  }).where(and(eq(emailInboxEvents.id, event.id), eq(emailInboxEvents.status, 'pending')));
  return isFinalAttempt ? 'failed' : 'deferred';
}

/**
 * Converts provider inbox events into normal Automation Engine runs. It deliberately
 * does not read mail, classify it, call an LLM, or create drafts; those are normal
 * Agent-Harness tool calls made while the queued run executes.
 */
export async function queuePendingWorkspaceEmailAutomationRuns(input: { limit?: number } = {}): Promise<WorkspaceEmailAutomationQueueResult> {
  await migrateWorkspaceEmailAutomationJobs();
  const now = new Date();
  const events = await db.query.emailInboxEvents.findMany({
    where: and(
      eq(emailInboxEvents.status, 'pending'),
      or(isNull(emailInboxEvents.nextAttemptAt), lte(emailInboxEvents.nextAttemptAt, now)),
    ),
    orderBy: [asc(emailInboxEvents.receivedAt)],
    limit: Math.min(Math.max(input.limit ?? 25, 1), 100),
  });
  const result: WorkspaceEmailAutomationQueueResult = { checked: events.length, queued: 0, deferred: 0, ignored: 0, failed: 0 };

  for (const event of events) {
    try {
      const job = await findEventAutomationJob(event);
      if (!job || !event.providerMessageId) {
        await markEvent(event, { status: 'ignored', errorCode: job ? 'provider_message_unavailable' : 'no_active_email_automation' });
        result.ignored += 1;
        continue;
      }
      const queuedRun = await scheduleAutomationJobRun(job.id, 'event', new Date(), {
        metadataJson: { emailInboxEventId: event.id },
      });
      if (!queuedRun) {
        result.deferred += 1;
        continue;
      }
      await markEvent(event, { status: 'queued' });
      result.queued += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'email_automation_queue_failed';
      const outcome = await retryOrFailEventQueueing(event, message);
      result[outcome] += 1;
      console.warn(`[WorkspaceEmailAutomation] Event queue ${outcome}`, event.id, message);
    }
  }
  return result;
}

/** Marks the source inbox event terminal only after its normal automation run ends. */
export async function markWorkspaceEmailAutomationEventRunFinished(input: {
  run: AutomationRunRecord;
  status: 'success' | 'failed';
  errorMessage?: string | null;
}): Promise<void> {
  const eventId = typeof input.run.metadataJson?.emailInboxEventId === 'string'
    ? input.run.metadataJson.emailInboxEventId
    : null;
  if (!eventId) return;

  await db.update(emailInboxEvents).set({
    status: input.status === 'success' ? 'processed' : 'failed',
    processedAt: new Date(),
    errorCode: input.status === 'failed' ? (input.errorMessage || 'automation_run_failed').slice(0, 250) : null,
    updatedAt: new Date(),
  }).where(and(eq(emailInboxEvents.id, eventId), eq(emailInboxEvents.status, 'queued')));
}

/**
 * Revalidates an inbox event at execution time and returns the narrow context that
 * may enter an Automation prompt. Full message and thread content remain available
 * only through the scoped email tools added to the Agent-Harness.
 */
export async function getWorkspaceEmailAutomationEventContext(input: {
  job: AutomationJobRecord;
  run: AutomationRunRecord;
}): Promise<WorkspaceEmailAutomationEventContext | null> {
  const eventId = typeof input.run.metadataJson?.emailInboxEventId === 'string'
    ? input.run.metadataJson.emailInboxEventId
    : null;
  if (!eventId) return null;
  if (input.run.triggerType !== 'event' || input.job.triggerKind !== 'event' || !input.job.workspaceId) {
    throw new Error('Email event metadata is only valid for a workspace event automation.');
  }

  const event = await db.query.emailInboxEvents.findFirst({ where: eq(emailInboxEvents.id, eventId) });
  if (!event || event.workspaceId !== input.job.workspaceId || !event.providerMessageId) {
    throw new Error('Workspace email event is no longer available.');
  }
  const [mailbox] = await db.select({
    workspaceId: workspaceEmailMailboxes.workspaceId,
    accountId: emailAccounts.id,
    status: workspaceEmailMailboxes.status,
  }).from(workspaceEmailMailboxes)
    .innerJoin(emailAccounts, eq(emailAccounts.id, workspaceEmailMailboxes.emailAccountId))
    .where(eq(workspaceEmailMailboxes.id, event.mailboxId))
    .limit(1);
  if (!mailbox || mailbox.status !== 'active' || mailbox.workspaceId !== input.job.workspaceId
    || !eventConfigMatchesMailbox(JSON.stringify(input.job.eventConfig || {}), mailbox.accountId)) {
    throw new Error('Workspace mailbox binding changed before the email automation could run.');
  }

  const metadata = emailEventMetadata(event.metadataJson);
  return {
    eventId: event.id,
    mailboxId: event.mailboxId,
    providerMessageId: event.providerMessageId,
    providerThreadId: event.providerThreadId,
    folder: metadata.folder,
    receivedAt: event.receivedAt.toISOString(),
    hasAttachments: metadata.hasAttachments,
    sessionId: emailThreadSessionId({
      jobId: input.job.id,
      mailboxId: event.mailboxId,
      providerThreadId: event.providerThreadId,
      providerMessageId: event.providerMessageId,
    }),
  };
}

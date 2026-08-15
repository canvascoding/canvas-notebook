import 'server-only';

import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { automationJobs, emailAccounts, emailInboxEvents, workspaceEmailMailboxes } from '@/app/lib/db/schema';
import { createWorkspaceInboxCase, createWorkspaceOutboxDraft } from './workspace-inbox-outbox';

type InboxEventRow = typeof emailInboxEvents.$inferSelect;

type TriageResult = {
  checked: number;
  processed: number;
  ignored: number;
  drafted: number;
  failed: number;
};

type TriageDependencies = {
  readMessage?: (input: {
    userId: string;
    accountId: string;
    messageId: string;
    folder: string;
    workspaceId: string;
  }) => Promise<{ message?: unknown }>;
  draftReply?: (input: {
    userId: string;
    workspaceId: string;
    message: Record<string, unknown>;
    instruction: string;
  }) => Promise<string>;
};

function eventConfigMatchesMailbox(value: string | null, emailAccountId: string): boolean {
  if (!value) return false;
  try {
    const config = JSON.parse(value) as Record<string, unknown>;
    return config.eventType === 'email_inbox_event' && config.mailboxId === emailAccountId;
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function senderAddress(value: string): string | null {
  const match = value.match(/<([^>]+)>/) || value.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  const address = (match?.[1] || '').trim();
  return address.includes('@') ? address : null;
}

function senderName(value: string): string | null {
  const withoutAddress = value.replace(/<[^>]+>/g, '').replace(/"/g, '').trim();
  return withoutAddress || null;
}

function isAutomatedMessage(message: Record<string, unknown>): boolean {
  const from = stringValue(message.from).toLowerCase();
  const subject = stringValue(message.subject).toLowerCase();
  const body = `${stringValue(message.body)} ${stringValue(message.snippet)}`.toLowerCase().slice(0, 4_000);
  return /mailer-daemon|postmaster|no-?reply|donotreply/.test(from)
    || /undeliverable|delivery status|failure notice|out of office|automatic reply|auto.?reply|abwesenheitsnotiz/.test(subject)
    || /this is an automated|automatische antwort|out of (the )?office|i am currently away/.test(body);
}

function priorityFor(message: Record<string, unknown>): 'low' | 'normal' | 'high' | 'urgent' {
  const content = `${stringValue(message.subject)} ${stringValue(message.body)} ${stringValue(message.snippet)}`.toLowerCase();
  if (/\b(urgent|kritisch|critical|sofort|immediately|outage|security incident)\b/.test(content)) return 'urgent';
  if (/\b(asap|dringend|blocked|blockiert|complaint|beschwerde|refund)\b/.test(content)) return 'high';
  if (/\b(fyi|newsletter|information)\b/.test(content)) return 'low';
  return 'normal';
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject || '(No subject)'}`;
}

async function markEvent(event: InboxEventRow, values: {
  status: 'processed' | 'ignored' | 'failed';
  caseId?: string | null;
  errorCode?: string | null;
}) {
  const now = new Date();
  await db.update(emailInboxEvents).set({
    status: values.status,
    processedAt: values.status === 'failed' ? null : now,
    caseId: values.caseId || null,
    errorCode: values.errorCode || null,
    attemptCount: event.attemptCount + 1,
    nextAttemptAt: null,
    updatedAt: now,
  }).where(and(eq(emailInboxEvents.id, event.id), eq(emailInboxEvents.status, 'pending')));
}

async function processEvent(event: InboxEventRow, dependencies: TriageDependencies): Promise<'processed' | 'ignored' | 'drafted'> {
  const [mailbox] = await db.select({
    id: workspaceEmailMailboxes.id,
    workspaceId: workspaceEmailMailboxes.workspaceId,
    accountId: emailAccounts.id,
    accountOwnerId: emailAccounts.userId,
  }).from(workspaceEmailMailboxes)
    .innerJoin(emailAccounts, eq(emailAccounts.id, workspaceEmailMailboxes.emailAccountId))
    .where(and(eq(workspaceEmailMailboxes.id, event.mailboxId), eq(workspaceEmailMailboxes.status, 'active')))
    .limit(1);
  if (!mailbox || mailbox.workspaceId !== event.workspaceId || !event.providerMessageId) {
    await markEvent(event, { status: 'ignored', errorCode: 'mailbox_or_message_unavailable' });
    return 'ignored';
  }
  const providerMessageId = event.providerMessageId;

  const jobs = await db.select().from(automationJobs).where(and(
    eq(automationJobs.workspaceId, event.workspaceId),
    eq(automationJobs.triggerKind, 'event'),
    eq(automationJobs.status, 'active'),
  )).orderBy(asc(automationJobs.createdAt));
  const job = jobs.find((candidate) => eventConfigMatchesMailbox(candidate.eventConfigJson, mailbox.accountId));
  if (!job) {
    await markEvent(event, { status: 'ignored', errorCode: 'no_active_triage_automation' });
    return 'ignored';
  }
  const automationUserId = job.responsibleUserId || job.ownerUserId || job.createdByUserId;

  const metadata = event.metadataJson ? JSON.parse(event.metadataJson) as Record<string, unknown> : {};
  const folder = stringValue(metadata.folder) || 'INBOX';
  const read = dependencies.readMessage
    ? await dependencies.readMessage({
        userId: mailbox.accountOwnerId,
        accountId: mailbox.accountId,
        messageId: providerMessageId,
        folder,
        workspaceId: event.workspaceId,
      })
    : await (async () => {
        const { readEmailMessage } = await import('@/app/lib/email/service');
        return readEmailMessage(mailbox.accountOwnerId, mailbox.accountId, providerMessageId, folder, {
          enforceReadPolicy: true,
          workspaceId: event.workspaceId,
        });
      })();
  const message = (read.message || {}) as Record<string, unknown>;
  const subject = stringValue(message.subject) || '(No subject)';
  const from = stringValue(message.from);
  const threadId = stringValue(message.threadId) || event.providerThreadId || providerMessageId;
  const automated = isAutomatedMessage(message);
  const inboxCase = await createWorkspaceInboxCase({
    userId: automationUserId,
    workspaceId: event.workspaceId,
    mailboxId: event.mailboxId,
    providerThreadId: threadId,
    latestProviderMessageId: providerMessageId,
    requesterAddress: senderAddress(from),
    requesterName: senderName(from),
    subject,
    status: automated ? 'closed' : 'new',
    priority: priorityFor(message),
    assigneeUserId: automationUserId,
  });
  if (automated) {
    await markEvent(event, { status: 'ignored', caseId: inboxCase.id, errorCode: 'automated_message' });
    return 'ignored';
  }

  const recipient = senderAddress(from);
  if (!recipient) {
    await markEvent(event, { status: 'processed', caseId: inboxCase.id, errorCode: 'missing_reply_address' });
    return 'processed';
  }
  const instruction = `${job.prompt}\n\nReturn only a conservative draft reply. Never state that an action has already been completed unless the email proves it. This is a human-review draft and must never be sent automatically.`;
  const body = dependencies.draftReply
    ? await dependencies.draftReply({ userId: mailbox.accountOwnerId, workspaceId: event.workspaceId, message, instruction })
    : await (async () => {
        const { draftEmailReplyWithAi } = await import('@/app/lib/email/ai-service');
        return draftEmailReplyWithAi({ userId: mailbox.accountOwnerId, workspaceId: event.workspaceId }, message, instruction);
      })();
  await createWorkspaceOutboxDraft({
    userId: automationUserId,
    workspaceId: event.workspaceId,
    mailboxId: event.mailboxId,
    inboxCaseId: inboxCase.id,
    subject: replySubject(subject),
    body,
    to: [recipient],
    originAutomationJobId: job.id,
    originRunId: `email-event:${event.id}`,
    originAgentId: job.agentId,
  });
  await markEvent(event, { status: 'processed', caseId: inboxCase.id });
  return 'drafted';
}

export async function processPendingWorkspaceEmailTriageEvents(options: { limit?: number } & TriageDependencies = {}): Promise<TriageResult> {
  const events = await db.query.emailInboxEvents.findMany({
    where: eq(emailInboxEvents.status, 'pending'),
    orderBy: [asc(emailInboxEvents.receivedAt)],
    limit: Math.min(Math.max(options.limit ?? 25, 1), 100),
  });
  const result: TriageResult = { checked: events.length, processed: 0, ignored: 0, drafted: 0, failed: 0 };
  for (const event of events) {
    try {
      const outcome = await processEvent(event, options);
      if (outcome === 'drafted') result.drafted += 1;
      else if (outcome === 'ignored') result.ignored += 1;
      else result.processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'triage_failed';
      await markEvent(event, { status: 'failed', errorCode: message.slice(0, 250) });
      result.failed += 1;
      console.warn('[WorkspaceEmailTriage] Event failed', event.id, message);
    }
  }
  return result;
}

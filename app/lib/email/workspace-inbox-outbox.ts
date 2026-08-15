import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { emailAccounts, emailDrafts, emailInboxCases, workspaceEmailMailboxes } from '@/app/lib/db/schema';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';

type OutboxStatus = 'prepared' | 'awaiting_review' | 'editing' | 'sending' | 'sent' | 'discarded' | 'send_failed';
type InboxCaseStatus = 'new' | 'in_progress' | 'awaiting_review' | 'answered' | 'closed' | 'needs_routing';

function parseRecipients(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function publicOutboxDraft(draft: typeof emailDrafts.$inferSelect) {
  return {
    id: draft.id, workspaceId: draft.workspaceId, mailboxId: draft.mailboxId, inboxCaseId: draft.inboxCaseId,
    status: draft.outboxStatus as OutboxStatus | null, version: draft.version, subject: draft.subject, body: draft.body,
    to: parseRecipients(draft.toJson), cc: parseRecipients(draft.ccJson), bcc: parseRecipients(draft.bccJson),
    isHtml: draft.isHtml, origin: draft.origin, assignedUserId: draft.assignedUserId,
    originAutomationJobId: draft.originAutomationJobId, originRunId: draft.originRunId, originAgentId: draft.originAgentId,
    editingByUserId: draft.editingByUserId, editingStartedAt: draft.editingStartedAt?.toISOString() || null,
    sentByUserId: draft.sentByUserId, sentAt: draft.sentAt?.toISOString() || null,
    updatedAt: draft.updatedAt.toISOString(), createdAt: draft.createdAt.toISOString(),
  };
}

function publicInboxCase(item: typeof emailInboxCases.$inferSelect) {
  return {
    id: item.id, workspaceId: item.workspaceId, mailboxId: item.mailboxId, providerThreadId: item.providerThreadId,
    latestProviderMessageId: item.latestProviderMessageId, requesterAddress: item.requesterAddress,
    requesterName: item.requesterName, subject: item.subject, status: item.status as InboxCaseStatus,
    priority: item.priority, assigneeUserId: item.assigneeUserId, closedAt: item.closedAt?.toISOString() || null,
    createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(),
  };
}

async function requireWorkspace(userId: string, workspaceId: string, permission: 'canRead' | 'canWrite') {
  return resolveAgentSessionWorkspaceForUser({ userId, workspaceId, permissions: [permission] });
}

export async function listWorkspaceInboxCases(userId: string, workspaceId: string) {
  await requireWorkspace(userId, workspaceId, 'canRead');
  const rows = await db.query.emailInboxCases.findMany({
    where: eq(emailInboxCases.workspaceId, workspaceId),
    orderBy: [desc(emailInboxCases.updatedAt)],
  });
  return rows.map(publicInboxCase);
}

export async function listWorkspaceOutboxDrafts(userId: string, workspaceId: string) {
  await requireWorkspace(userId, workspaceId, 'canRead');
  const rows = await db.query.emailDrafts.findMany({
    where: and(eq(emailDrafts.workspaceId, workspaceId), eq(emailDrafts.origin, 'automation')),
    orderBy: [desc(emailDrafts.updatedAt)],
  });
  return rows.map(publicOutboxDraft);
}

/**
 * Internal read model for regular workspace automations. It deliberately
 * exposes only the queue state that is actionable for the current workspace;
 * it has no provider access and cannot trigger a send.
 */
export async function getWorkspaceEmailAttentionSummary(workspaceId: string) {
  const [cases, drafts] = await Promise.all([
    db.query.emailInboxCases.findMany({
      where: and(eq(emailInboxCases.workspaceId, workspaceId), notInArray(emailInboxCases.status, ['answered', 'closed'])),
      orderBy: [desc(emailInboxCases.updatedAt)],
      limit: 20,
    }),
    db.query.emailDrafts.findMany({
      where: and(
        eq(emailDrafts.workspaceId, workspaceId),
        eq(emailDrafts.origin, 'automation'),
        inArray(emailDrafts.outboxStatus, ['awaiting_review', 'editing', 'send_failed']),
      ),
      orderBy: [desc(emailDrafts.updatedAt)],
      limit: 20,
    }),
  ]);
  const overdueBefore = Date.now() - 24 * 60 * 60 * 1_000;
  return {
    openCaseCount: cases.length,
    overdueCaseCount: cases.filter((item) => item.updatedAt.getTime() < overdueBefore).length,
    reviewDraftCount: drafts.length,
    sendFailureCount: drafts.filter((item) => item.outboxStatus === 'send_failed').length,
    cases: cases.map((item) => ({ id: item.id, subject: item.subject, status: item.status, priority: item.priority, updatedAt: item.updatedAt.toISOString() })),
    drafts: drafts.map((item) => ({ id: item.id, subject: item.subject, status: item.outboxStatus, updatedAt: item.updatedAt.toISOString() })),
  };
}

export async function createWorkspaceInboxCase(input: {
  userId: string; workspaceId: string; mailboxId: string; providerThreadId: string; subject: string;
  latestProviderMessageId?: string | null; requesterAddress?: string | null; requesterName?: string | null;
  status?: InboxCaseStatus; priority?: 'low' | 'normal' | 'high' | 'urgent'; assigneeUserId?: string | null;
}) {
  await requireWorkspace(input.userId, input.workspaceId, 'canWrite');
  const mailbox = await db.query.workspaceEmailMailboxes.findFirst({
    where: and(eq(workspaceEmailMailboxes.id, input.mailboxId), eq(workspaceEmailMailboxes.workspaceId, input.workspaceId), eq(workspaceEmailMailboxes.status, 'active')),
  });
  if (!mailbox) throw new Error('Workspace mailbox not found.');
  const now = new Date();
  const id = `inbox-case-${randomUUID()}`;
  await db.insert(emailInboxCases).values({
    id, workspaceId: input.workspaceId, mailboxId: input.mailboxId, providerThreadId: input.providerThreadId,
    latestProviderMessageId: input.latestProviderMessageId || null, requesterAddress: input.requesterAddress || null,
    requesterName: input.requesterName || null, subject: input.subject.trim() || '(No subject)', status: input.status || 'new', priority: input.priority || 'normal',
    assigneeUserId: input.assigneeUserId || null, closedAt: input.status === 'closed' ? now : null, createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [emailInboxCases.mailboxId, emailInboxCases.providerThreadId],
    set: {
      latestProviderMessageId: input.latestProviderMessageId || null,
      subject: input.subject.trim() || '(No subject)',
      status: input.status || 'new',
      priority: input.priority || 'normal',
      assigneeUserId: input.assigneeUserId || null,
      closedAt: input.status === 'closed' ? now : null,
      updatedAt: now,
    },
  });
  const item = await db.query.emailInboxCases.findFirst({ where: and(eq(emailInboxCases.mailboxId, input.mailboxId), eq(emailInboxCases.providerThreadId, input.providerThreadId)) });
  if (!item) throw new Error('Inbox case could not be created.');
  return publicInboxCase(item);
}

export async function createWorkspaceOutboxDraft(input: {
  userId: string; workspaceId: string; mailboxId: string; inboxCaseId?: string | null;
  subject: string; body: string; to: string[]; cc?: string[]; bcc?: string[];
  originAutomationJobId?: string | null; originRunId?: string | null; originAgentId?: string | null; assignedUserId?: string | null;
  initialStatus?: Extract<OutboxStatus, 'prepared' | 'awaiting_review'>;
}) {
  await requireWorkspace(input.userId, input.workspaceId, 'canWrite');
  const [mailbox] = await db.select({ accountId: emailAccounts.id, accountOwnerId: emailAccounts.userId })
    .from(workspaceEmailMailboxes)
    .innerJoin(emailAccounts, eq(emailAccounts.id, workspaceEmailMailboxes.emailAccountId))
    .where(and(eq(workspaceEmailMailboxes.id, input.mailboxId), eq(workspaceEmailMailboxes.workspaceId, input.workspaceId), eq(workspaceEmailMailboxes.status, 'active')))
    .limit(1);
  if (!mailbox) throw new Error('Workspace mailbox not found.');
  if (input.inboxCaseId) {
    const inboxCase = await db.query.emailInboxCases.findFirst({
      where: and(
        eq(emailInboxCases.id, input.inboxCaseId),
        eq(emailInboxCases.workspaceId, input.workspaceId),
        eq(emailInboxCases.mailboxId, input.mailboxId),
      ),
      columns: { id: true },
    });
    if (!inboxCase) throw new Error('Workspace inbox case does not belong to this mailbox.');
  }
  if (input.originRunId) {
    const existing = await db.query.emailDrafts.findFirst({
      where: and(eq(emailDrafts.workspaceId, input.workspaceId), eq(emailDrafts.origin, 'automation'), eq(emailDrafts.originRunId, input.originRunId)),
    });
    if (existing) return publicOutboxDraft(existing);
  }
  const now = new Date();
  const id = `draft_${randomUUID()}`;
  await db.insert(emailDrafts).values({
    id, userId: mailbox.accountOwnerId, accountId: mailbox.accountId, status: 'draft',
    toJson: JSON.stringify(input.to), ccJson: JSON.stringify(input.cc || []), bccJson: JSON.stringify(input.bcc || []),
    subject: input.subject.trim(), body: input.body, isHtml: true, attachmentsJson: '[]', providerDraftId: null,
    workspaceId: input.workspaceId, mailboxId: input.mailboxId, inboxCaseId: input.inboxCaseId || null,
    origin: 'automation', originAutomationJobId: input.originAutomationJobId || null,
    originRunId: input.originRunId || null, originAgentId: input.originAgentId || null,
    outboxStatus: input.initialStatus || 'awaiting_review', version: 1, assignedUserId: input.assignedUserId || null, editingByUserId: null, editingStartedAt: null,
    sentByUserId: null, sentAt: null, createdAt: now, updatedAt: now,
  });
  const draft = await db.query.emailDrafts.findFirst({ where: eq(emailDrafts.id, id) });
  if (!draft) throw new Error('Workspace outbox draft could not be created.');
  return publicOutboxDraft(draft);
}

export async function updateWorkspaceOutboxDraft(input: {
  userId: string; workspaceId: string; draftId: string; expectedVersion: number; subject: string; body: string;
  to: string[]; cc?: string[]; bcc?: string[]; status?: Extract<OutboxStatus, 'awaiting_review' | 'editing' | 'discarded'>;
}) {
  await requireWorkspace(input.userId, input.workspaceId, 'canWrite');
  const current = await db.query.emailDrafts.findFirst({ where: and(eq(emailDrafts.id, input.draftId), eq(emailDrafts.workspaceId, input.workspaceId), eq(emailDrafts.origin, 'automation')) });
  if (!current) throw new Error('Workspace outbox draft not found.');
  if (current.version !== input.expectedVersion) throw new Error('This outbox draft has changed. Reload it before saving.');
  if (current.outboxStatus === 'sent' || current.outboxStatus === 'discarded') throw new Error('This outbox draft can no longer be edited.');
  const nextStatus = input.status || 'editing';
  const now = new Date();
  const [updated] = await db.update(emailDrafts).set({
    subject: input.subject.trim(), body: input.body, toJson: JSON.stringify(input.to), ccJson: JSON.stringify(input.cc || []), bccJson: JSON.stringify(input.bcc || []),
    outboxStatus: nextStatus, version: current.version + 1, editingByUserId: input.userId, editingStartedAt: now, updatedAt: now,
  }).where(and(eq(emailDrafts.id, current.id), eq(emailDrafts.version, current.version))).returning();
  if (!updated) throw new Error('This outbox draft has changed. Reload it before saving.');
  return publicOutboxDraft(updated);
}

type WorkspaceOutboxSendDependencies = {
  sendMessage?: (input: {
    userId: string;
    accountId: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
    isHtml: boolean;
  }) => Promise<unknown>;
};

export async function sendWorkspaceOutboxDraft(input: {
  userId: string; workspaceId: string; draftId: string; expectedVersion: number;
}, dependencies: WorkspaceOutboxSendDependencies = {}) {
  await requireWorkspace(input.userId, input.workspaceId, 'canWrite');
  const current = await db.query.emailDrafts.findFirst({
    where: and(eq(emailDrafts.id, input.draftId), eq(emailDrafts.workspaceId, input.workspaceId), eq(emailDrafts.origin, 'automation')),
  });
  if (!current) throw new Error('Workspace outbox draft not found.');
  if (current.version !== input.expectedVersion) throw new Error('This outbox draft has changed. Reload it before sending.');
  if (current.outboxStatus === 'sent' || current.outboxStatus === 'discarded' || current.outboxStatus === 'sending') {
    throw new Error('This outbox draft cannot be sent.');
  }
  const [mailbox] = await db.select({ accountId: emailAccounts.id, accountOwnerId: emailAccounts.userId })
    .from(workspaceEmailMailboxes)
    .innerJoin(emailAccounts, eq(emailAccounts.id, workspaceEmailMailboxes.emailAccountId))
    .where(and(
      eq(workspaceEmailMailboxes.id, current.mailboxId || ''),
      eq(workspaceEmailMailboxes.workspaceId, input.workspaceId),
      eq(workspaceEmailMailboxes.status, 'active'),
      eq(emailAccounts.status, 'active'),
    ))
    .limit(1);
  if (!mailbox || current.accountId !== mailbox.accountId) throw new Error('Workspace mailbox is no longer available.');

  const now = new Date();
  const [reserved] = await db.update(emailDrafts).set({
    outboxStatus: 'sending', version: current.version + 1, editingByUserId: input.userId, editingStartedAt: now, updatedAt: now,
  }).where(and(eq(emailDrafts.id, current.id), eq(emailDrafts.version, current.version))).returning();
  if (!reserved) throw new Error('This outbox draft has changed. Reload it before sending.');

  try {
    const sendInput = {
      userId: mailbox.accountOwnerId,
      accountId: mailbox.accountId,
      to: parseRecipients(current.toJson),
      cc: parseRecipients(current.ccJson),
      bcc: parseRecipients(current.bccJson),
      subject: current.subject,
      body: current.body,
      isHtml: current.isHtml,
    };
    if (dependencies.sendMessage) {
      await dependencies.sendMessage(sendInput);
    } else {
      const { sendEmailMessage } = await import('@/app/lib/email/service');
      await sendEmailMessage(sendInput.userId, {
        accountId: sendInput.accountId,
        to: sendInput.to,
        cc: sendInput.cc,
        bcc: sendInput.bcc,
        subject: sendInput.subject,
        body: sendInput.body,
        is_HTML: sendInput.isHtml,
      });
    }
    const sentAt = new Date();
    const [sent] = await db.update(emailDrafts).set({
      status: 'sent', outboxStatus: 'sent', sentByUserId: input.userId, sentAt, version: reserved.version + 1, updatedAt: sentAt,
    }).where(and(eq(emailDrafts.id, reserved.id), eq(emailDrafts.version, reserved.version), eq(emailDrafts.outboxStatus, 'sending'))).returning();
    if (!sent) throw new Error('Email was sent, but the outbox state could not be finalized.');
    if (current.inboxCaseId) {
      await db.update(emailInboxCases).set({ status: 'answered', updatedAt: sentAt }).where(eq(emailInboxCases.id, current.inboxCaseId));
    }
    await recordAuditEvent({
      source: 'workspace-email-outbox', eventType: 'email_outbox.sent', entityType: 'email_draft', entityId: current.id,
      action: 'send', status: 'success', workspaceId: input.workspaceId, userId: input.userId,
      summary: 'Workspace outbox draft sent after human confirmation.',
      metadata: { mailboxId: current.mailboxId, inboxCaseId: current.inboxCaseId, version: reserved.version, recipientCount: sendInput.to.length + sendInput.cc.length + sendInput.bcc.length },
    });
    return publicOutboxDraft(sent);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send workspace outbox draft.';
    await db.update(emailDrafts).set({
      outboxStatus: 'send_failed', version: reserved.version + 1, updatedAt: new Date(),
    }).where(and(eq(emailDrafts.id, reserved.id), eq(emailDrafts.version, reserved.version), eq(emailDrafts.outboxStatus, 'sending')));
    await recordAuditEvent({
      source: 'workspace-email-outbox', eventType: 'email_outbox.send_failed', entityType: 'email_draft', entityId: current.id,
      action: 'send', status: 'failure', workspaceId: input.workspaceId, userId: input.userId,
      summary: 'Workspace outbox draft send failed after human confirmation.', metadata: { mailboxId: current.mailboxId, error: message },
    });
    throw error;
  }
}

export { publicInboxCase, publicOutboxDraft };

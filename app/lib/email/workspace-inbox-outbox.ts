import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { emailAccounts, emailDrafts, emailInboxCases, workspaceEmailMailboxes } from '@/app/lib/db/schema';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';

type OutboxStatus = 'prepared' | 'awaiting_review' | 'editing' | 'sent' | 'discarded' | 'send_failed';
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
  originAutomationJobId?: string | null; originRunId?: string | null; originAgentId?: string | null;
}) {
  await requireWorkspace(input.userId, input.workspaceId, 'canWrite');
  const [mailbox] = await db.select({ accountId: emailAccounts.id, accountOwnerId: emailAccounts.userId })
    .from(workspaceEmailMailboxes)
    .innerJoin(emailAccounts, eq(emailAccounts.id, workspaceEmailMailboxes.emailAccountId))
    .where(and(eq(workspaceEmailMailboxes.id, input.mailboxId), eq(workspaceEmailMailboxes.workspaceId, input.workspaceId), eq(workspaceEmailMailboxes.status, 'active')))
    .limit(1);
  if (!mailbox) throw new Error('Workspace mailbox not found.');
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
    outboxStatus: 'awaiting_review', version: 1, assignedUserId: null, editingByUserId: null, editingStartedAt: null,
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

export { publicInboxCase, publicOutboxDraft };

import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { emailAccounts, emailDrafts, emailInboxCases, personalEmailInboxCases, workspaceEmailMailboxes } from '@/app/lib/db/schema';
import { getEmailAccountForUser } from '@/app/lib/email/account-store';
import { normalizeEmailAttachmentInputs } from '@/app/lib/email/attachments';
import type { EmailAttachmentInput } from '@/app/lib/email/attachment-types';
import { isLikelyHtmlEmailContent, normalizeEmailHtmlContent } from '@/app/lib/email/html-content';
import { plainTextToEmailHtml } from '@/app/lib/email/html-conversion';
import { sanitizeServerEmailEditorHtml } from '@/app/lib/email/server-html-editor-content';
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

function parseAttachments(value: string): EmailAttachmentInput[] {
  try {
    return normalizeEmailAttachmentInputs(JSON.parse(value));
  } catch {
    return [];
  }
}

function normalizeOutboxAttachments(value: unknown): EmailAttachmentInput[] {
  const attachments = normalizeEmailAttachmentInputs(value);
  if (attachments.some((attachment) => attachment.source !== 'upload')) {
    throw new Error('Outbox drafts accept uploaded attachment snapshots only.');
  }
  if (attachments.some((attachment) => attachment.disposition === 'inline')) {
    throw new Error('Outbox drafts do not support inline attachments.');
  }
  return attachments;
}

function prepareOutboxBody(body: string, bodyHtml?: string): string {
  const htmlCandidate = bodyHtml?.trim() || '';
  if (isLikelyHtmlEmailContent(normalizeEmailHtmlContent(htmlCandidate))) {
    return sanitizeServerEmailEditorHtml(htmlCandidate);
  }
  if (isLikelyHtmlEmailContent(normalizeEmailHtmlContent(body))) {
    return sanitizeServerEmailEditorHtml(body);
  }
  return plainTextToEmailHtml(body);
}

function publicOutboxDraft(draft: typeof emailDrafts.$inferSelect, senderAddress?: string | null) {
  return {
    id: draft.id, accountId: draft.accountId, workspaceId: draft.workspaceId, mailboxId: draft.mailboxId, inboxCaseId: draft.inboxCaseId,
    personalInboxCaseId: draft.personalInboxCaseId,
    senderAddress: senderAddress || null,
    status: draft.outboxStatus as OutboxStatus | null, version: draft.version, subject: draft.subject, body: draft.body,
    to: parseRecipients(draft.toJson), cc: parseRecipients(draft.ccJson), bcc: parseRecipients(draft.bccJson),
    attachments: parseAttachments(draft.attachmentsJson || '[]'),
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

function publicPersonalInboxCase(item: typeof personalEmailInboxCases.$inferSelect) {
  return {
    id: item.id, workspaceId: null, mailboxId: `account:${item.emailAccountId}`, providerThreadId: item.providerThreadId,
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
  const rows = await db.select({ draft: emailDrafts, senderAddress: emailAccounts.emailAddress })
    .from(emailDrafts)
    .innerJoin(emailAccounts, eq(emailAccounts.id, emailDrafts.accountId))
    .where(and(eq(emailDrafts.workspaceId, workspaceId), inArray(emailDrafts.origin, ['automation', 'agent'])))
    .orderBy(desc(emailDrafts.updatedAt));
  return rows.map(({ draft, senderAddress }) => publicOutboxDraft(draft, senderAddress));
}

export async function findWorkspaceInboxCase(userId: string, workspaceId: string, caseId: string) {
  await requireWorkspace(userId, workspaceId, 'canRead');
  const item = await db.query.emailInboxCases.findFirst({
    where: and(eq(emailInboxCases.id, caseId), eq(emailInboxCases.workspaceId, workspaceId)),
  });
  return item ? publicInboxCase(item) : null;
}

export async function findWorkspaceOutboxDraft(userId: string, workspaceId: string, draftId: string) {
  await requireWorkspace(userId, workspaceId, 'canRead');
  const [row] = await db.select({ draft: emailDrafts, senderAddress: emailAccounts.emailAddress })
    .from(emailDrafts)
    .innerJoin(emailAccounts, eq(emailAccounts.id, emailDrafts.accountId))
    .where(and(
      eq(emailDrafts.id, draftId),
      eq(emailDrafts.workspaceId, workspaceId),
      inArray(emailDrafts.origin, ['automation', 'agent']),
    ))
    .limit(1);
  return row ? publicOutboxDraft(row.draft, row.senderAddress) : null;
}

export async function listPersonalInboxCases(userId: string) {
  const rows = await db.query.personalEmailInboxCases.findMany({
    where: eq(personalEmailInboxCases.userId, userId),
    orderBy: [desc(personalEmailInboxCases.updatedAt)],
  });
  return rows.map(publicPersonalInboxCase);
}

export async function listPersonalOutboxDrafts(userId: string) {
  const rows = await db.select({ draft: emailDrafts, senderAddress: emailAccounts.emailAddress })
    .from(emailDrafts)
    .innerJoin(emailAccounts, eq(emailAccounts.id, emailDrafts.accountId))
    .where(and(eq(emailDrafts.userId, userId), isNull(emailDrafts.workspaceId), eq(emailDrafts.origin, 'agent')))
    .orderBy(desc(emailDrafts.updatedAt));
  return rows.map(({ draft, senderAddress }) => publicOutboxDraft(draft, senderAddress));
}

export async function findPersonalInboxCase(userId: string, caseId: string) {
  const item = await db.query.personalEmailInboxCases.findFirst({
    where: and(eq(personalEmailInboxCases.id, caseId), eq(personalEmailInboxCases.userId, userId)),
  });
  return item ? publicPersonalInboxCase(item) : null;
}

export async function findPersonalOutboxDraft(userId: string, draftId: string) {
  const [row] = await db.select({ draft: emailDrafts, senderAddress: emailAccounts.emailAddress })
    .from(emailDrafts)
    .innerJoin(emailAccounts, eq(emailAccounts.id, emailDrafts.accountId))
    .where(and(
      eq(emailDrafts.id, draftId),
      eq(emailDrafts.userId, userId),
      isNull(emailDrafts.workspaceId),
      eq(emailDrafts.origin, 'agent'),
    ))
    .limit(1);
  return row ? publicOutboxDraft(row.draft, row.senderAddress) : null;
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
        inArray(emailDrafts.origin, ['automation', 'agent']),
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
  await recordAuditEvent({
    source: 'workspace-email-inbox', eventType: 'email_inbox_case.upsert', entityType: 'email_inbox_case', entityId: item.id,
    action: 'upsert', status: 'success', workspaceId: input.workspaceId, userId: input.userId,
    summary: `Inbox case ${item.subject} created or updated.`, metadata: { mailboxId: input.mailboxId, status: item.status, priority: item.priority },
  });
  return publicInboxCase(item);
}

export async function createPersonalInboxCase(input: {
  userId: string; accountId: string; providerThreadId: string; subject: string;
  latestProviderMessageId?: string | null; requesterAddress?: string | null; requesterName?: string | null;
  status?: InboxCaseStatus; priority?: 'low' | 'normal' | 'high' | 'urgent'; assigneeUserId?: string | null;
}) {
  await getEmailAccountForUser(input.userId, input.accountId);
  const now = new Date();
  const id = `personal-inbox-case-${randomUUID()}`;
  await db.insert(personalEmailInboxCases).values({
    id, userId: input.userId, emailAccountId: input.accountId, providerThreadId: input.providerThreadId,
    latestProviderMessageId: input.latestProviderMessageId || null, requesterAddress: input.requesterAddress || null,
    requesterName: input.requesterName || null, subject: input.subject.trim() || '(No subject)',
    status: input.status || 'new', priority: input.priority || 'normal', assigneeUserId: input.assigneeUserId || null,
    closedAt: input.status === 'closed' ? now : null, createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [personalEmailInboxCases.emailAccountId, personalEmailInboxCases.providerThreadId],
    set: {
      latestProviderMessageId: input.latestProviderMessageId || null,
      subject: input.subject.trim() || '(No subject)', status: input.status || 'new', priority: input.priority || 'normal',
      assigneeUserId: input.assigneeUserId || null, closedAt: input.status === 'closed' ? now : null, updatedAt: now,
    },
  });
  const item = await db.query.personalEmailInboxCases.findFirst({
    where: and(eq(personalEmailInboxCases.userId, input.userId), eq(personalEmailInboxCases.emailAccountId, input.accountId), eq(personalEmailInboxCases.providerThreadId, input.providerThreadId)),
  });
  if (!item) throw new Error('Personal inbox case could not be created.');
  return publicPersonalInboxCase(item);
}

export async function createWorkspaceOutboxDraft(input: {
  userId: string; workspaceId: string; mailboxId: string; inboxCaseId?: string | null;
  subject: string; body: string; to: string[]; cc?: string[]; bcc?: string[];
  bodyHtml?: string;
  attachments?: EmailAttachmentInput[];
  originAutomationJobId?: string | null; originRunId?: string | null; originAgentId?: string | null; assignedUserId?: string | null;
  origin?: 'automation' | 'agent';
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
  const attachments = normalizeOutboxAttachments(input.attachments);
  const preparedBody = prepareOutboxBody(input.body, input.bodyHtml);
  const now = new Date();
  const id = `draft_${randomUUID()}`;
  await db.insert(emailDrafts).values({
    id, userId: mailbox.accountOwnerId, accountId: mailbox.accountId, status: 'draft',
    toJson: JSON.stringify(input.to), ccJson: JSON.stringify(input.cc || []), bccJson: JSON.stringify(input.bcc || []),
    subject: input.subject.trim(), body: preparedBody, isHtml: true, attachmentsJson: JSON.stringify(attachments), providerDraftId: null,
    workspaceId: input.workspaceId, mailboxId: input.mailboxId, inboxCaseId: input.inboxCaseId || null,
    origin: input.origin || 'agent', originAutomationJobId: input.originAutomationJobId || null,
    originRunId: input.originRunId || null, originAgentId: input.originAgentId || null,
    outboxStatus: input.initialStatus || 'awaiting_review', version: 1, assignedUserId: input.assignedUserId || null, editingByUserId: null, editingStartedAt: null,
    sentByUserId: null, sentAt: null, createdAt: now, updatedAt: now,
  });
  const draft = await db.query.emailDrafts.findFirst({ where: eq(emailDrafts.id, id) });
  if (!draft) throw new Error('Workspace outbox draft could not be created.');
  if (input.inboxCaseId) {
    await db.update(emailInboxCases)
      .set({ status: 'awaiting_review', updatedAt: now })
      .where(and(eq(emailInboxCases.id, input.inboxCaseId), eq(emailInboxCases.workspaceId, input.workspaceId)));
  }
  await recordAuditEvent({
    source: 'workspace-email-outbox', eventType: 'email_outbox.prepared', entityType: 'email_draft', entityId: draft.id,
    action: 'create', status: 'success', workspaceId: input.workspaceId, userId: input.userId,
    summary: 'Workspace outbox draft prepared for human review.',
    metadata: { mailboxId: input.mailboxId, inboxCaseId: input.inboxCaseId || null, origin: input.origin || 'agent' },
  });
  void import('@/app/lib/mobile/push-devices')
    .then(({ sendWorkspaceOutboxReviewPush }) => sendWorkspaceOutboxReviewPush({
      userId: input.assignedUserId || input.userId,
      workspaceId: input.workspaceId,
      draftId: draft.id,
      subject: draft.subject,
    }))
    .catch(() => undefined);
  return publicOutboxDraft(draft);
}

export async function createPersonalOutboxDraft(input: {
  userId: string; accountId: string; inboxCaseId?: string | null;
  subject: string; body: string; to: string[]; cc?: string[]; bcc?: string[];
  bodyHtml?: string;
  attachments?: EmailAttachmentInput[];
  originAgentId?: string | null;
}) {
  await getEmailAccountForUser(input.userId, input.accountId);
  if (input.inboxCaseId) {
    const inboxCase = await db.query.personalEmailInboxCases.findFirst({
      where: and(eq(personalEmailInboxCases.id, input.inboxCaseId), eq(personalEmailInboxCases.userId, input.userId), eq(personalEmailInboxCases.emailAccountId, input.accountId)),
      columns: { id: true },
    });
    if (!inboxCase) throw new Error('Personal inbox case does not belong to this mailbox.');
  }
  const attachments = normalizeOutboxAttachments(input.attachments);
  const preparedBody = prepareOutboxBody(input.body, input.bodyHtml);
  const now = new Date();
  const id = `draft_${randomUUID()}`;
  await db.insert(emailDrafts).values({
    id, userId: input.userId, accountId: input.accountId, status: 'draft',
    toJson: JSON.stringify(input.to), ccJson: JSON.stringify(input.cc || []), bccJson: JSON.stringify(input.bcc || []),
    subject: input.subject.trim(), body: preparedBody, isHtml: true, attachmentsJson: JSON.stringify(attachments), providerDraftId: null,
    workspaceId: null, mailboxId: null, inboxCaseId: null, personalInboxCaseId: input.inboxCaseId || null,
    origin: 'agent', originAutomationJobId: null, originRunId: null, originAgentId: input.originAgentId || null,
    outboxStatus: 'awaiting_review', version: 1, assignedUserId: input.userId, editingByUserId: null, editingStartedAt: null,
    sentByUserId: null, sentAt: null, createdAt: now, updatedAt: now,
  });
  const draft = await db.query.emailDrafts.findFirst({ where: and(eq(emailDrafts.id, id), eq(emailDrafts.userId, input.userId)) });
  if (!draft) throw new Error('Personal outbox draft could not be created.');
  if (input.inboxCaseId) {
    await db.update(personalEmailInboxCases)
      .set({ status: 'awaiting_review', updatedAt: now })
      .where(and(eq(personalEmailInboxCases.id, input.inboxCaseId), eq(personalEmailInboxCases.userId, input.userId)));
  }
  return publicOutboxDraft(draft);
}

export async function updateWorkspaceOutboxDraft(input: {
  userId: string; workspaceId: string; draftId: string; expectedVersion: number; subject: string; body: string;
  to: string[]; cc?: string[]; bcc?: string[]; status?: Extract<OutboxStatus, 'awaiting_review' | 'editing' | 'discarded'>;
  bodyHtml?: string;
  attachments?: EmailAttachmentInput[];
  actor?: 'human' | 'agent';
}) {
  await requireWorkspace(input.userId, input.workspaceId, 'canWrite');
  const current = await db.query.emailDrafts.findFirst({ where: and(eq(emailDrafts.id, input.draftId), eq(emailDrafts.workspaceId, input.workspaceId), inArray(emailDrafts.origin, ['automation', 'agent'])) });
  if (!current) throw new Error('Workspace outbox draft not found.');
  if (current.version !== input.expectedVersion) throw new Error('This outbox draft has changed. Reload it before saving.');
  if (current.outboxStatus === 'sent' || current.outboxStatus === 'discarded') throw new Error('This outbox draft can no longer be edited.');
  if (input.actor === 'agent' && current.editingByUserId) {
    throw new Error('This outbox draft is being reviewed by a person. Create a new draft instead of overwriting it.');
  }
  const attachments = input.attachments === undefined
    ? parseAttachments(current.attachmentsJson || '[]')
    : normalizeOutboxAttachments(input.attachments);
  const preparedBody = prepareOutboxBody(input.body, input.bodyHtml);
  const nextStatus = input.status || 'editing';
  const now = new Date();
  const [updated] = await db.update(emailDrafts).set({
    subject: input.subject.trim(), body: preparedBody, toJson: JSON.stringify(input.to), ccJson: JSON.stringify(input.cc || []), bccJson: JSON.stringify(input.bcc || []), attachmentsJson: JSON.stringify(attachments),
    outboxStatus: nextStatus, version: current.version + 1,
    editingByUserId: input.actor === 'agent' ? null : input.userId,
    editingStartedAt: input.actor === 'agent' ? null : now,
    updatedAt: now,
  }).where(and(eq(emailDrafts.id, current.id), eq(emailDrafts.version, current.version))).returning();
  if (!updated) throw new Error('This outbox draft has changed. Reload it before saving.');
  await recordAuditEvent({
    source: 'workspace-email-outbox', eventType: 'email_outbox.updated', entityType: 'email_draft', entityId: updated.id,
    action: 'update', status: 'success', workspaceId: input.workspaceId, userId: input.userId,
    summary: input.actor === 'agent' ? 'Workspace outbox draft updated by an agent.' : 'Workspace outbox draft updated for review.',
    metadata: { status: updated.outboxStatus, version: updated.version, actor: input.actor || 'human' },
  });
  return publicOutboxDraft(updated);
}

export async function updatePersonalOutboxDraft(input: {
  userId: string; draftId: string; expectedVersion: number; subject: string; body: string;
  to: string[]; cc?: string[]; bcc?: string[]; status?: Extract<OutboxStatus, 'awaiting_review' | 'editing' | 'discarded'>;
  bodyHtml?: string;
  attachments?: EmailAttachmentInput[];
  actor?: 'human' | 'agent';
}) {
  const current = await db.query.emailDrafts.findFirst({
    where: and(eq(emailDrafts.id, input.draftId), eq(emailDrafts.userId, input.userId), isNull(emailDrafts.workspaceId), eq(emailDrafts.origin, 'agent')),
  });
  if (!current) throw new Error('Personal outbox draft not found.');
  if (current.version !== input.expectedVersion) throw new Error('This outbox draft has changed. Reload it before saving.');
  if (current.outboxStatus === 'sent' || current.outboxStatus === 'discarded') throw new Error('This outbox draft can no longer be edited.');
  if (input.actor === 'agent' && current.editingByUserId) {
    throw new Error('This outbox draft is being reviewed by a person. Create a new draft instead of overwriting it.');
  }
  const attachments = input.attachments === undefined
    ? parseAttachments(current.attachmentsJson || '[]')
    : normalizeOutboxAttachments(input.attachments);
  const preparedBody = prepareOutboxBody(input.body, input.bodyHtml);
  const now = new Date();
  const [updated] = await db.update(emailDrafts).set({
    subject: input.subject.trim(), body: preparedBody, toJson: JSON.stringify(input.to), ccJson: JSON.stringify(input.cc || []), bccJson: JSON.stringify(input.bcc || []), attachmentsJson: JSON.stringify(attachments),
    outboxStatus: input.status || 'editing', version: current.version + 1,
    editingByUserId: input.actor === 'agent' ? null : input.userId,
    editingStartedAt: input.actor === 'agent' ? null : now,
    updatedAt: now,
  }).where(and(eq(emailDrafts.id, current.id), eq(emailDrafts.version, current.version))).returning();
  if (!updated) throw new Error('This outbox draft has changed. Reload it before saving.');
  return publicOutboxDraft(updated);
}

export async function sendPersonalOutboxDraft(input: {
  userId: string; draftId: string; expectedVersion: number;
}, dependencies: WorkspaceOutboxSendDependencies = {}) {
  const current = await db.query.emailDrafts.findFirst({
    where: and(eq(emailDrafts.id, input.draftId), eq(emailDrafts.userId, input.userId), isNull(emailDrafts.workspaceId), eq(emailDrafts.origin, 'agent')),
  });
  if (!current) throw new Error('Personal outbox draft not found.');
  if (current.version !== input.expectedVersion) throw new Error('This outbox draft has changed. Reload it before sending.');
  if (current.outboxStatus === 'sent' || current.outboxStatus === 'discarded' || current.outboxStatus === 'sending') {
    throw new Error('This outbox draft cannot be sent.');
  }
  await getEmailAccountForUser(input.userId, current.accountId);
  const now = new Date();
  const [reserved] = await db.update(emailDrafts).set({
    outboxStatus: 'sending', version: current.version + 1, editingByUserId: input.userId, editingStartedAt: now, updatedAt: now,
  }).where(and(eq(emailDrafts.id, current.id), eq(emailDrafts.version, current.version))).returning();
  if (!reserved) throw new Error('This outbox draft has changed. Reload it before sending.');

  try {
    const sendInput = {
      userId: input.userId, accountId: current.accountId, to: parseRecipients(current.toJson), cc: parseRecipients(current.ccJson),
      bcc: parseRecipients(current.bccJson), subject: current.subject, body: current.body, isHtml: current.isHtml,
      attachments: parseAttachments(current.attachmentsJson || '[]'),
    };
    if (dependencies.sendMessage) {
      await dependencies.sendMessage(sendInput);
    } else {
      const { sendEmailMessage } = await import('@/app/lib/email/service');
      await sendEmailMessage(input.userId, {
        accountId: current.accountId, to: sendInput.to, cc: sendInput.cc, bcc: sendInput.bcc,
        subject: current.subject, body: current.body, is_HTML: current.isHtml,
        attachments: sendInput.attachments,
      }, { deliveryOrigin: 'human' });
    }
    const sentAt = new Date();
    const [sent] = await db.update(emailDrafts).set({
      status: 'sent', outboxStatus: 'sent', sentByUserId: input.userId, sentAt, version: reserved.version + 1, updatedAt: sentAt,
    }).where(and(eq(emailDrafts.id, reserved.id), eq(emailDrafts.version, reserved.version), eq(emailDrafts.outboxStatus, 'sending'))).returning();
    if (!sent) throw new Error('This outbox draft changed while it was being sent.');
    return publicOutboxDraft(sent);
  } catch (error) {
    const failedAt = new Date();
    await db.update(emailDrafts).set({
      outboxStatus: 'send_failed', version: reserved.version + 1, updatedAt: failedAt,
    }).where(and(eq(emailDrafts.id, reserved.id), eq(emailDrafts.version, reserved.version), eq(emailDrafts.outboxStatus, 'sending')));
    throw error;
  }
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
    attachments: EmailAttachmentInput[];
  }) => Promise<unknown>;
};

export async function sendWorkspaceOutboxDraft(input: {
  userId: string; workspaceId: string; draftId: string; expectedVersion: number;
}, dependencies: WorkspaceOutboxSendDependencies = {}) {
  await requireWorkspace(input.userId, input.workspaceId, 'canWrite');
  const current = await db.query.emailDrafts.findFirst({
    where: and(eq(emailDrafts.id, input.draftId), eq(emailDrafts.workspaceId, input.workspaceId), inArray(emailDrafts.origin, ['automation', 'agent'])),
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
      attachments: parseAttachments(current.attachmentsJson || '[]'),
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
        attachments: sendInput.attachments,
      }, { deliveryOrigin: 'human' });
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

export { publicInboxCase, publicOutboxDraft, publicPersonalInboxCase };

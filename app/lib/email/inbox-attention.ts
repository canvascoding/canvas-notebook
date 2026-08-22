import 'server-only';

import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
} from 'drizzle-orm';

import { db } from '@/app/lib/db';
import {
  emailDrafts,
  emailInboxCases,
  personalEmailInboxCases,
} from '@/app/lib/db/schema';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const ACTIVE_CASE_STATUSES = ['new', 'in_progress', 'awaiting_review', 'needs_routing'] as const;
const ACTIVE_DRAFT_STATUSES = ['awaiting_review', 'editing', 'send_failed'] as const;

export type EmailAttentionTarget =
  | {
      kind: 'email';
      scope: 'personal';
      caseId?: string;
      draftId?: string;
    }
  | {
      kind: 'email';
      scope: 'workspace';
      caseId?: string;
      draftId?: string;
    };

export type EmailAttentionItem = {
  id: string;
  type: 'email.attention';
  title: string;
  detail: string;
  occurredAt: string;
  priority: 'normal' | 'high';
  attentionRequired: true;
  target: EmailAttentionTarget;
};

type DraftRow = typeof emailDrafts.$inferSelect;

function normalizePriority(value: string | null | undefined): 'normal' | 'high' {
  return value === 'high' || value === 'urgent' || value === 'send_failed' ? 'high' : 'normal';
}

function draftDetail(draft: DraftRow): string {
  if (draft.outboxStatus === 'send_failed') return 'Email send failed';
  if (draft.outboxStatus === 'editing') return 'Email draft is being reviewed';
  return 'Email review required';
}

function caseDetail(input: { status: string; draft?: DraftRow | null }): string {
  if (input.draft) return draftDetail(input.draft);
  if (input.status === 'needs_routing') return 'Email needs routing';
  if (input.status === 'awaiting_review') return 'Email review required';
  if (input.status === 'in_progress') return 'Email is in progress';
  return 'New email requires attention';
}

async function resolveReadableWorkspace(input: {
  userId: string;
  workspace: WorkspaceContext;
}): Promise<WorkspaceContext> {
  return resolveAgentSessionWorkspaceForUser({
    userId: input.userId,
    workspaceId: input.workspace.workspaceId,
    permissions: ['canRead'],
  });
}

function latestDraftByCaseId(drafts: DraftRow[], field: 'inboxCaseId' | 'personalInboxCaseId'): Map<string, DraftRow> {
  const result = new Map<string, DraftRow>();
  for (const draft of drafts) {
    const caseId = draft[field];
    if (!caseId) continue;
    const current = result.get(caseId);
    if (!current || current.updatedAt < draft.updatedAt) result.set(caseId, draft);
  }
  return result;
}

function sortItems(items: EmailAttentionItem[]): EmailAttentionItem[] {
  return items.sort((left, right) => (
    right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id)
  ));
}

async function listWorkspaceAttention(input: {
  userId: string;
  workspace: WorkspaceContext;
}): Promise<EmailAttentionItem[]> {
  const workspace = await resolveReadableWorkspace(input);
  if (workspace.workspaceType === 'personal') return listPersonalAttention({ userId: input.userId, workspace });

  const [cases, drafts] = await Promise.all([
    db.query.emailInboxCases.findMany({
      where: and(
        eq(emailInboxCases.workspaceId, workspace.workspaceId),
        inArray(emailInboxCases.status, ACTIVE_CASE_STATUSES),
      ),
      orderBy: [desc(emailInboxCases.updatedAt), desc(emailInboxCases.id)],
    }),
    db.query.emailDrafts.findMany({
      where: and(
        eq(emailDrafts.workspaceId, workspace.workspaceId),
        inArray(emailDrafts.origin, ['automation', 'agent']),
        inArray(emailDrafts.outboxStatus, ACTIVE_DRAFT_STATUSES),
      ),
      orderBy: [desc(emailDrafts.updatedAt), desc(emailDrafts.id)],
    }),
  ]);
  const draftsByCaseId = latestDraftByCaseId(drafts, 'inboxCaseId');
  const items: EmailAttentionItem[] = cases.map((emailCase) => {
    const draft = draftsByCaseId.get(emailCase.id) ?? null;
    const occurredAt = draft && draft.updatedAt > emailCase.updatedAt ? draft.updatedAt : emailCase.updatedAt;
    return {
      id: `email-case:${emailCase.id}`,
      type: 'email.attention',
      title: emailCase.subject,
      detail: caseDetail({ status: emailCase.status, draft }),
      occurredAt: occurredAt.toISOString(),
      priority: draft?.outboxStatus === 'send_failed' ? 'high' : normalizePriority(emailCase.priority),
      attentionRequired: true,
      target: {
        kind: 'email',
        scope: 'workspace',
        caseId: emailCase.id,
        ...(draft ? { draftId: draft.id } : {}),
      },
    };
  });
  for (const draft of drafts) {
    if (draft.inboxCaseId) continue;
    items.push({
      id: `email-draft:${draft.id}`,
      type: 'email.attention',
      title: draft.subject || '(No subject)',
      detail: draftDetail(draft),
      occurredAt: draft.updatedAt.toISOString(),
      priority: normalizePriority(draft.outboxStatus),
      attentionRequired: true,
      target: { kind: 'email', scope: 'workspace', draftId: draft.id },
    });
  }
  return sortItems(items);
}

async function listPersonalAttention(input: {
  userId: string;
  workspace: WorkspaceContext;
}): Promise<EmailAttentionItem[]> {
  const [cases, drafts] = await Promise.all([
    db.query.personalEmailInboxCases.findMany({
      where: and(
        eq(personalEmailInboxCases.userId, input.userId),
        inArray(personalEmailInboxCases.status, ACTIVE_CASE_STATUSES),
      ),
      orderBy: [desc(personalEmailInboxCases.updatedAt), desc(personalEmailInboxCases.id)],
    }),
    db.query.emailDrafts.findMany({
      where: and(
        eq(emailDrafts.userId, input.userId),
        isNull(emailDrafts.workspaceId),
        eq(emailDrafts.origin, 'agent'),
        inArray(emailDrafts.outboxStatus, ACTIVE_DRAFT_STATUSES),
      ),
      orderBy: [desc(emailDrafts.updatedAt), desc(emailDrafts.id)],
    }),
  ]);
  const draftsByCaseId = latestDraftByCaseId(drafts, 'personalInboxCaseId');
  const items: EmailAttentionItem[] = cases.map((emailCase) => {
    const draft = draftsByCaseId.get(emailCase.id) ?? null;
    const occurredAt = draft && draft.updatedAt > emailCase.updatedAt ? draft.updatedAt : emailCase.updatedAt;
    return {
      id: `email-case:${emailCase.id}`,
      type: 'email.attention',
      title: emailCase.subject,
      detail: caseDetail({ status: emailCase.status, draft }),
      occurredAt: occurredAt.toISOString(),
      priority: draft?.outboxStatus === 'send_failed' ? 'high' : normalizePriority(emailCase.priority),
      attentionRequired: true,
      target: {
        kind: 'email',
        scope: 'personal',
        caseId: emailCase.id,
        ...(draft ? { draftId: draft.id } : {}),
      },
    };
  });
  for (const draft of drafts) {
    if (draft.personalInboxCaseId) continue;
    items.push({
      id: `email-draft:${draft.id}`,
      type: 'email.attention',
      title: draft.subject || '(No subject)',
      detail: draftDetail(draft),
      occurredAt: draft.updatedAt.toISOString(),
      priority: normalizePriority(draft.outboxStatus),
      attentionRequired: true,
      target: { kind: 'email', scope: 'personal', draftId: draft.id },
    });
  }
  return sortItems(items);
}

export async function listEmailAttention(input: {
  userId: string;
  workspace: WorkspaceContext;
}): Promise<EmailAttentionItem[]> {
  return listWorkspaceAttention(input);
}

export async function countEmailAttention(input: {
  userId: string;
  workspace: WorkspaceContext;
}): Promise<number> {
  const workspace = await resolveReadableWorkspace(input);
  if (workspace.workspaceType === 'personal') {
    const [caseCount, draftCount] = await Promise.all([
      db.select({ total: count() }).from(personalEmailInboxCases).where(and(
        eq(personalEmailInboxCases.userId, input.userId),
        inArray(personalEmailInboxCases.status, ACTIVE_CASE_STATUSES),
      )),
      db.select({ total: count() }).from(emailDrafts).where(and(
        eq(emailDrafts.userId, input.userId),
        isNull(emailDrafts.workspaceId),
        eq(emailDrafts.origin, 'agent'),
        isNull(emailDrafts.personalInboxCaseId),
        inArray(emailDrafts.outboxStatus, ACTIVE_DRAFT_STATUSES),
      )),
    ]);
    return Number(caseCount[0]?.total ?? 0) + Number(draftCount[0]?.total ?? 0);
  }
  const [caseCount, draftCount] = await Promise.all([
    db.select({ total: count() }).from(emailInboxCases).where(and(
      eq(emailInboxCases.workspaceId, workspace.workspaceId),
      inArray(emailInboxCases.status, ACTIVE_CASE_STATUSES),
    )),
    db.select({ total: count() }).from(emailDrafts).where(and(
      eq(emailDrafts.workspaceId, workspace.workspaceId),
      inArray(emailDrafts.origin, ['automation', 'agent']),
      isNull(emailDrafts.inboxCaseId),
      inArray(emailDrafts.outboxStatus, ACTIVE_DRAFT_STATUSES),
    )),
  ]);
  return Number(caseCount[0]?.total ?? 0) + Number(draftCount[0]?.total ?? 0);
}

import 'server-only';

import {
  findPersonalInboxCase,
  findPersonalOutboxDraft,
  findWorkspaceInboxCase,
  findWorkspaceOutboxDraft,
  sendPersonalOutboxDraft,
  sendWorkspaceOutboxDraft,
} from '@/app/lib/email/workspace-inbox-outbox';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const SENDABLE_REVIEW_STATUSES = new Set([
  'prepared',
  'awaiting_review',
  'editing',
  'send_failed',
]);

type OutboxDraft = NonNullable<Awaited<ReturnType<typeof findWorkspaceOutboxDraft>>>;
type InboxCase = NonNullable<Awaited<ReturnType<typeof findWorkspaceInboxCase>>>;

export type MobileEmailReview = {
  id: string;
  status: OutboxDraft['status'];
  version: number;
  subject: string;
  body: string;
  to: string[];
  cc: string[];
  bcc: string[];
  isHtml: boolean;
  editingByOther: boolean;
  canSend: boolean;
  updatedAt: string;
};

export type MobileEmailCase = Pick<
  InboxCase,
  'id' | 'subject' | 'requesterName' | 'requesterAddress' | 'status' | 'priority' | 'assigneeUserId' | 'updatedAt'
>;

export class MobileEmailError extends Error {
  constructor(
    message: string,
    public readonly code: 'EMAIL_CASE_NOT_FOUND' | 'EMAIL_REVIEW_NOT_FOUND' | 'EMAIL_REVIEW_NOT_SENDABLE' | 'INVALID_EMAIL_REVIEW',
    public readonly status: number,
  ) {
    super(message);
  }
}

function isPersonalWorkspace(workspace: WorkspaceContext): boolean {
  return workspace.workspaceType === 'personal';
}

function serializeReview(draft: OutboxDraft, userId: string): MobileEmailReview {
  const editingByOther = Boolean(draft.editingByUserId && draft.editingByUserId !== userId);
  return {
    id: draft.id,
    status: draft.status,
    version: draft.version,
    subject: draft.subject,
    body: draft.body,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    isHtml: draft.isHtml,
    editingByOther,
    canSend: !editingByOther && SENDABLE_REVIEW_STATUSES.has(draft.status || ''),
    updatedAt: draft.updatedAt,
  };
}

export async function getMobileEmailReview(input: {
  userId: string;
  workspace: WorkspaceContext;
  draftId: string;
}): Promise<MobileEmailReview> {
  const draft = isPersonalWorkspace(input.workspace)
    ? await findPersonalOutboxDraft(input.userId, input.draftId)
    : await findWorkspaceOutboxDraft(input.userId, input.workspace.workspaceId, input.draftId);
  if (!draft) {
    throw new MobileEmailError('Email review was not found.', 'EMAIL_REVIEW_NOT_FOUND', 404);
  }
  return serializeReview(draft, input.userId);
}

export async function getMobileEmailCase(input: {
  userId: string;
  workspace: WorkspaceContext;
  caseId: string;
}): Promise<MobileEmailCase> {
  const item = isPersonalWorkspace(input.workspace)
    ? await findPersonalInboxCase(input.userId, input.caseId)
    : await findWorkspaceInboxCase(input.userId, input.workspace.workspaceId, input.caseId);
  if (!item) {
    throw new MobileEmailError('Email case was not found.', 'EMAIL_CASE_NOT_FOUND', 404);
  }
  return {
    id: item.id,
    subject: item.subject,
    requesterName: item.requesterName,
    requesterAddress: item.requesterAddress,
    status: item.status,
    priority: item.priority,
    assigneeUserId: item.assigneeUserId,
    updatedAt: item.updatedAt,
  };
}

export async function sendMobileEmailReview(input: {
  userId: string;
  workspace: WorkspaceContext;
  draftId: string;
  expectedVersion: number;
}): Promise<MobileEmailReview> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new MobileEmailError('A current email review version is required.', 'INVALID_EMAIL_REVIEW', 400);
  }
  const current = await getMobileEmailReview(input);
  if (!current.canSend) {
    throw new MobileEmailError('This email review cannot be sent.', 'EMAIL_REVIEW_NOT_SENDABLE', 409);
  }
  const sent = isPersonalWorkspace(input.workspace)
    ? await sendPersonalOutboxDraft({
      userId: input.userId,
      draftId: input.draftId,
      expectedVersion: input.expectedVersion,
    })
    : await sendWorkspaceOutboxDraft({
      userId: input.userId,
      workspaceId: input.workspace.workspaceId,
      draftId: input.draftId,
      expectedVersion: input.expectedVersion,
    });
  return serializeReview(sent, input.userId);
}

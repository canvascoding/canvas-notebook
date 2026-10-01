import 'server-only';

import { createHash } from 'node:crypto';

import { inferEmailAttachmentMimeType } from '@/app/lib/email/attachment-types';
import { OutboxSendError, type OutboxFailureCode } from '@/app/lib/email/outbox-errors';
import {
  findPersonalInboxCase,
  findPersonalOutboxDraft,
  findWorkspaceInboxCase,
  findWorkspaceOutboxDraft,
  listPersonalOutboxDrafts,
  listWorkspaceOutboxDrafts,
  rejectPersonalOutboxDraft,
  rejectWorkspaceOutboxDraft,
  sendPersonalOutboxDraft,
  sendWorkspaceOutboxDraft,
  updatePersonalOutboxDraft,
  updateWorkspaceOutboxDraft,
} from '@/app/lib/email/workspace-inbox-outbox';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const SENDABLE_REVIEW_STATUSES = new Set([
  'prepared',
  'awaiting_review',
  'editing',
  'send_failed',
]);
const PENDING_REVIEW_STATUSES = new Set([...SENDABLE_REVIEW_STATUSES, 'sending', 'send_uncertain']);

const SEND_ERROR_MESSAGES: Record<OutboxFailureCode, string> = {
  SEND_POLICY_BLOCKED: 'The sending account policy blocks these recipients. Update the recipients or the account policy before trying again.',
  SEND_FAILED: 'The email could not be sent. Check the sending account and recipients before trying again.',
  SEND_UNCERTAIN: 'Delivery could not be confirmed. The provider may have accepted this email. Check Sent mail; retry is disabled to prevent duplicate delivery.',
};

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
  canEdit: boolean;
  canReject: boolean;
  scope: 'personal' | 'workspace';
  workspaceId: string;
  workspaceName: string;
  senderAddress: string | null;
  mailboxId: string | null;
  accountId: string;
  attachments: Array<{ id: string; name: string; mimeType: string; size: number }>;
  errorCode: OutboxFailureCode | null;
  errorMessage: string | null;
  failedAt: string | null;
  updatedAt: string;
};

export type MobileEmailCase = Pick<
  InboxCase,
  'id' | 'subject' | 'requesterName' | 'requesterAddress' | 'status' | 'priority' | 'assigneeUserId' | 'updatedAt'
>;

export class MobileEmailError extends Error {
  constructor(
    message: string,
    public readonly code: 'EMAIL_CASE_NOT_FOUND' | 'EMAIL_REVIEW_NOT_FOUND' | 'EMAIL_REVIEW_NOT_SENDABLE' | 'EMAIL_REVIEW_NOT_EDITABLE' | 'EMAIL_REVIEW_NOT_REJECTABLE' | 'EMAIL_REVIEW_READ_ONLY' | 'EMAIL_REVIEW_VERSION_CONFLICT' | 'INVALID_EMAIL_REVIEW' | 'INVALID_EMAIL_REVIEW_CURSOR' | OutboxFailureCode,
    public readonly status: number,
    public readonly data?: MobileEmailReview,
  ) {
    super(message);
  }
}

type MobileEmailSendDependencies = NonNullable<Parameters<typeof sendPersonalOutboxDraft>[1]>;

function isPersonalWorkspace(workspace: WorkspaceContext): boolean {
  return workspace.workspaceType === 'personal';
}

function serializeReview(draft: OutboxDraft, userId: string, workspace: WorkspaceContext): MobileEmailReview {
  const editingByOther = Boolean(draft.editingByUserId && draft.editingByUserId !== userId);
  const canDecide = workspace.permissions.canWrite && !editingByOther && SENDABLE_REVIEW_STATUSES.has(draft.status || '');
  const errorCode = draft.errorCode && Object.hasOwn(SEND_ERROR_MESSAGES, draft.errorCode)
    ? draft.errorCode as OutboxFailureCode
    : null;
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
    canSend: canDecide,
    canEdit: canDecide,
    canReject: canDecide,
    scope: isPersonalWorkspace(workspace) ? 'personal' : 'workspace',
    workspaceId: workspace.workspaceId,
    workspaceName: workspace.displayName || workspace.workspaceType,
    senderAddress: draft.senderAddress,
    mailboxId: draft.mailboxId,
    accountId: draft.accountId,
    attachments: draft.attachments.map((attachment, index) => ({
      id: `${draft.id}:${index}`,
      name: attachment.name || 'Attachment',
      mimeType: inferEmailAttachmentMimeType(attachment.name || '', attachment.mimeType),
      size: typeof attachment.size === 'number' && Number.isFinite(attachment.size) && attachment.size >= 0 ? attachment.size : 0,
    })),
    errorCode,
    // Transport errors can include provider credentials or implementation details.
    errorMessage: errorCode ? SEND_ERROR_MESSAGES[errorCode] : null,
    failedAt: draft.failedAt,
    updatedAt: draft.updatedAt,
  };
}

export async function getMobileEmailReview(input: {
  userId: string;
  workspace: WorkspaceContext;
  draftId: string;
}): Promise<MobileEmailReview> {
  if (!input.workspace.permissions.canRead) {
    throw new MobileEmailError('This email review is not accessible.', 'EMAIL_REVIEW_READ_ONLY', 403);
  }
  const draft = isPersonalWorkspace(input.workspace)
    ? await findPersonalOutboxDraft(input.userId, input.draftId)
    : await findWorkspaceOutboxDraft(input.userId, input.workspace.workspaceId, input.draftId);
  if (!draft) {
    throw new MobileEmailError('Email review was not found.', 'EMAIL_REVIEW_NOT_FOUND', 404);
  }
  return serializeReview(draft, input.userId, input.workspace);
}

export type MobileEmailReviewQueue = {
  data: MobileEmailReview[];
  pagination: { nextCursor: string | null; total: number; problemCount: number };
};

type ReviewQueueCursor = { fingerprint: string; updatedAt: string; key: string };

function reviewQueueKey(review: MobileEmailReview): string {
  return `${review.scope}:${review.scope === 'personal' ? '' : review.workspaceId}:${review.id}`;
}

function reviewQueueCursor(value: string | null | undefined, fingerprint: string): ReviewQueueCursor | null {
  if (!value) return null;
  try {
    if (value.length > 2_000 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('Invalid cursor');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as ReviewQueueCursor;
    if (parsed.fingerprint !== fingerprint || typeof parsed.key !== 'string' || !parsed.key || typeof parsed.updatedAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.updatedAt))) throw new Error('Invalid cursor');
    return parsed;
  } catch {
    throw new MobileEmailError('The email review cursor is invalid for this view.', 'INVALID_EMAIL_REVIEW_CURSOR', 400);
  }
}

export async function listMobileEmailReviews(input: {
  userId: string;
  workspaces: WorkspaceContext[];
  scope: 'selected' | 'current';
  filter?: string | null;
  limit?: number;
  cursor?: string | null;
}): Promise<MobileEmailReviewQueue> {
  const filter = input.filter || 'all';
  const limit = input.limit ?? 30;
  if (!['all', 'problems'].includes(filter) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new MobileEmailError('The email review filter or page size is invalid.', 'INVALID_EMAIL_REVIEW', 400);
  }
  const workspaces = [...new Map(input.workspaces.filter((workspace) => workspace.permissions.canRead
    && (workspace.status ?? 'active') === 'active').map((workspace) => [workspace.workspaceId, workspace])).values()];
  const fingerprint = createHash('sha256').update(JSON.stringify({ userId: input.userId, scope: input.scope, filter,
    workspaces: workspaces.map((workspace) => workspace.workspaceId).sort() })).digest('hex');
  const cursor = reviewQueueCursor(input.cursor, fingerprint);
  const personalWorkspace = workspaces.find(isPersonalWorkspace);
  const sources = workspaces.filter((workspace) => !isPersonalWorkspace(workspace));
  if (personalWorkspace) sources.push(personalWorkspace);
  const lists = await Promise.all(sources.map(async (workspace) => {
    const drafts = isPersonalWorkspace(workspace)
      ? await listPersonalOutboxDrafts(input.userId)
      : await listWorkspaceOutboxDrafts(input.userId, workspace.workspaceId);
    return drafts.filter((draft) => PENDING_REVIEW_STATUSES.has(draft.status || ''))
      .map((draft) => serializeReview(draft, input.userId, workspace));
  }));
  const pending = [...new Map(lists.flat().map((review) => [reviewQueueKey(review), review])).values()];
  const isProblem = (review: MobileEmailReview) => review.status === 'send_failed' || review.status === 'send_uncertain';
  const matching = pending.filter((review) => filter === 'all' || isProblem(review))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || reviewQueueKey(b).localeCompare(reviewQueueKey(a)));
  const remaining = matching.filter((review) => !cursor || review.updatedAt < cursor.updatedAt
    || (review.updatedAt === cursor.updatedAt && reviewQueueKey(review).localeCompare(cursor.key) < 0));
  const data = remaining.slice(0, limit);
  const last = data.at(-1);
  return {
    data,
    pagination: {
      nextCursor: remaining.length > limit && last ? Buffer.from(JSON.stringify({ fingerprint, updatedAt: last.updatedAt, key: reviewQueueKey(last) })).toString('base64url') : null,
      total: matching.length,
      problemCount: pending.filter(isProblem).length,
    },
  };
}

async function requireMutableReview(input: { userId: string; workspace: WorkspaceContext; draftId: string; expectedVersion: number }, action: 'edit' | 'reject' | 'send') {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new MobileEmailError('A current email review version is required.', 'INVALID_EMAIL_REVIEW', 400);
  }
  if (!input.workspace.permissions.canWrite) {
    throw new MobileEmailError('This email review is read-only.', 'EMAIL_REVIEW_READ_ONLY', 403);
  }
  const current = await getMobileEmailReview(input);
  if (current.version !== input.expectedVersion) {
    throw new MobileEmailError('This email review has changed. Reload it before continuing.', 'EMAIL_REVIEW_VERSION_CONFLICT', 409);
  }
  if (!current.canSend) {
    const code = action === 'edit' ? 'EMAIL_REVIEW_NOT_EDITABLE' : action === 'reject' ? 'EMAIL_REVIEW_NOT_REJECTABLE' : 'EMAIL_REVIEW_NOT_SENDABLE';
    throw new MobileEmailError(`This email review cannot be ${action === 'edit' ? 'edited' : action === 'reject' ? 'rejected' : 'sent'}.`, code, 409, current);
  }
  return current;
}

function rethrowReviewMutationError(error: unknown): never {
  if (error instanceof Error && /has changed|reload it before/iu.test(error.message)) {
    throw new MobileEmailError('This email review has changed. Reload it before continuing.', 'EMAIL_REVIEW_VERSION_CONFLICT', 409);
  }
  if (error instanceof Error && /can no longer be edited|cannot be changed or sent/iu.test(error.message)) {
    throw new MobileEmailError('This email review can no longer be changed.', 'EMAIL_REVIEW_NOT_EDITABLE', 409);
  }
  throw error;
}

function validateReviewRecipients(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 250 || value.some((item) => typeof item !== 'string' || item.length > 320)) {
    throw new MobileEmailError('The email review recipients are invalid.', 'INVALID_EMAIL_REVIEW', 400);
  }
  return value.map((value: string) => {
    const trimmed = value.trim();
    const address = (trimmed.match(/^[^<>]*<([^<>]+)>$/u)?.[1] || trimmed).trim().toLowerCase();
    if (/[\r\n,;]/u.test(trimmed) || !/^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/u.test(address)) {
      throw new MobileEmailError('Use one valid email address per recipient.', 'INVALID_EMAIL_REVIEW', 400);
    }
    return address;
  });
}

export async function updateMobileEmailReview(input: {
  userId: string; workspace: WorkspaceContext; draftId: string; expectedVersion: number; changes: Record<string, unknown>;
}): Promise<MobileEmailReview> {
  const current = await requireMutableReview(input, 'edit');
  const changes = input.changes;
  if (!Object.keys(changes).some((key) => ['to', 'cc', 'bcc', 'subject', 'body'].includes(key))
    || Object.keys(changes).some((key) => !['to', 'cc', 'bcc', 'subject', 'body', 'expectedVersion'].includes(key))
    || ('subject' in changes && (typeof changes.subject !== 'string' || changes.subject.length > 1_000 || /[\r\n]/u.test(changes.subject)))
    || ('body' in changes && (typeof changes.body !== 'string' || changes.body.length > 2_000_000))) {
    throw new MobileEmailError('The email review changes are invalid.', 'INVALID_EMAIL_REVIEW', 400);
  }
  const patch = {
    userId: input.userId, draftId: input.draftId, expectedVersion: input.expectedVersion,
    subject: typeof changes.subject === 'string' ? changes.subject : current.subject,
    ...(typeof changes.body === 'string' ? { body: changes.body } : {}),
    to: 'to' in changes ? validateReviewRecipients(changes.to) : current.to,
    cc: 'cc' in changes ? validateReviewRecipients(changes.cc) : current.cc,
    bcc: 'bcc' in changes ? validateReviewRecipients(changes.bcc) : current.bcc,
  };
  try {
    if (isPersonalWorkspace(input.workspace)) await updatePersonalOutboxDraft(patch);
    else await updateWorkspaceOutboxDraft({ ...patch, workspaceId: input.workspace.workspaceId });
    return await getMobileEmailReview(input);
  } catch (error) {
    rethrowReviewMutationError(error);
  }
}

export async function rejectMobileEmailReview(input: {
  userId: string; workspace: WorkspaceContext; draftId: string; expectedVersion: number;
}): Promise<MobileEmailReview> {
  await requireMutableReview(input, 'reject');
  try {
    if (isPersonalWorkspace(input.workspace)) await rejectPersonalOutboxDraft(input);
    else await rejectWorkspaceOutboxDraft({ ...input, workspaceId: input.workspace.workspaceId });
    return await getMobileEmailReview(input);
  } catch (error) {
    rethrowReviewMutationError(error);
  }
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
}, dependencies: MobileEmailSendDependencies = {}): Promise<MobileEmailReview> {
  await requireMutableReview(input, 'send');
  try {
    const sent = isPersonalWorkspace(input.workspace)
      ? await sendPersonalOutboxDraft({
        userId: input.userId,
        draftId: input.draftId,
        expectedVersion: input.expectedVersion,
      }, dependencies)
      : await sendWorkspaceOutboxDraft({
        userId: input.userId,
        workspaceId: input.workspace.workspaceId,
        draftId: input.draftId,
        expectedVersion: input.expectedVersion,
      }, dependencies);
    return serializeReview(sent, input.userId, input.workspace);
  } catch (error) {
    if (error instanceof OutboxSendError) {
      throw new MobileEmailError(SEND_ERROR_MESSAGES[error.code], error.code, error.status,
        error.draft ? serializeReview(error.draft, input.userId, input.workspace) : undefined);
    }
    rethrowReviewMutationError(error);
  }
}

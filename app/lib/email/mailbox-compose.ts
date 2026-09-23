import 'server-only';

import { and, eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { emailDrafts, emailAccounts } from '@/app/lib/db/schema';
import { createEmailDraft, updateEmailDraft, sendEmailDraft, sendEmailMessage, readEmailMessage, createEmailDerivedDraft, sendEmailDerivedMessage } from '@/app/lib/email/service';
import { buildEmailDerivedDraft, type EmailDerivedDraftMode, type EmailDerivedDraftOverrides } from '@/app/lib/email/message-draft-builder';
import { EmailMailboxAccessError, resolveEmailMailboxAccess } from '@/app/lib/email/mailbox-access';
import { createWorkspaceOutboxDraft, findWorkspaceOutboxDraft, updateWorkspaceOutboxDraft, sendWorkspaceOutboxDraft } from '@/app/lib/email/workspace-inbox-outbox';
import { snapshotBrowserEmailAttachments, BrowserEmailAttachmentError } from '@/app/lib/email/attachments';
import type { LocalEmailDraftInput } from '@/app/lib/email/draft-store';

type ComposeInput = LocalEmailDraftInput & { mailboxWorkspaceId?: unknown; attachmentWorkspaceId?: unknown; expectedVersion?: number };
type MailboxAccess = Awaited<ReturnType<typeof resolveEmailMailboxAccess>>;

async function outboxInput(userId: string, mailboxWorkspaceId: string, input: ComposeInput) {
  if (input.is_HTML && /<img\b|cid:/iu.test(input.body)) throw new BrowserEmailAttachmentError('Inline images are not supported in shared mailboxes. Add images as file attachments.');
  const attachments = input.attachments === undefined ? undefined : await snapshotBrowserEmailAttachments(input.attachments, { userId, mailboxWorkspaceId, attachmentWorkspaceId: input.attachmentWorkspaceId });
  return { subject: input.subject, body: input.body, bodyHtml: input.is_HTML ? input.body : undefined, to: input.to, cc: input.cc, bcc: input.bcc, attachments };
}

async function assertPersonalDraft(userId: string, accountId: string, draftId: string) {
  const draft = await db.query.emailDrafts.findFirst({ where: eq(emailDrafts.id, draftId) });
  if (draft && (draft.userId !== userId || draft.accountId !== accountId || draft.workspaceId)) throw new EmailMailboxAccessError('This draft belongs to another mailbox context.');
}

export async function createBrowserEmailDraft(userId: string, input: ComposeInput, trustedAccess?: MailboxAccess) {
  const access = trustedAccess || await resolveEmailMailboxAccess({ userId, accountId: input.accountId, mailboxWorkspaceId: input.mailboxWorkspaceId, operation: 'write' });
  if (!access.workspaceId) return createEmailDraft(userId, { ...input, accountId: access.accountId }, { deliveryOrigin: 'human' });
  const draft = await createWorkspaceOutboxDraft({ userId, workspaceId: access.workspaceId, mailboxId: access.mailboxId!, ...await outboxInput(userId, access.workspaceId, input), initialStatus: 'prepared', assignedUserId: userId, origin: 'human' });
  return { draft: { ...draft, is_HTML: draft.isHtml }, account: { id: access.accountId } };
}

export async function updateBrowserEmailDraft(userId: string, draftId: string, input: ComposeInput) {
  const access = await resolveEmailMailboxAccess({ userId, accountId: input.accountId, mailboxWorkspaceId: input.mailboxWorkspaceId, operation: 'write' });
  if (!access.workspaceId) {
    await assertPersonalDraft(userId, access.accountId, draftId);
    return updateEmailDraft(userId, draftId, { ...input, accountId: access.accountId }, { deliveryOrigin: 'human' });
  }
  const current = await findWorkspaceOutboxDraft(userId, access.workspaceId, draftId);
  if (!current || current.accountId !== access.accountId || current.mailboxId !== access.mailboxId) throw new EmailMailboxAccessError('This draft belongs to another mailbox context.');
  if (!Number.isInteger(input.expectedVersion)) throw new EmailMailboxAccessError('Reload this draft before editing it.', 409);
  const draft = await updateWorkspaceOutboxDraft({ userId, workspaceId: access.workspaceId, draftId, expectedVersion: input.expectedVersion!, ...await outboxInput(userId, access.workspaceId, input) });
  return { draft: { ...draft, is_HTML: draft.isHtml }, account: { id: access.accountId } };
}

export async function sendBrowserEmailDraft(userId: string, draftId: string, input: { accountId: string; mailboxWorkspaceId?: unknown; expectedVersion?: number }) {
  const access = await resolveEmailMailboxAccess({ userId, accountId: input.accountId, mailboxWorkspaceId: input.mailboxWorkspaceId, operation: 'write' });
  if (!access.workspaceId) {
    await assertPersonalDraft(userId, access.accountId, draftId);
    return sendEmailDraft(userId, access.accountId, draftId, { deliveryOrigin: 'human' });
  }
  const current = await findWorkspaceOutboxDraft(userId, access.workspaceId, draftId);
  if (!current || current.accountId !== access.accountId || current.mailboxId !== access.mailboxId) throw new EmailMailboxAccessError('This draft belongs to another mailbox context.');
  if (!Number.isInteger(input.expectedVersion)) throw new EmailMailboxAccessError('Reload this draft before sending it.', 409);
  return sendWorkspaceOutboxDraft({ userId, workspaceId: access.workspaceId, draftId, expectedVersion: input.expectedVersion! });
}

/** Store shared mail before attempting transport; policy/provider failures stay in Outbox. */
export async function sendBrowserEmailMessage(userId: string, input: ComposeInput) {
  const access = await resolveEmailMailboxAccess({ userId, accountId: input.accountId, mailboxWorkspaceId: input.mailboxWorkspaceId, operation: 'write' });
  if (!access.workspaceId) return sendEmailMessage(userId, { ...input, accountId: access.accountId }, { deliveryOrigin: 'human' });
  const draft = await createWorkspaceOutboxDraft({ userId, workspaceId: access.workspaceId, mailboxId: access.mailboxId!, ...await outboxInput(userId, access.workspaceId, input), initialStatus: 'prepared', assignedUserId: userId, origin: 'human' });
  return sendWorkspaceOutboxDraft({ userId, workspaceId: access.workspaceId, draftId: draft.id, expectedVersion: draft.version });
}

export async function createBrowserEmailDerivedDraft(userId: string, input: { accountId: string; mailboxWorkspaceId?: unknown; attachmentWorkspaceId?: unknown; messageId: string; folder?: string; mode: EmailDerivedDraftMode; overrides?: EmailDerivedDraftOverrides }, send = false) {
  const access = await resolveEmailMailboxAccess({ userId, accountId: input.accountId, mailboxWorkspaceId: input.mailboxWorkspaceId, operation: 'write' });
  if (!access.workspaceId) {
    const operation = send ? sendEmailDerivedMessage : createEmailDerivedDraft;
    return operation(userId, access.accountId, input.messageId, input.folder, input.mode, input.overrides, { ...access.readOptions, deliveryOrigin: 'human' });
  }
  const result = await readEmailMessage(access.accountOwnerId, access.accountId, input.messageId, input.folder, access.readOptions);
  const account = await db.query.emailAccounts.findFirst({ where: and(eq(emailAccounts.id, access.accountId), eq(emailAccounts.userId, access.accountOwnerId)) });
  const draft = buildEmailDerivedDraft({ accountId: access.accountId, message: result.message as Record<string, unknown>, mode: input.mode, ownAddresses: new Set(account ? [account.emailAddress] : []), ...input.overrides });
  const compose = { ...draft, attachmentWorkspaceId: input.attachmentWorkspaceId, accountId: access.accountId, mailboxWorkspaceId: access.workspaceId };
  return send ? sendBrowserEmailMessage(userId, compose) : createBrowserEmailDraft(userId, compose, access);
}

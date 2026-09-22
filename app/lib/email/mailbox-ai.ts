import 'server-only';

import { createEmailAiReplyDraft, generateEmailAiReplyBody } from '@/app/lib/email/service';
import { createBrowserEmailDerivedDraft } from '@/app/lib/email/mailbox-compose';
import type { resolveEmailMailboxAccess } from '@/app/lib/email/mailbox-access';
import { plainTextToEmailHtml } from '@/app/lib/email/html-conversion';

/** AI runs as the member; a shared generated draft belongs to its durable workspace Outbox. */
export async function createMailboxAiReplyDraft(input: {
  userId: string;
  access: Awaited<ReturnType<typeof resolveEmailMailboxAccess>>;
  messageId: string;
  folder?: string;
  instruction?: string;
  workspaceId?: string;
}) {
  const { access, userId, messageId, folder, instruction } = input;
  const options = { ...access.readOptions, actorUserId: userId, workspaceId: access.workspaceId || input.workspaceId };
  if (!access.workspaceId) return createEmailAiReplyDraft(userId, access.accountId, messageId, folder, instruction, options);
  const result = await generateEmailAiReplyBody(access.accountOwnerId, access.accountId, messageId, folder, instruction, options);
  return createBrowserEmailDerivedDraft(userId, {
    accountId: access.accountId, mailboxWorkspaceId: access.workspaceId, messageId, folder, mode: 'reply',
    overrides: { bodyOverride: result.body, bodyOverrideHtml: plainTextToEmailHtml(result.body), is_HTML: true },
  });
}

import { createHash } from 'node:crypto';
import { resolveProviderMessageIdentity, type ProviderMessageIdentityInput } from '@/app/lib/email/provider-message-identity';
import type { AuthorizedEmailClassificationMailbox, EmailMessageOrigin } from './mailbox-types';
import type { EmailClassificationMailboxInput } from './store-types';
import type { EmailReplyStatus } from './types';

export function emailClassificationFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function emailClassificationMailboxRef(mailbox: Pick<EmailClassificationMailboxInput, 'ownerUserId' | 'accountSource' | 'accountId' | 'workspaceId' | 'mailboxId'>): string {
  return `emb:${emailClassificationFingerprint([mailbox.ownerUserId, mailbox.accountSource, mailbox.accountId, mailbox.workspaceId, mailbox.mailboxId])}`;
}

export function emailClassificationMessageIdentity(mailbox: Pick<EmailClassificationMailboxInput, 'mailboxRef' | 'provider'>, message: ProviderMessageIdentityInput) {
  const identity = resolveProviderMessageIdentity(message);
  if ((mailbox.provider === 'imap' || mailbox.provider === 'smtp_imap') && !identity.isImap) throw new Error('A durable IMAP reference including UIDVALIDITY is required.');
  return { ...identity, messageRef: `emm:${emailClassificationFingerprint([mailbox.mailboxRef, identity.canonicalId, identity.isImap ? identity.folder : null])}` };
}

export function emailClassificationMessageOrigin(mailbox: AuthorizedEmailClassificationMailbox, identity: ReturnType<typeof emailClassificationMessageIdentity>): EmailMessageOrigin {
  return {
    mailboxRef: mailbox.mailboxRef, accountSource: mailbox.accountSource, accountId: mailbox.accountId,
    accountScope: mailbox.workspaceId ? 'workspace' : 'personal', accountOwnerId: mailbox.ownerUserId,
    mailboxId: mailbox.mailboxId, workspaceId: mailbox.workspaceId, workspaceName: mailbox.workspaceName,
    emailAddress: mailbox.emailAddress, displayName: mailbox.displayName,
    folder: identity.folder, canonicalId: identity.canonicalId, capabilities: { ...mailbox.capabilities },
  };
}

/** An absent flag (including legacy mapper defaults) never proves an unanswered message. */
export function emailClassificationReplyStatus(message: Record<string, unknown>, provenance: 'provider' | 'cache' | 'imap' = 'provider'): EmailReplyStatus {
  if (message.replyStatus === 'answered' || message.replyStatus === 'unanswered' || message.replyStatus === 'unknown') return message.replyStatus;
  if (message.isAnswered === true) return 'answered';
  if (message.isAnswered === false && (provenance === 'imap' || message.answerStatusAvailable === true)) return 'unanswered';
  return 'unknown';
}

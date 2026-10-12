import 'server-only';

import { emailClassificationFingerprint, emailClassificationMessageIdentity } from './classification/identity';
import type { AuthorizedEmailClassificationMailbox } from './classification/mailbox-types';
import type { EmailDerivedDraftMode } from './message-draft-builder';
import type { StoredEmailAccount } from './account-store';
import type { EmailAccountSmtpSecret } from './secret-store';

export interface AcceptedEmailReplyInput {
  actorUserId: string; ownerUserId: string; accountId: string; workspaceId?: string | null;
  accountSource: 'local' | 'managed'; messageId: string; folder?: string; mode: EmailDerivedDraftMode;
}
export interface CapturedEmailReply {
  input: AcceptedEmailReplyInput;
  source: AuthorizedEmailClassificationMailbox & { connectionRevision: string };
  messageRef: string;
  canonicalId: string;
  folder: string;
  /** Never expose this server-only, process-local credential snapshot in a response or log. */
  imap?: { account: StoredEmailAccount; secret: EmailAccountSmtpSecret };
}
export interface AcceptedEmailReplyDependencies {
  resolveSource?(input: AcceptedEmailReplyInput): Promise<AuthorizedEmailClassificationMailbox | null>;
  captureImap?(source: AuthorizedEmailClassificationMailbox): Promise<CapturedEmailReply['imap']>;
  markImap?(reply: CapturedEmailReply): Promise<void>;
  confirm?(reply: CapturedEmailReply): Promise<boolean>;
}

async function resolveSource(input: AcceptedEmailReplyInput) {
  const { resolveAuthorizedEmailClassificationMailboxes } = await import('./classification/mailbox-registry');
  const sources = await resolveAuthorizedEmailClassificationMailboxes(input.actorUserId, { kind: input.workspaceId ? 'work' : 'personal' });
  return sources.find(source => source.accountId === input.accountId && source.ownerUserId === input.ownerUserId
    && source.accountSource === input.accountSource && source.workspaceId === (input.workspaceId ?? null)) ?? null;
}
async function captureImap(source: AuthorizedEmailClassificationMailbox): Promise<CapturedEmailReply['imap']> {
  const { getEmailAccountForUser, readStoredEmailAccountSecret } = await import('./account-store');
  const account = await getEmailAccountForUser(source.ownerUserId, source.accountId);
  const secret = await readStoredEmailAccountSecret(account);
  if (account.authType !== 'smtp_imap' || secret.authType !== 'smtp_imap' || !secret.imap) return undefined;
  // Match the registry's exact identity inputs before freezing credentials: a
  // separate secret read may otherwise observe an intervening account rebind.
  const connectionRevision = emailClassificationFingerprint([source.ownerUserId, 'local', account.id, source.workspaceId, source.mailboxId,
    account.provider, account.authType, account.createdAt?.getTime() ?? null, account.providerAccountId,
    account.providerAccountId ? null : account.emailAddress, secret.imap.host, secret.imap.port, secret.imap.username, secret.imap.secure]);
  if (account.id !== source.accountId || account.userId !== source.ownerUserId || connectionRevision !== source.connectionRevision) return undefined;
  return structuredClone({ account, secret });
}
function sameCurrentSource(captured: AuthorizedEmailClassificationMailbox, current: AuthorizedEmailClassificationMailbox | null) {
  return Boolean(current && current.active && current.capabilities.canRead && current.capabilities.canWrite
    && current.mailboxRef === captured.mailboxRef && current.connectionRevision === captured.connectionRevision
    && current.bindingRevision === captured.bindingRevision && current.policyRevision === captured.policyRevision);
}

/** Optional bookkeeping preparation must never block a human's independently authorized send. */
export async function captureAcceptedEmailReply(input: AcceptedEmailReplyInput, deps: AcceptedEmailReplyDependencies = {}): Promise<CapturedEmailReply | null> {
  if (input.mode !== 'reply' && input.mode !== 'reply-all') return null;
  try {
    const source = await (deps.resolveSource ?? resolveSource)(input);
    if (!source || !source.connectionRevision || !sameCurrentSource(source, source)) return null;
    const identity = emailClassificationMessageIdentity(source, { id: input.messageId, folder: input.folder });
    const reply: CapturedEmailReply = { input: { ...input }, source: { ...structuredClone(source), connectionRevision: source.connectionRevision }, messageRef: identity.messageRef,
      canonicalId: identity.canonicalId, folder: identity.folder };
    if (source.accountSource === 'local' && (source.provider === 'imap' || source.provider === 'smtp_imap')) {
      try { reply.imap = await (deps.captureImap ?? captureImap)(source); } catch { /* Local accepted-send evidence remains valid without a provider flag. */ }
    }
    return reply;
  } catch { return null; }
}

/** Transport acceptance is final. All secondary failures are swallowed to prevent resend. */
export async function recordAcceptedEmailReply(reply: CapturedEmailReply | null, accepted: boolean, deps: AcceptedEmailReplyDependencies = {}): Promise<void> {
  if (!reply || !accepted) return;
  try {
    const currentSource = () => (deps.resolveSource ?? resolveSource)(reply.input);
    if (!sameCurrentSource(reply.source, await currentSource())) return;
    if (reply.imap) {
      try {
        if (deps.markImap) await deps.markImap(reply);
        else {
          const { setImapEmailMessageAnswered } = await import('./imap-service');
          const { invalidateEmailMailboxCache } = await import('./cache/consistency');
          await setImapEmailMessageAnswered(reply.imap.account, reply.canonicalId, reply.folder, true, reply.imap.secret);
          await invalidateEmailMailboxCache({ userId: reply.source.ownerUserId, accountId: reply.source.accountId, accountSource: 'local' });
        }
      } catch { /* A confirmed reply is still valid evidence when the IMAP flag cannot be saved. */ }
    }
    if (!sameCurrentSource(reply.source, await currentSource())) return;
    if (deps.confirm) await deps.confirm(reply);
    else {
      const { getRuntimeEmailClassificationStore } = await import('./classification/store');
      await (await getRuntimeEmailClassificationStore()).confirmAcceptedReply({ mailboxRef: reply.source.mailboxRef, messageRef: reply.messageRef,
        connectionRevision: reply.source.connectionRevision, bindingRevision: reply.source.bindingRevision, policyRevision: reply.source.policyRevision });
    }
  } catch { /* Never turn accepted SMTP/provider delivery into a retryable response. */ }
}

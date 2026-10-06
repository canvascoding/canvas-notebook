import 'server-only';

import { resolveProviderMessageIdentity } from '@/app/lib/email/provider-message-identity';
import { getRuntimeEmailClassificationStore, type PostgresEmailClassificationStore } from './store';

type LifecycleDependencies = { store?: Pick<PostgresEmailClassificationStore, 'invalidateAccount' | 'updateIndexedMessageState'> };

/** Mail operations have already succeeded. A classification outage must not replay them. */
export async function notifyEmailClassificationAccountChanged(input: {
  ownerUserId: string; accountId: string; accountSource: 'local' | 'managed';
}, dependencies: LifecycleDependencies = {}): Promise<boolean> {
  try { await (dependencies.store ?? await getRuntimeEmailClassificationStore()).invalidateAccount(input); return true; }
  catch { return false; }
}

/** Qualified provider identities keep identical UIDs in other folders/mailboxes untouched. */
export async function notifyEmailClassificationMessageChanged(input: {
  ownerUserId: string; accountId: string; accountSource: 'local' | 'managed'; messageId: string; folder?: string;
  read?: boolean; answered?: boolean; leaveInbox?: boolean; remove?: boolean;
}, dependencies: LifecycleDependencies = {}): Promise<boolean> {
  try {
    const identity = resolveProviderMessageIdentity({ id: input.messageId, folder: input.folder });
    await (dependencies.store ?? await getRuntimeEmailClassificationStore()).updateIndexedMessageState({
      ownerUserId: input.ownerUserId, accountId: input.accountId, accountSource: input.accountSource, canonicalId: identity.canonicalId,
      read: input.read, answered: input.answered, leaveInbox: input.leaveInbox, remove: input.remove,
    });
    return true;
  } catch { return false; }
}

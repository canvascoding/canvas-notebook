import 'server-only';

import { logEmailClientEvent } from '@/app/lib/email/logging';
import {
  getRuntimeEmailCacheStore,
  type EmailCacheAccountSource,
  type EmailMessageRefInput,
  type EmailCacheStore,
} from './store';

type EmailCacheMailbox = {
  userId: string;
  accountId: string;
  accountSource: EmailCacheAccountSource;
};

type EmailCacheStoreFactory = () => Promise<EmailCacheStore>;

let emailCacheStoreFactory: EmailCacheStoreFactory = getRuntimeEmailCacheStore;

function isImapMailboxChangedFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; status?: unknown };
  return candidate.code === 'EMAIL_MAILBOX_CHANGED' && candidate.status === 409;
}

export function setEmailCacheConsistencyStoreFactoryForTests(factory: EmailCacheStoreFactory | null): void {
  emailCacheStoreFactory = factory || getRuntimeEmailCacheStore;
}

async function bestEffortEmailCacheOperation(
  mailbox: EmailCacheMailbox,
  operation: 'bump-generation' | 'purge-account' | 'reactivate-account',
  execute: (store: EmailCacheStore) => Promise<unknown>,
): Promise<void> {
  try {
    const store = await emailCacheStoreFactory();
    await execute(store);
  } catch (error) {
    logEmailClientEvent('warn', 'email_cache_consistency_failed', {
      accountId: mailbox.accountId,
      error,
      operation,
      status: 'failed',
      userId: mailbox.userId,
    });
  }
}

export async function invalidateEmailMailboxCache(mailbox: EmailCacheMailbox): Promise<void> {
  await bestEffortEmailCacheOperation(mailbox, 'bump-generation', (store) => store.bumpMailboxGeneration(mailbox));
}

export async function purgeEmailMailboxCache(mailbox: EmailCacheMailbox): Promise<void> {
  await bestEffortEmailCacheOperation(mailbox, 'purge-account', (store) => store.purgeAccount(mailbox));
}

/**
 * Only call after a completed connect/upsert flow. In particular, a managed
 * account listing is not a reconnect signal because it may be stale after a
 * successful Control Plane disconnect.
 */
export async function reactivateEmailMailboxCache(mailbox: EmailCacheMailbox): Promise<void> {
  await bestEffortEmailCacheOperation(mailbox, 'reactivate-account', (store) => store.reactivateAccount(mailbox));
}

export async function runLocalEmailMailboxMutation<T>(
  mailbox: Omit<EmailCacheMailbox, 'accountSource'>,
  mutateProvider: () => Promise<T>,
): Promise<T> {
  const localMailbox = { ...mailbox, accountSource: 'local' as const };
  try {
    const result = await mutateProvider();
    await invalidateEmailMailboxCache(localMailbox);
    return result;
  } catch (error) {
    if (isImapMailboxChangedFailure(error)) {
      await invalidateEmailMailboxCache(localMailbox);
    }
    throw error;
  }
}

export async function runLocalEmailMessageReadMutation<T>(
  mailbox: Omit<EmailCacheMailbox, 'accountSource'> & {
    read: boolean;
    ref: EmailMessageRefInput | null;
  },
  mutateProvider: () => Promise<T>,
): Promise<T> {
  const localMailbox = {
    userId: mailbox.userId,
    accountId: mailbox.accountId,
    accountSource: 'local' as const,
  };
  let result: T;
  try {
    result = await mutateProvider();
  } catch (error) {
    if (isImapMailboxChangedFailure(error)) {
      await invalidateEmailMailboxCache(localMailbox);
    }
    throw error;
  }

  if (!mailbox.ref) {
    await invalidateEmailMailboxCache(localMailbox);
    return result;
  }

  try {
    const store = await emailCacheStoreFactory();
    const cached = await store.getMessage({
      ...localMailbox,
      ref: mailbox.ref,
      part: 'metadata',
    });
    if (!cached.value?.metadata || cached.generation === null) return result;

    await store.putMessage({
      ...localMailbox,
      ref: mailbox.ref,
      metadata: {
        ...cached.value.metadata,
        isRead: mailbox.read,
      },
      expectedGeneration: cached.generation,
    });
  } catch (error) {
    logEmailClientEvent('warn', 'email_cache_consistency_failed', {
      accountId: mailbox.accountId,
      error,
      operation: 'patch-read-state',
      status: 'failed',
      userId: mailbox.userId,
    });
    await invalidateEmailMailboxCache(localMailbox);
  }

  return result;
}

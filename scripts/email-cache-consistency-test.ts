import assert from 'node:assert/strict';

import {
  invalidateEmailMailboxCache,
  purgeEmailMailboxCache,
  reactivateEmailMailboxCache,
  runLocalEmailMailboxMutation,
  setEmailCacheConsistencyStoreFactoryForTests,
} from '../app/lib/email/cache/consistency';
import type { EmailCacheStore } from '../app/lib/email/cache/store';

type CacheCall = {
  operation: 'bump' | 'purge' | 'reactivate';
  userId: string;
  accountId: string;
  accountSource?: 'local' | 'managed';
};

type CacheMailboxInput = {
  userId: string;
  accountId: string;
  accountSource?: 'local' | 'managed';
  now?: number;
};

function cacheStore(calls: CacheCall[], options?: { failBump?: boolean }): EmailCacheStore {
  return {
    enabled: true,
    async bumpMailboxGeneration(input: CacheMailboxInput) {
      calls.push({ operation: 'bump', ...input });
      if (options?.failBump) throw new Error('cache unavailable');
      return 2;
    },
    async purgeAccount(input: CacheMailboxInput) {
      calls.push({ operation: 'purge', ...input });
      return { enabled: true, tombstoned: true, generation: 2, deletedLists: 1, deletedMessages: 1 };
    },
    async reactivateAccount(input: CacheMailboxInput) {
      calls.push({ operation: 'reactivate', ...input });
      return 3;
    },
  } as unknown as EmailCacheStore;
}

async function main() {
  const calls: CacheCall[] = [];
  const providerOrder: string[] = [];
  setEmailCacheConsistencyStoreFactoryForTests(async () => cacheStore(calls));

  const result = await runLocalEmailMailboxMutation(
    { userId: 'user-1', accountId: 'local-1' },
    async () => {
      providerOrder.push('provider');
      assert.equal(calls.length, 0);
      return { ok: true };
    },
  );
  providerOrder.push('returned');
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(providerOrder, ['provider', 'returned']);
  assert.deepEqual(calls, [{ operation: 'bump', userId: 'user-1', accountId: 'local-1', accountSource: 'local' }]);

  calls.length = 0;
  const providerError = new Error('provider failed');
  await assert.rejects(
    runLocalEmailMailboxMutation(
      { userId: 'user-1', accountId: 'local-1' },
      async () => { throw providerError; },
    ),
    (error) => error === providerError,
  );
  assert.deepEqual(calls, []);

  calls.length = 0;
  const mailboxChanged = Object.assign(new Error('The IMAP mailbox changed.'), {
    code: 'EMAIL_MAILBOX_CHANGED',
    status: 409,
  });
  await assert.rejects(
    runLocalEmailMailboxMutation(
      { userId: 'user-1', accountId: 'imap-1' },
      async () => { throw mailboxChanged; },
    ),
    (error) => error === mailboxChanged,
  );
  assert.deepEqual(calls, [{ operation: 'bump', userId: 'user-1', accountId: 'imap-1', accountSource: 'local' }]);

  calls.length = 0;
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    setEmailCacheConsistencyStoreFactoryForTests(async () => cacheStore(calls, { failBump: true }));
    const successDespiteCacheFailure = await runLocalEmailMailboxMutation(
      { userId: 'user-1', accountId: 'local-1' },
      async () => 'provider-success',
    );
    assert.equal(successDespiteCacheFailure, 'provider-success');
    await assert.rejects(
      runLocalEmailMailboxMutation(
        { userId: 'user-1', accountId: 'imap-1' },
        async () => { throw mailboxChanged; },
      ),
      (error) => error === mailboxChanged,
    );
  } finally {
    console.warn = originalWarn;
  }

  const failingLifecycleStore = {
    enabled: true,
    async purgeAccount() { throw new Error('purge unavailable'); },
    async reactivateAccount() { throw new Error('reactivation unavailable'); },
  } as unknown as EmailCacheStore;
  console.warn = () => undefined;
  try {
    setEmailCacheConsistencyStoreFactoryForTests(async () => failingLifecycleStore);
    await purgeEmailMailboxCache({ userId: 'user-1', accountId: 'local-1', accountSource: 'local' });
    await reactivateEmailMailboxCache({ userId: 'user-1', accountId: 'local-1', accountSource: 'local' });
  } finally {
    console.warn = originalWarn;
  }

  calls.length = 0;
  setEmailCacheConsistencyStoreFactoryForTests(async () => cacheStore(calls));
  await invalidateEmailMailboxCache({ userId: 'user-1', accountId: 'local-1', accountSource: 'local' });
  await purgeEmailMailboxCache({ userId: 'user-1', accountId: 'shared-id', accountSource: 'managed' });
  await reactivateEmailMailboxCache({ userId: 'user-1', accountId: 'shared-id', accountSource: 'local' });
  assert.deepEqual(calls, [
    { operation: 'bump', userId: 'user-1', accountId: 'local-1', accountSource: 'local' },
    { operation: 'purge', userId: 'user-1', accountId: 'shared-id', accountSource: 'managed' },
    { operation: 'reactivate', userId: 'user-1', accountId: 'shared-id', accountSource: 'local' },
  ]);

  setEmailCacheConsistencyStoreFactoryForTests(null);
  console.log('email-cache-consistency-test: ok');
}

main().catch((error) => {
  setEmailCacheConsistencyStoreFactoryForTests(null);
  console.error(error);
  process.exitCode = 1;
});

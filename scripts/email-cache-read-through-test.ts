import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  readThroughEmailDetail,
  readThroughEmailList,
} from '../app/lib/email/cache/read-through';
import {
  normalizeEmailMessageRef,
  type EmailCachedMessageDetail,
  type EmailCachedMessageMetadata,
  type EmailCacheReadResult,
  type EmailCacheStore,
  type EmailMessageRefInput,
} from '../app/lib/email/cache/store';
import { createImapMessageReference } from '../app/lib/email/imap-service';

const googleRef: EmailMessageRefInput = { provider: 'google', messageId: 'g-1', folder: 'INBOX' };
const normalizedGoogleRef = normalizeEmailMessageRef(googleRef);

function metadata(subject = 'Cached subject'): EmailCachedMessageMetadata {
  return {
    from: 'sender@example.test',
    subject,
    date: '2026-09-08T10:00:00.000Z',
    dateTimestamp: Date.parse('2026-09-08T10:00:00.000Z'),
    snippet: 'Cached snippet',
    isRead: false,
    isAnswered: false,
    isFlagged: false,
    hasAttachments: false,
    size: null,
    to: ['owner@example.test'],
    cc: [],
    threadId: 'thread-1',
    flags: [],
  };
}

function detail(): EmailCachedMessageDetail {
  return {
    body: 'Cached body',
    bodyHtml: '<p>Cached body</p>',
    to: ['owner@example.test'],
    cc: [],
    messageId: '<g-1@example.test>',
    inReplyTo: '',
    references: [],
    attachments: [{ index: 0, filename: 'brief.pdf', contentType: 'application/pdf', size: 123 }],
  };
}

function readResult<T>(value: T | null, state: 'fresh' | 'stale' | 'miss' = value ? 'fresh' : 'miss'): EmailCacheReadResult<T> {
  return {
    enabled: true,
    state,
    generation: value ? 1 : null,
    fetchedAt: value ? 100 : null,
    staleAt: value ? 200 : null,
    expiresAt: value ? 10_000 : null,
    value,
  };
}

type FakeOverrides = Partial<EmailCacheStore>;

function fakeStore(overrides: FakeOverrides = {}): EmailCacheStore {
  const store: EmailCacheStore = {
    enabled: true,
    async getMailboxGeneration() { return 1; },
    async bumpMailboxGeneration() { return 2; },
    async reactivateAccount() { return 1; },
    async getList() { return readResult(null); },
    async acquireListRefreshLease() { return { enabled: true, acquired: true, generation: 1, leaseUntil: 15_000 }; },
    async putList() { return { enabled: true, stored: true, reason: 'stored' }; },
    async releaseListRefreshLease() { return true; },
    async getMessage() { return readResult(null); },
    async getMessages() { return []; },
    async acquireMessageRefreshLease() { return { enabled: true, acquired: true, generation: 1, leaseUntil: 20_000 }; },
    async putMessage() { return { enabled: true, stored: true, reason: 'stored' }; },
    async putMessages(input) {
      const keys = input.messages.map((message) => normalizeEmailMessageRef(message.ref).messageKey);
      return {
        enabled: true,
        requestedCount: keys.length,
        storedCount: keys.length,
        storedMessageKeys: keys,
        rejectedMessageKeys: [],
        reason: 'stored',
      };
    },
    async releaseMessageRefreshLease() { return true; },
    async purgeAccount() {
      return { enabled: true, tombstoned: true, generation: 2, deletedLists: 0, deletedMessages: 0 };
    },
    async cleanup() { return { enabled: true, skipped: false, deletedLists: 0, deletedMessages: 0 }; },
    async maybeCleanup() { return { enabled: true, skipped: true, deletedLists: 0, deletedMessages: 0 }; },
  };
  return Object.assign(store, overrides);
}

const localMailbox = {
  userId: 'owner-user',
  accountId: 'local-google',
  accountSource: 'local' as const,
  provider: 'google',
};

const listScope = {
  folder: 'INBOX',
  filter: { filter: 'all', from: '', hasAttachments: false },
  query: '',
  offset: 0,
  limit: 10,
};

function cachedListStore(state: 'fresh' | 'stale' = 'fresh', overrides: FakeOverrides = {}) {
  return fakeStore({
    async getList() {
      return readResult({ refs: [normalizedGoogleRef], totalCount: 1 }, state);
    },
    async getMessages() {
      return [{
        ...readResult({ ref: normalizedGoogleRef, metadata: metadata(), detail: null }, state),
        messageKey: normalizedGoogleRef.messageKey,
      }];
    },
    ...overrides,
  });
}

async function main() {
  let providerLoads = 0;
  const fresh = await readThroughEmailList({
    runtime: { store: cachedListStore('fresh') },
    mailbox: localMailbox,
    scope: listScope,
    load: async () => {
      providerLoads += 1;
      return { messages: [], total: 0 };
    },
    fromCache: (messages, total) => ({ messages, total }),
  });
  assert.equal(providerLoads, 0, 'fresh cache hits must not call the provider');
  assert.equal(fresh.cache.state, 'fresh');
  assert.equal(fresh.cache.source, 'cache');
  assert.equal((fresh.messages?.[0] as { subject: string }).subject, 'Cached subject');

  const scheduled: Array<() => Promise<void>> = [];
  const writeOrder: string[] = [];
  const stale = await readThroughEmailList({
    runtime: {
      store: cachedListStore('stale', {
        async putMessages(input) {
          writeOrder.push('messages');
          const keys = input.messages.map((message) => normalizeEmailMessageRef(message.ref).messageKey);
          return { enabled: true, requestedCount: keys.length, storedCount: keys.length, storedMessageKeys: keys, rejectedMessageKeys: [], reason: 'stored' };
        },
        async putList() {
          writeOrder.push('list');
          return { enabled: true, stored: true, reason: 'stored' };
        },
      }),
      scheduleBackgroundTask: (task) => scheduled.push(task),
    },
    mailbox: localMailbox,
    scope: listScope,
    load: async () => {
      providerLoads += 1;
      return {
        messages: [{
          id: 'g-1', uid: 'g-1', folder: 'INBOX', from: 'sender@example.test', subject: 'Fresh subject',
          date: '2026-09-08T11:00:00.000Z', snippet: 'Fresh', isRead: true, isAnswered: false,
          isFlagged: false, hasAttachments: false, flags: [],
        }],
        total: 1,
      };
    },
    fromCache: (messages, total) => ({ messages, total }),
  });
  assert.equal(stale.cache.state, 'stale');
  assert.equal(stale.cache.refreshQueued, true);
  assert.equal(providerLoads, 0, 'stale response must return before revalidation');
  assert.equal(scheduled.length, 1);
  await scheduled[0]();
  assert.equal(providerLoads, 1);
  assert.deepEqual(writeOrder, ['messages', 'list'], 'metadata batch must be durable before the list snapshot');

  const staleWithLeaseFailure = await readThroughEmailList({
    runtime: {
      store: cachedListStore('stale', {
        async acquireListRefreshLease() { throw new Error('database unavailable'); },
      }),
      scheduleBackgroundTask: () => assert.fail('failed leases must not schedule work'),
    },
    mailbox: localMailbox,
    scope: listScope,
    load: async () => assert.fail('stale lease errors must not call provider inline'),
    fromCache: (messages, total) => ({ messages, total }),
  });
  assert.equal(staleWithLeaseFailure.cache.state, 'stale');
  assert.equal(staleWithLeaseFailure.cache.refreshQueued, false);

  const missWrites: string[] = [];
  const miss = await readThroughEmailList({
    runtime: {
      store: fakeStore({
        async putMessages(input) {
          missWrites.push(`${input.accountSource}:messages`);
          const keys = input.messages.map((message) => normalizeEmailMessageRef(message.ref).messageKey);
          return { enabled: true, requestedCount: keys.length, storedCount: keys.length, storedMessageKeys: keys, rejectedMessageKeys: [], reason: 'stored' };
        },
        async putList(input) {
          missWrites.push(`${input.accountSource}:list`);
          return { enabled: true, stored: true, reason: 'stored' };
        },
      }),
    },
    mailbox: { ...localMailbox, accountSource: 'managed' },
    scope: listScope,
    load: async () => ({
      messages: [{
        id: 'g-1', uid: 'g-1', folder: 'INBOX', from: 'sender@example.test', subject: 'Provider subject',
        date: '2026-09-08T12:00:00.000Z', snippet: 'Provider', isRead: true, isAnswered: false,
        isFlagged: false, hasAttachments: false,
      }],
      total: 1,
    }),
    fromCache: (messages, total) => ({ messages, total }),
  });
  assert.equal(miss.cache.state, 'fresh', 'a successful provider fill is fresh to the caller');
  assert.equal(miss.cache.source, 'provider');
  assert.deepEqual(missWrites, ['managed:messages', 'managed:list']);

  let raceNow = 100;
  let raceFilled = false;
  let raceAcquireCount = 0;
  let raceProviderLoads = 0;
  const raceStore = fakeStore({
    async getList() {
      return raceFilled ? readResult({ refs: [normalizedGoogleRef], totalCount: 1 }) : readResult(null);
    },
    async getMessages() {
      return raceFilled ? [{
        ...readResult({ ref: normalizedGoogleRef, metadata: metadata('Race winner'), detail: null }),
        messageKey: normalizedGoogleRef.messageKey,
      }] : [];
    },
    async acquireListRefreshLease() {
      raceAcquireCount += 1;
      return { enabled: true, acquired: false, generation: 1, leaseUntil: 500 };
    },
  });
  const race = await readThroughEmailList({
    runtime: {
      store: raceStore,
      now: () => raceNow,
      sleep: async (milliseconds) => {
        raceNow += milliseconds;
        raceFilled = true;
      },
    },
    mailbox: localMailbox,
    scope: listScope,
    load: async () => {
      raceProviderLoads += 1;
      return { messages: [], total: 0 };
    },
    fromCache: (messages, total) => ({ messages, total }),
  });
  assert.equal(raceAcquireCount, 1);
  assert.equal(raceProviderLoads, 0, 'a lease loser must consume the winner result instead of duplicating provider work');
  assert.equal((race.messages?.[0] as { subject: string }).subject, 'Race winner');

  const partialStore = fakeStore({
    async getList() {
      const second = normalizeEmailMessageRef({ provider: 'google', messageId: 'g-2', folder: 'INBOX' });
      return readResult({ refs: [normalizedGoogleRef, second], totalCount: 2 });
    },
    async getMessages() {
      return [{
        ...readResult({ ref: normalizedGoogleRef, metadata: metadata(), detail: null }),
        messageKey: normalizedGoogleRef.messageKey,
      }];
    },
  });
  let partialProviderLoads = 0;
  await readThroughEmailList({
    runtime: { store: partialStore },
    mailbox: localMailbox,
    scope: listScope,
    load: async () => {
      partialProviderLoads += 1;
      return { messages: [], total: 0 };
    },
    fromCache: (messages, total) => ({ messages, total }),
  });
  assert.equal(partialProviderLoads, 1, 'incomplete cached lists must be treated as a miss');

  const cachedDetailStore = fakeStore({
    async getMessage() {
      return readResult({ ref: normalizedGoogleRef, metadata: metadata(), detail: detail() });
    },
  });
  let detailProviderLoads = 0;
  const detailHit = await readThroughEmailDetail({
    runtime: { store: cachedDetailStore },
    mailbox: localMailbox,
    messageId: 'g-1',
    folder: 'INBOX',
    load: async () => {
      detailProviderLoads += 1;
      return { message: {} };
    },
    fromCache: (message) => ({ message }),
  });
  assert.equal(detailProviderLoads, 0);
  assert.equal(detailHit.cache.source, 'cache');
  assert.equal((detailHit.message as { body: string }).body, 'Cached body');

  let legacyCacheReads = 0;
  let legacyProviderLoads = 0;
  const legacy = await readThroughEmailDetail({
    runtime: {
      store: fakeStore({
        async getMessage() {
          legacyCacheReads += 1;
          return readResult(null);
        },
      }),
    },
    mailbox: { ...localMailbox, provider: 'imap' },
    messageId: '42',
    folder: 'INBOX',
    load: async () => {
      legacyProviderLoads += 1;
      return { message: { id: '42', body: 'Legacy' } };
    },
    fromCache: (message) => ({ message }),
  });
  assert.equal(legacyCacheReads, 0);
  assert.equal(legacyProviderLoads, 1);
  assert.equal(legacy.cache.bypassReason, 'legacy_imap_reference');

  const imapId = createImapMessageReference('INBOX', '77', 42);
  let imapWrites = 0;
  await readThroughEmailDetail({
    runtime: {
      store: fakeStore({
        async putMessage(input) {
          imapWrites += 1;
          assert.equal(normalizeEmailMessageRef(input.ref).uidValidity, '77');
          assert.equal('contentBase64' in (input.detail?.attachments[0] || {}), false);
          return { enabled: true, stored: true, reason: 'stored' };
        },
      }),
    },
    mailbox: { ...localMailbox, provider: 'imap' },
    messageId: imapId,
    folder: 'INBOX',
    load: async () => ({
      message: {
        id: imapId, uid: '42', uidValidity: '77', folder: 'INBOX', from: 'sender@example.test',
        subject: 'IMAP', date: '2026-09-08T12:00:00.000Z', snippet: 'IMAP', body: 'Body', bodyHtml: '',
        attachments: [{ filename: 'safe.txt', size: 4, contentBase64: 'must-not-be-cached' }],
      },
    }),
    fromCache: (message) => ({ message }),
  });
  assert.equal(imapWrites, 1);

  const serviceSource = await readFile(new URL('../app/lib/email/service.ts', import.meta.url), 'utf8');
  assert.match(serviceSource, /options\?\.cacheMode === 'swr' && options\.enforceReadPolicy === false/u,
    'cache must be opt-in and forbidden for policy-enforced agent/poller reads');
  const listSource = serviceSource.slice(serviceSource.indexOf('export async function listEmailMessages'), serviceSource.indexOf('export async function readEmailMessage'));
  assert.ok(listSource.indexOf('findManagedEmailAccount') < listSource.indexOf('getRuntimeEmailCacheStore'), 'managed ownership must resolve before cache access');
  assert.ok(listSource.indexOf('resolveLocalEmailCacheAccount') < listSource.lastIndexOf('getRuntimeEmailCacheStore'), 'local ownership must resolve before cache access');
  const routeSource = await readFile(new URL('../app/api/email/messages/list/route.ts', import.meta.url), 'utf8');
  const detailRouteSource = await readFile(new URL('../app/api/email/accounts/[accountId]/messages/[messageId]/route.ts', import.meta.url), 'utf8');
  for (const source of [routeSource, detailRouteSource]) {
    assert.match(source, /cacheMode: 'swr'/u);
    assert.match(source, /scheduleBackgroundTask: after/u);
  }

  console.log('email cache read-through tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

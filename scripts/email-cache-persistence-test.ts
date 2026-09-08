import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import { runEmailCachePostgresMigration } from '../app/lib/email/cache/postgres-migration';
import {
  createEmailCacheStore,
  getRuntimeEmailCacheStore,
  normalizeEmailListCacheScope,
  normalizeEmailMessageRef,
  PostgresEmailCacheStore,
} from '../app/lib/email/cache/store';

async function installBaseEmailSchema(postgres: PGlite): Promise<void> {
  await postgres.exec(`
    CREATE TABLE "user" (
      id text PRIMARY KEY
    );
    CREATE TABLE email_accounts (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
    );
    INSERT INTO "user" (id) VALUES ('user-1'), ('user-2');
    INSERT INTO email_accounts (id, user_id)
    VALUES ('account-1', 'user-1'), ('account-2', 'user-2');
  `);
}

async function testMigration(postgres: PGlite): Promise<void> {
  await runEmailCachePostgresMigration(postgres as never);
  await runEmailCachePostgresMigration(postgres as never);

  const columns = await postgres.query<{
    table_name: string;
    column_name: string;
    data_type: string;
  }>(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('email_cache_mailboxes', 'email_cache_lists', 'email_cache_messages')
    ORDER BY table_name, ordinal_position
  `);
  assert.equal(new Set(columns.rows.map((row) => row.table_name)).size, 3);
  assert.equal(
    columns.rows.find((row) => row.table_name === 'email_cache_lists' && row.column_name === 'refs_json')?.data_type,
    'jsonb',
  );
  assert.equal(
    columns.rows.find((row) => row.table_name === 'email_cache_messages' && row.column_name === 'detail_json')?.data_type,
    'jsonb',
  );

  const indexes = await postgres.query<{ indexname: string }>(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('email_cache_mailboxes', 'email_cache_lists', 'email_cache_messages')
  `);
  assert.ok(indexes.rows.some((row) => row.indexname === 'idx_email_cache_lists_refresh_lease'));
  assert.ok(indexes.rows.some((row) => row.indexname === 'idx_email_cache_messages_account_lru'));

  // Managed accounts live in the Control Plane and therefore intentionally do
  // not need a local email_accounts row. The email service must authorize this
  // (user, source, account) tuple before it calls the cache.
  await postgres.exec(`
    INSERT INTO email_cache_mailboxes (
      user_id, account_source, account_id, generation, last_accessed_at, created_at, updated_at
    ) VALUES ('user-1', 'managed', 'managed-account-1', 1, 1, 1, 1)
  `);
  await assert.rejects(
    postgres.exec(`
      INSERT INTO email_cache_mailboxes (
        user_id, account_source, account_id, generation, last_accessed_at, created_at, updated_at
      ) VALUES ('missing-user', 'managed', 'managed-account-2', 1, 1, 1, 1)
    `),
  );

  const postgresMigrationSource = await readFile(
    path.join(process.cwd(), 'app', 'lib', 'db', 'postgres.ts'),
    'utf8',
  );
  assert.match(postgresMigrationSource, /await runEmailCachePostgresMigration\(pool\)/u);
  const databaseIndexSource = await readFile(
    path.join(process.cwd(), 'app', 'lib', 'db', 'index.ts'),
    'utf8',
  );
  assert.match(databaseIndexSource, /function getPostgresRuntimeQueryable/u);
  assert.doesNotMatch(databaseIndexSource, /getPostgresRuntimeQueryable[\s\S]{0,300}createPostgresPool\(/u);
}

async function testNormalizedKeys(): Promise<void> {
  const first = normalizeEmailListCacheScope({
    userId: 'user-1',
    accountId: 'account-1',
    folder: 'INBOX',
    filter: { unread: true, labels: ['important'] },
    query: '  quarterly report  ',
    offset: 0,
    limit: 25,
  });
  const reordered = normalizeEmailListCacheScope({
    userId: 'user-1',
    accountId: 'account-1',
    folder: 'INBOX',
    filter: { labels: ['important'], unread: true },
    query: 'quarterly report',
    offset: 0,
    limit: 25,
  });
  const nextPage = normalizeEmailListCacheScope({
    ...reordered,
    offset: 25,
  });
  assert.equal(first.cacheKey, reordered.cacheKey);
  assert.notEqual(first.cacheKey, nextPage.cacheKey);

  const imap = normalizeEmailMessageRef({
    provider: 'imap',
    folder: 'INBOX',
    uidValidity: 42,
    uid: 7,
    messageId: 'imap:v1:inbox:42:7',
  });
  assert.notEqual(imap.messageKey, normalizeEmailMessageRef({
    provider: 'imap',
    folder: 'INBOX',
    uidValidity: 43,
    uid: 7,
    messageId: 'imap:v1:inbox:43:7',
  }).messageKey);
  assert.notEqual(imap.messageKey, normalizeEmailMessageRef({
    provider: 'imap',
    folder: 'Archive',
    uidValidity: 42,
    uid: 7,
    messageId: 'imap:v1:archive:42:7',
  }).messageKey);
  assert.equal(normalizeEmailMessageRef({
    provider: 'smtp_imap',
    folder: 'INBOX',
    uidValidity: '42',
    uid: 7,
    messageId: 'imap:v1:inbox:42:7',
  }).provider, 'imap');
  assert.throws(() => normalizeEmailMessageRef({
    provider: 'imap',
    folder: 'INBOX',
    uidValidity: '0',
    uid: 7,
    messageId: 'imap:v1:inbox:0:7',
  }));
  assert.throws(() => normalizeEmailMessageRef({
    provider: 'imap',
    folder: 'INBOX',
    uidValidity: '42',
    uid: 7,
    messageId: '7',
  }));
}

async function testPostgresStore(postgres: PGlite): Promise<void> {
  const store = new PostgresEmailCacheStore(postgres as never);
  const competingStore = new PostgresEmailCacheStore(postgres as never);
  const scope = {
    userId: 'user-1',
    accountId: 'account-1',
    folder: 'INBOX',
    filter: { unread: true },
    query: '',
    offset: 0,
    limit: 25,
  } as const;
  const ref = { provider: 'gmail', messageId: 'message-1', folder: 'INBOX' } as const;

  assert.equal((await store.getList({ ...scope, now: 1_000 })).state, 'miss');
  const firstLease = await store.acquireListRefreshLease({
    ...scope,
    owner: 'worker-a',
    leaseMs: 1_000,
    now: 1_000,
  });
  assert.deepEqual(firstLease, {
    enabled: true,
    acquired: true,
    generation: 1,
    leaseUntil: 2_000,
  });
  assert.deepEqual(await competingStore.acquireListRefreshLease({
    ...scope,
    owner: 'worker-b',
    leaseMs: 1_000,
    now: 1_001,
  }), {
    enabled: true,
    acquired: false,
    generation: 1,
    leaseUntil: 2_000,
  });

  assert.equal((await store.putList({
    ...scope,
    refs: [ref],
    totalCount: 1,
    expectedGeneration: 1,
    leaseOwner: 'worker-a',
    freshForMs: 60,
    retainForMs: 600,
    now: 1_010,
  })).stored, true);
  const fresh = await store.getList({ ...scope, now: 1_020 });
  assert.equal(fresh.state, 'fresh');
  assert.equal(fresh.value?.totalCount, 1);
  assert.equal(fresh.value?.refs[0].messageId, 'message-1');
  assert.equal((await store.getList({ ...scope, now: 1_071 })).state, 'stale');
  assert.equal((await store.getList({ ...scope, now: 1_611 })).state, 'miss');

  assert.equal(await store.bumpMailboxGeneration({
    userId: scope.userId,
    accountId: scope.accountId,
    now: 2_000,
  }), 2);
  assert.equal((await store.putList({
    ...scope,
    refs: [],
    totalCount: 0,
    expectedGeneration: 1,
    freshForMs: 60,
    retainForMs: 600,
    now: 2_001,
  })).stored, false);
  assert.equal((await store.getList({ ...scope, now: 2_002 })).state, 'miss');

  const secondLease = await store.acquireListRefreshLease({
    ...scope,
    owner: 'worker-b',
    leaseMs: 1_000,
    now: 2_100,
  });
  assert.equal(secondLease.generation, 2);
  assert.equal(secondLease.acquired, true);
  assert.equal((await store.putList({
    ...scope,
    refs: [],
    totalCount: 0,
    expectedGeneration: 2,
    leaseOwner: 'worker-b',
    freshForMs: 60,
    retainForMs: 600,
    now: 2_101,
  })).stored, true);
  assert.deepEqual((await store.getList({ ...scope, now: 2_102 })).value?.refs, []);

  const messageLease = await store.acquireMessageRefreshLease({
    userId: scope.userId,
    accountId: scope.accountId,
    ref,
    owner: 'worker-a',
    leaseMs: 1_000,
    now: 3_000,
  });
  assert.equal(messageLease.acquired, true);
  assert.deepEqual(await competingStore.acquireMessageRefreshLease({
    userId: scope.userId,
    accountId: scope.accountId,
    ref,
    owner: 'worker-b',
    leaseMs: 1_000,
    now: 3_001,
  }), {
    enabled: true,
    acquired: false,
    generation: 2,
    leaseUntil: 4_000,
  });
  assert.equal((await store.putMessage({
    userId: scope.userId,
    accountId: scope.accountId,
    ref,
    metadata: {
      from: 'sender@example.com',
      subject: 'Cached subject',
      date: '1970-01-01T00:00:02.900Z',
      dateTimestamp: 2_900,
      snippet: 'Cached preview',
      isRead: false,
      isAnswered: true,
      isFlagged: true,
      hasAttachments: true,
      size: 1_024,
      threadId: 'thread-1',
      to: ['user@example.com'],
      cc: ['copy@example.com'],
      flags: ['\\Answered', '\\Flagged'],
    },
    expectedGeneration: 2,
    leaseOwner: 'worker-a',
    freshForMs: 60,
    retainForMs: 600,
    now: 3_010,
  })).stored, true);
  assert.equal((await store.getMessage({
    userId: scope.userId,
    accountId: scope.accountId,
    ref,
    part: 'metadata',
    now: 3_020,
  })).state, 'fresh');
  assert.equal((await store.getMessage({
    userId: scope.userId,
    accountId: scope.accountId,
    ref,
    part: 'detail',
    now: 3_020,
  })).state, 'miss');

  assert.equal((await store.putMessage({
    userId: scope.userId,
    accountId: scope.accountId,
    ref,
    detail: {
      body: 'Message body',
      bodyHtml: '<p>Message body</p>',
      to: ['user@example.com'],
      cc: [],
      messageId: '<message-1@example.com>',
      inReplyTo: '<original@example.com>',
      references: ['<original@example.com>'],
      attachments: [{
        id: 'attachment-1',
        index: 0,
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        size: 128,
        ...({ contentBase64: 'must-not-be-persisted' } as Record<string, unknown>),
      }],
    },
    expectedGeneration: 2,
    freshForMs: 60,
    retainForMs: 600,
    now: 3_030,
  })).stored, true);
  const detail = await store.getMessage({
    userId: scope.userId,
    accountId: scope.accountId,
    ref,
    part: 'detail',
    now: 3_040,
  });
  assert.equal(detail.value?.detail?.body, 'Message body');
  assert.equal(detail.value?.metadata?.threadId, 'thread-1');
  assert.equal(detail.value?.metadata?.isAnswered, true);
  assert.equal(detail.value?.metadata?.isFlagged, true);
  assert.equal(detail.value?.metadata?.hasAttachments, true);
  assert.deepEqual(detail.value?.detail?.attachments[0], {
    id: 'attachment-1',
    index: 0,
    filename: 'invoice.pdf',
    contentType: 'application/pdf',
    size: 128,
  });
  assert.equal('contentBase64' in (detail.value?.detail?.attachments[0] || {}), false);

  const secondRef = { provider: 'gmail', messageId: 'message-2', folder: 'INBOX' } as const;
  assert.equal((await store.putMessage({
    userId: scope.userId,
    accountId: scope.accountId,
    ref: secondRef,
    metadata: {
      from: 'second@example.com',
      subject: 'Second subject',
      date: '1970-01-01T00:00:03.000Z',
      dateTimestamp: 3_000,
      snippet: 'Second preview',
      isRead: true,
      isAnswered: false,
      isFlagged: false,
      hasAttachments: false,
      size: null,
    },
    expectedGeneration: 2,
    freshForMs: 60,
    retainForMs: 600,
    now: 3_050,
  })).stored, true);
  let batchQueryCount = 0;
  const batchStore = new PostgresEmailCacheStore({
    query: async (...args: Parameters<PGlite['query']>) => {
      batchQueryCount += 1;
      return postgres.query(...args);
    },
  } as never);
  const batch = await batchStore.getMessages({
    userId: scope.userId,
    accountId: scope.accountId,
    refs: [secondRef, ref],
    part: 'metadata',
    now: 3_051,
  });
  assert.equal(batchQueryCount, 1);
  assert.deepEqual(
    new Map(batch.map((entry) => [entry.messageKey, entry.value?.metadata?.subject])),
    new Map([
      [normalizeEmailMessageRef(ref).messageKey, 'Cached subject'],
      [normalizeEmailMessageRef(secondRef).messageKey, 'Second subject'],
    ]),
  );

  // Add two more exact list scopes, then prove per-account LRU cleanup is both
  // capacity-bound and delete-bound.
  for (let offset = 25; offset <= 50; offset += 25) {
    const pageScope = { ...scope, offset };
    const lease = await store.acquireListRefreshLease({
      ...pageScope,
      owner: `cleanup-${offset}`,
      leaseMs: 100,
      now: 4_000 + offset,
    });
    assert.equal((await store.putList({
      ...pageScope,
      refs: [],
      expectedGeneration: lease.generation!,
      leaseOwner: `cleanup-${offset}`,
      freshForMs: 60,
      retainForMs: 600,
      now: 4_001 + offset,
    })).stored, true);
  }
  const firstCleanup = await store.cleanup({
    now: 4_100,
    maxListsPerAccount: 1,
    maxMessagesPerAccount: 10,
    maxDeletesPerTable: 1,
  });
  assert.equal(firstCleanup.deletedLists, 1);
  const listCount = await postgres.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM email_cache_lists',
  );
  assert.equal(listCount.rows[0].count, '2');

  const purge = await store.purgeAccount({
    userId: scope.userId,
    accountId: scope.accountId,
    now: 5_000,
  });
  assert.deepEqual(purge, {
    enabled: true,
    tombstoned: true,
    generation: 3,
    deletedLists: 2,
    deletedMessages: 1,
  });
  const remaining = await postgres.query<{ list_count: string; message_count: string }>(`
    SELECT
      (SELECT COUNT(*) FROM email_cache_lists)::text AS list_count,
      (SELECT COUNT(*) FROM email_cache_messages)::text AS message_count
  `);
  assert.deepEqual(remaining.rows[0], { list_count: '0', message_count: '0' });

  // A provider refresh that started before disconnect cannot recreate data or
  // acquire a new lease while the tombstone is active.
  assert.equal((await store.putList({
    ...scope,
    refs: [],
    expectedGeneration: 2,
    freshForMs: 60,
    retainForMs: 600,
    now: 5_001,
  })).stored, false);
  assert.deepEqual(await store.acquireListRefreshLease({
    ...scope,
    owner: 'late-worker',
    leaseMs: 1_000,
    now: 5_002,
  }), {
    enabled: true,
    acquired: false,
    generation: null,
    leaseUntil: null,
  });
  assert.equal(await store.getMailboxGeneration({
    userId: scope.userId,
    accountId: scope.accountId,
    now: 5_003,
  }), null);

  // Managed and local account namespaces are independent even when the account
  // identifier is not backed by local email_accounts.
  assert.equal(await store.getMailboxGeneration({
    userId: 'user-1',
    accountSource: 'managed',
    accountId: 'managed-account-1',
    now: 5_004,
  }), 1);

  assert.equal(await store.reactivateAccount({
    userId: scope.userId,
    accountId: scope.accountId,
    now: 6_000,
  }), 4);
  const reactivatedLease = await store.acquireListRefreshLease({
    ...scope,
    owner: 'reconnected-worker',
    leaseMs: 1_000,
    now: 6_001,
  });
  assert.equal(reactivatedLease.generation, 4);
  assert.equal(reactivatedLease.acquired, true);
  assert.equal((await store.putList({
    ...scope,
    refs: [],
    expectedGeneration: 4,
    leaseOwner: 'reconnected-worker',
    freshForMs: 60,
    retainForMs: 600,
    now: 6_002,
  })).stored, true);
}

async function testSqliteBypass(): Promise<void> {
  const store = createEmailCacheStore({ provider: 'sqlite' });
  assert.equal(store.enabled, false);
  assert.deepEqual(await store.getList({
    userId: 'user-1',
    accountId: 'account-1',
    folder: 'INBOX',
    limit: 25,
  }), {
    state: 'miss',
    enabled: false,
    generation: null,
    fetchedAt: null,
    staleAt: null,
    expiresAt: null,
    value: null,
  });
  assert.deepEqual(await store.putList({
    userId: 'user-1',
    accountId: 'account-1',
    folder: 'INBOX',
    limit: 25,
    refs: [],
    expectedGeneration: 1,
  }), { enabled: false, stored: false, reason: 'disabled' });

  const previousProvider = process.env.CANVAS_DATABASE_PROVIDER;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  try {
    assert.equal((await getRuntimeEmailCacheStore()).enabled, false);
  } finally {
    if (previousProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = previousProvider;
  }
}

async function main(): Promise<void> {
  await testNormalizedKeys();
  await testSqliteBypass();
  const postgres = new PGlite();
  try {
    await installBaseEmailSchema(postgres);
    await testMigration(postgres);
    await testPostgresStore(postgres);
  } finally {
    await postgres.close();
  }
  console.log('email-cache-persistence-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

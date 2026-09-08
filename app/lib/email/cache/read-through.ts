import 'server-only';

import { randomUUID } from 'node:crypto';

import { parseImapMessageReference } from '@/app/lib/email/imap-service';
import {
  DEFAULT_EMAIL_CACHE_FRESH_MS,
  DEFAULT_EMAIL_CACHE_RETENTION_MS,
  DEFAULT_EMAIL_MESSAGE_RETENTION_MS,
  normalizeEmailCacheProvider,
  normalizeEmailMessageRef,
  type EmailCacheAccountSource,
  type EmailCachedMessageDetail,
  type EmailCachedMessageMetadata,
  type EmailCacheReadMetadata,
  type EmailCacheStore,
  type EmailListCacheScopeInput,
  type EmailMessageRefInput,
  type NormalizedEmailMessageRef,
} from '@/app/lib/email/cache/store';

const LIST_LEASE_MS = 15_000;
const DETAIL_LEASE_MS = 20_000;
const LEASE_POLL_MS = 50;

type JsonRecord = Record<string, unknown>;

export type EmailCacheMode = 'provider' | 'swr';

export type EmailCacheBackgroundScheduler = (task: () => Promise<void>) => void;

export type EmailResponseCacheMetadata = {
  enabled: boolean;
  scope: 'list' | 'detail';
  state: 'fresh' | 'stale' | 'miss';
  source: 'cache' | 'provider' | 'bypass';
  generation: number | null;
  fetchedAt: string | null;
  staleAt: string | null;
  expiresAt: string | null;
  refreshQueued: boolean;
  bypassReason?: 'cache_disabled' | 'cache_error' | 'legacy_imap_reference' | 'unsafe_imap_reference' | 'unsafe_message_reference' | 'lease_contention';
};

export type EmailCacheMailboxContext = {
  userId: string;
  accountId: string;
  accountSource: EmailCacheAccountSource;
  provider: string;
};

export type EmailListPayload = JsonRecord & {
  messages?: unknown[];
  total?: unknown;
};

export type EmailDetailPayload = JsonRecord & {
  message?: JsonRecord;
};

type CacheRuntime = {
  store: EmailCacheStore;
  scheduleBackgroundTask?: EmailCacheBackgroundScheduler;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type CachedListBundle = {
  messages: JsonRecord[];
  totalCount: number | null;
  metadata: EmailCacheReadMetadata;
};

function nowFor(runtime: CacheRuntime): number {
  return runtime.now?.() ?? Date.now();
}

function sleepFor(runtime: CacheRuntime, milliseconds: number): Promise<void> {
  return runtime.sleep?.(milliseconds) ?? new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isoTimestamp(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function cacheMetadata(
  scope: 'list' | 'detail',
  metadata: EmailCacheReadMetadata,
  source: EmailResponseCacheMetadata['source'],
  refreshQueued: boolean,
  bypassReason?: EmailResponseCacheMetadata['bypassReason'],
): EmailResponseCacheMetadata {
  return {
    enabled: metadata.enabled,
    scope,
    state: metadata.state,
    source,
    generation: metadata.generation,
    fetchedAt: isoTimestamp(metadata.fetchedAt),
    staleAt: isoTimestamp(metadata.staleAt),
    expiresAt: isoTimestamp(metadata.expiresAt),
    refreshQueued,
    ...(bypassReason ? { bypassReason } : {}),
  };
}

function providerMissMetadata(
  enabled: boolean,
  scope: 'list' | 'detail',
  now: number,
  generation: number | null,
  source: EmailResponseCacheMetadata['source'] = 'provider',
  bypassReason?: EmailResponseCacheMetadata['bypassReason'],
): EmailResponseCacheMetadata {
  const retention = scope === 'list' ? DEFAULT_EMAIL_CACHE_RETENTION_MS : DEFAULT_EMAIL_MESSAGE_RETENTION_MS;
  return cacheMetadata(scope, {
    enabled,
    state: source === 'provider' ? 'fresh' : 'miss',
    generation,
    fetchedAt: source === 'provider' ? now : null,
    staleAt: source === 'provider' ? now + DEFAULT_EMAIL_CACHE_FRESH_MS : null,
    expiresAt: source === 'provider' ? now + retention : null,
  }, source, false, bypassReason);
}

function withCache<T extends JsonRecord>(payload: T, cache: EmailResponseCacheMetadata): T & { cache: EmailResponseCacheMetadata } {
  return { ...payload, cache };
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === 'string' && value ? [value] : [];
  return value.map((entry) => {
    if (typeof entry === 'string') return entry;
    const address = record(entry)?.emailAddress;
    const addressRecord = record(address);
    return stringValue(addressRecord?.address || record(entry)?.address || '');
  }).filter(Boolean);
}

function sameFolder(left: string, right: string): boolean {
  return left === right || (left.toLowerCase() === 'inbox' && right.toLowerCase() === 'inbox');
}

export function emailMessageCacheRef(
  providerValue: string,
  messageId: string,
  folder?: string,
  message?: JsonRecord,
): EmailMessageRefInput | null {
  const provider = normalizeEmailCacheProvider(providerValue);
  if (provider !== 'imap') {
    return messageId.trim() ? { provider, messageId, ...(folder?.trim() ? { folder: folder.trim() } : {}) } : null;
  }

  try {
    const parsed = parseImapMessageReference(messageId, folder);
    if (parsed.version !== 1 || !parsed.uidValidity) return null;
    const responseFolder = stringValue(message?.folder);
    const responseUid = nullableNumber(message?.uid);
    const responseUidValidity = message?.uidValidity === undefined ? null : stringValue(message.uidValidity);
    if (responseFolder && !sameFolder(responseFolder, parsed.folder)) return null;
    if (responseUid !== null && responseUid !== parsed.uid) return null;
    if (responseUidValidity && responseUidValidity !== parsed.uidValidity) return null;
    return {
      provider: 'imap',
      messageId,
      folder: parsed.folder,
      uidValidity: parsed.uidValidity,
      uid: parsed.uid,
    };
  } catch {
    return null;
  }
}

function cacheRefInput(ref: NormalizedEmailMessageRef): EmailMessageRefInput | null {
  if (!ref.messageId) return null;
  if (ref.provider === 'imap') {
    if (!ref.folder || !ref.uidValidity || ref.uid === null) return null;
    return {
      provider: 'imap',
      messageId: ref.messageId,
      folder: ref.folder,
      uidValidity: ref.uidValidity,
      uid: ref.uid,
    };
  }
  return { provider: ref.provider, messageId: ref.messageId, ...(ref.folder ? { folder: ref.folder } : {}) };
}

function metadataForMessage(message: JsonRecord): EmailCachedMessageMetadata {
  const date = stringValue(message.date);
  const parsedDate = Date.parse(date);
  const flags = Array.isArray(message.flags) ? message.flags.map(String) : [];
  return {
    from: stringValue(message.from),
    subject: stringValue(message.subject),
    date,
    dateTimestamp: Number.isFinite(parsedDate) ? parsedDate : null,
    snippet: stringValue(message.snippet),
    isRead: message.isRead !== false,
    isAnswered: message.isAnswered === true,
    isFlagged: message.isFlagged === true,
    hasAttachments: message.hasAttachments === true,
    size: nullableNumber(message.size),
    to: stringArray(message.to),
    cc: stringArray(message.cc),
    threadId: message.threadId === null || message.threadId === undefined ? null : stringValue(message.threadId),
    flags,
  };
}

function attachmentMetadata(value: unknown, index: number): EmailCachedMessageDetail['attachments'][number] {
  const attachment = record(value) || {};
  return {
    ...(attachment.id !== undefined ? { id: stringValue(attachment.id) } : {}),
    ...(attachment.index !== undefined ? { index: nullableNumber(attachment.index) ?? index } : { index }),
    ...(attachment.name !== undefined ? { name: stringValue(attachment.name) } : {}),
    ...(attachment.filename !== undefined ? { filename: stringValue(attachment.filename) } : {}),
    ...(attachment.mimeType !== undefined ? { mimeType: stringValue(attachment.mimeType) } : {}),
    ...(attachment.contentType !== undefined ? { contentType: stringValue(attachment.contentType) } : {}),
    size: nullableNumber(attachment.size),
    ...(attachment.inline !== undefined ? { inline: Boolean(attachment.inline) } : {}),
    ...(attachment.isInline !== undefined ? { inline: Boolean(attachment.isInline) } : {}),
    ...(attachment.contentId !== undefined ? { contentId: attachment.contentId === null ? null : stringValue(attachment.contentId) } : {}),
  };
}

function detailForMessage(message: JsonRecord): EmailCachedMessageDetail {
  const rawHeaders = record(message.headers);
  const headers = rawHeaders
    ? Object.fromEntries(Object.entries(rawHeaders).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.map(String) : String(value),
    ]))
    : undefined;
  return {
    body: message.body === null || message.body === undefined ? null : stringValue(message.body),
    bodyHtml: message.bodyHtml === null || message.bodyHtml === undefined ? null : stringValue(message.bodyHtml),
    to: stringArray(message.to),
    cc: stringArray(message.cc),
    ...(Array.isArray(message.bcc) ? { bcc: stringArray(message.bcc) } : {}),
    ...(Array.isArray(message.replyTo) ? { replyTo: stringArray(message.replyTo) } : {}),
    ...(message.messageId !== undefined ? { messageId: stringValue(message.messageId) } : {}),
    ...(message.inReplyTo !== undefined ? { inReplyTo: stringValue(message.inReplyTo) } : {}),
    ...(Array.isArray(message.references) ? { references: message.references.map(String) } : {}),
    ...(headers ? { headers } : {}),
    attachments: Array.isArray(message.attachments)
      ? message.attachments.map(attachmentMetadata)
      : [],
  };
}

function fallbackListMessage(ref: NormalizedEmailMessageRef, metadata: EmailCachedMessageMetadata): JsonRecord {
  const flags = metadata.flags || [];
  return {
    id: ref.messageId || '',
    uid: ref.uid !== null ? String(ref.uid) : ref.messageId || '',
    ...(ref.uidValidity ? { uidValidity: ref.uidValidity } : {}),
    ...(ref.folder ? { folder: ref.folder } : {}),
    ...(metadata.threadId !== undefined ? { threadId: metadata.threadId || '' } : {}),
    from: metadata.from,
    to: metadata.to || [],
    cc: metadata.cc || [],
    subject: metadata.subject,
    date: metadata.date,
    flags,
    isRead: metadata.isRead,
    isAnswered: metadata.isAnswered,
    isFlagged: metadata.isFlagged,
    hasAttachments: metadata.hasAttachments,
    ...(metadata.size !== null ? { size: metadata.size } : {}),
    snippet: metadata.snippet,
  };
}

function fallbackDetailMessage(
  ref: NormalizedEmailMessageRef,
  metadata: EmailCachedMessageMetadata,
  detail: EmailCachedMessageDetail,
  accountSource: EmailCacheAccountSource,
): JsonRecord {
  const providerFields = ref.provider === 'imap' || accountSource === 'managed'
    ? {
        uid: ref.uid !== null ? String(ref.uid) : ref.messageId || '',
        ...(ref.uidValidity ? { uidValidity: ref.uidValidity } : {}),
        ...(ref.folder ? { folder: ref.folder } : {}),
        flags: metadata.flags || [],
        isAnswered: metadata.isAnswered,
        isFlagged: metadata.isFlagged,
        hasAttachments: metadata.hasAttachments,
        attachments: detail.attachments,
      }
    : {};
  return {
    id: ref.messageId || '',
    ...(metadata.threadId !== undefined ? { threadId: metadata.threadId || '' } : {}),
    from: metadata.from,
    to: detail.to,
    cc: detail.cc,
    subject: metadata.subject,
    date: metadata.date,
    messageId: detail.messageId || '',
    inReplyTo: detail.inReplyTo || '',
    references: detail.references || [],
    body: detail.body || '',
    bodyHtml: detail.bodyHtml || '',
    isRead: metadata.isRead,
    snippet: metadata.snippet,
    ...(detail.bcc ? { bcc: detail.bcc } : {}),
    ...(detail.replyTo ? { replyTo: detail.replyTo } : {}),
    ...providerFields,
  };
}

function mapListMessages(provider: string, messages: unknown[]): Array<{
  ref: EmailMessageRefInput;
  metadata: EmailCachedMessageMetadata;
}> | null {
  const mapped = [];
  for (const value of messages) {
    const message = record(value);
    if (!message) return null;
    const messageId = stringValue(message.id);
    const ref = emailMessageCacheRef(provider, messageId, stringValue(message.folder) || undefined, message);
    if (!ref) return null;
    mapped.push({ ref, metadata: metadataForMessage(message) });
  }
  return mapped;
}

async function readListBundle(
  runtime: CacheRuntime,
  mailbox: EmailCacheMailboxContext,
  scope: EmailListCacheScopeInput,
): Promise<CachedListBundle | null> {
  const list = await runtime.store.getList({ ...scope, now: nowFor(runtime) });
  if (!list.value) return null;
  const refs = list.value.refs.map(cacheRefInput);
  if (refs.some((ref) => !ref)) return null;
  const messages = await runtime.store.getMessages({
    userId: mailbox.userId,
    accountId: mailbox.accountId,
    accountSource: mailbox.accountSource,
    refs: refs as EmailMessageRefInput[],
    part: 'metadata',
    now: nowFor(runtime),
  });
  const byKey = new Map(messages.map((message) => [message.messageKey, message]));
  const hydrated: JsonRecord[] = [];
  let state = list.state;
  for (const ref of list.value.refs) {
    const cached = byKey.get(ref.messageKey);
    if (!cached?.value?.metadata) return null;
    if (cached.state === 'stale') state = 'stale';
    hydrated.push(fallbackListMessage(ref, cached.value.metadata));
  }
  return {
    messages: hydrated,
    totalCount: list.value.totalCount,
    metadata: { ...list, state, value: undefined } as EmailCacheReadMetadata,
  };
}

async function refreshList<T extends EmailListPayload>(input: {
  runtime: CacheRuntime;
  mailbox: EmailCacheMailboxContext;
  scope: EmailListCacheScopeInput;
  owner: string;
  generation: number;
  load: () => Promise<T>;
}): Promise<{
  payload: T;
  cacheable: boolean;
  bypassReason?: EmailResponseCacheMetadata['bypassReason'];
}> {
  let payload: T;
  try {
    payload = await input.load();
  } catch (error) {
    await input.runtime.store.releaseListRefreshLease({
      ...input.scope,
      owner: input.owner,
      now: nowFor(input.runtime),
    }).catch(() => false);
    throw error;
  }
  try {
    const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
    const mapped = mapListMessages(input.mailbox.provider, rawMessages);
    if (!mapped) return { payload, cacheable: false, bypassReason: 'unsafe_message_reference' };
    const batch = await input.runtime.store.putMessages({
      userId: input.mailbox.userId,
      accountId: input.mailbox.accountId,
      accountSource: input.mailbox.accountSource,
      messages: mapped,
      expectedGeneration: input.generation,
      now: nowFor(input.runtime),
    });
    if (batch.storedCount !== mapped.length) return { payload, cacheable: false, bypassReason: 'cache_error' };
    const stored = await input.runtime.store.putList({
      ...input.scope,
      refs: mapped.map((entry) => entry.ref),
      totalCount: nullableNumber(payload.total),
      expectedGeneration: input.generation,
      leaseOwner: input.owner,
      now: nowFor(input.runtime),
    });
    if (stored.stored) void input.runtime.store.maybeCleanup().catch(() => undefined);
    return { payload, cacheable: stored.stored, ...(stored.stored ? {} : { bypassReason: 'cache_error' as const }) };
  } catch (error) {
    console.warn('Email list cache refresh could not be persisted.', error);
    return { payload, cacheable: false, bypassReason: 'cache_error' };
  } finally {
    await input.runtime.store.releaseListRefreshLease({
      ...input.scope,
      owner: input.owner,
      now: nowFor(input.runtime),
    }).catch(() => false);
  }
}

function scheduleRefresh(schedule: EmailCacheBackgroundScheduler, task: () => Promise<void>): boolean {
  try {
    schedule(async () => {
      try {
        await task();
      } catch (error) {
        console.warn('Email cache background refresh failed.', error);
      }
    });
    return true;
  } catch (error) {
    console.warn('Email cache background refresh could not be scheduled.', error);
    return false;
  }
}

export async function readThroughEmailList<T extends EmailListPayload>(input: {
  runtime: CacheRuntime;
  mailbox: EmailCacheMailboxContext;
  scope: Omit<EmailListCacheScopeInput, 'userId' | 'accountId' | 'accountSource'>;
  load: () => Promise<T>;
  fromCache: (messages: JsonRecord[], totalCount: number | null) => T;
}): Promise<T & { cache: EmailResponseCacheMetadata }> {
  const scope: EmailListCacheScopeInput = { ...input.scope, ...input.mailbox };
  if (!input.runtime.store.enabled) {
    const payload = await input.load();
    return withCache(payload, providerMissMetadata(false, 'list', nowFor(input.runtime), null, 'bypass', 'cache_disabled'));
  }

  let cached: CachedListBundle | null;
  try {
    cached = await readListBundle(input.runtime, input.mailbox, scope);
  } catch {
    const payload = await input.load();
    return withCache(payload, providerMissMetadata(true, 'list', nowFor(input.runtime), null, 'bypass', 'cache_error'));
  }

  if (cached?.metadata.state === 'fresh') {
    return withCache(input.fromCache(cached.messages, cached.totalCount), cacheMetadata('list', cached.metadata, 'cache', false));
  }

  if (cached?.metadata.state === 'stale') {
    let refreshQueued = false;
    if (input.runtime.scheduleBackgroundTask) {
      const owner = randomUUID();
      try {
        const lease = await input.runtime.store.acquireListRefreshLease({ ...scope, owner, leaseMs: LIST_LEASE_MS, now: nowFor(input.runtime) });
        if (lease.acquired && lease.generation !== null) {
          refreshQueued = scheduleRefresh(input.runtime.scheduleBackgroundTask, async () => {
            await refreshList({ ...input, scope, owner, generation: lease.generation!, runtime: input.runtime });
          });
          if (!refreshQueued) {
            await input.runtime.store.releaseListRefreshLease({ ...scope, owner, now: nowFor(input.runtime) }).catch(() => false);
          }
        } else {
          refreshQueued = Boolean(lease.leaseUntil && lease.leaseUntil > nowFor(input.runtime));
        }
      } catch (error) {
        console.warn('Email list cache refresh lease could not be acquired.', error);
      }
    }
    return withCache(input.fromCache(cached.messages, cached.totalCount), cacheMetadata('list', cached.metadata, 'cache', refreshQueued));
  }

  const owner = randomUUID();
  let lease;
  try {
    lease = await input.runtime.store.acquireListRefreshLease({ ...scope, owner, leaseMs: LIST_LEASE_MS, now: nowFor(input.runtime) });
  } catch {
    const payload = await input.load();
    return withCache(payload, providerMissMetadata(true, 'list', nowFor(input.runtime), null, 'bypass', 'cache_error'));
  }
  if (!lease.acquired) {
    const waitUntil = Math.min(lease.leaseUntil ?? nowFor(input.runtime), nowFor(input.runtime) + LIST_LEASE_MS);
    while (nowFor(input.runtime) < waitUntil) {
      await sleepFor(input.runtime, Math.min(LEASE_POLL_MS, waitUntil - nowFor(input.runtime)));
      try {
        cached = await readListBundle(input.runtime, input.mailbox, scope);
      } catch {
        const payload = await input.load();
        return withCache(payload, providerMissMetadata(true, 'list', nowFor(input.runtime), lease.generation, 'bypass', 'cache_error'));
      }
      if (cached) {
        return withCache(input.fromCache(cached.messages, cached.totalCount), cacheMetadata('list', cached.metadata, 'cache', false));
      }
    }
    try {
      lease = await input.runtime.store.acquireListRefreshLease({ ...scope, owner, leaseMs: LIST_LEASE_MS, now: nowFor(input.runtime) });
    } catch {
      const payload = await input.load();
      return withCache(payload, providerMissMetadata(true, 'list', nowFor(input.runtime), null, 'bypass', 'cache_error'));
    }
  }
  if (!lease.acquired || lease.generation === null) {
    const payload = await input.load();
    return withCache(payload, providerMissMetadata(true, 'list', nowFor(input.runtime), lease.generation, 'provider', 'lease_contention'));
  }
  const refreshed = await refreshList({ ...input, scope, owner, generation: lease.generation, runtime: input.runtime });
  return withCache(refreshed.payload, providerMissMetadata(true, 'list', nowFor(input.runtime), lease.generation, refreshed.cacheable ? 'provider' : 'bypass', refreshed.bypassReason));
}

async function readCachedDetail(
  runtime: CacheRuntime,
  mailbox: EmailCacheMailboxContext,
  ref: EmailMessageRefInput,
): Promise<{ message: JsonRecord; metadata: EmailCacheReadMetadata } | null> {
  const cached = await runtime.store.getMessage({
    userId: mailbox.userId,
    accountId: mailbox.accountId,
    accountSource: mailbox.accountSource,
    ref,
    part: 'detail',
    now: nowFor(runtime),
  });
  if (!cached.value?.metadata || !cached.value.detail) return null;
  return {
    message: fallbackDetailMessage(cached.value.ref, cached.value.metadata, cached.value.detail, mailbox.accountSource),
    metadata: cached,
  };
}

async function refreshDetail<T extends EmailDetailPayload>(input: {
  runtime: CacheRuntime;
  mailbox: EmailCacheMailboxContext;
  ref: EmailMessageRefInput;
  owner: string;
  generation: number;
  load: () => Promise<T>;
}): Promise<{
  payload: T;
  cacheable: boolean;
  bypassReason?: EmailResponseCacheMetadata['bypassReason'];
}> {
  let payload: T;
  try {
    payload = await input.load();
  } catch (error) {
    await input.runtime.store.releaseMessageRefreshLease({
      userId: input.mailbox.userId,
      accountId: input.mailbox.accountId,
      accountSource: input.mailbox.accountSource,
      ref: input.ref,
      owner: input.owner,
      now: nowFor(input.runtime),
    }).catch(() => false);
    throw error;
  }
  try {
    const message = record(payload.message);
    if (!message) return { payload, cacheable: false, bypassReason: 'unsafe_message_reference' };
    const actualRef = emailMessageCacheRef(
      input.mailbox.provider,
      stringValue(message.id) || ('messageId' in input.ref ? input.ref.messageId : ''),
      stringValue(message.folder) || ('folder' in input.ref ? input.ref.folder : undefined),
      message,
    );
    if (!actualRef || normalizeEmailMessageRef(actualRef).messageKey !== normalizeEmailMessageRef(input.ref).messageKey) {
      return { payload, cacheable: false, bypassReason: 'unsafe_message_reference' };
    }
    const stored = await input.runtime.store.putMessage({
      userId: input.mailbox.userId,
      accountId: input.mailbox.accountId,
      accountSource: input.mailbox.accountSource,
      ref: actualRef,
      metadata: metadataForMessage(message),
      detail: detailForMessage(message),
      expectedGeneration: input.generation,
      leaseOwner: input.owner,
      now: nowFor(input.runtime),
    });
    if (stored.stored) void input.runtime.store.maybeCleanup().catch(() => undefined);
    return { payload, cacheable: stored.stored, ...(stored.stored ? {} : { bypassReason: 'cache_error' as const }) };
  } catch (error) {
    console.warn('Email detail cache refresh could not be persisted.', error);
    return { payload, cacheable: false, bypassReason: 'cache_error' };
  } finally {
    await input.runtime.store.releaseMessageRefreshLease({
      userId: input.mailbox.userId,
      accountId: input.mailbox.accountId,
      accountSource: input.mailbox.accountSource,
      ref: input.ref,
      owner: input.owner,
      now: nowFor(input.runtime),
    }).catch(() => false);
  }
}

export async function readThroughEmailDetail<T extends EmailDetailPayload>(input: {
  runtime: CacheRuntime;
  mailbox: EmailCacheMailboxContext;
  messageId: string;
  folder?: string;
  load: () => Promise<T>;
  fromCache: (message: JsonRecord) => T;
}): Promise<T & { cache: EmailResponseCacheMetadata }> {
  const ref = emailMessageCacheRef(input.mailbox.provider, input.messageId, input.folder);
  if (!ref) {
    const payload = await input.load();
    const reason = /^[1-9]\d*$/u.test(input.messageId) ? 'legacy_imap_reference' : 'unsafe_imap_reference';
    return withCache(payload, providerMissMetadata(input.runtime.store.enabled, 'detail', nowFor(input.runtime), null, 'bypass', reason));
  }
  if (!input.runtime.store.enabled) {
    const payload = await input.load();
    return withCache(payload, providerMissMetadata(false, 'detail', nowFor(input.runtime), null, 'bypass', 'cache_disabled'));
  }

  let cached: Awaited<ReturnType<typeof readCachedDetail>>;
  try {
    cached = await readCachedDetail(input.runtime, input.mailbox, ref);
  } catch {
    const payload = await input.load();
    return withCache(payload, providerMissMetadata(true, 'detail', nowFor(input.runtime), null, 'bypass', 'cache_error'));
  }
  if (cached?.metadata.state === 'fresh') {
    return withCache(input.fromCache(cached.message), cacheMetadata('detail', cached.metadata, 'cache', false));
  }
  if (cached?.metadata.state === 'stale') {
    let refreshQueued = false;
    if (input.runtime.scheduleBackgroundTask) {
      const owner = randomUUID();
      try {
        const lease = await input.runtime.store.acquireMessageRefreshLease({
          userId: input.mailbox.userId,
          accountId: input.mailbox.accountId,
          accountSource: input.mailbox.accountSource,
          ref,
          owner,
          leaseMs: DETAIL_LEASE_MS,
          now: nowFor(input.runtime),
        });
        if (lease.acquired && lease.generation !== null) {
          refreshQueued = scheduleRefresh(input.runtime.scheduleBackgroundTask, async () => {
            await refreshDetail({ ...input, ref, owner, generation: lease.generation!, runtime: input.runtime });
          });
          if (!refreshQueued) {
            await input.runtime.store.releaseMessageRefreshLease({
              userId: input.mailbox.userId,
              accountId: input.mailbox.accountId,
              accountSource: input.mailbox.accountSource,
              ref,
              owner,
              now: nowFor(input.runtime),
            }).catch(() => false);
          }
        } else {
          refreshQueued = Boolean(lease.leaseUntil && lease.leaseUntil > nowFor(input.runtime));
        }
      } catch (error) {
        console.warn('Email detail cache refresh lease could not be acquired.', error);
      }
    }
    return withCache(input.fromCache(cached.message), cacheMetadata('detail', cached.metadata, 'cache', refreshQueued));
  }

  const owner = randomUUID();
  let lease;
  try {
    lease = await input.runtime.store.acquireMessageRefreshLease({
      userId: input.mailbox.userId,
      accountId: input.mailbox.accountId,
      accountSource: input.mailbox.accountSource,
      ref,
      owner,
      leaseMs: DETAIL_LEASE_MS,
      now: nowFor(input.runtime),
    });
  } catch {
    const payload = await input.load();
    return withCache(payload, providerMissMetadata(true, 'detail', nowFor(input.runtime), null, 'bypass', 'cache_error'));
  }
  if (!lease.acquired) {
    const waitUntil = Math.min(lease.leaseUntil ?? nowFor(input.runtime), nowFor(input.runtime) + DETAIL_LEASE_MS);
    while (nowFor(input.runtime) < waitUntil) {
      await sleepFor(input.runtime, Math.min(LEASE_POLL_MS, waitUntil - nowFor(input.runtime)));
      try {
        cached = await readCachedDetail(input.runtime, input.mailbox, ref);
      } catch {
        const payload = await input.load();
        return withCache(payload, providerMissMetadata(true, 'detail', nowFor(input.runtime), lease.generation, 'bypass', 'cache_error'));
      }
      if (cached) return withCache(input.fromCache(cached.message), cacheMetadata('detail', cached.metadata, 'cache', false));
    }
    try {
      lease = await input.runtime.store.acquireMessageRefreshLease({
        userId: input.mailbox.userId,
        accountId: input.mailbox.accountId,
        accountSource: input.mailbox.accountSource,
        ref,
        owner,
        leaseMs: DETAIL_LEASE_MS,
        now: nowFor(input.runtime),
      });
    } catch {
      const payload = await input.load();
      return withCache(payload, providerMissMetadata(true, 'detail', nowFor(input.runtime), null, 'bypass', 'cache_error'));
    }
  }
  if (!lease.acquired || lease.generation === null) {
    const payload = await input.load();
    return withCache(payload, providerMissMetadata(true, 'detail', nowFor(input.runtime), lease.generation, 'provider', 'lease_contention'));
  }
  const refreshed = await refreshDetail({ ...input, ref, owner, generation: lease.generation, runtime: input.runtime });
  return withCache(refreshed.payload, providerMissMetadata(true, 'detail', nowFor(input.runtime), lease.generation, refreshed.cacheable ? 'provider' : 'bypass', refreshed.bypassReason));
}

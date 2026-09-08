import 'server-only';

import { createHash } from 'node:crypto';

import type { EmailCachePostgresQueryable } from './postgres-migration';

export const EMAIL_CACHE_SCHEMA_VERSION = 1;
export const DEFAULT_EMAIL_CACHE_FRESH_MS = 60_000;
export const DEFAULT_EMAIL_CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_EMAIL_MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_EMAIL_CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;

export type EmailCacheState = 'fresh' | 'stale' | 'miss';
export type EmailCacheAccountSource = 'local' | 'managed';
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type EmailListCacheScopeInput = {
  userId: string;
  accountId: string;
  accountSource?: EmailCacheAccountSource;
  folder: string;
  filter?: JsonValue;
  query?: string;
  offset?: number;
  limit: number;
  schemaVersion?: number;
};

export type NormalizedEmailListCacheScope = {
  userId: string;
  accountId: string;
  accountSource: EmailCacheAccountSource;
  folder: string;
  filter: JsonValue;
  query: string;
  offset: number;
  limit: number;
  schemaVersion: number;
  cacheKey: string;
};

export type EmailMessageRefInput =
  | {
      provider: 'imap' | 'smtp_imap';
      folder: string;
      uidValidity: string | number;
      uid: number;
      messageId: string;
    }
  | {
      provider: string;
      messageId: string;
      folder?: string;
      uidValidity?: never;
      uid?: never;
    };

export type NormalizedEmailMessageRef = {
  messageKey: string;
  provider: string;
  messageId: string | null;
  folder: string | null;
  uidValidity: string | null;
  uid: number | null;
};

export type EmailCachedMessageMetadata = {
  from: string;
  subject: string;
  /** Provider-facing date value retained losslessly for the existing UI contract. */
  date: string;
  /** Parsed epoch milliseconds used only for normalized persistence/sorting. */
  dateTimestamp: number | null;
  snippet: string;
  isRead: boolean;
  isAnswered: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  size: number | null;
  to?: string[];
  cc?: string[];
  threadId?: string | null;
  flags?: string[];
};

export type EmailCachedAttachmentMetadata = {
  id?: string;
  index?: number;
  name?: string;
  filename?: string;
  mimeType?: string;
  contentType?: string;
  size: number | null;
  inline?: boolean;
  contentId?: string | null;
};

export type EmailCachedMessageDetail = {
  body: string | null;
  bodyHtml: string | null;
  to: string[];
  cc: string[];
  bcc?: string[];
  replyTo?: string[];
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  headers?: Record<string, string | string[]>;
  attachments: EmailCachedAttachmentMetadata[];
};

export type EmailCachedListSnapshot = {
  refs: NormalizedEmailMessageRef[];
  totalCount: number | null;
};

export type EmailCachedMessage = {
  ref: NormalizedEmailMessageRef;
  metadata: EmailCachedMessageMetadata | null;
  detail: EmailCachedMessageDetail | null;
};

export type EmailCacheReadMetadata = {
  state: EmailCacheState;
  enabled: boolean;
  generation: number | null;
  fetchedAt: number | null;
  staleAt: number | null;
  expiresAt: number | null;
};

export type EmailCacheReadResult<T> = EmailCacheReadMetadata & {
  value: T | null;
};

export type EmailCacheBatchMessageResult = EmailCacheReadResult<EmailCachedMessage> & {
  messageKey: string;
};

export type EmailCacheLeaseResult = {
  enabled: boolean;
  acquired: boolean;
  generation: number | null;
  leaseUntil: number | null;
};

export type EmailCacheWriteResult = {
  enabled: boolean;
  stored: boolean;
  reason: 'stored' | 'disabled' | 'generation_changed_or_lease_lost';
};

export type EmailCacheMessageWriteEntry = {
  ref: EmailMessageRefInput;
  metadata?: EmailCachedMessageMetadata;
  detail?: EmailCachedMessageDetail;
  leaseOwner?: string;
};

export type EmailCacheBatchWriteResult = {
  enabled: boolean;
  requestedCount: number;
  storedCount: number;
  storedMessageKeys: string[];
  rejectedMessageKeys: string[];
  reason: 'stored' | 'partial' | 'disabled' | 'generation_changed_or_tombstoned';
};

export type EmailCacheCleanupResult = {
  enabled: boolean;
  skipped: boolean;
  deletedLists: number;
  deletedMessages: number;
};

export type EmailCachePurgeResult = {
  enabled: boolean;
  tombstoned: boolean;
  generation: number | null;
  deletedLists: number;
  deletedMessages: number;
};

type MailboxInput = {
  userId: string;
  accountId: string;
  accountSource?: EmailCacheAccountSource;
};

export interface EmailCacheStore {
  /**
   * Persistence-only capabilities. Callers must re-authorize the current user
   * against the requested local or managed account before every cache read.
   */
  readonly enabled: boolean;
  getMailboxGeneration(input: MailboxInput & { now?: number }): Promise<number | null>;
  bumpMailboxGeneration(input: MailboxInput & { now?: number }): Promise<number | null>;
  reactivateAccount(input: MailboxInput & { now?: number }): Promise<number | null>;
  getList(input: EmailListCacheScopeInput & { now?: number }): Promise<EmailCacheReadResult<EmailCachedListSnapshot>>;
  acquireListRefreshLease(
    input: EmailListCacheScopeInput & { owner: string; leaseMs: number; now?: number },
  ): Promise<EmailCacheLeaseResult>;
  putList(
    input: EmailListCacheScopeInput & {
      refs: EmailMessageRefInput[];
      totalCount?: number | null;
      expectedGeneration: number;
      leaseOwner?: string;
      freshForMs?: number;
      retainForMs?: number;
      now?: number;
    },
  ): Promise<EmailCacheWriteResult>;
  releaseListRefreshLease(
    input: EmailListCacheScopeInput & { owner: string; now?: number },
  ): Promise<boolean>;
  getMessage(
    input: MailboxInput & { ref: EmailMessageRefInput; part?: 'metadata' | 'detail'; now?: number },
  ): Promise<EmailCacheReadResult<EmailCachedMessage>>;
  getMessages(
    input: MailboxInput & { refs: EmailMessageRefInput[]; part?: 'metadata' | 'detail'; now?: number },
  ): Promise<EmailCacheBatchMessageResult[]>;
  acquireMessageRefreshLease(
    input: MailboxInput & { ref: EmailMessageRefInput; owner: string; leaseMs: number; now?: number },
  ): Promise<EmailCacheLeaseResult>;
  putMessage(
    input: MailboxInput & {
      ref: EmailMessageRefInput;
      metadata?: EmailCachedMessageMetadata;
      detail?: EmailCachedMessageDetail;
      expectedGeneration: number;
      leaseOwner?: string;
      freshForMs?: number;
      retainForMs?: number;
      now?: number;
    },
  ): Promise<EmailCacheWriteResult>;
  putMessages(
    input: MailboxInput & {
      messages: EmailCacheMessageWriteEntry[];
      expectedGeneration: number;
      freshForMs?: number;
      retainForMs?: number;
      now?: number;
    },
  ): Promise<EmailCacheBatchWriteResult>;
  releaseMessageRefreshLease(
    input: MailboxInput & { ref: EmailMessageRefInput; owner: string; now?: number },
  ): Promise<boolean>;
  purgeAccount(input: MailboxInput & { now?: number }): Promise<EmailCachePurgeResult>;
  cleanup(input?: {
    now?: number;
    maxListsPerAccount?: number;
    maxMessagesPerAccount?: number;
    maxDeletesPerTable?: number;
  }): Promise<EmailCacheCleanupResult>;
  maybeCleanup(input?: {
    now?: number;
    intervalMs?: number;
    maxListsPerAccount?: number;
    maxMessagesPerAccount?: number;
    maxDeletesPerTable?: number;
  }): Promise<EmailCacheCleanupResult>;
}

type QueryResult<Row> = { rows: Row[]; rowCount?: number | null };

type CacheRow = {
  generation: number | string;
  fetched_at: number | string | null;
  stale_at: number | string | null;
  expires_at: number | string | null;
};

function requiredText(value: string, name: string): string {
  const normalized = value.normalize('NFC').trim();
  if (!normalized) throw new Error(`${name} must not be empty.`);
  return normalized;
}

function normalizeMailbox(input: MailboxInput): Required<MailboxInput> {
  const accountSource = input.accountSource ?? 'local';
  if (accountSource !== 'local' && accountSource !== 'managed') {
    throw new Error('accountSource must be local or managed.');
  }
  return {
    userId: requiredText(input.userId, 'userId'),
    accountId: requiredText(input.accountId, 'accountId'),
    accountSource,
  };
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function normalizeImapUint32(value: string | number, name: string): string {
  const candidate = String(value);
  if (!/^[1-9][0-9]*$/u.test(candidate)) {
    throw new Error(`${name} must be a positive decimal integer.`);
  }
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed > 4_294_967_295) {
    throw new Error(`${name} must fit in an unsigned 32-bit integer.`);
  }
  return String(parsed);
}

export function normalizeEmailCacheProvider(value: string): string {
  const provider = requiredText(value, 'provider').toLowerCase();
  if (provider === 'imap' || provider === 'smtp_imap') return 'imap';
  if (provider === 'gmail') return 'google';
  if (provider === 'outlook' || provider === 'office365') return 'microsoft';
  return provider;
}

function normalizeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeJson(nested)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Email cache filters only accept finite JSON numbers.');
  }
  return value;
}

export function normalizeEmailListCacheScope(
  input: EmailListCacheScopeInput,
): NormalizedEmailListCacheScope {
  const mailbox = normalizeMailbox(input);
  const normalized = {
    ...mailbox,
    folder: requiredText(input.folder, 'folder'),
    filter: normalizeJson(input.filter ?? null),
    query: (input.query ?? '').normalize('NFC').trim(),
    offset: nonNegativeInteger(input.offset ?? 0, 'offset'),
    limit: positiveInteger(input.limit, 'limit'),
    schemaVersion: positiveInteger(input.schemaVersion ?? EMAIL_CACHE_SCHEMA_VERSION, 'schemaVersion'),
  };
  const canonicalScope = JSON.stringify({
    version: normalized.schemaVersion,
    folder: normalized.folder,
    filter: normalized.filter,
    query: normalized.query,
    offset: normalized.offset,
    limit: normalized.limit,
  });
  return {
    ...normalized,
    cacheKey: createHash('sha256').update(canonicalScope).digest('hex'),
  };
}

export function normalizeEmailMessageRef(input: EmailMessageRefInput): NormalizedEmailMessageRef {
  const provider = normalizeEmailCacheProvider(input.provider);
  const candidate = input as {
    messageId?: string;
    folder?: string;
    uidValidity?: string | number;
    uid?: number;
  };
  if (provider === 'imap') {
    if (candidate.uid === undefined || candidate.uidValidity === undefined || candidate.folder === undefined) {
      throw new Error('IMAP cache references require folder, UIDVALIDITY, and UID.');
    }
    const folder = requiredText(candidate.folder, 'folder');
    const uidValidity = normalizeImapUint32(candidate.uidValidity, 'uidValidity');
    const uid = positiveInteger(candidate.uid, 'uid');
    if (uid > 4_294_967_295) throw new Error('uid must fit in an unsigned 32-bit integer.');
    const messageId = candidate.messageId ? requiredText(candidate.messageId, 'messageId') : '';
    if (!messageId || /^[0-9]+$/u.test(messageId)) {
      throw new Error('IMAP cache references require an opaque, non-legacy messageId.');
    }
    const identity = JSON.stringify({ provider, folder, uidValidity, uid });
    return {
      messageKey: createHash('sha256').update(identity).digest('hex'),
      provider,
      messageId,
      folder,
      uidValidity,
      uid,
    };
  }

  if (!candidate.messageId) throw new Error('Provider cache references require messageId.');
  const messageId = requiredText(candidate.messageId, 'messageId');
  const folder = candidate.folder ? requiredText(candidate.folder, 'folder') : null;
  const identity = JSON.stringify({ provider, messageId });
  return {
    messageKey: createHash('sha256').update(identity).digest('hex'),
    provider,
    messageId,
    folder,
    uidValidity: null,
    uid: null,
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function miss<T>(enabled: boolean): EmailCacheReadResult<T> {
  return {
    state: 'miss',
    enabled,
    generation: null,
    fetchedAt: null,
    staleAt: null,
    expiresAt: null,
    value: null,
  };
}

function readMetadata(row: CacheRow, now: number): Omit<EmailCacheReadMetadata, 'enabled'> {
  const fetchedAt = numberOrNull(row.fetched_at);
  const staleAt = numberOrNull(row.stale_at);
  const expiresAt = numberOrNull(row.expires_at);
  return {
    state: staleAt !== null && staleAt <= now ? 'stale' : 'fresh',
    generation: numberOrNull(row.generation),
    fetchedAt,
    staleAt,
    expiresAt,
  };
}

function validateCacheWindow(now: number, freshForMs: number, retainForMs: number): void {
  nonNegativeInteger(now, 'now');
  nonNegativeInteger(freshForMs, 'freshForMs');
  positiveInteger(retainForMs, 'retainForMs');
  if (retainForMs < freshForMs) throw new Error('retainForMs must be at least freshForMs.');
}

function stringList(value: string[] | undefined): string[] | undefined {
  return value?.map((entry) => String(entry));
}

function normalizeCachedMessageMetadata(
  metadata: EmailCachedMessageMetadata,
): EmailCachedMessageMetadata {
  return {
    from: String(metadata.from),
    subject: String(metadata.subject),
    date: String(metadata.date),
    dateTimestamp: metadata.dateTimestamp === null ? null : Number(metadata.dateTimestamp),
    snippet: String(metadata.snippet),
    isRead: Boolean(metadata.isRead),
    isAnswered: Boolean(metadata.isAnswered),
    isFlagged: Boolean(metadata.isFlagged),
    hasAttachments: Boolean(metadata.hasAttachments),
    size: metadata.size === null ? null : Number(metadata.size),
    ...(metadata.to ? { to: stringList(metadata.to) } : {}),
    ...(metadata.cc ? { cc: stringList(metadata.cc) } : {}),
    ...(metadata.threadId !== undefined ? {
      threadId: metadata.threadId === null ? null : String(metadata.threadId),
    } : {}),
    ...(metadata.flags ? { flags: stringList(metadata.flags) } : {}),
  };
}

function normalizeCachedMessageDetail(detail: EmailCachedMessageDetail): EmailCachedMessageDetail {
  return {
    body: detail.body === null ? null : String(detail.body),
    bodyHtml: detail.bodyHtml === null ? null : String(detail.bodyHtml),
    to: stringList(detail.to) ?? [],
    cc: stringList(detail.cc) ?? [],
    ...(detail.bcc ? { bcc: stringList(detail.bcc) } : {}),
    ...(detail.replyTo ? { replyTo: stringList(detail.replyTo) } : {}),
    ...(detail.messageId !== undefined ? { messageId: String(detail.messageId) } : {}),
    ...(detail.inReplyTo !== undefined ? { inReplyTo: String(detail.inReplyTo) } : {}),
    ...(detail.references ? { references: stringList(detail.references) } : {}),
    ...(detail.headers ? {
      headers: Object.fromEntries(Object.entries(detail.headers).map(([name, value]) => [
        name,
        Array.isArray(value) ? value.map(String) : String(value),
      ])),
    } : {}),
    attachments: detail.attachments.map((attachment) => ({
      ...(attachment.id !== undefined ? { id: String(attachment.id) } : {}),
      ...(attachment.index !== undefined ? { index: Number(attachment.index) } : {}),
      ...(attachment.name !== undefined ? { name: String(attachment.name) } : {}),
      ...(attachment.filename !== undefined ? { filename: String(attachment.filename) } : {}),
      ...(attachment.mimeType !== undefined ? { mimeType: String(attachment.mimeType) } : {}),
      ...(attachment.contentType !== undefined ? { contentType: String(attachment.contentType) } : {}),
      size: attachment.size === null ? null : Number(attachment.size),
      ...(attachment.inline !== undefined ? { inline: Boolean(attachment.inline) } : {}),
      ...(attachment.contentId !== undefined ? {
        contentId: attachment.contentId === null ? null : String(attachment.contentId),
      } : {}),
    })),
  };
}

export class PostgresEmailCacheStore implements EmailCacheStore {
  readonly enabled = true;
  private nextCleanupAt = 0;
  private cleanupPromise: Promise<EmailCacheCleanupResult> | null = null;

  constructor(private readonly postgres: EmailCachePostgresQueryable) {}

  private async query<Row>(sql: string, values?: unknown[]): Promise<QueryResult<Row>> {
    return this.postgres.query(sql, values) as unknown as Promise<QueryResult<Row>>;
  }

  async getMailboxGeneration(input: MailboxInput & { now?: number }): Promise<number | null> {
    const mailbox = normalizeMailbox(input);
    const now = nonNegativeInteger(input.now ?? Date.now(), 'now');
    const result = await this.query<{ generation: number | string }>(`
      INSERT INTO email_cache_mailboxes (
        user_id, account_source, account_id, generation, last_accessed_at, created_at, updated_at
      ) VALUES ($1, $2, $3, 1, $4, $4, $4)
      ON CONFLICT (user_id, account_source, account_id) DO UPDATE
      SET last_accessed_at = EXCLUDED.last_accessed_at,
          updated_at = EXCLUDED.updated_at
      WHERE email_cache_mailboxes.active = true
      RETURNING generation
    `, [mailbox.userId, mailbox.accountSource, mailbox.accountId, now]);
    return numberOrNull(result.rows[0]?.generation);
  }

  async bumpMailboxGeneration(input: MailboxInput & { now?: number }): Promise<number | null> {
    const mailbox = normalizeMailbox(input);
    const now = nonNegativeInteger(input.now ?? Date.now(), 'now');
    const result = await this.query<{ generation: number | string }>(`
      INSERT INTO email_cache_mailboxes (
        user_id, account_source, account_id, generation, last_accessed_at, created_at, updated_at
      ) VALUES ($1, $2, $3, 1, $4, $4, $4)
      ON CONFLICT (user_id, account_source, account_id) DO UPDATE
      SET generation = email_cache_mailboxes.generation + 1,
          last_accessed_at = EXCLUDED.last_accessed_at,
          updated_at = EXCLUDED.updated_at
      WHERE email_cache_mailboxes.active = true
      RETURNING generation
    `, [mailbox.userId, mailbox.accountSource, mailbox.accountId, now]);
    return numberOrNull(result.rows[0]?.generation);
  }

  async reactivateAccount(input: MailboxInput & { now?: number }): Promise<number> {
    const mailbox = normalizeMailbox(input);
    const now = nonNegativeInteger(input.now ?? Date.now(), 'now');
    const result = await this.query<{ generation: number | string }>(`
      INSERT INTO email_cache_mailboxes (
        user_id, account_source, account_id, generation, active, disconnected_at,
        last_accessed_at, created_at, updated_at
      ) VALUES ($1, $2, $3, 1, true, NULL, $4, $4, $4)
      ON CONFLICT (user_id, account_source, account_id) DO UPDATE
      SET generation = email_cache_mailboxes.generation + 1,
          active = true,
          disconnected_at = NULL,
          last_accessed_at = EXCLUDED.last_accessed_at,
          updated_at = EXCLUDED.updated_at
      RETURNING generation
    `, [mailbox.userId, mailbox.accountSource, mailbox.accountId, now]);
    return Number(result.rows[0].generation);
  }

  async getList(
    input: EmailListCacheScopeInput & { now?: number },
  ): Promise<EmailCacheReadResult<EmailCachedListSnapshot>> {
    const scope = normalizeEmailListCacheScope(input);
    const now = nonNegativeInteger(input.now ?? Date.now(), 'now');
    const result = await this.query<CacheRow & {
      refs_json: NormalizedEmailMessageRef[];
      total_count: number | string | null;
    }>(`
      UPDATE email_cache_lists AS list
      SET last_accessed_at = $5,
          updated_at = $5
      FROM email_cache_mailboxes AS mailbox
      WHERE list.user_id = $1
        AND list.account_source = $2
        AND list.account_id = $3
        AND list.cache_key = $4
        AND mailbox.user_id = list.user_id
        AND mailbox.account_source = list.account_source
        AND mailbox.account_id = list.account_id
        AND mailbox.active = true
        AND mailbox.generation = list.generation
        AND list.refs_json IS NOT NULL
        AND list.expires_at > $5
      RETURNING list.generation, list.fetched_at, list.stale_at, list.expires_at,
        list.refs_json, list.total_count
    `, [scope.userId, scope.accountSource, scope.accountId, scope.cacheKey, now]);
    const row = result.rows[0];
    if (!row) return miss(true);
    return {
      enabled: true,
      ...readMetadata(row, now),
      value: {
        refs: row.refs_json,
        totalCount: numberOrNull(row.total_count),
      },
    };
  }

  async acquireListRefreshLease(
    input: EmailListCacheScopeInput & { owner: string; leaseMs: number; now?: number },
  ): Promise<EmailCacheLeaseResult> {
    const scope = normalizeEmailListCacheScope(input);
    const owner = requiredText(input.owner, 'owner');
    const now = nonNegativeInteger(input.now ?? Date.now(), 'now');
    const leaseUntil = now + positiveInteger(input.leaseMs, 'leaseMs');
    const result = await this.query<{
      generation: number | string;
      acquired: boolean;
      lease_until: number | string | null;
    }>(`
      WITH mailbox AS MATERIALIZED (
        INSERT INTO email_cache_mailboxes (
          user_id, account_source, account_id, generation, last_accessed_at, created_at, updated_at
        ) VALUES ($1, $2, $3, 1, $11, $11, $11)
        ON CONFLICT (user_id, account_source, account_id) DO UPDATE
        SET last_accessed_at = EXCLUDED.last_accessed_at,
            updated_at = EXCLUDED.updated_at
        WHERE email_cache_mailboxes.active = true
        RETURNING generation
      ), claimed AS (
        INSERT INTO email_cache_lists (
          user_id, account_source, account_id, cache_key, schema_version, folder, filter_json,
          search_query, page_offset, page_limit, generation, refresh_owner,
          refresh_lease_until, last_accessed_at, created_at, updated_at
        )
        SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10,
          mailbox.generation, $12, $13, $11, $11, $11
        FROM mailbox
        ON CONFLICT (user_id, account_source, account_id, cache_key) DO UPDATE
        SET refresh_owner = EXCLUDED.refresh_owner,
            refresh_lease_until = EXCLUDED.refresh_lease_until,
            last_accessed_at = EXCLUDED.last_accessed_at,
            updated_at = EXCLUDED.updated_at
        WHERE email_cache_lists.refresh_lease_until IS NULL
           OR email_cache_lists.refresh_lease_until <= $11
           OR email_cache_lists.refresh_owner = $12
        RETURNING refresh_lease_until
      )
      SELECT mailbox.generation,
        EXISTS(SELECT 1 FROM claimed) AS acquired,
        COALESCE(
          (SELECT refresh_lease_until FROM claimed),
          (SELECT refresh_lease_until
           FROM email_cache_lists
           WHERE user_id = $1 AND account_source = $2 AND account_id = $3 AND cache_key = $4)
        ) AS lease_until
      FROM mailbox
    `, [
      scope.userId,
      scope.accountSource,
      scope.accountId,
      scope.cacheKey,
      scope.schemaVersion,
      scope.folder,
      JSON.stringify(scope.filter),
      scope.query,
      scope.offset,
      scope.limit,
      now,
      owner,
      leaseUntil,
    ]);
    const row = result.rows[0];
    return {
      enabled: true,
      acquired: Boolean(row?.acquired),
      generation: numberOrNull(row?.generation),
      leaseUntil: numberOrNull(row?.lease_until),
    };
  }

  async putList(
    input: EmailListCacheScopeInput & {
      refs: EmailMessageRefInput[];
      totalCount?: number | null;
      expectedGeneration: number;
      leaseOwner?: string;
      freshForMs?: number;
      retainForMs?: number;
      now?: number;
    },
  ): Promise<EmailCacheWriteResult> {
    const scope = normalizeEmailListCacheScope(input);
    const refs = input.refs.map(normalizeEmailMessageRef);
    const expectedGeneration = positiveInteger(input.expectedGeneration, 'expectedGeneration');
    const leaseOwner = input.leaseOwner ? requiredText(input.leaseOwner, 'leaseOwner') : null;
    const now = nonNegativeInteger(input.now ?? Date.now(), 'now');
    const freshForMs = input.freshForMs ?? DEFAULT_EMAIL_CACHE_FRESH_MS;
    const retainForMs = input.retainForMs ?? DEFAULT_EMAIL_CACHE_RETENTION_MS;
    validateCacheWindow(now, freshForMs, retainForMs);
    const staleAt = now + freshForMs;
    const expiresAt = now + retainForMs;
    const totalCount = input.totalCount === null || input.totalCount === undefined
      ? null
      : nonNegativeInteger(input.totalCount, 'totalCount');
    const result = await this.query<{ cache_key: string }>(`
      WITH mailbox AS MATERIALIZED (
        INSERT INTO email_cache_mailboxes (
          user_id, account_source, account_id, generation, last_accessed_at, created_at, updated_at
        ) VALUES ($1, $2, $3, 1, $15, $15, $15)
        ON CONFLICT (user_id, account_source, account_id) DO UPDATE
        SET last_accessed_at = EXCLUDED.last_accessed_at,
            updated_at = EXCLUDED.updated_at
        WHERE email_cache_mailboxes.active = true
        RETURNING generation
      )
      INSERT INTO email_cache_lists (
        user_id, account_source, account_id, cache_key, schema_version, folder, filter_json,
        search_query, page_offset, page_limit, refs_json, total_count, generation,
        fetched_at, stale_at, expires_at, refresh_owner, refresh_lease_until,
        last_accessed_at, created_at, updated_at
      )
      SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb, $12,
        $13, $15, $16, $17, NULL, NULL, $15, $15, $15
      FROM mailbox
      WHERE mailbox.generation = $13
      ON CONFLICT (user_id, account_source, account_id, cache_key) DO UPDATE
      SET schema_version = EXCLUDED.schema_version,
          folder = EXCLUDED.folder,
          filter_json = EXCLUDED.filter_json,
          search_query = EXCLUDED.search_query,
          page_offset = EXCLUDED.page_offset,
          page_limit = EXCLUDED.page_limit,
          refs_json = EXCLUDED.refs_json,
          total_count = EXCLUDED.total_count,
          generation = EXCLUDED.generation,
          fetched_at = EXCLUDED.fetched_at,
          stale_at = EXCLUDED.stale_at,
          expires_at = EXCLUDED.expires_at,
          refresh_owner = NULL,
          refresh_lease_until = NULL,
          last_accessed_at = EXCLUDED.last_accessed_at,
          updated_at = EXCLUDED.updated_at
      WHERE ($14::text IS NULL OR email_cache_lists.refresh_owner = $14)
      RETURNING cache_key
    `, [
      scope.userId,
      scope.accountSource,
      scope.accountId,
      scope.cacheKey,
      scope.schemaVersion,
      scope.folder,
      JSON.stringify(scope.filter),
      scope.query,
      scope.offset,
      scope.limit,
      JSON.stringify(refs),
      totalCount,
      expectedGeneration,
      leaseOwner,
      now,
      staleAt,
      expiresAt,
    ]);
    return result.rows.length
      ? { enabled: true, stored: true, reason: 'stored' }
      : { enabled: true, stored: false, reason: 'generation_changed_or_lease_lost' };
  }

  async releaseListRefreshLease(
    input: EmailListCacheScopeInput & { owner: string; now?: number },
  ): Promise<boolean> {
    const scope = normalizeEmailListCacheScope(input);
    const owner = requiredText(input.owner, 'owner');
    const now = nonNegativeInteger(input.now ?? Date.now(), 'now');
    const result = await this.query(`
      UPDATE email_cache_lists
      SET refresh_owner = NULL,
          refresh_lease_until = NULL,
          updated_at = $6
      WHERE user_id = $1 AND account_source = $2 AND account_id = $3
        AND cache_key = $4 AND refresh_owner = $5
      RETURNING 1
    `, [scope.userId, scope.accountSource, scope.accountId, scope.cacheKey, owner, now]);
    return result.rows.length > 0;
  }

  async getMessage(
    input: MailboxInput & { ref: EmailMessageRefInput; part?: 'metadata' | 'detail'; now?: number },
  ): Promise<EmailCacheReadResult<EmailCachedMessage>> {
    const ref = normalizeEmailMessageRef(input.ref);
    const messages = await this.getMessages({
      ...input,
      refs: [input.ref],
    });
    return messages.find((message) => message.messageKey === ref.messageKey) ?? miss(true);
  }

  async getMessages(
    input: MailboxInput & { refs: EmailMessageRefInput[]; part?: 'metadata' | 'detail'; now?: number },
  ): Promise<EmailCacheBatchMessageResult[]> {
    if (input.refs.length === 0) return [];
    const mailbox = normalizeMailbox(input);
    const refs = input.refs.map(normalizeEmailMessageRef);
    const messageKeys = [...new Set(refs.map((ref) => ref.messageKey))];
    const part = input.part ?? 'detail';
    const now = nonNegativeInteger(input.now ?? Date.now(), 'now');
    const payloadColumn = part === 'detail' ? 'detail_json' : 'metadata_json';
    const fetchedColumn = part === 'detail' ? 'detail_fetched_at' : 'metadata_fetched_at';
    const staleColumn = part === 'detail' ? 'detail_stale_at' : 'metadata_stale_at';
    const result = await this.query<CacheRow & {
      message_key: string;
      provider: string;
      provider_message_id: string | null;
      folder: string | null;
      uid_validity: string | null;
      uid: number | string | null;
      metadata_json: EmailCachedMessageMetadata | null;
      detail_json: EmailCachedMessageDetail | null;
    }>(`
      UPDATE email_cache_messages AS message
      SET last_accessed_at = $5,
          updated_at = $5
      FROM email_cache_mailboxes AS mailbox
      WHERE message.user_id = $1
        AND message.account_source = $2
        AND message.account_id = $3
        AND message.message_key = ANY($4::text[])
        AND mailbox.user_id = message.user_id
        AND mailbox.account_source = message.account_source
        AND mailbox.account_id = message.account_id
        AND mailbox.active = true
        AND mailbox.generation = message.generation
        AND message.${payloadColumn} IS NOT NULL
        AND message.expires_at > $5
      RETURNING message.message_key, message.generation, message.${fetchedColumn} AS fetched_at,
        message.${staleColumn} AS stale_at, message.expires_at,
        message.provider, message.provider_message_id, message.folder,
        message.uid_validity, message.uid, message.metadata_json, message.detail_json
    `, [mailbox.userId, mailbox.accountSource, mailbox.accountId, messageKeys, now]);
    return result.rows.map((row) => ({
      messageKey: row.message_key,
      enabled: true,
      ...readMetadata(row, now),
      value: {
        ref: {
          messageKey: row.message_key,
          provider: row.provider,
          messageId: row.provider_message_id,
          folder: row.folder,
          uidValidity: row.uid_validity,
          uid: numberOrNull(row.uid),
        },
        metadata: row.metadata_json,
        detail: row.detail_json,
      },
    }));
  }

  async acquireMessageRefreshLease(
    input: MailboxInput & { ref: EmailMessageRefInput; owner: string; leaseMs: number; now?: number },
  ): Promise<EmailCacheLeaseResult> {
    const mailbox = normalizeMailbox(input);
    const ref = normalizeEmailMessageRef(input.ref);
    const owner = requiredText(input.owner, 'owner');
    const now = nonNegativeInteger(input.now ?? Date.now(), 'now');
    const leaseUntil = now + positiveInteger(input.leaseMs, 'leaseMs');
    const result = await this.query<{
      generation: number | string;
      acquired: boolean;
      lease_until: number | string | null;
    }>(`
      WITH mailbox AS MATERIALIZED (
        INSERT INTO email_cache_mailboxes (
          user_id, account_source, account_id, generation, last_accessed_at, created_at, updated_at
        ) VALUES ($1, $2, $3, 1, $10, $10, $10)
        ON CONFLICT (user_id, account_source, account_id) DO UPDATE
        SET last_accessed_at = EXCLUDED.last_accessed_at,
            updated_at = EXCLUDED.updated_at
        WHERE email_cache_mailboxes.active = true
        RETURNING generation
      ), claimed AS (
        INSERT INTO email_cache_messages (
          user_id, account_source, account_id, message_key, provider, provider_message_id, folder,
          uid_validity, uid, generation, refresh_owner, refresh_lease_until,
          last_accessed_at, created_at, updated_at
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, mailbox.generation,
          $11, $12, $10, $10, $10
        FROM mailbox
        ON CONFLICT (user_id, account_source, account_id, message_key) DO UPDATE
        SET refresh_owner = EXCLUDED.refresh_owner,
            refresh_lease_until = EXCLUDED.refresh_lease_until,
            last_accessed_at = EXCLUDED.last_accessed_at,
            updated_at = EXCLUDED.updated_at
        WHERE email_cache_messages.refresh_lease_until IS NULL
           OR email_cache_messages.refresh_lease_until <= $10
           OR email_cache_messages.refresh_owner = $11
        RETURNING refresh_lease_until
      )
      SELECT mailbox.generation,
        EXISTS(SELECT 1 FROM claimed) AS acquired,
        COALESCE(
          (SELECT refresh_lease_until FROM claimed),
          (SELECT refresh_lease_until
           FROM email_cache_messages
           WHERE user_id = $1 AND account_source = $2 AND account_id = $3 AND message_key = $4)
        ) AS lease_until
      FROM mailbox
    `, [
      mailbox.userId,
      mailbox.accountSource,
      mailbox.accountId,
      ref.messageKey,
      ref.provider,
      ref.messageId,
      ref.folder,
      ref.uidValidity,
      ref.uid,
      now,
      owner,
      leaseUntil,
    ]);
    const row = result.rows[0];
    return {
      enabled: true,
      acquired: Boolean(row?.acquired),
      generation: numberOrNull(row?.generation),
      leaseUntil: numberOrNull(row?.lease_until),
    };
  }

  async putMessage(
    input: MailboxInput & {
      ref: EmailMessageRefInput;
      metadata?: EmailCachedMessageMetadata;
      detail?: EmailCachedMessageDetail;
      expectedGeneration: number;
      leaseOwner?: string;
      freshForMs?: number;
      retainForMs?: number;
      now?: number;
    },
  ): Promise<EmailCacheWriteResult> {
    const result = await this.putMessages({
      userId: input.userId,
      accountId: input.accountId,
      accountSource: input.accountSource,
      messages: [{
        ref: input.ref,
        metadata: input.metadata,
        detail: input.detail,
        leaseOwner: input.leaseOwner,
      }],
      expectedGeneration: input.expectedGeneration,
      freshForMs: input.freshForMs,
      retainForMs: input.retainForMs,
      now: input.now,
    });
    return result.storedCount === 1
      ? { enabled: true, stored: true, reason: 'stored' }
      : { enabled: true, stored: false, reason: 'generation_changed_or_lease_lost' };
  }

  async putMessages(
    input: MailboxInput & {
      messages: EmailCacheMessageWriteEntry[];
      expectedGeneration: number;
      freshForMs?: number;
      retainForMs?: number;
      now?: number;
    },
  ): Promise<EmailCacheBatchWriteResult> {
    if (input.messages.length > 50) {
      throw new Error('putMessages accepts at most 50 messages.');
    }
    const mailbox = normalizeMailbox(input);
    const expectedGeneration = positiveInteger(input.expectedGeneration, 'expectedGeneration');
    const now = nonNegativeInteger(input.now ?? Date.now(), 'now');
    const freshForMs = input.freshForMs ?? DEFAULT_EMAIL_CACHE_FRESH_MS;
    const retainForMs = input.retainForMs ?? DEFAULT_EMAIL_MESSAGE_RETENTION_MS;
    validateCacheWindow(now, freshForMs, retainForMs);

    const normalizedByKey = new Map<string, {
      message_key: string;
      provider: string;
      provider_message_id: string | null;
      folder: string | null;
      uid_validity: string | null;
      uid: number | null;
      sender: string | null;
      subject: string | null;
      message_date: number | null;
      preview: string | null;
      is_read: boolean | null;
      metadata_json: EmailCachedMessageMetadata | null;
      detail_json: EmailCachedMessageDetail | null;
      lease_owner: string | null;
    }>();
    for (const message of input.messages) {
      if (!message.metadata && !message.detail) {
        throw new Error('Every putMessages entry requires metadata, detail, or both.');
      }
      const ref = normalizeEmailMessageRef(message.ref);
      const metadata = message.metadata ? normalizeCachedMessageMetadata(message.metadata) : null;
      const detail = message.detail ? normalizeCachedMessageDetail(message.detail) : null;
      normalizedByKey.set(ref.messageKey, {
        message_key: ref.messageKey,
        provider: ref.provider,
        provider_message_id: ref.messageId,
        folder: ref.folder,
        uid_validity: ref.uidValidity,
        uid: ref.uid,
        sender: metadata?.from ?? null,
        subject: metadata?.subject ?? null,
        message_date: metadata?.dateTimestamp ?? null,
        preview: metadata?.snippet ?? null,
        is_read: metadata?.isRead ?? null,
        metadata_json: metadata,
        detail_json: detail,
        lease_owner: message.leaseOwner ? requiredText(message.leaseOwner, 'leaseOwner') : null,
      });
    }
    const normalizedMessages = [...normalizedByKey.values()];
    const requestedKeys = normalizedMessages.map((message) => message.message_key);
    if (normalizedMessages.length === 0) {
      return {
        enabled: true,
        requestedCount: 0,
        storedCount: 0,
        storedMessageKeys: [],
        rejectedMessageKeys: [],
        reason: 'stored',
      };
    }

    const staleAt = now + freshForMs;
    const expiresAt = now + retainForMs;
    const result = await this.query<{
      generation: number | string | null;
      stored_message_keys: string[];
    }>(`
      WITH mailbox AS MATERIALIZED (
        INSERT INTO email_cache_mailboxes (
          user_id, account_source, account_id, generation, last_accessed_at, created_at, updated_at
        ) VALUES ($1, $2, $3, 1, $6, $6, $6)
        ON CONFLICT (user_id, account_source, account_id) DO UPDATE
        SET last_accessed_at = EXCLUDED.last_accessed_at,
            updated_at = EXCLUDED.updated_at
        WHERE email_cache_mailboxes.active = true
        RETURNING generation
      ), payload AS MATERIALIZED (
        SELECT *
        FROM jsonb_to_recordset($5::jsonb) AS item (
          message_key text,
          provider text,
          provider_message_id text,
          folder text,
          uid_validity text,
          uid bigint,
          sender text,
          subject text,
          message_date bigint,
          preview text,
          is_read boolean,
          metadata_json jsonb,
          detail_json jsonb,
          lease_owner text
        )
      ), updated AS (
        UPDATE email_cache_messages AS target
        SET provider = payload.provider,
            provider_message_id = payload.provider_message_id,
            folder = payload.folder,
            uid_validity = payload.uid_validity,
            uid = payload.uid,
            sender = CASE
              WHEN payload.metadata_json IS NOT NULL THEN payload.sender
              WHEN target.generation = $4 THEN target.sender
              ELSE NULL
            END,
            subject = CASE
              WHEN payload.metadata_json IS NOT NULL THEN payload.subject
              WHEN target.generation = $4 THEN target.subject
              ELSE NULL
            END,
            message_date = CASE
              WHEN payload.metadata_json IS NOT NULL THEN payload.message_date
              WHEN target.generation = $4 THEN target.message_date
              ELSE NULL
            END,
            preview = CASE
              WHEN payload.metadata_json IS NOT NULL THEN payload.preview
              WHEN target.generation = $4 THEN target.preview
              ELSE NULL
            END,
            is_read = CASE
              WHEN payload.metadata_json IS NOT NULL THEN payload.is_read
              WHEN target.generation = $4 THEN target.is_read
              ELSE NULL
            END,
            metadata_json = CASE
              WHEN payload.metadata_json IS NOT NULL THEN payload.metadata_json
              WHEN target.generation = $4 THEN target.metadata_json
              ELSE NULL
            END,
            detail_json = CASE
              WHEN payload.detail_json IS NOT NULL THEN payload.detail_json
              WHEN target.generation = $4 THEN target.detail_json
              ELSE NULL
            END,
            generation = $4,
            metadata_fetched_at = CASE
              WHEN payload.metadata_json IS NOT NULL THEN $6
              WHEN target.generation = $4 THEN target.metadata_fetched_at
              ELSE NULL
            END,
            metadata_stale_at = CASE
              WHEN payload.metadata_json IS NOT NULL THEN $7
              WHEN target.generation = $4 THEN target.metadata_stale_at
              ELSE NULL
            END,
            detail_fetched_at = CASE
              WHEN payload.detail_json IS NOT NULL THEN $6
              WHEN target.generation = $4 THEN target.detail_fetched_at
              ELSE NULL
            END,
            detail_stale_at = CASE
              WHEN payload.detail_json IS NOT NULL THEN $7
              WHEN target.generation = $4 THEN target.detail_stale_at
              ELSE NULL
            END,
            expires_at = CASE
              WHEN target.generation = $4 THEN GREATEST(target.expires_at, $8)
              ELSE $8
            END,
            refresh_owner = CASE
              WHEN payload.lease_owner IS NOT NULL THEN NULL
              ELSE target.refresh_owner
            END,
            refresh_lease_until = CASE
              WHEN payload.lease_owner IS NOT NULL THEN NULL
              ELSE target.refresh_lease_until
            END,
            last_accessed_at = $6,
            updated_at = $6
        FROM payload, mailbox
        WHERE target.user_id = $1
          AND target.account_source = $2
          AND target.account_id = $3
          AND target.message_key = payload.message_key
          AND mailbox.generation = $4
          AND (
            (payload.lease_owner IS NOT NULL AND target.refresh_owner = payload.lease_owner)
            OR
            (payload.lease_owner IS NULL AND (
              payload.detail_json IS NULL
              OR target.refresh_lease_until IS NULL
              OR target.refresh_lease_until <= $6
            ))
          )
        RETURNING target.message_key
      ), inserted AS (
        INSERT INTO email_cache_messages (
        user_id, account_source, account_id, message_key, provider, provider_message_id, folder,
        uid_validity, uid, sender, subject, message_date, preview, is_read,
        metadata_json, detail_json, generation, metadata_fetched_at,
        metadata_stale_at, detail_fetched_at, detail_stale_at, expires_at,
        refresh_owner, refresh_lease_until, last_accessed_at, created_at, updated_at
      )
        SELECT $1, $2, $3, payload.message_key, payload.provider,
          payload.provider_message_id, payload.folder, payload.uid_validity, payload.uid,
          payload.sender, payload.subject, payload.message_date, payload.preview, payload.is_read,
          payload.metadata_json, payload.detail_json, $4,
          CASE WHEN payload.metadata_json IS NULL THEN NULL ELSE $6 END,
          CASE WHEN payload.metadata_json IS NULL THEN NULL ELSE $7 END,
          CASE WHEN payload.detail_json IS NULL THEN NULL ELSE $6 END,
          CASE WHEN payload.detail_json IS NULL THEN NULL ELSE $7 END,
          $8, NULL, NULL, $6, $6, $6
        FROM payload, mailbox
        WHERE mailbox.generation = $4
          AND NOT EXISTS (
            SELECT 1
            FROM email_cache_messages AS existing
            WHERE existing.user_id = $1
              AND existing.account_source = $2
              AND existing.account_id = $3
              AND existing.message_key = payload.message_key
          )
        ON CONFLICT (user_id, account_source, account_id, message_key) DO NOTHING
        RETURNING message_key
      ), stored AS (
        SELECT message_key FROM updated
        UNION ALL
        SELECT message_key FROM inserted
      )
      SELECT mailbox.generation,
        COALESCE((SELECT jsonb_agg(message_key ORDER BY message_key) FROM stored), '[]'::jsonb)
          AS stored_message_keys
      FROM (VALUES (1)) AS seed(value)
      LEFT JOIN mailbox ON true
    `, [
      mailbox.userId,
      mailbox.accountSource,
      mailbox.accountId,
      expectedGeneration,
      JSON.stringify(normalizedMessages),
      now,
      staleAt,
      expiresAt,
    ]);
    const row = result.rows[0];
    const storedMessageKeys = Array.isArray(row?.stored_message_keys)
      ? row.stored_message_keys.map(String)
      : [];
    const storedKeySet = new Set(storedMessageKeys);
    const rejectedMessageKeys = requestedKeys.filter((key) => !storedKeySet.has(key));
    const generationMatches = numberOrNull(row?.generation) === expectedGeneration;
    return {
      enabled: true,
      requestedCount: requestedKeys.length,
      storedCount: storedMessageKeys.length,
      storedMessageKeys,
      rejectedMessageKeys,
      reason: !generationMatches
        ? 'generation_changed_or_tombstoned'
        : rejectedMessageKeys.length > 0 ? 'partial' : 'stored',
    };
  }

  async releaseMessageRefreshLease(
    input: MailboxInput & { ref: EmailMessageRefInput; owner: string; now?: number },
  ): Promise<boolean> {
    const mailbox = normalizeMailbox(input);
    const ref = normalizeEmailMessageRef(input.ref);
    const owner = requiredText(input.owner, 'owner');
    const now = nonNegativeInteger(input.now ?? Date.now(), 'now');
    const result = await this.query(`
      UPDATE email_cache_messages
      SET refresh_owner = NULL,
          refresh_lease_until = NULL,
          updated_at = $6
      WHERE user_id = $1 AND account_source = $2 AND account_id = $3
        AND message_key = $4 AND refresh_owner = $5
      RETURNING 1
    `, [mailbox.userId, mailbox.accountSource, mailbox.accountId, ref.messageKey, owner, now]);
    return result.rows.length > 0;
  }

  async purgeAccount(input: MailboxInput & { now?: number }): Promise<EmailCachePurgeResult> {
    const mailbox = normalizeMailbox(input);
    const now = nonNegativeInteger(input.now ?? Date.now(), 'now');
    const result = await this.query<{
      generation: number | string;
      deleted_lists: number | string;
      deleted_messages: number | string;
    }>(`
      WITH tombstone AS MATERIALIZED (
        INSERT INTO email_cache_mailboxes (
          user_id, account_source, account_id, generation, active, disconnected_at,
          last_accessed_at, created_at, updated_at
        ) VALUES ($1, $2, $3, 1, false, $4, $4, $4, $4)
        ON CONFLICT (user_id, account_source, account_id) DO UPDATE
        SET generation = email_cache_mailboxes.generation + 1,
            active = false,
            disconnected_at = $4,
            last_accessed_at = $4,
            updated_at = $4
        RETURNING generation
      ), deleted_lists AS (
        DELETE FROM email_cache_lists AS list
        USING tombstone
        WHERE list.user_id = $1
          AND list.account_source = $2
          AND list.account_id = $3
        RETURNING 1
      ), deleted_messages AS (
        DELETE FROM email_cache_messages AS message
        USING tombstone
        WHERE message.user_id = $1
          AND message.account_source = $2
          AND message.account_id = $3
        RETURNING 1
      )
      SELECT tombstone.generation,
        (SELECT COUNT(*) FROM deleted_lists) AS deleted_lists,
        (SELECT COUNT(*) FROM deleted_messages) AS deleted_messages
      FROM tombstone
    `, [mailbox.userId, mailbox.accountSource, mailbox.accountId, now]);
    const row = result.rows[0];
    return {
      enabled: true,
      tombstoned: Boolean(row),
      generation: numberOrNull(row?.generation),
      deletedLists: numberOrNull(row?.deleted_lists) ?? 0,
      deletedMessages: numberOrNull(row?.deleted_messages) ?? 0,
    };
  }

  async cleanup(input: {
    now?: number;
    maxListsPerAccount?: number;
    maxMessagesPerAccount?: number;
    maxDeletesPerTable?: number;
  } = {}): Promise<EmailCacheCleanupResult> {
    const now = nonNegativeInteger(input.now ?? Date.now(), 'now');
    const maxLists = positiveInteger(input.maxListsPerAccount ?? 100, 'maxListsPerAccount');
    const maxMessages = positiveInteger(input.maxMessagesPerAccount ?? 500, 'maxMessagesPerAccount');
    const maxDeletes = positiveInteger(input.maxDeletesPerTable ?? 100, 'maxDeletesPerTable');
    const listResult = await this.query(`
      WITH ranked AS (
        SELECT list.user_id, list.account_source, list.account_id, list.cache_key,
          ROW_NUMBER() OVER (
            PARTITION BY list.user_id, list.account_source, list.account_id
            ORDER BY list.last_accessed_at DESC, list.cache_key
          ) AS lru_rank,
          mailbox.generation AS current_generation
        FROM email_cache_lists AS list
        JOIN email_cache_mailboxes AS mailbox
          ON mailbox.user_id = list.user_id
         AND mailbox.account_source = list.account_source
         AND mailbox.account_id = list.account_id
      ), victims AS (
        SELECT list.user_id, list.account_source, list.account_id, list.cache_key
        FROM email_cache_lists AS list
        JOIN ranked USING (user_id, account_source, account_id, cache_key)
        WHERE (list.expires_at IS NOT NULL AND list.expires_at <= $1)
           OR list.generation <> ranked.current_generation
           OR ranked.lru_rank > $2
        ORDER BY list.last_accessed_at ASC
        LIMIT $3
      )
      DELETE FROM email_cache_lists AS list
      USING victims
      WHERE list.user_id = victims.user_id
        AND list.account_source = victims.account_source
        AND list.account_id = victims.account_id
        AND list.cache_key = victims.cache_key
      RETURNING 1
    `, [now, maxLists, maxDeletes]);
    const messageResult = await this.query(`
      WITH ranked AS (
        SELECT message.user_id, message.account_source, message.account_id, message.message_key,
          ROW_NUMBER() OVER (
            PARTITION BY message.user_id, message.account_source, message.account_id
            ORDER BY message.last_accessed_at DESC, message.message_key
          ) AS lru_rank,
          mailbox.generation AS current_generation
        FROM email_cache_messages AS message
        JOIN email_cache_mailboxes AS mailbox
          ON mailbox.user_id = message.user_id
         AND mailbox.account_source = message.account_source
         AND mailbox.account_id = message.account_id
      ), victims AS (
        SELECT message.user_id, message.account_source, message.account_id, message.message_key
        FROM email_cache_messages AS message
        JOIN ranked USING (user_id, account_source, account_id, message_key)
        WHERE (message.expires_at IS NOT NULL AND message.expires_at <= $1)
           OR message.generation <> ranked.current_generation
           OR ranked.lru_rank > $2
        ORDER BY message.last_accessed_at ASC
        LIMIT $3
      )
      DELETE FROM email_cache_messages AS message
      USING victims
      WHERE message.user_id = victims.user_id
        AND message.account_source = victims.account_source
        AND message.account_id = victims.account_id
        AND message.message_key = victims.message_key
      RETURNING 1
    `, [now, maxMessages, maxDeletes]);
    return {
      enabled: true,
      skipped: false,
      deletedLists: listResult.rows.length,
      deletedMessages: messageResult.rows.length,
    };
  }

  async maybeCleanup(input: {
    now?: number;
    intervalMs?: number;
    maxListsPerAccount?: number;
    maxMessagesPerAccount?: number;
    maxDeletesPerTable?: number;
  } = {}): Promise<EmailCacheCleanupResult> {
    const now = nonNegativeInteger(input.now ?? Date.now(), 'now');
    const intervalMs = positiveInteger(
      input.intervalMs ?? DEFAULT_EMAIL_CACHE_CLEANUP_INTERVAL_MS,
      'intervalMs',
    );
    if (now < this.nextCleanupAt) {
      return { enabled: true, skipped: true, deletedLists: 0, deletedMessages: 0 };
    }
    if (this.cleanupPromise) return this.cleanupPromise;
    this.nextCleanupAt = now + intervalMs;
    this.cleanupPromise = this.cleanup(input).finally(() => {
      this.cleanupPromise = null;
    });
    return this.cleanupPromise;
  }
}

export function createEmailCacheStore(options: {
  postgres: EmailCachePostgresQueryable;
}): PostgresEmailCacheStore {
  if (!options?.postgres) {
    throw new Error('PostgreSQL email caching requires an explicit PostgreSQL queryable.');
  }
  return new PostgresEmailCacheStore(options.postgres);
}

let runtimeEmailCacheStorePromise: Promise<PostgresEmailCacheStore> | null = null;

/**
 * Lazily binds the cache to the application's existing PostgreSQL pool.
 * Runtime initialization failures reject instead of silently disabling caching,
 * while concurrent first callers share one store.
 */
export function getRuntimeEmailCacheStore(): Promise<PostgresEmailCacheStore> {
  if (!runtimeEmailCacheStorePromise) {
    runtimeEmailCacheStorePromise = import('@/app/lib/db').then((database) => {
      database.assertDatabaseAvailable();
      const postgres = database.getPostgresRuntimeQueryable();
      if (!postgres) throw new Error('PostgreSQL runtime pool is not initialized.');
      return new PostgresEmailCacheStore(postgres);
    }).catch((error) => {
      runtimeEmailCacheStorePromise = null;
      throw error;
    });
  }
  return runtimeEmailCacheStorePromise;
}

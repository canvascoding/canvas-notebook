import type { EmailClassificationOverride, EmailClassificationRaw, EmailReplyStatus } from './types';
import type { EmailMailboxSyncErrorCode } from './sync-errors';

export interface EmailClassificationQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

/** The callback must run on one owned connection, never the pool's query method. */
export type EmailClassificationTransaction = <T>(operation: (connection: EmailClassificationQueryable) => Promise<T>) => Promise<T>;

export type EmailAccountSource = 'local' | 'managed';

export interface EmailClassificationMailboxInput {
  mailboxRef: string;
  ownerUserId: string;
  accountSource: EmailAccountSource;
  accountId: string;
  provider: string;
  workspaceId: string | null;
  mailboxId: string | null;
  bindingRevision: string;
  connectionRevision?: string;
  policyRevision: string;
  active: boolean;
  readFrom: string[];
}

export interface StoredEmailClassificationMailbox extends EmailClassificationMailboxInput {
  connectionRevision: string;
  indexRevision: number;
  lastSyncAt: number | null;
  lastSyncErrorCode: EmailMailboxSyncErrorCode | null;
  syncCursor: string | null;
  coverage: 'pending' | 'partial' | 'complete' | 'failed';
  createdAt: number;
  updatedAt: number;
}

/** Whitelisted list data only. Body, bodyHtml and attachment contents are absent. */
export interface EmailIndexedMessageList {
  from: string;
  subject: string;
  date: string;
  snippet: string;
  to?: string[];
  cc?: string[];
  isRead?: boolean;
  isFlagged?: boolean;
  hasAttachments?: boolean;
  threadId?: string | null;
}

export interface EmailClassificationMetadataInput {
  messageRef: string;
  mailboxRef: string;
  canonicalId: string;
  folder: string;
  dateTimestamp: number | null;
  replyStatus: EmailReplyStatus;
  inInbox?: boolean;
  lastSeenInboxAt?: number;
  fingerprint: string;
  list: EmailIndexedMessageList;
}

export interface StoredEmailClassificationMetadata extends EmailClassificationMetadataInput {
  inInbox: boolean;
  lastSeenInboxAt: number;
  mailbox: StoredEmailClassificationMailbox;
  indexRevision: number;
  createdAt: number;
  updatedAt: number;
}

export type EmailClassificationJobStatus = 'pending' | 'processing' | 'retry' | 'completed' | 'failed' | 'canceled';

export interface StoredEmailClassificationJob {
  id: string;
  decisionRequestId?: string | null;
  messageRef: string;
  mailboxRef: string;
  configurationRevision: number;
  fingerprint: string;
  bindingRevision: string;
  policyRevision: string;
  status: EmailClassificationJobStatus;
  attempts: number;
  nextAttemptAt: number;
  leaseUntil: number | null;
  claimToken: string | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StoredEmailClassificationResult {
  messageRef: string;
  raw: EmailClassificationRaw | null;
  configurationRevision: number | null;
  evaluationFingerprint: string | null;
  fingerprint: string | null;
  bindingRevision: string | null;
  policyRevision: string | null;
  resultRevision: number;
  overrides: EmailClassificationOverride;
  version: number;
  updatedAt: number;
}

export interface StoredEmailPersonalFocusState {
  userId: string;
  messageRef: string;
  done: boolean;
  version: number;
  updatedAt: number | null;
}

export class EmailClassificationVersionConflictError extends Error {
  readonly code = 'EMAIL_CLASSIFICATION_VERSION_CONFLICT';
  readonly status = 409;
  constructor() { super('Email settings or state changed. Reload before saving.'); this.name = 'EmailClassificationVersionConflictError'; }
}

export class EmailClassificationStoreStateError extends Error {
  readonly code = 'EMAIL_CLASSIFICATION_STATE_UNAVAILABLE';
  readonly status = 409;
  constructor(message = 'This indexed email or mailbox is no longer available.') { super(message); this.name = 'EmailClassificationStoreStateError'; }
}

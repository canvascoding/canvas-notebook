import 'server-only';
import { hasManagedSystemUpdateIntent } from '@/app/lib/managed/control-plane-url-policy';

import { randomUUID } from 'node:crypto';
import { validateEmailClassificationOverride } from './policy';
import {
  DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, type EmailClassificationConfiguration, type EmailClassificationSettings,
} from './settings-types';
import { resetChangedEmailSpamValidation, validateEmailClassificationConfiguration } from './settings-validation';
import { emailClassificationEvaluationFingerprint } from './settings-evaluation';
import { emailClassificationSelectionSql, isEmailSelectedForClassification } from './selection';
import { EMAIL_CATEGORY_IDS, EMAIL_PRIORITIES, type EmailClassificationRaw, type EmailClassificationOverride } from './types';
import { isEmailMailboxSyncErrorCode, type EmailMailboxSyncErrorCode } from './sync-errors';
import {
  EmailClassificationStoreStateError, EmailClassificationVersionConflictError,
  type EmailClassificationQueryable, type EmailClassificationTransaction,
  type EmailClassificationMailboxInput, type StoredEmailClassificationMailbox,
  type EmailIndexedMessageList, type EmailClassificationMetadataInput, type StoredEmailClassificationMetadata,
  type StoredEmailClassificationJob, type EmailClassificationJobStatus, type StoredEmailClassificationResult, type StoredEmailPersonalFocusState,
} from './store-types';

type Row = Record<string, unknown>;

function integer(value: unknown, name: string, minimum = 0): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`Invalid ${name}.`);
  return number;
}

function text(value: unknown, name: string, maximum = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000\r\n]/u.test(value)) throw new Error(`Invalid ${name}.`);
  return value.trim();
}

function nullableText(value: string | null, name: string): string | null {
  return value === null ? null : text(value, name);
}

function object<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function defaults(): EmailClassificationSettings {
  const configuration: EmailClassificationConfiguration = structuredClone(DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION);
  if (hasManagedSystemUpdateIntent(process.env) && process.env.CANVAS_INSTANCE_TOKEN?.trim()) configuration.executionMode = 'managed';
  return { revision: 0, configuration, updatedAt: null, updatedByUserId: null };
}

function settingsFromRow(row?: Row): EmailClassificationSettings {
  return row ? {
    revision: integer(row.revision, 'settings revision', 1),
    configuration: validateEmailClassificationConfiguration(object(row.configuration_json)),
    updatedAt: integer(row.updated_at, 'settings time'), updatedByUserId: row.updated_by_user_id as string | null,
  } : defaults();
}

function mailboxFromRow(row: Row): StoredEmailClassificationMailbox {
  return {
    mailboxRef: String(row.mailbox_ref), ownerUserId: String(row.owner_user_id),
    accountSource: row.account_source as StoredEmailClassificationMailbox['accountSource'], accountId: String(row.account_id), provider: String(row.provider),
    workspaceId: row.workspace_id as string | null, mailboxId: row.mailbox_id as string | null,
    bindingRevision: String(row.binding_revision), policyRevision: String(row.policy_revision), connectionRevision: String(row.connection_revision),
    active: row.active === true, readFrom: object<string[]>(row.read_from_json), indexRevision: integer(row.index_revision, 'mailbox index revision', 1),
    lastSyncAt: row.last_sync_at === null ? null : integer(row.last_sync_at, 'sync time'), syncCursor: row.sync_cursor as string | null,
    lastSyncErrorCode: isEmailMailboxSyncErrorCode(row.last_sync_error_code) ? row.last_sync_error_code : null,
    coverage: row.coverage as StoredEmailClassificationMailbox['coverage'], createdAt: integer(row.created_at, 'mailbox created time'), updatedAt: integer(row.updated_at, 'mailbox updated time'),
  };
}

function metadataFromRow(row: Row): StoredEmailClassificationMetadata {
  return {
    messageRef: String(row.message_ref), mailboxRef: String(row.mailbox_ref), canonicalId: String(row.canonical_id), folder: String(row.folder),
    dateTimestamp: row.date_timestamp === null ? null : integer(row.date_timestamp, 'message date'),
    replyStatus: row.reply_status as StoredEmailClassificationMetadata['replyStatus'], inInbox: row.in_inbox === true,
    lastSeenInboxAt: integer(row.last_seen_inbox_at, 'last inbox observation'), fingerprint: String(row.fingerprint), list: object<EmailIndexedMessageList>(row.list_json),
    mailbox: mailboxFromRow(object<Row>(row.mailbox_data)), indexRevision: integer(row.index_revision, 'message index revision', 1),
    createdAt: integer(row.created_at, 'message created time'), updatedAt: integer(row.updated_at, 'message updated time'),
  };
}

function jobFromRow(row: Row): StoredEmailClassificationJob {
  return {
    decisionRequestId: typeof row.decision_request_id === 'string' ? row.decision_request_id : null,
    id: String(row.id), messageRef: String(row.message_ref), mailboxRef: String(row.mailbox_ref), configurationRevision: integer(row.configuration_revision, 'configuration revision', 1),
    fingerprint: String(row.fingerprint), bindingRevision: String(row.binding_revision), policyRevision: String(row.policy_revision),
    status: row.status as StoredEmailClassificationJob['status'], attempts: integer(row.attempts, 'attempts'), nextAttemptAt: integer(row.next_attempt_at, 'next attempt'),
    leaseUntil: row.lease_until === null ? null : integer(row.lease_until, 'lease'), claimToken: row.claim_token as string | null, errorCode: row.error_code as string | null,
    createdAt: integer(row.created_at, 'job created time'), updatedAt: integer(row.updated_at, 'job updated time'),
  };
}

function resultFromRow(row: Row): StoredEmailClassificationResult {
  return {
    messageRef: String(row.message_ref), raw: row.raw_json === null ? null : object<EmailClassificationRaw>(row.raw_json),
    configurationRevision: row.configuration_revision === null ? null : integer(row.configuration_revision, 'result configuration', 1),
    evaluationFingerprint: row.evaluation_fingerprint as string | null,
    fingerprint: row.fingerprint as string | null, bindingRevision: row.binding_revision as string | null, policyRevision: row.policy_revision as string | null,
    resultRevision: integer(row.result_revision, 'result revision'), overrides: validateEmailClassificationOverride(object(row.overrides_json)),
    version: integer(row.version, 'result version', 1), updatedAt: integer(row.updated_at, 'result time'),
  };
}

function focusFromRow(row: Row): StoredEmailPersonalFocusState {
  return { userId: String(row.user_id), messageRef: String(row.message_ref), done: row.done === true, version: integer(row.version, 'focus version', 1), updatedAt: integer(row.updated_at, 'focus time') };
}

function normalizeMailbox(input: EmailClassificationMailboxInput): EmailClassificationMailboxInput {
  if (!['local', 'managed'].includes(input.accountSource) || typeof input.active !== 'boolean') throw new Error('Invalid mailbox source or activation.');
  const workspaceId = nullableText(input.workspaceId, 'workspace');
  const mailboxId = nullableText(input.mailboxId, 'workspace mailbox');
  if ((workspaceId === null) !== (mailboxId === null)) throw new Error('Workspace and mailbox identities must be supplied together.');
  if (!Array.isArray(input.readFrom) || input.readFrom.length > 500) throw new Error('Invalid mailbox read policy.');
  return {
    mailboxRef: text(input.mailboxRef, 'mailbox reference'), ownerUserId: text(input.ownerUserId, 'owner'), accountSource: input.accountSource,
    accountId: text(input.accountId, 'account'), provider: text(input.provider, 'provider', 100), workspaceId, mailboxId,
    bindingRevision: text(input.bindingRevision, 'binding revision'), connectionRevision: text(input.connectionRevision ?? input.bindingRevision, 'connection revision'), policyRevision: text(input.policyRevision, 'policy revision'), active: input.active,
    readFrom: input.readFrom.map(value => text(value, 'allowed sender', 500)),
  };
}

function normalizeList(list: EmailIndexedMessageList): EmailIndexedMessageList {
  const header = (value: unknown, limit: number) => {
    if (typeof value !== 'string') return '';
    // PostgreSQL JSONB rejects NUL and lone surrogates. Repair provider text
    // before applying the existing UTF-16 limit, then retain complete pairs.
    const bounded = value.replace(/\u0000/gu, '').toWellFormed().slice(0, limit);
    return /[\uD800-\uDBFF]$/u.test(bounded) ? bounded.slice(0, -1) : bounded;
  };
  const addresses = (values: string[] | undefined) => values === undefined ? undefined : Array.isArray(values)
    ? values.slice(0, 100).map(value => header(value, 500)) : undefined;
  const normalized: EmailIndexedMessageList = { from: header(list.from, 1_000), subject: header(list.subject, 2_000), date: header(list.date, 200), snippet: header(list.snippet, 2_000) };
  for (const key of ['to', 'cc'] as const) { const value = addresses(list[key]); if (value !== undefined) normalized[key] = value; }
  for (const key of ['isRead', 'isFlagged', 'hasAttachments'] as const) if (typeof list[key] === 'boolean') normalized[key] = list[key];
  if (list.threadId === null || typeof list.threadId === 'string') normalized.threadId = list.threadId === null ? null : header(list.threadId, 500);
  return normalized;
}

function normalizedRaw(raw: EmailClassificationRaw): EmailClassificationRaw {
  if (!(EMAIL_CATEGORY_IDS as readonly unknown[]).includes(raw.category) || !(EMAIL_PRIORITIES as readonly unknown[]).includes(raw.priority)) throw new Error('Invalid classification choices.');
  const probability = (value: number | null): number | null => {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid classification probability.');
    return value;
  };
  const distribution = (value: Record<string, number> | null) => value === null ? null : Object.fromEntries(Object.entries(value).map(([key, number]) => [text(key, 'choice', 100), probability(number)])) as Record<string, number>;
  const spamProbability = probability(raw.spamProbability);
  const replyProbability = probability(raw.replyProbability);
  if (spamProbability === null || replyProbability === null || typeof raw.bodyWasTruncated !== 'boolean') throw new Error('Incomplete classification.');
  const usage = raw.usage === null ? null : Object.fromEntries(Object.entries(raw.usage).filter(([key, value]) => value !== undefined && ['inputTokens', 'outputTokens', 'requests'].includes(key)).map(([key, value]) => [key, integer(value, 'usage')]));
  return {
    category: raw.category, categoryProbabilities: distribution(raw.categoryProbabilities), categoryConfidence: probability(raw.categoryConfidence),
    priority: raw.priority, priorityProbabilities: distribution(raw.priorityProbabilities), priorityConfidence: probability(raw.priorityConfidence), spamProbability, replyProbability,
    providerId: text(raw.providerId, 'result provider', 128), model: text(raw.model, 'result model', 200), adapterVersion: text(raw.adapterVersion, 'adapter version', 200), schemaVersion: text(raw.schemaVersion, 'schema version', 200),
    probabilitySemantics: text(raw.probabilitySemantics, 'probability semantics', 100), calibrationReference: raw.calibrationReference === null ? null : text(raw.calibrationReference, 'calibration reference', 200),
    latencyMs: integer(raw.latencyMs, 'latency'), evaluatedAt: integer(raw.evaluatedAt, 'evaluation time'), evaluatedBodyCharacters: integer(raw.evaluatedBodyCharacters, 'evaluated characters'), bodyWasTruncated: raw.bodyWasTruncated, usage,
  };
}

/** Low-level store; services must authorize every source and personal state before use. */
export class PostgresEmailClassificationStore {
  constructor(private readonly postgres: EmailClassificationQueryable, private readonly transaction: EmailClassificationTransaction) {}

  private async lockSettings(connection: EmailClassificationQueryable): Promise<EmailClassificationSettings> {
    const result = await connection.query("SELECT * FROM email_classification_settings WHERE id = 'instance' FOR UPDATE");
    return settingsFromRow(result.rows[0]);
  }

  async readSettings(): Promise<EmailClassificationSettings> {
    return settingsFromRow((await this.postgres.query("SELECT * FROM email_classification_settings WHERE id = 'instance'")).rows[0]);
  }

  async updateSettings(input: { expectedRevision: number; actorUserId: string | null; configuration: EmailClassificationConfiguration; now?: number }): Promise<EmailClassificationSettings> {
    const expected = integer(input.expectedRevision, 'expected settings revision');
    const actor = input.actorUserId === null ? null : text(input.actorUserId, 'settings actor');
    const validated = validateEmailClassificationConfiguration(input.configuration);
    const now = integer(input.now ?? Date.now(), 'time');
    return this.transaction(async connection => {
      const previous = await this.lockSettings(connection);
      if (previous.revision !== expected) throw new EmailClassificationVersionConflictError();
      const configuration = resetChangedEmailSpamValidation(previous.configuration, validated);
      const updated = expected === 0
        ? await connection.query(`INSERT INTO email_classification_settings(id, revision, configuration_json, updated_at, updated_by_user_id)
            VALUES ('instance', 1, $1::jsonb, $2, $3) ON CONFLICT(id) DO NOTHING RETURNING *`, [JSON.stringify(configuration), now, actor])
        : await connection.query(`UPDATE email_classification_settings SET revision = revision + 1, configuration_json = $1::jsonb, updated_at = $2, updated_by_user_id = $3
            WHERE id = 'instance' AND revision = $4 RETURNING *`, [JSON.stringify(configuration), now, actor, expected]);
      if (!updated.rows[0]) throw new EmailClassificationVersionConflictError();
      if (!configuration.enabled) {
        await connection.query(`UPDATE email_classification_jobs SET status = 'canceled', lease_until = NULL, claim_token = NULL, error_code = 'disabled', updated_at = $1
          WHERE status IN ('pending', 'processing', 'retry')`, [now]);
      }
      return settingsFromRow(updated.rows[0]);
    });
  }

  async upsertMailbox(input: EmailClassificationMailboxInput, now = Date.now()): Promise<StoredEmailClassificationMailbox> {
    const mailbox = normalizeMailbox(input); integer(now, 'time');
    return this.transaction(async connection => {
      await this.lockSettings(connection);
      const previous = (await connection.query('SELECT * FROM email_classification_mailboxes WHERE mailbox_ref = $1 FOR UPDATE', [mailbox.mailboxRef])).rows[0];
      if (previous && (previous.owner_user_id !== mailbox.ownerUserId || previous.account_source !== mailbox.accountSource || previous.account_id !== mailbox.accountId || previous.workspace_id !== mailbox.workspaceId || previous.mailbox_id !== mailbox.mailboxId)) {
        throw new EmailClassificationStoreStateError('A mailbox reference cannot be reassigned to another owner or scope.');
      }
      const connectionChanged = previous && (previous.connection_revision !== mailbox.connectionRevision || previous.provider !== mailbox.provider);
      // Opaque IDs (including IMAP UIDVALIDITY+UID) belong to one actual server/account.
      // Old IDs must never be actionable under a replacement connection.
      if (connectionChanged) await connection.query('DELETE FROM email_classification_messages WHERE mailbox_ref = $1', [mailbox.mailboxRef]);
      const changed = previous && (previous.binding_revision !== mailbox.bindingRevision || previous.policy_revision !== mailbox.policyRevision || previous.active !== mailbox.active || previous.provider !== mailbox.provider || JSON.stringify(object(previous.read_from_json)) !== JSON.stringify(mailbox.readFrom));
      const result = await connection.query(`INSERT INTO email_classification_mailboxes(mailbox_ref, owner_user_id, account_source, account_id, provider, workspace_id, mailbox_id,
        binding_revision, policy_revision, read_from_json, active, created_at, updated_at,connection_revision)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$12,$14)
        ON CONFLICT(mailbox_ref) DO UPDATE SET provider = EXCLUDED.provider, binding_revision = EXCLUDED.binding_revision, policy_revision = EXCLUDED.policy_revision,
          connection_revision = EXCLUDED.connection_revision, read_from_json = EXCLUDED.read_from_json, active = EXCLUDED.active, index_revision = email_classification_mailboxes.index_revision + $13,
          coverage = CASE WHEN $13 = 1 THEN 'pending' ELSE email_classification_mailboxes.coverage END,
          sync_cursor = CASE WHEN $13 = 1 THEN NULL ELSE email_classification_mailboxes.sync_cursor END,
          last_sync_at = CASE WHEN $13 = 1 THEN NULL ELSE email_classification_mailboxes.last_sync_at END,
          last_sync_error_code = CASE WHEN $13 = 1 THEN NULL ELSE email_classification_mailboxes.last_sync_error_code END,
          updated_at = EXCLUDED.updated_at
        WHERE email_classification_mailboxes.owner_user_id = EXCLUDED.owner_user_id AND email_classification_mailboxes.account_source = EXCLUDED.account_source
          AND email_classification_mailboxes.account_id = EXCLUDED.account_id AND email_classification_mailboxes.workspace_id IS NOT DISTINCT FROM EXCLUDED.workspace_id
          AND email_classification_mailboxes.mailbox_id IS NOT DISTINCT FROM EXCLUDED.mailbox_id RETURNING *`,
      [mailbox.mailboxRef, mailbox.ownerUserId, mailbox.accountSource, mailbox.accountId, mailbox.provider, mailbox.workspaceId, mailbox.mailboxId,
        mailbox.bindingRevision, mailbox.policyRevision, JSON.stringify(mailbox.readFrom), mailbox.active, now, changed || connectionChanged ? 1 : 0, mailbox.connectionRevision]);
      if (!result.rows[0]) throw new EmailClassificationStoreStateError('A mailbox reference cannot be reassigned to another owner or scope.');
      if (changed || !mailbox.active) await connection.query(`UPDATE email_classification_jobs SET status = 'canceled', lease_until = NULL, claim_token = NULL, error_code = 'mailbox_changed', updated_at = $2
        WHERE mailbox_ref = $1 AND status IN ('pending','processing','retry')`, [mailbox.mailboxRef, now]);
      return mailboxFromRow(result.rows[0]);
    });
  }

  async readMailbox(mailboxRef: string): Promise<StoredEmailClassificationMailbox | null> {
    const row = (await this.postgres.query('SELECT * FROM email_classification_mailboxes WHERE mailbox_ref = $1', [text(mailboxRef, 'mailbox reference')])).rows[0];
    return row ? mailboxFromRow(row) : null;
  }

  async listActiveMailboxes(): Promise<StoredEmailClassificationMailbox[]> {
    const result = await this.postgres.query('SELECT * FROM email_classification_mailboxes WHERE active ORDER BY mailbox_ref');
    return result.rows.map(mailboxFromRow);
  }

  async deactivateMailbox(mailboxRef: string, now = Date.now()): Promise<void> {
    text(mailboxRef, 'mailbox reference'); integer(now, 'time');
    await this.transaction(async connection => {
      await this.lockSettings(connection);
      await connection.query('UPDATE email_classification_mailboxes SET active = false, last_sync_error_code = NULL, index_revision = index_revision + 1, updated_at = $2 WHERE mailbox_ref = $1 AND active', [mailboxRef, now]);
      await connection.query(`UPDATE email_classification_jobs SET status = 'canceled', lease_until = NULL, claim_token = NULL, error_code = 'mailbox_inactive', updated_at = $2
        WHERE mailbox_ref = $1 AND status IN ('pending','processing','retry')`, [mailboxRef, now]);
    });
  }

  async recordMailboxSync(input: { mailboxRef: string; bindingRevision: string; policyRevision: string; cursor: string | null; coverage: StoredEmailClassificationMailbox['coverage']; errorCode?: EmailMailboxSyncErrorCode | null; claimToken?: string; now?: number }): Promise<boolean> {
    if (!['pending', 'partial', 'complete', 'failed'].includes(input.coverage)) throw new Error('Invalid mailbox coverage.');
    if (input.errorCode != null && !isEmailMailboxSyncErrorCode(input.errorCode)) throw new Error('Invalid mailbox sync error code.');
    const errorCode = input.coverage === 'failed' ? input.errorCode ?? 'sync_failed' : null;
    const updated = await this.postgres.query(`UPDATE email_classification_mailboxes SET last_sync_at = CASE WHEN $4 = 'failed' THEN last_sync_at ELSE $2 END, sync_cursor = $3, coverage = $4, last_sync_error_code = $8, updated_at = $2
      WHERE mailbox_ref = $1 AND active AND binding_revision = $5 AND policy_revision = $6
        AND ($7::text IS NULL OR EXISTS(SELECT 1 FROM email_classification_mailbox_sync_leases lease WHERE lease.mailbox_ref = email_classification_mailboxes.mailbox_ref AND lease.claim_token = $7 AND lease.lease_until > $2)) RETURNING mailbox_ref`,
    [text(input.mailboxRef, 'mailbox reference'), integer(input.now ?? Date.now(), 'time'), input.cursor === null ? null : text(input.cursor, 'sync cursor', 10_000), input.coverage,
      text(input.bindingRevision, 'binding revision'), text(input.policyRevision, 'policy revision'), input.claimToken ?? null, errorCode]);
    return updated.rows.length > 0;
  }

  async upsertMessageMetadata(input: EmailClassificationMetadataInput & { expectedBindingRevision?: string; expectedPolicyRevision?: string }, now = Date.now()): Promise<StoredEmailClassificationMetadata> {
    const messageRef = text(input.messageRef, 'message reference'); const mailboxRef = text(input.mailboxRef, 'mailbox reference');
    const canonicalId = text(input.canonicalId, 'provider reference', 2_000); const folder = text(input.folder, 'folder');
    const fingerprint = text(input.fingerprint, 'fingerprint'); integer(now, 'time');
    if (!['answered', 'unanswered', 'unknown'].includes(input.replyStatus)) throw new Error('Invalid reply status.');
    if (input.inInbox !== undefined && typeof input.inInbox !== 'boolean') throw new Error('Invalid inbox membership.');
    const date = input.dateTimestamp === null ? null : integer(input.dateTimestamp, 'message date');
    const list = normalizeList(input.list);
    return this.transaction(async connection => {
      await this.lockSettings(connection);
      const mailboxRow = (await connection.query('SELECT * FROM email_classification_mailboxes WHERE mailbox_ref = $1 AND active FOR UPDATE', [mailboxRef])).rows[0];
      if (!mailboxRow) throw new EmailClassificationStoreStateError();
      if (input.expectedBindingRevision !== undefined && input.expectedBindingRevision !== mailboxRow.binding_revision
        || input.expectedPolicyRevision !== undefined && input.expectedPolicyRevision !== mailboxRow.policy_revision) throw new EmailClassificationStoreStateError();
      const previous = (await connection.query('SELECT * FROM email_classification_messages WHERE message_ref = $1 FOR UPDATE', [messageRef])).rows[0];
      if (previous && (previous.mailbox_ref !== mailboxRef || previous.canonical_id !== canonicalId)) throw new EmailClassificationStoreStateError('A message reference cannot be reassigned to another provider message.');
      const result = await connection.query(`INSERT INTO email_classification_messages(message_ref,mailbox_ref,canonical_id,folder,date_timestamp,reply_status,fingerprint,list_json,created_at,updated_at,in_inbox)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9,COALESCE($10,true)) ON CONFLICT(message_ref) DO UPDATE SET
          folder = EXCLUDED.folder, date_timestamp = EXCLUDED.date_timestamp,
          reply_status = CASE WHEN email_classification_messages.accepted_reply_at IS NOT NULL THEN 'answered'
            WHEN EXCLUDED.reply_status = 'unknown' THEN email_classification_messages.reply_status ELSE EXCLUDED.reply_status END,
          fingerprint = EXCLUDED.fingerprint, list_json = EXCLUDED.list_json,
          in_inbox = COALESCE($10,email_classification_messages.in_inbox),
          index_revision = email_classification_messages.index_revision + 1, updated_at = EXCLUDED.updated_at
        WHERE email_classification_messages.folder IS DISTINCT FROM EXCLUDED.folder OR email_classification_messages.date_timestamp IS DISTINCT FROM EXCLUDED.date_timestamp
          OR (email_classification_messages.accepted_reply_at IS NULL AND EXCLUDED.reply_status <> 'unknown' AND email_classification_messages.reply_status IS DISTINCT FROM EXCLUDED.reply_status) OR email_classification_messages.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
          OR email_classification_messages.list_json IS DISTINCT FROM EXCLUDED.list_json
          OR ($10 IS NOT NULL AND email_classification_messages.in_inbox IS DISTINCT FROM $10) RETURNING *`,
      [messageRef, mailboxRef, canonicalId, folder, date, input.replyStatus, fingerprint, JSON.stringify(list), now, input.inInbox ?? null]);
      const row = result.rows[0] ?? previous;
      if (input.lastSeenInboxAt !== undefined) {
        const seenAt = integer(input.lastSeenInboxAt, 'last inbox observation');
        const seen = (await connection.query('UPDATE email_classification_messages SET last_seen_inbox_at = GREATEST(last_seen_inbox_at,$2) WHERE message_ref = $1 RETURNING last_seen_inbox_at', [messageRef, seenAt])).rows[0];
        row.last_seen_inbox_at = seen.last_seen_inbox_at;
      }
      const currentMailbox = result.rows.length ? (await connection.query('UPDATE email_classification_mailboxes SET index_revision = index_revision + 1, updated_at = $2 WHERE mailbox_ref = $1 RETURNING *', [mailboxRef, now])).rows[0] : mailboxRow;
      if (input.inInbox === false || previous && previous.fingerprint !== fingerprint) await connection.query(`UPDATE email_classification_jobs SET status = 'canceled', lease_until = NULL, claim_token = NULL, error_code = 'message_changed', updated_at = $2
        WHERE message_ref = $1 AND status IN ('pending','processing','retry')`, [messageRef, now]);
      return metadataFromRow({ ...row, mailbox_data: currentMailbox });
    });
  }

  async readMessages(messageRefs: string[]): Promise<StoredEmailClassificationMetadata[]> {
    if (!messageRefs.length) return [];
    if (messageRefs.length > 1_000) throw new Error('Too many message references.');
    const result = await this.postgres.query(`SELECT message.*, to_jsonb(mailbox) AS mailbox_data FROM email_classification_messages message
      JOIN email_classification_mailboxes mailbox ON mailbox.mailbox_ref = message.mailbox_ref
      WHERE message.message_ref = ANY($1::text[]) AND mailbox.active`, [messageRefs.map(value => text(value, 'message reference'))]);
    return result.rows.map(metadataFromRow);
  }

  async invalidateAccount(input: { ownerUserId: string; accountId: string; accountSource: 'local' | 'managed'; now?: number }): Promise<void> {
    const now = integer(input.now ?? Date.now(), 'time');
    await this.transaction(async connection => {
      await this.lockSettings(connection);
      const sources = await connection.query(`UPDATE email_classification_mailboxes SET active = false, coverage = 'pending', sync_cursor = NULL, last_sync_error_code = NULL, index_revision = index_revision + 1, updated_at = $4
        WHERE owner_user_id = $1 AND account_id = $2 AND account_source = $3 AND active RETURNING mailbox_ref`,
      [text(input.ownerUserId, 'owner'), text(input.accountId, 'account'), input.accountSource, now]);
      const refs = sources.rows.map(row => String(row.mailbox_ref));
      if (refs.length) await connection.query(`UPDATE email_classification_jobs SET status = 'canceled', lease_until = NULL, claim_token = NULL, error_code = 'mailbox_changed', updated_at = $2
        WHERE mailbox_ref = ANY($1::text[]) AND status IN ('pending','processing','retry')`, [refs, now]);
    });
  }

  async updateIndexedMessageState(input: { ownerUserId: string; accountId: string; accountSource: 'local' | 'managed'; canonicalId: string;
    read?: boolean; answered?: boolean; leaveInbox?: boolean; remove?: boolean; now?: number }): Promise<void> {
    const now = integer(input.now ?? Date.now(), 'time');
    await this.transaction(async connection => {
      await this.lockSettings(connection);
      const selected = await connection.query(`SELECT message.message_ref, mailbox.mailbox_ref FROM email_classification_messages message
        JOIN email_classification_mailboxes mailbox ON mailbox.mailbox_ref = message.mailbox_ref
        WHERE mailbox.owner_user_id = $1 AND mailbox.account_id = $2 AND mailbox.account_source = $3 AND message.canonical_id = $4 FOR UPDATE OF mailbox, message`,
      [text(input.ownerUserId, 'owner'), text(input.accountId, 'account'), input.accountSource, text(input.canonicalId, 'provider reference', 2_000)]);
      const refs = selected.rows.map(row => String(row.message_ref));
      if (!refs.length) return;
      if (input.remove) await connection.query('DELETE FROM email_classification_messages WHERE message_ref = ANY($1::text[])', [refs]);
      else {
        await connection.query(`UPDATE email_classification_messages SET
          list_json = CASE WHEN $2::boolean IS NULL THEN list_json ELSE jsonb_set(list_json,'{isRead}',to_jsonb($2::boolean),true) END,
          reply_status = CASE WHEN $3::boolean IS NULL THEN reply_status WHEN $3 THEN 'answered' ELSE 'unanswered' END,
          accepted_reply_at = CASE WHEN $3::boolean = false THEN NULL ELSE accepted_reply_at END,
          in_inbox = CASE WHEN $4::boolean THEN false ELSE in_inbox END, index_revision = index_revision + 1, updated_at = $5
          WHERE message_ref = ANY($1::text[])`, [refs, input.read ?? null, input.answered ?? null, input.leaveInbox ?? false, now]);
        if (input.leaveInbox) await connection.query(`UPDATE email_classification_jobs SET status = 'canceled', lease_until = NULL, claim_token = NULL, error_code = 'left_inbox', updated_at = $2
          WHERE message_ref = ANY($1::text[]) AND status IN ('pending','processing','retry')`, [refs, now]);
      }
      await connection.query('UPDATE email_classification_mailboxes SET index_revision = index_revision + 1, updated_at = $2 WHERE mailbox_ref = ANY($1::text[])', [[...new Set(selected.rows.map(row => String(row.mailbox_ref)))], now]);
    });
  }

  /** A confirmed send is evidence for one original source, fenced against rebinding. */
  async confirmAcceptedReply(input: { mailboxRef: string; messageRef: string; connectionRevision: string; bindingRevision: string; policyRevision: string; now?: number }): Promise<boolean> {
    const now = integer(input.now ?? Date.now(), 'time');
    return this.transaction(async connection => {
      await this.lockSettings(connection);
      const mailbox = (await connection.query(`SELECT * FROM email_classification_mailboxes WHERE mailbox_ref = $1 AND active
        AND connection_revision = $2 AND binding_revision = $3 AND policy_revision = $4 FOR UPDATE`,
      [text(input.mailboxRef, 'mailbox reference'), text(input.connectionRevision, 'connection revision'), text(input.bindingRevision, 'binding revision'), text(input.policyRevision, 'policy revision')])).rows[0];
      if (!mailbox) return false;
      const updated = await connection.query(`UPDATE email_classification_messages SET reply_status = 'answered',
        accepted_reply_at = $3, index_revision = index_revision + 1, updated_at = $3 WHERE mailbox_ref = $1 AND message_ref = $2 RETURNING message_ref`,
      [input.mailboxRef, text(input.messageRef, 'message reference'), now]);
      if (!updated.rows.length) return false;
      await connection.query('UPDATE email_classification_mailboxes SET index_revision = index_revision + 1, updated_at = $2 WHERE mailbox_ref = $1', [input.mailboxRef, now]);
      return true;
    });
  }

  async reconcileMailboxInbox(input: { mailboxRef: string; bindingRevision: string; policyRevision: string; claimToken: string; startedAt: number; now?: number }): Promise<number> {
    const now = integer(input.now ?? Date.now(), 'time');
    return this.transaction(async connection => {
      await this.lockSettings(connection);
      const source = (await connection.query(`SELECT mailbox.mailbox_ref FROM email_classification_mailboxes mailbox
        JOIN email_classification_mailbox_sync_leases lease ON lease.mailbox_ref = mailbox.mailbox_ref
        WHERE mailbox.mailbox_ref = $1 AND mailbox.active AND mailbox.binding_revision = $2 AND mailbox.policy_revision = $3 AND lease.claim_token = $4 AND lease.lease_until > $5 FOR UPDATE OF mailbox`,
      [text(input.mailboxRef, 'mailbox reference'), text(input.bindingRevision, 'binding revision'), text(input.policyRevision, 'policy revision'), text(input.claimToken, 'claim token'), now])).rows[0];
      if (!source) return 0;
      const missing = await connection.query(`UPDATE email_classification_messages SET in_inbox = false, index_revision = index_revision + 1, updated_at = $3
        WHERE mailbox_ref = $1 AND in_inbox AND last_seen_inbox_at < $2 AND created_at <= $2 RETURNING message_ref`,
      [input.mailboxRef, integer(input.startedAt, 'inbox scan start'), now]);
      const refs = missing.rows.map(row => String(row.message_ref));
      if (refs.length) {
        await connection.query(`UPDATE email_classification_jobs SET status = 'canceled', lease_until = NULL, claim_token = NULL, error_code = 'left_inbox', updated_at = $2
          WHERE message_ref = ANY($1::text[]) AND status IN ('pending','processing','retry')`, [refs, now]);
        await connection.query('UPDATE email_classification_mailboxes SET index_revision = index_revision + 1, updated_at = $2 WHERE mailbox_ref = $1', [input.mailboxRef, now]);
      }
      return refs.length;
    });
  }

  async enqueueClassification(input: { messageRef: string; configurationRevision: number; fingerprint: string; now?: number }): Promise<StoredEmailClassificationJob | null> {
    const messageRef = text(input.messageRef, 'message reference'); const fingerprint = text(input.fingerprint, 'fingerprint');
    const revision = integer(input.configurationRevision, 'configuration revision', 1); const now = integer(input.now ?? Date.now(), 'time');
    return this.transaction(async connection => {
      const settings = await this.lockSettings(connection);
      if (!settings.configuration.enabled || settings.revision !== revision) return null;
      const message = (await connection.query(`SELECT message.*, mailbox.binding_revision, mailbox.policy_revision FROM email_classification_messages message
        JOIN email_classification_mailboxes mailbox ON mailbox.mailbox_ref = message.mailbox_ref
        WHERE message.message_ref = $1 AND message.fingerprint = $2 AND mailbox.active
          AND ${emailClassificationSelectionSql('message', '$3', '$4')} FOR UPDATE OF mailbox, message`,
      [messageRef, fingerprint, now, settings.configuration.initialLookbackDays])).rows[0];
      if (!message) return null;
      const result = await connection.query(`INSERT INTO email_classification_jobs(id,message_ref,mailbox_ref,configuration_revision,fingerprint,binding_revision,policy_revision,status,next_attempt_at,created_at,updated_at,evaluation_fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$8,$8,$9)
        ON CONFLICT(message_ref,configuration_revision,fingerprint) DO UPDATE SET binding_revision = EXCLUDED.binding_revision, policy_revision = EXCLUDED.policy_revision,
          status = 'pending', attempts = 0, next_attempt_at = EXCLUDED.next_attempt_at, lease_until = NULL, claim_token = NULL, error_code = NULL, updated_at = EXCLUDED.updated_at
        WHERE email_classification_jobs.binding_revision <> EXCLUDED.binding_revision OR email_classification_jobs.policy_revision <> EXCLUDED.policy_revision
          OR (email_classification_jobs.status = 'canceled' AND email_classification_jobs.claim_token IS NULL AND email_classification_jobs.lease_until IS NULL) RETURNING *`,
      [randomUUID(), messageRef, message.mailbox_ref, revision, fingerprint, message.binding_revision, message.policy_revision, now, emailClassificationEvaluationFingerprint(settings.configuration)]);
      const row = result.rows[0] ?? (await connection.query('SELECT * FROM email_classification_jobs WHERE message_ref = $1 AND configuration_revision = $2 AND fingerprint = $3', [messageRef, revision, fingerprint])).rows[0];
      return row ? jobFromRow(row) : null;
    });
  }

  async claimJobs(input: { limit: number; leaseMs: number; now?: number }): Promise<StoredEmailClassificationJob[]> {
    const limit = Math.min(integer(input.limit, 'claim limit', 1), 100); const leaseMs = integer(input.leaseMs, 'lease duration', 1);
    if (leaseMs > 600_000) throw new Error('Lease duration is too large.');
    const now = integer(input.now ?? Date.now(), 'time');
    return this.transaction(async connection => {
      const settings = await this.lockSettings(connection);
      if (!settings.configuration.enabled) return [];
      // Cancel legacy/ineligible work even when the daily budget has already been exhausted.
      await connection.query(`UPDATE email_classification_jobs job SET status = 'canceled', lease_until = NULL,
        claim_token = NULL, error_code = 'not_selected', updated_at = $1 FROM email_classification_messages message
        WHERE message.message_ref = job.message_ref AND job.status IN ('pending','processing','retry')
          AND NOT coalesce(${emailClassificationSelectionSql('message', '$1', '$2')}, false)`,
      [now, settings.configuration.initialLookbackDays]);
      const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
      await connection.query('INSERT INTO email_classification_daily_budget(day_start, attempts) VALUES ($1,0) ON CONFLICT(day_start) DO NOTHING', [dayStart]);
      const budget = (await connection.query('SELECT attempts FROM email_classification_daily_budget WHERE day_start = $1 FOR UPDATE', [dayStart])).rows[0];
      const remaining = Math.max(0, settings.configuration.maxEmailsPerDay - integer(budget.attempts, 'daily attempts'));
      if (remaining === 0) return [];
      await connection.query(`UPDATE email_classification_jobs SET status = 'canceled', lease_until = NULL, claim_token = NULL, error_code = 'stale_configuration', updated_at = $2
        WHERE configuration_revision <> $1 AND status IN ('pending','processing','retry')`, [settings.revision, now]);
      const processing = (await connection.query("SELECT count(*) AS count FROM email_classification_jobs WHERE status = 'processing' AND lease_until > $1", [now])).rows[0];
      const slots = Math.max(0, settings.configuration.concurrency - integer(processing.count, 'processing count'));
      if (slots === 0) return [];
      const candidates = await connection.query(`WITH eligible AS (SELECT job.id, job.next_attempt_at, job.created_at, mailbox.last_claimed_at,
          row_number() OVER (PARTITION BY job.mailbox_ref ORDER BY job.next_attempt_at, job.created_at, job.id) AS mailbox_position
        FROM email_classification_jobs job
        JOIN email_classification_messages message ON message.message_ref = job.message_ref
        JOIN email_classification_mailboxes mailbox ON mailbox.mailbox_ref = job.mailbox_ref
        WHERE job.configuration_revision = $1 AND message.in_inbox AND mailbox.active AND job.binding_revision = mailbox.binding_revision AND job.policy_revision = mailbox.policy_revision
          AND ${emailClassificationSelectionSql('message', '$2', '$4')}
          AND job.fingerprint = message.fingerprint AND ((job.status IN ('pending','retry') AND job.next_attempt_at <= $2) OR (job.status = 'processing' AND job.lease_until <= $2))
        ) SELECT job.* FROM eligible JOIN email_classification_jobs job ON job.id = eligible.id
        ORDER BY eligible.mailbox_position, eligible.last_claimed_at, eligible.next_attempt_at, eligible.created_at, eligible.id LIMIT $3 FOR UPDATE OF job SKIP LOCKED`, [settings.revision, now, Math.min(limit, remaining, slots), settings.configuration.initialLookbackDays]);
      const jobs: StoredEmailClassificationJob[] = [];
      for (const candidate of candidates.rows) {
        const updated = await connection.query(`UPDATE email_classification_jobs SET status = 'processing', attempts = attempts + 1, lease_until = $2, claim_token = $3, error_code = NULL, updated_at = $4, decision_request_id = coalesce(decision_request_id, id)
          WHERE id = $1 RETURNING *`, [candidate.id, now + leaseMs, randomUUID(), now]);
        jobs.push(jobFromRow(updated.rows[0]));
        await connection.query('UPDATE email_classification_mailboxes SET last_claimed_at = $2 WHERE mailbox_ref = $1', [candidate.mailbox_ref, now]);
      }
      if (jobs.length) await connection.query('UPDATE email_classification_daily_budget SET attempts = attempts + $2 WHERE day_start = $1', [dayStart, jobs.length]);
      return jobs;
    });
  }

  async readJob(id: string): Promise<StoredEmailClassificationJob | null> {
    const row = (await this.postgres.query('SELECT * FROM email_classification_jobs WHERE id = $1', [text(id, 'job ID')])).rows[0];
    return row ? jobFromRow(row) : null;
  }

  async cancelClaim(input: { jobId: string; claimToken: string; errorCode: string; now?: number }): Promise<boolean> {
    const now = integer(input.now ?? Date.now(), 'time');
    const updated = await this.postgres.query(`UPDATE email_classification_jobs SET status = 'canceled', lease_until = NULL, claim_token = NULL, error_code = $3, updated_at = $4
      WHERE id = $1 AND claim_token = $2 AND status = 'processing' RETURNING id`,
    [text(input.jobId, 'job ID'), text(input.claimToken, 'claim token'), text(input.errorCode, 'error code', 100), now]);
    return updated.rows.length > 0;
  }

  async readClassificationJobStates(messageRefs: string[], configurationRevision: number): Promise<Map<string, EmailClassificationJobStatus>> {
    if (!messageRefs.length) return new Map();
    if (messageRefs.length > 1_000) throw new Error('Too many job references.');
    const rows = await this.postgres.query(`SELECT job.message_ref, job.status FROM email_classification_jobs job
      JOIN email_classification_messages message ON message.message_ref = job.message_ref
      JOIN email_classification_mailboxes mailbox ON mailbox.mailbox_ref = job.mailbox_ref
      WHERE job.message_ref = ANY($1::text[]) AND job.configuration_revision = $2 AND mailbox.active
        AND job.fingerprint = message.fingerprint AND job.binding_revision = mailbox.binding_revision AND job.policy_revision = mailbox.policy_revision`,
    [messageRefs.map(value => text(value, 'message reference')), integer(configurationRevision, 'configuration revision')]);
    return new Map(rows.rows.map(row => [String(row.message_ref), row.status as EmailClassificationJobStatus]));
  }

  async readClassificationHistory(messageRefs: string[], evaluationFingerprint: string): Promise<Set<string>> {
    if (!messageRefs.length) return new Set();
    if (messageRefs.length > 1_000) throw new Error('Too many historical references.');
    const selected = await this.postgres.query('SELECT DISTINCT message_ref FROM email_classification_jobs WHERE message_ref = ANY($1::text[]) AND evaluation_fingerprint = $2',
      [messageRefs.map(value => text(value, 'message reference')), text(evaluationFingerprint, 'evaluation fingerprint')]);
    return new Set(selected.rows.map(row => String(row.message_ref)));
  }

  async claimMailboxSync(input: { mailboxRef: string; leaseMs: number; now?: number }): Promise<string | null> {
    const now = integer(input.now ?? Date.now(), 'time');
    const leaseMs = integer(input.leaseMs, 'sync lease duration', 1);
    if (leaseMs > 600_000) throw new Error('Sync lease duration is too large.');
    const token = randomUUID();
    const claimed = await this.postgres.query(`INSERT INTO email_classification_mailbox_sync_leases(mailbox_ref, claim_token, lease_until)
      SELECT mailbox_ref, $2, $3 FROM email_classification_mailboxes WHERE mailbox_ref = $1 AND active
      ON CONFLICT(mailbox_ref) DO UPDATE SET claim_token = EXCLUDED.claim_token, lease_until = EXCLUDED.lease_until
      WHERE email_classification_mailbox_sync_leases.lease_until <= $4 RETURNING claim_token`,
    [text(input.mailboxRef, 'mailbox reference'), token, now + leaseMs, now]);
    return claimed.rows.length ? token : null;
  }

  async releaseMailboxSync(input: { mailboxRef: string; claimToken: string }): Promise<boolean> {
    const released = await this.postgres.query('DELETE FROM email_classification_mailbox_sync_leases WHERE mailbox_ref = $1 AND claim_token = $2 RETURNING mailbox_ref',
      [text(input.mailboxRef, 'mailbox reference'), text(input.claimToken, 'claim token')]);
    return released.rows.length > 0;
  }

  async completeJob(input: { jobId: string; claimToken: string; raw: EmailClassificationRaw; now?: number }): Promise<boolean> {
    const id = text(input.jobId, 'job ID'); const token = text(input.claimToken, 'claim token'); const raw = normalizedRaw(input.raw); const now = integer(input.now ?? Date.now(), 'time');
    return this.transaction(async connection => {
      const settings = await this.lockSettings(connection);
      const jobRow = (await connection.query('SELECT * FROM email_classification_jobs WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!jobRow) return false;
      const job = jobFromRow(jobRow);
      if (job.status !== 'processing' || job.claimToken !== token || job.leaseUntil === null || job.leaseUntil <= now) return false;
      const message = (await connection.query(`SELECT message.*, mailbox.active, mailbox.binding_revision, mailbox.policy_revision FROM email_classification_messages message
        JOIN email_classification_mailboxes mailbox ON mailbox.mailbox_ref = message.mailbox_ref WHERE message.message_ref = $1 FOR UPDATE OF mailbox, message`, [job.messageRef])).rows[0];
      const valid = settings.configuration.enabled && settings.revision === job.configurationRevision && message?.active === true && message.in_inbox === true
        && isEmailSelectedForClassification({ inInbox: message.in_inbox === true,
          dateTimestamp: message.date_timestamp === null ? null : Number(message.date_timestamp), list: object<EmailIndexedMessageList>(message.list_json) }, settings.configuration.initialLookbackDays, now)
        && message.fingerprint === job.fingerprint && message.binding_revision === job.bindingRevision && message.policy_revision === job.policyRevision
        && (settings.configuration.executionMode === 'managed'
          ? settings.configuration.managedModel !== null && raw.providerId === settings.configuration.managedModel.providerId
            && raw.model === settings.configuration.managedModel.model && raw.adapterVersion === settings.configuration.managedModel.adapterVersion
          : raw.providerId === settings.configuration.providerId);
      if (!valid) {
        await connection.query("UPDATE email_classification_jobs SET status = 'canceled', lease_until = NULL, claim_token = NULL, error_code = 'stale_claim', updated_at = $2 WHERE id = $1", [id, now]);
        return false;
      }
      await connection.query(`INSERT INTO email_classification_results(message_ref,raw_json,configuration_revision,fingerprint,binding_revision,policy_revision,result_revision,version,updated_at,evaluation_fingerprint)
        VALUES ($1,$2::jsonb,$3,$4,$5,$6,1,1,$7,$8) ON CONFLICT(message_ref) DO UPDATE SET
          raw_json = EXCLUDED.raw_json, configuration_revision = EXCLUDED.configuration_revision, fingerprint = EXCLUDED.fingerprint,
          evaluation_fingerprint = EXCLUDED.evaluation_fingerprint,
          binding_revision = EXCLUDED.binding_revision, policy_revision = EXCLUDED.policy_revision, result_revision = email_classification_results.result_revision + 1,
          version = email_classification_results.version + 1, updated_at = EXCLUDED.updated_at`,
      [job.messageRef, JSON.stringify(raw), job.configurationRevision, job.fingerprint, job.bindingRevision, job.policyRevision, now, emailClassificationEvaluationFingerprint(settings.configuration)]);
      await connection.query("UPDATE email_classification_jobs SET status = 'completed', lease_until = NULL, claim_token = NULL, error_code = NULL, updated_at = $2 WHERE id = $1", [id, now]);
      return true;
    });
  }

  async renewClaim(input: { jobId: string; claimToken: string; leaseMs: number; now?: number }): Promise<boolean> {
    const now = integer(input.now ?? Date.now(), 'time'); const leaseMs = integer(input.leaseMs, 'lease duration', 1);
    if (leaseMs > 600_000) throw new Error('Lease duration is too large.');
    return this.transaction(async connection => {
      const settings = await this.lockSettings(connection);
      if (!settings.configuration.enabled) return false;
      const updated = await connection.query(`UPDATE email_classification_jobs SET lease_until = $3, updated_at = $4 WHERE id = $1 AND claim_token = $2
        AND status = 'processing' AND lease_until > $4 AND configuration_revision = $5 RETURNING id`,
      [text(input.jobId, 'job ID'), text(input.claimToken, 'claim token'), now + leaseMs, now, settings.revision]);
      return updated.rows.length > 0;
    });
  }

  async retryJob(input: { jobId: string; claimToken: string; errorCode: string; nextAttemptAt: number; terminal?: boolean; decisionRequestId?: string; now?: number }): Promise<boolean> {
    const now = integer(input.now ?? Date.now(), 'time');
    return this.transaction(async connection => {
      const settings = await this.lockSettings(connection);
      if (!settings.configuration.enabled) return false;
      const updated = await connection.query(`UPDATE email_classification_jobs SET status = $3, lease_until = NULL, claim_token = NULL, error_code = $4, next_attempt_at = $5, updated_at = $6, decision_request_id = coalesce($8, decision_request_id)
        WHERE id = $1 AND claim_token = $2 AND status = 'processing' AND lease_until > $6 AND configuration_revision = $7 RETURNING id`,
      [text(input.jobId, 'job ID'), text(input.claimToken, 'claim token'), input.terminal ? 'failed' : 'retry', text(input.errorCode, 'error code', 100), integer(input.nextAttemptAt, 'next attempt'), now, settings.revision, input.decisionRequestId ? text(input.decisionRequestId, 'decision request ID', 160) : null]);
      return updated.rows.length > 0;
    });
  }

  async readResultsBatch(messageRefs: string[]): Promise<StoredEmailClassificationResult[]> {
    if (!messageRefs.length) return [];
    if (messageRefs.length > 1_000) throw new Error('Too many result references.');
    const result = await this.postgres.query(`SELECT result.* FROM email_classification_results result JOIN email_classification_messages message ON message.message_ref = result.message_ref
      JOIN email_classification_mailboxes mailbox ON mailbox.mailbox_ref = message.mailbox_ref
      WHERE result.message_ref = ANY($1::text[]) AND mailbox.active`, [messageRefs.map(value => text(value, 'message reference'))]);
    return result.rows.map(resultFromRow);
  }

  async updateOverride(input: { messageRef: string; expectedVersion: number; overrides: EmailClassificationOverride; expectedBindingRevision?: string; expectedPolicyRevision?: string; now?: number }): Promise<StoredEmailClassificationResult> {
    const messageRef = text(input.messageRef, 'message reference'); const expected = integer(input.expectedVersion, 'expected result version');
    const overrides = validateEmailClassificationOverride(input.overrides); const now = integer(input.now ?? Date.now(), 'time');
    return this.transaction(async connection => {
      await this.lockSettings(connection);
      const message = (await connection.query(`SELECT message.message_ref, mailbox.binding_revision, mailbox.policy_revision FROM email_classification_messages message JOIN email_classification_mailboxes mailbox ON mailbox.mailbox_ref = message.mailbox_ref
        WHERE message.message_ref = $1 AND mailbox.active FOR UPDATE OF mailbox, message`, [messageRef])).rows[0];
      if (!message) throw new EmailClassificationStoreStateError();
      if (input.expectedBindingRevision !== undefined && input.expectedBindingRevision !== message.binding_revision
        || input.expectedPolicyRevision !== undefined && input.expectedPolicyRevision !== message.policy_revision) throw new EmailClassificationStoreStateError();
      const previous = (await connection.query('SELECT * FROM email_classification_results WHERE message_ref = $1 FOR UPDATE', [messageRef])).rows[0];
      if ((previous ? integer(previous.version, 'result version', 1) : 0) !== expected) throw new EmailClassificationVersionConflictError();
      const updated = expected === 0
        ? await connection.query(`INSERT INTO email_classification_results(message_ref,overrides_json,version,updated_at) VALUES ($1,$2::jsonb,1,$3) ON CONFLICT(message_ref) DO NOTHING RETURNING *`, [messageRef, JSON.stringify(overrides), now])
        : await connection.query('UPDATE email_classification_results SET overrides_json = $2::jsonb, version = version + 1, updated_at = $3 WHERE message_ref = $1 AND version = $4 RETURNING *', [messageRef, JSON.stringify(overrides), now, expected]);
      if (!updated.rows[0]) throw new EmailClassificationVersionConflictError();
      return resultFromRow(updated.rows[0]);
    });
  }

  async readPersonalFocusStates(userId: string, messageRefs: string[]): Promise<StoredEmailPersonalFocusState[]> {
    text(userId, 'focus user'); if (!messageRefs.length) return [];
    if (messageRefs.length > 1_000) throw new Error('Too many focus references.');
    const result = await this.postgres.query('SELECT * FROM email_classification_personal_focus WHERE user_id = $1 AND message_ref = ANY($2::text[])', [userId, messageRefs.map(value => text(value, 'message reference'))]);
    return result.rows.map(focusFromRow);
  }

  async setPersonalFocusState(input: { userId: string; messageRef: string; expectedVersion: number; done: boolean; expectedBindingRevision?: string; expectedPolicyRevision?: string; now?: number }): Promise<StoredEmailPersonalFocusState> {
    const userId = text(input.userId, 'focus user'); const messageRef = text(input.messageRef, 'message reference'); const expected = integer(input.expectedVersion, 'expected focus version');
    if (typeof input.done !== 'boolean') throw new Error('Invalid personal completion state.');
    const now = integer(input.now ?? Date.now(), 'time');
    return this.transaction(async connection => {
      await this.lockSettings(connection);
      const message = (await connection.query(`SELECT message.message_ref, mailbox.binding_revision, mailbox.policy_revision FROM email_classification_messages message JOIN email_classification_mailboxes mailbox ON mailbox.mailbox_ref = message.mailbox_ref
        WHERE message.message_ref = $1 AND mailbox.active FOR UPDATE OF mailbox, message`, [messageRef])).rows[0];
      if (!message) throw new EmailClassificationStoreStateError();
      if (input.expectedBindingRevision !== undefined && input.expectedBindingRevision !== message.binding_revision
        || input.expectedPolicyRevision !== undefined && input.expectedPolicyRevision !== message.policy_revision) throw new EmailClassificationStoreStateError();
      const previous = (await connection.query('SELECT * FROM email_classification_personal_focus WHERE user_id = $1 AND message_ref = $2 FOR UPDATE', [userId, messageRef])).rows[0];
      if ((previous ? integer(previous.version, 'focus version', 1) : 0) !== expected) throw new EmailClassificationVersionConflictError();
      const updated = expected === 0
        ? await connection.query('INSERT INTO email_classification_personal_focus(user_id,message_ref,done,version,updated_at) VALUES ($1,$2,$3,1,$4) ON CONFLICT(user_id,message_ref) DO NOTHING RETURNING *', [userId, messageRef, input.done, now])
        : await connection.query('UPDATE email_classification_personal_focus SET done = $3, version = version + 1, updated_at = $4 WHERE user_id = $1 AND message_ref = $2 AND version = $5 RETURNING *', [userId, messageRef, input.done, now, expected]);
      if (!updated.rows[0]) throw new EmailClassificationVersionConflictError();
      return focusFromRow(updated.rows[0]);
    });
  }
}

export function createEmailClassificationStore(options: { postgres: EmailClassificationQueryable; transaction: EmailClassificationTransaction }): PostgresEmailClassificationStore {
  return new PostgresEmailClassificationStore(options.postgres, options.transaction);
}

let runtimeStorePromise: Promise<PostgresEmailClassificationStore> | null = null;

export function getRuntimeEmailClassificationStore(): Promise<PostgresEmailClassificationStore> {
  runtimeStorePromise ??= import('@/app/lib/db').then(database => {
    database.assertDatabaseAvailable();
    const postgres = database.getPostgresRuntimeQueryable();
    if (!postgres) throw new Error('PostgreSQL runtime pool is not initialized.');
    const transaction: EmailClassificationTransaction = async operation => {
      const connection = await postgres.connect();
      let discard: Error | undefined;
      try {
        await connection.query('BEGIN');
        const result = await operation(connection);
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        try { await connection.query('ROLLBACK'); } catch (rollbackError) { discard = rollbackError instanceof Error ? rollbackError : new Error('Transaction rollback failed.'); }
        throw error;
      } finally { connection.release(discard); }
    };
    return createEmailClassificationStore({ postgres, transaction });
  }).catch(error => { runtimeStorePromise = null; throw error; });
  return runtimeStorePromise;
}

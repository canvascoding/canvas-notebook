import { EMAIL_CLASSIFICATION_FEED_STORAGE_UP_SQL } from './feed-postgres-migration';
import { emailClassificationSelectionSql, MAX_EMAIL_CLASSIFICATION_LOOKBACK_DAYS } from './selection';

type EmailClassificationMigrationQueryable = {
  query: (sql: string) => Promise<unknown>;
  exec?: (sql: string) => Promise<unknown>;
};

/** One additive batch is atomic under PostgreSQL's simple-query protocol. */
export const EMAIL_CLASSIFICATION_STORAGE_UP_SQL = `
  SELECT pg_advisory_xact_lock(hashtext('email-classification-storage-v1'));

  CREATE TABLE IF NOT EXISTS email_classification_settings (
    id text PRIMARY KEY CHECK (id = 'instance'),
    revision bigint NOT NULL CHECK (revision >= 1),
    configuration_json jsonb NOT NULL CHECK (jsonb_typeof(configuration_json) = 'object'),
    updated_at bigint NOT NULL,
    updated_by_user_id text REFERENCES "user"(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS email_classification_mailboxes (
    mailbox_ref text PRIMARY KEY,
    owner_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    account_source text NOT NULL CHECK (account_source IN ('local', 'managed')),
    account_id text NOT NULL,
    provider text NOT NULL,
    workspace_id text,
    mailbox_id text,
    binding_revision text NOT NULL,
    connection_revision text NOT NULL DEFAULT '',
    last_claimed_at bigint NOT NULL DEFAULT 0,
    policy_revision text NOT NULL,
    read_from_json jsonb NOT NULL CHECK (jsonb_typeof(read_from_json) = 'array'),
    active boolean NOT NULL,
    index_revision bigint NOT NULL DEFAULT 1 CHECK (index_revision >= 1),
    last_sync_at bigint,
    sync_cursor text,
    coverage text NOT NULL DEFAULT 'pending' CHECK (coverage IN ('pending', 'partial', 'complete', 'failed')),
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CHECK ((workspace_id IS NULL AND mailbox_id IS NULL) OR (workspace_id IS NOT NULL AND mailbox_id IS NOT NULL))
  );
  ALTER TABLE email_classification_mailboxes ADD COLUMN IF NOT EXISTS connection_revision text NOT NULL DEFAULT '';
  UPDATE email_classification_mailboxes SET connection_revision = binding_revision WHERE connection_revision = '';
  ALTER TABLE email_classification_mailboxes ADD COLUMN IF NOT EXISTS last_claimed_at bigint NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_email_classification_mailbox_owner
    ON email_classification_mailboxes(owner_user_id, active);
  CREATE INDEX IF NOT EXISTS idx_email_classification_mailbox_source
    ON email_classification_mailboxes(owner_user_id, account_source, account_id);

  CREATE TABLE IF NOT EXISTS email_classification_messages (
    message_ref text PRIMARY KEY,
    mailbox_ref text NOT NULL REFERENCES email_classification_mailboxes(mailbox_ref) ON DELETE CASCADE,
    canonical_id text NOT NULL,
    folder text NOT NULL,
    date_timestamp bigint,
    reply_status text NOT NULL CHECK (reply_status IN ('answered', 'unanswered', 'unknown')),
    accepted_reply_at bigint,
    in_inbox boolean NOT NULL DEFAULT true,
    last_seen_inbox_at bigint NOT NULL DEFAULT 0,
    fingerprint text NOT NULL,
    list_json jsonb NOT NULL CHECK (jsonb_typeof(list_json) = 'object'),
    index_revision bigint NOT NULL DEFAULT 1 CHECK (index_revision >= 1),
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    UNIQUE(mailbox_ref, canonical_id),
    UNIQUE(message_ref, mailbox_ref)
  );
  ALTER TABLE email_classification_messages ADD COLUMN IF NOT EXISTS in_inbox boolean NOT NULL DEFAULT true;
  ALTER TABLE email_classification_messages ADD COLUMN IF NOT EXISTS last_seen_inbox_at bigint NOT NULL DEFAULT 0;
  ALTER TABLE email_classification_messages ADD COLUMN IF NOT EXISTS accepted_reply_at bigint;
  CREATE INDEX IF NOT EXISTS idx_email_classification_message_mailbox_date
    ON email_classification_messages(mailbox_ref, date_timestamp DESC, message_ref);
  CREATE INDEX IF NOT EXISTS idx_email_classification_message_inbox_date
    ON email_classification_messages(mailbox_ref, date_timestamp DESC, message_ref) WHERE in_inbox;

  CREATE TABLE IF NOT EXISTS email_classification_jobs (
    id text PRIMARY KEY,
    message_ref text NOT NULL,
    mailbox_ref text NOT NULL,
    configuration_revision bigint NOT NULL CHECK (configuration_revision >= 1),
    evaluation_fingerprint text,
    fingerprint text NOT NULL,
    binding_revision text NOT NULL,
    policy_revision text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'processing', 'retry', 'completed', 'failed', 'canceled')),
    attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at bigint NOT NULL,
    lease_until bigint,
    claim_token text,
    error_code text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    UNIQUE(message_ref, configuration_revision, fingerprint),
    FOREIGN KEY(message_ref, mailbox_ref) REFERENCES email_classification_messages(message_ref, mailbox_ref) ON DELETE CASCADE,
    CHECK ((status = 'processing' AND lease_until IS NOT NULL AND claim_token IS NOT NULL)
      OR (status <> 'processing' AND lease_until IS NULL AND claim_token IS NULL))
  );
  ALTER TABLE email_classification_jobs ADD COLUMN IF NOT EXISTS evaluation_fingerprint text;
  ALTER TABLE email_classification_jobs ADD COLUMN IF NOT EXISTS decision_request_id text;
  CREATE INDEX IF NOT EXISTS idx_email_classification_job_evaluation
    ON email_classification_jobs(message_ref, evaluation_fingerprint);
  CREATE INDEX IF NOT EXISTS idx_email_classification_jobs_ready
    ON email_classification_jobs(status, next_attempt_at, lease_until);

  CREATE TABLE IF NOT EXISTS email_classification_results (
    message_ref text PRIMARY KEY REFERENCES email_classification_messages(message_ref) ON DELETE CASCADE,
    raw_json jsonb CHECK (raw_json IS NULL OR jsonb_typeof(raw_json) = 'object'),
    configuration_revision bigint,
    evaluation_fingerprint text,
    fingerprint text,
    binding_revision text,
    policy_revision text,
    result_revision bigint NOT NULL DEFAULT 0 CHECK (result_revision >= 0),
    overrides_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(overrides_json) = 'object'),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at bigint NOT NULL,
    CHECK ((raw_json IS NULL AND configuration_revision IS NULL AND fingerprint IS NULL AND binding_revision IS NULL AND policy_revision IS NULL)
      OR (raw_json IS NOT NULL AND configuration_revision IS NOT NULL AND configuration_revision >= 1 AND fingerprint IS NOT NULL AND binding_revision IS NOT NULL AND policy_revision IS NOT NULL))
  );
  ALTER TABLE email_classification_results ADD COLUMN IF NOT EXISTS evaluation_fingerprint text;

  CREATE TABLE IF NOT EXISTS email_classification_personal_focus (
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    message_ref text NOT NULL REFERENCES email_classification_messages(message_ref) ON DELETE CASCADE,
    done boolean NOT NULL,
    version bigint NOT NULL CHECK (version >= 1),
    updated_at bigint NOT NULL,
    PRIMARY KEY(user_id, message_ref)
  );

  CREATE TABLE IF NOT EXISTS email_classification_daily_budget (
    day_start bigint PRIMARY KEY CHECK (day_start >= 0),
    attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0)
  );

  CREATE TABLE IF NOT EXISTS email_classification_mailbox_sync_leases (
    mailbox_ref text PRIMARY KEY REFERENCES email_classification_mailboxes(mailbox_ref) ON DELETE CASCADE,
    claim_token text NOT NULL,
    lease_until bigint NOT NULL
  );

  -- Normalize legacy windows once; revisions fence requests started under the old limits.
  UPDATE email_classification_settings SET
    configuration_json = jsonb_set(configuration_json, '{initialLookbackDays}', '${MAX_EMAIL_CLASSIFICATION_LOOKBACK_DAYS}'::jsonb),
    revision = revision + 1, updated_at = (extract(epoch FROM CURRENT_TIMESTAMP) * 1000)::bigint
    WHERE jsonb_typeof(configuration_json->'initialLookbackDays') = 'number'
      AND (configuration_json->>'initialLookbackDays')::numeric > ${MAX_EMAIL_CLASSIFICATION_LOOKBACK_DAYS};
  UPDATE email_classification_jobs job SET status = 'canceled', lease_until = NULL, claim_token = NULL,
    error_code = 'not_selected', updated_at = (extract(epoch FROM CURRENT_TIMESTAMP) * 1000)::bigint
    FROM email_classification_messages message, email_classification_settings settings
    WHERE message.message_ref = job.message_ref AND settings.id = 'instance' AND job.status IN ('pending','processing','retry')
      AND NOT coalesce(${emailClassificationSelectionSql('message', '(extract(epoch FROM CURRENT_TIMESTAMP) * 1000)::bigint', "settings.configuration_json->>'initialLookbackDays'")},false);

  ${EMAIL_CLASSIFICATION_FEED_STORAGE_UP_SQL}
`;

export async function runEmailClassificationPostgresMigration(postgres: EmailClassificationMigrationQueryable): Promise<void> {
  if (postgres.exec) await postgres.exec(EMAIL_CLASSIFICATION_STORAGE_UP_SQL);
  else await postgres.query(EMAIL_CLASSIFICATION_STORAGE_UP_SQL);
}

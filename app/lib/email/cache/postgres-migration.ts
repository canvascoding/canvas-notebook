import type { Pool } from 'pg';

export type EmailCachePostgresQueryable = Pick<Pool, 'query'>;

/**
 * Installs the PostgreSQL-only email cache schema.
 *
 * These tables intentionally stay separate from the shared Drizzle schema.
 * The cache relies on PostgreSQL jsonb semantics.
 * Account ownership is re-authorized by the email service before every lookup.
 * The cache only binds users locally because managed Control Plane accounts do
 * not necessarily have a corresponding row in local email_accounts.
 */
export async function runEmailCachePostgresMigration(
  postgres: EmailCachePostgresQueryable,
): Promise<void> {
  await postgres.query(`
    CREATE TABLE IF NOT EXISTS email_cache_mailboxes (
      user_id text NOT NULL,
      account_source text NOT NULL CHECK (account_source IN ('local', 'managed')),
      account_id text NOT NULL,
      generation bigint NOT NULL DEFAULT 1 CHECK (generation >= 1),
      active boolean NOT NULL DEFAULT true,
      disconnected_at bigint,
      last_accessed_at bigint NOT NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      PRIMARY KEY (user_id, account_source, account_id),
      CONSTRAINT email_cache_mailboxes_disconnected_check
        CHECK ((active AND disconnected_at IS NULL) OR (NOT active AND disconnected_at IS NOT NULL)),
      CONSTRAINT email_cache_mailboxes_user_fk
        FOREIGN KEY (user_id)
        REFERENCES "user" (id)
        ON DELETE CASCADE
    )
  `);
  await postgres.query(`
    CREATE INDEX IF NOT EXISTS idx_email_cache_mailboxes_last_accessed
    ON email_cache_mailboxes (last_accessed_at)
  `);

  await postgres.query(`
    CREATE TABLE IF NOT EXISTS email_cache_lists (
      user_id text NOT NULL,
      account_source text NOT NULL CHECK (account_source IN ('local', 'managed')),
      account_id text NOT NULL,
      cache_key text NOT NULL,
      schema_version bigint NOT NULL,
      folder text NOT NULL,
      filter_json jsonb NOT NULL DEFAULT 'null'::jsonb,
      search_query text NOT NULL DEFAULT '',
      page_offset bigint NOT NULL CHECK (page_offset >= 0),
      page_limit bigint NOT NULL CHECK (page_limit > 0),
      refs_json jsonb,
      total_count bigint,
      generation bigint NOT NULL CHECK (generation >= 1),
      fetched_at bigint,
      stale_at bigint,
      expires_at bigint,
      refresh_owner text,
      refresh_lease_until bigint,
      last_accessed_at bigint NOT NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      PRIMARY KEY (user_id, account_source, account_id, cache_key),
      CONSTRAINT email_cache_lists_mailbox_fk
        FOREIGN KEY (user_id, account_source, account_id)
        REFERENCES email_cache_mailboxes (user_id, account_source, account_id)
        ON DELETE CASCADE,
      CONSTRAINT email_cache_lists_refs_array_check
        CHECK (refs_json IS NULL OR jsonb_typeof(refs_json) = 'array'),
      CONSTRAINT email_cache_lists_snapshot_timestamps_check
        CHECK (
          (refs_json IS NULL AND fetched_at IS NULL AND stale_at IS NULL AND expires_at IS NULL)
          OR
          (refs_json IS NOT NULL AND fetched_at IS NOT NULL AND stale_at IS NOT NULL AND expires_at IS NOT NULL
            AND fetched_at <= stale_at AND stale_at <= expires_at)
        )
    )
  `);
  await postgres.query(`
    CREATE INDEX IF NOT EXISTS idx_email_cache_lists_account_lru
    ON email_cache_lists (user_id, account_source, account_id, last_accessed_at DESC)
  `);
  await postgres.query(`
    CREATE INDEX IF NOT EXISTS idx_email_cache_lists_expiry
    ON email_cache_lists (expires_at)
    WHERE expires_at IS NOT NULL
  `);
  await postgres.query(`
    CREATE INDEX IF NOT EXISTS idx_email_cache_lists_refresh_lease
    ON email_cache_lists (refresh_lease_until)
    WHERE refresh_lease_until IS NOT NULL
  `);

  await postgres.query(`
    CREATE TABLE IF NOT EXISTS email_cache_messages (
      user_id text NOT NULL,
      account_source text NOT NULL CHECK (account_source IN ('local', 'managed')),
      account_id text NOT NULL,
      message_key text NOT NULL,
      provider text NOT NULL,
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
      generation bigint NOT NULL CHECK (generation >= 1),
      metadata_fetched_at bigint,
      metadata_stale_at bigint,
      detail_fetched_at bigint,
      detail_stale_at bigint,
      expires_at bigint,
      refresh_owner text,
      refresh_lease_until bigint,
      last_accessed_at bigint NOT NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      PRIMARY KEY (user_id, account_source, account_id, message_key),
      CONSTRAINT email_cache_messages_mailbox_fk
        FOREIGN KEY (user_id, account_source, account_id)
        REFERENCES email_cache_mailboxes (user_id, account_source, account_id)
        ON DELETE CASCADE,
      CONSTRAINT email_cache_messages_metadata_object_check
        CHECK (metadata_json IS NULL OR jsonb_typeof(metadata_json) = 'object'),
      CONSTRAINT email_cache_messages_detail_object_check
        CHECK (detail_json IS NULL OR jsonb_typeof(detail_json) = 'object'),
      CONSTRAINT email_cache_messages_metadata_timestamp_check
        CHECK (
          (metadata_json IS NULL AND metadata_fetched_at IS NULL AND metadata_stale_at IS NULL)
          OR
          (metadata_json IS NOT NULL AND metadata_fetched_at IS NOT NULL AND metadata_stale_at IS NOT NULL
            AND metadata_fetched_at <= metadata_stale_at)
        ),
      CONSTRAINT email_cache_messages_detail_timestamp_check
        CHECK (
          (detail_json IS NULL AND detail_fetched_at IS NULL AND detail_stale_at IS NULL)
          OR
          (detail_json IS NOT NULL AND detail_fetched_at IS NOT NULL AND detail_stale_at IS NOT NULL
            AND detail_fetched_at <= detail_stale_at)
        ),
      CONSTRAINT email_cache_messages_imap_identity_check
        CHECK (
          provider <> 'imap'
          OR (folder IS NOT NULL AND folder <> '' AND uid_validity IS NOT NULL AND uid IS NOT NULL AND uid > 0)
        )
    )
  `);
  await postgres.query(`
    CREATE INDEX IF NOT EXISTS idx_email_cache_messages_account_lru
    ON email_cache_messages (user_id, account_source, account_id, last_accessed_at DESC)
  `);
  await postgres.query(`
    CREATE INDEX IF NOT EXISTS idx_email_cache_messages_expiry
    ON email_cache_messages (expires_at)
    WHERE expires_at IS NOT NULL
  `);
  await postgres.query(`
    CREATE INDEX IF NOT EXISTS idx_email_cache_messages_refresh_lease
    ON email_cache_messages (refresh_lease_until)
    WHERE refresh_lease_until IS NOT NULL
  `);
}

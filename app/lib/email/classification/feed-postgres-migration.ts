export const EMAIL_CLASSIFICATION_FEED_STORAGE_UP_SQL = `
  SELECT pg_advisory_xact_lock(hashtext('email-classification-feed-v1'));
  CREATE TABLE IF NOT EXISTS email_classification_feed_snapshots (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    selector_hash text NOT NULL,
    authorization_signature text NOT NULL,
    index_signature text NOT NULL,
    settings_revision bigint NOT NULL,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    counts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    coverage_json jsonb NOT NULL DEFAULT '[]'::jsonb
  );
  CREATE INDEX IF NOT EXISTS idx_email_classification_feed_snapshot_user
    ON email_classification_feed_snapshots(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_email_classification_feed_snapshot_expiry
    ON email_classification_feed_snapshots(expires_at);
  CREATE TABLE IF NOT EXISTS email_classification_feed_rows (
    snapshot_id text NOT NULL REFERENCES email_classification_feed_snapshots(id) ON DELETE CASCADE,
    ordinal bigint NOT NULL CHECK (ordinal > 0),
    message_ref text NOT NULL REFERENCES email_classification_messages(message_ref) ON DELETE CASCADE,
    mailbox_ref text NOT NULL,
    canonical_id text NOT NULL,
    folder text NOT NULL,
    list_json jsonb NOT NULL,
    classification_json jsonb NOT NULL,
    focus_version bigint NOT NULL,
    PRIMARY KEY(snapshot_id, ordinal),
    UNIQUE(snapshot_id, message_ref)
  );
  CREATE INDEX IF NOT EXISTS idx_email_classification_feed_row_group
    ON email_classification_feed_rows(snapshot_id, (classification_json->>'group'), ordinal);
`;

export async function runEmailClassificationFeedPostgresMigration(postgres: { query(sql: string): Promise<unknown>; exec?: (sql: string) => Promise<unknown> }): Promise<void> {
  if (postgres.exec) await postgres.exec(EMAIL_CLASSIFICATION_FEED_STORAGE_UP_SQL);
  else await postgres.query(EMAIL_CLASSIFICATION_FEED_STORAGE_UP_SQL);
}

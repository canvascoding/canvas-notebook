import type { SqlConnection } from '../db';

/** An all-null historical/physical target is never a native document grant. */
export const PUBLIC_FILE_SHARE_TARGET_BINDING_CHECK_SQL = `(
  (document_id IS NULL AND lineage_id IS NULL AND lifecycle_generation IS NULL)
  OR (document_id IS NOT NULL AND lineage_id IS NOT NULL AND lifecycle_generation IS NOT NULL
    AND workspace_id IS NOT NULL AND length(workspace_id) BETWEEN 1 AND 256
    AND workspace_id=btrim(workspace_id) AND workspace_id!~'[[:cntrl:]]'
    AND length(document_id) BETWEEN 1 AND 256 AND document_id=btrim(document_id)
    AND document_id!~'[[:cntrl:]]'
    AND length(lineage_id) BETWEEN 1 AND 256 AND lineage_id=btrim(lineage_id)
    AND lineage_id!~'[[:cntrl:]]'
    AND lifecycle_generation BETWEEN 1 AND 9007199254740990)
)`;

/** Additive only: no existing row is rebound or backfilled from its path. */
export const PUBLIC_FILE_SHARE_TARGET_BINDING_STATEMENTS = [
  `ALTER TABLE public_file_shares
    ADD COLUMN IF NOT EXISTS document_id text,
    ADD COLUMN IF NOT EXISTS lineage_id text,
    ADD COLUMN IF NOT EXISTS lifecycle_generation bigint`,
  `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_constraint
      WHERE conrelid='public_file_shares'::regclass AND conname='public_file_share_target_binding_check') THEN
      ALTER TABLE public_file_shares ADD CONSTRAINT public_file_share_target_binding_check
        CHECK ${PUBLIC_FILE_SHARE_TARGET_BINDING_CHECK_SQL};
    END IF;
  END $$`,
] as const;

/** The caller owns schema selection and any surrounding migration transaction. */
export async function runPublicFileShareTargetBindingMigration(database: Pick<SqlConnection, 'run'>): Promise<void> {
  for (const statement of PUBLIC_FILE_SHARE_TARGET_BINDING_STATEMENTS) await database.run(statement);
}

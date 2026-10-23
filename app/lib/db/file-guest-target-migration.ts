import type { SqlConnection } from '../db';

/** NULL/NULL is historical, unbound invitation data, never a document grant. */
export const FILE_GUEST_TARGET_BINDING_CHECK_SQL = `(
  (lifecycle_generation IS NULL AND lineage_id IS NULL)
  OR (lifecycle_generation IS NOT NULL AND lineage_id IS NOT NULL
    AND lifecycle_generation BETWEEN 1 AND 9007199254740990
    AND length(lineage_id) BETWEEN 1 AND 256 AND lineage_id=btrim(lineage_id)
    AND lineage_id!~'[[:cntrl:]]')
)`;

/** Additive only. Existing invitations are deliberately not rebound or backfilled. */
export const FILE_GUEST_TARGET_BINDING_STATEMENTS = [
  `ALTER TABLE file_guest_invitations
    ADD COLUMN IF NOT EXISTS lifecycle_generation bigint,
    ADD COLUMN IF NOT EXISTS lineage_id text`,
  `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_constraint
      WHERE conrelid='file_guest_invitations'::regclass AND conname='file_guest_target_binding_check') THEN
      ALTER TABLE file_guest_invitations ADD CONSTRAINT file_guest_target_binding_check
        CHECK ${FILE_GUEST_TARGET_BINDING_CHECK_SQL};
    END IF;
  END $$`,
] as const;

/** The caller owns schema selection and any surrounding migration transaction. */
export async function runFileGuestTargetBindingMigration(database: Pick<SqlConnection, 'run'>): Promise<void> {
  for (const statement of FILE_GUEST_TARGET_BINDING_STATEMENTS) await database.run(statement);
}

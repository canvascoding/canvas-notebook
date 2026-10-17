/** The database bounds bytes, independently of the payload codec's JSON shape. */
export const CHAT_MESSAGE_ADMISSION_MAX_PRIVATE_PAYLOAD_BYTES = 4_194_304;

/**
 * Additive upgrade of the existing delivery receipts, without reinterpreting
 * hash-only legacy rows. One DO statement is atomic in PostgreSQL and works
 * through both native and prepared-query migration transports.
 * Constraints are also declared in schema.ts for schema-driven fresh installs.
 */
export const CHAT_MESSAGE_ADMISSION_UP_SQL = `
  DO $chat_message_admission$ BEGIN
  ALTER TABLE pi_message_delivery_receipts
    ADD COLUMN IF NOT EXISTS payload_version bigint,
    ADD COLUMN IF NOT EXISTS private_payload text,
    ADD COLUMN IF NOT EXISTS execution_phase text,
    ADD COLUMN IF NOT EXISTS execution_revision bigint;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'pi_message_delivery_receipts'::regclass
        AND conname = 'pi_message_delivery_receipts_admission_shape_check'
    ) THEN
      ALTER TABLE pi_message_delivery_receipts
        ADD CONSTRAINT pi_message_delivery_receipts_admission_shape_check CHECK (
          (payload_version IS NULL AND private_payload IS NULL
            AND execution_phase IS NULL AND execution_revision IS NULL)
          OR (payload_version = 1 AND private_payload IS NOT NULL
            AND execution_phase IN ('queued', 'dispatching', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown')
            AND execution_revision BETWEEN 1 AND 9007199254740991 AND state = 'accepted') IS TRUE
        );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'pi_message_delivery_receipts'::regclass
        AND conname = 'pi_message_delivery_receipts_private_payload_size_check'
    ) THEN
      ALTER TABLE pi_message_delivery_receipts
        ADD CONSTRAINT pi_message_delivery_receipts_private_payload_size_check
        CHECK (private_payload IS NULL OR octet_length(private_payload) <= 4194304);
    END IF;
  END $chat_message_admission$;
`;

export async function runChatMessageAdmissionMigration(database: { query(sql: string): Promise<unknown> }): Promise<void> {
  await database.query(CHAT_MESSAGE_ADMISSION_UP_SQL);
}

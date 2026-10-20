/**
 * Queue position is separate from the immutable accepted message intent. Old
 * receipts, including version-one admissions, remain unpositioned: startup
 * must not infer replay eligibility from their payload or execution phase.
 * This single statement also upgrades partially installed nullable columns.
 */
export const CHAT_MESSAGE_QUEUE_UP_SQL = `
  DO $chat_message_queue$ BEGIN
    ALTER TABLE pi_sessions
      ADD COLUMN IF NOT EXISTS message_queue_ordinal bigint NOT NULL DEFAULT 0;
    ALTER TABLE pi_sessions
      ALTER COLUMN message_queue_ordinal SET DEFAULT 0;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'pi_sessions'::regclass
        AND conname = 'pi_sessions_message_queue_ordinal_check'
    ) THEN
      ALTER TABLE pi_sessions
        ADD CONSTRAINT pi_sessions_message_queue_ordinal_check
        CHECK (message_queue_ordinal BETWEEN 0 AND 9007199254740991);
    END IF;
    ALTER TABLE pi_message_delivery_receipts
      ADD COLUMN IF NOT EXISTS queue_lane text,
      ADD COLUMN IF NOT EXISTS queue_ordinal bigint,
      ADD COLUMN IF NOT EXISTS queue_disposition text;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'pi_message_delivery_receipts'::regclass
        AND conname = 'pi_message_delivery_receipts_queue_shape_check'
    ) THEN
      ALTER TABLE pi_message_delivery_receipts
        ADD CONSTRAINT pi_message_delivery_receipts_queue_shape_check CHECK (
          (queue_lane IS NULL AND queue_ordinal IS NULL AND queue_disposition IS NULL)
          OR (payload_version = 1 AND state = 'accepted'
            AND queue_lane IN ('prompt', 'follow_up', 'steer')
            AND queue_ordinal BETWEEN 1 AND 9007199254740991
            AND queue_disposition IN ('ready', 'suspended')) IS TRUE
        );
    END IF;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_message_delivery_receipts_queue_ordinal
      ON pi_message_delivery_receipts (pi_session_db_id, queue_ordinal)
      WHERE queue_ordinal IS NOT NULL;
    UPDATE pi_sessions session
      SET message_queue_ordinal = GREATEST(COALESCE(session.message_queue_ordinal, 0), receipt.max_ordinal)
      FROM (
        SELECT current_session.id, COALESCE(MAX(receipt.queue_ordinal), 0) AS max_ordinal
        FROM pi_sessions current_session
        LEFT JOIN pi_message_delivery_receipts receipt ON receipt.pi_session_db_id = current_session.id
        GROUP BY current_session.id
      ) receipt
      WHERE session.id = receipt.id
        AND (session.message_queue_ordinal IS NULL OR session.message_queue_ordinal < receipt.max_ordinal);
    ALTER TABLE pi_sessions ALTER COLUMN message_queue_ordinal SET NOT NULL;
  END $chat_message_queue$;
`;

export async function runChatMessageQueueMigration(database: { query(sql: string): Promise<unknown> }): Promise<void> {
  await database.query(CHAT_MESSAGE_QUEUE_UP_SQL);
}

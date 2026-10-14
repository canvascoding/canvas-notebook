/** Deduplication only. The stored payload is validated by admission; this index
 * neither authenticates a channel nor grants access/execution authority. */
export const TELEGRAM_MESSAGE_SOURCE_UNIQUE_INDEX = 'idx_pi_message_delivery_receipts_telegram_user_source';

/** No backfill or repair: conflicting historical provider IDs fail startup. */
export const CHAT_MESSAGE_TELEGRAM_SOURCE_UP_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_message_delivery_receipts_telegram_user_source
    ON pi_message_delivery_receipts ((private_payload::jsonb -> 'identity' ->> 'userId'), client_message_id)
    WHERE payload_version = 1 AND private_payload IS NOT NULL
      AND client_message_id ~ '^telegram:[0-9a-f]{64}$';
`;

export async function runChatMessageTelegramSourceMigration(database: { query(sql: string): Promise<unknown> }): Promise<void> {
  await database.query(CHAT_MESSAGE_TELEGRAM_SOURCE_UP_SQL);
}

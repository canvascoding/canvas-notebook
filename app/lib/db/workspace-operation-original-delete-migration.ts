import type { SqlConnection } from '../db';

/** Private schema contract for the genuine Owner-B gate. These names describe
 * storage only; neither a ledger row nor a schema name grants mutation rights. */
export const WORKSPACE_OPERATION_ORIGINAL_DELETE_TABLE_SPECS = [
  {
    table: 'workspace_file_operation_delete_intents',
    columns: ['batch_id', 'plan_id', 'workspace_id', 'request_hash', 'intent_text', 'intent_digest', 'created_at'],
    primaryKey: ['batch_id'],
    uniqueKeys: [['batch_id', 'intent_digest']],
    foreignKeys: [{ columns: ['batch_id'], table: 'workspace_file_operation_batches', referencedColumns: ['batch_id'] }],
    immutableTrigger: 'workspace_file_operation_delete_intents_immutable',
  },
  {
    table: 'workspace_file_operation_delete_trash_receipts',
    columns: ['batch_id', 'intent_digest', 'receipt_text', 'receipt_digest', 'created_at'],
    primaryKey: ['batch_id'],
    uniqueKeys: [],
    foreignKeys: [{ columns: ['batch_id', 'intent_digest'], table: 'workspace_file_operation_delete_intents',
      referencedColumns: ['batch_id', 'intent_digest'] }],
    immutableTrigger: 'workspace_file_operation_delete_trash_receipts_immutable',
  },
  {
    table: 'workspace_file_operation_delete_receipts',
    columns: ['batch_id', 'intent_digest', 'receipt_text', 'receipt_digest', 'created_at'],
    primaryKey: ['batch_id'],
    uniqueKeys: [],
    foreignKeys: [{ columns: ['batch_id', 'intent_digest'], table: 'workspace_file_operation_delete_intents',
      referencedColumns: ['batch_id', 'intent_digest'] }],
    immutableTrigger: 'workspace_file_operation_delete_receipts_immutable',
  },
] as const;

export const WORKSPACE_OPERATION_ORIGINAL_DELETE_IMMUTABLE_FUNCTION = 'reject_workspace_file_operation_delete_mutation';

const createdAt = `created_at bigint NOT NULL DEFAULT
  floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint
  CHECK (created_at BETWEEN 0 AND 9007199254740990)`;
const batchId = `batch_id text PRIMARY KEY CHECK (char_length(batch_id) BETWEEN 16 AND 128
  AND batch_id=btrim(batch_id) AND batch_id!~'[[:cntrl:]]')`;
const digestCheck = (name: string, text: string) => `${name} text NOT NULL CHECK (${name} ~ '^[a-f0-9]{64}$'
  AND ${name}=encode(sha256(convert_to(${text},'UTF8')),'hex'))`;

/** Additive, append-only original Delete evidence. A fresh runtime claim may
 * resume the same original batch; no lease token or current-path backfill lives
 * in these rows. The caller owns migration ordering and its transaction. */
export const WORKSPACE_OPERATION_ORIGINAL_DELETE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS workspace_file_operation_delete_intents (
    ${batchId} REFERENCES workspace_file_operation_batches(batch_id),
    plan_id text NOT NULL CHECK (plan_id ~ '^[a-f0-9]{64}$'),
    workspace_id text NOT NULL CHECK (char_length(workspace_id) BETWEEN 1 AND 256
      AND workspace_id=btrim(workspace_id) AND workspace_id!~'[[:cntrl:]]'),
    request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    intent_text text NOT NULL CHECK (octet_length(intent_text) BETWEEN 1 AND 1048576),
    ${digestCheck('intent_digest', 'intent_text')},
    ${createdAt},
    UNIQUE(batch_id,intent_digest)
  )`,
  ...['workspace_file_operation_delete_trash_receipts', 'workspace_file_operation_delete_receipts'].map(table =>
    `CREATE TABLE IF NOT EXISTS ${table} (
      ${batchId},
      intent_digest text NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
      receipt_text text NOT NULL CHECK (octet_length(receipt_text) BETWEEN 1 AND 2097152),
      ${digestCheck('receipt_digest', 'receipt_text')},
      ${createdAt},
      FOREIGN KEY(batch_id,intent_digest) REFERENCES workspace_file_operation_delete_intents(batch_id,intent_digest)
    )`),
  `CREATE OR REPLACE FUNCTION ${WORKSPACE_OPERATION_ORIGINAL_DELETE_IMMUTABLE_FUNCTION}()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Original Delete evidence is immutable' USING ERRCODE='55000';
    END $$`,
  ...WORKSPACE_OPERATION_ORIGINAL_DELETE_TABLE_SPECS.map(spec => `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='${spec.table}'::regclass AND tgname='${spec.immutableTrigger}') THEN
      CREATE TRIGGER ${spec.immutableTrigger} BEFORE UPDATE OR DELETE ON ${spec.table}
        FOR EACH ROW EXECUTE FUNCTION ${WORKSPACE_OPERATION_ORIGINAL_DELETE_IMMUTABLE_FUNCTION}();
    END IF;
  END $$`),
] as const;

export async function runWorkspaceOperationOriginalDeleteMigration(database: Pick<SqlConnection, 'run'>): Promise<void> {
  for (const statement of WORKSPACE_OPERATION_ORIGINAL_DELETE_STATEMENTS) await database.run(statement);
}

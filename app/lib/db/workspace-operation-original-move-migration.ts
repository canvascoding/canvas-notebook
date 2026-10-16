import type { SqlConnection } from '../db';

/** Mechanical, append-only storage only. These rows confer no actor, Claim,
 * lifecycle, filesystem, DA04 or execution authority. The original Owner and
 * domain codec must validate the complete JSON and budgets before any IO. */
export const WORKSPACE_OPERATION_ORIGINAL_MOVE_TABLE_SPECS = [
  { table: 'workspace_file_operation_move_intents',
    columns: ['batch_id', 'plan_id', 'workspace_id', 'request_hash', 'intent_text', 'intent_digest', 'created_at'],
    primaryKey: ['batch_id'], uniqueKeys: [['batch_id', 'intent_digest']],
    foreignKeys: [{ columns: ['batch_id'], table: 'workspace_file_operation_batches', referencedColumns: ['batch_id'] }],
    immutableTrigger: 'workspace_file_operation_move_intents_immutable' },
  { table: 'workspace_file_operation_move_parent_receipts',
    columns: ['batch_id', 'intent_digest', 'parent_key', 'parent_path', 'producer_step', 'consumer_bindings_text',
      'consumer_bindings_digest', 'receipt_text', 'receipt_digest', 'created_at'],
    primaryKey: ['batch_id', 'parent_key'], uniqueKeys: [],
    foreignKeys: [{ columns: ['batch_id', 'intent_digest'], table: 'workspace_file_operation_move_intents', referencedColumns: ['batch_id', 'intent_digest'] }],
    immutableTrigger: 'workspace_file_operation_move_parent_receipts_immutable' },
  { table: 'workspace_file_operation_move_path_receipts',
    columns: ['batch_id', 'intent_digest', 'step_key', 'receipt_text', 'receipt_digest', 'created_at'],
    primaryKey: ['batch_id', 'step_key'], uniqueKeys: [],
    foreignKeys: [{ columns: ['batch_id', 'intent_digest'], table: 'workspace_file_operation_move_intents', referencedColumns: ['batch_id', 'intent_digest'] }],
    immutableTrigger: 'workspace_file_operation_move_path_receipts_immutable' },
  { table: 'workspace_file_operation_move_receipts',
    columns: ['batch_id', 'intent_digest', 'receipt_text', 'receipt_digest', 'created_at'],
    primaryKey: ['batch_id'], uniqueKeys: [],
    foreignKeys: [{ columns: ['batch_id', 'intent_digest'], table: 'workspace_file_operation_move_intents', referencedColumns: ['batch_id', 'intent_digest'] }],
    immutableTrigger: 'workspace_file_operation_move_receipts_immutable' },
] as const;

export const WORKSPACE_OPERATION_ORIGINAL_MOVE_IMMUTABLE_FUNCTION = 'reject_workspace_file_operation_move_mutation';
const identifier = (name: string, min = 1, max = 256) => `${name} text NOT NULL
  CHECK (char_length(${name}) BETWEEN ${min} AND ${max} AND ${name}=btrim(${name}) AND ${name}!~'[[:cntrl:]]')`;
const digest = (name: string, source?: string) => `${name} text NOT NULL CHECK (${name}~'^[a-f0-9]{64}$'
  ${source ? `AND ${name}=encode(sha256(convert_to(${source},'UTF8')),'hex')` : ''})`;
const created = `created_at bigint NOT NULL DEFAULT floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::bigint
  CHECK (created_at BETWEEN 0 AND 9007199254740990)`;
const original = `${identifier('batch_id', 16, 128)}, ${digest('intent_digest')},
  FOREIGN KEY(batch_id,intent_digest) REFERENCES workspace_file_operation_move_intents(batch_id,intent_digest)`;
const receipt = (max: number) => `receipt_text text NOT NULL CHECK (octet_length(receipt_text) BETWEEN 1 AND ${max}),
  ${digest('receipt_digest', 'receipt_text')}, ${created}`;

/** The caller retains migration ordering, schema selection and transaction. */
export const WORKSPACE_OPERATION_ORIGINAL_MOVE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS workspace_file_operation_move_intents (
    ${identifier('batch_id', 16, 128)} PRIMARY KEY REFERENCES workspace_file_operation_batches(batch_id),
    ${digest('plan_id')}, ${identifier('workspace_id')}, ${digest('request_hash')},
    intent_text text NOT NULL CHECK (octet_length(intent_text) BETWEEN 1 AND 16777216),
    ${digest('intent_digest', 'intent_text')}, ${created}, UNIQUE(batch_id,intent_digest)
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_file_operation_move_parent_receipts (
    ${original},
    parent_path text NOT NULL CHECK (octet_length(parent_path) BETWEEN 1 AND 4096
      AND parent_path!~'(^/|/$|//|(^|/)[.]{1,2}(/|$)|[[:cntrl:]])' AND position(chr(92) IN parent_path)=0),
    ${digest('parent_key', 'parent_path')}, ${identifier('producer_step')},
    consumer_bindings_text text NOT NULL CHECK (octet_length(consumer_bindings_text) BETWEEN 2 AND 1048576
      AND jsonb_typeof(consumer_bindings_text::jsonb)='array' AND jsonb_array_length(consumer_bindings_text::jsonb) BETWEEN 1 AND 1000),
    ${digest('consumer_bindings_digest', 'consumer_bindings_text')}, ${receipt(1048576)},
    CHECK (octet_length(consumer_bindings_text)+octet_length(receipt_text)<=1048576), PRIMARY KEY(batch_id,parent_key)
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_file_operation_move_path_receipts (
    ${original}, ${identifier('step_key')}, ${receipt(67108864)}, PRIMARY KEY(batch_id,step_key)
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_file_operation_move_receipts (
    ${original}, ${receipt(1048576)}, PRIMARY KEY(batch_id)
  )`,
  `CREATE OR REPLACE FUNCTION ${WORKSPACE_OPERATION_ORIGINAL_MOVE_IMMUTABLE_FUNCTION}()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Original Move evidence is immutable' USING ERRCODE='55000';
    END $$`,
  ...WORKSPACE_OPERATION_ORIGINAL_MOVE_TABLE_SPECS.map(spec => `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='${spec.table}'::regclass AND tgname='${spec.immutableTrigger}') THEN
      CREATE TRIGGER ${spec.immutableTrigger} BEFORE UPDATE OR DELETE ON ${spec.table}
        FOR EACH ROW EXECUTE FUNCTION ${WORKSPACE_OPERATION_ORIGINAL_MOVE_IMMUTABLE_FUNCTION}();
    END IF;
  END $$`),
] as const;

export async function runWorkspaceOperationOriginalMoveMigration(database: Pick<SqlConnection, 'run'>): Promise<void> {
  for (const statement of WORKSPACE_OPERATION_ORIGINAL_MOVE_STATEMENTS) await database.run(statement);
}

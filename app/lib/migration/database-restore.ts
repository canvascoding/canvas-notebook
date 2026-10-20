import 'server-only';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import { portableDatabaseLines, parsePortableDatabaseHeader } from './database-stream';
import { DATABASE_RECEIPTS, portableSchemaHash, readPortableDatabaseSchema, sqlName, type PortableDatabaseHeader, type PortableTable, type PortableForeignKey } from './database-schema';
import { preserveMigrationTable } from './database-policy';
import { mapDatabaseUsers } from './database-mappings';
import { portableDatabaseProviderConfig } from './database-config';
import type { CanvasMigrationManifest, MigrationImportUserMapping } from './types';
import { assertDatabaseWorkspaceRoot, type DatabaseWorkspaceRoot } from './database-workspaces';
import { assertRestoreAncestors } from './restore-plan';
import { getMigrationDataRoot } from './paths';

export type StagedDatabase = { header: PortableDatabaseHeader; tables: Map<string, { table: PortableTable; temporary: string }>;
  foreignKeys: PortableForeignKey[]; users: MigrationImportUserMapping[]; rows: number };

export async function ensureDatabaseRestoreReceipts(client: Client): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS ${sqlName(DATABASE_RECEIPTS)} (id text PRIMARY KEY, committed_at bigint NOT NULL)`);
}
export async function databaseRestoreWasCommitted(client: Client, id: string): Promise<boolean> {
  await ensureDatabaseRestoreReceipts(client);
  return (await client.query(`SELECT id FROM ${sqlName(DATABASE_RECEIPTS)} WHERE id=$1`, [id])).rowCount === 1;
}

/** The caller owns BEGIN/COMMIT. Every source row is bound as JSON to trusted target types. */
export async function stagePortableDatabase(client: Client, filename: string, manifest: CanvasMigrationManifest): Promise<StagedDatabase> {
  const schema = await readPortableDatabaseSchema(client);
  const source = portableDatabaseLines(createReadStream(filename));
  const first = await source.next();
  if (first.done) throw new Error('Database snapshot is empty.');
  const header = parsePortableDatabaseHeader(first.value);
  const organization = (await client.query<{ organization_id: string }>('SELECT organization_id FROM canvas_organization_settings ORDER BY created_at LIMIT 1')).rows[0]?.organization_id;
  if (header.organizationId !== organization || manifest.source?.organizationId !== organization) throw new Error('Database restore cannot change target organization or license ownership.');
  if (header.schemaHash !== portableSchemaHash(header.tables) || header.schemaHash !== portableSchemaHash(schema.tables)) throw new Error('Database schema or portability policy changed before restore.');
  if (JSON.stringify(header.users) !== JSON.stringify(manifest.users)) throw new Error('Database user inventory changed.');
  const targets = (await client.query<{ id: string; email: string | null }>('SELECT id,email FROM "user"')).rows;
  const users = mapDatabaseUsers(header.users, targets);
  const tables = new Map<string, { table: PortableTable; temporary: string }>();
  for (const [index, table] of schema.tables.entries()) {
    if (table.mode !== 'copy') continue;
    const temporary = 'migration_rows_' + index;
    await client.query(`CREATE TEMP TABLE ${sqlName(temporary)} (LIKE public.${sqlName(table.name)} INCLUDING GENERATED) ON COMMIT DROP`);
    tables.set(table.name, { table, temporary });
  }
  let rows = 0; let end = false;
  try {
    for await (const line of source) {
      if (end) throw new Error('Database snapshot has records after its trailer.');
      if (line.startsWith('{"end":')) {
        const trailer = JSON.parse(line) as { end: boolean; rowCount: number };
        if (trailer.end !== true || trailer.rowCount !== rows) throw new Error('Database snapshot row count is incomplete.');
        end = true; continue;
      }
      const record = /^\{"table":"([a-z_][a-z0-9_]*)","row":(\{[\s\S]*\})\}$/u.exec(line);
      const target = record && tables.get(record[1]);
      if (!record || !target) throw new Error('Database snapshot contains an unknown or excluded table.');
      const value = JSON.parse(record[2]) as Record<string, unknown>;
      if (!value || Array.isArray(value) || Object.keys(value).length !== target.table.columns.length
        || target.table.columns.some(column => !Object.hasOwn(value, column.name))) throw new Error('Database snapshot row has unknown or missing columns.');
      const columns = target.table.columns.map(column => sqlName(column.name)).join(',');
      await client.query(`INSERT INTO ${sqlName(target.temporary)} (${columns}) SELECT ${columns} FROM json_populate_record(NULL::public.${sqlName(target.table.name)},$1::json)`, [record[2]]);
      if (++rows > 100_000_000) throw new Error('Database snapshot row limit exceeded.');
    }
  } finally { await source.return(undefined); }
  if (!end) throw new Error('Database snapshot has no completed trailer.');
  const imported = tables.get('user');
  if (!imported) throw new Error('Database snapshot has no user table.');
  const actual = (await client.query(`SELECT id,email FROM ${sqlName(imported.temporary)} ORDER BY id`)).rows;
  if (JSON.stringify(actual) !== JSON.stringify(header.users)) throw new Error('Database rows and approved user inventory differ.');
  await client.query('CREATE TEMP TABLE migration_user_map (source text PRIMARY KEY,target text UNIQUE NOT NULL) ON COMMIT DROP');
  for (const user of users) await client.query('INSERT INTO migration_user_map VALUES ($1,$2)', [user.sourceUserId, user.targetUserId]);
  for (const { table, temporary } of tables.values()) if (table.nullColumns?.length) {
    await client.query(`UPDATE ${sqlName(temporary)} SET ${table.nullColumns.map(column => sqlName(column) + '=NULL').join(',')}`);
  }
  const workspaces = tables.get('canvas_workspaces');
  if (workspaces) {
    const roots = (await client.query<DatabaseWorkspaceRoot>(`SELECT id,type,root_relative_path AS "rootRelativePath",owner_user_id AS "ownerUserId",organization_id AS "organizationId" FROM ${sqlName(workspaces.temporary)}`)).rows;
    for (const workspace of roots) {
      assertDatabaseWorkspaceRoot(workspace);
      await assertRestoreAncestors(getMigrationDataRoot(), workspace.rootRelativePath);
    }
    for (const expected of manifest.workspaces ?? []) {
      const actual = roots.find(workspace => workspace.id === expected.id);
      if (!actual || actual.rootRelativePath !== expected.rootRelativePath || actual.type !== expected.type
        || actual.ownerUserId !== expected.ownerUserId || actual.organizationId !== expected.organizationId) throw new Error('Database and file workspace inventories differ. Retry the export.');
    }
  }
  const accounts = tables.get('account');
  if (accounts) await client.query(`UPDATE ${sqlName(accounts.temporary)} SET access_token=NULL,refresh_token=NULL,id_token=NULL,access_token_expires_at=NULL,refresh_token_expires_at=NULL`);
  const jobs = tables.get('automation_jobs'); if (jobs) await client.query(`UPDATE ${sqlName(jobs.temporary)} SET status='paused'`);
  const email = tables.get('email_accounts'); if (email) await client.query(`UPDATE ${sqlName(email.temporary)} SET status='disconnected'`);
  for (const name of ['studio_generations', 'studio_bulk_jobs', 'studio_bulk_job_line_items']) {
    const table = tables.get(name);
    if (table) await client.query(`UPDATE ${sqlName(table.temporary)} SET status='failed' WHERE status NOT IN ('completed','partial','failed','cancelled','canceled','success','succeeded')`);
  }
  const delegations = tables.get('pi_delegations');
  if (delegations) await client.query(`UPDATE ${sqlName(delegations.temporary)} SET status='cancelled' WHERE status IN ('queued','running')`);
  const provider = tables.get('ai_provider_installations');
  if (provider) {
    const configs = (await client.query<{ id: string; config_json: string | null }>(`SELECT id,config_json FROM ${sqlName(provider.temporary)}`)).rows;
    for (const config of configs) await client.query(`UPDATE ${sqlName(provider.temporary)} SET config_json=$1,enabled=0,status='unverified' WHERE id=$2`, [portableDatabaseProviderConfig(config.id, config.config_json), config.id]);
  }
  const yjs = tables.get('collaboration_yjs_states'); if (yjs) await client.query(`UPDATE ${sqlName(yjs.temporary)} SET room_owner_token=NULL,room_owner_backend_pid=NULL,room_owner_backend_start=NULL`);
  return { header, tables, foreignKeys: schema.foreignKeys, users, rows };
}

async function preservedDatabaseHash(client: Client): Promise<string> {
  const hash = createHash('sha256');
  const names = (await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename);
  for (const name of names.filter(preserveMigrationTable)) {
    hash.update(name);
    const result = await client.query<{ value: string }>(`SELECT row_to_json(t)::text value FROM public.${sqlName(name)} t ORDER BY row_to_json(t)::text`);
    for (const row of result.rows) hash.update(row.value + '\n');
  }
  return hash.digest('hex');
}

/** Replaces application tables inside the transaction; target license/Team Seat rows are never written. */
export async function replacePortableDatabase(client: Client, stage: StagedDatabase): Promise<void> {
  const preserved = await preservedDatabaseHash(client);
  // Application transition triggers govern new edits, not loading already
  // committed history. Internal constraint triggers stay enabled throughout.
  const triggers = (await client.query<{ table_name: string; trigger_name: string; enabled: string }>(`SELECT c.relname table_name,t.tgname trigger_name,t.tgenabled enabled
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname=ANY($1::text[]) ORDER BY c.relname,t.tgname`,
  [stage.header.tables.map(table => table.name)])).rows;
  for (const trigger of triggers) if (trigger.enabled !== 'D') {
    await client.query(`ALTER TABLE public.${sqlName(trigger.table_name)} DISABLE TRIGGER ${sqlName(trigger.trigger_name)}`);
  }
  const fkChanges = stage.foreignKeys.filter(key => !key.deferrable);
  for (const key of fkChanges) await client.query(`ALTER TABLE public.${sqlName(key.child)} ALTER CONSTRAINT ${sqlName(key.name)} DEFERRABLE INITIALLY DEFERRED`);
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  const clear = stage.header.tables.filter(table => !['user', 'account'].includes(table.name)).map(table => 'public.' + sqlName(table.name));
  await client.query('TRUNCATE ' + clear.join(','));
  const user = stage.tables.get('user')!;
  const userColumns = user.table.columns.map(column => sqlName(column.name));
  await client.query(`INSERT INTO public."user" (${userColumns.join(',')}) SELECT ${userColumns.join(',')} FROM ${sqlName(user.temporary)}
    ON CONFLICT (id) DO UPDATE SET ${userColumns.filter(column => column !== '"id"').map(column => column + '=EXCLUDED.' + column).join(',')}`);
  // Retain accounts of target-only licensed/bootstrap users. Imported identities
  // receive the source credential records with their approved target user IDs.
  await client.query('DELETE FROM account WHERE user_id IN (SELECT target FROM migration_user_map)');
  for (const { table, temporary } of stage.tables.values()) {
    if (table.name === 'user') continue;
    const columns = table.columns.map(column => sqlName(column.name)).join(',');
    await client.query(`INSERT INTO public.${sqlName(table.name)} (${columns}) SELECT ${columns} FROM ${sqlName(temporary)}`);
  }
  // Drain deferred foreign-key events before ALTER TABLE restores trigger modes.
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  for (const trigger of triggers) if (trigger.enabled !== 'D') {
    const mode = trigger.enabled === 'A' ? 'ENABLE ALWAYS' : trigger.enabled === 'R' ? 'ENABLE REPLICA' : 'ENABLE';
    await client.query(`ALTER TABLE public.${sqlName(trigger.table_name)} ${mode} TRIGGER ${sqlName(trigger.trigger_name)}`);
  }
  for (const key of fkChanges) await client.query(`ALTER TABLE public.${sqlName(key.child)} ALTER CONSTRAINT ${sqlName(key.name)} NOT DEFERRABLE INITIALLY IMMEDIATE`);
  if (await preservedDatabaseHash(client) !== preserved) throw new Error('Database restore would change target licensing or Team Seat state.');
  for (const sequence of stage.header.sequences ?? []) {
    const table = stage.tables.get(sequence.table)?.table;
    if (!table?.columns.some(column => column.name === sequence.column) || !/^[0-9]{1,19}$/u.test(sequence.value)
      || BigInt(sequence.value) > BigInt('9223372036854775807')) throw new Error('Invalid portable sequence metadata.');
    const name = (await client.query<{ name: string | null }>('SELECT pg_get_serial_sequence($1,$2) name', ['public.' + sqlName(table.name), sequence.column])).rows[0]?.name;
    if (!name || !/^public\.[a-z_][a-z0-9_]*$/u.test(name)) throw new Error('Portable sequence does not match the target schema.');
    const current = (await client.query<{ value: string }>(`SELECT last_value::text value FROM public.${sqlName(name.slice(7))}`)).rows[0].value;
    const maximum = (await client.query<{ value: string }>(`SELECT COALESCE(MAX(${sqlName(sequence.column)}),0)::text value FROM public.${sqlName(table.name)}`)).rows[0].value;
    const value = [current, maximum, sequence.value].map(BigInt).reduce((a, b) => a > b ? a : b);
    // Sequence advances are intentionally monotonic, including on rollback.
    await client.query('SELECT setval($1::regclass,$2::bigint,true)', [name, value.toString()]);
  }
}

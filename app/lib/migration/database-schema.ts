import 'server-only';
import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import { PORTABLE_DATABASE_TABLES, preserveMigrationTable, resetMigrationTable } from './database-policy';

export const DATABASE_ARTIFACT = 'data/database/postgres.jsonl.gz';
export const DATABASE_RECEIPTS = 'canvas_migration_restore_receipts';
export type PortableColumn = { name: string; type: string };
export type PortableTable = { name: string; columns: PortableColumn[]; mode: 'copy' | 'reset' };
export type PortableDatabaseHeader = { format: 'canvas-postgres-rows'; version: 1; schemaHash: string;
  organizationId: string; tables: PortableTable[]; users: Array<{ id: string; email: string | null }>;
  sequences?: Array<{ table: string; column: string; value: string }> };
export type PortableForeignKey = { child: string; parent: string; name: string; deferred: boolean; deferrable: boolean; userColumns: string[] };
export function sqlName(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsupported PostgreSQL migration identifier.');
  return '"' + value + '"';
}
export function portableSchemaHash(tables: PortableTable[]): string {
  return createHash('sha256').update(JSON.stringify(tables)).digest('hex');
}

export async function portableSequences(client: Client, tables: PortableTable[]): Promise<Array<{ table: string; column: string; value: string }>> {
  const sequences: Array<{ table: string; column: string; value: string }> = [];
  for (const table of tables.filter(table => table.mode === 'copy')) for (const column of table.columns) {
    const name = (await client.query<{ name: string | null }>('SELECT pg_get_serial_sequence($1,$2) name', ['public.' + sqlName(table.name), column.name])).rows[0]?.name;
    if (!name) continue;
    if (!/^public\.[a-z_][a-z0-9_]*$/u.test(name)) throw new Error('Unsupported portable PostgreSQL sequence.');
    const value = (await client.query<{ value: string }>(`SELECT last_value::text value FROM public.${sqlName(name.slice(7))}`)).rows[0].value;
    sequences.push({ table: table.name, column: column.name, value });
  }
  return sequences;
}
export async function readPortableDatabaseSchema(client: Client): Promise<{ tables: PortableTable[]; foreignKeys: PortableForeignKey[] }> {
  const result = await client.query<{ table_name: string; name: string; type: string }>(`SELECT c.relname table_name,a.attname name,format_type(a.atttypid,a.atttypmod) type
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated=''
    ORDER BY c.relname,a.attnum`);
  const byName = new Map<string, PortableTable>();
  for (const row of result.rows) {
    sqlName(row.table_name); sqlName(row.name);
    if (preserveMigrationTable(row.table_name)) continue;
    if (!PORTABLE_DATABASE_TABLES.has(row.table_name)) throw new Error('Database portability policy needs review for table ' + row.table_name + '.');
    let table = byName.get(row.table_name);
    if (!table) { table = { name: row.table_name, columns: [], mode: resetMigrationTable(row.table_name) ? 'reset' : 'copy' }; byName.set(row.table_name, table); }
    table.columns.push({ name: row.name, type: row.type });
  }
  const foreignKeys = (await client.query<PortableForeignKey>(`SELECT c.conname name,r.relname child,p.relname parent,c.condeferrable deferrable,c.condeferred deferred,
    COALESCE(array_agg(a.attname ORDER BY k.ordinality) FILTER (WHERE p.relname='user'),ARRAY[]::name[]) AS "userColumns"
    FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_class p ON p.oid=c.confrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace JOIN unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality) ON true
    JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.attnum WHERE c.contype='f' AND n.nspname='public'
    GROUP BY c.oid,r.relname,p.relname ORDER BY r.relname,c.conname`)).rows;
  // A copied child cannot retain a reference to deliberately excluded authority.
  let changed = true;
  while (changed) {
    changed = false;
    for (const fk of foreignKeys) {
      const child = byName.get(fk.child);
      if (child?.mode === 'copy' && byName.get(fk.parent)?.mode === 'reset') { child.mode = 'reset'; changed = true; }
    }
  }
  for (const fk of foreignKeys) if (preserveMigrationTable(fk.child) && !preserveMigrationTable(fk.parent) && fk.parent !== 'user') {
    throw new Error('Preserved instance state has an unsupported dependency on ' + fk.parent + '.');
  }
  return { tables: [...byName.values()], foreignKeys };
}

export function databaseExportExpression(table: PortableTable, column: PortableColumn): string {
  if (table.name === 'account' && /^(?:access_token|refresh_token|id_token)(?:_expires_at)?$/u.test(column.name)) return 'NULL AS ' + sqlName(column.name);
  if (table.name === 'collaboration_yjs_states' && /^room_owner_(?:token|backend_pid|backend_start)$/u.test(column.name)) return 'NULL AS ' + sqlName(column.name);
  if (table.name === 'automation_jobs' && column.name === 'status') return "'paused' AS status";
  if (table.name === 'ai_provider_installations' && column.name === 'enabled') return '0 AS enabled';
  if (table.name === 'ai_provider_installations' && column.name === 'status') return "'unverified' AS status";
  if (table.name === 'ai_provider_installations' && column.name === 'config_json') return '($1::jsonb ->> id) AS config_json';
  if (table.name === 'email_accounts' && column.name === 'status') return "'disconnected' AS status";
  if (table.name === 'pi_delegations' && column.name === 'status') return "CASE WHEN status IN ('queued','running') THEN 'cancelled' ELSE status END AS status";
  if (['studio_generations', 'studio_bulk_jobs', 'studio_bulk_job_line_items'].includes(table.name) && column.name === 'status') {
    return "CASE WHEN status IN ('completed','partial','failed','cancelled','canceled','success','succeeded') THEN status ELSE 'failed' END AS status";
  }
  return sqlName(column.name);
}

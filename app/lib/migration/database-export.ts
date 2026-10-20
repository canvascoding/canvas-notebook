import 'server-only';
import { promises as fs, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { Client } from 'pg';
import { readPortableDatabaseSchema, portableSchemaHash, portableSequences, sqlName, databaseExportExpression,
  type PortableDatabaseHeader } from './database-schema';
import { migrationFileSha256 } from './archive';
import { portableDatabaseProviderConfig } from './database-config';
import { assertDatabaseWorkspaceRoot, type DatabaseWorkspaceRoot } from './database-workspaces';

/** A repeatable-read logical snapshot contains data, never executable SQL/DDL. */
export async function exportPortableDatabase(filename: string): Promise<{ header: PortableDatabaseHeader; bytes: number; sha256: string }> {
  if (!process.env.DATABASE_URL) throw new Error('PostgreSQL migration requires DATABASE_URL.');
  const client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { tables } = await readPortableDatabaseSchema(client);
    const organizationId = (await client.query<{ organization_id: string }>('SELECT organization_id FROM canvas_organization_settings ORDER BY created_at LIMIT 1')).rows[0]?.organization_id;
    if (!organizationId) throw new Error('PostgreSQL migration requires an initialized organization.');
    const users = (await client.query<{ id: string; email: string | null }>('SELECT id,email FROM "user" ORDER BY id')).rows;
    const workspaces = (await client.query<DatabaseWorkspaceRoot>('SELECT id,type,root_relative_path AS "rootRelativePath",owner_user_id AS "ownerUserId",organization_id AS "organizationId" FROM canvas_workspaces')).rows;
    workspaces.forEach(assertDatabaseWorkspaceRoot);
    const header: PortableDatabaseHeader = { format: 'canvas-postgres-rows', version: 1, schemaHash: portableSchemaHash(tables), organizationId, tables, users,
      sequences: await portableSequences(client, tables) };
    async function* lines() {
      yield JSON.stringify(header) + '\n';
      let rowCount = 0;
      for (const table of tables.filter(table => table.mode === 'copy')) {
        const columns = table.columns.map(column => databaseExportExpression(table, column)).join(',');
        let parameters: string[] = [];
        if (table.name === 'ai_provider_installations') {
          const providers = (await client.query<{ id: string; config_json: string | null }>('SELECT id,config_json FROM ai_provider_installations')).rows;
          parameters = [JSON.stringify(Object.fromEntries(providers.map(row => [row.id, portableDatabaseProviderConfig(row.id, row.config_json)])))];
        }
        await client.query(`DECLARE migration_export_cursor NO SCROLL CURSOR FOR SELECT row_to_json(r)::text AS value FROM (SELECT ${columns} FROM public.${sqlName(table.name)}) r`, parameters);
        try {
          for (;;) {
            const result = await client.query<{ value: string }>('FETCH FORWARD 16 FROM migration_export_cursor');
            if (!result.rows.length) break;
            for (const row of result.rows) {
              if (Buffer.byteLength(row.value) > 64 * 1024 ** 2) throw new Error('A database row exceeds the portable 64 MiB limit.');
              // Embedding the raw server JSON preserves bigint digits and bytea.
              yield '{"table":' + JSON.stringify(table.name) + ',"row":' + row.value + '}\n'; rowCount++;
            }
          }
        } finally { await client.query('CLOSE migration_export_cursor'); }
      }
      yield JSON.stringify({ end: true, rowCount }) + '\n';
    }
    await pipeline(Readable.from(lines()), createGzip({ level: 1 }), createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
    await client.query('COMMIT');
    return { header, bytes: (await fs.stat(filename)).size, sha256: await migrationFileSha256(filename) };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); await fs.rm(filename, { force: true }); throw error; }
  finally { await client.end(); }
}

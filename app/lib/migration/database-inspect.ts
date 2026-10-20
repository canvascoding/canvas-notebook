import 'server-only';
import type { File as ZipFile } from 'unzipper';
import { Client } from 'pg';
import { portableDatabaseLines, parsePortableDatabaseHeader } from './database-stream';
import { DATABASE_ARTIFACT, readPortableDatabaseSchema, portableSchemaHash } from './database-schema';
import type { CanvasMigrationManifest } from './types';

export async function inspectPortableDatabase(entry: ZipFile, manifest: CanvasMigrationManifest): Promise<void> {
  if (entry.path !== DATABASE_ARTIFACT || manifest.exportProfile !== 'full_admin' || manifest.selection?.includePersonalWorkspaces !== true
    || manifest.database?.backupKind !== 'postgres_rows' || !manifest.database.artifactSha256
    || manifest.files.find(file => file.archivePath === entry.path)?.sha256 !== manifest.database.artifactSha256) throw new Error('Portable database metadata or explicit personal-data scope is missing.');
  let header;
  for await (const line of portableDatabaseLines(entry.stream())) { header = parsePortableDatabaseHeader(line); break; }
  if (!header) throw new Error('Database snapshot is empty.');
  const client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
  try {
    const { tables } = await readPortableDatabaseSchema(client);
    const organization = (await client.query<{ organization_id: string }>('SELECT organization_id FROM canvas_organization_settings ORDER BY created_at LIMIT 1')).rows[0]?.organization_id;
    if (header.organizationId !== organization || manifest.source?.organizationId !== organization) throw new Error('Database migration requires the same organization on source and target; target licensing cannot be reassigned by an archive.');
    if (header.schemaHash !== portableSchemaHash(header.tables) || header.schemaHash !== portableSchemaHash(tables)) throw new Error('Portable database schemas or portability policies differ. Update both instances before migrating.');
    if (JSON.stringify(header.users) !== JSON.stringify(manifest.users)) throw new Error('Database and manifest user inventories differ. Retry the export.');
  } finally { await client.end(); }
}

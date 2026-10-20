import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { Client } from 'pg';

async function main() {
  if (process.env.EXPORT_MIGRATION_ACCEPTANCE !== '1') throw new Error('Explicit isolated acceptance mode is required.');
  const root = path.join(os.homedir(), '.local/state/canvas-local-team-seat/export-migration-99b4');
  const env = parse(await fs.readFile(path.join(root, 'source.env')));
  if (new URL(env.DATABASE_URL).pathname !== '/canvas_export_99b4_source' || env.DATA !== path.join(root, 'source-data')) throw new Error('Refusing a non-fixture database/data root.');
  Object.assign(process.env, env);
  const { prepareRestoreFileJournal, publishRestoreFiles, rollbackRestoreFiles, restoreJournalPath } = await import('../app/lib/migration/restore-files');
  const { closeDatabaseConnections } = await import('../app/lib/db');
  const client = new Client({ connectionString: env.DATABASE_URL }); await client.connect();
  const id = randomUUID();
  let journal: Awaited<ReturnType<typeof prepareRestoreFileJournal>> | null = null;
  try {
    assert.equal(await fs.stat(restoreJournalPath()).then(() => true, () => false), false);
    const row = (await client.query<{ workspace_id: string; path: string; root_relative_path: string }>(`SELECT d.workspace_id,d.path,w.root_relative_path FROM collaboration_documents d
      JOIN canvas_workspaces w ON w.id=d.workspace_id WHERE d.status='active' AND w.status='active'
      AND d.path LIKE 'export-99b4/current-%.md' ORDER BY d.created_at DESC LIMIT 1`)).rows[0];
    assert.ok(row, 'A native Markdown fixture must exist.');
    const file = path.join(env.DATA, row.root_relative_path, row.path); const original = await fs.readFile(file);
    const state = async () => (await client.query('SELECT id,status,lineage_id,state_version::text,yjs_state_lifecycle FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 ORDER BY id', [row.workspace_id, row.path])).rows;
    const before = await state();
    const stage = `.migration/restores/${id}/rollback-fixture`;
    await fs.mkdir(path.dirname(path.join(env.DATA, stage)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(env.DATA, stage), 'temporary replaced fixture', { mode: 0o600 });
    journal = await prepareRestoreFileJournal({ id, dataRoot: env.DATA, directories: [], files: [
      { target: row.root_relative_path + '/' + row.path, staged: stage, workspaceId: row.workspace_id, workspacePath: row.path },
      { target: row.root_relative_path + '/export-99b4/rollback-new-' + id + '.txt', staged: stage + '-missing', workspaceId: row.workspace_id, workspacePath: 'export-99b4/rollback-new-' + id + '.txt' },
    ] });
    await assert.rejects(publishRestoreFiles(env.DATA, journal), /ENOENT/);
    assert.ok((await state()).some(document => document.status === 'archived'));
    await rollbackRestoreFiles(env.DATA, journal);
    await rollbackRestoreFiles(env.DATA, journal);
    assert.deepEqual(await fs.readFile(file), original);
    assert.deepEqual(await state(), before, 'Native identity, active status and durable state must be restored.');
    await fs.rm(restoreJournalPath(), { force: true });
    journal = null;
    await fs.rm(path.join(env.DATA, '.migration/restores', id), { recursive: true, force: true });
    console.log('PASS: real PostgreSQL native lineage is archived during interrupted publication and restored with original file bytes and Yjs state.');
  } finally {
    if (journal) { await rollbackRestoreFiles(env.DATA, journal); await fs.rm(restoreJournalPath(), { force: true }); }
    await client.end(); await closeDatabaseConnections();
  }
}
main().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : 'Native rollback acceptance failed.'); process.exit(1); });

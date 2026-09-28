import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { Client, Pool } from 'pg';

import { lockProposalDocumentIdentityRows } from '../app/lib/file-version-center/proposal-document-identity-lock';
import type { FileVersionCenterTransaction } from '../app/lib/file-version-center/database';

const WORKSPACE_ID = 'fvrc-lock-workspace';
const DOCUMENT_ID = 'fvrc-lock-document';
const LINEAGE_ID = 'fvrc-lock-lineage';

async function waitForLineageBlock(observer: Pool, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ wait_event_type: string | null; query: string }>(`
      SELECT wait_event_type, query FROM pg_stat_activity WHERE pid = $1
    `, [pid]);
    if (result.rows[0]?.wait_event_type === 'Lock'
      && result.rows[0].query.includes('file_collaboration_lineages')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The graph identity reader did not block on the lineage row first.');
}

async function main(): Promise<void> {
  if (process.env.COLLABORATION_E2E !== '1') throw new Error('The real PostgreSQL lock test requires COLLABORATION_E2E=1.');
  let databaseUrl: URL;
  try { databaseUrl = new URL(process.env.DATABASE_URL || ''); }
  catch { throw new Error('The real PostgreSQL lock test requires a local DATABASE_URL.'); }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(databaseUrl.hostname) || databaseUrl.port !== '55433') {
    throw new Error('The real PostgreSQL lock test is restricted to the managed loopback PostgreSQL service.');
  }
  const schema = `fvrc_identity_lock_${randomBytes(8).toString('hex')}`;
  const observer = new Pool({ connectionString: databaseUrl.toString(), max: 2 });
  const checkpoint = new Client({ connectionString: databaseUrl.toString() });
  const review = new Client({ connectionString: databaseUrl.toString() });
  let schemaCreated = false;
  let checkpointOpen = false;
  let reviewOpen = false;
  try {
    await observer.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await observer.query(`CREATE TABLE "${schema}".file_collaboration_lineages (id text PRIMARY KEY, workspace_id text NOT NULL)`);
    await observer.query(`CREATE TABLE "${schema}".collaboration_documents (id text PRIMARY KEY, workspace_id text NOT NULL, lineage_id text)`);
    await observer.query(`CREATE TABLE "${schema}".collaboration_yjs_states (document_id text PRIMARY KEY, workspace_id text NOT NULL)`);
    await observer.query(`INSERT INTO "${schema}".file_collaboration_lineages (id,workspace_id) VALUES ($1,$2)`, [LINEAGE_ID, WORKSPACE_ID]);
    await observer.query(`INSERT INTO "${schema}".collaboration_documents (id,workspace_id,lineage_id) VALUES ($1,$2,$3)`,
      [DOCUMENT_ID, WORKSPACE_ID, LINEAGE_ID]);
    await observer.query(`INSERT INTO "${schema}".collaboration_yjs_states (document_id,workspace_id) VALUES ($1,$2)`,
      [DOCUMENT_ID, WORKSPACE_ID]);
    await checkpoint.connect(); checkpointOpen = true;
    await review.connect(); reviewOpen = true;
    await checkpoint.query('BEGIN');
    await review.query('BEGIN');
    await checkpoint.query(`SET LOCAL search_path TO "${schema}"`);
    await review.query(`SET LOCAL search_path TO "${schema}"`);
    await checkpoint.query('SET LOCAL statement_timeout = 5000');
    await review.query('SET LOCAL statement_timeout = 5000');
    const reviewPid = (await review.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;

    // The file checkpoint owns lineage before it writes the document row.
    await checkpoint.query('SELECT id FROM file_collaboration_lineages WHERE id = $1 FOR UPDATE', [LINEAGE_ID]);
    const transaction: FileVersionCenterTransaction = { query: async <Row>(sql: string, params?: unknown[]) => {
      const result = await review.query(sql, params);
      return { rows: result.rows as Row[] };
    } };
    const graphLock = lockProposalDocumentIdentityRows(transaction, { documentId: DOCUMENT_ID, workspaceId: WORKSPACE_ID });
    await waitForLineageBlock(observer, reviewPid);

    // A joined document-first FOR UPDATE would have held this row and deadlocked
    // with the checkpoint. The ordered helper holds no document row yet.
    await checkpoint.query('SELECT id FROM collaboration_documents WHERE id = $1 FOR UPDATE NOWAIT', [DOCUMENT_ID]);
    await checkpoint.query('UPDATE collaboration_documents SET lineage_id = $1 WHERE id = $2', [LINEAGE_ID, DOCUMENT_ID]);
    await checkpoint.query('COMMIT');
    assert.equal(await graphLock, LINEAGE_ID);
    await review.query('COMMIT');
    console.log('Real PostgreSQL lineage → document → state lock-order regression passed.');
  } finally {
    if (checkpointOpen) {
      try { await checkpoint.query('ROLLBACK'); } catch { /* Connection may already be closed. */ }
      await checkpoint.end();
    }
    if (reviewOpen) {
      try { await review.query('ROLLBACK'); } catch { /* Connection may already be closed. */ }
      await review.end();
    }
    if (schemaCreated) await observer.query(`DROP SCHEMA "${schema}" CASCADE`);
    await observer.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool, types } from 'pg';
import * as Y from 'yjs';
import type { SqlConnection } from '../app/lib/db';
import { COLLABORATION_NATIVE_COPY_STATEMENTS } from '../app/lib/db/collaboration-native-copy-migration';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { loadCollaborationStateOnConnection } from '../app/lib/collaboration/persistence';
import { persistNativeWorkspaceCopies, type NativeCopyRequest } from '../app/lib/collaboration/native-copy-persistence';
import { readNativeWorkspaceRecoveryRecords } from '../app/lib/collaboration/workspace-native-recovery';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';

const PREFIX = 'canvas_native_copy_test_';
const SCHEMA = new RegExp(`^${PREFIX}[0-9a-f]{32}$`, 'u');
const TABLES = ['file_collaboration_lineages', 'collaboration_documents', 'collaboration_yjs_states',
  'collaboration_yjs_state_backups', 'collaboration_agent_operations', 'collaboration_excalidraw_states',
  'file_revisions', 'file_locks', 'file_guest_invitations', 'collaboration_admission_requests',
  'collaboration_admission_scopes', 'collaboration_admission_targets'] as const;
type Fault = { commit?: 'before' | 'after'; afterCommit?: () => Promise<void> };

function managedDatabase(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  const url = new URL(process.env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.port !== '55433' || decodeURIComponent(url.pathname) !== '/canvas_notebook') {
    throw new Error('Native copy test accepts only managed loopback PG18 at 55433/canvas_notebook.');
  }
  return url;
}
function identifier(schema: string): string {
  if (!SCHEMA.test(schema)) throw new Error('Refusing a non-generated native-copy schema.');
  return `"${schema}"`;
}
function connectionFactory(pool: Pool, fault: Fault = {}) {
  return async (): Promise<SqlConnection> => {
    const client = await pool.connect(); let closed = false;
    const query = async (sql: string, values: unknown[] = []) => {
      if (/^COMMIT$/iu.test(sql) && fault.commit === 'before') { delete fault.commit; throw new Error('Injected commit response failure'); }
      const result = await client.query(sql, values);
      if (/^COMMIT$/iu.test(sql) && fault.commit === 'after') {
        delete fault.commit; await fault.afterCommit?.(); throw new Error('Injected committed response failure');
      }
      return result.rows;
    };
    return { run: query, all: query, get: async (sql, values) => (await query(sql, values))[0],
      close: async error => { if (!closed) { closed = true; client.release(error); } } };
  };
}
function workspace(id: string): WorkspaceContext {
  return { workspaceId: id, organizationId: null, workspaceType: 'personal', ownerUserId: 'native-copy-tester',
    rootPath: '/unused-native-copy-fixture', legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false, canManageWorkspace: true, canRunAgent: true } };
}
async function main() {
  const url = managedDatabase();
  if (!url) { console.log('SKIP native copy PostgreSQL fixtures: managed PG18 connection not supplied.'); return; }
  const schema = `${PREFIX}${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 3000, allowExitOnIdle: true });
  let pool: Pool | undefined;
  try {
    const version = await admin.query(`SELECT current_setting('server_version_num')::int AS version,current_database() AS database`);
    assert.equal(Math.floor(version.rows[0].version / 10000), 18); assert.equal(version.rows[0].database, 'canvas_notebook');
    for (const table of TABLES) assert.equal((await admin.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${table}`])).rows[0].present, true);
    await admin.query(`CREATE SCHEMA ${identifier(schema)}`);
    pool = new Pool({ connectionString: url.toString(), max: 6, connectionTimeoutMillis: 3000, allowExitOnIdle: true,
      // Match the production SqlConnection INT8 decoder without changing global pg parsers.
      types: { getTypeParser: (oid, format) => oid === types.builtins.INT8 ? (value: string) => Number.parseInt(value, 10) : types.getTypeParser(oid, format) },
      options: `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=8000`, application_name: 'native-copy-isolated-fixtures' });
    const fixturePool = pool;
    for (const table of TABLES) await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    for (const statement of COLLABORATION_NATIVE_COPY_STATEMENTS) await pool.query(statement);
    for (const statement of COLLABORATION_NATIVE_COPY_STATEMENTS) await pool.query(statement);
    const sourceWorkspace = workspace(`${schema}-source`); const targetWorkspace = workspace(`${schema}-target`);
    const openConnection = connectionFactory(pool);
    for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
      const sourceDoc = nativeTableWidthFixture(representation, 'A\tB\r\n😀');
      const sourceId = `${schema}-${representation}`; const lineageId = `lineage-${sourceId}`; const sourcePath = `${representation}.md`;
      try {
        sourceDoc.getText('frontmatter').insert(0, '---\r\ntitle: Private DB fixture\r\n---\r\n');
        sourceDoc.getText('bodyFinalLineEnding').insert(0, '\r\n\r\n');
        await pool.query(`INSERT INTO file_collaboration_lineages (id,workspace_id,workspace_type,path,status,created_at)
          VALUES ($1,$2,'personal',$3,'active',1)`, [lineageId, sourceWorkspace.workspaceId, sourcePath]);
        await pool.query(`INSERT INTO collaboration_documents (id,lineage_id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at)
          VALUES ($1,$2,$3,'personal',$4,'yjs','active',0,1,1)`, [sourceId, lineageId, sourceWorkspace.workspaceId, sourcePath]);
        await pool.query(`INSERT INTO collaboration_yjs_states (document_id,workspace_id,path,representation,lifecycle_generation,schema_version,
          yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,newline_style,has_bom,degraded,status)
          VALUES ($1,$2,$3,$4,1,1,$5,$6,3,1,0,'crlf',1,0,'active')`,
        [sourceId, sourceWorkspace.workspaceId, sourcePath, representation, Buffer.from(Y.encodeStateAsUpdate(sourceDoc)), Buffer.from(Y.encodeStateVector(sourceDoc))]);
        const read = await openConnection();
        let records;
        try { records = await readNativeWorkspaceRecoveryRecords(read, sourceWorkspace, sourcePath); }
        finally { await read.close(); }
        assert.equal(records.length, 1);
        const input: NativeCopyRequest = { operationId: `copy-${representation}`, actorUserId: 'native-copy-tester', actorSessionId: 'fixture-session',
          kind: 'native_clone', sourceWorkspace, targetWorkspace, targetScopes: [`copy-${representation}.md`],
          copies: [{ source: records[0], targetPath: `copy-${representation}.md` }], expectedTargets: [] };
        const receipt = await persistNativeWorkspaceCopies(input, openConnection);
        assert.equal(receipt.publicationStatus, 'native_committed'); assert.equal(receipt.documents.length, 1);
        const target = receipt.documents[0].clone;
        assert.notEqual(target.documentId, sourceId); assert.notEqual(target.lineageId, lineageId);
        const readTarget = await openConnection();
        let clonedState;
        try { clonedState = await loadCollaborationStateOnConnection(readTarget, target.documentId); }
        finally { await readTarget.close(); }
        assert.ok(clonedState); assert.equal(clonedState.hasBom, true); assert.equal(clonedState.newlineStyle, 'crlf');
        assert.equal(clonedState.documentSequence, 0); assert.equal(clonedState.checkpointedAt, null);
        const native = authoritativeNativeCollaborationSnapshot(clonedState);
        assert.equal(native.version.stateProof, target.stateProof); assert.match(JSON.stringify(native.content), /"colwidth":\[120\]/u);
        assert.deepEqual(await persistNativeWorkspaceCopies(input, openConnection), receipt);
        // A later peer edit changes the current proof. The atomically committed ledger still proves this initial copy.
        const edited = new Y.Doc(); Y.applyUpdate(edited, clonedState.yjsState); edited.getText('frontmatter').insert(0, '# peer metadata\n');
        await pool.query(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,document_sequence=1 WHERE document_id=$3`,
        [Buffer.from(Y.encodeStateAsUpdate(edited)), Buffer.from(Y.encodeStateVector(edited)), target.documentId]); edited.destroy();
        assert.deepEqual(await persistNativeWorkspaceCopies(input, openConnection), receipt);
        await assert.rejects(() => persistNativeWorkspaceCopies({ ...input, actorUserId: 'other-user' }, openConnection));
        await assert.rejects(() => persistNativeWorkspaceCopies({ ...input, copies: [{ ...input.copies[0], targetPath: 'changed.md' }], targetScopes: ['changed.md'] }, openConnection));
        const afterInput = { ...input, operationId: `lost-after-${representation}`, targetScopes: [`after-${representation}.md`],
          copies: [{ source: records[0], targetPath: `after-${representation}.md` }] };
        const recovered = await persistNativeWorkspaceCopies(afterInput, connectionFactory(pool, { commit: 'after' }));
        assert.equal(recovered.documents.length, 1);
        assert.deepEqual(await persistNativeWorkspaceCopies(afterInput, openConnection), recovered);
        const beforeInput = { ...input, operationId: `lost-before-${representation}`, targetScopes: [`before-${representation}.md`],
          copies: [{ source: records[0], targetPath: `before-${representation}.md` }] };
        await assert.rejects(() => persistNativeWorkspaceCopies(beforeInput, connectionFactory(fixturePool, { commit: 'before' })), /Injected commit/u);
        assert.equal((await pool.query(`SELECT count(*)::int AS count FROM collaboration_native_copy_receipts WHERE operation_id=$1`, [beforeInput.operationId])).rows[0].count, 0);
        assert.equal((await pool.query(`SELECT count(*)::int AS count FROM collaboration_documents WHERE workspace_id=$1 AND path=$2`, [targetWorkspace.workspaceId, beforeInput.copies[0].targetPath])).rows[0].count, 0);
        // Lifecycle rebinding must never turn an old receipt into a new identity at the same path.
        await pool.query(`UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1`, [target.documentId]);
        await assert.rejects(() => persistNativeWorkspaceCopies(input, openConnection));
      } finally { sourceDoc.destroy(); }
    }
    // Missing state after historical initialization is unavailable even when a registry row still exists.
    await pool.query(`INSERT INTO collaboration_documents (id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at)
      VALUES ($1,$2,'personal','missing.md','yjs','active',1,1,1)`, [`${schema}-missing`, sourceWorkspace.workspaceId]);
    const read = await openConnection();
    try { await assert.rejects(() => readNativeWorkspaceRecoveryRecords(read, sourceWorkspace, 'missing.md')); }
    finally { await read.close(); }
    console.log('native copy PostgreSQL: fresh identities, exact native/profile preservation, atomic ledger, retries, actor/fingerprint conflicts, lost COMMIT before/after, peer-edit proof, lifecycle conflict, missing state OK');
  } finally {
    await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`); await admin.end();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]') : 'Native copy test failed.'); process.exitCode = 1; });

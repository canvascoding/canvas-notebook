import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import type { SqlConnection } from '../app/lib/db';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { Y } from '../app/lib/collaboration/server-runtime';
import type * as Native from '../app/lib/files/workspace-operation-original-delete-native';

// Real in-memory PostgreSQL syntax/data only. No independent-backend locking,
// schema gate, current rights, genuine Claim or Owner authority is claimed.
type Row = Record<string, unknown>;
type Selection = { schema: string; documentId: string; lineageId: string; path: string; workspaceId: string;
  workspaceType: 'personal'; organizationId: null; customerId: null; projectId: null };
type HeaderModule = typeof Native & { lockOriginalRows: (database: SqlConnection, selection: Selection,
  maxStateBytes?: number, locking?: boolean) => Promise<{ registry: Row; lineage: Row; raw: Row; projection: Row | undefined }> };
const file = path.resolve('app/lib/files/workspace-operation-original-delete-native.ts');
const ownPath = path.resolve('scripts/workspace-operation-original-native-header-test.ts');
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let complete = false;
const watchdog = setTimeout(() => { console.error('native joined header fixture incomplete'); process.exitCode = 1; }, 30_000);
process.on('beforeExit', () => { if (!complete) process.exitCode = 1; });

async function main(): Promise<void> {
  const source = await fs.readFile(file, 'utf8'), ownHash = sha(await fs.readFile(ownPath));
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const functionNode = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'lockOriginalRows');
  assert(functionNode);
  // All original raw/mapper/scope/restore/CAS/postcondition code is byte-equal.
  assert.equal(sha(source.slice(0, functionNode.getStart(ast)) + '<lockOriginalRows>' + source.slice(functionNode.end)),
    'c57c3e16b79d13c3de13296793a1cd847697841fca2119ee403a5eec588fcf08');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const load = createRequire(file), loaded = { exports: {} as HeaderModule };
  new Function('require', 'module', 'exports', `${compiled}\nmodule.exports.lockOriginalRows=lockOriginalRows;`)(
    (name: string) => name === 'server-only' ? {} : load(name), loaded, loaded.exports);
  const pg = new PGlite(), calls: Array<{ sql: string; parameters: unknown[] }> = [];
  const database: SqlConnection = {
    get: async (sql, parameters = []) => { calls.push({ sql, parameters }); return (await pg.query(sql, parameters)).rows[0]; },
    all: async (sql, parameters = []) => { calls.push({ sql, parameters }); return (await pg.query(sql, parameters)).rows; },
    run: async (sql, parameters = []) => { calls.push({ sql, parameters }); return pg.query(sql, parameters); },
    close: () => { throw new Error('Native header must not close borrowed SQL.'); },
  };
  const selected: Selection = { schema: '"header_fixture"', documentId: 'original-D1', lineageId: 'original-L1', path: ' note .md',
    workspaceId: 'native-header', workspaceType: 'personal', organizationId: null, customerId: null, projectId: null };
  let passed = 0;
  const run = async (name: string, operation: () => Promise<void>) => {
    await pg.exec('BEGIN');
    try { calls.length = 0; await operation(); passed++; console.log(`PASS ${passed}: ${name}`); }
    finally { await pg.exec('ROLLBACK'); }
  };
  const rejectedHeader = async (prepare: () => Promise<unknown>, code = 'ORIGINAL_NATIVE_DELETE_CHANGED', maxBytes?: number,
    locking = true) => {
    await prepare(); calls.length = 0;
    await assert.rejects(loaded.exports.lockOriginalRows(database, selected, maxBytes, locking), { code });
    assert.equal(calls.length, 1, 'The rejected header cannot reach the bounded BLOB or projection read.');
  };
  try {
    // Deliberately no FKs: controlled orphans must reach the reader's own checks.
    await pg.exec(`CREATE SCHEMA header_fixture;
      CREATE TABLE header_fixture.collaboration_documents(id text PRIMARY KEY,lineage_id text,workspace_id text,workspace_type text,
        organization_id text,customer_id text,project_id text,path text,provider text,yjs_state_lifecycle text,status text,state_version bigint,
        snapshot_revision_id text,created_at bigint,updated_at bigint);
      CREATE TABLE header_fixture.file_collaboration_lineages(id text PRIMARY KEY,workspace_id text,workspace_type text,
        organization_id text,customer_id text,project_id text,path text,status text,archived_at bigint,trash_entry_id text,created_at bigint);
      CREATE TABLE header_fixture.collaboration_yjs_states(document_id text PRIMARY KEY,workspace_id text,organization_id text,path text,
        representation text,lifecycle_generation bigint,schema_version bigint,status text,document_sequence bigint,persisted_at bigint,
        checkpoint_sequence bigint,checkpointed_at bigint,newline_style text,has_bom bigint,degraded bigint,projection_error_code text,
        projection_error_sequence bigint,projection_error_generation bigint,projection_error_phase text,projection_error_permanent bigint,
        yjs_state bytea,state_vector bytea,canonical_hash text,serialized_hash text);
      CREATE TABLE header_fixture.collaboration_file_projections(document_id text PRIMARY KEY,lifecycle_generation bigint,projected_sequence bigint,
        updated_at bigint,finalized bigint,revision_id text,canonical_hash text,serialized_hash text);
      CREATE TABLE header_fixture.collaboration_agent_operations(operation_id text,document_id text,status text);`);
    await pg.query(`INSERT INTO header_fixture.collaboration_documents VALUES
      ('original-D1','original-L1','native-header','personal',NULL,NULL,NULL,' note .md','yjs','initialized','active',2,NULL,100,100)`);
    await pg.query(`INSERT INTO header_fixture.file_collaboration_lineages VALUES
      ('original-L1','native-header','personal',NULL,NULL,NULL,' note .md','active',NULL,NULL,100)`);
    const doc = createPlainTextYDoc('Actual native state');
    try {
      await pg.query(`INSERT INTO header_fixture.collaboration_yjs_states VALUES
        ('original-D1','native-header',NULL,' note .md','plain_text',1,1,'active',2,100,0,NULL,'crlf',1,0,NULL,NULL,NULL,NULL,0,$1,$2,NULL,NULL)`,
      [Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc)]);
    } finally { doc.destroy(); }
    await run('actual joined header + bounded binary + absent optional projection is exactly three queries', async () => {
      const result = await loaded.exports.lockOriginalRows(database, selected);
      assert.equal(result.registry.id, selected.documentId); assert.equal(result.lineage.id, selected.lineageId);
      assert.equal(result.registry.state_version, 2); assert.equal(result.registry.created_at, 100);
      assert(result.raw.yjs_state instanceof Uint8Array); assert.equal(result.projection, undefined);
      assert.equal(calls.length, 3); assert.deepEqual(calls[0].parameters, ['original-D1', 'original-L1']);
      assert.match(calls[0].sql, /INNER JOIN "header_fixture"\.file_collaboration_lineages l ON l\.id=d\.lineage_id/u);
      assert.match(calls[0].sql, /INNER JOIN "header_fixture"\.collaboration_yjs_states s ON s\.document_id=d\.id/u);
      assert.match(calls[0].sql, /FOR UPDATE OF d,l,s NOWAIT/u); assert(!calls[0].sql.includes('to_jsonb(s)'));
      assert.match(calls[1].sql, /octet_length\(yjs_state\) BETWEEN 1 AND \$2/u);
      assert.match(calls[2].sql, /FOR UPDATE NOWAIT/u);
    });
    await run('readonly header observes the identical original tuple without row locks', async () => {
      const locked = await loaded.exports.lockOriginalRows(database, selected);
      calls.length = 0; const readonly = await loaded.exports.lockOriginalRows(database, selected, undefined, false);
      assert.deepEqual(readonly, locked); assert.equal(calls.length, 3);
      assert(calls.every(call => !/FOR (?:UPDATE|SHARE)/u.test(call.sql)));
    });
    await run('original optional projection remains a separately locked actual row', async () => {
      await pg.query(`INSERT INTO header_fixture.collaboration_file_projections VALUES ('original-D1',1,0,100,0,NULL,NULL,NULL)`);
      const result = await loaded.exports.lockOriginalRows(database, selected);
      assert.equal(result.projection?.document_id, selected.documentId); assert.equal(calls.length, 3);
    });
    await run('missing original registry rejects before binary', () => rejectedHeader(() => pg.query(`DELETE FROM header_fixture.collaboration_documents`)));
    await run('missing original lineage rejects before binary', () => rejectedHeader(() => pg.query(`DELETE FROM header_fixture.file_collaboration_lineages`)));
    await run('missing original raw state rejects before binary', () => rejectedHeader(() => pg.query(`DELETE FROM header_fixture.collaboration_yjs_states`)));
    await run('registry bound to another lineage rejects before binary', () => rejectedHeader(() => pg.query(`UPDATE header_fixture.collaboration_documents SET lineage_id='other-L2'`)));
    await run('state bound to another document rejects before binary', () => rejectedHeader(() => pg.query(`UPDATE header_fixture.collaboration_yjs_states SET document_id='other-D2'`)));
    await run('same-path replacement never supplies missing original IDs', () => rejectedHeader(async () => {
      await pg.query(`UPDATE header_fixture.collaboration_documents SET id='later-D2',lineage_id='later-L2'`);
      await pg.query(`UPDATE header_fixture.file_collaboration_lineages SET id='later-L2'`);
      await pg.query(`UPDATE header_fixture.collaboration_yjs_states SET document_id='later-D2'`);
    }));
    await run('readonly orphan also rejects before binary', () => rejectedHeader(() => pg.query(`DELETE FROM header_fixture.file_collaboration_lineages`),
      'ORIGINAL_NATIVE_DELETE_CHANGED', undefined, false));
    await run('empty state bytes reject in original size gate', () => rejectedHeader(() => pg.query(`UPDATE header_fixture.collaboration_yjs_states SET yjs_state=$1`, [new Uint8Array()]),
      'ORIGINAL_NATIVE_DELETE_TOO_LARGE'));
    await run('caller archive cap is enforced before binary', () => rejectedHeader(async () => undefined, 'ORIGINAL_NATIVE_DELETE_TOO_LARGE', 1));
    await run('vector upper bound is enforced before binary', () => rejectedHeader(() => pg.query(`UPDATE header_fixture.collaboration_yjs_states SET state_vector=$1`,
      [new Uint8Array(1024 * 1024 + 1)]), 'ORIGINAL_NATIVE_DELETE_TOO_LARGE'));
    await run('actual full public DAL reader still maps original Yjs/BOM/CRLF and native identity', async () => {
      const result = await loaded.exports.readOriginalNativeDeleteTargetOnConnection(database, { schema: 'header_fixture',
        documentId: selected.documentId, lineageId: selected.lineageId, path: selected.path, workspace: {
          workspaceId: selected.workspaceId, workspaceType: 'personal', organizationId: null, rootPath: '/unused-header-test', legacy: false,
          permissions: { canRead: false, canWrite: false, canDelete: false, canRunAgent: false, canManageWorkspace: false, canCreatePublicLinks: false },
        } });
      assert.equal(result.expected.documentId, selected.documentId); assert.equal(result.expected.path, selected.path);
      assert.equal(result.expected.registryStateVersion, 2); assert.equal(result.state.newlineStyle, 'crlf'); assert.equal(result.state.hasBom, true);
      assert.equal(calls.length, 4, 'Three original-row queries plus the unchanged actual agent-operation guard.');
    });
  } finally {
    await pg.close(); clearTimeout(watchdog);
    assert.equal(sha(await fs.readFile(file, 'utf8')), sha(source));
    assert.equal(sha(await fs.readFile(ownPath)), ownHash);
  }
  complete = true;
  console.log(`native joined header: ${passed}/${passed}, real PGlite SQL, original guards unchanged, cleanup complete`);
}
void main().catch(error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });

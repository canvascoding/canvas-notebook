import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, Pool, types } from 'pg';
import { getSchema } from '@tiptap/core';
import type { SqlConnection } from '../app/lib/db';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { isLiveCollaborationDocumentReaderAvailable } from '../app/lib/collaboration/document-access';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions } from '../app/lib/collaboration/markdown-state';
import { collaborationAdmissionLockKey } from '../app/lib/collaboration/room-admission-contract';
import { Y } from '../app/lib/collaboration/server-runtime';
import { withNativeWorkspaceFileRead } from '../app/lib/collaboration/workspace-native-file-read';
import { readWorkspaceDocumentCatalogue } from '../app/lib/collaboration/workspace-document-catalogue';
import { withWorkspaceFileLifecycleGuard } from '../app/lib/files/workspace-file-lifecycle-guard';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const schemaPattern = /^canvas_native_read_test_[a-f0-9]{32}$/u;
let phase = 'private local configuration';

async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(isLiveCollaborationDocumentReaderAvailable(), false, 'This fixture exercises the real persisted reader.');
  const envPath = process.env.CANVAS_NATIVE_READ_TEST_ENV_FILE;
  assert(envPath, 'An explicit private local environment file is required.');
  assert.equal((await stat(envPath)).mode & 0o077, 0);
  const connectionString = parse(await readFile(envPath)).DATABASE_URL;
  assert(connectionString, 'Local PostgreSQL is not configured.');
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.port, '55433');
  assert.equal(url.pathname, '/canvas_notebook');
  assert.equal(url.search, '');
  const schema = `canvas_native_read_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, schemaPattern);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5_000,
    options: '-c statement_timeout=10000' });
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-native-read-sql-'));
  const previousDataRoot = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = temporaryRoot;
  let pool: Pool | undefined;
  let created = false;
  try {
    await control.connect();
    const server = (await control.query(`SELECT current_database() AS name,
      current_setting('server_version_num')::integer AS version,
      to_regclass('public.collaboration_yjs_states') IS NOT NULL AS states`)).rows[0];
    assert.equal(server.name, 'canvas_notebook');
    assert.equal(Math.floor(server.version / 10_000), 18);
    assert.equal(server.states, true);
    phase = 'owned generated schema';
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    for (const table of ['collaboration_documents', 'collaboration_yjs_states',
      'collaboration_yjs_state_backups', 'collaboration_agent_operations',
      'collaboration_admission_requests', 'collaboration_admission_scopes']) {
      await control.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    pool = new Pool({ connectionString, max: 6, connectionTimeoutMillis: 5_000,
      // Same INT8 contract as app/lib/db/postgres.ts; keep the control client
      // on pg's default decimal strings to also verify the catalogue boundary.
      types: { getTypeParser: (oid, format) => oid === types.builtins.INT8
        ? (value: string) => Number.parseInt(value, 10) : types.getTypeParser(oid, format) },
      options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=4000 -c application_name=canvas-native-read-test` });
    assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema);
    const workspace: WorkspaceContext = { workspaceId: `native-read-${randomUUID()}`, organizationId: null,
      workspaceType: 'personal', rootPath: temporaryRoot, legacy: false, status: 'active', ownerUserId: 'owner',
      permissions: { canRead: true, canWrite: true, canDelete: true, canManageWorkspace: true,
        canCreatePublicLinks: true, canRunAgent: true } };
    const commands: string[] = [];
    const liveClients = new Set<number>();
    let checkouts = 0;
    const openConnection = async (): Promise<SqlConnection> => {
      const client = await pool!.connect();
      client.on('error', () => undefined);
      const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      assert(!liveClients.has(pid)); liveClients.add(pid); checkouts += 1;
      let released = false;
      return {
        get: async (sql, args) => { commands.push(sql); return (await client.query(sql, args)).rows[0]; },
        all: async (sql, args) => { commands.push(sql); return (await client.query(sql, args)).rows; },
        run: async (sql, args) => { commands.push(sql); return { changes: (await client.query(sql, args)).rowCount ?? 0 }; },
        close: error => {
          assert.equal(released, false); released = true; liveClients.delete(pid); client.release(error);
        },
      };
    };
    const input = (filePath: string, mode: 'metadata' | 'export' = 'export') => ({ workspace,
      path: filePath, mode, maxBytes: 1024 * 1024 });
    const fixture = async (filePath: string, doc?: InstanceType<typeof Y.Doc>,
      representation: 'plain_text' | 'tiptap_blocks' = 'plain_text', lifecycle = 'initialized', stateVersion = 0) => {
      const documentId = `read-${randomUUID()}`;
      await pool!.query(`INSERT INTO collaboration_documents(id,workspace_id,workspace_type,organization_id,path,
        provider,state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,'personal',NULL,$3,'yjs',$4,$5,'active',1,1)`,
      [documentId, workspace.workspaceId, filePath, stateVersion, lifecycle]);
      if (doc) await pool!.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,
        representation,lifecycle_generation,schema_version,yjs_state,state_vector,document_sequence,persisted_at,
        checkpoint_sequence,newline_style,has_bom,degraded,status)
        VALUES($1,$2,NULL,$3,$4,1,1,$5,$6,0,100,0,'crlf',1,0,'active')`,
      [documentId, workspace.workspaceId, filePath, representation, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))]);
      return documentId;
    };

    phase = 'native-only source independent of suffix and projection';
    const plain = createPlainTextYDoc('First\nSecond\n');
    try {
      const documentId = await fixture('native.bin', plain);
      await assert.rejects(stat(path.join(temporaryRoot, 'native.bin')), { code: 'ENOENT' });
      const result = await withNativeWorkspaceFileRead(input('native.bin'), async native => {
        assert.equal(liveClients.size, 1, 'Consumption must precede the read transaction close.');
        assert.equal(native?.documentId, documentId);
        return native;
      }, { openConnection });
      assert.equal(result?.content?.toString('utf8'), '\uFEFFFirst\r\nSecond\r\n');
      assert.equal(result?.documentSequence, 0); assert.equal(result?.source, 'persisted_yjs');
      assert.equal(result?.modifiedAt, 100); assert.equal(liveClients.size, 0);
    } finally { plain.destroy(); }

    phase = 'real shared read fence excludes a lifecycle writer';
    await writeFile(path.join(temporaryRoot, 'pristine.md'), 'Original physical bytes');
    await fixture('pristine.md', undefined, 'plain_text', 'never_initialized');
    let consumed = false;
    const result = await withNativeWorkspaceFileRead(input('pristine.md'), async native => {
      assert.equal(native, null); consumed = true;
      const writer = await pool!.connect();
      try {
        await writer.query('BEGIN');
        const locked = (await writer.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
          [collaborationAdmissionLockKey(workspace.workspaceId)])).rows[0].locked;
        assert.equal(locked, false, 'The same shared read fence must remain held through physical consumption.');
        await writer.query('ROLLBACK');
      } finally { writer.release(); }
      await assert.rejects(withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: ['pristine.md'] },
        async () => { throw new Error('A blocked lifecycle writer must not reach mutation.'); }, openConnection),
      { code: 'COLLABORATION_FILE_LIFECYCLE_BUSY' });
      return await readFile(path.join(temporaryRoot, 'pristine.md'), 'utf8');
    }, { openConnection });
    assert.equal(consumed, true); assert.equal(result, 'Original physical bytes');
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      assert.equal((await writer.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
        [collaborationAdmissionLockKey(workspace.workspaceId)])).rows[0].locked, true,
      'COMMIT must release the shared fence.');
      await writer.query('ROLLBACK');
    } finally { writer.release(); }

    phase = 'native metadata stays readable through export failure';
    const rich = createRichMarkdownYDoc('| A |\n| --- |\n| B |', 'tiptap_blocks');
    try {
      const tree = new CollaborationBlockTree(rich, getSchema(richMarkdownSchemaExtensions()));
      for (const record of tree.records.values()) if (['tableHeader', 'tableCell'].includes((record.get('shape') as { type: string }).type)) {
        (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth', [120]);
      }
      await fixture('rich.md', rich, 'tiptap_blocks');
      const metadata = await withNativeWorkspaceFileRead(input('rich.md', 'metadata'), async native => native, { openConnection });
      assert.equal(metadata?.contentUnavailable, true); assert.equal(metadata?.content, null);
      await assert.rejects(withNativeWorkspaceFileRead(input('rich.md'), async () => { throw new Error('Lossy export must not be consumed.'); },
        { openConnection }), /roundtrip_unstable/u);
      assert.equal(liveClients.size, 0);
    } finally { rich.destroy(); }

    phase = 'lost native state never grants physical fallback';
    await fixture('missing.bin', undefined, 'plain_text', 'initialized', 2);
    await writeFile(path.join(temporaryRoot, 'missing.bin'), 'Stale but readable');
    await assert.rejects(withNativeWorkspaceFileRead(input('missing.bin'), async () => {
      throw new Error('Missing initialized state must never be consumed as ordinary bytes.');
    }, { openConnection }), { status: 409 });

    phase = 'PostgreSQL enforces read-only and rolls back before releasing the fence';
    let activeRead: SqlConnection | undefined;
    await assert.rejects(withNativeWorkspaceFileRead(input('pristine.md'), async () => {
      assert(activeRead);
      await activeRead.run(`UPDATE collaboration_documents SET updated_at=999 WHERE path='pristine.md'`);
    }, { openConnection: async () => { activeRead = await openConnection(); return activeRead; } }), { code: '25006' });
    assert.equal(Number((await pool.query("SELECT updated_at FROM collaboration_documents WHERE path='pristine.md'")).rows[0].updated_at), 1);
    assert.equal(liveClients.size, 0);
    phase = 'catalogue accepts driver decimal strings and rejects unsafe clocks';
    await control.query(`SET search_path="${schema}"`);
    const controlConnection: SqlConnection = {
      get: async (sql, args) => (await control.query(sql, args)).rows[0],
      all: async (sql, args) => (await control.query(sql, args)).rows,
      run: async (sql, args) => ({ changes: (await control.query(sql, args)).rowCount ?? 0 }), close: () => undefined,
    };
    const raw = (await control.query("SELECT lifecycle_generation FROM collaboration_yjs_states WHERE path='native.bin'")).rows[0];
    assert.equal(typeof raw.lifecycle_generation, 'string');
    await control.query('BEGIN READ ONLY');
    await control.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [collaborationAdmissionLockKey(workspace.workspaceId)]);
    try {
      const catalogue = await readWorkspaceDocumentCatalogue(controlConnection, workspace, { paths: ['native.bin'] });
      assert.equal(catalogue[0].lifecycle_generation, 1); assert.equal(catalogue[0].state_version, 0);
      assert.equal(catalogue[0].authority, 'initialized');
      await control.query('COMMIT');
    } catch (error) { await control.query('ROLLBACK'); throw error; }
    for (const [table, field, invalid, original] of [
      ['collaboration_documents', 'state_version', '9007199254740992', '0'],
      ['collaboration_yjs_states', 'lifecycle_generation', '9007199254740992', '1'],
    ] as const) {
      await pool.query(`UPDATE ${table} SET ${field}=$1 WHERE path='native.bin'`, [invalid]);
      await assert.rejects(withNativeWorkspaceFileRead(input('native.bin'), async () => {
        throw new Error('Unsafe native clocks must never reach physical consumption.');
      }, { openConnection }), { code: 'identity-conflict' });
      await pool.query(`UPDATE ${table} SET ${field}=$1 WHERE path='native.bin'`, [original]);
    }
    const before = checkouts;
    await assert.rejects(withNativeWorkspaceFileRead({ ...input('native.bin'),
      workspace: { ...workspace, permissions: { ...workspace.permissions, canRead: false } } }, async () => undefined, { openConnection }), { status: 403 });
    assert.equal(checkouts, before);
    assert(commands.includes('BEGIN READ ONLY')); assert(commands.includes('COMMIT')); assert(commands.includes('ROLLBACK'));
    assert.equal(commands.some(sql => /^\s*(?:INSERT|DELETE)/u.test(sql)), false);
    console.log('Native file reader PostgreSQL: native-only bytes, strict export/metadata, real read/lifecycle fence, read-only rollback and permissions passed.');
  } finally {
    await pool?.end();
    if (created) {
      assert.match(schema, schemaPattern);
      await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await control.end();
    await rm(temporaryRoot, { recursive: true, force: true });
    if (previousDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousDataRoot;
  }
}

main().catch((error: unknown) => {
  // Keep private connection settings and document bytes out of terminal output.
  const rawCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const code = /^[A-Za-z0-9_-]{1,40}$/u.test(rawCode) ? rawCode : 'unknown';
  console.error(`Native file reader PostgreSQL fixture failed during ${phase} (${code}).`);
  process.exitCode = 1;
});

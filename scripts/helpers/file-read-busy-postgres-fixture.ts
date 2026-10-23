import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, Pool } from 'pg';
import { NextRequest } from 'next/server';
import ts from 'typescript';
import type { Document } from '@hocuspocus/server';
import type { SqlConnection } from '../../app/lib/db';
import type { PersistedCollaborationState } from '../../app/lib/collaboration/persistence';
import { installCollaborationDocumentReader } from '../../app/lib/collaboration/document-access';
import { withNativeWorkspaceFileRead } from '../../app/lib/collaboration/workspace-native-file-read';
import { collaborationAdmissionLockKey } from '../../app/lib/collaboration/room-admission-contract';
import { revalidateBusyFileRead } from '../../app/lib/files/read-busy';
import type { WorkspaceContext } from '../../app/lib/workspaces/types';
import type * as Route from '../../app/api/files/read/route';

type Hooks = {
  workspaceId: string;
  reader: Parameters<typeof installCollaborationDocumentReader>[0];
  room(id: string): Promise<{ document: Document; state: PersistedCollaborationState }>;
  onPersist(callback: ((state: PersistedCollaborationState) => Promise<void>) | null): void;
  unload(document: Document): Promise<{ entered: Promise<void>; release(): void; complete: Promise<void> }>;
};

/** Real PostgreSQL native read transactions around the existing actual
 * Hocuspocus/server/owner-runtime fixture. That fixture's owner session remains
 * simulated; this does not claim PostgreSQL room-owner acquisition coverage. */
export async function testNativeBusyReadPostgres(hooks: Hooks) {
  const envPath = process.env.CANVAS_FILE_READ_BUSY_TEST_ENV_FILE;
  assert(envPath, 'A private explicit managed PG environment file is required.');
  const envStat = await fs.lstat(envPath);
  assert(envStat.isFile() && !envStat.isSymbolicLink() && envStat.uid === process.getuid!() && envStat.nlink === 1);
  assert.equal(envStat.mode & 0o077, 0);
  const connectionString = parse(await fs.readFile(envPath)).DATABASE_URL;
  assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `canvas_file_read_busy_${randomUUID().replaceAll('-', '')}`;
  const marker = randomUUID();
  assert.match(schema, /^canvas_file_read_busy_[a-f0-9]{32}$/u);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-file-read-busy-pg-')));
  await fs.chmod(root, 0o700);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined, created = false, passed = false;
  let schemaOid = 0;
  const live = new Set<number>(), shared = new Set<number>();
  const pending: Array<{ release(): void; complete: Promise<void> }> = [];
  let uninstall = () => {};
  let nativeRequests = 0;
  try {
    await control.connect();
    const server = (await control.query('SELECT current_database() AS name,current_user AS owner,current_setting(\'server_version_num\')::integer AS version')).rows[0];
    assert.equal(server.name, 'canvas_notebook'); assert.equal(Math.floor(server.version / 10_000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    await control.query(`COMMENT ON SCHEMA "${schema}" IS '${marker}'`);
    schemaOid = Number((await control.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].oid);
    for (const table of ['collaboration_documents', 'collaboration_yjs_states', 'collaboration_yjs_state_backups', 'collaboration_agent_operations']) {
      await control.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=4000 -c application_name=${schema}` });
    assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema);
    const openConnection = async (): Promise<SqlConnection> => {
      const connection = await pool!.connect();
      const pid = Number((await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      assert(!live.has(pid)); live.add(pid);
      return {
        get: async (sql, args) => {
          const result = (await connection.query(sql, args)).rows[0];
          if (sql.includes('pg_advisory_xact_lock_shared')) shared.add(pid);
          return result;
        },
        all: async (sql, args) => (await connection.query(sql, args)).rows,
        run: async (sql, args) => { const result = await connection.query(sql, args);
          if (/^(COMMIT|ROLLBACK)$/u.test(sql)) shared.delete(pid); return { changes: result.rowCount ?? 0 }; },
        close: error => { assert(live.delete(pid)); shared.delete(pid); connection.release(error); },
      };
    };
    const workspace: WorkspaceContext = { workspaceId: hooks.workspaceId, workspaceType: 'personal', organizationId: null,
      rootPath: root, status: 'active', legacy: false, permissions: { canRead: true, canWrite: true, canDelete: true,
        canCreatePublicLinks: false, canRunAgent: false, canManageWorkspace: false } };
    const nativeRows = new Map<string, PersistedCollaborationState>();
    const insert = async (state: PersistedCollaborationState) => {
      nativeRows.set(state.path, state);
      await pool!.query(`INSERT INTO collaboration_documents(id,workspace_id,workspace_type,path,provider,state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,'personal',$3,'yjs',1,'initialized','active',1,1)`, [state.documentId, workspace.workspaceId, state.path]);
      await pool!.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,path,representation,lifecycle_generation,schema_version,yjs_state,state_vector,
        document_sequence,persisted_at,checkpoint_sequence,newline_style,has_bom,degraded,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,'lf',0,0,'active')`, [state.documentId, workspace.workspaceId, state.path,
      state.representation, state.lifecycleGeneration, state.schemaVersion, Buffer.from(state.yjsState), Buffer.from(state.stateVector), state.documentSequence, state.persistedAt]);
    };
    hooks.onPersist(async state => {
      // Final-store publication must run after the Busy read released its fence.
      assert.equal(shared.size, 0); assert.equal(live.size, 0);
      await pool!.query(`UPDATE collaboration_yjs_states SET yjs_state=$2,state_vector=$3,document_sequence=$4,persisted_at=$5 WHERE document_id=$1`,
        [state.documentId, Buffer.from(state.yjsState), Buffer.from(state.stateVector), state.documentSequence, state.persistedAt]);
      nativeRows.set(state.path, state);
    });
    uninstall = installCollaborationDocumentReader(hooks.reader);
    const filename = path.resolve('app/api/files/read/route.ts'), runtimeRequire = createRequire(filename);
    const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const mocks: Record<string, unknown> = {
      '@/app/lib/utils/rate-limit': { rateLimit: () => ({ ok: true }) },
      '@/app/lib/workspaces/request': { requireRequestWorkspace: async () => ({ workspace, session: { user: { id: 'owner' } } }), workspaceFileOptions: () => ({ workspace }) },
      '@/app/lib/files/collaboration-policy': { isDocxPath: () => false, readFileCollaborationState: async ({ path: filePath }: { path: string }) => ({
        document: { id: nativeRows.get(filePath)?.documentId, provider: 'yjs' }, latestRevision: null }) },
      '@/app/lib/filesystem/workspace-files': { readFile: () => assert.fail('Busy must never fall back to physical bytes'), getFileStats: () => assert.fail('native read must not consult disk stats') },
      '@/app/lib/collaboration/workspace-native-file-read': { withNativeWorkspaceFileRead: <T>(input: Parameters<typeof withNativeWorkspaceFileRead>[0], consume: Parameters<typeof withNativeWorkspaceFileRead<T>>[1]) =>
        withNativeWorkspaceFileRead(input, consume, { openConnection }) },
    };
    const route = {} as typeof Route;
    new Function('require', 'module', 'exports', source)((name: string) => mocks[name] ?? runtimeRequire(name), { exports: route }, route);
    const read = async (filePath: string, bootstrap = false) => {
      nativeRequests++;
      const response = await route.GET(new NextRequest(`https://canvas.test/api/files/read?path=${encodeURIComponent(filePath)}${bootstrap ? '&collaborationBootstrap=1' : ''}`));
      assert.equal(live.size, 0); assert.equal(shared.size, 0, 'the complete native transaction is closed before its response');
      return response;
    };
    const exclusive = async () => {
      const writer = await pool!.connect();
      try {
        await writer.query('BEGIN');
        assert.equal((await writer.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked', [collaborationAdmissionLockKey(workspace.workspaceId)])).rows[0].locked, true,
          'a fresh writer can acquire the fence between Busy and retry');
        await writer.query('ROLLBACK');
      } finally { writer.release(); }
    };
    const recovered = await hooks.room('reader-native-busy-recovery'); await insert(recovered.state);
    const unloading = await hooks.unload(recovered.document); pending.push(unloading); await unloading.entered;
    const bootstrapBusy = await read(recovered.state.path, true);
    assert.equal(bootstrapBusy.status, 503); assert.equal((await bootstrapBusy.json()).code, 'ROOM_OWNER_BUSY');
    let requests = 0;
    const recoveringRead = async () => {
      const response = await read(recovered.state.path); requests++;
      if (requests === 1) {
        assert.equal(response.status, 503); assert.equal((await response.clone().json()).code, 'ROOM_OWNER_BUSY');
        assert.equal(response.headers.get('cache-control'), 'no-store'); await exclusive();
        unloading.release(); await unloading.complete;
        assert.equal(recovered.document.isDestroyed, true);
      }
      return response;
    };
    const response = await revalidateBusyFileRead(recoveringRead, new AbortController().signal);
    assert.equal(response.status, 200); const fresh = (await response.json()).data;
    assert.equal(requests, 2); assert.equal(fresh.content, 'original+latest');
    assert.equal(fresh.collaboration?.document?.id, recovered.state.documentId);
    assert.equal((await pool.query('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1', [recovered.state.documentId])).rows[0].yjs_state
      .equals(Buffer.from(nativeRows.get(recovered.state.path)!.yjsState)), true);
    const bootstrap = await read(recovered.state.path, true);
    assert.equal(bootstrap.status, 200); const metadata = (await bootstrap.json()).data;
    assert.equal(metadata.contentUnavailable, true); assert.equal(metadata.content, '');
    assert.equal(metadata.nativeSource.documentId, recovered.state.documentId);
    console.log('PASS actual Hocuspocus final-store Busy -> native GET503 -> fully released real PG18 fence -> fresh GET200/current Yjs bytes');

    const persistent = await hooks.room('reader-native-busy-exhausted'); await insert(persistent.state);
    const held = await hooks.unload(persistent.document); pending.push(held); await held.entered;
    requests = 0;
    const failure = await revalidateBusyFileRead(() => { requests++; return read(persistent.state.path); }, new AbortController().signal);
    assert.ok(failure instanceof Response); assert.equal(failure.status, 503); assert.equal((await failure.json()).code, 'ROOM_OWNER_BUSY');
    assert.equal(requests, 4); assert.equal(persistent.document.isDestroyed, false); await exclusive();
    held.release(); await held.complete;
    console.log('PASS enduring actual room drain exhausts exactly four native HTTP attempts without holding SQL fence or falling back');
    passed = true;
  } finally {
    for (const value of pending) value.release();
    await Promise.allSettled(pending.map(value => value.complete));
    uninstall(); hooks.onPersist(null);
    assert.equal(live.size, 0); assert.equal(shared.size, 0);
    await pool?.end();
    if (created) {
      const owner = (await control.query('SELECT oid,pg_get_userbyid(nspowner)=current_user AS owned,obj_description(oid,\'pg_namespace\') AS marker FROM pg_namespace WHERE nspname=$1', [schema])).rows[0];
      assert.equal(owner?.owned, true); assert.equal(Number(owner.oid), schemaOid); assert.equal(owner.marker, marker);
      await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      assert.equal((await control.query('SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name=$1', [schema])).rows[0].count, 0);
    }
    await control.end();
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ version: 1, schema, schemaOid, ownerMarkerVerified: created, passed, nativeRequests, liveSessions: 0, sharedFences: 0, schemaRemoved: created }) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ evidenceRoot: root, passed, nativeRequests, liveSessions: 0, sharedFences: 0, schemaRemoved: created }));
  }
}

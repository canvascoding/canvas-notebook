import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, Pool, types } from 'pg';
import { NextRequest } from 'next/server';
import ts from 'typescript';
import type { SqlConnection } from '../app/lib/db';
import type * as Route from '../app/api/files/read/route';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { setFileCollaborationConnectionFactoryForTests } from '../app/lib/files/collaboration-repository';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { Y } from '../app/lib/collaboration/server-runtime';
import { withNativeWorkspaceFileRead } from '../app/lib/collaboration/workspace-native-file-read';
import { isLiveCollaborationDocumentReaderAvailable } from '../app/lib/collaboration/document-access';
import { createCollaborationAdmissionService } from '../app/lib/collaboration/room-admission';
import { collaborationAdmissionActionDigest, type CollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { lockFileLifecycleCollaborationWriterAdmission } from '../app/lib/collaboration/file-lifecycle-writer-admission';
import { assertWorkspaceFileLifecycleSqlAvailable, withWorkspaceFileLifecycleGuard } from '../app/lib/files/workspace-file-lifecycle-guard';
import { sha256Buffer } from '../app/lib/files/revision-guard';
import { nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';

const schemaPattern = /^canvas_native_docx_read_test_[a-f0-9]{32}$/u;
let phase = 'private local configuration';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(isLiveCollaborationDocumentReaderAvailable(), false);
  const envPath = process.env.CANVAS_NATIVE_READ_TEST_ENV_FILE;
  assert(envPath, 'An explicit private managed environment file is required.');
  const envStat = await stat(envPath);
  assert.equal(envStat.mode & 0o077, 0); assert.equal(envStat.uid, process.getuid!()); assert.equal(envStat.nlink, 1);
  const connectionString = parse(await readFile(envPath)).DATABASE_URL;
  assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `canvas_native_docx_read_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, schemaPattern);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5_000, options: '-c statement_timeout=10000' });
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-native-docx-read-sql-'));
  const previous = { DATA: process.env.DATA, CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT };
  process.env.DATA = root; process.env.CANVAS_DATA_ROOT = root;
  let pool: Pool | undefined;
  let created = false;
  const live = new Set<number>();
  const readFences = new Set<number>();
  const kernelContext = new AsyncLocalStorage<boolean>();
  let readerOpens = 0, kernelEntries = 0, officeReads = 0, physicalReads = 0;
  let beforeOffice: (() => Promise<void>) | undefined;
  let kernelAttempt: (() => void) | undefined;
  try {
    await control.connect();
    const server = (await control.query(`SELECT current_database() AS name,
      current_setting('server_version_num')::integer AS version, current_user AS owner`)).rows[0];
    assert.equal(server.name, 'canvas_notebook'); assert.equal(Math.floor(server.version / 10_000), 18);
    phase = 'owned generated schema';
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    for (const table of ['collaboration_documents', 'collaboration_yjs_states', 'collaboration_yjs_state_backups',
      'collaboration_agent_operations', 'collaboration_admission_requests', 'collaboration_admission_scopes',
      'collaboration_admission_targets', 'file_collaboration_lineages', 'file_revisions', 'file_locks']) {
      await control.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5_000,
      types: { getTypeParser: (oid, format) => oid === types.builtins.INT8
        ? (value: string) => Number.parseInt(value, 10) : types.getTypeParser(oid, format) },
      options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=4000 -c application_name=canvas-native-docx-read-test` });
    assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema);
    const openConnection = async (reader = false): Promise<SqlConnection> => {
      if (reader) { assert.equal(kernelContext.getStore(), true, 'DOCX kernel must precede native SQL checkout.'); readerOpens++; }
      const client = await pool!.connect();
      const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      assert(!live.has(pid)); live.add(pid);
      const ignoreOwnedClientError = () => undefined;
      client.on('error', ignoreOwnedClientError);
      let released = false;
      return {
        get: async (sql, args) => {
          const row = (await client.query(sql, args)).rows[0];
          if (reader && sql.includes('pg_advisory_xact_lock_shared')) readFences.add(pid);
          return row;
        },
        all: async (sql, args) => (await client.query(sql, args)).rows,
        run: async (sql, args) => {
          const result = await client.query(sql, args);
          if (/^(COMMIT|ROLLBACK)$/u.test(sql)) readFences.delete(pid);
          return { changes: result.rowCount ?? 0 };
        },
        close: error => {
          assert.equal(released, false); released = true; live.delete(pid); readFences.delete(pid);
          client.off('error', ignoreOwnedClientError); client.release(error);
        },
      };
    };
    setFileCollaborationConnectionFactoryForTests(() => openConnection());
    const { readOfficeDocumentSnapshot } = await import('../app/lib/office/document-service');
    const { prepareOfficeCommit, findOfficeCommit } = await import('../app/lib/office/document-journal');
    const { createEmptyDocx } = await import('../app/lib/office/empty-docx');
    const collaboration = await import('../app/lib/files/collaboration-policy');
    const catalogue = await import('../app/lib/collaboration/workspace-document-catalogue');
    const filesystem = await import('../app/lib/filesystem/workspace-files');
    const { withWorkspaceMutationLock } = await import('../app/lib/files/workspace-mutation-lock');
    const workspace: WorkspaceContext = { workspaceId: `native-docx-${randomUUID()}`, organizationId: null,
      workspaceType: 'personal', rootPath: root, legacy: false, status: 'active', ownerUserId: 'owner',
      permissions: { canRead: true, canWrite: false, canDelete: false, canManageWorkspace: false,
        canCreatePublicLinks: false, canRunAgent: false } };
    const filename = path.resolve('app/api/files/read/route.ts');
    const runtimeRequire = createRequire(filename);
    const source = ts.transpileModule(await readFile(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const mocks: Record<string, unknown> = {
      // The ESM graph holds these actual modules; do not require a second CJS
      // copy through TypeScript aliases while evaluating the actual route.
      '@/app/lib/files/revision-guard': { sha256Buffer },
      '@/app/lib/office/editor-compatibility': await import('../app/lib/office/editor-compatibility'),
      '@/app/lib/excalidraw-file': await import('../app/lib/excalidraw-file'),
      '@/app/lib/collaboration/checkpoint-errors': await import('../app/lib/collaboration/checkpoint-errors'),
      '@/app/lib/files/read-busy': await import('../app/lib/files/read-busy'),
      // Scene routes have their own integration suite. A DOCX request must never
      // enter them; keep their new imports outside this read-only DOCX fixture.
      '@/app/lib/excalidraw-collaboration/scene-service': {
        getExcalidrawDocument: () => assert.fail('A DOCX read must not resolve an Excalidraw scene.'),
      },
      '@/app/lib/excalidraw-collaboration/checkpoint': {
        serializePortableExcalidrawScene: () => assert.fail('A DOCX read must not serialize an Excalidraw scene.'),
      },
      '@/app/lib/excalidraw-collaboration/http': {
        excalidrawRequestAuthority: () => assert.fail('A DOCX read must not request Excalidraw authority.'),
        excalidrawRouteError: () => assert.fail('A DOCX read must not return an Excalidraw error.'),
      },
      '@/app/lib/utils/rate-limit': { rateLimit: () => ({ ok: true }) },
      '@/app/lib/workspaces/request': {
        requireRequestWorkspace: async () => ({ workspace, session: { user: { id: 'owner' } } }),
        workspaceFileOptions: () => ({ workspace }),
      },
      '@/app/lib/files/workspace-mutation-lock': {
        withWorkspaceMutationLock: (id: string, operation: () => Promise<unknown>) => {
          kernelAttempt?.();
          return withWorkspaceMutationLock(id, () => kernelContext.run(true, async () => { kernelEntries++; return operation(); }));
        },
      },
      '@/app/lib/collaboration/workspace-native-file-read': {
        withNativeWorkspaceFileRead: <T>(input: Parameters<typeof withNativeWorkspaceFileRead>[0], consume: Parameters<typeof withNativeWorkspaceFileRead<T>>[1]) =>
          withNativeWorkspaceFileRead(input, consume, { openConnection: () => openConnection(true) }),
      },
      '@/app/lib/office/document-service': {
        readOfficeDocumentSnapshot: async (scope: WorkspaceContext, filePath: string) => {
          assert.equal(kernelContext.getStore(), true); assert.equal(readFences.size, 1, 'Office recovery stays inside the native read fence.');
          officeReads++; await beforeOffice?.();
          const snapshot = await readOfficeDocumentSnapshot(scope, filePath);
          assert.equal(readFences.size, 1, 'Office commit must not release the native read fence.');
          return snapshot;
        },
      },
      '@/app/lib/filesystem/workspace-files': { ...filesystem,
        getFileStats: async (...args: Parameters<typeof filesystem.getFileStats>) => { physicalReads++; return filesystem.getFileStats(...args); },
        readFile: async (...args: Parameters<typeof filesystem.readFile>) => { physicalReads++; return filesystem.readFile(...args); },
      },
      '@/app/lib/files/collaboration-policy': collaboration,
      '@/app/lib/collaboration/workspace-document-catalogue': catalogue,
    };
    const route = {} as typeof Route;
    new Function('require', 'module', 'exports', source)((name: string) => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      assert.equal(name, 'next/server', 'Every route dependency must use the held ESM graph or an explicit IO seam.');
      return runtimeRequire(name);
    }, { exports: route }, route);
    const read = (filePath: string, query = '') => route.GET(new NextRequest(`https://canvas.test/api/files/read?path=${encodeURIComponent(filePath)}${query}`));
    const expectSuccess = async (filePath: string, query = '') => {
      const response = await read(filePath, query);
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(live.size, 0); assert.equal(readFences.size, 0);
      return (await response.json()).data;
    };
    const revisions = async () => Number((await pool!.query('SELECT count(*) AS count FROM file_revisions')).rows[0].count);
    const nativeFixture = async (filePath: string, doc?: InstanceType<typeof Y.Doc>, representation = 'plain_text', lifecycle = 'initialized') => {
      const documentId = `docx-read-${randomUUID()}`;
      await pool!.query(`INSERT INTO collaboration_documents(id,workspace_id,workspace_type,organization_id,path,
        provider,state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,'personal',NULL,$3,'yjs',0,$4,'active',1,1)`, [documentId, workspace.workspaceId, filePath, lifecycle]);
      if (doc) await pool!.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,
        representation,lifecycle_generation,schema_version,yjs_state,state_vector,document_sequence,persisted_at,
        checkpoint_sequence,newline_style,has_bom,degraded,status)
        VALUES($1,$2,NULL,$3,$4,1,1,$5,$6,0,100,0,'lf',0,0,'active')`,
      [documentId, workspace.workspaceId, filePath, representation, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))]);
      return documentId;
    };
    const plainFixture = async (filePath: string, text = 'Actual native content') => {
      const doc = createPlainTextYDoc(text);
      try { return await nativeFixture(filePath, doc); } finally { doc.destroy(); }
    };
    const officeBytes = await createEmptyDocx();

    phase = 'native DOCX suffix without and with stale physical Office projection';
    const nativeId = await plainFixture('native.docx');
    await assert.rejects(stat(path.join(root, 'native.docx')), { code: 'ENOENT' });
    for (const stale of [false, true]) {
      if (stale) await writeFile(path.join(root, 'native.docx'), officeBytes);
      const data = await expectSuccess('native.docx');
      assert.equal(data.content, 'Actual native content'); assert.equal(data.nativeSource.documentId, nativeId);
      assert.equal(data.stats.sha256, sha256Buffer(Buffer.from(data.content))); assert.equal(data.revision, null);
      assert.equal(data.stats.modified, 0); assert.equal(data.editorCompatibility, undefined);
    }
    for (const query of ['&meta=1', '&collaborationBootstrap=1']) {
      const data = await expectSuccess('native.docx', query);
      assert.equal(data.content, ''); assert.equal(data.contentUnavailable, true); assert.equal(data.stats.size, undefined);
      assert.equal(data.nativeSource.documentId, nativeId);
    }
    assert.equal(officeReads + physicalReads, 0); assert.equal(await revisions(), 0);
    console.log('PASS native .docx authority before stale/missing projection, metadata and bootstrap; no Office/FS/revision fallback');

    phase = 'native DOCX missing, foreign, quarantined and unexportable state';
    await nativeFixture('missing.docx'); await writeFile(path.join(root, 'missing.docx'), officeBytes);
    assert.equal((await read('missing.docx')).status, 409);
    const foreignId = await plainFixture('foreign.docx');
    await pool.query('UPDATE collaboration_yjs_states SET organization_id=$1 WHERE document_id=$2', ['foreign', foreignId]);
    assert.equal((await read('foreign.docx')).status, 409);
    const corruptId = await plainFixture('corrupt.docx'); await writeFile(path.join(root, 'corrupt.docx'), officeBytes);
    await pool.query('UPDATE collaboration_yjs_states SET state_vector=$1 WHERE document_id=$2', [Buffer.from([0]), corruptId]);
    // Preserve the existing malformed-vector contract; corrupt native bytes
    // remain errors even for bootstrap and never authorize an Office fallback.
    for (const query of ['', '&collaborationBootstrap=1']) {
      const response = await read('corrupt.docx', query);
      assert.equal(response.status, 500); assert.equal((await response.json()).success, false);
    }
    const quarantinedId = await plainFixture('quarantined.docx');
    await writeFile(path.join(root, 'quarantined.docx'), officeBytes);
    await pool.query('UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1', [quarantinedId]);
    assert.equal((await read('quarantined.docx')).status, 409);
    assert.equal((await expectSuccess('quarantined.docx', '&meta=1')).contentUnavailable, true);
    const rich = nativeTableWidthFixture('tiptap_blocks');
    try { await nativeFixture('rich.docx', rich, 'tiptap_blocks'); } finally { rich.destroy(); }
    await writeFile(path.join(root, 'rich.docx'), officeBytes);
    assert.equal((await read('rich.docx')).status, 422);
    assert.equal((await expectSuccess('rich.docx', '&collaborationBootstrap=1')).contentUnavailable, true);
    assert.equal(officeReads + physicalReads, 0); assert.equal(await revisions(), 0); assert.equal(live.size, 0);
    console.log('PASS native missing/foreign/quarantined/export-loss failures stay native; recoverable metadata never parses Office');

    phase = 'unregistered and pristine real DOCX binary/read-only contract';
    const pristineId = await nativeFixture('pristine.docx', undefined, 'plain_text', 'never_initialized');
    for (const filePath of ['office.docx', 'pristine.docx']) {
      await writeFile(path.join(root, filePath), officeBytes);
      const data = await expectSuccess(filePath);
      assert.deepEqual(Buffer.from(data.content.slice(7), 'base64'), officeBytes); assert(data.content.startsWith('base64:'));
      assert.equal(data.stats.sha256, sha256Buffer(officeBytes)); assert.equal(data.stats.size, officeBytes.length);
      assert.equal(data.revision.contentHash, data.stats.sha256); assert.equal(data.editorCompatibility.editable, true);
      assert.equal(data.workspaceId, workspace.workspaceId); assert.equal(data.viewerUserId, 'owner'); assert(data.collaboration.lineageId);
      assert.equal(data.nativeSource, undefined);
      const meta = await expectSuccess(filePath, '&meta=1');
      assert.equal(meta.content, ''); assert.equal(meta.editorCompatibility, undefined); assert.equal(meta.revision.id, data.revision.id);
      const bootstrap = await expectSuccess(filePath, '&collaborationBootstrap=1');
      assert.equal(bootstrap.content, data.content); assert.equal(bootstrap.revision.id, data.revision.id);
    }
    assert.equal((await pool.query('SELECT yjs_state_lifecycle FROM collaboration_documents WHERE id=$1', [pristineId])).rows[0].yjs_state_lifecycle, 'never_initialized');
    assert.equal(await revisions(), 2);
    console.log('PASS real unregistered/pristine DOCX retains base64, exact hash/revision, compatibility, scope, metadata and read-only access');

    phase = 'real Office interrupted-publication recovery and unpublished proposal';
    const loaded = await expectSuccess('office.docx');
    const changed = Buffer.from(officeBytes); // Distinct exact bytes, still a valid package with a ZIP comment.
    const published = Buffer.concat([changed, Buffer.from('owned-recovery-comment')]);
    published.writeUInt16LE(Buffer.byteLength('owned-recovery-comment'), changed.length - 2);
    const journalInput = { workspaceId: workspace.workspaceId, lineageId: loaded.collaboration.lineageId, path: 'office.docx',
      actorUserId: 'owner', actorSessionId: 'original-office-session', actorType: 'agent' as const,
      beforeHash: loaded.stats.sha256, beforeContent: officeBytes, content: published,
      baseRevisionId: loaded.revision.id, idempotencyKey: randomUUID() };
    const pending = await prepareOfficeCommit(journalInput);
    await writeFile(path.join(root, 'office.docx'), published);
    const recovered = await expectSuccess('office.docx');
    assert.equal(recovered.stats.sha256, sha256Buffer(published)); assert.equal(recovered.revision.createdByActorType, 'agent');
    assert.equal(recovered.revision.sourceSessionId, journalInput.actorSessionId);
    assert.equal((await findOfficeCommit(journalInput))?.id, pending.id); assert.equal((await findOfficeCommit(journalInput))?.status, 'completed');
    const unpublishedInput = { ...journalInput, beforeHash: recovered.stats.sha256, beforeContent: published,
      content: officeBytes, baseRevisionId: recovered.revision.id, idempotencyKey: randomUUID() };
    await prepareOfficeCommit(unpublishedInput);
    assert.equal((await expectSuccess('office.docx')).revision.id, recovered.revision.id);
    assert.equal((await findOfficeCommit(unpublishedInput))?.status, 'prepared');
    assert.deepEqual(await readFile(path.join(root, 'office.docx')), published);
    console.log('PASS real PG/FS Office journal recovery retains original actor/session and exact published bytes; unpublished proposal remains private');

    phase = 'kernel acquisition precedes native SQL while another kernel owner is active';
    const entered = gate(), release = gate(), attempt = gate();
    const holder = withWorkspaceMutationLock(workspace.workspaceId, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const previousOpens = readerOpens;
    kernelAttempt = attempt.resolve;
    const waitingRead = read('office.docx');
    try {
      await Promise.race([attempt.promise, waitingRead.then(() => assert.fail('Reader must attempt the outer kernel before SQL.'))]);
      assert.equal(readerOpens, previousOpens); assert.equal(live.size, 0);
    } finally { kernelAttempt = undefined; release.resolve(); await holder; }
    assert.equal((await waitingRead).status, 200);
    console.log('PASS waiting for a foreign kernel owner holds no SQL read fence; Office recovery reenters after kernel release');

    phase = 'shared fallback read excludes real initialization and move writer admission';
    await writeFile(path.join(root, 'racing.docx'), officeBytes);
    beforeOffice = async () => {
      const writer = await openConnection();
      try {
        await writer.run('BEGIN');
        await assert.rejects(lockFileLifecycleCollaborationWriterAdmission(
          (sql, args) => writer.all(sql, args) as Promise<Array<Record<string, unknown>>>, {
            workspaceId: workspace.workspaceId, organizationId: null, representation: 'plain_text',
            documentId: 'racing-initialization', path: 'racing.docx', lifecycleGeneration: 1, schemaVersion: 1,
          }), { code: '55P03' });
        await writer.run('ROLLBACK'); await writer.run('BEGIN');
        await assert.rejects(assertWorkspaceFileLifecycleSqlAvailable(writer, workspace.workspaceId, ['racing.docx', 'moved.docx']),
          { code: 'COLLABORATION_FILE_LIFECYCLE_BUSY' });
        await writer.run('ROLLBACK');
      } finally { await writer.close(); }
      assert.equal(Number((await pool!.query('SELECT count(*) AS count FROM collaboration_documents WHERE path=$1', ['racing.docx'])).rows[0].count), 0);
    };
    try { assert.equal((await expectSuccess('racing.docx')).stats.sha256, sha256Buffer(officeBytes)); }
    finally { beforeOffice = undefined; }
    const afterRead = await openConnection();
    try {
      await afterRead.run('BEGIN');
      await assertWorkspaceFileLifecycleSqlAvailable(afterRead, workspace.workspaceId, ['racing.docx', 'moved.docx']);
      await afterRead.run('ROLLBACK');
    } finally { await afterRead.close(); }
    console.log('PASS same shared SQL fence blocks initialization until its SQL lock timeout and rejects move admission through Office recovery; released after response');

    phase = 'real DA04 reservation permits native reads but rejects new lifecycle writes';
    const actionPayloadText = JSON.stringify({ source: 'native.docx', target: 'reserved-target.docx' });
    const request: CollaborationAdmissionRequest = { requestId: randomUUID(), actorId: 'owner', action: 'rename',
      actionPayloadText, actionDigest: collaborationAdmissionActionDigest('rename', actionPayloadText),
      scopes: [{ workspaceId: workspace.workspaceId, organizationId: null, path: 'native.docx', kind: 'exact' },
        { workspaceId: workspace.workspaceId, organizationId: null, path: 'reserved-target.docx', kind: 'exact' }],
      expectedDocuments: [{ documentId: nativeId, workspaceId: workspace.workspaceId, organizationId: null, path: 'native.docx',
        representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1, status: 'active' }] };
    const admission = createCollaborationAdmissionService({ openConnection: () => openConnection() });
    const reservation = await admission.reserve(request);
    const officeBeforeReservation = officeReads;
    try {
      assert.equal((await expectSuccess('native.docx')).nativeSource.documentId, nativeId);
      await assert.rejects(withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: ['native.docx', 'reserved-target.docx'] },
        async () => assert.fail('A reserved lifecycle writer must never reach physical publication.'), () => openConnection()),
      { code: 'COLLABORATION_FILE_LIFECYCLE_BUSY' });
      assert.equal(officeReads, officeBeforeReservation);
    } finally { await admission.cancel(request, reservation.revision); }
    assert.equal(live.size, 0); assert.equal(readFences.size, 0); assert(kernelEntries > 0);
    console.log('PASS real DA04 reservation remains read-only reachable and rejects new lifecycle publication; no native Office side effects');
  } catch (error) {
    console.error('Native DOCX original failure:', phase,
      error instanceof Error ? error.message.slice(0, 400) : 'Unknown failure');
    throw error;
  } finally {
    try {
      setFileCollaborationConnectionFactoryForTests(null);
      assert.equal(live.size, 0, 'Every owned checkout must close before schema cleanup.');
      await pool?.end();
      if (created) {
        assert.match(schema, schemaPattern);
        const owned = (await control.query('SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_namespace WHERE nspname=$1', [schema])).rows[0];
        assert.equal(owned?.owned, true);
        await control.query(`DROP SCHEMA "${schema}" CASCADE`);
        assert.equal(Number((await control.query('SELECT count(*) AS count FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].count), 0);
        console.log('PASS owned PG18 schema/checkouts cleanup; no public-table mutations or host/container runtime');
      }
    } finally {
      await control.end(); await rm(root, { recursive: true, force: true });
      for (const key of ['DATA', 'CANVAS_DATA_ROOT'] as const) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
    }
  }
}

main().catch((error: unknown) => {
  const rawCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const code = /^[A-Za-z0-9_-]{1,40}$/u.test(rawCode) ? rawCode : 'unknown';
  console.error(`Native DOCX API PostgreSQL fixture failed during ${phase} (${code}).`);
  if (error instanceof assert.AssertionError) console.error(error.message.slice(0, 400));
  process.exitCode = 1;
});

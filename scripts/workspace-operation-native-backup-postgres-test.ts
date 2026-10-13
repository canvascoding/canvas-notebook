import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { Pool, types } from 'pg';
import * as Y from 'yjs';
import type { SqlConnection } from '../app/lib/db';
import { COLLABORATION_NATIVE_COPY_STATEMENTS } from '../app/lib/db/collaboration-native-copy-migration';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { completeNativeCopyPublication, persistNativeWorkspaceCopies } from '../app/lib/collaboration/native-copy-persistence';
import { tryLockCollaborationAdmissionWorkspace } from '../app/lib/collaboration/room-admission';
import { readWorkspaceDocumentCatalogue } from '../app/lib/collaboration/workspace-document-catalogue';
import { readNativeWorkspaceRecoveryRecords } from '../app/lib/collaboration/workspace-native-recovery';
import { withFileCollaborationReadSnapshot } from '../app/lib/files/collaboration-repository';
import { withWorkspaceFileLifecycleGuard } from '../app/lib/files/workspace-file-lifecycle-guard';
import { captureWorkspaceOperationBackup, listWorkspaceOperationBackups, restoreWorkspaceOperationBackup,
  type WorkspaceOperationBackupDependencies, WorkspaceOperationBackupError } from '../app/lib/files/workspace-operation-backup';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';
import { inspectNativeWorkspaceCopy } from '../app/lib/collaboration/workspace-native-copy';
import { readNativeCopyReceipt } from '../app/lib/collaboration/native-copy-result';
import { copyNativeWorkspaceOperationBackup } from '../app/lib/files/workspace-operation-backup';

const PREFIX = 'canvas_native_backup_test_';
const SCHEMA = new RegExp(`^${PREFIX}[0-9a-f]{32}$`, 'u');
const TABLES = ['file_collaboration_lineages', 'collaboration_documents', 'collaboration_yjs_states',
  'collaboration_yjs_state_backups', 'collaboration_agent_operations', 'collaboration_excalidraw_states',
  'file_revisions', 'file_locks', 'file_guest_invitations', 'collaboration_admission_requests',
  'collaboration_admission_scopes', 'collaboration_admission_targets'] as const;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function identifier(value: string) { if (!SCHEMA.test(value)) throw new Error('Refusing a non-generated native-backup schema.'); return `"${value}"`; }
async function main() {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) {
    console.log('SKIP native operation backup PostgreSQL fixtures: managed PG18 connection not supplied.'); return;
  }
  const url = new URL(process.env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.port !== '55433' || decodeURIComponent(url.pathname) !== '/canvas_notebook') throw new Error('Native backup tests accept only managed loopback PG18.');
  const schema = `${PREFIX}${randomUUID().replaceAll('-', '')}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-native-backup-'));
  const previousData = process.env.DATA; process.env.DATA = root;
  const admin = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 3000, allowExitOnIdle: true });
  let pool: Pool | undefined;
  try {
    const version = await admin.query(`SELECT current_setting('server_version_num')::int AS version,current_database() AS database`);
    assert.equal(Math.floor(version.rows[0].version / 10000), 18); assert.equal(version.rows[0].database, 'canvas_notebook');
    for (const table of TABLES) assert.equal((await admin.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${table}`])).rows[0].present, true);
    await admin.query(`CREATE SCHEMA ${identifier(schema)}`);
    pool = new Pool({ connectionString: url.toString(), max: 8, connectionTimeoutMillis: 3000, allowExitOnIdle: true,
      types: { getTypeParser: (oid, format) => oid === types.builtins.INT8 ? (value: string) => Number.parseInt(value, 10) : types.getTypeParser(oid, format) },
      options: `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=8000`, application_name: 'native-backup-isolated-fixtures' });
    const fixturePool = pool;
    for (const table of TABLES) await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    for (const sql of COLLABORATION_NATIVE_COPY_STATEMENTS) await pool.query(sql);
    const openConnection = async (): Promise<SqlConnection> => {
      const client = await fixturePool.connect(); let closed = false;
      const query = async (sql: string, values: unknown[] = []) => (await client.query(sql, values)).rows;
      return { run: query, all: query, get: async (sql, values) => (await query(sql, values))[0],
        close: async error => { if (!closed) { closed = true; client.release(error); } } };
    };
    const workspace: WorkspaceContext = { workspaceId: `${schema}-workspace`, workspaceType: 'personal', organizationId: null,
      rootPath: path.join(root, 'workspace', 'files'), ownerUserId: 'native-backup-tester', legacy: false, status: 'active',
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false, canManageWorkspace: true, canRunAgent: true } };
    await fs.mkdir(workspace.rootPath, { recursive: true });
    // A genuine held kernel fence denies a second reservation connection.
    await withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: ['admission-denied.md'] }, async () => {
      const competitor = await openConnection();
      try {
        await competitor.run('BEGIN');
        await assert.rejects(() => tryLockCollaborationAdmissionWorkspace(async (sql, values) =>
          await competitor.all(sql, values) as Array<Record<string, unknown>>, workspace.workspaceId));
      } finally { await competitor.run('ROLLBACK'); await competitor.close(); }
    }, openConnection);
    const dependencies: WorkspaceOperationBackupDependencies = {
      captureNative: (workspace, path) => withFileCollaborationReadSnapshot(connection => readNativeWorkspaceRecoveryRecords(connection, workspace, path), openConnection),
      withLifecycleGuard: (scope, work) => withWorkspaceFileLifecycleGuard(scope, work, openConnection),
      readTargetCatalogue: (workspace, path) => withFileCollaborationReadSnapshot(connection => readWorkspaceDocumentCatalogue(connection, workspace, { paths: [path] }), openConnection),
      persistCopies: input => persistNativeWorkspaceCopies(input, openConnection),
      completePublication: input => completeNativeCopyPublication(input, openConnection),
    };
    const targetWorkspace: WorkspaceContext = { ...workspace, workspaceId: `${schema}-copy-target`,
      rootPath: path.join(root, 'target', 'files') };
    await fs.mkdir(targetWorkspace.rootPath, { recursive: true });
    const copyFile = path.resolve('app/lib/filesystem/workspace-files.ts');
    const copySource = ts.transpileModule(await fs.readFile(copyFile, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const copyModule = { exports: {} as typeof import('../app/lib/filesystem/workspace-files') };
    const loadCopy = createRequire(copyFile);
    new Function('require', 'module', 'exports', copySource)((name: string) => {
      if (name === '@/app/lib/files/workspace-file-lifecycle-guard') return {
        withWorkspaceFileLifecycleGuards: async (scopes: Array<{ workspaceId: string; paths: string[] }>, work: () => Promise<unknown>) => {
          const ordered = [...scopes].sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
          const enter = (index: number): Promise<unknown> => index === ordered.length ? work()
            : withWorkspaceFileLifecycleGuard(ordered[index], () => enter(index + 1), openConnection);
          return enter(0);
        },
      };
      return loadCopy(name);
    }, copyModule, copyModule.exports);
    const copyDependencies = { inspect: (input: Parameters<typeof inspectNativeWorkspaceCopy>[0]) => inspectNativeWorkspaceCopy(input, openConnection),
      publish: (input: Parameters<typeof copyNativeWorkspaceOperationBackup>[0]) => copyNativeWorkspaceOperationBackup(input, dependencies) };
    for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
      const doc = nativeTableWidthFixture(representation, 'A\tB\r\n😀');
      const sourceId = `native-${representation}`; const lineageId = `lineage-${representation}`; const sourcePath = `${representation}.md`;
      try {
        doc.getText('frontmatter').insert(0, '---\r\ntitle: Private native backup fixture\r\n---\r\n');
        doc.getText('bodyFinalLineEnding').insert(0, '\r\n\r\n');
        await pool.query(`INSERT INTO file_collaboration_lineages (id,workspace_id,workspace_type,path,status,created_at)
          VALUES ($1,$2,'personal',$3,'active',1)`, [lineageId, workspace.workspaceId, sourcePath]);
        await pool.query(`INSERT INTO collaboration_documents (id,lineage_id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at)
          VALUES ($1,$2,$3,'personal',$4,'yjs','active',0,1,1)`, [sourceId, lineageId, workspace.workspaceId, sourcePath]);
        await pool.query(`INSERT INTO collaboration_yjs_states (document_id,workspace_id,path,representation,lifecycle_generation,schema_version,
          yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,newline_style,has_bom,degraded,status)
          VALUES ($1,$2,$3,$4,1,1,$5,$6,3,1,0,'crlf',1,0,'active')`,
        [sourceId, workspace.workspaceId, sourcePath, representation, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))]);
        if (representation === 'tiptap_xml') await fs.writeFile(path.join(workspace.rootPath, sourcePath), 'stale filesystem projection\n');
        const backup = await captureWorkspaceOperationBackup({ workspace, path: sourcePath, operationId: `capture-${representation}` }, dependencies);
        assert.equal(backup.version, 2); assert.equal(backup.nativePayload?.documentCount, 1);
        assert.equal(backup.entries[0].type, representation === 'tiptap_xml' ? 'file' : 'native_document');
        const copyOptions = { source: { workspace }, target: { workspace: targetWorkspace,
          mutationActorUserId: 'native-backup-tester', mutationActorSessionId: 'copy-session', mutationOperationId: `native-copy-${representation}` } };
        const copied = await copyModule.exports.copyFileBetweenWorkspaces(sourcePath, '.', true, true, copyOptions, copyDependencies);
        assert.equal(copied.copied, sourcePath); assert.equal(copied.collaborationInitialized, true);
        const copyReceipt = readNativeCopyReceipt(copied); assert.ok(copyReceipt); assert.equal(copyReceipt.publicationStatus, 'published');
        assert.notEqual(copyReceipt.documents[0].clone.documentId, sourceId);
        for (const privateValue of ['documents', 'blockIdMapping', 'stateProof', sourceId]) assert.equal(JSON.stringify(copied).includes(privateValue), false);
        assert.deepEqual(readNativeCopyReceipt(await copyModule.exports.copyFileBetweenWorkspaces(sourcePath, '.', false, true,
          copyOptions, copyDependencies)), copyReceipt);
        const renamed = await copyModule.exports.copyFileBetweenWorkspaces(sourcePath, '.', false, true,
          { ...copyOptions, target: { ...copyOptions.target, mutationOperationId: `native-collision-${representation}` } }, copyDependencies);
        assert.equal(renamed.copied, `${representation} (1).md`, 'native-only names participate in collision selection');
        if (representation === 'tiptap_blocks') await assert.rejects(fs.lstat(path.join(targetWorkspace.rootPath, sourcePath)), { code: 'ENOENT' });
        else assert.equal(await fs.readFile(path.join(targetWorkspace.rootPath, sourcePath), 'utf8'), 'stale filesystem projection\n');
        await assert.rejects(() => copyModule.exports.copyFileBetweenWorkspaces(sourcePath, '.', true, false,
          { ...copyOptions, target: { ...copyOptions.target, mutationOperationId: `unsupported-replace-${representation}` } }, copyDependencies),
        error => error instanceof Error && 'code' in error && error.code === 'NATIVE_COPY_REPLACEMENT_UNSUPPORTED');
        const scopeFolder = path.join(root, '.workspace-operation-backups', hash(JSON.stringify(['personal', null, workspace.workspaceId])), backup.backupId);
        assert.equal((await fs.stat(path.join(scopeFolder, 'native.bin'))).mode & 0o077, 0);
        const metadata = JSON.stringify(await listWorkspaceOperationBackups({ workspace }));
        for (const privateValue of [sourceId, lineageId, 'Private native backup fixture', 'stateVector', 'stateProof', 'yjsState']) assert.equal(metadata.includes(privateValue), false);
        const restore = { workspace, backupId: backup.backupId, targetPath: `restored-${representation}.md`,
          operationId: `restore-${representation}`, actorUserId: 'native-backup-tester', actorSessionId: 'native-fixture-session' };
        await pool.query(`INSERT INTO collaboration_admission_requests (request_id,request_digest,intent_text,status,revision,created_at)
          VALUES ($1,$2,'fixture','reserved',1,1)`, [`reserved-${representation}`, hash('reserved')]);
        await pool.query(`INSERT INTO collaboration_admission_scopes (request_id,ordinal,workspace_id,path,kind)
          VALUES ($1,0,$2,$3,'exact')`, [`reserved-${representation}`, workspace.workspaceId, restore.targetPath]);
        await assert.rejects(() => restoreWorkspaceOperationBackup(restore, dependencies), error => error instanceof Error
          && 'code' in error && error.code === 'COLLABORATION_FILE_LIFECYCLE_BUSY');
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM collaboration_documents WHERE path=$1', [restore.targetPath])).rows[0].count, 0);
        await assert.rejects(fs.lstat(path.join(workspace.rootPath, restore.targetPath)), { code: 'ENOENT' });
        await pool.query("UPDATE collaboration_admission_requests SET status='cancelled' WHERE request_id=$1", [`reserved-${representation}`]);
        const restored = await restoreWorkspaceOperationBackup(restore, dependencies);
        assert.equal(restored.collaborationInitialized, true); assert.equal(restored.recoveryMode, 'native_complete');
        const connection = await openConnection();
        try {
          const records = await readNativeWorkspaceRecoveryRecords(connection, workspace, restored.restoredPath);
          assert.equal(records.length, 1); assert.notEqual(records[0].state.documentId, sourceId); assert.notEqual(records[0].lineageId, lineageId);
          assert.equal(records[0].state.hasBom, true); assert.equal(records[0].state.newlineStyle, 'crlf');
          assert.match(JSON.stringify(authoritativeNativeCollaborationSnapshot(records[0].state).content), /"colwidth":\[120\]/u);
          if (representation === 'tiptap_blocks') await assert.rejects(fs.stat(path.join(workspace.rootPath, restored.restoredPath)), { code: 'ENOENT' });
          else assert.equal(await fs.readFile(path.join(workspace.rootPath, restored.restoredPath), 'utf8'), 'stale filesystem projection\n');
          assert.deepEqual(await restoreWorkspaceOperationBackup(restore, dependencies), restored);
          // A partial directory publication cannot erase a peer-added file on retry.
          if (representation === 'tiptap_blocks') {
            await persistNativeWorkspaceCopies({ operationId: 'seed-native-bundle', actorUserId: 'native-backup-tester', kind: 'native_clone',
              sourceWorkspace: workspace, targetWorkspace: workspace, targetScopes: ['bundle'], expectedTargets: [],
              copies: [{ source: records[0], targetPath: 'bundle/note.md' }] }, openConnection);
            await fs.mkdir(path.join(workspace.rootPath, 'bundle')); await fs.writeFile(path.join(workspace.rootPath, 'bundle', 'raw.bin'), 'raw backup bytes');
            await fs.mkdir(path.join(workspace.rootPath, 'bundle', 'nested'));
            await fs.writeFile(path.join(workspace.rootPath, 'bundle', 'nested', 'child.bin'), 'nested raw backup bytes');
            const bundle = await captureWorkspaceOperationBackup({ workspace, path: 'bundle', operationId: 'capture-bundle' }, dependencies);
            const bundleOptions = { source: { workspace }, target: { workspace: targetWorkspace,
              mutationActorUserId: 'native-backup-tester', mutationOperationId: 'cross-workspace-native-bundle' } };
            const copiedBundle = await copyModule.exports.copyFileBetweenWorkspaces('bundle', '.', false, false, bundleOptions, copyDependencies);
            assert.equal(copiedBundle.copied, 'bundle');
            assert.equal(readNativeCopyReceipt(copiedBundle)?.documents.length, 1);
            assert.equal(await fs.readFile(path.join(targetWorkspace.rootPath, 'bundle', 'nested', 'child.bin'), 'utf8'), 'nested raw backup bytes');
            await assert.rejects(fs.lstat(path.join(targetWorkspace.rootPath, 'bundle', 'note.md')), { code: 'ENOENT' });
            await fs.writeFile(path.join(workspace.rootPath, 'bundle', 'unsupported.docx'), 'synthetic Word marker');
            await assert.rejects(() => copyModule.exports.copyFileBetweenWorkspaces('bundle', '.', false, true,
              { ...bundleOptions, target: { ...bundleOptions.target, mutationOperationId: 'mixed-native-office-bundle' } }, copyDependencies),
            error => error instanceof Error && 'code' in error && error.code === 'NATIVE_COPY_REPLACEMENT_UNSUPPORTED');
            await fs.unlink(path.join(workspace.rootPath, 'bundle', 'unsupported.docx'));
            const syncTarget = path.join(workspace.rootPath, 'synced-bundle');
            const syncPaths: string[] = [];
            const originalSyncOpen = fs.open;
            fs.open = (async (...args: Parameters<typeof fs.open>) => {
              const handle = await originalSyncOpen(...args);
              if (typeof args[0] === 'string' && typeof args[1] === 'number' && (args[1] & constants.O_DIRECTORY) !== 0) {
                const filename = args[0]; const sync = handle.sync.bind(handle);
                handle.sync = async () => { await sync(); syncPaths.push(filename); };
              }
              return handle;
            }) as typeof fs.open;
            try {
              await restoreWorkspaceOperationBackup({ workspace, backupId: bundle.backupId, targetPath: 'synced-bundle',
                operationId: 'restore-synced-bundle', actorUserId: 'native-backup-tester' }, {
                ...dependencies, completePublication: async request => {
                  const child = syncPaths.lastIndexOf(path.join(syncTarget, 'nested'));
                  const parent = syncPaths.lastIndexOf(syncTarget); const rootParent = syncPaths.lastIndexOf(workspace.rootPath);
                  assert.ok(child >= 0 && parent > child && rootParent > parent, 'child, root and destination parent fsync before native publication');
                  await dependencies.completePublication(request);
                },
              });
            } finally { fs.open = originalSyncOpen; }
            const target = path.join(workspace.rootPath, 'restored-bundle');
            const originalOpen = fs.open;
            fs.open = (async (...args: Parameters<typeof fs.open>) => {
              if (args[0] === path.join(target, 'raw.bin')) throw new Error('Injected physical restore interruption');
              return originalOpen(...args);
            }) as typeof fs.open;
            const request = { workspace, backupId: bundle.backupId, targetPath: 'restored-bundle', operationId: 'restore-bundle', actorUserId: 'native-backup-tester' };
            try { await assert.rejects(() => restoreWorkspaceOperationBackup(request, dependencies), /Injected physical/u); }
            finally { fs.open = originalOpen; }
            await fs.writeFile(path.join(target, 'peer-added.txt'), 'Peer-owned bytes');
            await assert.rejects(() => restoreWorkspaceOperationBackup(request, dependencies), error => error instanceof WorkspaceOperationBackupError && error.code === 'RESTORE_COLLISION');
            assert.equal(await fs.readFile(path.join(target, 'peer-added.txt'), 'utf8'), 'Peer-owned bytes');
            assert.equal((await pool.query(`SELECT publication_status FROM collaboration_native_copy_receipts WHERE operation_id='restore-bundle'`)).rows[0].publication_status, 'native_committed');
            // A valid payload cannot smuggle a native document omitted from the physical/logical manifest.
            const bundleFolder = path.join(root, '.workspace-operation-backups', hash(JSON.stringify(['personal', null, workspace.workspaceId])), bundle.backupId);
            const omittedEntries = bundle.entries.filter(entry => entry.type !== 'native_document');
            const omittedManifest = { ...bundle, entries: omittedEntries, fileCount: bundle.fileCount - 1,
              contentSha256: hash(JSON.stringify({ entries: omittedEntries, nativePayload: bundle.nativePayload })) };
            await fs.writeFile(path.join(bundleFolder, 'manifest.json'), JSON.stringify(omittedManifest));
            await assert.rejects(() => restoreWorkspaceOperationBackup({ workspace, backupId: bundle.backupId,
              targetPath: 'omitted-native-scope', operationId: 'restore-omitted-native', actorUserId: 'native-backup-tester' }, dependencies),
            error => error instanceof WorkspaceOperationBackupError && error.code === 'CORRUPT_BACKUP');
            assert.equal((await pool.query("SELECT count(*)::int AS count FROM collaboration_documents WHERE path LIKE 'omitted-native-scope/%'")).rows[0].count, 0);
          }
        } finally { await connection.close(); }
        // Corruption blocks before physical or native target publication.
        const nativeBytes = await fs.readFile(path.join(scopeFolder, 'native.bin')); nativeBytes[nativeBytes.length - 1] ^= 1;
        await fs.writeFile(path.join(scopeFolder, 'native.bin'), nativeBytes);
        await assert.rejects(() => restoreWorkspaceOperationBackup({ ...restore, targetPath: `corrupt-${representation}.md`, operationId: `corrupt-${representation}` }, dependencies),
          error => error instanceof WorkspaceOperationBackupError && error.code === 'CORRUPT_BACKUP');
        assert.equal((await pool.query(`SELECT count(*)::int AS count FROM collaboration_documents WHERE path=$1`, [`corrupt-${representation}.md`])).rows[0].count, 0);
      } finally { doc.destroy(); }
    }
    console.log('native backup/copy PostgreSQL: actual lifecycle guard and competing admission denial, direct cross-workspace copy, native-only collisions, private receipt accessor/JSON secrecy, stale/missing projection, native/profile preservation, fresh clone IDs, private payload integrity and exact inventory, idempotent publication, bottom-up durable directory publication, partial-directory peer preservation OK');
  } finally {
    await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`); await admin.end();
    if (previousData === undefined) delete process.env.DATA; else process.env.DATA = previousData;
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]') : 'Native backup test failed.'); process.exitCode = 1; });

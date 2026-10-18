import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SqlConnection } from '../app/lib/db';
import type { FileNode } from '../app/lib/files/types';
import type { WorkspaceDocumentTreeDependencies } from '../app/lib/files/workspace-document-tree';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Real PostgreSQL18, complete migrations and owned DATA. API-service seeds are
// genuine; explicit SQL below creates adversarial catalogue facts, not authority.
let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const code = (error: unknown) => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;

async function sceneTreeFilesystemSnapshot(root: string): Promise<unknown[]> {
  const records: unknown[] = [];
  const visit = async (relative: string): Promise<void> => {
    const absolute = path.join(root, relative), info = await fs.lstat(absolute, { bigint: true });
    records.push({ path: relative, dev: String(info.dev), ino: String(info.ino), mode: String(info.mode),
      size: String(info.size), mtime: String(info.mtimeNs), ctime: String(info.ctimeNs),
      ...(info.isFile() ? { sha256: sha(await fs.readFile(absolute)) } : {}) });
    if (info.isDirectory()) for (const name of (await fs.readdir(absolute)).sort()) await visit(path.join(relative, name));
  };
  await visit(''); return records;
}

async function workspaceSceneTreePostgresTest(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const sources = ['scripts/workspace-scene-tree-postgres-test.ts', 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-document-tree.ts', 'app/lib/collaboration/workspace-native-file-read.ts',
    'app/lib/collaboration/workspace-document-catalogue.ts', 'app/lib/collaboration/workspace-scene-catalogue.ts',
    'app/lib/filesystem/workspace-files.ts', 'app/lib/excalidraw-collaboration/scene-service.ts', 'app/lib/db/postgres.ts'];
  const pins = Object.fromEntries(await Promise.all(sources.map(async file => [file, sha(await fs.readFile(file))])));
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { readWorkspaceDocumentTree: tree } = await import('../app/lib/files/workspace-document-tree');
    const { readWorkspaceDocumentCatalogue: yjsCatalogue } = await import('../app/lib/collaboration/workspace-document-catalogue');
    const { readWorkspaceSceneCatalogue: sceneCatalogue } = await import('../app/lib/collaboration/workspace-scene-catalogue');
    const { createExcalidrawDocument } = await import('../app/lib/excalidraw-collaboration/scene-service');
    const { canonicalSceneHash } = await import('../app/lib/excalidraw-collaboration/scene');
    const { buildFileTree } = await import('../app/lib/filesystem/workspace-files');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { openDb } = await import('../app/lib/db');
    const sourceOwner = await readPostgresWorkspaceForActorOnConnection(h.connection,
      resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' }), h.source.workspaceId);
    assert(sourceOwner?.permissions.canWrite); assert(h.source.permissions.canRead && !h.source.permissions.canWrite);
    const group = async (name: string, action: () => Promise<void>) => { currentCase = name; await action(); groups++;
      console.log(`PASS workspace-scene-tree ${groups}: ${name}`); };
    const flatten = (nodes: readonly FileNode[]): string[] => nodes.flatMap(node => [`${node.type}:${node.path}`, ...flatten(node.children ?? [])]).sort();
    const databaseSnapshot = async (connection: SqlConnection = h.connection) => {
      const tables = await connection.all('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [h.schema]);
      const values: Record<string, string> = {};
      for (const table of tables) {
        assert(table && typeof table === 'object' && 'tablename' in table && typeof table.tablename === 'string');
        const { tablename } = table;
        assert.match(tablename, /^[a-z][a-z0-9_]*$/u);
        const result = await connection.get(`SELECT md5(COALESCE(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)
          ORDER BY to_jsonb(t)::text)::text,'[]')) AS digest FROM "${h.schema}"."${tablename}" t`);
        assert(result && typeof result === 'object' && 'digest' in result && typeof result.digest === 'string');
        values[tablename] = result.digest;
      }
      return values;
    };
    const initialized = async (file: string) => {
      assert(!path.isAbsolute(file) && file.split('/').every(segment => segment && segment !== '.' && segment !== '..'));
      await fs.mkdir(path.dirname(path.join(h.source.rootPath, file)), { recursive: true, mode: 0o700 });
      const scene = await createExcalidrawDocument({ workspace: sourceOwner, path: file, idempotencyKey: crypto.randomUUID(),
        actor: { userId: 'owner', actorId: 'owner', actorType: 'user', sessionId: 'session-owner' } });
      assert.equal(scene.status, 'active'); assert.equal(scene.checkpoint.status, 'saved');
      await fs.unlink(path.join(h.source.rootPath, file)); return scene;
    };
    const storedFact = async (file: string, options: { workspace?: WorkspaceContext; provider?: 'yjs' | 'excalidraw'; state?: boolean; registry?: boolean } = {}) => {
      const workspace = options.workspace ?? h.source, provider = options.provider ?? 'excalidraw';
      const id = `tree-scene-${crypto.randomUUID()}`, lineage = `tree-lineage-${crypto.randomUUID()}`;
      await h.admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,$3,$4,$5,'active',100)`, [lineage, workspace.workspaceId, workspace.workspaceType, workspace.organizationId ?? null, file]);
      if (options.registry !== false) await h.admin.query(`INSERT INTO collaboration_documents
        (id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,0,'never_initialized','active',100,100)`,
      [id, lineage, workspace.workspaceId, workspace.workspaceType, workspace.organizationId ?? null, file, provider]);
      if (options.state) await h.admin.query(`INSERT INTO collaboration_excalidraw_states
        (document_id,workspace_id,organization_id,path,lifecycle_generation,excalidraw_version,scene_schema_version,
          elements_json,shared_app_state_json,assets_json,scene_sequence,checkpoint_sequence,canonical_hash,persisted_at,status)
        VALUES($1,$2,$3,$4,1,'0.18.1',1,'[]'::jsonb,'{}'::jsonb,'[]'::jsonb,0,0,$5,100,'active')`,
      [id, workspace.workspaceId, workspace.organizationId ?? null, file, canonicalSceneHash({ elements: [], appState: {}, assets: [] })]);
      return { id, lineage, path: file };
    };
    type ReadFacts = { backend: number; sceneReads: number; yjsReads: number; physicalReads: number; committed: number; rolledBack: number; closed: number };
    let lastRead: ReadFacts | undefined;
    const read = async (directory: string, depth = 2, afterPhysical?: () => Promise<void>) => {
      const facts: ReadFacts = { backend: 0, sceneReads: 0, yjsReads: 0, physicalReads: 0, committed: 0, rolledBack: 0, closed: 0 };
      let opens = 0, begins = 0;
      const query = async (text: string, values?: unknown[]) => {
        assert.match(text, /^\s*(?:SELECT\b|BEGIN READ ONLY\s*$|SET LOCAL\b|COMMIT\s*$|ROLLBACK\s*$)/iu, 'A tree read may not perform DML.');
        const result = await h.admin.query(text, values);
        if (/^\s*BEGIN\b/iu.test(text)) begins++;
        if (/^\s*COMMIT\b/iu.test(text)) facts.committed++;
        else if (/^\s*ROLLBACK\b/iu.test(text)) facts.rolledBack++;
        else {
          const witness = (await h.admin.query(`SELECT pg_backend_pid() AS pid,current_setting('transaction_read_only') AS readonly,
            pg_current_xact_id_if_assigned()::text AS xid`)).rows[0];
          assert.equal(witness.readonly, 'on'); assert.equal(witness.xid, null);
          if (!facts.backend) facts.backend = witness.pid; assert.equal(witness.pid, facts.backend);
        }
        return result;
      };
      const connection: SqlConnection = { get: async (text, values) => (await query(text, values)).rows[0],
        all: async (text, values) => (await query(text, values)).rows,
        run: async (text, values) => ({ changes: (await query(text, values)).rowCount ?? 0 }), close: () => { facts.closed++; } };
      const dependencies: WorkspaceDocumentTreeDependencies = { openConnection: async () => { opens++; return connection; },
        readCatalogue: async (actual, workspace, options) => { assert.equal(actual, connection); facts.yjsReads++; return yjsCatalogue(actual, workspace, options); },
        readSceneCatalogue: async (actual, workspace, options) => { assert.equal(actual, connection); facts.sceneReads++; return sceneCatalogue(actual, workspace, options); },
        buildPhysicalTree: async (...args) => { facts.physicalReads++; const nodes = await buildFileTree(...args); await afterPhysical?.(); return nodes; } };
      try { return await tree(h.source, directory, depth, {}, dependencies); }
      finally {
        lastRead = facts; assert.equal(opens, 1); assert.equal(begins, 1); assert.equal(facts.closed, 1);
        assert.equal(facts.committed + facts.rolledBack, 1);
        assert.equal((await h.admin.query('SELECT pg_current_xact_id_if_assigned()::text AS xid')).rows[0].xid, null);
      }
    };
    const rejects = (expected: string) => (error: unknown) => {
      assert.equal(code(error), expected); assert.equal(Reflect.get(Object(error), 'status'), 409); return true;
    };
    let mixed = '';
    await group('API-initialized Scene remains visible with virtual parents after only its projection is removed', async () => {
      const base = `tree-virtual-${crypto.randomUUID()}`, file = `${base}/nested/drawing.excalidraw`, scene = await initialized(file);
      await fs.rmdir(path.join(h.source.rootPath, base, 'nested')); await fs.rmdir(path.join(h.source.rootPath, base));
      assert.deepEqual(flatten(await read(base, 0)), [`directory:${base}/nested`]);
      assert.deepEqual(flatten(await read(base, 1)), [`directory:${base}/nested`, `file:${file}`].sort());
      assert(lastRead); assert.equal(lastRead.physicalReads, 0); assert.equal(lastRead.sceneReads, 2); assert.equal(lastRead.yjsReads, 2);
      assert.equal((await h.admin.query('SELECT document_id FROM collaboration_excalidraw_states WHERE document_id=$1', [scene.documentId])).rows[0].document_id, scene.documentId);
      await assert.rejects(fs.lstat(path.join(h.source.rootPath, base)), { code: 'ENOENT' });
    });
    await group('mixed real Yjs/Scene/physical namespace obeys depth, hidden entries and workspace isolation', async () => {
      mixed = `tree-mixed-${crypto.randomUUID()}`;
      const note = await h.upload(`${mixed}/note.md`, Buffer.from('# Native tree\n')); await fs.unlink(path.join(h.source.rootPath, mixed, 'note.md'));
      await initialized(`${mixed}/drawing.excalidraw`); await fs.writeFile(path.join(h.source.rootPath, mixed, 'asset.pdf'), '%PDF-1.7\n%%EOF', { flag: 'wx', mode: 0o600 });
      for (const file of ['nested/deep.excalidraw', 'foreign.bin', '.git/hidden.excalidraw', '.gitkeep', '.canvas-copy-backups/hidden.excalidraw']) await storedFact(`${mixed}/${file}`);
      await storedFact(`${mixed}/foreign-only.excalidraw`, { workspace: h.destination });
      const shallow = [`directory:${mixed}/nested`, ...['asset.pdf', 'drawing.excalidraw', 'foreign.bin', 'note.md'].map(file => `file:${mixed}/${file}`)].sort();
      assert.deepEqual(flatten(await read(mixed, 0)), shallow);
      assert.deepEqual(flatten(await read(mixed, 1)), [...shallow, `file:${mixed}/nested/deep.excalidraw`].sort());
      assert.equal((await h.admin.query('SELECT document_id FROM collaboration_yjs_states WHERE document_id=$1', [note.documentId])).rows.length, 1);
    });
    await group('registry-only Scene is visible without state initialization while a pristine Yjs registry stays absent', async () => {
      const base = `tree-registry-${crypto.randomUUID()}`, scene = await storedFact(`${base}/pending.excalidraw`);
      await storedFact(`${base}/pristine.md`, { provider: 'yjs' });
      const before = await databaseSnapshot(), physical = await sceneTreeFilesystemSnapshot(h.dataRoot);
      assert.deepEqual(flatten(await read(base)), [`file:${scene.path}`]);
      assert.equal((await h.admin.query('SELECT document_id FROM collaboration_excalidraw_states WHERE document_id=$1', [scene.id])).rows.length, 0);
      assert.deepEqual(await databaseSnapshot(), before); assert.deepEqual(await sceneTreeFilesystemSnapshot(h.dataRoot), physical);
    });
    await group('actual one-backend READ ONLY reads allocate no XID or DML and preserve all table rows/xmin and filesystem identities', async () => {
      const before = await databaseSnapshot(), physical = await sceneTreeFilesystemSnapshot(h.dataRoot);
      const first = await read(mixed, 2), second = await read(mixed, 2); assert.deepEqual(second, first);
      assert(lastRead); assert.equal(lastRead.sceneReads, 2); assert.equal(lastRead.yjsReads, 2); assert.equal(lastRead.committed, 1); assert.equal(lastRead.rolledBack, 0);
      assert.deepEqual(await databaseSnapshot(), before); assert.deepEqual(await sceneTreeFilesystemSnapshot(h.dataRoot), physical);
    });
    await group('Scene registry/state ancestors, cross-provider equal paths and physical file/directory conflicts fail closed', async () => {
      const base = `tree-conflict-${crypto.randomUUID()}`;
      const leaf = await storedFact(`${base}/leaf.excalidraw`);
      await assert.rejects(read(`${leaf.path}/child`), rejects('ARCHIVE_NAME_CONFLICT'));
      const orphan = await storedFact(`${base}/orphan.excalidraw`, { registry: false, state: true });
      await assert.rejects(read(`${orphan.path}/child`), rejects('ARCHIVE_NAME_CONFLICT'));
      const duplicate = `${base}/equal/item.md`, nativeBytes = Buffer.from('# Existing native identity\n');
      const native = await h.upload(duplicate, nativeBytes), databaseBefore = await databaseSnapshot();
      // A second independent Scene identity cannot acquire this active lineage
      // path. Assert the real schema boundary and roll back every setup write.
      await h.admin.query('BEGIN');
      try {
        await assert.rejects(storedFact(duplicate), error => {
          assert.equal(code(error), '23505');
          assert.equal(Reflect.get(Object(error), 'constraint'), 'idx_file_collaboration_lineages_active_path'); return true;
        });
      } finally { await h.admin.query('ROLLBACK'); }
      assert.deepEqual(await databaseSnapshot(), databaseBefore);
      assert.deepEqual(flatten(await read(`${base}/equal`)), [`file:${duplicate}`]);
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, duplicate)), nativeBytes);
      assert.equal((await h.admin.query('SELECT document_id FROM collaboration_yjs_states WHERE document_id=$1', [native.documentId])).rows.length, 1);
      const blocked = `${base}/physical/block`;
      await fs.mkdir(path.dirname(path.join(h.source.rootPath, blocked)), { recursive: true });
      await fs.writeFile(path.join(h.source.rootPath, blocked), 'Own physical obstruction', { flag: 'wx', mode: 0o600 });
      await storedFact(`${blocked}/drawing.excalidraw`);
      const physical = await sceneTreeFilesystemSnapshot(h.dataRoot);
      await assert.rejects(read(`${base}/physical`), rejects('TREE_NAME_CONFLICT'));
      assert(lastRead); assert.equal(lastRead.rolledBack, 1); assert.deepEqual(await sceneTreeFilesystemSnapshot(h.dataRoot), physical);
    });
    await group('real concurrent Scene-header drift rolls back the tree read and leaves only the deliberate SQL fault', async () => {
      const base = `tree-drift-${crypto.randomUUID()}`, scene = await initialized(`${base}/drawing.excalidraw`);
      const physical = await sceneTreeFilesystemSnapshot(h.dataRoot), writer = await openDb();
      let changed = false, expectedDatabase: Record<string, string> | undefined;
      try {
        await assert.rejects(read(base, 1, async () => {
          assert.equal(changed, false); changed = true;
          const writerPid = await writer.get('SELECT pg_backend_pid() AS pid');
          assert(writerPid && typeof writerPid === 'object' && 'pid' in writerPid && typeof writerPid.pid === 'number');
          const readerPid = (await h.admin.query('SELECT pg_backend_pid() AS pid')).rows[0]; assert.notEqual(writerPid.pid, readerPid.pid);
          await writer.run('UPDATE collaboration_excalidraw_states SET scene_sequence=scene_sequence+1 WHERE document_id=$1', [scene.documentId]);
          expectedDatabase = await databaseSnapshot(writer);
        }), rejects('TREE_SOURCE_CHANGED'));
        assert(changed && expectedDatabase); assert(lastRead); assert.equal(lastRead.sceneReads, 2); assert.equal(lastRead.rolledBack, 1); assert.equal(lastRead.committed, 0);
        assert.deepEqual(await databaseSnapshot(), expectedDatabase); assert.deepEqual(await sceneTreeFilesystemSnapshot(h.dataRoot), physical);
        assert.equal(Number((await h.admin.query('SELECT scene_sequence FROM collaboration_excalidraw_states WHERE document_id=$1', [scene.documentId])).rows[0].scene_sequence), scene.sceneSequence + 1);
      } finally { await writer.close(); }
    });
  });
  assert.equal(groups, 6); assert.deepEqual(Object.fromEntries(await Promise.all(sources.map(async file => [file, sha(await fs.readFile(file))]))), pins);
  completed = true; console.log(JSON.stringify({ suite: 'workspace-scene-tree-postgres', groups, passed: true, sourcesUnchanged: true }));
}

void workspaceSceneTreePostgresTest().catch(error => {
  console.error(JSON.stringify({ suite: 'workspace-scene-tree-postgres', case: currentCase,
    name: error instanceof Error ? error.name : 'NonError', code: code(error),
    message: error instanceof assert.AssertionError ? error.message : undefined })); process.exitCode = 1;
});

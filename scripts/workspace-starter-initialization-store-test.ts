import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, rm, writeFile, rename, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { SqlConnection } from '../app/lib/db';
import { withObservedWorkspaceStarterDocument, WORKSPACE_STARTER_DOCUMENT_NAME } from '../app/lib/workspaces/starter-document';
import { readWorkspaceStarterInitializationIntent, recordWorkspaceStarterInitializationIntent,
  WORKSPACE_STARTER_INITIALIZATION_STATEMENTS } from '../app/lib/workspaces/starter-document-initialization-store';
import { runPgliteFixture } from './helpers/pglite-pool-harness';

/** Embedded SQL proves the actual DDL/store/rollback contract, not independent
 * PG backends, genuine Auth, lifecycle ownership, or COMMIT transport finality. */
async function main(): Promise<void> {
  const pg = new PGlite(), root = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-starter-intent-')));
  const db: SqlConnection = {
    get: async (sql, params) => (await pg.query(sql, params)).rows[0],
    all: async (sql, params) => (await pg.query(sql, params)).rows,
    run: async (sql, params) => { await pg.query(sql, params); },
    close: () => { throw new Error('The store must not close its caller connection.'); },
  };
  let groups = 0;
  const check = async (name: string, operation: () => Promise<void>) => { await operation(); groups++; console.log(`Starter intent case passed: ${name}`); };
  async function workspace(id: string, type = 'personal', projectId: string | null = null): Promise<string> {
    const directory = path.join(root, id); await mkdir(directory);
    await pg.query(`INSERT INTO canvas_workspaces(id,organization_id,type,project_id,root_relative_path,status)
      VALUES($1,'starter-org',$2,$3,$1,'active')`, [id, type, projectId]);
    return directory;
  }
  const record = (id: string, directory: string, type: 'personal' | 'project' = 'personal', projectId: string | null = null) =>
    withObservedWorkspaceStarterDocument({ rootPath: directory, workspaceType: type }, observation =>
      recordWorkspaceStarterInitializationIntent(db, { workspaceId: id, actorUserId: 'starter-user', organizationId: 'starter-org',
        workspaceType: type, projectId, rootRelativePath: id, observation }));
  try {
    await pg.exec(`CREATE TABLE canvas_workspaces(id text PRIMARY KEY,organization_id text,type text NOT NULL,
      project_id text,root_relative_path text NOT NULL,status text NOT NULL)`);
    for (let repetition = 0; repetition < 2; repetition++) for (const sql of WORKSPACE_STARTER_INITIALIZATION_STATEMENTS) await pg.exec(sql);
    await check('actual created/existing source records use stable UUIDs and roundtrip exact namespaces', async () => {
      const firstRoot = await workspace('created'), first = await record('created', firstRoot);
      assert.equal(first.seedDisposition, 'created'); assert.match(first.operationId, /^[a-f0-9-]{36}$/u); assert.notEqual(first.operationId, first.requestId);
      assert(Object.isFrozen(first)); assert.deepEqual(await readWorkspaceStarterInitializationIntent(db, 'created'), first);
      const secondRoot = await workspace('existing', 'project', 'project-1'), bytes = Buffer.from('\ufeffOriginal 😀\r\n');
      await writeFile(path.join(secondRoot, WORKSPACE_STARTER_DOCUMENT_NAME), bytes);
      const second = await record('existing', secondRoot, 'project', 'project-1');
      assert.equal(second.seedDisposition, 'existing'); assert.equal(second.sourceBytes, bytes.length); assert.equal(second.projectId, 'project-1');
      assert.notEqual(first.operationId, second.operationId); assert.deepEqual(await readFile(path.join(secondRoot, WORKSPACE_STARTER_DOCUMENT_NAME)), bytes);
      assert.deepEqual(await readWorkspaceStarterInitializationIntent(db, 'existing'), second);
      assert.equal(await readWorkspaceStarterInitializationIntent(db, 'missing'), null);
    });
    await check('intent and actual Workspace row rollback together; no fabricated completion row exists', async () => {
      await pg.exec('BEGIN');
      const directory = await workspace('rolled-back'); await record('rolled-back', directory);
      await pg.exec('ROLLBACK');
      assert.equal(await readWorkspaceStarterInitializationIntent(db, 'rolled-back'), null);
      assert.deepEqual((await pg.query(`SELECT id FROM canvas_workspaces WHERE id='rolled-back'`)).rows, []);
      const columns = (await pg.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
        WHERE table_name='canvas_workspace_starter_initializations'`)).rows.map(row => row.column_name);
      assert.equal(columns.some(column => /complete|document_id|lineage_id|state_proof/u.test(column)), false);
    });
    await check('immutable intents reject UPDATE/standalone DELETE/duplicate insert but allow genuine parent FK cascade', async () => {
      const original = await readWorkspaceStarterInitializationIntent(db, 'created'); assert(original);
      await assert.rejects(pg.query(`UPDATE canvas_workspace_starter_initializations SET source_sha256=$1 WHERE workspace_id='created'`, ['a'.repeat(64)]), /immutable/u);
      await assert.rejects(pg.query(`DELETE FROM canvas_workspace_starter_initializations WHERE workspace_id='created'`), /immutable/u);
      await assert.rejects(record('created', path.join(root, 'created')), /duplicate/u);
      assert.deepEqual(await readWorkspaceStarterInitializationIntent(db, 'created'), original);
      await pg.query(`DELETE FROM canvas_workspaces WHERE id='created'`);
      assert.equal(await readWorkspaceStarterInitializationIntent(db, 'created'), null);
    });
    await check('database trigger independently rejects foreign scope and raw invalid source facts', async () => {
      const original = await db.get(`SELECT * FROM canvas_workspace_starter_initializations WHERE workspace_id='existing'`) as Record<string, unknown>;
      const directory = await workspace('raw-invalid', 'project', 'project-1'); assert(directory);
      for (const patch of [{ organization_id: 'foreign' }, { workspace_type: 'team' }, { project_id: 'other' }, { root_relative_path: 'other' },
        { source_bytes: 5242881 }, { path: 'other.md' }, { source_file_version: '1:2:999:1:2' }, { operation_id: 'invalid' }]) {
        const row = { ...original, workspace_id: 'raw-invalid', operation_id: randomUUID(), request_id: randomUUID(), root_relative_path: 'raw-invalid', ...patch };
        const keys = Object.keys(row);
        await assert.rejects(pg.query(`INSERT INTO canvas_workspace_starter_initializations(${keys.join(',')})
          VALUES(${keys.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(row)));
      }
      assert.equal(await readWorkspaceStarterInitializationIntent(db, 'raw-invalid'), null);
    });
    await check('replacement after actual INSERT is rejected and caller rollback preserves D2 without persisting the old expectation', async () => {
      await pg.exec('BEGIN'); const directory = await workspace('source-race'), file = path.join(directory, WORKSPACE_STARTER_DOCUMENT_NAME);
      const replacing: SqlConnection = { ...db, get: async (sql, values) => {
        const row = await db.get(sql, values);
        if (sql.startsWith('INSERT INTO canvas_workspace_starter_initializations')) { await rename(file, `${file}.old`); await writeFile(file, 'D2'); }
        return row;
      } };
      await assert.rejects(withObservedWorkspaceStarterDocument({ rootPath: directory, workspaceType: 'personal' }, observation =>
        recordWorkspaceStarterInitializationIntent(replacing, { workspaceId: 'source-race', actorUserId: 'starter-user', organizationId: 'starter-org',
          workspaceType: 'personal', projectId: null, rootRelativePath: 'source-race', observation })), /source-changed/u);
      await pg.exec('ROLLBACK'); assert.equal(await readWorkspaceStarterInitializationIntent(db, 'source-race'), null);
      assert.equal(await readFile(file, 'utf8'), 'D2');
    });
    await check('strict row decoder accepts actual default bigint strings but rejects unsafe clocks, omitted fields and accessors', async () => {
      const row = await db.get(`SELECT * FROM canvas_workspace_starter_initializations WHERE workspace_id='existing'`) as Record<string, unknown>;
      // Raw decoder boundaries only; these objects do not claim SQL/Auth authority.
      const boundary = (raw: unknown): SqlConnection => ({ ...db, get: async () => raw });
      const stringClocks = { ...row, source_bytes: String(row.source_bytes), created_at: String(row.created_at) };
      assert.deepEqual(await readWorkspaceStarterInitializationIntent(boundary(stringClocks), 'existing'), await readWorkspaceStarterInitializationIntent(db, 'existing'));
      const missing = { ...row }; delete missing.project_id;
      let reads = 0; const getter = { ...row }; Object.defineProperty(getter, 'source_sha256', { enumerable: true, get: () => { reads++; return 'a'.repeat(64); } });
      for (const invalid of [missing, getter, { ...row, extra: true }, { ...row, created_at: '9007199254740992' }, { ...row, source_bytes: '01' },
        { ...row, workspace_id: 'foreign' }, { ...row, root_relative_path: '../escape' }]) {
        await assert.rejects(readWorkspaceStarterInitializationIntent(boundary(invalid), 'existing'), /WORKSPACE_STARTER_INITIALIZATION_INVALID/u);
      }
      assert.equal(reads, 0);
    });
    assert.equal(groups, 6);
  } finally { try { await pg.close(); } finally { await rm(root, { recursive: true, force: true }); } }
}
void runPgliteFixture({ label: 'workspace-starter-intent', operation: main, successMessage: 'Starter intent embedded SQL: 6 groups passed; owned cleanup settled.' });

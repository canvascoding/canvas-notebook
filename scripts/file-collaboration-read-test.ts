import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import ts from 'typescript';
import type { SqlConnection } from '../app/lib/db';
import * as repository from '../app/lib/files/collaboration-repository';
import * as pathGuard from '../app/lib/workspaces/path-guard';
import type * as Policy from '../app/lib/files/collaboration-policy';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-collaboration-read-'));
  const postgres = new PGlite();
  const workspace: WorkspaceContext = {
    workspaceId: 'workspace', workspaceType: 'organization', rootPath: root,
    organizationId: 'organization', legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true,
      canManageWorkspace: false, canRunAgent: true },
  };
  let transactionOpen = false;
  let opens = 0;
  const queries: string[] = [];
  const connect = async (): Promise<SqlConnection> => {
    opens++;
    const query = async (sql: string, parameters: unknown[] = []) => {
      const normalized = sql.replace(/\s+/gu, ' ').trim();
      queries.push(normalized);
      assert(!/FOR UPDATE|pg_advisory|INSERT|DELETE/iu.test(normalized), 'identity lookup cannot mutate metadata or take mutation locks');
      if (normalized.startsWith('BEGIN')) {
        assert.equal(normalized, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        transactionOpen = true;
      }
      const result = await postgres.query(sql, parameters);
      if (normalized === 'COMMIT' || normalized === 'ROLLBACK') transactionOpen = false;
      return result;
    };
    return {
      get: async (sql, params) => (await query(sql, params)).rows[0],
      all: async (sql, params) => (await query(sql, params)).rows,
      run: async (sql, params) => ({ changes: (await query(sql, params)).affectedRows }),
      close: () => assert.equal(transactionOpen, false),
    };
  };
  try {
    await fs.mkdir(path.join(root, 'folder'));
    await fs.writeFile(path.join(root, 'folder', 'Notes.md'), 'File bytes are irrelevant to metadata lookup.');
    await fs.symlink('folder', path.join(root, 'alias'));
    await postgres.exec(`
      CREATE TABLE file_collaboration_lineages (id text PRIMARY KEY, workspace_id text, path text, status text,
        organization_id text, customer_id text, project_id text, workspace_type text, created_at bigint,
        archived_at bigint, trash_entry_id text);
      CREATE TABLE file_revisions (id text PRIMARY KEY, lineage_id text, revision_number bigint, workspace_id text,
        path text, content_hash text, size_bytes bigint, organization_id text, customer_id text, project_id text,
        workspace_type text, created_by_user_id text, created_by_actor_type text, source_session_id text,
        base_revision_id text, created_at bigint);
      CREATE TABLE collaboration_documents (id text PRIMARY KEY, lineage_id text, workspace_id text, path text,
        provider text, state_version bigint, snapshot_revision_id text, status text, organization_id text,
        customer_id text, project_id text, workspace_type text, created_at bigint, updated_at bigint);
      CREATE TABLE file_locks (id text PRIMARY KEY, lineage_id text, workspace_id text, path text, revision_id text,
        status text, expires_at bigint, updated_at bigint, organization_id text, customer_id text, project_id text,
        workspace_type text, locked_by_user_id text, locked_by_session_id text, lock_type text, created_at bigint);
      INSERT INTO file_collaboration_lineages (id, workspace_id, path, status) VALUES
        ('lineage', 'workspace', 'folder/Notes.md', 'active'),
        ('empty-lineage', 'workspace', 'empty.md', 'active'),
        ('other-lineage', 'other-workspace', 'folder/Notes.md', 'active');
      INSERT INTO file_revisions (id, lineage_id, revision_number, workspace_id, path, content_hash, size_bytes) VALUES
        ('revision', 'lineage', 1, 'workspace', 'historical-name.md', 'hash', 4),
        ('other-revision', 'other-lineage', 99, 'other-workspace', 'folder/Notes.md', 'other', 8),
        ('legacy-revision', NULL, 1, 'workspace', 'legacy.md', 'legacy', 2);
      INSERT INTO collaboration_documents (id, lineage_id, workspace_id, path, provider, state_version, snapshot_revision_id, status) VALUES
        ('document', 'lineage', 'workspace', 'folder/Notes.md', 'yjs', 3, 'revision', 'active'),
        ('other-document', 'other-lineage', 'other-workspace', 'folder/Notes.md', 'yjs', 99, 'other-revision', 'active');
      INSERT INTO file_locks (id, lineage_id, workspace_id, path, status, expires_at, updated_at) VALUES
        ('expired-lock', 'lineage', 'workspace', 'folder/Notes.md', 'active', 10, 100),
        ('active-lock', 'lineage', 'workspace', 'folder/Notes.md', 'active', 1000, 200);
    `);
    repository.setFileCollaborationConnectionFactoryForTests(connect);
    const filename = path.resolve('app/lib/files/collaboration-policy.ts');
    const require = createRequire(filename);
    const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    });
    const policy = {} as typeof Policy;
    new Function('require', 'module', 'exports', compiled.outputText)((name: string) => {
      if (name === '@/app/lib/files/collaboration-repository') return repository;
      if (name === '@/app/lib/files/workspace-mutation-lock') return {
        withWorkspaceMutationLock: async () => { throw new Error('Workspace mutation fence used'); },
      };
      if (name === '@/app/lib/workspaces/path-guard') return {
        ...pathGuard,
        assertWorkspacePathHasNoAliases: async (...args: Parameters<typeof pathGuard.assertWorkspacePathHasNoAliases>) => {
          assert.equal(transactionOpen, false, 'filesystem checks must finish before the DB snapshot starts');
          assert.deepEqual(args[2], { readOnly: true });
          return pathGuard.assertWorkspacePathHasNoAliases(...args);
        },
      };
      return require(name);
    }, { exports: policy }, policy);

    const state = await policy.readFileCollaborationState({ workspace, path: './folder\\Notes.md', nowMs: 500 });
    assert.equal(state.path, 'folder/Notes.md'); assert.equal(state.lineageId, 'lineage');
    assert.equal(state.document?.id, 'document'); assert.equal(state.document?.stateVersion, 3);
    assert.equal(state.latestRevision?.id, 'revision');
    assert.equal(state.latestRevision?.path, 'historical-name.md', 'renamed files retain valid historical revisions through lineage identity');
    assert.equal(state.activeLock?.id, 'active-lock');
    assert.equal(state.crdtCapable, true); assert.equal(state.strategy, 'crdt_text');
    assert.equal((await postgres.query<{ status: string }>("SELECT status FROM file_locks WHERE id = 'expired-lock'")).rows[0].status,
      'active', 'reads ignore expired leases without changing their stored status');
    await assert.rejects(policy.getFileCollaborationState({ workspace, path: 'folder/Notes.md', ensureDocument: false }),
      /Workspace mutation fence used/, 'the existing mutation path keeps its original fence');

    const empty = await policy.readFileCollaborationState({ workspace, path: 'empty.md' });
    assert.equal(empty.lineageId, 'empty-lineage'); assert.equal(empty.document, null); assert.equal(empty.latestRevision, null);
    const absent = await policy.readFileCollaborationState({ workspace, path: 'absent.md' });
    assert.equal(absent.lineageId, null); assert.equal(absent.document, null); assert.equal(absent.latestRevision, null);
    const legacy = await policy.readFileCollaborationState({ workspace, path: 'legacy.md' });
    assert.equal(legacy.lineageId, null); assert.equal(legacy.latestRevision?.id, 'legacy-revision');
    assert.equal(legacy.document, null, 'a metadata read cannot bootstrap collaboration');

    const priorOpens = opens;
    await assert.rejects(policy.readFileCollaborationState({ workspace: { ...workspace,
      permissions: { ...workspace.permissions, canRead: false } }, path: 'folder/Notes.md' }), { status: 403 });
    await assert.rejects(policy.readFileCollaborationState({ workspace: { ...workspace, status: 'archived' }, path: 'folder/Notes.md' }), { status: 403 });
    await assert.rejects(policy.readFileCollaborationState({ workspace, path: '../outside.md' }), { code: 'WORKSPACE_PATH_OUTSIDE_ROOT' });
    await assert.rejects(policy.readFileCollaborationState({ workspace, path: 'alias/Notes.md' }), { code: 'WORKSPACE_PATH_ALIAS' });
    assert.equal(opens, priorOpens, 'permission and path failures must occur before opening a DB connection');

    const missingRoot = { ...workspace, rootPath: path.join(root, 'missing-root') };
    await assert.rejects(policy.readFileCollaborationState({ workspace: missingRoot, path: 'Notes.md' }), { code: 'ENOENT' });
    await assert.rejects(fs.stat(missingRoot.rootPath), { code: 'ENOENT' });
    await pathGuard.assertWorkspacePathHasNoAliases(missingRoot, 'Notes.md');
    assert((await fs.stat(missingRoot.rootPath)).isDirectory(), 'default guard behavior still prepares roots for existing mutation callers');

    const rootAlias = path.join(root, 'root-alias'); await fs.symlink(root, rootAlias);
    assert.equal((await policy.readFileCollaborationState({ workspace: { ...workspace, rootPath: rootAlias }, path: 'folder/Notes.md' })).document?.id,
      'document', 'configured root symlinks remain supported');

    await repository.withFileCollaborationReadSnapshot(async (transaction) => {
      assert.equal((await transaction.get('SHOW transaction_isolation') as { transaction_isolation: string }).transaction_isolation, 'repeatable read');
      assert.equal((await transaction.get('SHOW transaction_read_only') as { transaction_read_only: string }).transaction_read_only, 'on');
    });
    await assert.rejects(repository.withFileCollaborationReadSnapshot(async (transaction) => {
      await transaction.run("UPDATE file_locks SET status = 'expired'");
    }), /read-only transaction/);
    assert.equal(transactionOpen, false);
    let discarded: Error | undefined;
    await assert.rejects(repository.withFileCollaborationReadSnapshot(async () => { throw new Error('Read failed'); }, async () => ({
      get: async () => undefined, all: async () => [],
      run: async (sql) => { if (sql === 'ROLLBACK') throw new Error('Rollback failed'); },
      close: (error) => { discarded = error; },
    })), /Read failed/);
    assert(discarded instanceof Error, 'a failed read rollback cannot return an unresolved transaction to the pool');
    assert(queries.filter((query) => query.startsWith('BEGIN')).length >= 5);
    console.log('Read-only collaboration metadata: consistent DB snapshot, no mutation fence, scope/lineage, expired leases, aliases, no root creation and read-only SQL enforcement passed.');
  } finally {
    repository.setFileCollaborationConnectionFactoryForTests(null);
    await postgres.close(); await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });

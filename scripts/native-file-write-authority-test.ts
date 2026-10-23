import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import ts from 'typescript';
import * as Y from 'yjs';
import type { SqlConnection } from '../app/lib/db';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import * as repository from '../app/lib/files/collaboration-repository';
import type * as Policy from '../app/lib/files/collaboration-policy';
import { assertNoInitializedNativeFileWrite, NativeWholeFileWriteBlockedError } from '../app/lib/files/native-file-write-authority';
import { WorkspaceDocumentCatalogueError } from '../app/lib/collaboration/workspace-document-catalogue';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-native-write-authority-'));
  const postgres = new PGlite();
  const workspace: WorkspaceContext = { workspaceId: 'native-write', workspaceType: 'personal', rootPath: root,
    organizationId: null, ownerUserId: 'owner', legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true,
      canManageWorkspace: true, canRunAgent: true } };
  const connection: SqlConnection = {
    get: async (sql, args = []) => (await postgres.query(sql, args)).rows[0],
    all: async (sql, args = []) => (await postgres.query(sql, args)).rows,
    run: async (sql, args = []) => ({ changes: (await postgres.query(sql, args)).affectedRows }),
    close: () => undefined,
  };
  let capable = true;
  const compiledPath = path.resolve('app/lib/files/collaboration-policy.ts');
  const require = createRequire(compiledPath);
  const policy = {} as typeof Policy;
  try {
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    repository.setFileCollaborationConnectionFactoryForTests(async () => connection);
    const compiled = ts.transpileModule(await fs.readFile(compiledPath, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    });
    new Function('require', 'module', 'exports', compiled.outputText)((name: string) => {
      if (name === '@/app/lib/files/collaboration-repository') return repository;
      if (name === '@/app/lib/collaboration/capabilities') return { workspaceSupportsRealtimeTextCollaboration: () => capable };
      return require(name);
    }, { exports: policy }, policy);

    await fs.writeFile(path.join(root, 'note.md'), 'projection must survive blocked replacement');
    const pristine = await policy.getFileCollaborationState({ workspace, path: 'note.md', ensureDocument: true });
    const documentId = pristine.document!.id;
    assert.equal((await assertNoInitializedNativeFileWrite(connection, workspace, 'note.md'))?.authority, 'pristine');
    capable = false;
    const disabledPristine = await policy.readFileCollaborationState({ workspace, path: 'note.md' });
    assert.equal(disabledPristine.crdtCapable, false);
    assert.equal(disabledPristine.document?.id, documentId, 'a capability toggle cannot hide the durable document identity');
    await policy.assertFileCollaborationWriteAllowed({ workspace, path: 'note.md', actorUserId: 'owner' });

    const doc = new Y.Doc(); doc.getText('content').insert(0, 'authoritative native text');
    const update = Buffer.from(Y.encodeStateAsUpdate(doc)), vector = Buffer.from(Y.encodeStateVector(doc));
    doc.destroy();
    await postgres.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,
      lifecycle_generation,schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,
      newline_style,has_bom,degraded,status) VALUES($1,$2,NULL,'note.md','plain_text',1,1,$3,$4,0,1,0,'lf',0,0,'active')`,
    [documentId, workspace.workspaceId, update, vector]);
    assert.equal((await postgres.query<{ yjs_state_lifecycle: string }>(
      'SELECT yjs_state_lifecycle FROM collaboration_documents WHERE id=$1', [documentId])).rows[0].yjs_state_lifecycle, 'initialized');
    for (const actorType of ['user', 'agent', 'automation', 'system'] as const) {
      await assert.rejects(policy.assertFileCollaborationWriteAllowed({ workspace, path: 'note.md', actorUserId: 'owner', actorType }),
        (error) => error instanceof policy.FileCollaborationPolicyError && error.code === 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED');
    }
    assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), 'projection must survive blocked replacement');
    assert.deepEqual(Buffer.from((await postgres.query<{ yjs_state: Uint8Array }>(
      'SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1', [documentId])).rows[0].yjs_state), update);
    await fs.unlink(path.join(root, 'note.md'));
    await assert.rejects(policy.assertFileCollaborationWriteAllowed({ workspace, path: 'note.md', actorUserId: 'owner' }),
      { code: 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED' }, 'missing projection bytes do not permit raw create/overwrite');
    await assert.rejects(fs.stat(path.join(root, 'note.md')), { code: 'ENOENT' });

    // The durable lifecycle marker remembers even sequence-zero states after loss.
    await postgres.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1', [documentId]);
    await assert.rejects(assertNoInitializedNativeFileWrite(connection, workspace, 'note.md'),
      (error) => error instanceof NativeWholeFileWriteBlockedError && error.authority === 'missing-state');
    await assert.rejects(policy.assertFileCollaborationWriteAllowed({ workspace, path: 'note.md', actorUserId: 'owner' }),
      { code: 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED' });

    await postgres.query("UPDATE collaboration_documents SET yjs_state_lifecycle='legacy_unknown' WHERE id=$1", [documentId]);
    await assert.rejects(assertNoInitializedNativeFileWrite(connection, workspace, 'note.md'),
      (error) => error instanceof NativeWholeFileWriteBlockedError && error.authority === 'missing-state');
    await postgres.query("UPDATE collaboration_documents SET yjs_state_lifecycle='never_initialized' WHERE id=$1", [documentId]);
    await postgres.query(`INSERT INTO collaboration_yjs_state_backups(backup_id,document_id,lifecycle_generation,schema_version,
      representation,yjs_state,state_vector,document_sequence,reason,created_at,expires_at)
      VALUES('historical',$1,1,1,'plain_text',$2,$3,0,'compaction',1,2)`, [documentId, update, vector]);
    await assert.rejects(assertNoInitializedNativeFileWrite(connection, workspace, 'note.md'),
      (error) => error instanceof NativeWholeFileWriteBlockedError && error.authority === 'missing-state');
    await postgres.query('DELETE FROM collaboration_yjs_state_backups WHERE document_id=$1', [documentId]);

    await postgres.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,
      lifecycle_generation,schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,
      newline_style,has_bom,degraded,status) VALUES($1,$2,NULL,'note.md','plain_text',1,1,$3,$4,0,1,0,'lf',0,0,'active')`,
    [documentId, workspace.workspaceId, update, vector]);
    await postgres.query("UPDATE collaboration_documents SET path='renamed.json' WHERE id=$1", [documentId]);
    await postgres.query("UPDATE collaboration_yjs_states SET path='renamed.json' WHERE document_id=$1", [documentId]);
    await postgres.query("UPDATE file_collaboration_lineages SET path='renamed.json' WHERE id=$1", [pristine.lineageId]);
    const renamed = await policy.readFileCollaborationState({ workspace, path: 'renamed.json' });
    assert.equal(renamed.strategy, 'revision_check'); assert.equal(renamed.crdtCapable, false);
    assert.equal(renamed.document?.id, documentId, 'a suffix change cannot turn an existing Yjs document into a raw file');
    await assert.rejects(policy.assertFileCollaborationWriteAllowed({ workspace, path: 'renamed.json', actorUserId: 'owner' }),
      { code: 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED' });

    await postgres.query("UPDATE collaboration_yjs_states SET status='archived' WHERE document_id=$1", [documentId]);
    await assert.rejects(assertNoInitializedNativeFileWrite(connection, workspace, 'renamed.json'),
      (error) => error instanceof WorkspaceDocumentCatalogueError && error.code === 'identity-conflict');
    await postgres.query("UPDATE collaboration_yjs_states SET status='active',organization_id='foreign' WHERE document_id=$1", [documentId]);
    await assert.rejects(policy.assertFileCollaborationWriteAllowed({ workspace, path: 'renamed.json', actorUserId: 'owner' }),
      (error) => error instanceof WorkspaceDocumentCatalogueError && error.code === 'orphan-state');
    await postgres.query('UPDATE collaboration_yjs_states SET organization_id=NULL WHERE document_id=$1', [documentId]);
    await postgres.query("UPDATE collaboration_documents SET status='archived' WHERE id=$1", [documentId]);
    await assert.rejects(assertNoInitializedNativeFileWrite(connection, workspace, 'renamed.json'),
      (error) => error instanceof WorkspaceDocumentCatalogueError && error.code === 'orphan-state');
    await postgres.query("UPDATE collaboration_yjs_states SET status='archived' WHERE document_id=$1", [documentId]);
    assert.equal(await assertNoInitializedNativeFileWrite(connection, workspace, 'renamed.json'), null,
      'archived identities do not prohibit creating a genuinely new file after a completed lifecycle transition');

    capable = true;
    const replacement = await policy.getFileCollaborationState({ workspace, path: 'renamed.md', ensureDocument: true });
    assert.notEqual(replacement.document!.id, documentId);
    assert.equal((await assertNoInitializedNativeFileWrite(connection, workspace, 'renamed.md'))?.authority, 'pristine');
    await assert.rejects(policy.assertFileCollaborationWriteAllowed({ workspace, path: 'renamed.md', actorUserId: 'owner' }),
      { code: 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED' }, 'the existing licensed pristine admission remains guarded');
    capable = false;
    await assert.rejects(assertNoInitializedNativeFileWrite(connection, workspace, '../renamed'),
      /canonical/u, 'invalid scope cannot bypass catalogue inspection');
    const child = await policy.getFileCollaborationState({ workspace, path: 'folder/child.md', ensureDocument: false });
    assert.equal(child.document, null);
    capable = true;
    await policy.getFileCollaborationState({ workspace, path: 'folder/child.md', ensureDocument: true });
    await assert.rejects(assertNoInitializedNativeFileWrite(connection, workspace, 'folder'),
      { code: 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED' }, 'registry-only descendants cannot be replaced by a file');
    assert.equal(await assertNoInitializedNativeFileWrite(connection, workspace, 'folder-other'), null,
      'namespace scope is an exact path or descendant, never a prefix match');
    await assert.rejects(assertNoInitializedNativeFileWrite(connection,
      { ...workspace, permissions: { ...workspace.permissions, canWrite: false } }, 'renamed.md'), { status: 403 });
    await assert.rejects(assertNoInitializedNativeFileWrite({ ...connection,
      get: async () => { throw new Error('Registry read failed'); } }, workspace, 'renamed.md'), /Registry read failed/u);
    await postgres.exec('ALTER TABLE collaboration_documents DROP COLUMN yjs_state_lifecycle CASCADE');
    await assert.rejects(assertNoInitializedNativeFileWrite(connection, workspace, 'renamed.md'),
      { code: '42703' }, 'missing initialization evidence/schema blocks instead of assuming pristine');
    repository.setFileCollaborationConnectionFactoryForTests(async () => { throw new Error('Database unavailable'); });
    await assert.rejects(policy.assertFileCollaborationWriteAllowed({ workspace, path: 'new.md', actorUserId: 'owner' }), /Database unavailable/u);
    console.log('Native writer admission: capability and suffix bypasses, sequence-zero loss, legacy/history, scoped identity, pristine lifecycle, actor parity and fail-closed DB failures passed.');
  } finally {
    repository.setFileCollaborationConnectionFactoryForTests(null);
    await postgres.close(); await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });

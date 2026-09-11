import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import * as Y from 'yjs';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { resolveWorkspaceDataRoot } from '../app/lib/workspaces/context';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type * as Repository from '../app/lib/collaboration/projection-repository';

async function main() {
  const database = await createPiTestDatabase();
  const connection = await database.openDb();
  const filename = path.resolve('app/lib/collaboration/projection-repository.ts');
  const load = createRequire(filename);
  const source = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const reloadRepository = () => {
    const exports = {};
    new Function('require', 'module', 'exports', source)((name: string) => name === '@/app/lib/db' ? database : load(name),
      { exports }, exports);
    return exports as typeof Repository;
  };
  let repository = reloadRepository();
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'ABC');
  doc.getText('content').delete(0, 1);
  const state: PersistedCollaborationState = {
    documentId: 'doc', workspaceId: 'workspace', organizationId: 'organization', path: 'note.md', representation: 'plain_text',
    lifecycleGeneration: 1, schemaVersion: 1, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
    documentSequence: 2, checkpointSequence: 1, persistedAt: Date.now(), checkpointedAt: Date.now(),
    canonicalHash: 'canonical', serializedHash: 'serialized', newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active',
  };
  const pending = () => repository.listPendingCollaborationProjections();
  try {
    assert.equal(await repository.loadCollaborationProjectionWorkspace(state), null,
      'a missing workspace cannot produce an internal projection context');
    await connection.run(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
      VALUES ('projection-owner','Projection owner','projection-owner@example.test',0,1,1)`);
    await connection.run(`INSERT INTO canvas_organization_settings (organization_id,owner_user_id,created_at,updated_at)
      VALUES ('organization','projection-owner',1,1)`);
    const rootRelativePath = 'workspaces/team/organization/projection-tests/files';
    await connection.run(`INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at)
      VALUES ($1,$2,'team',$3,'Projection tests','active',1,1)`, [state.workspaceId, state.organizationId, rootRelativePath]);
    const workspace = await repository.loadCollaborationProjectionWorkspace(state);
    assert.ok(workspace);
    assert.deepEqual(workspace, {
      workspaceId: state.workspaceId, workspaceType: 'team', organizationId: state.organizationId,
      rootRelativePath, rootPath: path.join(resolveWorkspaceDataRoot(), rootRelativePath), status: 'active', legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: false,
        canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false },
    }, 'the active persisted workspace supplies its real root/type and only internal projection permissions');
    assert.equal(workspace.actor, undefined, 'projection does not impersonate the workspace owner or an editor');
    assert.equal(await repository.loadCollaborationProjectionWorkspace({ ...state, organizationId: 'another-organization' }), null,
      'a workspace ID alone cannot cross the persisted organization boundary');
    assert.equal(await repository.loadCollaborationProjectionWorkspace({ ...state, organizationId: null }), null,
      'a legacy/null organization in a Yjs state cannot project into an organization-owned workspace');
    // The real workspace schema forbids null organizations, so exercise that
    // boundary without weakening the schema to manufacture an impossible row.
    await assert.rejects(connection.run(`INSERT INTO canvas_workspaces
      (id,organization_id,type,root_relative_path,display_name,created_at,updated_at)
      VALUES ('null-organization',NULL,'personal','workspaces/null/files','Invalid workspace',1,1)`), { code: '23502' });
    for (const status of ['disabled', 'archived', 'recovery_locked']) {
      await connection.run('UPDATE canvas_workspaces SET status=$1 WHERE id=$2', [status, state.workspaceId]);
      assert.equal(await repository.loadCollaborationProjectionWorkspace(state), null,
        `${status} workspaces cannot receive a background projection`);
    }
    await connection.run("UPDATE canvas_workspaces SET status='active' WHERE id=$1", [state.workspaceId]);
    for (const invalidRoot of ['/outside-workspace', '../outside-workspace', 'workspaces/../outside-workspace',
      'workspaces\\..\\outside-workspace', 'workspaces/./files']) {
      await connection.run('UPDATE canvas_workspaces SET root_relative_path=$1 WHERE id=$2', [invalidRoot, state.workspaceId]);
      await assert.rejects(repository.loadCollaborationProjectionWorkspace(state), /Invalid workspace root path/u,
        'a malformed persisted root must fail closed before any filesystem output');
    }
    await connection.run('UPDATE canvas_workspaces SET root_relative_path=$1 WHERE id=$2', [rootRelativePath, state.workspaceId]);
    assert.deepEqual(await repository.loadCollaborationProjectionWorkspace(state), workspace,
      'valid workspace loading recovers after rejected status/root rows');

    await connection.run(`INSERT INTO collaboration_yjs_states (document_id, workspace_id, organization_id, path,
      representation, lifecycle_generation, schema_version, yjs_state, state_vector, document_sequence, checkpoint_sequence,
      persisted_at, checkpointed_at, canonical_hash, serialized_hash)
      VALUES ($1,$2,$3,$4,$5,1,1,$6,$7,2,1,$8,$8,$9,$10)`, [state.documentId, state.workspaceId, state.organizationId,
      state.path, state.representation, Buffer.from(state.yjsState), Buffer.from(state.stateVector), Date.now(), state.canonicalHash, state.serializedHash]);
    await connection.run(`INSERT INTO collaboration_documents (id,workspace_id,workspace_type,path,provider,state_version,status,created_at,updated_at)
      VALUES ('doc','workspace','personal','note.md','yjs',1,'active',1,1)`);
    assert.deepEqual(await pending(), [{ documentId: 'doc', lifecycleGeneration: 1, documentSequence: 2 }],
      'the binary commit alone creates durable backlog, without an in-memory job');
    repository = reloadRepository();
    assert.equal((await pending()).length, 1, 'a fresh repository recovers the pending binary state');
    const recovered = new Y.Doc();
    try {
      const row = await connection.get('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1', ['doc']) as { yjs_state: Uint8Array };
      Y.applyUpdate(recovered, row.yjs_state);
      assert.equal(recovered.getText('content').toString(), 'BC', 'unprojected deletion remains durably recoverable');
    } finally { recovered.destroy(); }
    assert.deepEqual(await repository.listPendingCollaborationProjections('doc'), [], 'recovery pages have a stable cursor');

    state.checkpointSequence = 2;
    await connection.run('BEGIN');
    await connection.run('UPDATE collaboration_yjs_states SET checkpoint_sequence=2 WHERE document_id=$1', ['doc']);
    await repository.recordCollaborationProjectionPending(connection, state, { revisionId: 'revision-2' });
    await connection.run('COMMIT');
    await connection.run('UPDATE collaboration_documents SET state_version=2 WHERE id=$1', ['doc']);
    repository = reloadRepository();
    assert.equal(await repository.hasPendingCollaborationProjection(state), true,
      'a crash after file/document metadata but before share finalization retains its receipt');
    await assert.rejects(repository.finalizeCollaborationProjectionReceipt(state, 'wrong-revision'), /receipt changed/u);
    assert.equal((await pending()).length, 1);
    await repository.finalizeCollaborationProjectionReceipt(state, 'revision-2');
    assert.deepEqual(await pending(), []);
    await repository.finalizeCollaborationProjectionReceipt(state, 'revision-2');
    assert.deepEqual(await pending(), [], 'finalizing the same receipt is idempotent');

    await repository.beginCollaborationProjectionAttempt(state);
    repository = reloadRepository();
    assert.equal((await pending()).length, 1, 'repeating the same N/hash is marked before replacing the file');
    await assert.rejects(repository.finalizeCollaborationProjectionReceipt(state, 'revision-2'), /receipt changed/u,
      'an older checkpoint hash does not prove that the new receipt committed');
    await repository.recordCollaborationProjectionPending(connection, state, { revisionId: 'revision-2' });
    await repository.finalizeCollaborationProjectionReceipt(state, 'revision-2');

    await connection.run('BEGIN');
    await repository.recordCollaborationProjectionPending(connection, state, { revisionId: 'rolled-back' });
    await connection.run('ROLLBACK');
    assert.deepEqual(await pending(), [], 'the receipt participates in checkpoint rollback');
    await assert.rejects(repository.recordCollaborationProjectionPending(connection, { ...state, checkpointSequence: 1 },
      { revisionId: 'older' }), /newer collaboration projection/u);

    await connection.run('UPDATE collaboration_documents SET state_version=1 WHERE id=$1', ['doc']);
    assert.equal((await pending()).length, 1, 'legacy metadata gaps remain discoverable');
    await connection.run('UPDATE collaboration_documents SET state_version=2 WHERE id=$1', ['doc']);
    await repository.recordCollaborationProjectionPending(connection, state, { revisionId: 'before-delete' });
    await connection.run("UPDATE collaboration_yjs_states SET status='archived', lifecycle_generation=2 WHERE document_id=$1", ['doc']);
    assert.deepEqual(await pending(), [], 'archived documents are never replayed');
    await assert.rejects(repository.finalizeCollaborationProjectionReceipt(state, 'before-delete'), /receipt changed/u);
    await connection.run("UPDATE collaboration_yjs_states SET status='active', lifecycle_generation=3 WHERE document_id=$1", ['doc']);
    assert.deepEqual(await pending(), [{ documentId: 'doc', lifecycleGeneration: 3, documentSequence: 2 }],
      'legacy/migration checkpoints get their own current-generation recovery task');
    assert.equal(await repository.hasPendingCollaborationProjection(state), false);
    await assert.rejects(repository.beginCollaborationProjectionAttempt(state), /stale document identity/u);

    const newGeneration = { ...state, lifecycleGeneration: 3 };
    await repository.recordCollaborationProjectionPending(connection, newGeneration, { revisionId: 'new-generation' });
    assert.equal((await pending())[0].lifecycleGeneration, 3);
    await assert.rejects(repository.recordCollaborationProjectionPending(connection, state, { revisionId: 'old-generation' }), /newer collaboration projection/u);
    await repository.finalizeCollaborationProjectionReceipt(newGeneration, 'new-generation');
    assert.deepEqual(await pending(), []);

    await repository.beginCollaborationProjectionAttempt(newGeneration);
    await connection.run('UPDATE collaboration_yjs_states SET lifecycle_generation=4,document_sequence=0,checkpoint_sequence=0 WHERE document_id=$1', ['doc']);
    assert.deepEqual(await pending(), [{ documentId: 'doc', lifecycleGeneration: 4, documentSequence: 0 }],
      'a hypothetical new generation with reset counters cannot hide an unfinished prior-generation receipt');
    const resetGeneration = { ...newGeneration, lifecycleGeneration: 4, documentSequence: 0, checkpointSequence: 0 };
    await repository.beginCollaborationProjectionAttempt(resetGeneration);
    await repository.recordCollaborationProjectionPending(connection, resetGeneration, { revisionId: 'reset-generation' });
    await repository.finalizeCollaborationProjectionReceipt(resetGeneration, 'reset-generation');
    assert.deepEqual(await pending(), []);
    console.log('Projection backlog survives repository restart; real SQL verifies receipts, atomic rollback, monotonic sequences, generation/deletion fences and workspace organization/status/root boundaries.');
  } finally { doc.destroy(); await database.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

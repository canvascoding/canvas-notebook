import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import * as Y from 'yjs';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type * as Persistence from '../app/lib/collaboration/persistence';
import type * as Repository from '../app/lib/collaboration/projection-repository';
import { classifyCollaborationProjectionError, inCollaborationProjectionPhase } from '../app/lib/collaboration/projection-errors';
import { CollaborationCheckpointValidationError, COLLABORATION_CHECKPOINT_ERROR_CODES as CODES } from '../app/lib/collaboration/checkpoint-errors';
import { COLLABORATION_FAILURE_CODES, isCollaborationStateQuarantined } from '../app/lib/collaboration/failure';

async function main() {
  const database = await createPiTestDatabase(); const connection = await database.openDb();
  const compile = async <T>(relative: string): Promise<T> => {
    const filename = path.resolve(relative); const require = createRequire(filename);
    const source = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText;
    const exports = {};
    new Function('require', 'module', 'exports', source)((name: string) => name === '@/app/lib/db' ? database : require(name), { exports }, exports);
    return exports as T;
  };
  const persistence = await compile<typeof Persistence>('app/lib/collaboration/persistence.ts');
  let repository = await compile<typeof Repository>('app/lib/collaboration/projection-repository.ts');
  const doc = new Y.Doc(); doc.getText('content').insert(0, 'Original');
  try {
    await connection.run(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
      VALUES ('owner','Owner','quarantine@example.test',0,1,1)`);
    await connection.run(`INSERT INTO canvas_organization_settings (organization_id,owner_user_id,created_at,updated_at)
      VALUES ('org','owner',1,1)`);
    await connection.run(`INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at)
      VALUES ('ws','org','team','workspaces/quarantine/files','Quarantine','active',1,1)`);
    await connection.run(`INSERT INTO collaboration_documents (id,workspace_id,organization_id,workspace_type,path,provider,status,created_at,updated_at)
      VALUES ('doc','ws','org','team','note.txt','yjs','active',1,1)`);
    await connection.run(`INSERT INTO collaboration_yjs_states (document_id,workspace_id,organization_id,path,representation,yjs_state,state_vector,
      document_sequence,checkpoint_sequence,persisted_at) VALUES ('doc','ws','org','note.txt','plain_text',$1,$2,1,0,1)`,
    [Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc)]);
    const load = async () => { const state = await persistence.loadCollaborationState('doc'); assert(state); return state; };
    const initial = await load();
    await repository.recordCollaborationProjectionFailure(initial, { code: CODES.failed, phase: 'projection_finalize', causeCode: 'ENOSPC', permanent: false });
    repository = await compile<typeof Repository>('app/lib/collaboration/projection-repository.ts');
    assert.equal((await load()).projectionError?.code, CODES.failed);
    assert.equal((await repository.loadCollaborationProjectionStatus(await load())).projectionFinalized, true,
      'a zero checkpoint requires no derived receipt, while its diagnostic still persists');
    assert.equal((await repository.listPendingCollaborationProjections()).length, 1);
    const schema = classifyCollaborationProjectionError(new CollaborationCheckpointValidationError('schema_invalid'));
    await repository.recordCollaborationProjectionFailure(initial, schema);
    const quarantined = await load();
    assert.equal(quarantined.degraded, true); assert.equal(quarantined.projectionError?.permanent, true);
    assert.deepEqual(await repository.listPendingCollaborationProjections(), []);
    assert.equal(await repository.hasPendingCollaborationProjection(quarantined), false);
    assert.equal((await repository.readCollaborationProjectionHealth(connection)).quarantined, 1);
    doc.getText('content').insert(doc.getText('content').length, ' offline change');
    const merged = await persistence.persistCollaborationYDoc('doc', 1, doc);
    assert.equal(merged.degraded, true, 'binary persistence cannot clear permanent structure quarantine');
    assert.equal(merged.projectionError?.permanent, true);
    await repository.recordCollaborationProjectionFailure(merged, { code: CODES.failed, phase: 'file_write', causeCode: 'EIO', permanent: false });
    assert.equal((await load()).projectionError?.code, CODES.schemaInvalid, 'transient errors cannot replace a permanent reason');
    await connection.run('UPDATE collaboration_yjs_states SET lifecycle_generation=2,degraded=0 WHERE document_id=$1', ['doc']);
    const newLifecycle = await load(); assert.equal(newLifecycle.projectionError, undefined);
    await repository.recordCollaborationProjectionFailure(quarantined, schema);
    assert.equal((await load()).degraded, false, 'old generation failure cannot quarantine its replacement');
    assert.equal((await repository.listPendingCollaborationProjections()).length, 1);
    await repository.recordCollaborationProjectionFailure(newLifecycle,
      { code: CODES.failed, phase: 'projection_finalize', causeCode: 'ENOSPC', permanent: false });
    const checkpoint = { ...await load(), checkpointSequence: newLifecycle.documentSequence, canonicalHash: 'canonical', serializedHash: 'serialized' };
    await connection.run('UPDATE collaboration_yjs_states SET checkpoint_sequence=$1,canonical_hash=$2,serialized_hash=$3 WHERE document_id=$4',
      [checkpoint.checkpointSequence, checkpoint.canonicalHash, checkpoint.serializedHash, checkpoint.documentId]);
    await repository.recordCollaborationProjectionPending(connection, checkpoint, { revisionId: 'revision' });
    assert.equal((await repository.loadCollaborationProjectionStatus(await load())).projectionFinalized, false);
    assert.equal((await load()).projectionError?.code, CODES.failed);
    await repository.finalizeCollaborationProjectionReceipt(checkpoint, 'revision');
    assert.equal((await load()).projectionError, undefined);
    assert.equal((await repository.loadCollaborationProjectionStatus(await load())).projectionFinalized, true);

    await persistence.markCollaborationDegraded('doc', 2);
    doc.getText('content').insert(doc.getText('content').length, ' legacy pending');
    assert.equal((await persistence.persistCollaborationYDoc('doc', 2, doc)).degraded, true,
      'a changed binary save never clears unclassified historical quarantine');
    await persistence.markCollaborationDegraded('doc', 2, COLLABORATION_FAILURE_CODES.persistenceFailed);
    assert.equal((await load()).projectionError, undefined, 'storage retry cannot relabel legacy quarantine');
    await connection.run('UPDATE collaboration_yjs_states SET lifecycle_generation=3,degraded=0 WHERE document_id=$1', ['doc']);
    await persistence.markCollaborationDegraded('doc', 3, COLLABORATION_FAILURE_CODES.persistenceFailed);
    const storagePending = await load(); assert.equal(storagePending.degraded, true);
    assert.equal(isCollaborationStateQuarantined(storagePending), false, 'binary retry retains transport write permission');
    assert.equal((await repository.readCollaborationProjectionHealth(connection)).quarantined, 0);
    assert.equal((await repository.readCollaborationProjectionHealth(connection)).binaryPersistenceFailures, 1);
    await repository.recordCollaborationProjectionFailure(storagePending,
      { code: CODES.failed, phase: 'checkpoint_confirm', causeCode: 'unknown', permanent: false });
    assert.equal((await load()).projectionError?.code, COLLABORATION_FAILURE_CODES.persistenceFailed,
      'blocked projection cannot erase the binary recovery reason');
    const storageRecovered = await persistence.persistCollaborationYDoc('doc', 3, doc);
    assert.equal(storageRecovered.persistenceDisposition, 'unchanged');
    assert.equal(storageRecovered.degraded, false, 'a confirmed causal no-op can heal an explicit binary-storage failure');
    assert.equal(storageRecovered.projectionError, undefined);

    const privateError = Object.assign(new Error('private/path body token'), { code: 'ENOSPC' });
    await assert.rejects(inCollaborationProjectionPhase('projection_finalize', async () => { throw privateError; }), (error: unknown) => {
      const diagnostic = classifyCollaborationProjectionError(error);
      assert.deepEqual(diagnostic, { code: CODES.failed, phase: 'projection_finalize', causeCode: 'ENOSPC', permanent: false, blocksEditing: false });
      assert(!JSON.stringify(diagnostic).includes('private')); return true;
    });
    assert.equal(classifyCollaborationProjectionError({ code: 'TOKEN-PRIVATE' }).causeCode, 'unknown');
    console.log('SQL quarantine: restart, binary updates, lifecycle fencing, transient receipt finalization and safe native diagnostics passed.');
  } finally { doc.destroy(); await database.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

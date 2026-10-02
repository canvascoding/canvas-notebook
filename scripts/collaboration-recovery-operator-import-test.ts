import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import * as Y from 'yjs';
import { closeDatabaseConnections, openDb, type SqlConnection } from '../app/lib/db';
import { recoveryHash } from '../app/lib/collaboration/recovery-plan';
import { decodeRecoveryState } from '../app/lib/collaboration/recovery-evidence';
import { readCollaborationRecoveryBundle, prepareCollaborationRecoverySelection, collaborationRecoverySelectionHash,
  applyCollaborationRecoverySelection, type RecoveryExecutionProof } from '../app/lib/collaboration/recovery-operator';
import type { HistoricalCollaborationIdentityEvidence } from '../app/lib/collaboration/recovery-legacy-evidence';

const run = promisify(execFile);
async function main() {
  const database = new URL(process.env.DATABASE_URL!);
  assert(['127.0.0.1', 'localhost'].includes(database.hostname)); assert.equal(database.port, '55433');
  assert.match(database.pathname, /^\/canvas_editor_test_[a-f0-9]+$/u, 'a disposable local test database is required');
  assert(process.env.DATA && path.isAbsolute(process.env.DATA));
  const client = new Client({ connectionString: database.href }); await client.connect();
  const documents: Y.Doc[] = []; const scope = randomUUID();
  const rootRelativePath = `workspace/recovery-import-operator-${scope}`;
  const directory = path.join(process.env.DATA, rootRelativePath); await fs.mkdir(directory, { recursive: true });
  try {
    await client.query(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
      VALUES ($1,'Isolated import operator test',$2,0,1,1)`, [scope, `${scope}@example.test`]);
    await client.query(`INSERT INTO canvas_organization_settings (organization_id,owner_user_id,created_at,updated_at)
      VALUES ($1,$1,1,1)`, [scope]);
    await client.query(`INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at)
      VALUES ($1,$1,'team',$2,'Isolated import test','active',1,1)`, [scope, rootRelativePath]);
    const canonical = 'Original private checkpoint\n'; const serialized = '\uFEFFOriginal private checkpoint\r\n';
    const documentId = randomUUID(); const conflictId = randomUUID();
    const identities: HistoricalCollaborationIdentityEvidence[] = [];
    for (const [id, filename] of [[documentId, 'import.txt'], [conflictId, 'conflict.txt']]) {
      const doc = new Y.Doc(); doc.getText('content').insert(0, canonical); documents.push(doc);
      await client.query(`INSERT INTO collaboration_yjs_states (document_id,workspace_id,organization_id,path,representation,
        lifecycle_generation,schema_version,yjs_state,state_vector,document_sequence,checkpoint_sequence,persisted_at,checkpointed_at,
        canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES ($1,$2,$2,$3,'plain_text',3,1,$4,$5,7,7,1,2,$6,$7,'crlf',1,0,'active')`,
      [id, scope, filename, Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc), recoveryHash(canonical), recoveryHash(serialized)]);
      await fs.writeFile(path.join(directory, filename), serialized);
      const lineageId = randomUUID(); const revisionId = randomUUID();
      const recordScope = { workspaceId: scope, organizationId: scope, customerId: null, projectId: null,
        workspaceType: 'team' as const, path: filename, createdAt: 1 };
      identities.push({ document: { ...recordScope, id, lineageId, provider: 'yjs', stateVersion: 7,
        snapshotRevisionId: revisionId, status: 'active', updatedAt: 2 },
      revision: { ...recordScope, id: revisionId, lineageId, revisionNumber: 4, contentHash: recoveryHash(serialized),
        sizeBytes: Buffer.byteLength(serialized), createdByUserId: scope, createdByActorType: 'user',
        sourceSessionId: null, baseRevisionId: null, historyOnly: false },
      lineage: { ...recordScope, id: lineageId, status: 'active', archivedAt: null, trashEntryId: null } });
    }
    const snapshot = async () => {
      const tables = ['collaboration_documents', 'file_collaboration_lineages', 'file_revisions', 'collaboration_yjs_states',
        'collaboration_file_projections', 'public_file_shares'];
      const snapshots = [];
      for (const table of tables) snapshots.push({ table, rows: (await client.query(`SELECT * FROM ${table} ORDER BY 1`)).rows });
      return snapshots;
    };
    const capture = async (name: string) => {
      const output = path.join(process.env.DATA!, `import-operator-bundle-${name}`); const before = await snapshot();
      const captured = await run(process.execPath, ['--import', 'tsx', '--conditions', 'react-server',
        path.resolve('scripts/collaboration-recovery-dry-run.ts'), '--output', output],
      { env: { ...process.env, CANVAS_ENV_FILE: '' }, timeout: 60_000 });
      assert(!captured.stdout.includes('private checkpoint'));
      assert.deepEqual(await snapshot(), before, 'capture must not migrate or mutate PostgreSQL');
      // Explicit test artifact: the real native SQLite reader has its own source
      // hash/chmod tests. This test covers PostgreSQL import through projection.
      const artifact = JSON.stringify(identities, null, 2) + '\n';
      await fs.writeFile(path.join(output, 'legacy-identities.json'), artifact, { mode: 0o600, flag: 'wx' });
      const manifestPath = path.join(output, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      manifest.artifacts['legacy-identities.json'] = recoveryHash(artifact);
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
      return await readCollaborationRecoveryBundle(output);
    };
    const beforeCapture = await snapshot(); const originalFile = await fs.readFile(path.join(directory, 'import.txt'));
    const bundle = await capture('initial'); const unselected = prepareCollaborationRecoverySelection(bundle);
    assert.deepEqual(await snapshot(), beforeCapture, 'read-only preparation imports no metadata');
    assert.deepEqual(await fs.readFile(path.join(directory, 'import.txt')), originalFile);
    assert.equal(unselected.operations.length, 2);
    assert(unselected.operations.every(operation => operation.kind === 'import_historical_identity' && !operation.selected));
    assert.equal(unselected.manual.length, 0);
    const selection = structuredClone(unselected);
    selection.operations.forEach(operation => { operation.selected = operation.documentId === documentId; });
    const operation = selection.operations.find(operation => operation.documentId === documentId)!;
    const expected = decodeRecoveryState(operation.expectedState); const historical = identities.find(record => record.document.id === documentId)!;
    assert.equal(operation.historicalIdentity!.document.id, documentId);
    assert.equal(operation.historicalIdentity!.lineage!.id, historical.lineage!.id);
    const backupReport = path.join(process.env.DATA!, 'import-test-backup-report.json');
    const restoreReport = path.join(process.env.DATA!, 'import-test-restore-report.json');
    const drainReport = path.join(process.env.DATA!, 'import-test-drain-report.json');
    const time = new Date(Date.now() - 1000).toISOString();
    const backupId = randomUUID(); const archive = path.join(process.env.DATA!, 'import-test-synthetic-archive.bin');
    const archiveBytes = 'ISOLATED TEST FIXTURE ONLY. This is not a production backup or restore.\n';
    await fs.writeFile(archive, archiveBytes, { mode: 0o600, flag: 'wx' }); const archiveHash = recoveryHash(archiveBytes);
    const checks = ['postgres', 'workspace_files', 'yjs_bytes', 'registry', 'revisions', 'shares'] as const;
    const backupReportBytes = JSON.stringify({ version: 1, backupId, completed: true, archiveHash,
      bundleManifestHash: bundle.manifestHash, isolatedSyntheticTestFixture: true }) + '\n';
    const restoreReportBytes = JSON.stringify({ version: 1, backupId, result: 'passed', archiveHash,
      checks: checks.map(kind => ({ kind, sourceHash: recoveryHash('isolated fixture:' + kind), restoredHash: recoveryHash('isolated fixture:' + kind) })),
      isolatedSyntheticTestFixture: true }) + '\n';
    const drainReportBytes = JSON.stringify({ version: 1, bundleManifestHash: bundle.manifestHash,
      notebookWritersStopped: true, postgresExternalWriterCount: 0, isolatedSyntheticTestFixture: true }) + '\n';
    for (const [filename, report] of [[backupReport, backupReportBytes], [restoreReport, restoreReportBytes], [drainReport, drainReportBytes]])
      await fs.writeFile(filename, report, { mode: 0o600 });
    const proof: RecoveryExecutionProof = { version: 1, bundleManifestHash: bundle.manifestHash, backupId,
      backup: { archive, archiveHash, completedAt: time, report: backupReport, reportHash: recoveryHash(backupReportBytes) },
      restore: { backupId, result: 'passed', verifiedAt: time, report: restoreReport, reportHash: recoveryHash(restoreReportBytes), checks: [...checks] },
      writerDrain: { verifiedAt: time, report: drainReport, reportHash: recoveryHash(drainReportBytes) } };
    const journalDirectory = path.join(process.env.DATA!, 'import-operator-journal');
    const execute = (selected = selection, openConnection = openDb, journal = journalDirectory) => applyCollaborationRecoverySelection({
      bundle, selection: selected, selectionHash: collaborationRecoverySelectionHash(selected), proof,
      journalDirectory: journal, openConnection });
    assert.deepEqual(await execute(unselected), [], 'preparation never grants implicit apply authority');
    assert.deepEqual(await snapshot(), beforeCapture);

    let failAfterProjection = true;
    const faultConnection = async (): Promise<SqlConnection> => {
      const connection = await openDb();
      return { ...connection, get: async (sql, values) => {
        // The dedicated guard is rechecked immediately after finalized projection.
        // This injects a crash before the completion journal, without replacing
        // the real import transaction or the production checkpoint pipeline.
        if (failAfterProjection && sql.includes('FROM pg_locks')) {
          const receipt = (await client.query('SELECT finalized FROM collaboration_file_projections WHERE document_id=$1', [documentId])).rows[0];
          if (receipt && Number(receipt.finalized) === 1) {
            failAfterProjection = false; throw new Error('Injected crash after import projection before completion journal');
          }
        }
        return connection.get(sql, values);
      } };
    };
    await assert.rejects(execute(selection, faultConnection), /Injected crash after import projection/u);
    assert.equal(failAfterProjection, false, 'fault reached the actual finalized import projection');
    await assert.rejects(fs.stat(path.join(journalDirectory, `${operation.id}.complete.json`)), { code: 'ENOENT' });
    const finalized = (await client.query('SELECT * FROM collaboration_file_projections WHERE document_id=$1', [documentId])).rows[0];
    assert.equal(Number(finalized.finalized), 1); assert.equal(Number(finalized.lifecycle_generation), 3);
    assert.equal(Number(finalized.projected_sequence), 7); assert.equal(finalized.canonical_hash, recoveryHash(canonical));
    assert.equal(finalized.serialized_hash, recoveryHash(serialized));
    const registry = (await client.query('SELECT * FROM collaboration_documents WHERE id=$1', [documentId])).rows[0];
    assert.equal(registry.id, documentId); assert.equal(registry.lineage_id, historical.lineage!.id);
    assert.equal(registry.yjs_state_lifecycle, 'initialized'); assert.equal(registry.status, 'active');
    assert.equal(Number(registry.created_at), historical.document.createdAt);
    assert.equal(Number(registry.state_version), 7); assert.equal(registry.snapshot_revision_id, finalized.revision_id);
    const importedRevision = (await client.query('SELECT * FROM file_revisions WHERE id=$1', [historical.revision.id])).rows[0];
    assert.equal(importedRevision.lineage_id, historical.lineage!.id);
    assert.equal(importedRevision.content_hash, historical.revision.contentHash);
    assert.equal(Number(importedRevision.revision_number), 4);
    const afterProjection = decodeRecoveryState((await client.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [documentId])).rows[0]);
    assert.deepEqual(Buffer.from(afterProjection.yjsState), Buffer.from(expected.yjsState), 'metadata recovery preserves original update bytes');
    assert.deepEqual(Buffer.from(afterProjection.stateVector), Buffer.from(expected.stateVector), 'metadata recovery preserves original vector');
    assert.equal(afterProjection.lifecycleGeneration, 3); assert.equal(afterProjection.documentSequence, 7);
    assert.equal(afterProjection.checkpointSequence, 7); assert.equal(afterProjection.hasBom, true); assert.equal(afterProjection.newlineStyle, 'crlf');
    assert.deepEqual(await fs.readFile(path.join(directory, 'import.txt')), originalFile);
    const resumed = await execute(); assert.equal(resumed.length, 1); assert.equal(resumed[0].disposition, 'already_applied');
    assert.equal(resumed[0].revisionId, finalized.revision_id);
    const complete = JSON.parse(await fs.readFile(path.join(journalDirectory, `${operation.id}.complete.json`), 'utf8'));
    assert.equal(complete.operationId, operation.id); assert.equal(complete.revisionId, finalized.revision_id);
    const beforeReplay = await snapshot(); const beforeReplayFile = await fs.stat(path.join(directory, 'import.txt'));
    const replay = await execute(); assert.equal(replay[0].disposition, 'already_applied');
    assert.deepEqual(await snapshot(), beforeReplay, 'a completed double-run changes no states, registry, lineage, revisions or receipts');
    const afterReplayFile = await fs.stat(path.join(directory, 'import.txt'));
    assert.equal(afterReplayFile.ino, beforeReplayFile.ino); assert.equal(afterReplayFile.mtimeMs, beforeReplayFile.mtimeMs);

    // A current successor created after review must win. Never rebind it to the
    // historical ID, even though the old file bytes still match the evidence.
    const successorId = randomUUID();
    await client.query(`INSERT INTO collaboration_documents (id,workspace_id,organization_id,workspace_type,path,provider,
      state_version,status,created_at,updated_at) VALUES ($1,$2,$2,'team','conflict.txt','yjs',0,'active',1,1)`, [successorId, scope]);
    const beforeConflict = await snapshot(); const conflictFile = await fs.readFile(path.join(directory, 'conflict.txt'));
    const conflictSelection = structuredClone(unselected);
    conflictSelection.operations.forEach(selected => { selected.selected = selected.documentId === conflictId; });
    await assert.rejects(execute(conflictSelection, openDb, path.join(process.env.DATA!, 'import-conflict-journal')), /existing_document_conflict/u);
    assert.deepEqual(await snapshot(), beforeConflict, 'a current conflict rejects historical import without touching either identity');
    assert.deepEqual(await fs.readFile(path.join(directory, 'conflict.txt')), conflictFile);
    assert.equal((await client.query('SELECT id FROM collaboration_documents WHERE id=$1', [conflictId])).rowCount, 0);
    const recaptured = prepareCollaborationRecoverySelection(await capture('current-conflict'));
    assert(!recaptured.operations.some(selected => selected.kind === 'import_historical_identity' && selected.documentId === conflictId));
    console.log('Historical import operator: real isolated PostgreSQL, canonical historical IDs/lineage, full checkpoint receipts, original binary/vector/BOM, crash resume, completed double-run and current-successor rejection passed. Proof reports were explicitly isolated test fixtures, not production evidence.');
  } finally { documents.forEach(doc => doc.destroy()); await client.end(); await closeDatabaseConnections(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

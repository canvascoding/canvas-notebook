import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import * as Y from 'yjs';
import { closeDatabaseConnections } from '../app/lib/db';
import { recoveryHash } from '../app/lib/collaboration/recovery-plan';
import { readCollaborationRecoveryBundle, prepareCollaborationRecoverySelection, collaborationRecoverySelectionHash,
  type RecoveryBundle, type RecoveryExecutionProof } from '../app/lib/collaboration/recovery-operator';

const run = promisify(execFile);
async function main() {
  const database = new URL(process.env.DATABASE_URL!);
  assert(['127.0.0.1', 'localhost'].includes(database.hostname)); assert.equal(database.port, '55433');
  assert.match(database.pathname, /^\/canvas_editor_test_[a-f0-9]+$/u, 'an isolated disposable native PostgreSQL database is required');
  assert(process.env.DATA && path.isAbsolute(process.env.DATA));
  const client = new Client({ connectionString: database.href }); await client.connect();
  const scope = randomUUID(); const currentId = randomUUID(); const orphanId = randomUUID();
  const lineageId = randomUUID(); const revisionId = randomUUID(); const shareId = randomUUID();
  const rootRelativePath = `workspace/initial-recovery-${scope}`;
  const directory = path.join(process.env.DATA, rootRelativePath); await fs.mkdir(directory, { recursive: true });
  const canonical = 'Verified initial snapshot\n'; const serialized = '\uFEFFVerified initial snapshot\r\n';
  const documents: Y.Doc[] = [];
  const cli = (script: string, args: string[]) => run(process.execPath,
    ['--import', 'tsx', '--conditions', 'react-server', path.resolve(script), ...args],
    { env: { ...process.env, CANVAS_ENV_FILE: '' }, timeout: 60_000 });
  try {
    await client.query(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
      VALUES ($1,'Initial recovery fixture',$2,0,1,1)`, [scope, `${scope}@example.test`]);
    await client.query(`INSERT INTO canvas_organization_settings (organization_id,owner_user_id,created_at,updated_at)
      VALUES ($1,$1,1,1)`, [scope]);
    await client.query(`INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at)
      VALUES ($1,$1,'team',$2,'Initial recovery fixture','active',1,1)`, [scope, rootRelativePath]);
    await client.query(`INSERT INTO file_collaboration_lineages
      (id,organization_id,workspace_id,workspace_type,path,status,created_at) VALUES ($1,$2,$2,'team','initial.txt','active',1)`, [lineageId, scope]);
    await client.query(`INSERT INTO file_revisions (id,lineage_id,workspace_id,organization_id,workspace_type,path,
      content_hash,size_bytes,revision_number,created_by_actor_type,created_at)
      VALUES ($1,$2,$3,$3,'team','initial.txt',$4,$5,1,'system',1)`, [revisionId, lineageId, scope, recoveryHash(serialized), Buffer.byteLength(serialized)]);
    await client.query(`INSERT INTO collaboration_documents (id,lineage_id,workspace_id,organization_id,workspace_type,path,
      provider,state_version,snapshot_revision_id,yjs_state_lifecycle,status,created_at,updated_at)
      VALUES ($1,$2,$3,$3,'team','initial.txt','yjs',0,$4,'initialized','active',1,1)`, [currentId, lineageId, scope, revisionId]);
    for (const [id, content, sequence] of [[currentId, canonical, 0], [orphanId, 'Historical orphan\n', 5]] as const) {
      const doc = new Y.Doc(); doc.getText('content').insert(0, content); documents.push(doc);
      await client.query(`INSERT INTO collaboration_yjs_states (document_id,workspace_id,organization_id,path,representation,
        lifecycle_generation,schema_version,yjs_state,state_vector,document_sequence,checkpoint_sequence,persisted_at,
        checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded)
        VALUES ($1,$2,$2,'initial.txt','plain_text',1,1,$3,$4,$5,$5,1,1,$6,$7,$8,$9,0)`,
      [id, scope, Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc), sequence, recoveryHash(content),
        recoveryHash(id === currentId ? serialized : content), id === currentId ? 'crlf' : 'lf', id === currentId ? 1 : 0]);
    }
    const filename = path.join(directory, 'initial.txt'); await fs.writeFile(filename, serialized);
    await client.query(`INSERT INTO public_file_shares (id,token,token_hash,token_preview,workspace_id,organization_id,workspace_type,
      workspace_root_relative_path,workspace_path,file_name,file_identity,last_known_revision,mime_type,size_bytes,status,
      created_by_user_id,created_at,updated_at) VALUES ($1,$1,$1,'fixture',$2,$2,'team',$3,'initial.txt','initial.txt',
      'before-identity','before-revision','text/plain',1,'active',$2,1,1)`, [shareId, scope, rootRelativePath]);
    const bundleDirectory = path.join(process.env.DATA, `initial-bundle-${scope}`);
    await cli('scripts/collaboration-recovery-dry-run.ts', ['--output', bundleDirectory]);
    const bundle = await readCollaborationRecoveryBundle(bundleDirectory);
    const selection = prepareCollaborationRecoverySelection(bundle);
    assert.equal(selection.operations.length, 1); assert.equal(selection.manual.length, 0);
    assert.equal(selection.operations[0].kind, 'recover_orphans'); assert.equal(selection.operations[0].documentId, currentId);
    assert.equal(selection.operations[0].expectedFileHash, selection.operations[0].projectedFileHash);
    assert.equal(selection.operations[0].selected, false); assert.equal(selection.operations[0].orphans.length, 1);
    const rejected: Array<[string, (value: RecoveryBundle) => void]> = [
      ['registry version', value => { value.rows.registry[0].state_version = '1'; }],
      ['registry lifecycle', value => { value.rows.registry[0].yjs_state_lifecycle = 'pending'; }],
      ['registry project', value => { value.rows.registry[0].project_id = 'foreign'; }],
      ['revision missing', value => { value.rows.revisions = []; }],
      ['revision scope', value => { value.rows.revisions[0].organization_id = 'foreign'; }],
      ['revision hash', value => { value.rows.revisions[0].content_hash = recoveryHash('other'); }],
      ['revision size', value => { value.rows.revisions[0].size_bytes = '1'; }],
      ['revision history-only', value => { value.rows.revisions[0].history_only = true; }],
      ['canonical mismatch', value => { value.rows.states.find(row => row.document_id === currentId)!.canonical_hash = recoveryHash('other'); }],
      ['degraded initial', value => { value.rows.states.find(row => row.document_id === currentId)!.degraded = '1'; }],
      ['initial generation', value => { value.rows.states.find(row => row.document_id === currentId)!.lifecycle_generation = '2'; }],
      ['binary mismatch', value => { value.rows.states.find(row => row.document_id === currentId)!.yjs_state = { encoding: 'base64', bytes: 'AA==' }; }],
      ['vector mismatch', value => { value.rows.states.find(row => row.document_id === currentId)!.state_vector = { encoding: 'base64', bytes: 'AA==' }; }],
    ];
    for (const [name, change] of rejected) {
      const invalid = structuredClone(bundle); change(invalid);
      assert.equal(prepareCollaborationRecoverySelection(invalid).operations.length, 0, name);
    }
    selection.operations[0].selected = true;
    const selectionHash = collaborationRecoverySelectionHash(selection);
    const reviewed = path.join(process.env.DATA, `initial-reviewed-${scope}.json`);
    await fs.writeFile(reviewed, JSON.stringify(selection) + '\n', { mode: 0o600 });
    const archive = path.join(process.env.DATA, `initial-synthetic-archive-${scope}.fixture`);
    const archiveBytes = 'ISOLATED SYNTHETIC TEST FIXTURE ONLY; not a production backup.\n';
    await fs.writeFile(archive, archiveBytes, { mode: 0o600 });
    const archiveHash = recoveryHash(archiveBytes); const backupId = randomUUID(); const time = new Date(Date.now() - 1000).toISOString();
    const checks: RecoveryExecutionProof['restore']['checks'] = ['postgres', 'workspace_files', 'yjs_bytes', 'registry', 'revisions', 'shares'];
    const reports = [
      { version: 1, backupId, completed: true, archiveHash, bundleManifestHash: bundle.manifestHash, isolatedSyntheticTestFixture: true },
      { version: 1, backupId, result: 'passed', archiveHash, checks: checks.map(kind => ({ kind,
        sourceHash: recoveryHash(`initial synthetic fixture:${kind}`), restoredHash: recoveryHash(`initial synthetic fixture:${kind}`) })), isolatedSyntheticTestFixture: true },
      { version: 1, bundleManifestHash: bundle.manifestHash, notebookWritersStopped: true,
        postgresExternalWriterCount: 0, isolatedSyntheticTestFixture: true },
    ];
    const reportPaths: string[] = []; const reportHashes: string[] = [];
    for (const [index, report] of reports.entries()) {
      const reportPath = path.join(process.env.DATA, `initial-report-${scope}-${index}.json`); const bytes = JSON.stringify(report) + '\n';
      await fs.writeFile(reportPath, bytes, { mode: 0o600 }); reportPaths.push(reportPath); reportHashes.push(recoveryHash(bytes));
    }
    const proof: RecoveryExecutionProof = { version: 1, backupId, bundleManifestHash: bundle.manifestHash,
      backup: { archive, archiveHash, completedAt: time, report: reportPaths[0], reportHash: reportHashes[0] },
      restore: { backupId, result: 'passed', verifiedAt: time, report: reportPaths[1], reportHash: reportHashes[1], checks },
      writerDrain: { verifiedAt: time, report: reportPaths[2], reportHash: reportHashes[2] } };
    const proofPath = path.join(process.env.DATA, `initial-proof-${scope}.json`);
    await fs.writeFile(proofPath, JSON.stringify(proof) + '\n', { mode: 0o600 });
    const journal = path.join(process.env.DATA, `initial-journal-${scope}`);
    const execute = () => cli('scripts/collaboration-recovery-apply.ts', ['apply', '--bundle', bundleDirectory, '--reviewed', reviewed,
      '--expect-selection-sha256', selectionHash, '--proof', proofPath, '--journal', journal]);
    const before = (await client.query('SELECT * FROM collaboration_yjs_states ORDER BY document_id')).rows;
    const beforeRevisions = (await client.query('SELECT * FROM file_revisions ORDER BY id')).rows;
    await client.query('UPDATE file_revisions SET content_hash=$1 WHERE id=$2', [recoveryHash('foreign revision'), revisionId]);
    await assert.rejects(execute(), 'actual changed native PostgreSQL revision must stop before intent');
    assert.equal((await client.query('SELECT status FROM collaboration_yjs_states WHERE document_id=$1', [orphanId])).rows[0].status, 'active');
    await client.query('UPDATE file_revisions SET content_hash=$1 WHERE id=$2', [recoveryHash(serialized), revisionId]);
    await client.query("UPDATE collaboration_documents SET workspace_type='organization' WHERE id=$1", [currentId]);
    await assert.rejects(execute(), 'actual changed current scope must stop before intent');
    await client.query("UPDATE collaboration_documents SET workspace_type='team' WHERE id=$1", [currentId]);
    await fs.writeFile(filename, 'New external edit\n'); await assert.rejects(execute(), 'actual changed file must stop before intent');
    assert.equal(await fs.readFile(filename, 'utf8'), 'New external edit\n'); await fs.writeFile(filename, serialized);
    assert.deepEqual((await client.query('SELECT * FROM collaboration_yjs_states ORDER BY document_id')).rows, before);
    const applied = await execute(); assert.equal(JSON.parse(applied.stdout.trim()).applied, 1);
    const after = (await client.query('SELECT * FROM collaboration_yjs_states ORDER BY document_id')).rows;
    const current = after.find(row => row.document_id === currentId)!; const originalCurrent = before.find(row => row.document_id === currentId)!;
    for (const field of ['yjs_state', 'state_vector', 'document_sequence', 'checkpoint_sequence', 'lifecycle_generation', 'canonical_hash', 'serialized_hash', 'has_bom', 'newline_style']) {
      assert.deepEqual(current[field], originalCurrent[field], `current initial ${field} remains exact`);
    }
    const orphan = after.find(row => row.document_id === orphanId)!; const originalOrphan = before.find(row => row.document_id === orphanId)!;
    assert.equal(orphan.status, 'archived'); assert.equal(Number(orphan.lifecycle_generation), Number(originalOrphan.lifecycle_generation) + 1);
    assert.deepEqual(orphan.yjs_state, originalOrphan.yjs_state); assert.deepEqual(orphan.state_vector, originalOrphan.state_vector);
    assert.equal(await fs.readFile(filename, 'utf8'), serialized);
    assert.deepEqual((await client.query('SELECT * FROM file_revisions ORDER BY id')).rows, beforeRevisions, 'normal initial checkpoint reuses exact known revision');
    const receipt = (await client.query('SELECT * FROM collaboration_file_projections WHERE document_id=$1', [currentId])).rows[0];
    assert.equal(Number(receipt.projected_sequence), 0); assert.equal(Number(receipt.finalized), 1); assert.equal(receipt.revision_id, revisionId);
    const share = (await client.query('SELECT * FROM public_file_shares WHERE id=$1', [shareId])).rows[0];
    assert.notEqual(share.file_identity, 'before-identity'); assert.notEqual(share.last_known_revision, 'before-revision');
    const inode = (await fs.stat(filename)).ino;
    const registryAfter = (await client.query('SELECT * FROM collaboration_documents ORDER BY id')).rows;
    const receiptAfter = (await client.query('SELECT * FROM collaboration_file_projections ORDER BY document_id')).rows;
    const freshResume = await execute(); assert.equal(JSON.parse(freshResume.stdout.trim()).resumed, 1);
    assert.equal((await fs.stat(filename)).ino, inode, 'a fresh CLI process resumes without another replacement');
    assert.deepEqual((await client.query('SELECT * FROM collaboration_yjs_states ORDER BY document_id')).rows, after);
    assert.deepEqual((await client.query('SELECT * FROM file_revisions ORDER BY id')).rows, beforeRevisions);
    assert.deepEqual((await client.query('SELECT * FROM collaboration_documents ORDER BY id')).rows, registryAfter);
    assert.deepEqual((await client.query('SELECT * FROM collaboration_file_projections ORDER BY document_id')).rows, receiptAfter);
    assert.deepEqual((await client.query('SELECT * FROM public_file_shares WHERE id=$1', [shareId])).rows[0], share);
    console.log('Initial recovery: native PostgreSQL, verified generation-1 sequence-zero retain-only preparation, fail-closed scope/revision/vector/size checks, actual changed-ledger/file rejection, normal finalized receipt/shares, exact archive and fresh CLI resume without duplicate writes passed. Synthetic proof fixtures are not production evidence.');
  } finally {
    documents.forEach(doc => doc.destroy()); await client.end(); await closeDatabaseConnections();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

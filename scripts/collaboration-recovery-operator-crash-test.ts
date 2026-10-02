import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import * as Y from 'yjs';
import { openDb, closeDatabaseConnections, type SqlConnection } from '../app/lib/db';
import { createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { decodeRecoveryState, recoveryPostgresInteger } from '../app/lib/collaboration/recovery-evidence';
import { collaborationRoomReleaseDigest } from '../app/lib/collaboration/room-owner-release';
import { recoveryHash } from '../app/lib/collaboration/recovery-plan';
import { readCollaborationRecoveryBundle, prepareCollaborationRecoverySelection, collaborationRecoverySelectionHash,
  applyCollaborationRecoverySelection, type RecoverySelection, type RecoveryExecutionProof } from '../app/lib/collaboration/recovery-operator';

const run = promisify(execFile);
const env = { ...process.env, CANVAS_ENV_FILE: '' };
type Worker = { boundary: 'clone_commit' | 'first_archive_commit'; bundle: string; reviewed: string; proof: string;
  journal: string; operationId: string; documentId: string; orphanIds: string[] };

function testDatabase(): URL {
  const database = new URL(process.env.DATABASE_URL!);
  assert(['127.0.0.1', 'localhost'].includes(database.hostname)); assert.equal(database.port, '55433');
  assert.match(database.pathname, /^\/canvas_editor_test_[a-f0-9]+$/u, 'disposable PostgreSQL wrapper required');
  return database;
}

/** Fault injection lives only in this child test process, after actual SQL COMMIT. */
async function worker(filename: string): Promise<void> {
  const input = JSON.parse(await fs.readFile(filename, 'utf8')) as Worker;
  const bundle = await readCollaborationRecoveryBundle(input.bundle);
  const selection = JSON.parse(await fs.readFile(input.reviewed, 'utf8')) as RecoverySelection;
  const proof = JSON.parse(await fs.readFile(input.proof, 'utf8')) as RecoveryExecutionProof;
  const openConnection = async (): Promise<SqlConnection> => {
    const connection = await openDb();
    return { ...connection, run: async (sql, values) => {
      const result = await connection.run(sql, values);
      if (sql === 'COMMIT') {
        if (input.boundary === 'clone_commit') {
          const outcome = await connection.get(`SELECT operation_id FROM collaboration_recovery_state_mutations
            WHERE operation_id=$1 AND kind='repair_code_marks'`, [input.operationId]);
          if (outcome) {
            const row = await connection.get('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [input.documentId]);
            const state = decodeRecoveryState(row as Record<string, unknown>);
            assert.equal(state.lifecycleGeneration, 2); assert.equal(state.documentSequence, 6); assert.equal(state.checkpointSequence, 5);
            process.exit(73);
          }
        } else {
          const result = await connection.get(`SELECT COUNT(*) AS count FROM collaboration_recovery_state_mutations
            WHERE kind='archive_orphan' AND document_id=ANY($1::text[])`, [input.orphanIds]) as { count: unknown };
          if (recoveryPostgresInteger(result.count) === 1) process.exit(73);
        }
      }
      return result;
    } };
  };
  await applyCollaborationRecoverySelection({ bundle, selection, selectionHash: collaborationRecoverySelectionHash(selection),
    proof, journalDirectory: input.journal, openConnection });
  throw new Error('Expected committed crash boundary was not reached.');
}

async function main(): Promise<void> {
  const database = testDatabase();
  if (process.argv[2] === '--worker') { await worker(process.argv[3]); return; }
  const client = new Client({ connectionString: database.href }); await client.connect();
  const documents: Y.Doc[] = []; const scope = randomUUID();
  const rootRelativePath = `workspace/recovery-crash-${scope}`; const directory = path.join(process.env.DATA!, rootRelativePath);
  const bundleDirectory = path.join(process.env.DATA!, 'crash-bundle');
  await fs.mkdir(directory, { recursive: true });
  const row = async (id: string) => (await client.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [id])).rows[0];
  const snapshot = async () => {
    const tables = ['collaboration_yjs_states', 'collaboration_documents', 'file_collaboration_lineages', 'file_revisions',
      'collaboration_file_projections', 'public_file_shares', 'collaboration_recovery_state_mutations', 'collaboration_room_release_receipts'];
    const rows = [];
    for (const table of tables) rows.push({ table, rows: (await client.query(`SELECT * FROM ${table} ORDER BY 1`)).rows });
    return rows;
  };
  const fileProof = async (filename: string) => {
    const [stat, bytes] = await Promise.all([fs.stat(filename), fs.readFile(filename)]);
    return { inode: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, hash: recoveryHash(bytes) };
  };
  try {
    await client.query(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
      VALUES ($1,'Isolated crash test',$2,0,1,1)`, [scope, `${scope}@example.test`]);
    await client.query(`INSERT INTO canvas_organization_settings (organization_id,owner_user_id,created_at,updated_at)
      VALUES ($1,$1,1,1)`, [scope]);
    await client.query(`INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at)
      VALUES ($1,$1,'team',$2,'Isolated crash test','active',1,1)`, [scope, rootRelativePath]);
    const seed = async (id: string, filename: string, doc: Y.Doc, content: string, degraded = false) => {
      documents.push(doc);
      await client.query(`INSERT INTO collaboration_yjs_states
        (document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,yjs_state,state_vector,
        document_sequence,checkpoint_sequence,persisted_at,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded)
        VALUES ($1,$2,$2,$3,$4,1,1,$5,$6,5,5,1,1,$7,$7,'lf',0,$8)`,
      [id, scope, filename, degraded ? 'tiptap_xml' : 'plain_text', Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc), recoveryHash(content), degraded ? 1 : 0]);
    };
    const register = async (id: string, filename: string, content: string) => {
      const revisionId = randomUUID();
      await client.query(`INSERT INTO file_revisions
        (id,workspace_id,organization_id,workspace_type,path,content_hash,size_bytes,revision_number,created_by_actor_type,created_at)
        VALUES ($1,$2,$2,'team',$3,$4,$5,1,'system',1)`, [revisionId, scope, filename, recoveryHash(content), Buffer.byteLength(content)]);
      await client.query(`INSERT INTO collaboration_documents
        (id,workspace_id,organization_id,workspace_type,path,provider,state_version,snapshot_revision_id,status,created_at,updated_at)
        VALUES ($1,$2,$2,'team',$3,'yjs',5,$4,'active',1,1)`, [id, scope, filename, revisionId]);
    };
    const cloneId = randomUUID(); const seedText = '---\ntitle: Isolated crash\n---\n\nOriginal text\n';
    const richSeed = createRichMarkdownYDoc(seedText, 'tiptap_xml'); const code = new Y.Doc({ gc: false });
    const bold = new Y.Doc({ gc: false }); const merged = new Y.Doc({ gc: false }); documents.push(richSeed, code, bold);
    for (const doc of [code, bold, merged]) Y.applyUpdate(doc, Y.encodeStateAsUpdate(richSeed));
    for (const [doc, mark] of [[code, 'code'], [bold, 'bold']] as const) {
      const element = doc.getXmlFragment('body').get(0); assert(element instanceof Y.XmlElement);
      const text = element.get(0); assert(text instanceof Y.XmlText); text.format(0, text.length, { [mark]: {} });
    }
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(code)); Y.applyUpdate(merged, Y.encodeStateAsUpdate(bold));
    await seed(cloneId, 'conflict.md', merged, seedText, true); await register(cloneId, 'conflict.md', seedText);
    await fs.writeFile(path.join(directory, 'conflict.md'), seedText);
    await client.query('UPDATE collaboration_yjs_states SET room_owner_epoch=1 WHERE document_id=$1', [cloneId]);
    const cloneBefore = await row(cloneId);
    const updateDigest = collaborationRoomReleaseDigest('update', cloneBefore.yjs_state);
    const vectorDigest = collaborationRoomReleaseDigest('vector', cloneBefore.state_vector);
    await client.query(`INSERT INTO collaboration_room_release_receipts
      (release_id,document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,owner_epoch,
      owner_token,owner_backend_pid,owner_backend_start,document_sequence,persisted_update_hash,persisted_vector_hash,live_update_hash,live_vector_hash,created_at)
      VALUES ($1,$2,$3,$3,'conflict.md','tiptap_xml',1,1,1,$4,1,'isolated-prior-owner',5,$5,$6,$5,$6,1)`,
    [randomUUID(), cloneId, scope, randomUUID(), updateDigest, vectorDigest]);

    const current = randomUUID(); const orphanIds = [randomUUID(), randomUUID()];
    for (const [id, content] of [[current, 'Current checkpoint\n'], ...orphanIds.map(id => [id, 'Historical checkpoint\n'])]) {
      const doc = new Y.Doc(); doc.getText('content').insert(0, content); await seed(id, 'note.txt', doc, content);
    }
    await register(current, 'note.txt', 'Current checkpoint\n'); await fs.writeFile(path.join(directory, 'note.txt'), 'Historical checkpoint\n');
    const originals = new Map(await Promise.all(orphanIds.map(async id => [id, await row(id)] as const)));
    const currentBefore = await row(current); const shareId = randomUUID();
    await client.query(`INSERT INTO public_file_shares
      (id,token,token_hash,token_preview,workspace_id,organization_id,workspace_type,workspace_root_relative_path,workspace_path,
      file_name,file_identity,last_known_revision,mime_type,size_bytes,status,created_by_user_id,created_at,updated_at)
      VALUES ($1,$1,$1,'fixture',$2,$2,'team',$3,'note.txt','note.txt','prior-identity','prior-revision','text/plain',1,'active',$2,1,1)`,
    [shareId, scope, rootRelativePath]);
    await run(process.execPath, ['--import', 'tsx', '--conditions', 'react-server', path.resolve('scripts/collaboration-recovery-dry-run.ts'),
      '--output', bundleDirectory], { env, timeout: 60_000 });
    const bundle = await readCollaborationRecoveryBundle(bundleDirectory); const proposal = prepareCollaborationRecoverySelection(bundle);
    assert.equal(proposal.operations.length, 2);
    const checks: RecoveryExecutionProof['restore']['checks'] = ['postgres', 'workspace_files', 'yjs_bytes', 'registry', 'revisions', 'shares'];
    const backupId = randomUUID(); const archive = path.join(process.env.DATA!, 'crash-synthetic-archive.bin');
    const archiveBytes = 'ISOLATED SYNTHETIC TEST ONLY. No production backup or restore.\n';
    await fs.writeFile(archive, archiveBytes, { mode: 0o600 }); const archiveHash = recoveryHash(archiveBytes);
    const reportFiles = ['backup', 'restore', 'drain'].map(name => path.join(process.env.DATA!, `crash-${name}-report.json`));
    const reports = [
      { version: 1, backupId, completed: true, archiveHash, bundleManifestHash: bundle.manifestHash, isolatedSyntheticTestFixture: true },
      { version: 1, backupId, result: 'passed', archiveHash, isolatedSyntheticTestFixture: true,
        checks: checks.map(kind => ({ kind, sourceHash: recoveryHash(kind), restoredHash: recoveryHash(kind) })) },
      { version: 1, bundleManifestHash: bundle.manifestHash, notebookWritersStopped: true, postgresExternalWriterCount: 0, isolatedSyntheticTestFixture: true },
    ].map(value => JSON.stringify(value) + '\n');
    for (const [index, filename] of reportFiles.entries()) await fs.writeFile(filename, reports[index], { mode: 0o600 });
    const time = new Date(Date.now() - 1000).toISOString();
    const proof: RecoveryExecutionProof = { version: 1, bundleManifestHash: bundle.manifestHash, backupId,
      backup: { archive, archiveHash, completedAt: time, report: reportFiles[0], reportHash: recoveryHash(reports[0]) },
      restore: { backupId, result: 'passed', verifiedAt: time, report: reportFiles[1], reportHash: recoveryHash(reports[1]), checks },
      writerDrain: { verifiedAt: time, report: reportFiles[2], reportHash: recoveryHash(reports[2]) } };
    const proofFile = path.join(process.env.DATA!, 'crash-proof.json');
    await fs.writeFile(proofFile, JSON.stringify(proof), { mode: 0o600 });
    for (const boundary of ['clone_commit', 'first_archive_commit'] as const) {
      const selection = structuredClone(proposal);
      selection.operations.forEach(operation => { operation.selected = operation.kind === (boundary === 'clone_commit' ? 'repair_code_marks' : 'recover_orphans'); });
      const operation = selection.operations.find(operation => operation.selected)!;
      const reviewed = path.join(process.env.DATA!, `${boundary}-selection.json`); const journal = path.join(process.env.DATA!, `${boundary}-journal`);
      await fs.writeFile(reviewed, JSON.stringify(selection), { mode: 0o600 });
      const workerFile = path.join(process.env.DATA!, `${boundary}-worker.json`);
      const input: Worker = { boundary, bundle: bundleDirectory, reviewed, proof: proofFile, journal,
        operationId: operation.id, documentId: operation.documentId, orphanIds };
      await fs.writeFile(workerFile, JSON.stringify(input), { mode: 0o600 });
      const beforeCloneFile = await fileProof(path.join(directory, 'conflict.md'));
      await assert.rejects(run(process.execPath, ['--import', 'tsx', '--conditions', 'react-server',
        path.resolve('scripts/collaboration-recovery-operator-crash-test.ts'), '--worker', workerFile], { env, timeout: 60_000 }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 73), 'child must exit at its actual committed boundary');
      await assert.rejects(fs.stat(path.join(journal, `${operation.id}.complete.json`)), { code: 'ENOENT' });
      assert.equal(JSON.parse(await fs.readFile(path.join(journal, `${operation.id}.intent.json`), 'utf8')).operationId, operation.id);
      if (boundary === 'clone_commit') {
        const after = decodeRecoveryState(await row(cloneId));
        assert.equal(after.lifecycleGeneration, 2); assert.equal(after.documentSequence, 6); assert.equal(after.checkpointSequence, 5);
        assert.equal(after.degraded, false); assert.equal(Number((await row(cloneId)).room_owner_epoch), 1);
        assert.deepEqual(await fileProof(path.join(directory, 'conflict.md')), beforeCloneFile, 'clone COMMIT precedes every file write');
        assert.equal((await client.query('SELECT * FROM collaboration_file_projections WHERE document_id=$1', [cloneId])).rowCount, 0);
        const outcome = (await client.query('SELECT * FROM collaboration_recovery_state_mutations WHERE operation_id=$1', [operation.id])).rows[0];
        assert.deepEqual(outcome.before_update, cloneBefore.yjs_state); assert.deepEqual(outcome.before_vector, cloneBefore.state_vector);
      } else {
        const statuses = await Promise.all(orphanIds.map(async id => (await row(id)).status));
        assert.equal(statuses.filter(status => status === 'archived').length, 1); assert.equal(statuses.filter(status => status === 'active').length, 1);
        const receipt = (await client.query('SELECT finalized FROM collaboration_file_projections WHERE document_id=$1', [current])).rows[0];
        assert.equal(Number(receipt.finalized), 1, 'first archival occurs only after finalized file/share projection');
        const share = (await client.query('SELECT * FROM public_file_shares WHERE id=$1', [shareId])).rows[0];
        const stat = await fs.stat(path.join(directory, 'note.txt'));
        assert.equal(share.file_identity, `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`);
        assert.equal(await fs.readFile(path.join(directory, 'note.txt'), 'utf8'), 'Current checkpoint\n');
      }
      const resume = () => run(process.execPath, ['--import', 'tsx', '--conditions', 'react-server', path.resolve('scripts/collaboration-recovery-apply.ts'),
        'apply', '--bundle', bundleDirectory, '--reviewed', reviewed, '--expect-selection-sha256', collaborationRecoverySelectionHash(selection),
        '--proof', proofFile, '--journal', journal], { env, timeout: 60_000 });
      const resumed = await resume(); assert(resumed.stdout.includes('"completed":true'));
      if (boundary === 'clone_commit') {
        const after = decodeRecoveryState(await row(cloneId));
        assert.equal(after.lifecycleGeneration, 2); assert.equal(after.documentSequence, 6); assert.equal(after.checkpointSequence, 6);
        assert.match(await fs.readFile(path.join(directory, 'conflict.md'), 'utf8'), /`Original text`/u);
      } else {
        for (const id of orphanIds) {
          const after = await row(id); assert.equal(after.status, 'archived'); assert.equal(Number(after.lifecycle_generation), 2);
          assert.equal(Number(after.document_sequence), 5); assert.deepEqual(after.yjs_state, originals.get(id)!.yjs_state);
          assert.deepEqual(after.state_vector, originals.get(id)!.state_vector);
        }
        const currentAfter = await row(current); assert.deepEqual(currentAfter.yjs_state, currentBefore.yjs_state);
        assert.deepEqual(currentAfter.state_vector, currentBefore.state_vector); assert.equal(Number(currentAfter.lifecycle_generation), 1);
        assert.equal(Number(currentAfter.document_sequence), 5);
      }
      const committed = await snapshot(); const fileBeforeReplay = await fileProof(path.join(directory, String(operation.expectedState.path)));
      const replayed = await resume(); assert(replayed.stdout.includes('"resumed":1'));
      assert.deepEqual(await snapshot(), committed, 'fresh completed replay changes no database row or revision');
      assert.deepEqual(await fileProof(path.join(directory, String(operation.expectedState.path))), fileBeforeReplay,
        'fresh completed replay does not replace the file or change its mtime');
    }
    assert.equal(Number((await client.query('SELECT COUNT(*) AS count FROM collaboration_recovery_state_mutations')).rows[0].count), 3);
    console.log('Recovery crash boundaries: real isolated PostgreSQL, child exit after clone COMMIT with owner release and after first orphan COMMIT, fresh CLI resumes and completed no-op DB/inode/revision stability passed. Proof reports were synthetic isolated fixtures.');
  } finally { documents.forEach(doc => doc.destroy()); await client.end(); await closeDatabaseConnections(); }
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : 'Recovery crash test failed'); process.exit(1);
});

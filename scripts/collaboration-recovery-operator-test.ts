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
import { decodeRecoveryState } from '../app/lib/collaboration/recovery-evidence';
import { recoveryHash } from '../app/lib/collaboration/recovery-plan';
import { readCollaborationRecoveryBundle, prepareCollaborationRecoverySelection, collaborationRecoverySelectionHash,
  applyCollaborationRecoverySelection, verifyCollaborationRecoveryExecutionProof, type RecoveryExecutionProof } from '../app/lib/collaboration/recovery-operator';

const run = promisify(execFile);
async function main() {
  const database = new URL(process.env.DATABASE_URL!);
  assert(['127.0.0.1', 'localhost'].includes(database.hostname)); assert.equal(database.port, '55433');
  assert.match(database.pathname, /^\/canvas_editor_test_[a-f0-9]+$/u, 'disposable database required');
  const client = new Client({ connectionString: database.href }); await client.connect();
  const documents: Y.Doc[] = []; const scope = randomUUID();
  const rootRelativePath = `workspace/recovery-operator-${scope}`; const directory = path.join(process.env.DATA!, rootRelativePath);
  await fs.mkdir(directory, { recursive: true });
  try {
    await client.query(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES ($1,'Recovery operator',$2,0,1,1)`, [scope, `${scope}@example.test`]);
    await client.query(`INSERT INTO canvas_organization_settings (organization_id,owner_user_id,created_at,updated_at) VALUES ($1,$1,1,1)`, [scope]);
    await client.query(`INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at)
      VALUES ($1,$1,'team',$2,'Recovery operator','active',1,1)`, [scope, rootRelativePath]);
    const insert = async (id: string, filename: string, doc: Y.Doc, content: string, degraded = false) => {
      documents.push(doc);
      await client.query(`INSERT INTO collaboration_yjs_states
        (document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,yjs_state,state_vector,
        document_sequence,checkpoint_sequence,persisted_at,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded)
        VALUES ($1,$2,$2,$3,$4,1,1,$5,$6,5,5,1,1,$7,$7,'lf',0,$8)`,
      [id, scope, filename, degraded ? 'tiptap_xml' : 'plain_text', Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc), recoveryHash(content), degraded ? 1 : 0]);
    };
    const current = randomUUID(); const old = randomUUID(); const old2 = randomUUID(); const revision = randomUUID();
    for (const [id, content] of [[current, 'Current checkpoint\n'], [old, 'Historical checkpoint\n'], [old2, 'Historical checkpoint\n']]) {
      const doc = new Y.Doc(); doc.getText('content').insert(0, content); await insert(id, 'note.txt', doc, content);
    }
    await client.query(`INSERT INTO file_revisions (id,workspace_id,organization_id,workspace_type,path,content_hash,size_bytes,revision_number,created_by_actor_type,created_at)
      VALUES ($1,$2,$2,'team','note.txt',$3,$4,1,'system',1)`, [revision, scope, recoveryHash('Current checkpoint\n'), Buffer.byteLength('Current checkpoint\n')]);
    await client.query(`INSERT INTO collaboration_documents (id,workspace_id,organization_id,workspace_type,path,provider,state_version,snapshot_revision_id,status,created_at,updated_at)
      VALUES ($1,$2,$2,'team','note.txt','yjs',5,$3,'active',1,1)`, [current, scope, revision]);
    await fs.writeFile(path.join(directory, 'note.txt'), 'Historical checkpoint\n');
    const cloneId = randomUUID(); const cloneRevision = randomUUID(); const seedText = '---\ntitle: Evidence\n---\n\nOriginal text\n';
    const seed = createRichMarkdownYDoc(seedText, 'tiptap_xml'); const code = new Y.Doc({ gc: false }); const bold = new Y.Doc({ gc: false }); const merged = new Y.Doc({ gc: false });
    documents.push(seed, code, bold);
    for (const doc of [code, bold, merged]) Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
    for (const [doc, mark] of [[code, 'code'], [bold, 'bold']] as const) {
      const element = doc.getXmlFragment('body').get(0); assert(element instanceof Y.XmlElement);
      const text = element.get(0); assert(text instanceof Y.XmlText); text.format(0, text.length, { [mark]: {} });
    }
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(code)); Y.applyUpdate(merged, Y.encodeStateAsUpdate(bold));
    await insert(cloneId, 'conflict.md', merged, seedText, true);
    await client.query(`INSERT INTO file_revisions (id,workspace_id,organization_id,workspace_type,path,content_hash,size_bytes,revision_number,created_by_actor_type,created_at)
      VALUES ($1,$2,$2,'team','conflict.md',$3,$4,1,'system',1)`, [cloneRevision, scope, recoveryHash(seedText), Buffer.byteLength(seedText)]);
    await client.query(`INSERT INTO collaboration_documents (id,workspace_id,organization_id,workspace_type,path,provider,state_version,snapshot_revision_id,status,created_at,updated_at)
      VALUES ($1,$2,$2,'team','conflict.md','yjs',5,$3,'active',1,1)`, [cloneId, scope, cloneRevision]);
    await fs.writeFile(path.join(directory, 'conflict.md'), seedText);
    const shareId = randomUUID();
    await client.query(`INSERT INTO public_file_shares (id,token,token_hash,token_preview,workspace_id,organization_id,workspace_type,workspace_root_relative_path,
      workspace_path,file_name,file_identity,last_known_revision,mime_type,size_bytes,status,created_by_user_id,created_at,updated_at)
      VALUES ($1,$1,$1,'fixture',$2,$2,'team',$3,'note.txt','note.txt','before-identity','before-revision','text/plain',1,'active',$2,1,1)`, [shareId, scope, rootRelativePath]);
    const bundleDirectory = path.join(process.env.DATA!, 'operator-bundle');
    await run(process.execPath, ['--import', 'tsx', '--conditions', 'react-server', path.resolve('scripts/collaboration-recovery-dry-run.ts'), '--output', bundleDirectory],
      { env: { ...process.env, CANVAS_ENV_FILE: '' }, timeout: 60_000 });
    const bundle = await readCollaborationRecoveryBundle(bundleDirectory); const selection = prepareCollaborationRecoverySelection(bundle);
    assert.equal(selection.operations.length, 2); assert.equal(selection.operations.find(operation => operation.kind === 'recover_orphans')!.orphans.length, 2);
    selection.operations.forEach(operation => { operation.selected = true; });
    const selectionHash = collaborationRecoverySelectionHash(selection);
    const backupReport = path.join(process.env.DATA!, 'backup-report.json'); const restoreReport = path.join(process.env.DATA!, 'restore-report.json'); const drainReport = path.join(process.env.DATA!, 'drain-report.json');
    // These are explicit synthetic test fixtures, never evidence of a production backup or restore.
    const archive = path.join(process.env.DATA!, 'synthetic-backup.fixture'); const backupId = randomUUID();
    const archiveHash = recoveryHash('Isolated synthetic archive'); await fs.writeFile(archive, 'Isolated synthetic archive', { mode: 0o600 });
    const checks: RecoveryExecutionProof['restore']['checks'] = ['postgres', 'workspace_files', 'yjs_bytes', 'registry', 'revisions', 'shares'];
    const reports = [
      { version: 1, backupId, completed: true, archiveHash, bundleManifestHash: bundle.manifestHash },
      { version: 1, backupId, result: 'passed', archiveHash, checks: checks.map(kind => ({ kind, sourceHash: recoveryHash(kind), restoredHash: recoveryHash(kind) })) },
      { version: 1, bundleManifestHash: bundle.manifestHash, notebookWritersStopped: true, postgresExternalWriterCount: 0 },
    ].map(value => JSON.stringify(value) + '\n');
    for (const [index, filename] of [backupReport, restoreReport, drainReport].entries()) await fs.writeFile(filename, reports[index], { mode: 0o600 });
    const time = new Date(Date.now() - 1000).toISOString();
    const proof: RecoveryExecutionProof = { version: 1, bundleManifestHash: bundle.manifestHash, backupId,
      backup: { archive, archiveHash, completedAt: time, report: backupReport, reportHash: recoveryHash(reports[0]) },
      restore: { backupId, result: 'passed', verifiedAt: time, report: restoreReport, reportHash: recoveryHash(reports[1]), checks },
      writerDrain: { verifiedAt: time, report: drainReport, reportHash: recoveryHash(reports[2]) } };
    await fs.writeFile(archive, 'Changed archive');
    await assert.rejects(verifyCollaborationRecoveryExecutionProof(proof, bundle.manifestHash), /archive hash mismatch/u);
    await fs.writeFile(archive, 'Isolated synthetic archive');
    const failedRestore = JSON.stringify({ ...JSON.parse(reports[1]), result: 'failed' });
    await fs.writeFile(restoreReport, failedRestore);
    await assert.rejects(verifyCollaborationRecoveryExecutionProof({ ...proof, restore: { ...proof.restore, reportHash: recoveryHash(failedRestore) } },
      bundle.manifestHash), /restore comparison/u);
    await fs.writeFile(restoreReport, reports[1]);
    const activeWriter = JSON.stringify({ ...JSON.parse(reports[2]), postgresExternalWriterCount: 1 });
    await fs.writeFile(drainReport, activeWriter);
    await assert.rejects(verifyCollaborationRecoveryExecutionProof({ ...proof, writerDrain: { ...proof.writerDrain, reportHash: recoveryHash(activeWriter) } },
      bundle.manifestHash), /writer drain/u);
    await fs.writeFile(drainReport, reports[2]);
    const journalDirectory = path.join(process.env.DATA!, 'operator-journal');
    const execute = (openConnection = openDb, selected = selection, hash = selectionHash) => applyCollaborationRecoverySelection({ bundle,
      selection: selected, selectionHash: hash, proof, journalDirectory, openConnection });
    await assert.rejects(execute(openDb, selection, recoveryHash('wrong')), /reviewed selection changed/u);
    const altered = structuredClone(selection); altered.operations[0].expectedFileHash = recoveryHash('arbitrary');
    await assert.rejects(execute(openDb, altered, collaborationRecoverySelectionHash(altered)), /not derived/u);
    const originalStates = (await client.query('SELECT * FROM collaboration_yjs_states ORDER BY document_id')).rows;
    let failArchiveOnce = true;
    const faultConnection = async (): Promise<SqlConnection> => {
      const connection = await openDb(); return { ...connection, get: async (sql, params) => {
        if (failArchiveOnce && sql.includes('FOR UPDATE') && sql.includes('collaboration_yjs_states') && params?.[0] === old) {
          failArchiveOnce = false; throw new Error('Injected crash after checkpoint, before archive');
        }
        return connection.get(sql, params);
      } };
    };
    await assert.rejects(execute(faultConnection), /Injected crash/u);
    assert.equal(await fs.readFile(path.join(directory, 'note.txt'), 'utf8'), 'Current checkpoint\n');
    assert.equal((await client.query('SELECT status FROM collaboration_yjs_states WHERE document_id=$1', [old])).rows[0].status, 'active');
    const result = await execute(); assert.equal(result.length, 2);
    const clone = decodeRecoveryState((await client.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [cloneId])).rows[0]);
    assert.equal(clone.lifecycleGeneration, 2); assert.equal(clone.documentSequence, 6); assert.equal(clone.checkpointSequence, 6); assert.equal(clone.degraded, false);
    assert.match(await fs.readFile(path.join(directory, 'conflict.md'), 'utf8'), /`Original text`/u);
    const share = (await client.query('SELECT * FROM public_file_shares WHERE id=$1', [shareId])).rows[0];
    assert.equal(share.status, 'active'); assert.notEqual(share.file_identity, 'before-identity'); assert.notEqual(share.last_known_revision, 'before-revision');
    for (const id of [old, old2]) {
      const after = (await client.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [id])).rows[0];
      assert.equal(after.status, 'archived'); assert.deepEqual(after.yjs_state, originalStates.find(row => row.document_id === id).yjs_state);
    }
    const beforeReplay = (await client.query('SELECT * FROM collaboration_yjs_states ORDER BY document_id')).rows;
    const revisionCount = (await client.query('SELECT count(*) AS count FROM file_revisions')).rows[0].count;
    const inode = (await fs.stat(path.join(directory, 'note.txt'))).ino;
    assert((await execute()).every(result => result.disposition === 'already_applied'));
    assert.deepEqual((await client.query('SELECT * FROM collaboration_yjs_states ORDER BY document_id')).rows, beforeReplay);
    assert.equal((await client.query('SELECT count(*) AS count FROM file_revisions')).rows[0].count, revisionCount);
    assert.equal((await fs.stat(path.join(directory, 'note.txt'))).ino, inode);
    await fs.writeFile(path.join(directory, 'note.txt'), 'External newer edit');
    await assert.rejects(execute(), /file changed/u); assert.equal(await fs.readFile(path.join(directory, 'note.txt'), 'utf8'), 'External newer edit');
    const replacement = path.join(directory, 'replacement.txt'); await fs.writeFile(replacement, 'Current checkpoint\n');
    await fs.rename(replacement, path.join(directory, 'note.txt'));
    const shareBeforeIdenticalReplacement = (await client.query('SELECT * FROM public_file_shares WHERE id=$1', [shareId])).rows[0];
    await assert.rejects(execute(), /completed projection changed/u);
    assert.deepEqual((await client.query('SELECT * FROM public_file_shares WHERE id=$1', [shareId])).rows[0], shareBeforeIdenticalReplacement,
      'same-byte external replacement must not silently rebind a public share');
    await fs.appendFile(path.join(bundleDirectory, 'plan.json'), ' '); await assert.rejects(readCollaborationRecoveryBundle(bundleDirectory), /artifact hash mismatch/u);
    console.log('Recovery operator: real PostgreSQL and filesystem, checked revisions, private bundles, complete projection/share receipts, exact archives, crash resume, clone lifecycle, idempotence and changed-file rejection passed.');
  } finally { documents.forEach(doc => doc.destroy()); await client.end(); await closeDatabaseConnections(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

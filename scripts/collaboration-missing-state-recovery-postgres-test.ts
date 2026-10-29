import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import { captureMissingStateRecoveryBundle, prepareMissingStateRecoverySelection, applyMissingStateRecoverySelection } from '../app/lib/collaboration/recovery-missing-state';
import { canonical, type RecoveryExecutionProof } from '../app/lib/collaboration/recovery-operator';
import { recoveryHash } from '../app/lib/collaboration/recovery-plan';
import { decodeRecoveryState } from '../app/lib/collaboration/recovery-evidence';
import { authoritativeCollaborationSnapshot } from '../app/lib/collaboration/authoritative-snapshot';
import { serializeCanonicalText } from '../app/lib/collaboration/persistence';

async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  assert(['localhost','127.0.0.1'].includes(url.hostname)); assert.equal(url.port, '55433');
  assert.match(url.pathname, /^\/canvas_editor_test_[a-f0-9]+$/u, 'fresh isolated PostgreSQL required');
  assert(process.env.DATA && path.isAbsolute(process.env.DATA));
  const connect = async () => { const client = new Client({ connectionString: url.href }); await client.connect(); return client; };
  const wrap = (client: Client): SqlConnection => ({ get: async (sql, params) => (await client.query(sql, params)).rows[0],
    all: async (sql, params) => (await client.query(sql, params)).rows, run: async (sql, params) => client.query(sql, params),
    close: async () => { await client.end(); } });
  const openConnection = async () => wrap(await connect());
  let fixture = await connect();
  await runPostgresMigrations(fixture as unknown as Parameters<typeof runPostgresMigrations>[0]);
  const scope = randomUUID(), rootRelativePath = `workspace/missing-state-${scope}`, root = path.join(process.env.DATA, rootRelativePath);
  await fs.mkdir(root, { recursive: true });
  await fixture.query(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
    VALUES ($1,'Missing state fixture',$2,0,1,1)`, [scope, `${scope}@example.test`]);
  await fixture.query(`INSERT INTO canvas_organization_settings (organization_id,owner_user_id,created_at,updated_at) VALUES ($1,$1,1,1)`, [scope]);
  await fixture.query(`INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at)
    VALUES ($1,$1,'team',$2,'Missing state fixture','active',1,1)`, [scope, rootRelativePath]);
  const ids: string[] = [], contents = ['# Literal Markdown\n\n[Other](other.md)\n', '\ufeff# Original\r\n\r\nUnchanged **Markdown**\r\n'];
  for (const [index, content] of contents.entries()) {
    const id = randomUUID(), lineage = randomUUID(), revision = randomUUID(), filename = `note-${index}.md`; ids.push(id);
    await fs.writeFile(path.join(root, filename), content);
    await fixture.query(`INSERT INTO file_collaboration_lineages (id,workspace_id,organization_id,workspace_type,path,status,created_at)
      VALUES ($1,$2,$2,'team',$3,'active',1)`, [lineage, scope, filename]);
    await fixture.query(`INSERT INTO file_revisions
      (id,workspace_id,organization_id,workspace_type,path,content_hash,size_bytes,revision_number,created_by_actor_type,created_at,lineage_id)
      VALUES ($1,$2,$2,'team',$3,$4,$5,1,'system',1,$6)`, [revision, scope, filename, recoveryHash(content), Buffer.byteLength(content), lineage]);
    await fixture.query(`INSERT INTO collaboration_documents
      (id,workspace_id,organization_id,workspace_type,path,provider,state_version,snapshot_revision_id,status,created_at,updated_at,lineage_id,yjs_state_lifecycle)
      VALUES ($1,$2,$2,'team',$3,'yjs',0,$4,'active',1,1,$5,'legacy_unknown')`, [id, scope, filename, revision, lineage]);
  }
  const share = randomUUID();
  await fixture.query(`INSERT INTO public_file_shares
    (id,token,token_hash,token_preview,workspace_id,organization_id,workspace_type,workspace_root_relative_path,workspace_path,
    file_name,file_identity,last_known_revision,mime_type,size_bytes,status,created_by_user_id,created_at,updated_at)
    VALUES ($1,$1,$1,'fixture',$2,$2,'team',$3,'note-0.md','note-0.md','original-inode','original-revision','text/markdown',1,'active',$2,1,1)`,
  [share, scope, rootRelativePath]);
  await fixture.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const bundle = await captureMissingStateRecoveryBundle(wrap(fixture), ids);
  await fixture.query('COMMIT');
  const bundleManifestHash = recoveryHash(canonical(bundle) + '\n'), selection = prepareMissingStateRecoverySelection(bundle, bundleManifestHash);
  assert.equal(selection.operations.length, 2); assert(selection.operations.every(item => !item.selected));
  const bad = structuredClone(bundle); bad.documents[0].source.hash = recoveryHash('wrong');
  assert.throws(() => prepareMissingStateRecoverySelection(bad, bundleManifestHash), /selected revision/u);
  const initialized = structuredClone(bundle); initialized.documents[0].registry.yjs_state_lifecycle = 'initialized';
  assert.throws(() => prepareMissingStateRecoverySelection(initialized, bundleManifestHash), /initialized registry/u);
  selection.operations.forEach(item => { item.selected = true; });
  const selectionHash = recoveryHash(canonical(selection));
  // Explicit synthetic fixtures test the verifier contract. They are never
  // claimed as evidence of a real production backup or restore rehearsal.
  const backupId = randomUUID(), archive = path.join(process.env.DATA, 'synthetic-backup.fixture');
  await fs.writeFile(archive, 'ISOLATED SYNTHETIC TEST FIXTURE', { mode: 0o600 });
  const archiveHash = recoveryHash(await fs.readFile(archive));
  const checks: RecoveryExecutionProof['restore']['checks'] = ['postgres','workspace_files','yjs_bytes','registry','revisions','shares'];
  const reports = [
    { version: 1, backupId, completed: true, archiveHash, bundleManifestHash, isolatedSyntheticTestFixture: true },
    { version: 1, backupId, result: 'passed', archiveHash, isolatedSyntheticTestFixture: true,
      checks: checks.map(kind => ({ kind, sourceHash: recoveryHash(kind), restoredHash: recoveryHash(kind) })) },
    { version: 1, bundleManifestHash, notebookWritersStopped: true, postgresExternalWriterCount: 0, isolatedSyntheticTestFixture: true },
  ].map(value => canonical(value) + '\n');
  const filenames = ['backup','restore','drain'].map(name => path.join(process.env.DATA!, name + '.fixture.json'));
  for (const [index, filename] of filenames.entries()) await fs.writeFile(filename, reports[index], { mode: 0o600 });
  const time = new Date(Date.now() - 1000).toISOString();
  const proof: RecoveryExecutionProof = { version: 1, bundleManifestHash, backupId,
    backup: { archive, archiveHash, completedAt: time, report: filenames[0], reportHash: recoveryHash(reports[0]) },
    restore: { backupId, result: 'passed', verifiedAt: time, report: filenames[1], reportHash: recoveryHash(reports[1]), checks },
    writerDrain: { verifiedAt: time, report: filenames[2], reportHash: recoveryHash(reports[2]) } };
  const input = { bundle, bundleManifestHash, selection, selectionHash, proof,
    journalDirectory: path.join(process.env.DATA, 'journal'), openConnection };
  await assert.rejects(applyMissingStateRecoverySelection({ ...input, bundle: bad }), /bundle hash changed/u);
  await assert.rejects(applyMissingStateRecoverySelection({ ...input, selectionHash: recoveryHash('wrong') }), /selection changed/u);
  await assert.rejects(applyMissingStateRecoverySelection(input), /another database client/u);
  assert.equal((await fixture.query('SELECT count(*) FROM collaboration_yjs_states WHERE workspace_id=$1', [scope])).rows[0].count, '0');
  await fixture.end();
  let failInsert = true;
  const rollbackConnection = async () => { const database = await openConnection(); return { ...database, run: async (sql: string, params?: unknown[]) => {
    if (failInsert && sql.startsWith('INSERT INTO collaboration_file_projections')) { failInsert = false; throw new Error('Injected projection failure'); }
    return database.run(sql, params);
  } }; };
  await assert.rejects(applyMissingStateRecoverySelection({ ...input, openConnection: rollbackConnection }), /Injected projection failure/u);
  fixture = await connect();
  assert.equal((await fixture.query('SELECT count(*) FROM collaboration_yjs_states WHERE workspace_id=$1', [scope])).rows[0].count, '0');
  assert((await fixture.query('SELECT yjs_state_lifecycle FROM collaboration_documents WHERE workspace_id=$1', [scope])).rows.every(row => row.yjs_state_lifecycle === 'legacy_unknown'));
  await fixture.end();
  let loseCommit = true;
  const uncertainConnection = async () => { const database = await openConnection(); return { ...database, run: async (sql: string, params?: unknown[]) => {
    const result = await database.run(sql, params);
    if (loseCommit && sql === 'COMMIT') { loseCommit = false; throw new Error('Lost committed response'); }
    return result;
  } }; };
  const applied = await applyMissingStateRecoverySelection({ ...input, openConnection: uncertainConnection });
  assert.equal(applied.length, 2); assert.equal(loseCommit, false);
  assert((await applyMissingStateRecoverySelection(input)).every(item => item.disposition === 'already_applied'));
  fixture = await connect();
  for (const item of bundle.documents) {
    const registry = (await fixture.query('SELECT * FROM collaboration_documents WHERE id=$1', [item.registry.id])).rows[0];
    assert.deepEqual(registry, { ...item.registry, yjs_state_lifecycle: 'initialized' });
    assert.deepEqual((await fixture.query('SELECT * FROM file_revisions WHERE lineage_id=$1 ORDER BY id', [item.registry.lineage_id])).rows, item.revisions);
    assert.deepEqual((await fixture.query('SELECT * FROM public_file_shares WHERE workspace_id=$1 AND workspace_path=$2 ORDER BY id', [scope, item.registry.path])).rows, item.shares);
    const state = decodeRecoveryState((await fixture.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [item.registry.id])).rows[0]);
    assert.equal(recoveryHash(serializeCanonicalText(authoritativeCollaborationSnapshot(state).canonicalContent, state)), item.source.hash);
    const filename = path.join(root, String(item.registry.path)), stat = await fs.stat(filename);
    assert.equal(recoveryHash(await fs.readFile(filename)), item.source.hash);
    assert.equal(stat.ino, item.source.fileIdentity.inode); assert.equal(stat.mtimeMs, item.source.fileIdentity.mtimeMs);
  }
  await fixture.query("UPDATE public_file_shares SET last_known_revision='external-change' WHERE id=$1", [share]);
  await fixture.end();
  await assert.rejects(applyMissingStateRecoverySelection(input), /current state is not this recovery/u);
  fixture = await connect(); await fixture.query("UPDATE public_file_shares SET last_known_revision='original-revision' WHERE id=$1", [share]); await fixture.end();
  await fs.appendFile(path.join(root, 'note-0.md'), 'New external edit');
  await assert.rejects(applyMissingStateRecoverySelection(input), /file identity or content changed/u);
  console.log('Missing-state recovery: real PostgreSQL, exact UTF-8/BOM/CRLF preservation, unchanged IDs/revisions/shares/files, writer exclusion, rollback, unknown commit, replay and changed evidence rejection passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

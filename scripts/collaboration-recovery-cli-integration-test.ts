import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';
import * as Y from 'yjs';

const run = promisify(execFile);
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const database = new URL(process.env.DATABASE_URL!);
  assert(['127.0.0.1', 'localhost'].includes(database.hostname));
  assert.equal(database.port, '55433');
  assert.match(database.pathname, /^\/canvas_editor_test_[a-f0-9]+$/u, 'requires a disposable local database');
  assert(process.env.DATA && path.isAbsolute(process.env.DATA));
  const client = new Client({ connectionString: database.href });
  await client.connect();
  const id = randomUUID();
  const rootRelativePath = `workspace/recovery-cli-${id}`;
  const directory = path.join(process.env.DATA, rootRelativePath);
  await fs.mkdir(directory, { recursive: true });
  const documents: Y.Doc[] = [];
  try {
    const raw = (await client.query('SELECT 0::bigint AS zero, 1::bigint AS one')).rows[0];
    assert.equal(raw.zero, '0'); assert.equal(raw.one, '1', 'the CLI process must handle raw pg bigint strings');
    await client.query(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
      VALUES ($1,'Recovery CLI',$2,0,1,1)`, [id, `recovery-${id}@example.test`]);
    await client.query(`INSERT INTO canvas_organization_settings (organization_id,owner_user_id,created_at,updated_at)
      VALUES ($1,$1,1,1)`, [id]);
    await client.query(`INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at)
      VALUES ($1,$1,'team',$2,'Recovery CLI','active',1,1)`, [id, rootRelativePath]);
    const oldId = `old-${id}`; const currentId = `current-${id}`;
    for (const [documentId, content] of [[oldId, 'Historical snapshot'], [currentId, 'Current snapshot']]) {
      const doc = new Y.Doc(); documents.push(doc); doc.getText('content').insert(0, content);
      await client.query(`INSERT INTO collaboration_yjs_states
        (document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,yjs_state,state_vector,
        document_sequence,checkpoint_sequence,persisted_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded)
        VALUES ($1,$2,$2,'note.txt','plain_text',1,1,$3,$4,5,5,1,$5,$5,'lf',0,0)`,
      [documentId, id, Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc), hash(content)]);
    }
    await client.query(`INSERT INTO collaboration_documents
      (id,workspace_id,organization_id,workspace_type,path,provider,snapshot_revision_id,status,created_at,updated_at)
      VALUES ($1,$2,$2,'team','note.txt','yjs','revision','active',1,1)`, [currentId, id]);
    const filename = path.join(directory, 'note.txt');
    await fs.writeFile(filename, 'Historical snapshot');
    const capture = async (name: string) => {
      const output = path.join(process.env.DATA!, `capture-${name}`);
      const before = (await client.query('SELECT * FROM collaboration_yjs_states ORDER BY document_id')).rows;
      const result = await run(process.execPath, ['--import', 'tsx', '--conditions', 'react-server',
        path.resolve('scripts/collaboration-recovery-dry-run.ts'), '--output', output], {
        env: { ...process.env, CANVAS_ENV_FILE: '' }, timeout: 60_000, maxBuffer: 1024 * 1024,
      });
      assert(!result.stdout.includes('Historical snapshot') && !result.stdout.includes('Current snapshot'));
      assert.deepEqual((await client.query('SELECT * FROM collaboration_yjs_states ORDER BY document_id')).rows, before);
      assert.equal(await fs.readFile(filename, 'utf8'), 'Historical snapshot');
      const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
      assert.equal(manifest.complete, true);
      for (const [artifact, expectedHash] of Object.entries(manifest.artifacts)) {
        assert.equal(hash(await fs.readFile(path.join(output, artifact))), expectedHash);
      }
      return JSON.parse(await fs.readFile(path.join(output, 'plan.json'), 'utf8')).cases[0];
    };
    const healthy = await capture('healthy');
    assert.equal(healthy.proposedAction, 'restore_current_snapshot_after_approval');
    assert.equal(healthy.preconditions.successor.degraded, false);
    assert.equal(healthy.preconditions.successor.hasBom, false);
    assert.equal(healthy.preconditions.workspace.rootRelativePath, rootRelativePath);
    await client.query('UPDATE collaboration_yjs_states SET has_bom=1, serialized_hash=$2 WHERE document_id=$1',
      [currentId, hash('\ufeffCurrent snapshot')]);
    const bom = await capture('bom');
    assert.equal(bom.proposedAction, 'restore_current_snapshot_after_approval');
    assert.equal(bom.preconditions.successor.hasBom, true);
    assert.notEqual(bom.fingerprint, healthy.fingerprint);
    await client.query('UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1', [currentId]);
    assert.equal((await capture('quarantined')).proposedAction, 'manual_review');
    await client.query('UPDATE collaboration_yjs_states SET document_sequence=9007199254740993 WHERE document_id=$1', [currentId]);
    const unsafeOutput = path.join(process.env.DATA, 'capture-unsafe');
    await assert.rejects(run(process.execPath, ['--import', 'tsx', '--conditions', 'react-server',
      path.resolve('scripts/collaboration-recovery-dry-run.ts'), '--output', unsafeOutput], {
      env: { ...process.env, CANVAS_ENV_FILE: '' }, timeout: 60_000, maxBuffer: 1024 * 1024,
    }));
    await assert.rejects(fs.stat(path.join(unsafeOutput, 'manifest.json')), { code: 'ENOENT' });
    console.log('Standalone recovery CLI: raw PostgreSQL flags, BOM, quarantine, exact fingerprints, immutable evidence and unsafe-integer rejection passed.');
  } finally {
    for (const doc of documents) doc.destroy();
    await client.end();
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.name + ': ' + error.message : 'Recovery CLI test failed'); process.exitCode = 1; });

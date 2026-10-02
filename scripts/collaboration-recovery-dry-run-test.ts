import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as Y from 'yjs';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { authoritativeCollaborationSnapshot } from '../app/lib/collaboration/checkpoint';
import { serializeCanonicalText } from '../app/lib/collaboration/persistence';
import { planCollaborationRecovery, recoveryHash } from '../app/lib/collaboration/recovery-plan';
import * as recoveryEvidence from '../app/lib/collaboration/recovery-evidence';

async function main() {
  const db = await createPiTestDatabase(); const connection = await db.openDb();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-recovery-'));
  const root = path.join(directory, 'files'); await fs.mkdir(root);
  const queries: string[] = []; const logs: string[] = [];
  const documents: Y.Doc[] = [];
  const filename = path.resolve('scripts/collaboration-recovery-dry-run.ts');
  const source = (await fs.readFile(filename, 'utf8')).split('\nmain().catch')[0] + '\nexport { main };';
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const exports = {} as { main: () => Promise<void> }; const require = createRequire(filename);
  const processFixture = { argv: ['', '', '--output', path.join(directory, 'capture-1')],
    env: { DATA: directory, DATABASE_URL: 'postgres://test-only/no-real-connection' } };
  class TestClient {
    connect = async () => {};
    end = async () => {};
    async query(sql: string, parameters: unknown[] = []) {
      assert.match(sql, /^(BEGIN.*READ ONLY|SET LOCAL|SELECT|COMMIT|ROLLBACK)/u, 'capture cannot mutate PostgreSQL');
      queries.push(sql);
      const rows = await connection.all(sql, parameters) as Array<Record<string, unknown>>;
      return { rows: rows.map((row) => ({ ...row,
        ...(row.yjs_state ? { yjs_state: Buffer.from(row.yjs_state as Uint8Array) } : {}),
        ...(row.state_vector ? { state_vector: Buffer.from(row.state_vector as Uint8Array) } : {}),
        ...('degraded' in row ? { degraded: String(row.degraded) } : {}),
        ...('has_bom' in row ? { has_bom: String(row.has_bom) } : {}),
      })) };
    }
  }
  new Function('require', 'module', 'exports', 'process', 'console', compiled)((name: string) => {
    const mocks: Record<string, unknown> = {
      pg: { Client: TestClient }, '../app/lib/collaboration/checkpoint': { authoritativeCollaborationSnapshot },
      '../app/lib/collaboration/persistence': { serializeCanonicalText },
      '../app/lib/workspaces/contracts': { workspaceAbsoluteRoot: () => root },
      '../app/lib/collaboration/recovery-plan': { planCollaborationRecovery, recoveryHash },
      '../app/lib/collaboration/recovery-evidence': { ...recoveryEvidence,
        observeRecoveryFile: (relativeRoot: string, filePath: string) => recoveryEvidence.observeRecoveryFile(relativeRoot, filePath, () => root) },
    };
    return name in mocks ? mocks[name] : require(name);
  }, { exports }, exports, processFixture, { log: (value: string) => logs.push(value) });
  try {
    await connection.run(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
      VALUES ('owner','Owner','recovery@example.test',0,1,1)`);
    await connection.run(`INSERT INTO canvas_organization_settings (organization_id,owner_user_id,created_at,updated_at)
      VALUES ('org','owner',1,1)`);
    await connection.run(`INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at)
      VALUES ('ws','org','team','files','Recovery','active',1,1)`);
    for (const [id, text] of [['old', 'Historical private text'], ['current', 'Current private text']]) {
      const doc = new Y.Doc(); documents.push(doc); doc.getText('content').insert(0, text);
      await connection.run(`INSERT INTO collaboration_yjs_states
        (document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,yjs_state,state_vector,
        document_sequence,checkpoint_sequence,persisted_at,canonical_hash,serialized_hash)
        VALUES ($1,'ws','org','note.txt','plain_text',1,1,$2,$3,5,5,1,$4,$4)`,
      [id, Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc), recoveryHash(text)]);
    }
    await connection.run(`INSERT INTO collaboration_documents
      (id,workspace_id,organization_id,workspace_type,path,provider,snapshot_revision_id,status,created_at,updated_at)
      VALUES ('current','ws','org','team','note.txt','yjs','revision','active',1,1)`);
    await fs.writeFile(path.join(root, 'note.txt'), 'Historical private text');
    await exports.main();
    const capture = processFixture.argv[3];
    const plan = JSON.parse(await fs.readFile(path.join(capture, 'plan.json'), 'utf8'));
    assert.equal(plan.cases.length, 1); assert.equal(plan.cases[0].proposedAction, 'restore_current_snapshot_after_approval');
    assert.equal(plan.cases[0].preconditions.successor.degraded, false, 'raw PostgreSQL zero is not quarantine');
    for (const state of [plan.cases[0].preconditions.orphan, plan.cases[0].preconditions.successor]) {
      assert.equal(state.representation, 'plain_text');
      assert.equal(state.schemaVersion, 1);
      assert.equal(state.newlineStyle, 'lf');
      assert.equal(state.hasBom, false, 'raw PostgreSQL zero does not add a BOM');
    }
    assert.equal(plan.cases[0].preconditions.workspace.rootRelativePath, 'files');
    const manifest = JSON.parse(await fs.readFile(path.join(capture, 'manifest.json'), 'utf8'));
    for (const [name, hash] of Object.entries(manifest.artifacts)) {
      assert.equal(recoveryHash(await fs.readFile(path.join(capture, name))), hash);
      assert.equal((await fs.stat(path.join(capture, name))).mode & 0o777, 0o600);
    }
    assert.equal((await fs.stat(capture)).mode & 0o777, 0o700);
    const backup = JSON.parse(await fs.readFile(path.join(capture, 'postgres-evidence.json'), 'utf8'));
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(Buffer.from(backup.states.find((row: { document_id: string }) => row.document_id === ['old', 'current'][i]).yjs_state.bytes, 'base64'),
        Buffer.from(Y.encodeStateAsUpdate(documents[i])), 'original binary state remains recoverable');
    }
    await assert.rejects(exports.main(), { code: 'EEXIST' });
    processFixture.argv[3] = path.join(directory, 'capture-2'); await exports.main();
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(processFixture.argv[3], 'plan.json'), 'utf8')), plan);
    assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'Historical private text');
    assert(logs.every((item) => !item.includes('private text') && !item.includes('note.txt') && !item.includes('postgres://')));
    assert(queries.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
    console.log('Recovery capture: real PostgreSQL SQL, read-only transaction, original bytes, artifact hashes, private permissions and stable rerun passed.');
  } finally {
    for (const doc of documents) doc.destroy();
    await db.close(); await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

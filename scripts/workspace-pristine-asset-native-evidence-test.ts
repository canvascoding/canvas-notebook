import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import * as Y from 'yjs';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { COLLABORATION_SCHEMA_VERSION } from '../app/lib/collaboration/types';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import { captureWorkspaceOperationNativeSourceEvidence, assertWorkspaceOperationNativeSourceEvidenceCurrent,
  WorkspaceOperationNativeSourceEvidenceError } from '../app/lib/files/workspace-operation-native-source-evidence';
import { createWorkspaceOperationNativeDeleteBatchPlan } from '../app/lib/files/workspace-operation-native-delete-plan';
import { readWorkspaceLinkSourceAuthorityOnConnection } from '../app/lib/markdown/workspace-source-authority-stage';

// Genuine embedded SQL, FS and Yjs exercise the actual collector and downstream
// evidence/compiler. These minimal declared tables are not production DDL,
// PostgreSQL admission/row locks, a current principal, or mutation authority.
test('registered pristine assets coexist with native Delete evidence', async t => {
  await runPristineAssetNativeEvidenceRegression(t);
});

async function runPristineAssetNativeEvidenceRegression(t: TestContext) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pristine-native-evidence-'));
  const rootRelativePath = 'users/fixture/workspace', rootPath = path.join(temporary, rootRelativePath);
  const workspace: WorkspaceContext = { workspaceId: `asset-evidence-${randomUUID()}`, rootPath, rootRelativePath,
    workspaceType: 'personal', organizationId: null, ownerUserId: 'fixture-user', legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canManageWorkspace: true,
      canCreatePublicLinks: false, canRunAgent: true } };
  const scope = captureWorkspaceOperationJobScope(workspace);
  const sql = new PGlite();
  const statements: string[] = [];
  let closes = 0;
  const query = async (statement: string, values: unknown[] = []) => {
    statements.push(statement); return sql.query<Record<string, unknown>>(statement, values);
  };
  const database: SqlConnection = {
    get: async (statement, values) => (await query(statement, values)).rows[0],
    all: async (statement, values) => (await query(statement, values)).rows,
    run: async (statement, values) => ({ changes: (await query(statement, values)).affectedRows ?? 0 }),
    close: async () => { closes++; assert.fail('The collector cannot close its caller connection.'); },
  };
  const nativePath = 'empty.md';
  const actions = [{ reviewId: 'native-delete', kind: 'delete' as const, selections: [{ sourcePath: nativePath }] }];
  const read = () => readWorkspaceLinkSourceAuthorityOnConnection(database, workspace);
  const build = (observation: Awaited<ReturnType<typeof read>>) => createWorkspaceOperationNativeDeleteBatchPlan({
    scope: { workspace, fileOptions: { workspace } }, actions, observation });
  const seedRegistry = async (filePath: string, initialized = false, sequence = 0) => {
    const documentId = `document-${randomUUID()}`, lineageId = `lineage-${randomUUID()}`;
    await sql.query("INSERT INTO file_collaboration_lineages VALUES($1,$2,'personal',NULL,NULL,NULL,$3,'active',NULL,NULL)",
      [lineageId, workspace.workspaceId, filePath]);
    await sql.query(`INSERT INTO collaboration_documents VALUES($1,$2,$3,'personal',NULL,NULL,NULL,$4,'yjs','active',$5,$6)`,
      [documentId, lineageId, workspace.workspaceId, filePath, sequence, initialized ? 'initialized' : 'never_initialized']);
    return documentId;
  };
  const seedNative = async (filePath: string, representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks', text: string, sequence: number) => {
    const documentId = await seedRegistry(filePath, true, sequence);
    const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
    try {
      await sql.query(`INSERT INTO collaboration_yjs_states VALUES($1,$2,NULL,$3,$4,1,$5,'active',$6,$7,$8,100,0,NULL,NULL,NULL,
        'lf',0,0,NULL,NULL,NULL,NULL,0)`, [documentId, workspace.workspaceId, filePath, representation,
        COLLABORATION_SCHEMA_VERSION, Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc), sequence]);
    } finally { doc.destroy(); }
    await fs.writeFile(path.join(rootPath, filePath), text);
  };
  const reset = async (representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks' = 'tiptap_blocks') => {
    await sql.exec('TRUNCATE collaboration_documents,collaboration_yjs_states,file_collaboration_lineages');
    await fs.rm(rootPath, { recursive: true, force: true }); await fs.mkdir(rootPath, { recursive: true });
    await seedNative(nativePath, representation, '', 0);
    await seedNative('Erste Schritte.md', 'tiptap_blocks', '# Willkommen', 1);
    statements.length = 0;
  };
  let primary: unknown, failed = false;
  try {
    await sql.exec(`CREATE TABLE file_collaboration_lineages(id text PRIMARY KEY,workspace_id text,workspace_type text,
      organization_id text,customer_id text,project_id text,path text,status text,archived_at bigint,trash_entry_id text);
      CREATE TABLE collaboration_documents(id text PRIMARY KEY,lineage_id text,workspace_id text,workspace_type text,
      organization_id text,customer_id text,project_id text,path text,provider text,status text,state_version bigint,yjs_state_lifecycle text);
      CREATE TABLE collaboration_yjs_states(document_id text PRIMARY KEY,workspace_id text,organization_id text,path text,
      representation text,lifecycle_generation bigint,schema_version bigint,status text,yjs_state bytea,state_vector bytea,
      document_sequence bigint,persisted_at bigint,checkpoint_sequence bigint,checkpointed_at bigint,canonical_hash text,serialized_hash text,
      newline_style text,has_bom bigint,degraded bigint,projection_error_code text,projection_error_sequence bigint,
      projection_error_generation bigint,projection_error_phase text,projection_error_permanent bigint);
      CREATE TABLE collaboration_yjs_state_backups(document_id text); CREATE TABLE collaboration_agent_operations(document_id text);`);
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
      await t.test(`empty initialized ${representation} sequence zero remains a valid native target`, async () => {
        await reset(representation);
        const observation = await read(); assert.equal(observation.stage.coverage.complete, true);
        const plan = build(observation); assert.equal(plan.version, 2); assert.equal(plan.readiness, 'ready');
        assert.equal(plan.nativeTarget.documentSequence, 0); assert.equal(plan.nativeTarget.lifecycleGeneration, 1);
        assert.equal(plan.nativeTarget.path, nativePath); assert.equal(plan.nativeGraphPlan.steps[0].linkIntents.length, 0);
      });
    }
    for (const filePath of ['empty.txt', 'image.png', 'ordinary.asset']) {
      await t.test(`registered pristine ${filePath} retains disk authority beside native sources`, async () => {
        await reset(); await seedRegistry(filePath);
        const bytes = filePath.endsWith('.txt') ? Buffer.alloc(0) : Buffer.from([0, 255, 17, 35]);
        await fs.writeFile(path.join(rootPath, filePath), bytes);
        const observation = await read(); assert.equal(observation.stage.coverage.complete, true);
        assert.equal(observation.nativeBindings.length, 2); assert.equal(observation.privateNativeStates.length, 2);
        const evidence = captureWorkspaceOperationNativeSourceEvidence(scope, observation);
        assert.equal(evidence.stage.sources.length, 2, 'A pristine asset is not a fabricated native source.');
        assert.equal(evidence.nativeBindings.some(binding => binding.expected.path === filePath), false);
        assert(evidence.stage.namespace.find(entry => entry.path === filePath)?.filesystemIdentity);
        const plan = build(observation); assert.equal(plan.version, 2); assert.equal(plan.readiness, 'ready');
        assert.equal(plan.nativeTarget.path, nativePath); assert.equal(plan.nativeGraphPlan.steps[0].linkIntents.length, 0);
        assert.deepEqual(await fs.readFile(path.join(rootPath, filePath)), bytes);
      });
    }
    await t.test('replacing a pristine asset with identical bytes changes its physical pin and conflicts', async () => {
      await reset(); await seedRegistry('asset.txt'); await fs.writeFile(path.join(rootPath, 'asset.txt'), 'same bytes');
      const original = captureWorkspaceOperationNativeSourceEvidence(scope, await read());
      const named = path.join(rootPath, 'asset.txt'), held = await fs.open(named, 'r');
      try {
        const before = await held.stat(); await fs.unlink(named); await fs.writeFile(named, 'same bytes');
        assert.notEqual((await fs.stat(named)).ino, before.ino, 'The held original inode prevents accidental inode reuse.');
        const observation = await read(); assert.equal(observation.stage.coverage.complete, true);
        const current = captureWorkspaceOperationNativeSourceEvidence(scope, observation);
        assert.notEqual(current.semanticProof, original.semanticProof, 'Pristine asset pins cannot be ignored as native projections.');
        assert.throws(() => assertWorkspaceOperationNativeSourceEvidenceCurrent(original, observation, scope),
          error => error instanceof WorkspaceOperationNativeSourceEvidenceError && error.code === 'NATIVE_SOURCE_EVIDENCE_CHANGED');
      } finally { await held.close(); }
    });
    await t.test('a registered pristine asset without its physical source blocks complete native evidence', async () => {
      await reset(); await seedRegistry('missing.txt');
      const observation = await read(); assert.equal(observation.stage.coverage.complete, false);
      assert.throws(() => captureWorkspaceOperationNativeSourceEvidence(scope, observation), WorkspaceOperationNativeSourceEvidenceError);
      assert.throws(() => build(observation));
    });
    await t.test('a physical registered pristine Markdown source still requires import and rebinding', async () => {
      await reset(); await seedRegistry('pristine.md'); await fs.writeFile(path.join(rootPath, 'pristine.md'), '# Original Markdown');
      const observation = await read(); assert.equal(observation.stage.coverage.complete, true);
      assert(observation.stage.sources.some(source => source.kind === 'physical'));
      assert.throws(() => captureWorkspaceOperationNativeSourceEvidence(scope, observation),
        error => error instanceof WorkspaceOperationNativeSourceEvidenceError && error.code === 'NATIVE_SOURCE_IMPORT_REQUIRED');
      assert.throws(() => build(observation),
        error => error instanceof WorkspaceOperationNativeSourceEvidenceError && error.code === 'NATIVE_SOURCE_IMPORT_REQUIRED');
    });
    assert.equal(closes, 0);
    assert(statements.every(statement => /^\s*(?:SELECT\b|WITH expected AS MATERIALIZED \()/u.test(statement)),
      'The borrowed collector must issue reads only, without transaction, lifecycle or authority operations.');
    await sql.query('SELECT 1 AS caller_connection_still_usable');
  } catch (error) { primary = error; failed = true; }
  finally {
    const cleanup: unknown[] = [];
    try { await sql.close(); } catch (error) { cleanup.push(error); }
    try { await fs.rm(temporary, { recursive: true, force: true }); } catch (error) { cleanup.push(error); }
    if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'Pristine asset fixture cleanup failed.');
  }
  if (failed) throw primary;
}

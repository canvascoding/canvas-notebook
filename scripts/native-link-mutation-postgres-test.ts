import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, Pool } from 'pg';
import { getSchema } from '@tiptap/core';
import type { SqlConnection } from '../app/lib/db';
import { runNativeLinkMutationReceiptMigration } from '../app/lib/db/native-link-mutation-migration';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { loadCollaborationStateOnConnection, type PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { lockIdentity } from '../app/lib/collaboration/room-owner';
import { Y } from '../app/lib/collaboration/server-runtime';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { prepareNativeLinkMutations } from '../app/lib/markdown/workspace-native-link-mutations';
import { nativeLinkPreparedIntentProof, persistPreparedNativeLinkMutation, type NativeLinkMutationBinding } from '../app/lib/markdown/native-link-mutation-persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const schemaPattern = /^canvas_native_link_test_[a-f0-9]{32}$/u;
let stage = 'private local environment';

async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  const envPath = process.env.CANVAS_NATIVE_LINK_TEST_ENV_FILE;
  assert(envPath, 'An explicit private local environment file is required.');
  assert.equal((await stat(envPath)).mode & 0o077, 0, 'The local environment must be private.');
  const connectionString = parse(await readFile(envPath)).DATABASE_URL;
  assert(connectionString, 'Local PostgreSQL is not configured.');
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new Error('Invalid private local database configuration.'); }
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['127.0.0.1','localhost'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `canvas_native_link_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, schemaPattern);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5_000, options: '-c statement_timeout=10000' });
  let pool: Pool | undefined, created = false;
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'canvas-native-link-sql-'));
  const previousData = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = temporaryRoot;
  try {
    await control.connect();
    const server = (await control.query(`SELECT current_database() AS name,current_setting('server_version_num')::integer AS version,
      to_regclass('public.collaboration_yjs_states') IS NOT NULL AS states`)).rows[0];
    assert.equal(server.name, 'canvas_notebook'); assert.equal(Math.floor(server.version / 10_000), 18); assert.equal(server.states, true);
    stage = 'isolated generated schema';
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    for (const table of ['collaboration_documents','collaboration_yjs_states','collaboration_agent_operations',
      'collaboration_admission_requests','collaboration_admission_scopes']) {
      await control.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=4000 -c application_name=canvas-native-link-test` });
    assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema);
    const plainConnection: SqlConnection = {
      get: async (sql, args) => (await pool!.query(sql, args)).rows[0],
      all: async (sql, args) => (await pool!.query(sql, args)).rows,
      run: async (sql, args) => ({ changes: (await pool!.query(sql, args)).rowCount ?? 0 }), close: () => undefined,
    };
    await runNativeLinkMutationReceiptMigration(plainConnection);
    await runNativeLinkMutationReceiptMigration(plainConnection);
    const workspace: WorkspaceContext = { workspaceId: `native-link-${randomUUID()}`, workspaceType: 'personal', rootPath: temporaryRoot,
      organizationId: null, ownerUserId: 'owner', legacy: false, status: 'active',
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
    type Fault = { kind: 'before' | 'after' | 'after-peer' | 'after-missing-receipt'; documentId: string };
    let fault: Fault | null = null, discardedCommits = 0;
    const peerEdit = async (documentId: string, changeTarget = false) => {
      const state = (await loadCollaborationStateOnConnection(plainConnection, documentId))!;
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, state.yjsState);
        if (changeTarget) {
          const text = doc.getText('content'), offset = text.toString().indexOf('renamed.md');
          assert(offset >= 0); text.delete(offset, 'renamed.md'.length); text.insert(offset, 'user-choice.md');
        } else doc.getText('content').insert(doc.getText('content').length, '\n\nLater independent peer edit.');
        await pool!.query(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,
          document_sequence=document_sequence+1,persisted_at=persisted_at+1 WHERE document_id=$3`,
        [Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc)), documentId]);
      } finally { doc.destroy(); }
    };
    const openConnection = async (): Promise<SqlConnection> => {
      const client = await pool!.connect(); client.on('error', () => undefined);
      let wroteReceipt = false, released = false;
      return {
        get: async (sql, args) => {
          const result = await client.query(sql, args);
          if (sql.startsWith('INSERT INTO collaboration_native_link_mutation_receipts')) wroteReceipt = true;
          return result.rows[0];
        },
        all: async (sql, args) => (await client.query(sql, args)).rows,
        run: async (sql, args) => {
          if (sql === 'COMMIT' && wroteReceipt && fault) {
            const current = fault; fault = null;
            if (current.kind === 'before') await client.query('ROLLBACK'); else await client.query('COMMIT');
            if (current.kind === 'after-peer') await peerEdit(current.documentId);
            if (current.kind === 'after-missing-receipt') {
              // Deliberately corrupt only this owned fixture to prove that after-state alone is insufficient.
              await pool!.query('ALTER TABLE collaboration_native_link_mutation_receipts DISABLE TRIGGER native_link_mutation_receipt_scope');
              await pool!.query('DELETE FROM collaboration_native_link_mutation_receipts WHERE document_id=$1', [current.documentId]);
              await pool!.query('ALTER TABLE collaboration_native_link_mutation_receipts ENABLE TRIGGER native_link_mutation_receipt_scope');
            }
            throw new Error('Injected uncertain native link commit reply.');
          }
          return { changes: (await client.query(sql, args)).rowCount ?? 0 };
        },
        close: error => { assert.equal(released, false); released = true; if (error && wroteReceipt) discardedCommits++; client.release(error); },
      };
    };
    const fixture = async (name: string, rich = false, content = '[Link](target.md)\n\nIndependent paragraph.') => {
      const documentId = `native-${randomUUID()}`, filePath = `${name}.md`;
      const doc = rich ? createRichMarkdownYDoc('| Keep |\n| --- |\n| [Link](target.md) |', 'tiptap_blocks') : new Y.Doc();
      let state: PersistedCollaborationState;
      try {
        if (rich) {
          const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
          for (const record of tree.records.values()) if (['tableCell','tableHeader'].includes((record.get('shape') as { type: string }).type)) {
            (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth', [120]);
          }
          assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
        } else doc.getText('content').insert(0, content);
        state = { documentId, workspaceId: workspace.workspaceId, organizationId: null, path: filePath,
          representation: rich ? 'tiptap_blocks' : 'plain_text', lifecycleGeneration: 1, schemaVersion: 1,
          yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 7, persistedAt: 1,
          checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
      } finally { doc.destroy(); }
      await pool!.query(`INSERT INTO collaboration_documents(id,workspace_id,workspace_type,organization_id,path,provider,state_version,
        yjs_state_lifecycle,status,created_at,updated_at) VALUES($1,$2,'personal',NULL,$3,'yjs',0,'initialized','active',1,1)`, [documentId, workspace.workspaceId, filePath]);
      await pool!.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,newline_style,has_bom,degraded,status)
        VALUES($1,$2,NULL,$3,$4,1,1,$5,$6,7,1,0,'lf',0,0,'active')`,
      [documentId, workspace.workspaceId, filePath, state.representation, Buffer.from(state.yjsState), Buffer.from(state.stateVector)]);
      const inventory = inspectPersistedDocumentLinks(state), link = inventory.links[0];
      const prepared = prepareNativeLinkMutations({ state, operationId: `operation-${randomUUID()}`, recipes: [{ linkId: link.id,
        source: inventory.document, sourceVersion: inventory.version, destinationWorkspaceId: workspace.workspaceId, sourcePathAfter: filePath,
        cloneSelection: null, reference: link.ref, action: 'rewrite', nextValue: 'renamed.md', expectedTargetIdentity: 'fixture-target' }] });
      const binding: NativeLinkMutationBinding = { actorUserId: 'owner', actorId: 'agent', actorType: 'agent', actorSessionId: 'session',
        requestId: `request-${randomUUID()}`, requestHash: nativeLinkJsonProof({ name, target: 'renamed.md' }), authorizedPreparedProof: nativeLinkPreparedIntentProof(prepared) };
      return { workspace, prepared, binding, validateAuthority: async () => { assert(workspace.permissions.canWrite); } };
    };
    const count = async (documentId: string) => Number((await pool!.query(
      'SELECT count(*) AS count FROM collaboration_native_link_mutation_receipts WHERE document_id=$1', [documentId])).rows[0].count);
    const current = async (documentId: string) => (await loadCollaborationStateOnConnection(plainConnection, documentId))!;
    const persist = (value: Awaited<ReturnType<typeof fixture>>) => persistPreparedNativeLinkMutation(value, { openConnection });

    stage = 'atomic native mutation and exact retry';
    const first = await fixture('first');
    const applied = await persist(first);
    assert.equal(applied.disposition, 'applied'); assert.equal(applied.receipt.after.documentSequence, 8); assert.equal(await count(first.prepared.source.documentId), 1);
    assert.equal(inspectPersistedDocumentLinks(await current(first.prepared.source.documentId)).links[0].literal, 'renamed.md');
    const retry = await persist(first); assert.equal(retry.disposition, 'already-applied'); assert.equal(retry.receipt.after.documentSequence, 8);
    await peerEdit(first.prepared.source.documentId);
    const historical = await persist(first);
    assert.equal(historical.receipt.after.documentSequence, 8); assert.equal(historical.currentObservation.documentSequence, 9);
    assert.notEqual(historical.currentObservation.stateProof, historical.receipt.after.stateProof); assert.equal(await count(first.prepared.source.documentId), 1);
    for (const change of [{ actorUserId: 'other' }, { actorId: 'other' }, { actorType: 'user' as const },
      { actorSessionId: null }, { requestId: 'different' }, { requestHash: 'a'.repeat(64) }]) {
      await assert.rejects(persist({ ...first, binding: { ...first.binding, ...change } }), { code: 'NATIVE_LINK_REQUEST_CONFLICT' });
    }
    await assert.rejects(pool.query("UPDATE collaboration_native_link_mutation_receipts SET actor_session_id='other'"), { code: '55000' });
    await peerEdit(first.prepared.source.documentId, true);
    const targetChanged = await persist(first);
    assert.equal(targetChanged.receipt.after.documentSequence, 8); assert.equal(targetChanged.currentObservation.documentSequence, 10);
    assert.equal(inspectPersistedDocumentLinks(await current(first.prepared.source.documentId)).links[0].literal, 'user-choice.md',
      'historical retry must never replay over a later peer target; the coordinator separately checks current graph effect');

    stage = 'deletion-only proof and durable sequence';
    const deletion = await fixture('deletion-only', false, '![](target.md)\n\nIndependent paragraph.');
    const deletionState = await current(deletion.prepared.source.documentId), deletionInventory = inspectPersistedDocumentLinks(deletionState);
    deletion.prepared = prepareNativeLinkMutations({ state: deletionState, operationId: deletion.prepared.operationId,
      recipes: [{ linkId: deletionInventory.links[0].id, source: deletionInventory.document, sourceVersion: deletionInventory.version,
        destinationWorkspaceId: workspace.workspaceId, sourcePathAfter: deletionState.path, cloneSelection: null,
        reference: deletionInventory.links[0].ref, action: 'unlink', nextValue: null, expectedTargetIdentity: 'fixture-target' }] });
    deletion.binding.requestHash = nativeLinkJsonProof({ name: 'deletion-only', action: 'unlink' });
    deletion.binding.authorizedPreparedProof = nativeLinkPreparedIntentProof(deletion.prepared);
    assert.equal(deletion.prepared.after.stateVector, deletion.prepared.before.stateVector);
    assert.notEqual(deletion.prepared.after.stateProof, deletion.prepared.before.stateProof);
    const deleted = await persist(deletion); assert.equal(deleted.receipt.after.documentSequence, 8);
    await peerEdit(deletion.prepared.source.documentId);
    assert.equal((await persist(deletion)).receipt.after.documentSequence, 8);

    stage = 'concurrent session commits';
    const race = await fixture('race');
    const races = await Promise.all([persist(race), persist(race)]);
    assert.deepEqual(races.map(value => value.disposition).sort(), ['already-applied','applied']); assert.equal((await current(race.prepared.source.documentId)).documentSequence, 8);
    await assert.rejects(pool.query(`INSERT INTO collaboration_native_link_mutation_receipts
      SELECT changed.* FROM collaboration_native_link_mutation_receipts original,
        LATERAL jsonb_populate_record(NULL::collaboration_native_link_mutation_receipts,
          to_jsonb(original)||jsonb_build_object('operation_id','forged','request_id','forged','path','wrong.md')) changed
      WHERE original.operation_id=$1`, [race.prepared.operationId]), { code: '23514' });

    stage = 'authority and receipt failure roll back state';
    const revoked = await fixture('authority-revoked'); let authorityChecks = 0;
    await assert.rejects(persist({ ...revoked, validateAuthority: async () => {
      if (++authorityChecks === 2) throw Object.assign(new Error('Current authority revoked.'), { status: 403 });
    } }), { status: 403 });
    assert.equal((await current(revoked.prepared.source.documentId)).documentSequence, 7); assert.equal(await count(revoked.prepared.source.documentId), 0);
    const rejectedReceipt = await fixture('receipt-rejected');
    await pool.query(`CREATE FUNCTION reject_fixture_native_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.operation_id='${rejectedReceipt.prepared.operationId}' THEN RAISE EXCEPTION 'Fixture rejects receipt' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER reject_fixture_receipt BEFORE INSERT ON collaboration_native_link_mutation_receipts FOR EACH ROW EXECUTE FUNCTION reject_fixture_native_receipt()');
    await assert.rejects(persist(rejectedReceipt), { code: '23514' });
    assert.equal((await current(rejectedReceipt.prepared.source.documentId)).documentSequence, 7); assert.equal(await count(rejectedReceipt.prepared.source.documentId), 0);
    await pool.query('DROP TRIGGER reject_fixture_receipt ON collaboration_native_link_mutation_receipts');

    stage = 'scope and exact-before conflicts';
    for (const mutation of ['sequence','generation','path','organization'] as const) {
      const value = await fixture(`conflict-${mutation}`), id = value.prepared.source.documentId;
      if (mutation === 'sequence') await peerEdit(id);
      if (mutation === 'generation') await pool.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1', [id]);
      if (mutation === 'path') {
        await pool.query("UPDATE collaboration_documents SET path='moved.md' WHERE id=$1", [id]);
        await pool.query("UPDATE collaboration_yjs_states SET path='moved.md' WHERE document_id=$1", [id]);
      }
      if (mutation === 'organization') {
        await pool.query("UPDATE collaboration_documents SET organization_id='other' WHERE id=$1", [id]);
        await pool.query("UPDATE collaboration_yjs_states SET organization_id='other' WHERE document_id=$1", [id]);
      }
      await assert.rejects(persist(value), { code: 'NATIVE_LINK_SOURCE_CHANGED' }); assert.equal(await count(id), 0);
    }
    const invalid = await fixture('invalid-after');
    invalid.prepared.after.stateProof = `yjs-snapshot-sha256-v1:${'f'.repeat(64)}`;
    invalid.binding.authorizedPreparedProof = nativeLinkPreparedIntentProof(invalid.prepared);
    await assert.rejects(persist(invalid), { code: 'NATIVE_LINK_INVALID_PREPARED' }); assert.equal((await current(invalid.prepared.source.documentId)).documentSequence, 7);
    const trailing = await fixture('trailing-delta'); trailing.prepared.update = Buffer.concat([trailing.prepared.update, Buffer.from([0])]);
    trailing.binding.authorizedPreparedProof = nativeLinkPreparedIntentProof(trailing.prepared);
    await assert.rejects(persist(trailing), { code: 'NATIVE_LINK_INVALID_PREPARED' }); assert.equal(await count(trailing.prepared.source.documentId), 0);

    stage = 'foreign agent and actual room advisory owner';
    const busy = await fixture('busy');
    await pool.query(`INSERT INTO collaboration_agent_operations(operation_id,document_id,workspace_id,initiated_by_user_id,actor_id,idempotency_key,
      payload_hash,status,base_state_vector,created_at,updated_at) VALUES('foreign',$1,$2,'owner','other','other','hash','applying',$3,1,1)`,
    [busy.prepared.source.documentId, workspace.workspaceId, Buffer.from([])]);
    await assert.rejects(persist(busy), { code: 'NATIVE_LINK_MUTATION_BUSY' }); assert.equal(await count(busy.prepared.source.documentId), 0);
    await pool.query("DELETE FROM collaboration_agent_operations WHERE operation_id='foreign'");
    const owner = await pool.connect(), key = lockIdentity(busy.prepared.source.documentId);
    try {
      await owner.query('SELECT pg_advisory_lock($1::bigint)', [key.key]);
      await assert.rejects(persist(busy), { code: 'COLLABORATION_FILE_LIFECYCLE_BUSY' });
    } finally { await owner.query('SELECT pg_advisory_unlock($1::bigint)', [key.key]); owner.release(); }

    stage = 'unconfirmed commits and later peer edits';
    for (const kind of ['before','after','after-peer','after-missing-receipt'] as const) {
      const value = await fixture(`commit-${kind}`), id = value.prepared.source.documentId;
      fault = { kind, documentId: id };
      if (kind === 'before' || kind === 'after-missing-receipt') {
        await assert.rejects(persist(value), { code: 'NATIVE_LINK_COMMIT_UNCONFIRMED' });
        assert.equal(await count(id), 0);
        assert.equal((await current(id)).documentSequence, kind === 'before' ? 7 : 8);
        if (kind === 'before') { assert.equal((await persist(value)).disposition, 'applied'); assert.equal((await current(id)).documentSequence, 8); }
        else { await assert.rejects(persist(value), { code: 'NATIVE_LINK_SOURCE_CHANGED' }); assert.equal((await current(id)).documentSequence, 8); }
      } else {
        const recovered = await persist(value); assert.equal(recovered.disposition, 'commit-recovered');
        assert.equal(recovered.receipt.after.documentSequence, 8); assert.equal(recovered.currentObservation.documentSequence, kind === 'after-peer' ? 9 : 8);
        assert.equal(await count(id), 1);
      }
    }
    assert.equal(discardedCommits, 4, 'every uncertain mutation COMMIT must discard its original connection');

    stage = 'schema-valid export failure remains native';
    const rich = await fixture('export-failure', true), richResult = await persist(rich);
    assert.equal(richResult.receipt.after.documentSequence, 8);
    const richInventory = inspectPersistedDocumentLinks(await current(rich.prepared.source.documentId));
    assert.equal(richInventory.coverage.complete, true); assert.equal(richInventory.links[0].literal, 'renamed.md');
    assert.equal((await current(rich.prepared.source.documentId)).checkpointSequence, 0);
    console.log('Native PostgreSQL 18 link persistence passed: atomic receipts, actor/session binding, concurrent exact retry, scope CAS, foreign writers, lost COMMIT with peer edits, missing-receipt refusal and export-failure independence.');
  } finally {
    if (previousData === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = previousData;
    await pool?.end();
    if (created) { assert.match(schema, schemaPattern); await control.query(`DROP SCHEMA "${schema}" CASCADE`); }
    await control.end(); await rm(temporaryRoot, { recursive: true, force: true });
  }
}

void main().catch(error => {
  // Never print private connection settings or PostgreSQL parameter payloads.
  console.error(`Native link PostgreSQL test failed at ${stage}: ${error instanceof Error ? error.name : 'unknown error'}; code=${String((error as { code?: unknown })?.code ?? 'unavailable')}`);
  process.exitCode = 1;
});

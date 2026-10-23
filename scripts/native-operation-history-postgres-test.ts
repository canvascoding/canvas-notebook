import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { DocumentVersionIdentityV1 } from '../app/lib/documents/read-version';
import type { NativeDocumentEditAuthorityOrigin } from '../app/lib/documents/edit-principal';
import type { NativeAgentOperationHistoryCaptureInput } from '../app/lib/file-version-center/native-operation-history';
import type { FileVersionCenterTransaction } from '../app/lib/file-version-center/database';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Actual PG history/immutable-content tests on the existing owned fixture.
// Operation/After/payload SQL below is explicit test-data arrangement, NOT an
// invocation of the NativeEdit Owner, a room apply or a durability/auth proof.
// Current origins come from genuine principals; no SQL result/auth substitution.
type Fixture = Parameters<Parameters<typeof withDocumentReadToolDispatchFixture>[0]>[0];
type Representation = DocumentVersionIdentityV1['representation'];
type Facts = { workspace: WorkspaceContext; origin: NativeDocumentEditAuthorityOrigin;
  actor: { userId: string; actorType: 'user' | 'agent'; actorId: string; sessionId: string } };
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
let currentCase = 'setup', groups = 0, completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const errorCode = (wanted: string) => (error: unknown): boolean => {
  assert.equal(error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined, wanted); return true;
};

export async function nativeOperationHistoryPostgresTest(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { admin, workspaceId } = fixture;
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { createPlainTextYDoc, validateRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { nativeTableWidthFixture } = await import('./helpers/rich-markdown-projection-fixtures');
    const { collaborationStateProof } = await import('../app/lib/collaboration/state-proof');
    const { captureAgentStateSnapshot } = await import('../app/lib/collaboration/agent-durability');
    const { inspectNativeDocument } = await import('../app/lib/collaboration/document-snapshot');
    const { prepareNativeDocumentEditInDocument, validateNativeDocumentEditCandidate } =
      await import('../app/lib/collaboration/native-document-edit-preparation');
    const { applyAgentTextTargets } = await import('../app/lib/collaboration/agent-operations');
    const { documentVersionV1 } = await import('../app/lib/documents/read-version');
    const { decodeDocumentEditPatchV1 } = await import('../app/lib/documents/edit-contracts');
    const { makeNativeDocumentEditOriginal, makeNativeDocumentEditAfter } =
      await import('../app/lib/collaboration/native-document-edit-operation-contract');
    const { prepareNativeAgentOperationHistorySnapshot: prepare, captureNativeAgentOperationHistoryOnConnection: capture } =
      await import('../app/lib/file-version-center/native-operation-history');
    const { createFileVersionContentStore } = await import('../app/lib/file-version-center/version-content-store');
    const { FILE_VERSION_CENTER_LIMITS_V1: limits } = await import('../app/lib/file-version-center/policy-v1');
    const { withNativeDocumentEditRequestAuthority: requestAuthority, withNativeDocumentEditMcpAuthority: mcpAuthority,
      withNativeDocumentEditWriteAuthorityOnConnection: onConnection } = await import('../app/lib/documents/edit-principal');
    const { NATIVE_DOCUMENT_EDIT_OPERATION_STATEMENTS } = await import('../app/lib/db/native-document-edit-operation-migration');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const pool = getPostgresRuntimeQueryable(); assert(pool);
    // Actual additive migration, no trigger/constraint removal or fake rows.
    for (const statement of NATIVE_DOCUMENT_EDIT_OPERATION_STATEMENTS) await admin.query(statement);
    process.env.FILE_VERSION_CENTER_MODE = 'shadow'; // capture only; History UI stays off.
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,search_knowledge,edit_knowledge_source';
    assert.equal((await admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=1
      WHERE organization_id='tool-dispatch-org' AND user_id='reader' AND status='active'`)).rowCount, 1);
    assert.equal((await admin.query(`UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2 AND user_id='reader'`,
      [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write']), fixture.clientId])).rowCount, 1);
    const token = await fixture.issue({ scope: 'knowledge:read knowledge:search knowledge:write' });
    let leased = 0;
    const withB = async <T>(action: (tx: FileVersionCenterTransaction, db: SqlConnection, client: PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool.connect(); leased++; let began = false, discard: Error | undefined;
      const tx: FileVersionCenterTransaction = { query: async <Row>(sql: string, params?: unknown[]) => {
        assert(!/^\s*(?:BEGIN|COMMIT|ROLLBACK(?!\s+TO\b))/iu.test(sql), 'History may only use its private savepoint on caller B.');
        const result = await client.query(sql, params); return { rows: result.rows as Row[], rowCount: result.rowCount };
      } };
      const db: SqlConnection = { get: async (sql, params) => (await client.query(sql, params)).rows[0],
        all: async (sql, params) => (await client.query(sql, params)).rows,
        run: async (sql, params) => ({ changes: (await client.query(sql, params)).rowCount ?? 0 }),
        close: () => assert.fail('History/current-principal cannot close caller-owned B.') };
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
        const result = await action(tx, db, client); await client.query('COMMIT'); began = false; return result;
      } catch (error) {
        if (began) try { await client.query('ROLLBACK'); }
        catch (rollback) { discard = new AggregateError([error, rollback], 'Owned history-test rollback failed.'); throw discard; }
        throw error;
      } finally { client.release(discard); leased--; }
    };
    const facts = async (kind: 'user' | 'agent', actualToken = token): Promise<Facts> => {
      const consume = (authority: Parameters<typeof onConnection>[1]) => withB((_tx, db) => onConnection<Facts>(db, authority, async access => {
        await access.assertCurrent(); assert.equal(access.workspace.permissions.canWrite, true);
        return { workspace: access.workspace, origin: access.origin, actor: { userId: access.userId,
          actorType: access.actorType, actorId: access.actorId, sessionId: access.sessionId } };
      }));
      if (kind === 'agent') return mcpAuthority({ token: actualToken, clientId: 'untrusted-caller', scopes: [] }, { workspaceId }, consume);
      const session = (await admin.query<{ token: string }>('SELECT token FROM "session" WHERE id=$1', ['reader-session'])).rows[0]; assert(session);
      return requestAuthority(new Request('http://localhost/api/documents/edit', { method: 'POST',
        headers: { authorization: `Bearer ${session.token}`, 'x-canvas-workspace-id': workspaceId } }), { workspaceId }, consume);
    };
    const originalA = await facts('agent'), userA = await facts('user');
    assert.equal(originalA.origin.transport, 'direct-mcp'); assert.equal(userA.origin.transport, 'request');
    const currentNative = async () => ({
      documents: (await admin.query('SELECT *,xmin::text AS row_xmin FROM collaboration_documents ORDER BY id')).rows,
      lineages: (await admin.query('SELECT *,xmin::text AS row_xmin FROM file_collaboration_lineages ORDER BY id')).rows,
      states: (await admin.query('SELECT *,xmin::text AS row_xmin FROM collaboration_yjs_states ORDER BY document_id')).rows,
      metadata: (await admin.query('SELECT *,xmin::text AS row_xmin FROM workspace_file_metadata ORDER BY workspace_id,path')).rows,
      projections: (await admin.query('SELECT *,xmin::text AS row_xmin FROM collaboration_file_projections ORDER BY document_id')).rows,
    });
    const historyRows = async () => ({
      revisions: (await admin.query('SELECT *,xmin::text AS row_xmin FROM file_revisions ORDER BY id')).rows,
      contents: (await admin.query('SELECT *,xmin::text AS row_xmin FROM file_revision_contents ORDER BY revision_id')).rows,
      blobs: (await admin.query('SELECT *,xmin::text AS row_xmin FROM file_version_blobs ORDER BY blob_id')).rows,
    });
    const operationRows = async (operationId: string) => ({
      operation: (await admin.query('SELECT *,xmin::text AS row_xmin FROM collaboration_agent_operations WHERE operation_id=$1', [operationId])).rows,
      payload: (await admin.query('SELECT *,xmin::text AS row_xmin FROM collaboration_agent_native_edit_payloads WHERE operation_id=$1', [operationId])).rows,
    });
    const stage = async (options: { representation?: Representation; facts?: Facts; edit?: boolean;
      overLimit?: boolean; corruptInitialPayload?: boolean; target?: Awaited<ReturnType<Fixture['seed']>> } = {}): Promise<NativeAgentOperationHistoryCaptureInput> => {
      const origin = options.facts ?? originalA;
      const target = options.target ?? await fixture.seed({ representation: options.representation, text: 'Target 😀 remains native.',
        nonexportable: options.representation === 'tiptap_blocks' });
      const row = (await admin.query<{ yjs_state: Uint8Array; state_vector: Uint8Array; document_sequence: string | number }>(
        'SELECT yjs_state,state_vector,document_sequence FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId])).rows[0]; assert(row);
      const doc = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(doc, row.yjs_state);
        const identity: DocumentVersionIdentityV1 = { workspaceId, organizationId: origin.workspace.organizationId ?? null,
          documentId: target.documentId, lineageId: target.lineageId, lifecycleGeneration: 1, schemaVersion: 1, representation: target.representation };
        const proof = collaborationStateProof(doc, Y); assert(proof);
        const operationId = `native-history-${randomUUID()}`, expectedVersion = documentVersionV1(identity, proof);
        const original = makeNativeDocumentEditOriginal({ kind: 'native_document_edit_original', version: 1,
          requestFingerprint: sha(operationId), identity, expectedVersion, origin: origin.origin, actor: origin.actor,
          source: { path: target.filePath, stateProof: proof, stateVectorHash: sha(row.state_vector), persistedSequence: Number(row.document_sequence) },
          preparedIntentProof: sha(`owned-test-intent:${operationId}`) });
        if (options.overLimit) doc.getText('content').insert(doc.getText('content').length, 'Z'.repeat(limits.maxRawVersionBytes + 64));
        else if (options.edit !== false) {
          const prepared = prepareNativeDocumentEditInDocument({ doc, identity, expectedVersion, groupId: operationId,
            patch: decodeDocumentEditPatchV1({ kind: 'native_text_replace', edits: [{ oldText: 'Target', newText: 'Changed 🦊' }] }) });
          const actual = applyAgentTextTargets({ doc, targets: prepared.targets,
            origin: { actorType: origin.actor.actorType, actorId: origin.actor.actorId, initiatedByUserId: origin.actor.userId, operationId },
            validateClone: candidate => validateNativeDocumentEditCandidate(candidate, identity.representation) });
          assert.equal(actual.status, 'applied_to_ydoc'); assert.deepEqual(actual.conflicts, []);
          assert.equal(actual.appliedTargetIds.length, prepared.targets.length);
        }
        const prepared = prepare({ doc, identity }), stateProof = collaborationStateProof(doc, Y), snapshot = captureAgentStateSnapshot(doc, Y);
        assert(stateProof && snapshot); const update = Y.encodeStateAsUpdate(doc), vector = Y.encodeStateVector(doc), appliedAt = Date.now();
        let bytes = prepared.status === 'ready' ? prepared.bytes : null;
        // Deliberately INITIAL adversarial data: SQL verifies hash/size but not Yjs parsing.
        if (options.corruptInitialPayload) bytes = new Uint8Array([255, 255]);
        const history = bytes ? { status: 'ready' as const, format: 'native-yjs-update-v1' as const, sha256: sha(bytes), sizeBytes: bytes.byteLength }
          : { status: 'over_limit' as const, format: 'native-yjs-update-v1' as const, sizeBytes: prepared.sizeBytes };
        const after = makeNativeDocumentEditAfter({ kind: 'native_document_edit_after', version: 1, originalProof: original.originalProof,
          outcome: options.edit === false ? 'no_change' : 'applied', identity, beforeVersion: expectedVersion,
          afterVersion: documentVersionV1(identity, stateProof), stateProof, stateVectorHash: sha(vector), stateSnapshotHash: sha(snapshot), appliedAt, history }, original);
        // Genuine SQL fixture arrangement, not a call to the production mutation owner.
        await withB(async (_tx, _db, client) => {
          await client.query(`UPDATE collaboration_yjs_states SET yjs_state=$2,state_vector=$3,
            document_sequence=document_sequence+1,persisted_at=$4 WHERE document_id=$1`, [target.documentId, Buffer.from(update), Buffer.from(vector), appliedAt]);
          await client.query(`INSERT INTO collaboration_agent_operations(operation_id,document_id,document_path,document_representation,
            workspace_id,organization_id,document_lifecycle_generation,schema_version,initiated_by_user_id,actor_id,actor_session_id,
            idempotency_key,payload_hash,operation_type,requested_mode,atomicity,operation_payload,status,base_state_vector,
            base_document_sequence,created_at,updated_at,native_edit_original_json)
            VALUES($1,$2,$3,$4,$5,$6,1,1,$7,$8,$9,$1,$10,'apply','direct_apply','all_or_nothing','[]','preparing',$11,$12,$13,$13,$14::jsonb)`,
          [operationId,target.documentId,target.filePath,target.representation,workspaceId,identity.organizationId,
            original.actor.userId,original.actor.actorId,original.actor.sessionId,original.requestFingerprint,
            Buffer.from(row.state_vector),Number(row.document_sequence),appliedAt,JSON.stringify(original)]);
          await client.query(`UPDATE collaboration_agent_operations SET native_edit_after_json=$2::jsonb,status='persisted_yjs',applied_at=$3,
            resulting_state_vector_hash=$4,resulting_state_snapshot=$5 WHERE operation_id=$1`,
          [operationId,JSON.stringify(after),appliedAt,after.stateVectorHash,Buffer.from(snapshot)]);
          if (bytes) await client.query(`INSERT INTO collaboration_agent_native_edit_payloads
            (operation_id,workspace_id,original_proof,after_proof,format,sha256,size_bytes,yjs_update,created_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [operationId,workspaceId,original.originalProof,after.afterProof,
            history.format,sha(bytes),bytes.byteLength,Buffer.from(bytes),appliedAt]);
        });
        await assert.rejects(lstat(path.join(fixture.workspaceRoot, target.filePath)), { code: 'ENOENT' });
        return { operationId, workspace: origin.workspace, original, after, bytes };
      } finally { doc.destroy(); }
    };
    const check = async (name: string, action: () => Promise<void>): Promise<void> => {
      currentCase = name; await action(); groups++; console.log('PASS native operation history:', name);
    };
    const revisionId = (input: NativeAgentOperationHistoryCaptureInput) => `file-rev-op-${sha(`${workspaceId}\0${input.operationId}`)}`;
    let capturedAgent: NativeAgentOperationHistoryCaptureInput | undefined;

    await check('actual native update is reconstructable binary; deletion proof and history-only raw cap are separate', async () => {
      const identity: DocumentVersionIdentityV1 = { workspaceId, organizationId: originalA.workspace.organizationId ?? null,
        documentId: 'pure-history-document', lineageId: 'pure-history-lineage', lifecycleGeneration: 1, schemaVersion: 1, representation: 'plain_text' };
      const doc = createPlainTextYDoc('ABCDE 🦊'), huge = createPlainTextYDoc('Z'.repeat(limits.maxRawVersionBytes + 64));
      try {
        const vector = Y.encodeStateVector(doc), first = prepare({ doc, identity }); assert.equal(first.status, 'ready');
        doc.getText('content').delete(1, 2); assert.deepEqual(Y.encodeStateVector(doc), vector);
        const before = Y.encodeStateAsUpdate(doc), prepared = prepare({ doc, identity }); assert.equal(prepared.status, 'ready');
        assert.equal(first.status, 'ready'); assert.notEqual(prepared.stateProof, first.stateProof);
        assert.equal(prepared.sha256, sha(before)); assert.equal(prepared.sizeBytes, before.byteLength);
        const clone = new Y.Doc({ gc: false });
        try { Y.applyUpdate(clone, prepared.bytes); assert.equal(clone.getText('content').toString(), 'ADE 🦊');
          assert.equal(collaborationStateProof(clone, Y), prepared.stateProof); assert.equal(prepared.version, documentVersionV1(identity, prepared.stateProof)); }
        finally { clone.destroy(); }
        assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
        const over = prepare({ doc: huge, identity }); assert.equal(over.status, 'over_limit');
        assert.equal(over.sizeBytes, Y.encodeStateAsUpdate(huge).byteLength); assert(over.sizeBytes !== null && over.sizeBytes > limits.maxRawVersionBytes);
        for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
          const native = nativeTableWidthFixture(representation);
          try { assert.equal(validateRichMarkdownYDoc(native).code, 'roundtrip_unstable');
            const snapshot = prepare({ doc: native, identity: { ...identity, representation } }); assert.equal(snapshot.status, 'ready'); }
          finally { native.destroy(); }
        }
      } finally { doc.destroy(); huge.destroy(); }
    });
    await check('Plain/XML/Blocks use real same-B HistoryOnly binary bindings with exact user/manual vs agent attribution', async () => {
      for (const [representation, actor] of [['plain_text', userA], ['tiptap_xml', originalA], ['tiptap_blocks', originalA]] as const) {
        const input = await stage({ representation, facts: actor }); assert(input.bytes);
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM file_version_blobs WHERE workspace_id=$1 AND content_sha256=$2',
          [workspaceId, sha(input.bytes)])).rows[0].count, 0, 'The visibility probe requires a genuinely fresh blob.');
        const beforeNative = await currentNative(), beforeOperation = await operationRows(input.operationId);
        const committed = await withB(async (tx, _db, client) => {
          const before = (await client.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid')).rows[0];
          const result = await capture(tx, input); assert.equal(result.outcome, 'captured'); assert(result.revision && result.binding);
          const after = (await client.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid')).rows[0]; assert.deepEqual(after, before);
          assert.equal(result.revision.id, revisionId(input)); assert.equal(result.revision.createdByActorType, actor.actor.actorType);
          assert.equal(result.revision.createdByUserId, actor.actor.userId); assert.equal(result.revision.sourceSessionId, actor.actor.sessionId);
          assert.equal(result.revision.path, input.original.source.path); assert.equal(result.revision.createdAt, input.after.appliedAt);
          assert.equal(result.binding.format, 'binary'); assert.equal(result.binding.source, actor.actor.actorType === 'user' ? 'manual' : 'agent_apply');
          assert.equal(result.binding.stateVectorHash, input.after.stateVectorHash); assert.equal(result.binding.sha256, sha(input.bytes!));
          const rows = (await client.query(`SELECT r.history_only,r.xmin::text AS r_xmin,c.xmin::text AS c_xmin,b.xmin::text AS b_xmin
            FROM file_revisions r JOIN file_revision_contents c ON c.revision_id=r.id JOIN file_version_blobs b ON b.blob_id=c.blob_id
            WHERE r.id=$1`, [result.revision.id])).rows[0]; assert(rows); assert.equal(rows.history_only, true);
          // SAVEPOINT writes have a subtransaction xmin. The real outer B/XID
          // must stay unchanged; all three new rows share their actual xmin.
          assert.match(rows.r_xmin, /^[1-9][0-9]*$/u);
          assert.deepEqual([rows.c_xmin, rows.b_xmin], [rows.r_xmin, rows.r_xmin]);
          const hidden = (await admin.query(`SELECT
            (SELECT count(*)::int FROM file_revisions WHERE id=$1) AS revisions,
            (SELECT count(*)::int FROM file_revision_contents WHERE revision_id=$1) AS bindings,
            (SELECT count(*)::int FROM file_version_blobs WHERE blob_id=$2) AS blobs`,
          [result.revision.id, result.binding.blobId])).rows[0];
          assert.deepEqual(hidden, { revisions: 0, bindings: 0, blobs: 0 }, 'Independent B cannot see any capture row before caller COMMIT.');
          const store = createFileVersionContentStore({ database: { transaction: action => action(tx) } });
          const loaded = await store.readRevisionContent({ revisionId: result.revision.id, workspaceId, lineageId: input.original.identity.lineageId }); assert(loaded);
          assert.deepEqual(loaded.content, Buffer.from(input.bytes!)); const reconstructed = new Y.Doc({ gc: false });
          try { Y.applyUpdate(reconstructed, loaded.content); assert.equal(collaborationStateProof(reconstructed, Y), input.after.stateProof);
            assert.match(JSON.stringify(inspectNativeDocument(reconstructed, representation).content), /Changed 🦊/u);
            if (representation === 'tiptap_blocks') assert.equal(validateRichMarkdownYDoc(reconstructed).code, 'roundtrip_unstable'); }
          finally { reconstructed.destroy(); }
          return { revisionId: result.revision.id, blobId: result.binding.blobId, xmin: rows.r_xmin as string };
        });
        const visible = (await admin.query(`SELECT r.xmin::text AS r_xmin,c.xmin::text AS c_xmin,b.xmin::text AS b_xmin,
          b.content_sha256,c.blob_id FROM file_revisions r JOIN file_revision_contents c ON c.revision_id=r.id
          JOIN file_version_blobs b ON b.blob_id=c.blob_id WHERE r.id=$1 AND b.blob_id=$2`,
        [committed.revisionId, committed.blobId])).rows;
        assert.deepEqual(visible, [{ r_xmin: committed.xmin, c_xmin: committed.xmin, b_xmin: committed.xmin,
          content_sha256: sha(input.bytes), blob_id: committed.blobId }], 'The same exact rows become visible together after caller COMMIT.');
        assert.deepEqual(await currentNative(), beforeNative); assert.deepEqual(await operationRows(input.operationId), beforeOperation);
        if (representation === 'tiptap_xml') capturedAgent = input;
      }
    });
    await check('genuine renewed SID_B may retry exact Original_A without changing binary binding/xmins or attribution', async () => {
      assert(capturedAgent); const input = capturedAgent, sessionId = `history-renewed-${randomUUID()}`, now = Date.now();
      const beforeHistory = await historyRows(), beforeOperation = await operationRows(input.operationId), beforeNative = await currentNative();
      await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,'reader',$3,$4,$4)`,
        [sessionId,randomUUID(),now+3600000,now]);
      await admin.query(`UPDATE "session" SET expires_at=$1 WHERE id='reader-session'`, [now-1000]);
      try {
        const renewed = await facts('agent', await fixture.issue({ sid: sessionId, scope: 'knowledge:read knowledge:search knowledge:write' }));
        assert.equal(renewed.actor.sessionId, sessionId); assert.equal(renewed.origin.transport, 'direct-mcp');
        assert.equal(input.original.actor.sessionId, 'reader-session'); assert.notEqual(renewed.actor.sessionId, input.original.actor.sessionId);
        const result = await withB(tx => capture(tx, { ...input, workspace: renewed.workspace }));
        assert.equal(result.outcome, 'already_captured'); assert.equal(result.revision?.sourceSessionId, 'reader-session');
        assert.equal(result.revision?.createdByActorType, 'agent'); assert.equal(result.binding?.format, 'binary');
        assert.deepEqual(await historyRows(), beforeHistory); assert.deepEqual(await operationRows(input.operationId), beforeOperation);
        assert.deepEqual(await currentNative(), beforeNative);
      } finally { await fixture.restoreReaderSession(); await admin.query('DELETE FROM "session" WHERE id=$1 AND user_id=$2', [sessionId,'reader']); }
    });
    await check('input drift and initially corrupt payload are refused; actual immutable SQL guards preserve originals', async () => {
      assert(capturedAgent); const input = capturedAgent; assert(input.bytes);
      const beforeHistory = await historyRows(), beforeNative = await currentNative(), beforeOperation = await operationRows(input.operationId);
      const changed = new Uint8Array(input.bytes); changed[changed.length - 1] ^= 1;
      await assert.rejects(withB(tx => capture(tx, { ...input, bytes: changed })), errorCode('EDIT_OUTCOME_UNCONFIRMED'));
      const { afterProof: oldProof, ...afterBody } = input.after; assert.match(oldProof, /^[a-f0-9]{64}$/u);
      const changedAfter = makeNativeDocumentEditAfter({ ...afterBody, appliedAt: input.after.appliedAt + 1 }, input.original);
      await assert.rejects(withB(tx => capture(tx, { ...input, after: changedAfter })), errorCode('EDIT_OUTCOME_UNCONFIRMED'));
      await assert.rejects(admin.query('UPDATE collaboration_agent_native_edit_payloads SET yjs_update=yjs_update WHERE operation_id=$1', [input.operationId]), errorCode('55000'));
      await assert.rejects(admin.query(`UPDATE collaboration_agent_operations SET native_edit_after_json=jsonb_set(native_edit_after_json,'{appliedAt}',to_jsonb(applied_at+1))
        WHERE operation_id=$1`, [input.operationId]), errorCode('55000'));
      assert.deepEqual(await historyRows(), beforeHistory); assert.deepEqual(await currentNative(), beforeNative);
      assert.deepEqual(await operationRows(input.operationId), beforeOperation);
      const corrupt = await stage({ corruptInitialPayload: true }); const corruptionHistory = await historyRows(), corruptionNative = await currentNative();
      const corruptionOriginal = await operationRows(corrupt.operationId);
      await assert.rejects(withB(tx => capture(tx, corrupt)), errorCode('EDIT_OUTCOME_UNCONFIRMED'));
      assert.deepEqual(await historyRows(), corruptionHistory); assert.deepEqual(await currentNative(), corruptionNative);
      assert.deepEqual(await operationRows(corrupt.operationId), corruptionOriginal);
    });
    await check('disabled and actual over-limit preserve native evidence and create no history', async () => {
      const disabled = await stage({ edit: false }); const before = await historyRows(), native = await currentNative();
      process.env.FILE_VERSION_CENTER_MODE = 'off';
      try { assert.deepEqual(await withB(tx => capture(tx, disabled)), { outcome: 'disabled', revision: null, binding: null }); }
      finally { process.env.FILE_VERSION_CENTER_MODE = 'shadow'; }
      assert.deepEqual(await historyRows(), before); assert.deepEqual(await currentNative(), native);
      const over = await stage({ overLimit: true }); assert.equal(over.after.history.status, 'over_limit'); assert.equal(over.bytes, null);
      const overNative = await currentNative(), overOriginal = await operationRows(over.operationId);
      assert.deepEqual(await withB(tx => capture(tx, over)), { outcome: 'over_limit', revision: null, binding: null });
      assert.deepEqual(await historyRows(), before); assert.deepEqual(await currentNative(), overNative);
      assert.deepEqual(await operationRows(over.operationId), overOriginal);
    });
    await check('real 500-version quota rolls back the half-created HistoryOnly revision while caller B remains usable', async () => {
      const target = await fixture.seed({ text: 'Target quota fixture.' }), first = await stage({ target, edit: false });
      const result = await withB(tx => capture(tx, first)); assert.equal(result.outcome, 'captured'); assert(result.revision && result.binding);
      // Bounded actual quota data, all rows reference the genuine captured blob.
      await withB(async (_tx, _db, client) => {
        await client.query(`INSERT INTO file_revisions(id,organization_id,customer_id,project_id,workspace_id,workspace_type,path,content_hash,size_bytes,
          created_by_user_id,created_by_actor_type,source_session_id,lineage_id,revision_number,created_at,history_only)
          SELECT 'history-quota-'||$2||'-'||n,organization_id,customer_id,project_id,workspace_id,workspace_type,path,content_hash,size_bytes,
          created_by_user_id,created_by_actor_type,source_session_id,lineage_id,n+1,created_at,true
          FROM file_revisions CROSS JOIN generate_series(1,$3::integer) AS t(n) WHERE id=$1`,
        [result.revision!.id,randomUUID(),limits.maxVersionsPerLineage-1]);
        await client.query(`INSERT INTO file_revision_contents(revision_id,workspace_id,lineage_id,blob_id,content_format,source,state_vector_hash,created_at)
          SELECT r.id,c.workspace_id,c.lineage_id,c.blob_id,c.content_format,c.source,c.state_vector_hash,c.created_at
          FROM file_revisions r JOIN file_revision_contents c ON c.revision_id=$1
          WHERE r.lineage_id=c.lineage_id AND r.id<>$1`, [result.revision!.id]);
      });
      const count = (await admin.query('SELECT count(*)::int AS count FROM file_revision_contents WHERE lineage_id=$1', [target.lineageId])).rows[0].count;
      assert.equal(count, limits.maxVersionsPerLineage);
      const pending = await stage({ target, edit: false }), beforeHistory = await historyRows(), beforeNative = await currentNative(), beforeOperation = await operationRows(pending.operationId);
      await withB(async (tx, _db, client) => {
        const outcome = await capture(tx, pending); assert.deepEqual(outcome, { outcome: 'quota_exceeded', quotaCode: 'version_count_exceeded', revision: null, binding: null });
        assert.equal((await client.query('SELECT 1 AS usable')).rows[0].usable, 1, 'The caller B survives the internal savepoint rollback.');
        assert.equal((await client.query('SELECT count(*)::int AS count FROM file_revisions WHERE id=$1', [revisionId(pending)])).rows[0].count, 0);
      });
      assert.deepEqual(await historyRows(), beforeHistory); assert.deepEqual(await currentNative(), beforeNative);
      assert.deepEqual(await operationRows(pending.operationId), beforeOperation);
    });
    assert.equal(leased, 0); assert.deepEqual(await readdir(fixture.workspaceRoot), []);
    assert.equal(groups, 6); console.log('Native operation history PG summary:', JSON.stringify({ groups, callerLeasesClosed: leased === 0,
      scope: 'history-only; operation SQL is fixture arrangement; no Owner/Room/durability/HTTP claim' }));
  });
  completed = true;
}
void nativeOperationHistoryPostgresTest().catch(error => {
  const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  const safeCode = typeof code === 'string' && /^[A-Za-z0-9_]{1,80}$/u.test(code) ? code : undefined;
  const numericArray = (value: unknown) => Array.isArray(value)
    && value.every(item => typeof item === 'string' && /^[0-9]+$/u.test(item)) ? value : undefined;
  console.error('FAIL native operation history:', currentCase, error instanceof Error ? error.name : typeof error, safeCode,
    error instanceof Error ? error.stack?.split('\n').filter(line => /^\s+at\s/u.test(line)).slice(0, 5) : [],
    { actualXids: numericArray(error && typeof error === 'object' ? Reflect.get(error, 'actual') : undefined),
      expectedXids: numericArray(error && typeof error === 'object' ? Reflect.get(error, 'expected') : undefined) });
  process.exitCode = 1;
});

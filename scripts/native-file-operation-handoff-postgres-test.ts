import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, Pool } from 'pg';
import { getSchema } from '@tiptap/core';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { withWorkspaceMutationLock } from '../app/lib/files/workspace-mutation-lock';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { loadCollaborationStateOnConnection, type PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createCollaborationAdmissionService } from '../app/lib/collaboration/room-admission';
import { collaborationAdmissionActionDigest, type CollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { createCollaborationAdmissionQuiescenceService } from '../app/lib/collaboration/room-admission-quiescence';
import { createCollaborationAdmissionHandoffService } from '../app/lib/collaboration/room-admission-handoff';
import { createCollaborationRoomOwnerSession } from '../app/lib/collaboration/room-owner';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import { COLLABORATION_ROOM_OWNER_UP_SQL, COLLABORATION_ROOM_RELEASE_UP_SQL } from '../app/lib/db/collaboration-room-owner-migration';
import { runNativeFileOperationHandoffMigration } from '../app/lib/db/native-file-operation-handoff-migration';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { prepareNativeLinkMutations } from '../app/lib/markdown/workspace-native-link-mutations';
import { applyNativeFileOperationMutationOnConnection, captureNativeFileOperationBundle,
  nativeFileOperationReceiptSetProofOnConnection, readCommittedNativeFileOperationReceiptOnConnection,
  readAppliedNativeFileOperationReceiptBindingsOnConnection, readStagedNativeFileOperationBindingOnConnection,
  stageNativeFileOperationBundleOnConnection, type NativeFileOperationBundle } from '../app/lib/markdown/native-file-operation-handoff';

let stage = 'private local environment';
async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  const envPath = process.env.CANVAS_NATIVE_FILE_HANDOFF_TEST_ENV_FILE; assert(envPath);
  assert.equal((await stat(envPath)).mode & 0o077, 0);
  const connectionString = parse(await readFile(envPath)).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString); assert(['postgres:','postgresql:'].includes(url.protocol));
  assert(['localhost','127.0.0.1'].includes(url.hostname)); assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `canvas_native_file_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^canvas_native_file_test_[a-f0-9]{32}$/u); assert(schema.length <= 63);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>(); let pool: Pool | undefined; let created = false;
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'canvas-native-file-handoff-'));
  const previousData = process.env.CANVAS_DATA_ROOT; process.env.CANVAS_DATA_ROOT = temporaryRoot;
  let fault: 'before' | 'after' | 'after-peer' | null = null; let pendingPeer: (() => Promise<void>) | null = null;
  let discarded = 0;
  const openConnection = async (): Promise<SqlConnection> => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=4000 -c application_name=canvas-native-file-handoff-test` });
    clients.add(client); await client.connect(); let closed = false; let wrote = false;
    return {
      get: async (sql, values) => (await client.query(sql, values)).rows[0],
      all: async (sql, values) => (await client.query(sql, values)).rows,
      run: async (sql, values) => {
        if (sql.startsWith('INSERT INTO collaboration_native_file_operation_receipts')) wrote = true;
        if (sql === 'COMMIT' && wrote && fault) {
          const injected = fault; fault = null;
          await client.query(injected === 'before' ? 'ROLLBACK' : 'COMMIT');
          throw new Error('Injected lost native file COMMIT reply.');
        }
        return { changes: (await client.query(sql, values)).rowCount ?? 0 };
      },
      close: async error => {
        assert.equal(closed, false); closed = true; if (wrote && error) discarded++;
        await client.end(); clients.delete(client);
        if (wrote && error && pendingPeer) { const peer = pendingPeer; pendingPeer = null; await peer(); }
      },
    };
  };
  try {
    await control.connect(); const server = (await control.query(`SELECT current_database() AS name,current_setting('server_version_num')::integer AS version,
      to_regclass('public.collaboration_yjs_states') IS NOT NULL AS states`)).rows[0];
    assert.equal(server.name, 'canvas_notebook'); assert.equal(Math.floor(server.version / 10000), 18); assert.equal(server.states, true);
    stage = 'isolated generated schema'; await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    for (const table of ['collaboration_documents','file_collaboration_lineages','collaboration_yjs_states',
      'collaboration_file_projections','collaboration_agent_operations']) await control.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    pool = new Pool({ connectionString, max: 6, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=4000` });
    assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema);
    const connection: SqlConnection = { get: async (sql, values) => (await pool!.query(sql, values)).rows[0],
      all: async (sql, values) => (await pool!.query(sql, values)).rows,
      run: async (sql, values) => {
        try { return { changes: (await pool!.query(sql, values)).rowCount ?? 0 }; }
        catch (error) {
          if (sql.startsWith('CREATE OR REPLACE FUNCTION') && error && typeof error === 'object') {
            const detail = error as { position?: string; internalPosition?: string; internalQuery?: string };
            console.error('Owned fixture DDL:', sql.slice(0, 100), detail.position, detail.internalPosition, detail.internalQuery);
          }
          throw error;
        }
      }, close: () => undefined };
    await pool.query(COLLABORATION_ROOM_OWNER_UP_SQL); await pool.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
    for (const sql of COLLABORATION_ADMISSION_STATEMENTS) await pool.query(sql);
    await runNativeFileOperationHandoffMigration(connection); await runNativeFileOperationHandoffMigration(connection);
    const workspace: WorkspaceContext = { workspaceId: `native-file-${randomUUID()}`, workspaceType: 'personal', organizationId: null,
      rootPath: temporaryRoot, legacy: false, status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true,
        canManageWorkspace: true, canCreatePublicLinks: true, canRunAgent: true } };
    const admission = createCollaborationAdmissionService({ openConnection });
    const quiescence = createCollaborationAdmissionQuiescenceService({ openConnection });
    const handoff = createCollaborationAdmissionHandoffService({ openConnection,
      withMutationLocks: (workspaceIds, operation) => {
        const enter = (index: number): ReturnType<typeof operation> => index === workspaceIds.length ? operation()
          : withWorkspaceMutationLock(workspaceIds[index], () => enter(index + 1));
        return enter(0);
      } });
    const current = async (documentId: string) => (await loadCollaborationStateOnConnection(connection, documentId, true))!;
    const seed = async (label: string, options: { rich?: boolean; deletion?: boolean; archive?: boolean; links?: boolean } = {}) => {
      const documentId = `native-${randomUUID()}`, lineageId = `lineage-${randomUUID()}`, filePath = `${label}.md`, mutationId = randomUUID();
      const doc = options.rich ? createRichMarkdownYDoc('| Keep |\n| --- |\n| [Link](target.md) |', 'tiptap_blocks') : new Y.Doc();
      let state: PersistedCollaborationState;
      try {
        if (options.rich) {
          const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
          for (const record of tree.records.values()) if (['tableCell','tableHeader'].includes((record.get('shape') as { type: string }).type))
            (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth', [120]);
          assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
        } else doc.getText('content').insert(0, options.deletion ? '![](target.md)\n\nIndependent.' : '[Link](target.md)\n\nIndependent.');
        state = { documentId, workspaceId: workspace.workspaceId, organizationId: null, path: filePath,
          representation: options.rich ? 'tiptap_blocks' : 'plain_text', lifecycleGeneration: 1, schemaVersion: 1,
          yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 7, persistedAt: 100,
          checkpointSequence: 7, checkpointedAt: 100, canonicalHash: 'old', serializedHash: 'old', hasBom: false, newlineStyle: 'lf', degraded: false, status: 'active' };
      } finally { doc.destroy(); }
      await pool!.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,'personal',NULL,$3,'active',100)`, [lineageId, workspace.workspaceId, filePath]);
      await pool!.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
        state_version,yjs_state_lifecycle,status,created_at,updated_at) VALUES($1,$2,$3,'personal',NULL,$4,'yjs',7,'initialized','active',100,100)`,
      [documentId, lineageId, workspace.workspaceId, filePath]);
      await pool!.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,$2,NULL,$3,$4,1,1,$5,$6,7,100,7,100,'old','old','lf',0,0,'active')`,
      [documentId, workspace.workspaceId, filePath, state.representation, Buffer.from(state.yjsState), Buffer.from(state.stateVector)]);
      await pool!.query(`INSERT INTO collaboration_file_projections(document_id,lifecycle_generation,projected_sequence,revision_id,
        canonical_hash,serialized_hash,finalized,updated_at) VALUES($1,1,7,'old-revision','old','old',1,100)`, [documentId]);
      const native = authoritativeNativeCollaborationSnapshot(state); const inventory = inspectPersistedDocumentLinks(state);
      const prepared = options.links || options.deletion ? prepareNativeLinkMutations({ state, operationId: mutationId, recipes: [{
        linkId: inventory.links[0].id, source: inventory.document, sourceVersion: inventory.version, destinationWorkspaceId: workspace.workspaceId,
        sourcePathAfter: `moved-${filePath}`, cloneSelection: null, reference: inventory.links[0].ref,
        action: options.deletion ? 'unlink' : 'rewrite', nextValue: options.deletion ? null : 'renamed.md', expectedTargetIdentity: 'fixture-target' }] }) : null;
      const bundle: NativeFileOperationBundle = { version: 1, operationId: randomUUID(), requestId: randomUUID(), action: options.archive ? 'archive' : 'move',
        actor: { actorUserId: 'owner', actorId: 'test-agent', actorType: 'agent', actorSessionId: 'session' }, reviewDigest: nativeLinkJsonProof({ label }),
        mutations: [{ mutationId, kind: options.archive ? 'archive' : 'move', source: inventory.document, lineageId,
          registryStateVersion: 7, before: { ...native.version, binaryHash: nativeLinkJsonProof('unused') },
          destinationPath: options.archive ? null : `moved-${filePath}`, trashEntryId: options.archive ? 'owned-trash' : null, prepared }] };
      // Exact persisted binary hash is separate from deletion-aware native proof.
      const { createHash } = await import('node:crypto'); bundle.mutations[0].before.binaryHash = createHash('sha256').update(state.yjsState).digest('hex');
      return { bundle, state };
    };
    const requestFor = async (bundle: NativeFileOperationBundle, changePayload?: (payload: Record<string, unknown>) => void, prove = true) => {
      const staged = await stageNativeFileOperationBundleOnConnection(connection, bundle);
      const payload = JSON.parse(staged.actionPayloadText) as Record<string, unknown>; changePayload?.(payload); const actionPayloadText = JSON.stringify(payload);
      const request: CollaborationAdmissionRequest = { requestId: bundle.requestId, actorId: bundle.actor.actorId, action: bundle.action,
        actionPayloadText, actionDigest: collaborationAdmissionActionDigest(bundle.action, actionPayloadText),
        scopes: bundle.mutations.flatMap((mutation) => [mutation.source.path, mutation.destinationPath].filter((entry): entry is string => entry !== null)
          .map((filePath) => ({ workspaceId: workspace.workspaceId, organizationId: null, path: filePath, kind: 'exact' as const }))),
        expectedDocuments: bundle.mutations.map((mutation) => ({ ...mutation.source, status: 'active' as const })) };
      await admission.reserve(request); if (prove) for (const target of request.expectedDocuments) await quiescence.prove(request, target.documentId);
      return request;
    };
    const apply = async (bundle: NativeFileOperationBundle, request: CollaborationAdmissionRequest,
      after?: (database: SqlConnection) => Promise<void>) => handoff.execute(request, { authorize: async actual => { assert.equal(actual.actorId, bundle.actor.actorId); },
      prepare: async database => {
        assert(workspace.permissions.canWrite);
        const binding = await readStagedNativeFileOperationBindingOnConnection(database, { request, operationId: bundle.operationId });
        assert.equal(binding.executionReady, false); assert.equal(binding.mutations.length, bundle.mutations.length);
        assert.equal(binding.reviewDigest, bundle.reviewDigest); assert.equal(binding.actor.actorSessionId, bundle.actor.actorSessionId);
        assert(!JSON.stringify(binding).includes('inverseRecipes')); assert(!JSON.stringify(binding).includes('"update":'));
      }, mutate: async database => {
        for (const mutation of bundle.mutations) {
          const result = await applyNativeFileOperationMutationOnConnection(database,
            { workspace, action: bundle.action, operationId: bundle.operationId, mutationId: mutation.mutationId }); assert.equal(result.executionReady, false);
        }
        const bindings = await readAppliedNativeFileOperationReceiptBindingsOnConnection(database, bundle.action, bundle.operationId);
        assert.equal(bindings.executionReady, false); assert.equal(bindings.receipts.length, bundle.mutations.length);
        assert.equal(bindings.receiptSetProof, await nativeFileOperationReceiptSetProofOnConnection(database, bundle.action, bundle.operationId));
        assert(!JSON.stringify(bindings).includes('inverseRecipes')); assert(!JSON.stringify(bindings).includes('"update":'));
        await after?.(database);
        return { nativeFileReceiptSetProof: await nativeFileOperationReceiptSetProofOnConnection(database, bundle.action, bundle.operationId) };
      } });
    const readReceipt = async (bundle: NativeFileOperationBundle, request: CollaborationAdmissionRequest) => {
      const database = await openConnection();
      try { await database.run('BEGIN'); const receipt = await readCommittedNativeFileOperationReceiptOnConnection(database,
        { request, operationId: bundle.operationId, mutationId: bundle.mutations[0].mutationId }); await database.run('COMMIT'); return receipt; }
      finally { await database.close(new Error('Discarding owned receipt reader.')); }
    };
    const receiptCount = async (bundle: NativeFileOperationBundle) => Number((await pool!.query(
      'SELECT count(*) AS n FROM collaboration_native_file_operation_receipts WHERE operation_id=$1', [bundle.operationId])).rows[0].n);

    stage = 'combined move + native delta + receipt + projection invalidation';
    const combined = await seed('combined', { links: true }); const combinedRequest = await requestFor(combined.bundle);
    await apply(combined.bundle, combinedRequest);
    const moved = await current(combined.state.documentId); assert.equal(moved.path, 'moved-combined.md'); assert.equal(moved.documentSequence, 8);
    assert.equal(moved.lifecycleGeneration, 1); assert.equal(moved.checkpointSequence, 0);
    assert.equal(inspectPersistedDocumentLinks(moved).links[0].literal, 'renamed.md');
    const projection = (await pool.query('SELECT * FROM collaboration_file_projections WHERE document_id=$1', [moved.documentId])).rows[0];
    assert.equal(Number(projection.finalized), 0); assert.equal(projection.revision_id, null); assert.equal(projection.canonical_hash, null);
    const initialReceipt = await readReceipt(combined.bundle, combinedRequest); assert(initialReceipt); assert.equal(initialReceipt.receipt.after.clock.documentSequence, 8);
    await apply(combined.bundle, combinedRequest); assert.equal(await receiptCount(combined.bundle), 1);
    await assert.rejects(pool.query('UPDATE collaboration_native_file_operation_receipts SET mutation_id=$1', ['forged']), { code: '55000' });
    await assert.rejects(pool.query('DELETE FROM collaboration_native_file_operation_intents WHERE operation_id=$1', [combined.bundle.operationId]), { code: '55000' });

    stage = 'plain move and nonexportable Rich preserve binary/vector/sequence';
    for (const rich of [false, true]) {
      const item = await seed(rich ? 'rich' : 'plain', { rich }); const request = await requestFor(item.bundle); await apply(item.bundle, request);
      const after = await current(item.state.documentId); assert(Buffer.from(after.yjsState).equals(Buffer.from(item.state.yjsState)));
      assert(Buffer.from(after.stateVector).equals(Buffer.from(item.state.stateVector))); assert.equal(after.documentSequence, 7); assert.equal(after.persistedAt, 100);
    }
    stage = 'rename action and native link-only update retain their distinct identity clocks';
    const rename = await seed('rename'); rename.bundle.action = 'rename'; const renameRequest = await requestFor(rename.bundle);
    await apply(rename.bundle, renameRequest); assert.equal((await current(rename.state.documentId)).path, 'moved-rename.md');
    const linkOnly = await seed('link-only', { links: true }); linkOnly.bundle.mutations[0].kind = 'link'; linkOnly.bundle.mutations[0].destinationPath = null;
    const linkOnlyRequest = await requestFor(linkOnly.bundle); await apply(linkOnly.bundle, linkOnlyRequest);
    const linked = await current(linkOnly.state.documentId); assert.equal(linked.path, linkOnly.state.path); assert.equal(linked.documentSequence, 8);
    assert.equal(Number((await pool.query('SELECT state_version FROM collaboration_documents WHERE id=$1', [linked.documentId])).rows[0].state_version), 7);
    stage = 'archive increments generation and preserves native bytes';
    const archive = await seed('archive', { archive: true, rich: true }); const archiveRequest = await requestFor(archive.bundle); await apply(archive.bundle, archiveRequest);
    const archived = await current(archive.state.documentId); assert.equal(archived.lifecycleGeneration, 2); assert.equal(archived.status, 'archived');
    assert(Buffer.from(archived.yjsState).equals(Buffer.from(archive.state.yjsState))); assert.equal(archived.documentSequence, 7); assert(await readReceipt(archive.bundle, archiveRequest));
    stage = 'deletion-only delta has equal vector but different state proof';
    const deletion = await seed('deletion', { deletion: true }); assert.equal(deletion.bundle.mutations[0].prepared!.before.stateVector, deletion.bundle.mutations[0].prepared!.after.stateVector);
    const deletionRequest = await requestFor(deletion.bundle); await apply(deletion.bundle, deletionRequest); assert.equal((await current(deletion.state.documentId)).documentSequence, 8);

    stage = 'forged, wrapped and detached authority';
    const forged = await seed('forged'); await stageNativeFileOperationBundleOnConnection(connection, forged.bundle);
    await assert.rejects(applyNativeFileOperationMutationOnConnection(connection,
      { workspace, action: 'move', operationId: forged.bundle.operationId, mutationId: forged.bundle.mutations[0].mutationId }), { code: 'ADMISSION_RECOVERY_REQUIRED' });
    const wrapper = await seed('wrapper'); const wrapperRequest = await requestFor(wrapper.bundle);
    await assert.rejects(handoff.execute(wrapperRequest, { authorize: async () => undefined, prepare: async () => undefined,
      mutate: async database => { await applyNativeFileOperationMutationOnConnection({ ...database },
        { workspace, action: 'move', operationId: wrapper.bundle.operationId, mutationId: wrapper.bundle.mutations[0].mutationId }); return {}; } }), { code: 'ADMISSION_RECOVERY_REQUIRED' });
    const detached = await seed('detached'); const detachedRequest = await requestFor(detached.bundle); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); let detachedCall: Promise<unknown> | undefined;
    await assert.rejects(handoff.execute(detachedRequest, { authorize: async () => undefined, prepare: async () => undefined,
      mutate: async database => {
        const originalGet = database.get; database.get = async (sql, args) => { if (sql.includes('collaboration_native_file_operation_intents')) await gate; return originalGet(sql, args); };
        detachedCall = applyNativeFileOperationMutationOnConnection(database,
          { workspace, action: 'move', operationId: detached.bundle.operationId, mutationId: detached.bundle.mutations[0].mutationId }).catch(error => error);
        return {};
      } }), { code: 'ADMISSION_RECOVERY_REQUIRED' }); release(); await detachedCall;
    assert.equal((await current(detached.state.documentId)).path, detached.state.path); assert.equal(await receiptCount(detached.bundle), 0);

    stage = 'rollback and lost COMMIT before/after durable write';
    const rollback = await seed('rollback'); const rollbackRequest = await requestFor(rollback.bundle);
    await assert.rejects(apply(rollback.bundle, rollbackRequest, async () => { throw new Error('Owned rollback fixture.'); }));
    assert.equal((await current(rollback.state.documentId)).path, rollback.state.path); assert.equal(await receiptCount(rollback.bundle), 0);
    for (const injected of ['before','after'] as const) {
      const item = await seed(`lost-${injected}`); const request = await requestFor(item.bundle); fault = injected;
      if (injected === 'before') { await assert.rejects(apply(item.bundle, request), { code: 'ADMISSION_RECOVERY_REQUIRED' }); assert.equal(await readReceipt(item.bundle, request), null); }
      else { await apply(item.bundle, request); assert(await readReceipt(item.bundle, request)); }
    }

    stage = 'current admitted peer and historical committed clock';
    const peer = await seed('peer', { links: true }); const peerRequest = await requestFor(peer.bundle); fault = 'after-peer';
    pendingPeer = async () => {
      const ownerClient = new Client({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000` }); await ownerClient.connect();
      const session = await createCollaborationRoomOwnerSession(ownerClient);
      try {
        const before = await current(peer.state.documentId); const fence = await session.acquire({ ...peer.bundle.mutations[0].source, path: before.path });
        const doc = new Y.Doc(); try {
          Y.applyUpdate(doc, before.yjsState); doc.getText('content').insert(doc.getText('content').length, '\nLater independent peer.');
          await pool!.query(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,document_sequence=document_sequence+1,persisted_at=persisted_at+1 WHERE document_id=$3`,
          [Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc)), before.documentId]);
        } finally { doc.destroy(); } await session.release(fence);
      } finally { await session.close(); }
    };
    await apply(peer.bundle, peerRequest); const peerReceipt = await readReceipt(peer.bundle, peerRequest); assert(peerReceipt);
    assert.equal(peerReceipt.receipt.after.clock.documentSequence, 8); assert.equal(peerReceipt.currentObservation.clock.documentSequence, 9);
    await apply(peer.bundle, peerRequest); assert.equal((await current(peer.state.documentId)).documentSequence, 9);

    stage = 'private actor/session/Review membership and exact registry/lineage/collision guards';
    for (const field of ['actorSessionId','reviewDigest'] as const) {
      const item = await seed(`binding-${field}`); const request = await requestFor(item.bundle, payload => {
        if (field === 'reviewDigest') payload.reviewDigest = 'a'.repeat(64); else (payload.actor as Record<string, unknown>).actorSessionId = 'other';
      }); await assert.rejects(apply(item.bundle, request), { code: 'NATIVE_FILE_INTENT_CONFLICT' }); assert.equal(await receiptCount(item.bundle), 0);
    }
    const foreign = await seed('foreign-lineage'); const foreignRequest = await requestFor(foreign.bundle);
    await pool.query('UPDATE file_collaboration_lineages SET organization_id=$1 WHERE id=$2', ['foreign', foreign.bundle.mutations[0].lineageId]);
    await assert.rejects(apply(foreign.bundle, foreignRequest), { code: 'NATIVE_FILE_SOURCE_CHANGED' });
    const staleRegistry = await seed('stale-registry'); const staleRegistryRequest = await requestFor(staleRegistry.bundle);
    await pool.query('UPDATE collaboration_documents SET state_version=8 WHERE id=$1', [staleRegistry.state.documentId]);
    await assert.rejects(apply(staleRegistry.bundle, staleRegistryRequest), { code: 'NATIVE_FILE_SOURCE_CHANGED' });
    const collision = await seed('collision');
    await pool.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,path,status,created_at)
      VALUES($1,$2,'personal',$3,'active',100)`, [randomUUID(), workspace.workspaceId, collision.bundle.mutations[0].destinationPath]);
    const collisionRequest = await requestFor(collision.bundle); await assert.rejects(apply(collision.bundle, collisionRequest), { code: 'NATIVE_FILE_DESTINATION_CONFLICT' });
    const active = await seed('active-owner');
    const ownerClient = new Client({ connectionString, options: `-c search_path=${schema}` }); await ownerClient.connect(); const owner = await createCollaborationRoomOwnerSession(ownerClient);
    try {
      await owner.acquire(active.bundle.mutations[0].source); const activeRequest = await requestFor(active.bundle, undefined, false);
      await assert.rejects(apply(active.bundle, activeRequest), { code: 'ADMISSION_CONFLICT' }); assert.equal(await receiptCount(active.bundle), 0);
    } finally { await owner.close(); }

    stage = 'whole bundle completion and deferred endstate';
    const one = await seed('partial-one'); const two = await seed('partial-two'); one.bundle.mutations.push(two.bundle.mutations[0]);
    const partialRequest = await requestFor(one.bundle);
    await assert.rejects(handoff.execute(partialRequest, { authorize: async () => undefined, prepare: async () => undefined,
      mutate: async database => { await applyNativeFileOperationMutationOnConnection(database,
        { workspace, action: 'move', operationId: one.bundle.operationId, mutationId: one.bundle.mutations[0].mutationId }); return { nativeFileReceiptSetProof: 'incomplete' }; } }), { code: 'ADMISSION_RECOVERY_REQUIRED' });
    assert.equal(await receiptCount(one.bundle), 0); assert.equal((await current(one.state.documentId)).path, one.state.path);
    await apply(one.bundle, partialRequest); assert.equal(await receiptCount(one.bundle), 2);

    stage = 'real unchanged graph guard superset receives outcome without a claim, sequence or mutation receipt';
    const guarded = await seed('guarded'); const guard = await seed('real-guard');
    const guardedIntent = await stageNativeFileOperationBundleOnConnection(connection, guarded.bundle);
    const guardedRequest: CollaborationAdmissionRequest = { requestId: guarded.bundle.requestId, actorId: guarded.bundle.actor.actorId,
      action: guarded.bundle.action, actionPayloadText: guardedIntent.actionPayloadText,
      actionDigest: collaborationAdmissionActionDigest(guarded.bundle.action, guardedIntent.actionPayloadText),
      scopes: [guarded.state.path, guarded.bundle.mutations[0].destinationPath!, guard.state.path]
        .map(filePath => ({ workspaceId: workspace.workspaceId, organizationId: null, path: filePath, kind: 'exact' })),
      expectedDocuments: [{ ...guarded.bundle.mutations[0].source, status: 'active' }, { ...guard.bundle.mutations[0].source, status: 'active' }] };
    await admission.reserve(guardedRequest); for (const target of guardedRequest.expectedDocuments) await quiescence.prove(guardedRequest, target.documentId);
    const guardedOutcome = await apply(guarded.bundle, guardedRequest); assert.equal(guardedOutcome.targets.length, 2);
    const unchanged = await current(guard.state.documentId); assert.equal(unchanged.documentSequence, 7); assert.equal(unchanged.checkpointSequence, 7);
    assert(Buffer.from(unchanged.yjsState).equals(Buffer.from(guard.state.yjsState))); assert.equal(await receiptCount(guarded.bundle), 1);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM collaboration_native_file_operation_receipts WHERE document_id=$1', [guard.state.documentId])).rows[0].n), 0);
    const guardTarget = guardedOutcome.targets.find(target => target.documentId === guard.state.documentId); assert(guardTarget);
    assert.equal((JSON.parse(guardTarget.snapshotText) as { documentSequence: number }).documentSequence, 7);

    stage = 'unclaimed guard drift cannot certify a frozen graph';
    const drifted = await seed('guard-drift-mutated'); const driftGuard = await seed('guard-drift-unchanged');
    const driftIntent = await stageNativeFileOperationBundleOnConnection(connection, drifted.bundle);
    const driftRequest: CollaborationAdmissionRequest = { ...guardedRequest, requestId: drifted.bundle.requestId,
      actionPayloadText: driftIntent.actionPayloadText, actionDigest: collaborationAdmissionActionDigest(drifted.bundle.action, driftIntent.actionPayloadText),
      scopes: [drifted.state.path, drifted.bundle.mutations[0].destinationPath!, driftGuard.state.path]
        .map(filePath => ({ workspaceId: workspace.workspaceId, organizationId: null, path: filePath, kind: 'exact' })),
      expectedDocuments: [{ ...drifted.bundle.mutations[0].source, status: 'active' }, { ...driftGuard.bundle.mutations[0].source, status: 'active' }] };
    await admission.reserve(driftRequest); for (const target of driftRequest.expectedDocuments) await quiescence.prove(driftRequest, target.documentId);
    await assert.rejects(apply(drifted.bundle, driftRequest, async database => {
      await database.run('UPDATE collaboration_yjs_states SET document_sequence=document_sequence+1 WHERE document_id=$1', [driftGuard.state.documentId]);
    }));
    assert.equal(await receiptCount(drifted.bundle), 0); assert.equal((await current(drifted.state.documentId)).path, drifted.state.path);
    assert.equal((await current(driftGuard.state.documentId)).documentSequence, 7);

    stage = 'deferred SQL rejects guard drift after the last JS receipt-set proof';
    await assert.rejects(handoff.execute(driftRequest, { authorize: async () => undefined, prepare: async () => undefined,
      mutate: async database => {
        await applyNativeFileOperationMutationOnConnection(database,
          { workspace, action: drifted.bundle.action, operationId: drifted.bundle.operationId, mutationId: drifted.bundle.mutations[0].mutationId });
        const nativeFileReceiptSetProof = await nativeFileOperationReceiptSetProofOnConnection(database, drifted.bundle.action, drifted.bundle.operationId);
        await database.run('UPDATE collaboration_yjs_states SET document_sequence=document_sequence+1 WHERE document_id=$1', [driftGuard.state.documentId]);
        return { nativeFileReceiptSetProof };
      } }), { code: 'ADMISSION_RECOVERY_REQUIRED' });
    assert.equal(await receiptCount(drifted.bundle), 0); assert.equal((await current(driftGuard.state.documentId)).documentSequence, 7);

    stage = 'missing mutation membership and real wrong-generation/foreign mutation targets fail closed';
    for (const variation of ['missing','generation','foreign'] as const) {
      const item = await seed(`membership-${variation}`); const staged = await stageNativeFileOperationBundleOnConnection(connection, item.bundle);
      let expected = { ...item.bundle.mutations[0].source, status: 'active' as const };
      if (variation === 'missing') expected = { ...guard.bundle.mutations[0].source, status: 'active' };
      if (variation === 'generation') {
        await pool.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1', [item.state.documentId]); expected.lifecycleGeneration = 2;
      }
      if (variation === 'foreign') {
        const foreignWorkspace = `foreign-${randomUUID()}`;
        await pool.query('UPDATE collaboration_yjs_states SET workspace_id=$1 WHERE document_id=$2', [foreignWorkspace, item.state.documentId]);
        await pool.query('UPDATE collaboration_documents SET workspace_id=$1 WHERE id=$2', [foreignWorkspace, item.state.documentId]);
        await pool.query('UPDATE file_collaboration_lineages SET workspace_id=$1 WHERE id=$2', [foreignWorkspace, item.bundle.mutations[0].lineageId]); expected.workspaceId = foreignWorkspace;
      }
      const request: CollaborationAdmissionRequest = { requestId: item.bundle.requestId, actorId: item.bundle.actor.actorId, action: item.bundle.action,
        actionPayloadText: staged.actionPayloadText, actionDigest: collaborationAdmissionActionDigest(item.bundle.action, staged.actionPayloadText),
        scopes: [{ workspaceId: expected.workspaceId, organizationId: expected.organizationId, path: expected.path, kind: 'exact' }], expectedDocuments: [expected] };
      await admission.reserve(request); await quiescence.prove(request, expected.documentId);
      await assert.rejects(apply(item.bundle, request), { code: 'NATIVE_FILE_INTENT_CONFLICT' }); assert.equal(await receiptCount(item.bundle), 0);
    }

    stage = 'active foreign agent mutation and forged projection finalization are rejected';
    const busy = await seed('busy-agent'); const busyRequest = await requestFor(busy.bundle);
    await pool.query(`INSERT INTO collaboration_agent_operations(operation_id,document_id,workspace_id,initiated_by_user_id,actor_id,
      idempotency_key,payload_hash,status,base_state_vector,created_at,updated_at) VALUES($1,$2,$3,'other-owner','other-agent',$4,$5,'ready',$6,100,100)`,
    [randomUUID(), busy.state.documentId, workspace.workspaceId, randomUUID(), 'a'.repeat(64), Buffer.from(busy.state.stateVector)]);
    await assert.rejects(apply(busy.bundle, busyRequest), { code: 'NATIVE_FILE_MUTATION_BUSY' }); assert.equal(await receiptCount(busy.bundle), 0);
    const finalized = await seed('forged-finalized'); const finalizedRequest = await requestFor(finalized.bundle);
    await assert.rejects(apply(finalized.bundle, finalizedRequest, async database => {
      await database.run('UPDATE collaboration_file_projections SET finalized=1 WHERE document_id=$1', [finalized.state.documentId]);
    }), { code: 'ADMISSION_RECOVERY_REQUIRED' }); assert.equal(await receiptCount(finalized.bundle), 0);
    assert.equal((await current(finalized.state.documentId)).path, finalized.state.path);

    stage = 'unsafe private clocks and missing private durable receipt never prove success';
    for (const badClock of [Number.MAX_SAFE_INTEGER + 1, -1, null]) {
      const unsafe = structuredClone(guarded.bundle); unsafe.mutations[0].before.documentSequence = badClock as number;
      assert.throws(() => captureNativeFileOperationBundle(unsafe), { code: 'NATIVE_FILE_INVALID_INTENT' });
    }
    stage = 'aggregate private budget rejects before cloning, base64 or full JSON allocation';
    const oversizedUpdate = new Uint8Array(1024 * 1024);
    const sharedMutation = combined.bundle.mutations[0]; assert(sharedMutation.prepared);
    const overBudget = { ...combined.bundle, mutations: Array.from({ length: 60 }, (_, index) => ({ ...sharedMutation,
      mutationId: `budget-${index}`, prepared: { ...sharedMutation.prepared!, update: oversizedUpdate } })) };
    const largeInverse = { ...combined.bundle, mutations: [{ ...sharedMutation,
      prepared: { ...sharedMutation.prepared!, inverseRecipes: new Array(262_145).fill(null) } }] };
    const originalClone = globalThis.structuredClone; let cloneCalls = 0;
    globalThis.structuredClone = ((value, options) => { cloneCalls++; return originalClone(value, options); }) as typeof structuredClone;
    try {
      assert.throws(() => captureNativeFileOperationBundle(overBudget), { code: 'NATIVE_FILE_INVALID_INTENT' });
      assert.throws(() => captureNativeFileOperationBundle(largeInverse), { code: 'NATIVE_FILE_INVALID_INTENT' });
      let invoked = false;
      const accessorBundle = Object.defineProperty({ ...combined.bundle }, 'mutations', { get: () => { invoked = true; return []; }, enumerable: true });
      assert.throws(() => captureNativeFileOperationBundle(accessorBundle), { code: 'NATIVE_FILE_INVALID_INTENT' });
      assert.equal(invoked, false); assert.equal(cloneCalls, 0);
    } finally { globalThis.structuredClone = originalClone; }
    await pool.query('ALTER TABLE collaboration_native_file_operation_receipts DISABLE TRIGGER native_file_receipt_immutable');
    await pool.query('DELETE FROM collaboration_native_file_operation_receipts WHERE operation_id=$1', [guarded.bundle.operationId]);
    await pool.query('ALTER TABLE collaboration_native_file_operation_receipts ENABLE TRIGGER native_file_receipt_immutable');
    assert.equal(await readReceipt(guarded.bundle, guardedRequest), null);
    const captured = captureNativeFileOperationBundle(one.bundle); assert(Buffer.byteLength(captured.actionPayloadText) < 64 * 1024); assert(!captured.actionPayloadText.includes('inverseRecipes'));
    assert(discarded >= 3); console.log('Native file Handoff PG18: combined claim, native identity, immutable private receipts, projection pending, rollback/lost COMMIT/peer and negative authorities passed.');
  } finally {
    for (const client of clients) await client.end().catch(() => undefined);
    await pool?.end(); if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`); await control.end();
    if (previousData === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = previousData;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(`Native file Handoff PostgreSQL fixture failed at ${stage}:`, error instanceof Error ? error.name : 'Unknown',
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'no-code');
  if (error instanceof Error) console.error(error.message.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]').replace(/password\s*=\s*\S+/giu, 'password=[redacted]'));
  if (error instanceof Error) console.error(error.stack?.split('\n').filter(line => /^\s+at /u.test(line)).slice(0, 3).join('\n'));
  process.exitCode = 1; });

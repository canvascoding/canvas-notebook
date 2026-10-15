import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
import { captureCollaborationAdmissionRequest, collaborationAdmissionActionDigest, type CollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { createCollaborationAdmissionQuiescenceService } from '../app/lib/collaboration/room-admission-quiescence';
import { createCollaborationRoomOwnerSession, lockIdentity } from '../app/lib/collaboration/room-owner';
import { createCollaborationAdmissionHandoffService } from '../app/lib/collaboration/room-admission-handoff';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import { COLLABORATION_ROOM_OWNER_UP_SQL, COLLABORATION_ROOM_RELEASE_UP_SQL } from '../app/lib/db/collaboration-room-owner-migration';
import { runNativeFileOperationHandoffMigration } from '../app/lib/db/native-file-operation-handoff-migration';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { prepareNativeLinkMutations } from '../app/lib/markdown/workspace-native-link-mutations';
import { applyNativeFileOperationMutationOnConnection,
  nativeFileOperationReceiptSetProofOnConnection,
  stageNativeFileOperationBundleOnConnection, type NativeFileOperationBundle } from '../app/lib/markdown/native-file-operation-handoff';

import { runNativeFileOperationSideEffectMigration } from '../app/lib/db/native-file-operation-side-effects-migration';
import { runFileGuestTargetBindingMigration } from '../app/lib/db/file-guest-target-migration';
import { captureNativeFileOperationSideEffectsOnConnection, applyNativeFileOperationSideEffectsOnConnection,
  readCommittedNativeFileOperationSideEffectsOnConnection } from '../app/lib/markdown/native-file-operation-side-effects';
import { runNativeFileOperationSideEffectMigration as runLegacySideEffectMigration } from './fixtures/file-guest-target-v1/native-file-operation-side-effects-migration';
import { captureNativeFileOperationSideEffectsOnConnection as captureLegacySideEffects,
  applyNativeFileOperationSideEffectsOnConnection as applyLegacySideEffects } from './fixtures/file-guest-target-v1/native-file-operation-side-effects';

import { inspectArchivedNativeSnapshot } from '../app/lib/collaboration/archived-native-snapshot';
import { runNativeFileRestoreMigration } from '../app/lib/db/native-file-operation-restore-migration';
import { captureNativeRestoreIntent, stageNativeRestoreIntentOnConnection, prepareNativeRestoreOnConnection, applyNativeRestoreOnConnection, readCommittedNativeRestoreOnConnection, type NativeRestoreIntent } from '../app/lib/markdown/native-file-operation-restore';

let stage = 'private local environment';
async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  const envPath = process.env.CANVAS_NATIVE_RESTORE_TEST_ENV_FILE; assert(envPath);
  assert.equal((await stat(envPath)).mode & 0o077, 0);
  const connectionString = parse(await readFile(envPath)).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString); assert(['postgres:','postgresql:'].includes(url.protocol));
  assert(['localhost','127.0.0.1'].includes(url.hostname)); assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `canvas_native_restore_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^canvas_native_restore_[a-f0-9]{32}$/u); assert(schema.length <= 63);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>(); let pool: Pool | undefined; let created = false;
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'canvas-native-restore-'));
  const previousData = process.env.CANVAS_DATA_ROOT; process.env.CANVAS_DATA_ROOT = temporaryRoot;
  let fault: 'before' | 'after' | 'after-peer' | null = null; let pendingPeer: (() => Promise<void>) | null = null;
  let discarded = 0;
  const openConnection = async (): Promise<SqlConnection> => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=4000 -c application_name=canvas-native-restore-test` });
    clients.add(client); await client.connect(); let closed = false; let wrote = false;
    return {
      get: async (sql, values) => (await client.query(sql, values)).rows[0],
      all: async (sql, values) => (await client.query(sql, values)).rows,
      run: async (sql, values) => {
        if (sql.startsWith('INSERT INTO') && sql.includes('collaboration_native_restore_receipts')) wrote = true;
        if (sql === 'COMMIT' && wrote && fault) {
          const injected = fault; fault = null;
          await client.query(injected === 'before' ? 'ROLLBACK' : 'COMMIT');
          throw new Error('Injected lost native file COMMIT reply.');
        }
        try { return { changes: (await client.query(sql, values)).rowCount ?? 0 }; }
        catch (error) {
          if (sql === 'COMMIT' && stage.startsWith('real Combined')) console.error('Owned Restore COMMIT:', (error as Error).message);
          throw error;
        }
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
      'collaboration_file_projections','collaboration_agent_operations','workspace_file_metadata',
      'workspace_file_user_states','file_guest_invitations','public_file_shares','file_locks']) await control.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    pool = new Pool({ connectionString, max: 6, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=4000` });
    assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema);
    // Only the empty owned schema is reset to the genuine pre-migration shape.
    // The shared public schema and all historical records remain untouched.
    await pool.query(`ALTER TABLE file_guest_invitations
      DROP CONSTRAINT IF EXISTS file_guest_target_binding_check,
      DROP COLUMN IF EXISTS lifecycle_generation,
      DROP COLUMN IF EXISTS lineage_id`);
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
    await runNativeFileOperationHandoffMigration(connection);
    await runLegacySideEffectMigration(connection);
    await runNativeFileRestoreMigration(connection); await runNativeFileRestoreMigration(connection);
    const workspace: WorkspaceContext = { workspaceId: `native-file-${randomUUID()}`, workspaceType: 'personal', organizationId: null,
      rootPath: temporaryRoot, legacy: false, status: 'active', actor: { userId: 'owner', role: 'owner' }, permissions: { canRead: true, canWrite: true, canDelete: true,
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
      bundle.mutations[0].before.binaryHash = createHash('sha256').update(state.yjsState).digest('hex');
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
    type Fixture = Awaited<ReturnType<typeof seed>>;
    const privateSentinel = `private-${randomUUID()}`;
    const annotations = async (item: Fixture, options: { foreignLock?: boolean; expiredSource?: boolean; expiredDestination?: boolean; legacy?: boolean } = {}) => {
      const source = item.bundle.mutations[0]; const now = Date.now();
      await pool!.query('INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at) VALUES($1,$2,$3,100,101)',
        [workspace.workspaceId, source.source.path, `Owned title ${privateSentinel}`]);
      await pool!.query(`INSERT INTO workspace_file_user_states(workspace_id,user_id,path,is_favorite,pinned_at,created_at,updated_at)
        VALUES($1,'first-user',$2,1,250,100,101),($1,'second-user',$2,0,300,102,103)`, [workspace.workspaceId, source.source.path]);
      await pool!.query(`INSERT INTO file_guest_invitations(id,workspace_id,path,document_id,email,permission,status,policy_revision,
        created_by_user_id,challenge_hash,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'read','active',3,'owner',$6,100,101)`,
      [`guest-${source.mutationId}`, workspace.workspaceId, source.source.path, source.source.documentId,
        `${privateSentinel}@fixture.invalid`, privateSentinel]);
      if (!options.legacy) await pool!.query('UPDATE file_guest_invitations SET lifecycle_generation=$1,lineage_id=$2 WHERE id=$3',
        [source.source.lifecycleGeneration,source.lineageId,`guest-${source.mutationId}`]);
      await pool!.query(`INSERT INTO public_file_shares(id,token,token_hash,token_preview,workspace_id,workspace_type,workspace_path,
        file_name,file_identity,mime_type,size_bytes,created_by_user_id,policy_revision,created_at,updated_at)
        VALUES($1,$2,$3,'preview',$4,'personal',$5,'fixture.md','native','text/markdown',0,'owner',4,100,101)`,
      [`public-${source.mutationId}`, `${privateSentinel}-${source.mutationId}`, `${privateSentinel}-hash-${source.mutationId}`, workspace.workspaceId, source.source.path]);
      await pool!.query(`INSERT INTO file_locks(id,workspace_id,workspace_type,path,lineage_id,revision_id,locked_by_user_id,
        locked_by_session_id,lock_type,status,expires_at,created_at,updated_at) VALUES($1,$2,'personal',$3,$4,'kept-revision',$5,$6,'edit','active',$7,100,101)`,
      [`lock-${source.mutationId}`, workspace.workspaceId, source.source.path, source.lineageId,
        options.foreignLock ? 'foreign-user' : 'owner', options.foreignLock ? 'foreign-session' : 'session', options.expiredSource ? now - 1000 : now + 120_000]);
      if (options.expiredDestination) await pool!.query(`INSERT INTO file_locks(id,workspace_id,workspace_type,path,locked_by_user_id,
        locked_by_session_id,lock_type,status,expires_at,created_at,updated_at) VALUES($1,$2,'personal',$3,'foreign-user','foreign-session','edit','active',$4,100,101)`,
      [`destination-lock-${source.mutationId}`, workspace.workspaceId, source.destinationPath, now - 1000]);
    };
    const rows = async (item: Fixture) => {
      const source = item.bundle.mutations[0]; const paths = [source.source.path, source.destinationPath].filter(Boolean);
      return {
        metadata: (await pool!.query('SELECT * FROM workspace_file_metadata WHERE workspace_id=$1 AND path=ANY($2::text[]) ORDER BY path', [workspace.workspaceId, paths])).rows,
        users: (await pool!.query('SELECT * FROM workspace_file_user_states WHERE workspace_id=$1 AND path=ANY($2::text[]) ORDER BY user_id', [workspace.workspaceId, paths])).rows,
        guest: (await pool!.query('SELECT * FROM file_guest_invitations WHERE document_id=$1 ORDER BY id', [source.source.documentId])).rows,
        shares: (await pool!.query('SELECT * FROM public_file_shares WHERE id=$1', [`public-${source.mutationId}`])).rows,
        locks: (await pool!.query('SELECT * FROM file_locks WHERE workspace_id=$1 AND path=ANY($2::text[]) ORDER BY id', [workspace.workspaceId, paths])).rows,
      };
    };

    const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const archiveItem = async (item: Fixture, supplemental = true, legacy = false) => {
      const request = await requestFor(item.bundle);
      const outcome = await handoff.execute(request, { authorize: async () => undefined,
        prepare: async database => { if (supplemental) await (legacy ? captureLegacySideEffects : captureNativeFileOperationSideEffectsOnConnection)(database, { workspace, request, operationId: item.bundle.operationId }); },
        mutate: async (database): Promise<Readonly<Record<string, string>>> => {
          for (const mutation of item.bundle.mutations) await applyNativeFileOperationMutationOnConnection(database,
            { workspace, action: 'archive', operationId: item.bundle.operationId, mutationId: mutation.mutationId });
          const nativeFileReceiptSetProof = await nativeFileOperationReceiptSetProofOnConnection(database, 'archive', item.bundle.operationId);
          if (!supplemental) return { nativeFileReceiptSetProof };
          const applied = await (legacy ? applyLegacySideEffects : applyNativeFileOperationSideEffectsOnConnection)(database, { workspace, operationId: item.bundle.operationId });
          return { nativeFileReceiptSetProof, nativeFileSideEffectSetProof: applied.nativeFileSideEffectSetProof };
        } });
      const archived = await current(item.state.documentId), snapshot = inspectArchivedNativeSnapshot(archived);
      const receipt = (await pool!.query('SELECT receipt_digest FROM collaboration_native_file_operation_receipts WHERE operation_id=$1 AND document_id=$2',
        [item.bundle.operationId, item.state.documentId])).rows[0];
      const intent: NativeRestoreIntent = { version: 1, operationId: randomUUID(), mutationId: randomUUID(), requestId: randomUUID(),
        workspaceType: workspace.workspaceType,
        actor: structuredClone(item.bundle.actor), reviewDigest: digest('restore-review'),
        source: { ...item.bundle.mutations[0].source, lifecycleGeneration: archived.lifecycleGeneration }, lineageId: item.bundle.mutations[0].lineageId,
        trashEntryId: item.bundle.mutations[0].trashEntryId!, before: { ...snapshot.version, binaryHash: digest(archived.yjsState) },
        archive: { request: captureCollaborationAdmissionRequest(request).request, operationId: item.bundle.operationId,
          mutationId: item.bundle.mutations[0].mutationId, receiptDigest: receipt.receipt_digest,
          nativeReceiptSetProof: outcome.result.nativeFileReceiptSetProof, sideEffectSetProof: outcome.result.nativeFileSideEffectSetProof ?? '0'.repeat(64) } };
      return { item, intent, archived };
    };
    type Archived = Awaited<ReturnType<typeof archiveItem>>;
    const restoreRequest = async (intent: NativeRestoreIntent, guards: Fixture[] = [], change?: (request: CollaborationAdmissionRequest) => CollaborationAdmissionRequest) => {
      const captured = await stageNativeRestoreIntentOnConnection(connection, intent); assert.equal(captured.executionReady, false);
      let request: CollaborationAdmissionRequest = { requestId: intent.requestId, actorId: intent.actor.actorId, action: 'restore',
        actionPayloadText: captured.actionPayloadText, actionDigest: collaborationAdmissionActionDigest('restore', captured.actionPayloadText),
        scopes: [intent.source, ...guards.map(guard => guard.bundle.mutations[0].source)].map(source => ({ workspaceId: source.workspaceId,
          organizationId: source.organizationId, path: source.path, kind: 'exact' })),
        expectedDocuments: [{ ...intent.source, status: 'archived' }, ...guards.map(guard => ({ ...guard.bundle.mutations[0].source, status: 'active' as const }))] };
      if (change) request = change(request); await admission.reserve(request);
      for (const target of request.expectedDocuments) await quiescence.prove(request, target.documentId);
      return request;
    };
    const restore = async (intent: NativeRestoreIntent, request: CollaborationAdmissionRequest, options: {
      skipPrepare?: boolean; wrapper?: boolean; workspace?: WorkspaceContext; principal?: NativeRestoreIntent['actor'];
      afterPrepare?: (db: SqlConnection) => Promise<void>; afterApply?: (db: SqlConnection) => Promise<void>; badOutcome?: boolean;
    } = {}) => handoff.execute(request, { authorize: async actual => { assert.equal(actual.actorId, intent.actor.actorId); },
      prepare: async database => {
        if (!options.skipPrepare) await prepareNativeRestoreOnConnection(database,
          { request, operationId: intent.operationId, workspace, principal: intent.actor });
        await options.afterPrepare?.(database);
      }, mutate: async database => {
        const applied = await applyNativeRestoreOnConnection(options.wrapper ? { ...database } : database,
          { operationId: intent.operationId, workspace: options.workspace ?? workspace, principal: options.principal ?? intent.actor });
        assert.equal(applied.executionReady, false); assert(!JSON.stringify(applied).includes(privateSentinel));
        await options.afterApply?.(database);
        return { nativeRestoreReceiptSetProof: options.badOutcome ? '0'.repeat(64) : applied.nativeRestoreReceiptSetProof };
      } });
    const readReceipt = async (intent: NativeRestoreIntent, request: CollaborationAdmissionRequest, principal = intent.actor) => {
      const database = await openConnection();
      try { await database.run('BEGIN'); const result = await readCommittedNativeRestoreOnConnection(database,
        { request, operationId: intent.operationId, workspace, principal }); await database.run('COMMIT'); return result; }
      finally { await database.close(new Error('Discarding own restore reader.')); }
    };
    const receiptCount = async (intent: NativeRestoreIntent) => Number((await pool!.query('SELECT count(*) AS n FROM collaboration_native_restore_receipts WHERE operation_id=$1', [intent.operationId])).rows[0].n);
    const stillArchived = async (archived: Archived) => {
      assert.deepEqual(await current(archived.item.state.documentId), archived.archived); assert.equal(await receiptCount(archived.intent), 0);
    };

    stage = 'genuine pre-migration V1 archive receipt survives additive Guest binding migration and current Restore';
    const historical = await seed('historical-before-guest-binding', { archive: true });
    await annotations(historical, { legacy: true });
    assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='file_guest_invitations' AND column_name IN('lineage_id','lifecycle_generation')`, [schema])).rows[0].n), 0);
    const oldArchive = await archiveItem(historical, true, true);
    const historicalBytes = async () => (await pool!.query(`SELECT s.stage_text,s.stage_digest,r.receipt_text,r.receipt_digest,r.stage_digest AS receipt_stage_digest
      FROM collaboration_native_file_operation_side_effect_stages s
      JOIN collaboration_native_file_operation_side_effect_receipts r USING(operation_id) WHERE s.operation_id=$1`, [historical.bundle.operationId])).rows[0];
    const beforeMigration = await historicalBytes();
    assert.equal(Object.hasOwn(JSON.parse(beforeMigration.receipt_text).effects[0].beforeRows.guests[0], 'guestBinding'), false);
    const oldGuest = (await pool.query('SELECT * FROM file_guest_invitations WHERE id=$1', [`guest-${historical.bundle.mutations[0].mutationId}`])).rows[0];
    await runFileGuestTargetBindingMigration(connection); await runFileGuestTargetBindingMigration(connection);
    await runNativeFileOperationSideEffectMigration(connection); await runNativeFileOperationSideEffectMigration(connection);
    assert.deepEqual(await historicalBytes(), beforeMigration);
    assert.deepEqual((await pool.query('SELECT * FROM file_guest_invitations WHERE id=$1', [oldGuest.id])).rows[0],
      { ...oldGuest, lifecycle_generation: null, lineage_id: null });
    const historicalReader = await openConnection();
    try {
      await historicalReader.run('BEGIN');
      const result = await readCommittedNativeFileOperationSideEffectsOnConnection(historicalReader, {
        request: oldArchive.intent.archive.request, operationId: historical.bundle.operationId, actor: historical.bundle.actor });
      assert.equal(result?.nativeFileSideEffectSetProof, oldArchive.intent.archive.sideEffectSetProof);
      await historicalReader.run('COMMIT');
    } finally { await historicalReader.close(new Error('Closing owned migrated historical receipt reader.')); }
    const oldRestoreRequest = await restoreRequest(oldArchive.intent);
    await restore(oldArchive.intent, oldRestoreRequest);
    assert(await readReceipt(oldArchive.intent, oldRestoreRequest));
    assert.deepEqual(await historicalBytes(), beforeMigration);
    assert.deepEqual((await pool.query('SELECT * FROM file_guest_invitations WHERE id=$1', [oldGuest.id])).rows[0],
      { ...oldGuest, lifecycle_generation: null, lineage_id: null });
    assert.equal((await current(historical.state.documentId)).status, 'active');

    stage = 'real Combined+Sideeffects archive followed by identity-preserving native restore';
    for (const rich of [false, true]) {
      const item = await seed(`happy-${rich}`, { archive: true, rich }); await annotations(item);
      const archived = await archiveItem(item), beforeEffects = await rows(item), request = await restoreRequest(archived.intent);
      const outcome = await restore(archived.intent, request), after = await current(item.state.documentId);
      assert.equal(after.status, 'active'); assert.equal(after.lifecycleGeneration, 3); assert.equal(after.documentSequence, 7); assert.equal(after.persistedAt, 100);
      assert(Buffer.from(after.yjsState).equals(Buffer.from(item.state.yjsState))); assert(Buffer.from(after.stateVector).equals(Buffer.from(item.state.stateVector)));
      assert.equal(after.path, item.state.path); assert.equal(after.documentId, item.state.documentId);
      assert.deepEqual(await rows(item), beforeEffects, 'Restore does not resurrect metadata, guest/public grants or locks.');
      const projection: Record<string, unknown> = (await pool!.query('SELECT * FROM collaboration_file_projections WHERE document_id=$1', [after.documentId])).rows[0];
      assert.equal(Number(projection.lifecycle_generation), 3); assert.equal(Number(projection.projected_sequence), 7); assert.equal(Number(projection.finalized), 0); assert.equal(projection.revision_id, null);
      const receipt = await readReceipt(archived.intent, request); assert(receipt); assert.equal(receipt.nativeRestoreReceiptSetProof, outcome.result.nativeRestoreReceiptSetProof);
      assert.equal(receipt.currentObservation.identity.lifecycleGeneration, 3); assert.equal(receipt.receipt.projection.filesystemComplete, false);
      await restore(archived.intent, request); assert.equal(await receiptCount(archived.intent), 1);
      await assert.rejects(readReceipt(archived.intent, request, { ...archived.intent.actor, actorSessionId: 'foreign' }), { code: 'NATIVE_RESTORE_AUTHORITY_REQUIRED' });
      for (const table of ['collaboration_native_restore_intents', 'collaboration_native_restore_receipts']) {
        await assert.rejects(pool.query(`UPDATE ${table} SET operation_id=$1 WHERE operation_id=$2`, [randomUUID(), archived.intent.operationId]), { code: '55000' });
        await assert.rejects(pool.query(`DELETE FROM ${table} WHERE operation_id=$1`, [archived.intent.operationId]), { code: '55000' });
      }
    }
    stage = 'committed restore recovery rejects current registry/lineage drift and orphan rows';
    for (const drift of ['registryPath', 'registryStatus', 'registryType', 'registryOrg', 'registryWorkspace', 'provider', 'initialization',
      'lineageId', 'lineagePath', 'lineageStatus', 'lineageType', 'lineageOrg', 'lineageWorkspace', 'registryOrphan', 'lineageOrphan'] as const) {
      const item = await archiveItem(await seed(`recovery-${drift}`, { archive: true })), request = await restoreRequest(item.intent);
      const confirmed = await restore(item.intent, request);
      const before = await current(item.intent.source.documentId);
      if (drift === 'registryOrphan') await pool.query('UPDATE collaboration_documents SET lineage_id=NULL WHERE id=$1', [before.documentId]);
      else if (drift === 'lineageOrphan') await pool.query('DELETE FROM file_collaboration_lineages WHERE id=$1', [item.intent.lineageId]);
      else if (drift === 'lineageId') {
        const foreignLineage = randomUUID();
        await pool.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,path,status,created_at)
          VALUES($1,$2,'personal',$3,'active',100)`, [foreignLineage, workspace.workspaceId, `${foreignLineage}.md`]);
        await pool.query('UPDATE collaboration_documents SET lineage_id=$1 WHERE id=$2', [foreignLineage, before.documentId]);
      } else {
        const target = drift.startsWith('lineage') ? 'file_collaboration_lineages' : 'collaboration_documents';
        const changes: Record<string, string> = { registryPath: "path='drift.md'", registryStatus: "status='archived'", registryType: "workspace_type='organization'",
          registryOrg: "organization_id='foreign'", registryWorkspace: "workspace_id='foreign'", provider: "provider='excalidraw'", initialization: "yjs_state_lifecycle='never_initialized'",
          lineagePath: "path='drift.md'", lineageStatus: "status='archived',archived_at=100,trash_entry_id='drift-trash'", lineageType: "workspace_type='organization'", lineageOrg: "organization_id='foreign'", lineageWorkspace: "workspace_id='foreign'" };
        await pool.query(`UPDATE ${target} SET ${changes[drift]} WHERE id=$1`, [target === 'file_collaboration_lineages' ? item.intent.lineageId : before.documentId]);
      }
      await assert.rejects(readReceipt(item.intent, request), { code: 'NATIVE_RESTORE_UNCONFIRMED' });
      assert.deepEqual(await current(before.documentId), before, 'Recovery never rewrites a state to match damaged registry metadata.');
      assert.equal(await receiptCount(item.intent), 1, 'The historical committed receipt remains intact.');
      assert.deepEqual(await handoff.readOutcome(request), confirmed, 'Recovery failure cannot erase or reapply the historical outcome.');
    }

    stage = 'historical native receipts prevent deleting the committed document registry row';
    const protectedItem = await archiveItem(await seed('recovery-registry-fk', { archive: true })), protectedRequest = await restoreRequest(protectedItem.intent);
    await restore(protectedItem.intent, protectedRequest);
    await assert.rejects(pool.query('DELETE FROM collaboration_documents WHERE id=$1', [protectedItem.intent.source.documentId]), { code: '23503' });
    assert(await readReceipt(protectedItem.intent, protectedRequest)); assert.equal(await receiptCount(protectedItem.intent), 1);

    stage = 'current registry and lineage remain SHARE-locked until the same reader transaction ends';
    const locked = await archiveItem(await seed('recovery-current-row-locks', { archive: true })), lockedRequest = await restoreRequest(locked.intent);
    await restore(locked.intent, lockedRequest);
    const reader = await openConnection(), rival = await openConnection();
    try {
      await reader.run('BEGIN');
      const confirmed = await readCommittedNativeRestoreOnConnection(reader,
        { request: lockedRequest, operationId: locked.intent.operationId, workspace, principal: locked.intent.actor }); assert(confirmed);
      for (const [table, id] of [['collaboration_documents', locked.intent.source.documentId], ['file_collaboration_lineages', locked.intent.lineageId]] as const) {
        await rival.run('BEGIN'); await rival.run("SET LOCAL lock_timeout='100ms'");
        await assert.rejects(async () => { await rival.run(`UPDATE ${table} SET path=path WHERE id=$1`, [id]); }, { code: '55P03' });
        await rival.run('ROLLBACK');
      }
      await reader.run('COMMIT');
      await rival.run('BEGIN');
      assert.equal((await rival.run('UPDATE collaboration_documents SET path=path WHERE id=$1', [locked.intent.source.documentId]) as { changes: number }).changes, 1);
      assert.equal((await rival.run('UPDATE file_collaboration_lineages SET path=path WHERE id=$1', [locked.intent.lineageId]) as { changes: number }).changes, 1);
      await rival.run('ROLLBACK');
    } finally {
      await Promise.resolve(reader.run('ROLLBACK')).catch(() => undefined); await reader.close(new Error('Discarding owned locked reader.'));
      await Promise.resolve(rival.run('ROLLBACK')).catch(() => undefined); await rival.close(new Error('Discarding owned lock competitor.'));
    }

    stage = 'historical restore recovery follows a real later Combined move and archive';
    const movedItem = await seed('recovery-later-move', { archive: true }), originalArchive = await archiveItem(movedItem);
    const originalRestoreRequest = await restoreRequest(originalArchive.intent); await restore(originalArchive.intent, originalRestoreRequest);
    const beforeMove = await current(movedItem.state.documentId), beforeMoveSnapshot = authoritativeNativeCollaborationSnapshot(beforeMove);
    const destinationPath = 'later-moved-recovery.md';
    const laterMove: NativeFileOperationBundle = { ...movedItem.bundle, operationId: randomUUID(), requestId: randomUUID(), action: 'move',
      mutations: [{ ...movedItem.bundle.mutations[0], mutationId: randomUUID(), kind: 'move',
        source: { ...movedItem.bundle.mutations[0].source, lifecycleGeneration: 3 }, destinationPath, trashEntryId: null,
        registryStateVersion: 0, before: { ...beforeMoveSnapshot.version, binaryHash: digest(beforeMove.yjsState) } }] };
    const moveRequest = await requestFor(laterMove);
    await handoff.execute(moveRequest, { authorize: async () => undefined,
      prepare: database => captureNativeFileOperationSideEffectsOnConnection(database, { workspace, request: moveRequest, operationId: laterMove.operationId }).then(() => undefined),
      mutate: async database => {
        await applyNativeFileOperationMutationOnConnection(database, { workspace, action: 'move', operationId: laterMove.operationId, mutationId: laterMove.mutations[0].mutationId });
        const nativeFileReceiptSetProof = await nativeFileOperationReceiptSetProofOnConnection(database, 'move', laterMove.operationId);
        const effects = await applyNativeFileOperationSideEffectsOnConnection(database, { workspace, operationId: laterMove.operationId });
        return { nativeFileReceiptSetProof, nativeFileSideEffectSetProof: effects.nativeFileSideEffectSetProof };
      } });
    const afterMove = await readReceipt(originalArchive.intent, originalRestoreRequest); assert(afterMove);
    assert.equal(afterMove.receipt.after.identity.path, movedItem.state.path); assert.equal(afterMove.currentObservation.identity.path, destinationPath);
    assert.equal(afterMove.currentObservation.status, 'active'); assert.equal(afterMove.currentObservation.identity.lifecycleGeneration, 3);
    const movedState = await current(movedItem.state.documentId), movedSnapshot = authoritativeNativeCollaborationSnapshot(movedState);
    const laterArchive: Fixture = { state: movedState, bundle: { ...laterMove, operationId: randomUUID(), requestId: randomUUID(), action: 'archive',
      mutations: [{ ...laterMove.mutations[0], mutationId: randomUUID(), kind: 'archive', source: { ...laterMove.mutations[0].source, path: destinationPath },
        destinationPath: null, trashEntryId: 'later-recovery-trash', before: { ...movedSnapshot.version, binaryHash: digest(movedState.yjsState) } }] } };
    await archiveItem(laterArchive);
    const afterArchive = await readReceipt(originalArchive.intent, originalRestoreRequest); assert(afterArchive);
    assert.equal(afterArchive.receipt.after.identity.path, movedItem.state.path); assert.equal(afterArchive.currentObservation.identity.path, destinationPath);
    assert.equal(afterArchive.currentObservation.status, 'archived'); assert.equal(afterArchive.currentObservation.identity.lifecycleGeneration, 4);
    assert.equal((await pool.query('SELECT trash_entry_id FROM file_collaboration_lineages WHERE id=$1', [originalArchive.intent.lineageId])).rows[0].trash_entry_id, 'later-recovery-trash');
    await restore(originalArchive.intent, originalRestoreRequest);
    assert.equal((await current(movedItem.state.documentId)).status, 'archived', 'Completed retry must not replay an old restore after a later archive.');
    assert.equal(await receiptCount(originalArchive.intent), 1);

    stage = 'real unchanged native guard superset; no guard claim, mutation receipt or sequence change';
    const guarded = await archiveItem(await seed('guarded', { archive: true })); const guard = await seed('guard');
    const guardBefore = await current(guard.state.documentId), guardedRequest = await restoreRequest(guarded.intent, [guard]);
    const guardedOutcome = await restore(guarded.intent, guardedRequest); assert.equal(guardedOutcome.targets.length, 2); assert.equal(await receiptCount(guarded.intent), 1);
    assert.deepEqual(await current(guard.state.documentId), guardBefore);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM collaboration_native_restore_receipts WHERE document_id=$1', [guard.state.documentId])).rows[0].n), 0);

    stage = 'missing mutation target and foreign guard cannot borrow a restore intent';
    const omitted = await archiveItem(await seed('omitted-source', { archive: true })), omittedGuard = await seed('omitted-guard');
    const omittedRequest = await restoreRequest(omitted.intent, [omittedGuard], request => ({ ...request,
      expectedDocuments: request.expectedDocuments.filter(document => document.documentId !== omitted.intent.source.documentId) }));
    await assert.rejects(restore(omitted.intent, omittedRequest), { code: 'NATIVE_RESTORE_INVALID' }); await stillArchived(omitted);
    const foreign = await archiveItem(await seed('foreign-guard-source', { archive: true })), foreignGuard = await seed('foreign-guard');
    const foreignWorkspace = `foreign-${randomUUID()}`;
    foreignGuard.bundle.mutations[0].source.workspaceId = foreignWorkspace;
    for (const table of ['collaboration_documents', 'file_collaboration_lineages', 'collaboration_yjs_states']) await pool.query(
      `UPDATE ${table} SET workspace_id=$1 WHERE ${table === 'collaboration_yjs_states' ? 'document_id' : 'id'}=$2`,
      [foreignWorkspace, table === 'file_collaboration_lineages' ? foreignGuard.bundle.mutations[0].lineageId : foreignGuard.state.documentId]);
    const foreignRequest = await restoreRequest(foreign.intent, [foreignGuard]);
    await assert.rejects(restore(foreign.intent, foreignRequest), { code: 'NATIVE_RESTORE_INVALID' }); await stillArchived(foreign);

    stage = 'damaged historical native-set and sideeffect membership fail closed';
    for (const damage of ['missingNative', 'extraNative', 'missingSide'] as const) {
      const item = await seed(`membership-${damage}`, { archive: true });
      let second: Fixture | undefined;
      if (damage === 'missingNative') { second = await seed('membership-second', { archive: true }); item.bundle.mutations.push(second.bundle.mutations[0]); }
      const archived = await archiveItem(item), request = await restoreRequest(archived.intent);
      if (damage === 'missingNative') {
        await pool.query('ALTER TABLE collaboration_native_file_operation_receipts DISABLE TRIGGER native_file_receipt_immutable');
        try { await pool.query('DELETE FROM collaboration_native_file_operation_receipts WHERE operation_id=$1 AND document_id=$2', [item.bundle.operationId, second!.state.documentId]); }
        finally { await pool.query('ALTER TABLE collaboration_native_file_operation_receipts ENABLE TRIGGER native_file_receipt_immutable'); }
      } else if (damage === 'extraNative') {
        const extra = await seed('membership-extra');
        await pool.query('ALTER TABLE collaboration_native_file_operation_receipts DISABLE TRIGGER native_file_receipt_endstate');
        try { await pool.query(`INSERT INTO collaboration_native_file_operation_receipts(operation_id,mutation_id,document_id,request_id,changes_bundle_proof,receipt_text,receipt_digest,after_state_snapshot)
          SELECT operation_id,$2,$3,request_id,changes_bundle_proof,receipt_text,receipt_digest,after_state_snapshot FROM collaboration_native_file_operation_receipts WHERE operation_id=$1`,
          [item.bundle.operationId, randomUUID(), extra.state.documentId]); }
        finally { await pool.query('ALTER TABLE collaboration_native_file_operation_receipts ENABLE TRIGGER native_file_receipt_endstate'); }
      } else {
        await pool.query('ALTER TABLE collaboration_native_file_operation_side_effect_receipts DISABLE TRIGGER native_file_side_effect_receipt_immutable');
        try { await pool.query('DELETE FROM collaboration_native_file_operation_side_effect_receipts WHERE operation_id=$1', [item.bundle.operationId]); }
        finally { await pool.query('ALTER TABLE collaboration_native_file_operation_side_effect_receipts ENABLE TRIGGER native_file_side_effect_receipt_immutable'); }
      }
      await assert.rejects(restore(archived.intent, request)); await stillArchived(archived);
    }
    stage = 'an old genuine Archive→Restore→Archive cycle cannot authorize another restore generation';
    const cycleItem = await seed('old-cycle', { archive: true }), first = await archiveItem(cycleItem);
    await restore(first.intent, await restoreRequest(first.intent));
    const activeAgain = await current(cycleItem.state.documentId), snapshotAgain = authoritativeNativeCollaborationSnapshot(activeAgain);
    const laterItem: Fixture = { state: activeAgain, bundle: { ...cycleItem.bundle, operationId: randomUUID(), requestId: randomUUID(),
      mutations: [{ ...cycleItem.bundle.mutations[0], mutationId: randomUUID(), source: { ...cycleItem.bundle.mutations[0].source, lifecycleGeneration: 3 },
        registryStateVersion: 0, trashEntryId: 'later-owned-trash', before: { ...snapshotAgain.version, binaryHash: digest(activeAgain.yjsState) } }] } };
    const later = await archiveItem(laterItem); assert.equal(later.archived.lifecycleGeneration, 4);
    const staleIntent = { ...first.intent, operationId: randomUUID(), mutationId: randomUUID(), requestId: randomUUID() };
    await assert.rejects(restoreRequest(staleIntent)); assert.equal(await receiptCount(staleIntent), 0);
    const laterRequest = await restoreRequest(later.intent); await restore(later.intent, laterRequest); assert.equal((await current(cycleItem.state.documentId)).lifecycleGeneration, 5);

    stage = 'new deletion-only drift captured before reservation still fails exact archive-after equality';
    const changedBefore = await archiveItem(await seed('before-reservation-delete', { archive: true }));
    const deletedDoc = new Y.Doc(); try {
      Y.applyUpdate(deletedDoc, changedBefore.archived.yjsState); deletedDoc.getText('content').delete(0, 1);
      assert.deepEqual(Y.encodeStateVector(deletedDoc), changedBefore.archived.stateVector);
      await pool.query('UPDATE collaboration_yjs_states SET yjs_state=$1 WHERE document_id=$2', [Buffer.from(Y.encodeStateAsUpdate(deletedDoc)), changedBefore.intent.source.documentId]);
    } finally { deletedDoc.destroy(); }
    await assert.rejects(restore(changedBefore.intent, await restoreRequest(changedBefore.intent)), { code: 'NATIVE_RESTORE_SOURCE_CHANGED' });
    assert.equal(await receiptCount(changedBefore.intent), 0);

    stage = 'missing archive sideeffects, wrong receipt/trash/operation/request/set binding';
    const noSide = await archiveItem(await seed('missing-sideeffects', { archive: true }), false);
    await assert.rejects(restore(noSide.intent, await restoreRequest(noSide.intent)), { code: 'NATIVE_RESTORE_ARCHIVE_UNCONFIRMED' }); await stillArchived(noSide);
    for (const field of ['trash', 'receipt', 'nativeSet', 'sideSet', 'operation', 'archiveRequest'] as const) {
      const item = await archiveItem(await seed(`wrong-${field}`, { archive: true }));
      if (field === 'trash') item.intent.trashEntryId = 'foreign-trash';
      else if (field === 'receipt') item.intent.archive.receiptDigest = 'a'.repeat(64);
      else if (field === 'nativeSet') item.intent.archive.nativeReceiptSetProof = 'a'.repeat(64);
      else if (field === 'sideSet') item.intent.archive.sideEffectSetProof = 'a'.repeat(64);
      else if (field === 'operation') item.intent.archive.operationId = randomUUID();
      else item.intent.archive.request = { ...item.intent.archive.request, requestId: randomUUID() };
      const request = await restoreRequest(item.intent); await assert.rejects(restore(item.intent, request)); await stillArchived(item);
    }
    stage = 'historical commit alone, changed registry/lineage/native/status/org/schema/clocks and binary never authorize restore';
    for (const drift of ['gen', 'seq', 'binary', 'schema', 'org', 'status', 'lineage', 'registry', 'registryType', 'lineageType', 'missing', 'quarantine'] as const) {
      const item = await archiveItem(await seed(`drift-${drift}`, { archive: true }));
      const request = await restoreRequest(item.intent);
      if (drift === 'lineage') await pool.query('UPDATE file_collaboration_lineages SET trash_entry_id=$1 WHERE id=$2', ['foreign', item.intent.lineageId]);
      else if (drift === 'registry') await pool.query('UPDATE collaboration_documents SET state_version=1 WHERE id=$1', [item.intent.source.documentId]);
      else if (drift === 'registryType') await pool.query("UPDATE collaboration_documents SET workspace_type='organization' WHERE id=$1", [item.intent.source.documentId]);
      else if (drift === 'lineageType') await pool.query("UPDATE file_collaboration_lineages SET workspace_type='organization' WHERE id=$1", [item.intent.lineageId]);
      else if (drift === 'missing') await pool.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1', [item.intent.source.documentId]);
      else if (drift === 'binary') {
        const changed = new Y.Doc(); try { Y.applyUpdate(changed, item.archived.yjsState); changed.getText('content').delete(0, 1);
          assert.deepEqual(Y.encodeStateVector(changed), item.archived.stateVector);
          await pool.query('UPDATE collaboration_yjs_states SET yjs_state=$1 WHERE document_id=$2', [Buffer.from(Y.encodeStateAsUpdate(changed)), item.intent.source.documentId]);
        } finally { changed.destroy(); }
      } else {
        const sql = { gen: 'lifecycle_generation=lifecycle_generation+1', seq: 'document_sequence=document_sequence+1', schema: 'schema_version=3',
          org: "organization_id='foreign'", status: "status='active'", quarantine: 'degraded=1' }[drift];
        await pool.query(`UPDATE collaboration_yjs_states SET ${sql} WHERE document_id=$1`, [item.intent.source.documentId]);
      }
      await assert.rejects(restore(item.intent, request)); assert.equal(await receiptCount(item.intent), 0);
    }
    stage = 'target exact/ancestor/descendant registry collisions reject without overwriting';
    for (const collision of ['exact', 'ancestor', 'descendant'] as const) {
      const item = await seed(`${collision}/note`, { archive: true }); const archived = await archiveItem(item); const request = await restoreRequest(archived.intent);
      const target = collision === 'ancestor' ? collision : collision === 'descendant' ? `${item.state.path}/child.md` : item.state.path;
      await pool.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,path,status,created_at) VALUES($1,$2,'personal',$3,'active',100)`, [randomUUID(), workspace.workspaceId, target]);
      await assert.rejects(restore(archived.intent, request), { code: 'NATIVE_RESTORE_DESTINATION_CONFLICT' }); await stillArchived(archived);
    }
    stage = 'forged/wrapped/detached capability, current permissions/session and actual schema/XID';
    const bare = await archiveItem(await seed('bare', { archive: true }));
    await assert.rejects(applyNativeRestoreOnConnection(connection, { workspace, principal: bare.intent.actor, operationId: bare.intent.operationId }), { code: 'NATIVE_RESTORE_AUTHORITY_REQUIRED' });
    for (const bad of ['skip', 'wrapper', 'write', 'delete', 'actor', 'session', 'schema', 'xid'] as const) {
      const item = await archiveItem(await seed(`authority-${bad}`, { archive: true })), request = await restoreRequest(item.intent);
      const options = bad === 'skip' ? { skipPrepare: true } : bad === 'wrapper' ? { wrapper: true }
        : bad === 'write' || bad === 'delete' ? { workspace: { ...workspace, permissions: { ...workspace.permissions, [bad === 'write' ? 'canWrite' : 'canDelete']: false } } }
        : bad === 'actor' ? { principal: { ...item.intent.actor, actorUserId: 'other' } }
        : bad === 'session' ? { principal: { ...item.intent.actor, actorSessionId: 'other' } }
        : { afterPrepare: async (database: SqlConnection) => { await database.run(bad === 'schema' ? 'SET LOCAL search_path=public' : 'COMMIT'); } };
      await assert.rejects(restore(item.intent, request, options)); await stillArchived(item);
    }
    const detached = await archiveItem(await seed('detached', { archive: true })), detachedRequest = await restoreRequest(detached.intent);
    let release!: () => void, pending: Promise<unknown> | undefined; const barrier = new Promise<void>(resolve => { release = resolve; });
    try {
      await assert.rejects(handoff.execute(detachedRequest, { authorize: async () => undefined,
        prepare: async database => { await prepareNativeRestoreOnConnection(database, { workspace, principal: detached.intent.actor, request: detachedRequest, operationId: detached.intent.operationId }); },
        mutate: async database => {
          const get = database.get; database.get = async (sql, values) => { if (sql.includes('current_schema()')) await barrier; return get(sql, values); };
          pending = applyNativeRestoreOnConnection(database, { workspace, principal: detached.intent.actor, operationId: detached.intent.operationId }).catch(error => error);
          return {};
        } }), { code: 'ADMISSION_RECOVERY_REQUIRED' });
    } finally { release(); await pending; }
    await stillArchived(detached);

    stage = 'complete outcome/guard endstate, pending projection and rollback';
    for (const bad of ['throw', 'outcome', 'projection', 'guard', 'quarantine', 'permanent', 'registryType'] as const) {
      const item = await archiveItem(await seed(`endstate-${bad}`, { archive: true })); const guard = await seed(`endstate-guard-${bad}`);
      const request = await restoreRequest(item.intent, [guard]);
      await assert.rejects(restore(item.intent, request, { badOutcome: bad === 'outcome', afterApply: async database => {
        if (bad === 'throw') throw new Error('Owned rollback.');
        if (bad === 'projection') await database.run('UPDATE collaboration_file_projections SET finalized=1 WHERE document_id=$1', [item.intent.source.documentId]);
        if (bad === 'guard') await database.run('UPDATE collaboration_yjs_states SET document_sequence=document_sequence+1 WHERE document_id=$1', [guard.state.documentId]);
        if (bad === 'quarantine') await database.run('UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1', [item.intent.source.documentId]);
        if (bad === 'permanent') await database.run("UPDATE collaboration_yjs_states SET projection_error_permanent=1,projection_error_generation=lifecycle_generation,projection_error_sequence=document_sequence,projection_error_code='COLLABORATION_ROUNDTRIP_UNSTABLE' WHERE document_id=$1", [item.intent.source.documentId]);
        if (bad === 'registryType') await database.run("UPDATE file_collaboration_lineages SET workspace_type='organization' WHERE id=$1", [item.intent.lineageId]);
      } })); await stillArchived(item);
    }
    stage = 'actual active room owner and foreign reservation are not bypassed';
    const ownerCase = await archiveItem(await seed('owner', { archive: true }));
    const ownerClient = new Client({ connectionString, options: `-c search_path=${schema}` }); await ownerClient.connect();
    const owner = await createCollaborationRoomOwnerSession(ownerClient);
    try {
      // An archived row cannot acquire a legitimate owner. A conflicting real
      // backend advisory lease must nevertheless block reservation/quiescence.
      await assert.rejects(owner.acquire(ownerCase.intent.source));
      await ownerClient.query('SELECT pg_advisory_lock($1::bigint)', [lockIdentity(ownerCase.intent.source.documentId).key]);
      await assert.rejects(restoreRequest(ownerCase.intent));
      await ownerClient.query('SELECT pg_advisory_unlock($1::bigint)', [lockIdentity(ownerCase.intent.source.documentId).key]);
      const request = await restoreRequest(ownerCase.intent);
      await assert.rejects(admission.reserve({ ...request, requestId: randomUUID() }), { code: 'ADMISSION_CONFLICT' }); await stillArchived(ownerCase);
    } finally { await owner.close(); }

    stage = 'lost COMMIT before/after, later admitted peer and attributable immutable retry';
    for (const injected of ['before', 'after', 'after-peer'] as const) {
      const item = await archiveItem(await seed(`commit-${injected}`, { archive: true })); const request = await restoreRequest(item.intent); fault = injected;
      if (injected === 'after-peer') pendingPeer = async () => {
        const client = new Client({ connectionString, options: `-c search_path=${schema}` }); await client.connect(); const session = await createCollaborationRoomOwnerSession(client);
        try {
          const before = await current(item.intent.source.documentId), fence = await session.acquire({ ...item.intent.source, lifecycleGeneration: 3 });
          const doc = new Y.Doc(); try { Y.applyUpdate(doc, before.yjsState); doc.getText('content').insert(doc.getText('content').length, '\nLater legitimate peer.');
            await pool!.query('UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,document_sequence=document_sequence+1,persisted_at=persisted_at+1 WHERE document_id=$3',
              [Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc)), before.documentId]);
          } finally { doc.destroy(); } await session.release(fence);
        } finally { await session.close(); }
      };
      if (injected === 'before') { await assert.rejects(restore(item.intent, request), { code: 'ADMISSION_RECOVERY_REQUIRED' }); await stillArchived(item); assert.equal(await readReceipt(item.intent, request), null); }
      else {
        await restore(item.intent, request); const receipt = await readReceipt(item.intent, request); assert(receipt); assert.equal(receipt.receipt.after.clock.documentSequence, 7);
        if (injected === 'after-peer') assert.equal(receipt.currentObservation.clock.documentSequence, 8);
        await restore(item.intent, request); assert.equal(await receiptCount(item.intent), 1);
      }
    }
    stage = 'bounds reject before cloning/getters and compact action payload contains no binary';
    let cloneCalls = 0; const clone = globalThis.structuredClone;
    globalThis.structuredClone = ((value, options) => { cloneCalls++; return clone(value, options); }) as typeof structuredClone;
    try {
      const huge = { ...guarded.intent, before: { ...guarded.intent.before, stateVector: 'A'.repeat(1024 * 1024 + 1) } };
      assert.throws(() => captureNativeRestoreIntent(huge), { code: 'NATIVE_RESTORE_INVALID' });
      let invoked = false; const getter = Object.defineProperty({ ...guarded.intent }, 'actor', { get: () => { invoked = true; return guarded.intent.actor; }, enumerable: true });
      assert.throws(() => captureNativeRestoreIntent(getter), { code: 'NATIVE_RESTORE_INVALID' }); assert.equal(invoked, false); assert.equal(cloneCalls, 0);
    } finally { globalThis.structuredClone = clone; }
    const captured = captureNativeRestoreIntent(guarded.intent); assert(Buffer.byteLength(captured.actionPayloadText) < 64 * 1024);
    assert(!captured.actionPayloadText.includes('stateVector')); assert(discarded >= 3);
    console.log('Native restore PG18: real archive/sideeffects, exact lifecycle+CRDT identity, archived authority, guard superset, immutable complete outcomes, current registry/lineage recovery fences and drift, real later move/archive, rollback and lost-COMMIT later-peer recovery passed; executionReady:false.');
  } finally {
    for (const client of clients) await client.end().catch(() => undefined);
    await pool?.end(); if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`); await control.end();
    if (previousData === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = previousData;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error(`Native restore PostgreSQL fixture failed at ${stage}:`, error instanceof Error ? error.name : 'Unknown',
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'no-code');
  if (error instanceof Error) console.error(error.message.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]').replace(/password\s*=\s*\S+/giu, 'password=[redacted]'));
  if (error instanceof Error) console.error(error.stack?.split('\n').filter(line => /^\s+at /u.test(line)).slice(0, 3).join('\n'));
  process.exitCode = 1;
});

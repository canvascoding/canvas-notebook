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
import { collaborationAdmissionActionDigest, type CollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { createCollaborationAdmissionQuiescenceService } from '../app/lib/collaboration/room-admission-quiescence';
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

type SnapshotRow = Record<string, unknown>;

const FIXTURE_WATCHDOG_MS = 180_000;
let stage = 'module evaluated';
let failureStage: string | undefined;
let fixtureSettled = false;
let fixtureCompleted = false;
let incompleteExitReported = false;

function enterStage(next: string): void {
  // Callers supply static fixture labels, never paths, SQL, IDs, or ENV values.
  stage = next;
  console.log(`Native file side effects PostgreSQL fixture stage: ${stage}`);
}

function guardIncompleteExit(reason: 'beforeExit' | 'exit' | 'watchdog'): void {
  if (fixtureSettled || fixtureCompleted) return;
  if (!incompleteExitReported) console.error(`Native file side effects PostgreSQL fixture INCOMPLETE (${reason}) at ${stage}; cleanup completion is unconfirmed.`);
  incompleteExitReported = true;
  process.exitCode = 1;
}

process.once('beforeExit', () => guardIncompleteExit('beforeExit'));
process.once('exit', () => guardIncompleteExit('exit'));
// An unresolved Promise does not keep Node alive. Keep one bounded reference
// until main settles, and fail rather than report a successful partial run.
const fixtureWatchdog = setTimeout(() => {
  guardIncompleteExit('watchdog');
  process.exit(1);
}, FIXTURE_WATCHDOG_MS);
fixtureWatchdog.ref();

async function main() {
  enterStage('private local environment');
  assert.equal(process.env.NODE_ENV, 'test');
  const envPath = process.env.CANVAS_NATIVE_SIDE_EFFECT_TEST_ENV_FILE; assert(envPath);
  assert.equal((await stat(envPath)).mode & 0o077, 0);
  const connectionString = parse(await readFile(envPath)).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString); assert(['postgres:','postgresql:'].includes(url.protocol));
  assert(['localhost','127.0.0.1'].includes(url.hostname)); assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `canvas_native_side_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^canvas_native_side_test_[a-f0-9]{32}$/u); assert(schema.length <= 63);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>(); let pool: Pool | undefined; let created = false;
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'canvas-native-side-effects-'));
  const previousData = process.env.CANVAS_DATA_ROOT; process.env.CANVAS_DATA_ROOT = temporaryRoot;
  let fault: 'before' | 'after' | 'after-peer' | null = null; let pendingPeer: (() => Promise<void>) | null = null;
  let discarded = 0;
  const openConnection = async (): Promise<SqlConnection> => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=4000 -c application_name=canvas-native-side-effects-test` });
    clients.add(client); await client.connect(); let closed = false; let wrote = false;
    return {
      get: async (sql, values) => (await client.query(sql, values)).rows[0],
      all: async (sql, values) => (await client.query(sql, values)).rows,
      run: async (sql, values) => {
        if (sql.startsWith('INSERT INTO') && sql.includes('collaboration_native_file_operation_side_effect_receipts')) wrote = true;
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
    enterStage('connect local PostgreSQL');
    await control.connect(); const server = (await control.query(`SELECT current_database() AS name,current_setting('server_version_num')::integer AS version,
      to_regclass('public.collaboration_yjs_states') IS NOT NULL AS states`)).rows[0];
    assert.equal(server.name, 'canvas_notebook'); assert.equal(Math.floor(server.version / 10000), 18); assert.equal(server.states, true);
    enterStage('isolated generated schema'); await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    for (const table of ['collaboration_documents','file_collaboration_lineages','collaboration_yjs_states',
      'collaboration_file_projections','collaboration_agent_operations','workspace_file_metadata',
      'workspace_file_user_states','file_guest_invitations','public_file_shares','file_locks']) await control.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
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
    enterStage('isolated schema migrations');
    await pool.query(COLLABORATION_ROOM_OWNER_UP_SQL); await pool.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
    for (const sql of COLLABORATION_ADMISSION_STATEMENTS) await pool.query(sql);
    await runNativeFileOperationHandoffMigration(connection);
    await runFileGuestTargetBindingMigration(connection); await runFileGuestTargetBindingMigration(connection);
    await runNativeFileOperationSideEffectMigration(connection); await runNativeFileOperationSideEffectMigration(connection);
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
    type ApplyOptions = {
      skipStage?: boolean; wrapApply?: boolean; detached?: boolean;
      applyWorkspace?: WorkspaceContext;
      afterCapture?: (database: SqlConnection) => Promise<void>;
      beforeApply?: (database: SqlConnection) => Promise<void>;
      afterApply?: (database: SqlConnection) => Promise<void>;
      forge?: 'title' | 'lock' | 'unknown' | 'nativeProof';
    };
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    const effectProof = (receiptDigest: string) => digest(`canvas.native-file-side-effects.v1\n${receiptDigest}`);
    const privateSentinel = `private-${randomUUID()}`;
    const annotations = async (item: Fixture, options: { foreignLock?: boolean; expiredSource?: boolean; expiredDestination?: boolean } = {}) => {
      const source = item.bundle.mutations[0]; const now = Date.now();
      await pool!.query('INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at) VALUES($1,$2,$3,100,101)',
        [workspace.workspaceId, source.source.path, `Owned title ${privateSentinel}`]);
      await pool!.query(`INSERT INTO workspace_file_user_states(workspace_id,user_id,path,is_favorite,pinned_at,created_at,updated_at)
        VALUES($1,'first-user',$2,1,250,100,101),($1,'second-user',$2,0,300,102,103)`, [workspace.workspaceId, source.source.path]);
      await pool!.query(`INSERT INTO file_guest_invitations(id,workspace_id,path,document_id,email,permission,status,policy_revision,
        created_by_user_id,challenge_hash,created_at,updated_at,lifecycle_generation,lineage_id)
        VALUES($1,$2,$3,$4,$5,'read','active',3,'owner',$6,100,101,$7,$8)`,
      [`guest-${source.mutationId}`, workspace.workspaceId, source.source.path, source.source.documentId,
        `${privateSentinel}@fixture.invalid`, privateSentinel,source.source.lifecycleGeneration,source.lineageId]);
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
    const sideCount = async (bundle: NativeFileOperationBundle) => Number((await pool!.query(
      'SELECT count(*) AS n FROM collaboration_native_file_operation_side_effect_receipts WHERE operation_id=$1', [bundle.operationId])).rows[0].n);
    const apply = async (bundle: NativeFileOperationBundle, request: CollaborationAdmissionRequest, options: ApplyOptions = {}) => {
      let forgedProof: string | undefined; let release!: () => void; let pending: Promise<unknown> | undefined;
      const gate = new Promise<void>(resolve => { release = resolve; });
      try {
        return await handoff.execute(request, { authorize: async actual => { assert.equal(actual.actorId, bundle.actor.actorId); },
          prepare: async database => {
            if (!options.skipStage) assert.deepEqual(await captureNativeFileOperationSideEffectsOnConnection(database,
              { workspace, request, operationId: bundle.operationId }), { version: 1, executionReady: false });
            await options.afterCapture?.(database);
          }, mutate: async (database): Promise<Readonly<Record<string, string>>> => {
            for (const mutation of bundle.mutations) await applyNativeFileOperationMutationOnConnection(database,
              { workspace, action: bundle.action, operationId: bundle.operationId, mutationId: mutation.mutationId });
            await options.beforeApply?.(database);
            if (options.forge) {
              const originalRun = database.run;
              database.run = async (sql, parameters) => {
                if (sql.startsWith('INSERT INTO') && sql.includes('collaboration_native_file_operation_side_effect_receipts')) {
                  const values = [...parameters!]; const receipt = JSON.parse(values[4] as string);
                  if (options.forge === 'title') {
                    receipt.effects[0].afterRows.metadata[0].title = 'forged title';
                    await originalRun('UPDATE workspace_file_metadata SET title=$1 WHERE workspace_id=$2 AND path=$3',
                      ['forged title', workspace.workspaceId, bundle.mutations[0].destinationPath]);
                  } else if (options.forge === 'lock') {
                    receipt.effects[0].afterRows.locks[0].expiresAt += 10_000;
                    await originalRun('UPDATE file_locks SET expires_at=expires_at+10000 WHERE id=$1', [`lock-${bundle.mutations[0].mutationId}`]);
                  } else if (options.forge === 'unknown') receipt.effects[0].afterRows.metadata[0].unknown = 'not allowed';
                  else { receipt.nativeReceiptSetProof = '0'.repeat(64); values[3] = receipt.nativeReceiptSetProof; }
                  values[4] = JSON.stringify(receipt); values[5] = digest(values[4] as string); forgedProof = effectProof(values[5] as string);
                  return originalRun(sql, values);
                }
                return originalRun(sql, parameters);
              };
            }
            if (options.detached) {
              const originalGet = database.get;
              database.get = async (sql, values) => {
                if (sql.includes('current_schema()')) {
                  console.log('Native file side effects PostgreSQL fixture checkpoint: detached persistence reached fixture gate.');
                  await gate;
                }
                return originalGet(sql, values);
              };
              pending = applyNativeFileOperationSideEffectsOnConnection(database, { workspace, operationId: bundle.operationId }).catch(error => error);
              return {};
            }
            const applied = await applyNativeFileOperationSideEffectsOnConnection(options.wrapApply ? { ...database } : database,
              { workspace: options.applyWorkspace ?? workspace, operationId: bundle.operationId }); assert.equal(applied.executionReady, false);
            assert.deepEqual(Object.keys(applied).sort(), ['executionReady','nativeFileSideEffectSetProof','version']);
            assert(!JSON.stringify(applied).includes(privateSentinel));
            await options.afterApply?.(database);
            return { nativeFileReceiptSetProof: await nativeFileOperationReceiptSetProofOnConnection(database, bundle.action, bundle.operationId),
              nativeFileSideEffectSetProof: forgedProof ?? applied.nativeFileSideEffectSetProof };
          } });
      } finally {
        if (options.detached) console.log('Native file side effects PostgreSQL fixture checkpoint: handoff settled; releasing detached fixture gate.');
        release(); await pending;
        if (options.detached) console.log('Native file side effects PostgreSQL fixture checkpoint: detached persistence settled.');
      }
    };
    const committed = async (bundle: NativeFileOperationBundle, request: CollaborationAdmissionRequest, actor = bundle.actor) => {
      const database = await openConnection();
      try { await database.run('BEGIN'); const result = await readCommittedNativeFileOperationSideEffectsOnConnection(database,
        { request, operationId: bundle.operationId, actor }); await database.run('COMMIT'); return result; }
      finally { await database.close(new Error('Discarding owned private side-effects reader.')); }
    };
    const unchanged = async (item: Fixture, before: Awaited<ReturnType<typeof rows>>) => {
      assert.deepEqual(await rows(item), before); assert.equal((await current(item.state.documentId)).path, item.state.path);
      assert.equal(await sideCount(item.bundle), 0);
      assert.equal(Number((await pool!.query('SELECT count(*) AS n FROM collaboration_native_file_operation_side_effect_stages WHERE operation_id=$1',
        [item.bundle.operationId])).rows[0].n), 0);
    };

    enterStage('move/rename transport all annotations; revoke source grants; preserve lock identity and TTL');
    for (const action of ['move','rename'] as const) {
      const item = await seed(action, { rich: true }); item.bundle.action = action; await annotations(item, { expiredDestination: true });
      const before = await rows(item); const request = await requestFor(item.bundle); const outcome = await apply(item.bundle, request);
      const after = await rows(item); const destination = item.bundle.mutations[0].destinationPath;
      assert.deepEqual(after.metadata, before.metadata.map(row => ({ ...row, path: destination })));
      assert.deepEqual(after.users, before.users.map(row => ({ ...row, path: destination })));
      assert.equal(after.guest[0].status, 'revoked'); assert.equal(Number(after.guest[0].policy_revision), 4); assert.equal(after.guest[0].challenge_hash, null);
      assert.equal(after.guest[0].email, before.guest[0].email); assert.equal(after.shares[0].token, before.shares[0].token);
      assert.equal(after.shares[0].status, 'revoked'); assert.equal(Number(after.shares[0].policy_revision), 5); assert.equal(after.shares[0].revoked_reason, 'target_moved');
      assert.equal(after.locks[0].status, 'expired'); assert.equal(after.locks[1].status, 'active'); assert.equal(after.locks[1].path, destination);
      for (const key of ['id','lineage_id','revision_id','expires_at','created_at','locked_by_user_id','locked_by_session_id']) assert.equal(after.locks[1][key], before.locks[1][key]);
      const state = await current(item.state.documentId); assert(Buffer.from(state.yjsState).equals(Buffer.from(item.state.yjsState)));
      assert(Buffer.from(state.stateVector).equals(Buffer.from(item.state.stateVector))); assert.equal(state.documentSequence, 7);
      assert.equal(Number((await pool.query('SELECT finalized FROM collaboration_file_projections WHERE document_id=$1', [state.documentId])).rows[0].finalized), 0);
      const proof = await committed(item.bundle, request); assert(proof); assert.equal(proof.nativeFileSideEffectSetProof, outcome.result.nativeFileSideEffectSetProof);
      assert.deepEqual(Object.keys(proof).sort(), ['executionReady','nativeFileSideEffectSetProof','version']);
      const ledger: string = (await pool.query('SELECT receipt_text FROM collaboration_native_file_operation_side_effect_receipts WHERE operation_id=$1', [item.bundle.operationId])).rows[0].receipt_text;
      for (const forbidden of ['challenge_hash','token_hash','@fixture.invalid','"stateVector"','"yjsState"','"inverseRecipes"']) assert(!ledger.includes(forbidden));
      const titleReceipt: { title: string } = JSON.parse(ledger).effects[0].beforeRows.metadata[0]; assert.equal(titleReceipt.title, before.metadata[0].title);
      await apply(item.bundle, request); assert.equal(await sideCount(item.bundle), 1); assert.deepEqual(await rows(item), after);
      await assert.rejects(committed(item.bundle, request, { ...item.bundle.actor, actorSessionId: 'different-session' }), { code: 'NATIVE_FILE_SIDE_EFFECTS_UNCONFIRMED' });
      for (const table of ['collaboration_native_file_operation_side_effect_stages','collaboration_native_file_operation_side_effect_receipts']) {
        await assert.rejects(pool.query(`UPDATE ${table} SET operation_id=$1 WHERE operation_id=$2`, [randomUUID(), item.bundle.operationId]), { code: '55000' });
        await assert.rejects(pool.query(`DELETE FROM ${table} WHERE operation_id=$1`, [item.bundle.operationId]), { code: '55000' });
      }
    }
    enterStage('archive removes active annotations with private before-image; expires/releases exact locks');
    for (const expiredSource of [false, true]) {
      const item = await seed(`archive-${expiredSource}`, { archive: true, rich: true }); await annotations(item, { expiredSource });
      const before = await rows(item); const request = await requestFor(item.bundle); await apply(item.bundle, request); const after = await rows(item);
      assert.deepEqual(after.metadata, []); assert.deepEqual(after.users, []); assert.equal(after.locks[0].status, expiredSource ? 'expired' : 'released');
      assert.equal(after.locks[0].expires_at, before.locks[0].expires_at); assert.equal(after.guest[0].status, 'revoked'); assert.equal(after.shares[0].revoked_reason, 'target_deleted');
      const archived = await current(item.state.documentId); assert.equal(archived.status, 'archived'); assert.equal(archived.lifecycleGeneration, 2);
      assert(Buffer.from(archived.yjsState).equals(Buffer.from(item.state.yjsState))); assert(await committed(item.bundle, request));
    }
    enterStage('link-only external source and unclaimed guard retain lifecycle side effects');
    const move = await seed('with-link'); const linked = await seed('external-link', { links: true }); const guard = await seed('extra-guard');
    await annotations(move); await annotations(linked); await annotations(guard); const linkedBefore = await rows(linked); const guardBefore = await rows(guard);
    linked.bundle.mutations[0].kind = 'link'; linked.bundle.mutations[0].destinationPath = null; move.bundle.mutations.push(linked.bundle.mutations[0]);
    const staged = await stageNativeFileOperationBundleOnConnection(connection, move.bundle);
    const request: CollaborationAdmissionRequest = { requestId: move.bundle.requestId, actorId: move.bundle.actor.actorId, action: 'move',
      actionPayloadText: staged.actionPayloadText, actionDigest: collaborationAdmissionActionDigest('move', staged.actionPayloadText),
      scopes: [...move.bundle.mutations.flatMap(mutation => [mutation.source.path, mutation.destinationPath].filter((entry): entry is string => entry !== null)), guard.state.path]
        .map(filePath => ({ workspaceId: workspace.workspaceId, organizationId: null, path: filePath, kind: 'exact' })),
      expectedDocuments: [...move.bundle.mutations.map(mutation => ({ ...mutation.source, status: 'active' as const })), { ...guard.bundle.mutations[0].source, status: 'active' }] };
    await admission.reserve(request); for (const doc of request.expectedDocuments) await quiescence.prove(request, doc.documentId);
    await apply(move.bundle, request); assert.deepEqual(await rows(linked), linkedBefore); assert.deepEqual(await rows(guard), guardBefore);
    assert.equal((await current(linked.state.documentId)).documentSequence, 8); assert.equal((await current(guard.state.documentId)).documentSequence, 7);
    assert.equal(JSON.parse((await pool.query('SELECT receipt_text FROM collaboration_native_file_operation_side_effect_receipts WHERE operation_id=$1', [move.bundle.operationId])).rows[0].receipt_text).effects.length, 1);

    enterStage('foreign exact lock, destination annotation, scoped descendants and nonterminal agent reject before native mutation');
    for (const kind of ['foreignLock','foreignSession','destinationLock','foreignPublicScope','foreignGuestDoc','foreignGuestLineage','futureGuestGeneration','unscopedPublic','destinationTitle','destinationFavorite','descendant','agentReady','agentUnknown'] as const) {
      const item = await seed(kind); await annotations(item, { foreignLock: kind === 'foreignLock' });
      if (kind === 'foreignSession') await pool.query('UPDATE file_locks SET locked_by_session_id=\'foreign-session\' WHERE id=$1', [`lock-${item.bundle.mutations[0].mutationId}`]);
      if (kind === 'destinationLock') await pool.query(`INSERT INTO file_locks(id,workspace_id,workspace_type,path,locked_by_user_id,
        locked_by_session_id,lock_type,status,expires_at,created_at,updated_at) VALUES($1,$2,'personal',$3,'owner','session','edit','active',$4,100,101)`,
      [randomUUID(), workspace.workspaceId, item.bundle.mutations[0].destinationPath, Date.now() + 120_000]);
      if (kind === 'foreignPublicScope') await pool.query('UPDATE public_file_shares SET organization_id=\'foreign-organization\' WHERE id=$1', [`public-${item.bundle.mutations[0].mutationId}`]);
      if (kind === 'foreignGuestDoc') await pool.query('UPDATE file_guest_invitations SET document_id=\'foreign-document\' WHERE id=$1', [`guest-${item.bundle.mutations[0].mutationId}`]);
      if (kind === 'foreignGuestLineage') await pool.query('UPDATE file_guest_invitations SET lineage_id=\'foreign-lineage\' WHERE id=$1', [`guest-${item.bundle.mutations[0].mutationId}`]);
      if (kind === 'futureGuestGeneration') await pool.query('UPDATE file_guest_invitations SET lifecycle_generation=lifecycle_generation+1 WHERE id=$1', [`guest-${item.bundle.mutations[0].mutationId}`]);
      if (kind === 'unscopedPublic') await pool.query('UPDATE public_file_shares SET workspace_id=NULL WHERE id=$1', [`public-${item.bundle.mutations[0].mutationId}`]);
      if (kind === 'destinationTitle' || kind === 'descendant') await pool.query('INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at) VALUES($1,$2,\'peer\',100,101)',
        [workspace.workspaceId, kind === 'descendant' ? `${item.state.path}/unexpected.md` : item.bundle.mutations[0].destinationPath]);
      if (kind === 'destinationFavorite') await pool.query('INSERT INTO workspace_file_user_states(workspace_id,user_id,path,is_favorite,created_at,updated_at) VALUES($1,\'peer\',$2,1,100,101)',
        [workspace.workspaceId, item.bundle.mutations[0].destinationPath]);
      if (kind.startsWith('agent')) await pool.query(`INSERT INTO collaboration_agent_operations(operation_id,document_id,workspace_id,initiated_by_user_id,actor_id,
        idempotency_key,payload_hash,status,base_state_vector,created_at,updated_at) VALUES($1,$2,$3,'peer','peer',$4,$5,$6,$7,100,101)`,
      [randomUUID(), item.state.documentId, workspace.workspaceId, randomUUID(), 'a'.repeat(64), kind === 'agentReady' ? 'ready' : 'unclassified-new-state', Buffer.from(item.state.stateVector)]);
      const before = await rows(item); const request = await requestFor(item.bundle);
      await assert.rejects(apply(item.bundle, request), { code: ['foreignLock','foreignSession','destinationLock'].includes(kind) || kind.startsWith('agent') ? 'NATIVE_FILE_SIDE_EFFECTS_BUSY' : 'NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED' });
      await unchanged(item, before);
    }
    enterStage('old unbound and stale bound generations are terminally revoked without regranting authority');
    for (const kind of ['unbound','stale'] as const) {
      const item = await seed(`guest-${kind}`); await annotations(item);
      const mutation = item.bundle.mutations[0], guestId = `guest-${mutation.mutationId}`;
      if (kind === 'unbound') await pool.query('UPDATE file_guest_invitations SET lifecycle_generation=NULL,lineage_id=NULL WHERE id=$1', [guestId]);
      else {
        await pool.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1', [item.state.documentId]);
        mutation.source.lifecycleGeneration = 2;
      }
      const before: SnapshotRow = (await pool.query('SELECT * FROM file_guest_invitations WHERE id=$1', [guestId])).rows[0];
      const request = await requestFor(item.bundle); await apply(item.bundle, request);
      const after: SnapshotRow = (await pool.query('SELECT * FROM file_guest_invitations WHERE id=$1', [guestId])).rows[0];
      assert.equal(Number(after.policy_revision), 4);
      assert.deepEqual(after, { ...before, status: 'revoked', policy_revision: after.policy_revision, challenge_hash: null, updated_at: after.updated_at });
      const receipt = JSON.parse((await pool.query('SELECT receipt_text FROM collaboration_native_file_operation_side_effect_receipts WHERE operation_id=$1', [item.bundle.operationId])).rows[0].receipt_text);
      const oldRow = receipt.effects[0].beforeRows.guests[0], newRow = receipt.effects[0].afterRows.guests[0];
      if (kind === 'unbound') { assert.equal(Object.hasOwn(oldRow, 'guestBinding'), false); assert.equal(Object.hasOwn(newRow, 'guestBinding'), false); }
      else assert.deepEqual(oldRow.guestBinding, { version: 1, lineageId: mutation.lineageId, lifecycleGeneration: 1 });
      assert.deepEqual(newRow.guestBinding, oldRow.guestBinding);
      assert.equal(newRow.preservedRowProof, oldRow.preservedRowProof);
      assert(await committed(item.bundle, request));
    }
    enterStage('actual SQL stage guard rejects a forged future generation or foreign lineage matching the current private row');
    for (const kind of ['future','lineage'] as const) {
      const item = await seed(`guest-sql-${kind}`); await annotations(item);
      const before = await rows(item), request = await requestFor(item.bundle);
      let submitted = false;
      await assert.rejects(handoff.execute(request, { authorize: async () => undefined,
        prepare: async database => {
          const originalRun = database.run;
          database.run = async (sql, parameters) => {
            if (sql.startsWith('INSERT INTO') && sql.includes('collaboration_native_file_operation_side_effect_stages')) {
              const values = [...parameters!], stageRow = JSON.parse(String(values[2]));
              const guest = stageRow.effects[0].beforeRows.guests[0];
              if (kind === 'future') {
                guest.guestBinding.lifecycleGeneration += 1;
                await originalRun('UPDATE file_guest_invitations SET lifecycle_generation=lifecycle_generation+1 WHERE id=$1', [guest.id]);
              } else {
                guest.guestBinding.lineageId = 'foreign-lineage';
                await originalRun('UPDATE file_guest_invitations SET lineage_id=$1 WHERE id=$2', ['foreign-lineage',guest.id]);
              }
              values[2] = JSON.stringify(stageRow); values[3] = digest(String(values[2])); submitted = true;
              return originalRun(sql, values);
            }
            return originalRun(sql, parameters);
          };
          await captureNativeFileOperationSideEffectsOnConnection(database, { workspace, request, operationId: item.bundle.operationId });
        }, mutate: async () => { assert.fail('The actual SQL before-stage guard must prevent mutation.'); },
      }), (error: unknown) => (error as { code?: string }).code === '23514');
      assert.equal(submitted, true); await unchanged(item, before);
    }
    enterStage('historical applied agent operation is retained and never cancelled');
    const history = await seed('history'); await annotations(history); const historicalOperation = randomUUID();
    await pool.query(`INSERT INTO collaboration_agent_operations(operation_id,document_id,workspace_id,initiated_by_user_id,actor_id,
      idempotency_key,payload_hash,status,base_state_vector,created_at,updated_at) VALUES($1,$2,$3,'peer','peer',$4,$5,'persisted_yjs',$6,100,101)`,
    [historicalOperation, history.state.documentId, workspace.workspaceId, randomUUID(), 'a'.repeat(64), Buffer.from(history.state.stateVector)]);
    await apply(history.bundle, await requestFor(history.bundle)); assert.equal((await pool.query('SELECT status FROM collaboration_agent_operations WHERE operation_id=$1', [historicalOperation])).rows[0].status, 'persisted_yjs');

    enterStage('Apply alone rejects fully permitted foreign workspace/organization and rolls back the entire native transaction');
    for (const kind of ['workspace','organization'] as const) {
      const item = await seed(`apply-scope-${kind}`, { rich: true }); await annotations(item);
      const before = await rows(item), nativeBefore = await current(item.state.documentId);
      const nativeRows = async () => Promise.all([
        pool!.query('SELECT * FROM collaboration_documents WHERE id=$1', [item.state.documentId]).then(result => result.rows),
        pool!.query('SELECT * FROM file_collaboration_lineages WHERE id=$1', [item.bundle.mutations[0].lineageId]).then(result => result.rows),
        pool!.query('SELECT * FROM collaboration_file_projections WHERE document_id=$1', [item.state.documentId]).then(result => result.rows),
      ]);
      const nativeRowsBefore = await nativeRows(), request = await requestFor(item.bundle);
      const admissionBefore = await admission.read(request);
      const applyWorkspace: WorkspaceContext = { ...workspace, actor: { userId: item.bundle.actor.actorUserId, role: 'owner' },
        ...(kind === 'workspace' ? { workspaceId: `other-workspace-${randomUUID()}` } : { organizationId: 'other-organization' }) };
      await assert.rejects(apply(item.bundle, request, { applyWorkspace, beforeApply: async database => {
        // Prepare and Combined both used A: actual native changes already exist in this SAME TX before the wrong Apply context arrives.
        const state = await database.get('SELECT path FROM collaboration_yjs_states WHERE document_id=$1', [item.state.documentId]) as { path: string };
        assert.equal(state.path, item.bundle.mutations[0].destinationPath);
        const nativeReceipts = await database.get('SELECT count(*) AS n FROM collaboration_native_file_operation_receipts WHERE operation_id=$1',
          [item.bundle.operationId]) as { n: string }; assert.equal(Number(nativeReceipts.n), 1);
        const capturedStages = await database.get('SELECT count(*) AS n FROM collaboration_native_file_operation_side_effect_stages WHERE operation_id=$1',
          [item.bundle.operationId]) as { n: string }; assert.equal(Number(capturedStages.n), 1);
      } }), { code: 'NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED' });
      await unchanged(item, before); assert.deepEqual(await current(item.state.documentId), nativeBefore);
      assert.deepEqual(await nativeRows(), nativeRowsBefore); assert.deepEqual(await admission.read(request), admissionBefore);
      assert.equal(Number((await pool.query('SELECT count(*) AS n FROM collaboration_native_file_operation_receipts WHERE operation_id=$1',
        [item.bundle.operationId])).rows[0].n), 0);
      assert.equal((await pool.query('SELECT outcome_text FROM collaboration_admission_requests WHERE request_id=$1', [request.requestId])).rows[0].outcome_text, null);
    }

    enterStage('missing stage, wrapper, detached and backend/schema drift fail closed and roll back');
    for (const kind of ['missing','wrapper','detached','schema','backend'] as const) {
      enterStage({ missing: 'fail-closed missing stage', wrapper: 'fail-closed wrapper', detached: 'fail-closed detached persistence',
        schema: 'fail-closed schema drift', backend: 'fail-closed backend drift' }[kind]);
      const item = await seed(kind); await annotations(item); const before = await rows(item); const request = await requestFor(item.bundle);
      const options: ApplyOptions = { skipStage: kind === 'missing', wrapApply: kind === 'wrapper', detached: kind === 'detached' };
      let peer: SqlConnection | undefined;
      if (kind === 'schema') options.beforeApply = async database => { await database.run('SET LOCAL search_path=public'); };
      if (kind === 'backend') options.beforeApply = async database => { peer = await openConnection(); await peer.run('BEGIN'); database.get = peer.get; };
      try { await assert.rejects(apply(item.bundle, request, options), { code: kind === 'missing' || kind === 'wrapper' ? 'NATIVE_FILE_SIDE_EFFECTS_STAGE_REQUIRED'
        : kind === 'detached' ? 'ADMISSION_RECOVERY_REQUIRED' : 'NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED' }); }
      finally { if (peer) await peer.close(new Error('Discarding owned cross-backend fixture.')); }
      await unchanged(item, before);
    }
    enterStage('annotation phantoms before apply and after receipt reject entire native commit');
    for (const timing of ['before','after'] as const) {
      const item = await seed(`phantom-${timing}`); await annotations(item); const before = await rows(item); const request = await requestFor(item.bundle);
      const insert = async (database: SqlConnection) => { await database.run(`INSERT INTO workspace_file_user_states(workspace_id,user_id,path,is_favorite,created_at,updated_at)
        VALUES($1,'new-peer',$2,1,100,101)`, [workspace.workspaceId, item.bundle.mutations[0].destinationPath]); };
      await assert.rejects(apply(item.bundle, request, timing === 'before' ? { beforeApply: insert } : { afterApply: insert }),
        { code: timing === 'before' ? 'NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED' : 'ADMISSION_RECOVERY_REQUIRED' }); await unchanged(item, before);
    }
    enterStage('deferred ledger rejects forged metadata, renewed TTL, unknown attrs and forged native set even if Outcome hash matches');
    for (const forge of ['title','lock','unknown','nativeProof'] as const) {
      const item = await seed(`forged-${forge}`); await annotations(item); const before = await rows(item); const request = await requestFor(item.bundle);
      await assert.rejects(apply(item.bundle, request, { forge }), { code: 'ADMISSION_RECOVERY_REQUIRED' }); await unchanged(item, before);
    }
    enterStage('private full-row proof detects omitted guest/public/lock attributes after receipt with otherwise correct Outcome');
    for (const table of ['file_guest_invitations','public_file_shares','file_locks'] as const) {
      const item = await seed(`opaque-${table}`); await annotations(item); const before = await rows(item); const request = await requestFor(item.bundle);
      await assert.rejects(apply(item.bundle, request, { afterApply: async database => {
        if (table === 'file_guest_invitations') await database.run('UPDATE file_guest_invitations SET email=$1 WHERE id=$2',
          [`modified-${privateSentinel}@fixture.invalid`, `guest-${item.bundle.mutations[0].mutationId}`]);
        else if (table === 'public_file_shares') await database.run('UPDATE public_file_shares SET token=$1 WHERE id=$2',
          [`modified-${privateSentinel}`, `public-${item.bundle.mutations[0].mutationId}`]);
        else await database.run('UPDATE file_locks SET customer_id=$1 WHERE id=$2', ['unexpected-customer', `lock-${item.bundle.mutations[0].mutationId}`]);
      } }), { code: 'ADMISSION_RECOVERY_REQUIRED' }); await unchanged(item, before);
    }
    enterStage('explicit Guest binding remains covered by the deferred receipt when legacy private proof is unchanged');
    for (const kind of ['generation','lineage'] as const) {
      const item = await seed(`binding-receipt-${kind}`); await annotations(item);
      const before = await rows(item), request = await requestFor(item.bundle);
      await assert.rejects(apply(item.bundle, request, { afterApply: async database => {
        const guestId = `guest-${item.bundle.mutations[0].mutationId}`;
        if (kind === 'generation') await database.run('UPDATE file_guest_invitations SET lifecycle_generation=lifecycle_generation+1 WHERE id=$1', [guestId]);
        else await database.run('UPDATE file_guest_invitations SET lineage_id=$1 WHERE id=$2', ['changed-after-receipt',guestId]);
      } }), { code: 'ADMISSION_RECOVERY_REQUIRED' });
      await unchanged(item, before);
    }
    enterStage('unknown metadata schema, relation shadowing and row budget reject before large capture');
    for (const kind of ['newColumn','newGuestColumn','shadow','rowBudget','rawByteBudget','badClock'] as const) {
      const item = await seed(kind); await annotations(item); const request = await requestFor(item.bundle);
      if (kind === 'newColumn') await pool.query('ALTER TABLE workspace_file_metadata ADD COLUMN future_native_value text');
      if (kind === 'newGuestColumn') await pool.query('ALTER TABLE file_guest_invitations ADD COLUMN future_private_value text');
      if (kind === 'rowBudget') await pool.query(`INSERT INTO workspace_file_user_states(workspace_id,user_id,path,is_favorite,created_at,updated_at)
        SELECT $1,'budget-'||n::text,$2,0,100,101 FROM generate_series(1,257) n`, [workspace.workspaceId, item.state.path]);
      if (kind === 'badClock') await pool.query('UPDATE workspace_file_metadata SET updated_at=-1 WHERE workspace_id=$1 AND path=$2', [workspace.workspaceId, item.state.path]);
      if (kind === 'rawByteBudget') await pool.query('UPDATE file_guest_invitations SET assets_json=repeat(\'x\',65537) WHERE id=$1', [`guest-${item.bundle.mutations[0].mutationId}`]);
      const before = await rows(item);
      if (kind === 'shadow') await assert.rejects(handoff.execute(request, { authorize: async () => undefined, prepare: async database => {
        await database.run('CREATE TEMP TABLE workspace_file_metadata (LIKE workspace_file_metadata INCLUDING ALL)');
        await captureNativeFileOperationSideEffectsOnConnection(database, { workspace, request, operationId: item.bundle.operationId });
      }, mutate: async () => ({}) }), { code: 'NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED' });
      else await assert.rejects(apply(item.bundle, request), { code: kind === 'newColumn' || kind === 'newGuestColumn' ? 'NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED' : 'NATIVE_FILE_SIDE_EFFECTS_INVALID' });
      await unchanged(item, before);
      if (kind === 'newColumn') await pool.query('ALTER TABLE workspace_file_metadata DROP COLUMN future_native_value');
      if (kind === 'newGuestColumn') await pool.query('ALTER TABLE file_guest_invitations DROP COLUMN future_private_value');
      if (kind === 'badClock') {
        const result: { rows: Array<{ valid: boolean }> } = await pool.query(`SELECT native_file_side_effect_rows_match($1::jsonb,$2,ARRAY[$3]::text[],false) AS valid`,
          [JSON.stringify({ metadata: [null], userStates: [], guests: [], publicShares: [], locks: [] }), workspace.workspaceId, item.state.path]);
        assert.equal(result.rows[0].valid, false);
      }
    }
    enterStage('real metadata row lock blocks competing writer until commit; absent-row writer fence remains activation gate');
    const concurrent = await seed('concurrent'); await annotations(concurrent); const concurrentRequest = await requestFor(concurrent.bundle);
    let competing: Promise<{ rowCount: number | null }> | undefined; let completed = false; let concurrentClient: Client | undefined;
    await apply(concurrent.bundle, concurrentRequest, { afterCapture: async () => {
      concurrentClient = new Client({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=6000` }); await concurrentClient.connect();
      competing = concurrentClient.query('UPDATE workspace_file_metadata SET title=$1 WHERE workspace_id=$2 AND path=$3',
        ['peer title', workspace.workspaceId, concurrent.state.path]).then(result => { completed = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(completed, false);
    } });
    assert(competing); assert.equal((await competing).rowCount, 0); await concurrentClient!.end();

    enterStage('lost COMMIT rollback and durable-reply loss recover only immutable committed receipts, never replay later peer content');
    for (const injected of ['before','after','after-peer'] as const) {
      const item = await seed(`commit-${injected}`); await annotations(item); const before = await rows(item); const request = await requestFor(item.bundle); fault = injected;
      if (injected === 'after-peer') pendingPeer = async () => {
        const state = await current(item.state.documentId); const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, state.yjsState); doc.getText('content').insert(doc.getText('content').length, '\nLater peer.');
          await pool!.query('UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,document_sequence=document_sequence+1,persisted_at=persisted_at+1 WHERE document_id=$3',
            [Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc)), state.documentId]);
        } finally { doc.destroy(); }
        await pool!.query('UPDATE workspace_file_user_states SET is_favorite=0 WHERE workspace_id=$1 AND user_id=\'first-user\' AND path=$2',
          [workspace.workspaceId, item.bundle.mutations[0].destinationPath]);
      };
      if (injected === 'before') { await assert.rejects(apply(item.bundle, request), { code: 'ADMISSION_RECOVERY_REQUIRED' }); await unchanged(item, before); assert.equal(await committed(item.bundle, request), null); }
      else {
        await apply(item.bundle, request); assert(await committed(item.bundle, request)); const after = await rows(item);
        await apply(item.bundle, request); assert.deepEqual(await rows(item), after); assert.equal(await sideCount(item.bundle), 1);
        if (injected === 'after-peer') { assert.equal((await current(item.state.documentId)).documentSequence, 8); assert.equal(Number(after.users[0].is_favorite), 0); }
      }
    }
    assert(discarded >= 3);
  } catch (error) {
    failureStage = stage;
    throw error;
  } finally {
    enterStage('cleanup dedicated PostgreSQL clients');
    for (const client of clients) await client.end().catch(() => undefined);
    enterStage('cleanup PostgreSQL pool');
    await pool?.end();
    enterStage('cleanup isolated PostgreSQL schema');
    if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    enterStage('cleanup PostgreSQL control connection');
    await control.end();
    enterStage('cleanup owned temporary data');
    if (previousData === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = previousData;
    await rm(temporaryRoot, { recursive: true, force: true });
    enterStage('cleanup complete');
  }
}
void main().then(() => {
  fixtureCompleted = true;
  fixtureSettled = true;
  clearTimeout(fixtureWatchdog);
  console.log('Native file side effects PG18: exact move/rename/archive, private immutable scope receipts, metadata/grant/lock semantics, real row locks, bounds, phantoms, authorities and lost-COMMIT recovery passed; writer phantom activation gate remains open.');
  console.log('Native file side effects PostgreSQL fixture COMPLETED: all assertions and cleanup settled.');
}, error => {
  process.exitCode = 1;
  fixtureSettled = true;
  clearTimeout(fixtureWatchdog);
  console.error(`Native file side effects PostgreSQL fixture failed at ${failureStage ?? stage}; last stage ${stage}:`, error instanceof Error ? error.name : 'Unknown',
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'no-code');
  if (error instanceof Error) console.error(error.message.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]').replace(/password\s*=\s*\S+/giu, 'password=[redacted]'));
  if (error instanceof Error) console.error(error.stack?.split('\n').filter(line => /^\s+at /u.test(line)).slice(0, 3).join('\n'));
});

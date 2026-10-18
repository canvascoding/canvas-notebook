import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { SqlConnection } from '../app/lib/db';
import type { DirectMcpWorkspaceCopyPrincipal } from '../app/lib/mcp/server/document-read-principal';
import type { WorkspaceOperationCopyMcpOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import type { WorkspaceOperationManagedCopyPlan } from '../app/lib/files/workspace-operation-managed-copy-plan';
import type { WorkspaceOperationManagedCopyStageV4 } from '../app/lib/files/workspace-operation-managed-copy-stage';
import type { NativeCopyReceipt } from '../app/lib/collaboration/native-copy-persistence';
import type { ExcalidrawCopyIntent } from '../app/lib/excalidraw-collaboration/copy-contract';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Actual fixture issuer/current MCP principal -> existing Owner -> real PG/FD.
// No verifier, AuthInfo claim, permission, workspace, SQL result, writer or
// publication acknowledgement is substituted. No public Copy handler exists.
const sha = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const xid32 = (value: string) => (BigInt(value) % BigInt('4294967296')).toString();
let currentCase = 'setup', groups = 0, completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
const expectedCode = (wanted: string) => (error: unknown) => {
  assert.equal(error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined, wanted); return true;
};

export async function directMcpNativeCopyOwnerPostgresTest(): Promise<void> {
  const originalBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    process.env.CANVAS_MCP_DIRECT_ENABLED = 'true';
    process.env.CANVAS_MCP_DIRECT_SETTINGS_SOURCE = 'environment';
    process.env.CANVAS_MCP_DIRECT_TOOLS_SOURCE = 'environment';
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'copy_knowledge_source,read_knowledge_source';
    const { auth } = await import('../app/lib/auth');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const pool = getPostgresRuntimeQueryable(); assert(pool);
    const { withDirectMcpWorkspaceCopyPrincipal: capture, withDirectMcpWorkspaceCopyPrincipalOnConnection: phase,
      withDirectMcpDocumentReadPrincipal: captureRead } = await import('../app/lib/mcp/server/document-read-principal');
    const { captureWorkspaceOperationCopyMcpOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { previewWorkspaceNativeCopyOperation: preview, executeWorkspaceNativeCopyOperation: execute } =
      await import('../app/lib/files/workspace-operation-native-copy-owner');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { WorkspaceOperationJournal } = await import('../app/lib/files/workspace-operation-journal');
    const { captureExcalidrawCopyIntent, captureExcalidrawCopyBirthReceipt } = await import('../app/lib/excalidraw-collaboration/copy-data');
    const { importExcalidrawDocumentFile } = await import('../app/lib/excalidraw-collaboration/portable-import');
    const { applyExcalidrawScenePatch } = await import('../app/lib/excalidraw-collaboration/repository');
    const { serializePortableExcalidrawSceneFromReadonlyAssets: portable } = await import('../app/lib/excalidraw-collaboration/portable-serialization');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks: links } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const owner = await readPostgresWorkspaceForActorOnConnection(h.connection,
      resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' }), h.source.workspaceId); assert(owner);
    assert(h.source.permissions.canRead && !h.source.permissions.canWrite); assert(h.destination.permissions.canWrite);
    const clientId = `copy-owner-${crypto.randomUUID()}`, selection = {
      sourceWorkspaceId: h.source.workspaceId, destinationWorkspaceId: h.destination.workspaceId };
    await h.admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
      VALUES($1,$1,'member','Actual Copy owner fixture client',0,'[]',100,100)`, [clientId]);
    await h.admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
      VALUES($1,$2,'member','["knowledge:write","knowledge:read"]','["http://localhost/mcp"]',100,100)`, [crypto.randomUUID(), clientId]);
    for (const workspaceId of [h.source.workspaceId, h.destination.workspaceId]) {
      await h.admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at)
        VALUES($1,'owner',100,100)`, [workspaceId]);
      await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
        VALUES($1,'member',$2,100,100)`, [clientId, workspaceId]);
    }
    const issue = async (sessionId = 'session-member') => {
      const seconds = Math.floor(Date.now() / 1000);
      const result = await auth.api.signJWT({ body: { payload: { sub: 'member', azp: clientId, sid: sessionId,
        iss: 'http://localhost/api/auth', aud: 'http://localhost/mcp', iat: seconds - 1, exp: seconds + 600,
        scope: 'knowledge:read knowledge:write' } } }); assert(result.token); return result.token;
    };
    const authInfo = (token: string): AuthInfo => ({ token, clientId: 'untrusted-dto-client', scopes: [], extra: { userId: 'owner' } });
    const tokenA = await issue(), staging = new WorkspaceOperationStaging(), journal = new WorkspaceOperationJournal();
    const callerOrigin = async (principal: DirectMcpWorkspaceCopyPrincipal): Promise<WorkspaceOperationCopyMcpOrigin> => {
      const client = await pool.connect(); let began = false, discard: Error | undefined;
      const db: SqlConnection = { get: async (s, v) => (await client.query(s, v)).rows[0], all: async (s, v) => (await client.query(s, v)).rows,
        run: async (s, v) => ({ changes: (await client.query(s, v)).rowCount ?? 0 }), close: () => assert.fail('Borrowed Origin B cannot be closed.') };
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
        const origin = await phase(db, principal, async access => captureWorkspaceOperationCopyMcpOrigin({
          userId: access.userId, clientId: access.clientId, sessionId: access.sessionId,
          sourceWorkspace: access.sourceWorkspace, destinationWorkspace: access.destinationWorkspace }));
        await client.query('COMMIT'); began = false; return origin;
      } catch (error) {
        if (began) try { await client.query('ROLLBACK'); }
        catch (rollback) { discard = new AggregateError([error, rollback], 'Actual Origin B rollback failed.'); throw discard; }
        throw error;
      } finally { client.release(discard); }
    };
    const nativeLedger = async (operationId: string) => (await h.admin.query(
      'SELECT *,xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [operationId])).rows[0];
    const sceneLedger = async (operationId: string) => (await h.admin.query(
      'SELECT *,xmin::text AS xmin FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [operationId])).rows[0];
    const blob = (workspaceId: string, hash: string) => path.join(h.dataRoot, 'collaboration-assets/excalidraw', sha(workspaceId).slice(0, 32), hash);
    const sourceRows = async (ids: readonly string[], assetId: string) => (await h.admin.query(`
      SELECT 'native' AS kind,document_id AS id,to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=ANY($1::text[])
      UNION ALL SELECT 'scene',document_id,to_jsonb(s)::text,xmin::text FROM collaboration_excalidraw_states s WHERE document_id=ANY($1::text[])
      UNION ALL SELECT 'registry',id,to_jsonb(d)::text,xmin::text FROM collaboration_documents d WHERE id=ANY($1::text[])
      UNION ALL SELECT 'lineage',id,to_jsonb(l)::text,xmin::text FROM file_collaboration_lineages l WHERE id IN (SELECT lineage_id FROM collaboration_documents WHERE id=ANY($1::text[]))
      UNION ALL SELECT 'asset',file_id,to_jsonb(a)::text,xmin::text FROM collaboration_excalidraw_assets a WHERE workspace_id=$2 AND file_id=$3
      UNION ALL SELECT 'metadata',path,to_jsonb(m)::text,xmin::text FROM workspace_file_metadata m WHERE workspace_id=$2 AND path IN (SELECT path FROM collaboration_documents WHERE id=ANY($1::text[]))
      ORDER BY kind,id`, [ids, h.source.workspaceId, assetId])).rows;
    const snapshot = async () => {
      const rows: Record<string, unknown> = {};
      for (const table of ['workspace_file_operations', 'workspace_file_operation_steps', 'collaboration_native_copy_receipts',
        'collaboration_excalidraw_copy_receipts', 'collaboration_documents', 'file_collaboration_lineages', 'collaboration_yjs_states',
        'collaboration_excalidraw_states', 'collaboration_excalidraw_assets', 'workspace_file_metadata', 'file_revisions']) {
        rows[table] = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM ${table} t ORDER BY to_jsonb(t)::text,t.xmin::text`)).rows;
      }
      return rows;
    };
    const filesystem = async () => {
      const rows: unknown[] = [];
      const visit = async (relative: string): Promise<void> => {
        assert(rows.length < 10000); const full = path.join(h.dataRoot, relative), value = await fs.lstat(full, { bigint: true });
        assert(!value.isSymbolicLink()); const entry = { path: relative, dev: String(value.dev), ino: String(value.ino),
          mode: String(value.mode), uid: String(value.uid), size: String(value.size), nlink: String(value.nlink), mtimeNs: String(value.mtimeNs) };
        rows.push(value.isFile() ? { ...entry, sha256: sha(await fs.readFile(full)) } : entry);
        if (value.isDirectory()) for (const name of (await fs.readdir(full)).sort()) await visit(path.join(relative, name));
      };
      await visit('.'); return rows;
    };
    const seed = async () => {
      const suffix = crypto.randomUUID(), root = `mcp-mixed-${suffix}`, destinationPath = `mcp-copy-${suffix}`, assetId = `png-${suffix}`;
      const png = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), Buffer.from(suffix)]);
      const note = await h.upload(`${root}/note.md`, Buffer.from(`# Note\n[Scene](/${root}/diagram.excalidraw) [Target](target.md) [PDF](manual.pdf)\n`));
      const target = await h.upload(`${root}/target.md`, Buffer.from('# Target\n'));
      const incoming = await h.upload(`${root}-incoming.md`, Buffer.from(`[Original scene](/${root}/diagram.excalidraw)\n`));
      await h.metadata(h.source, `${root}/note.md`, { title: 'MCP shared source title' });
      const pdf = Buffer.from('%PDF-1.7\n\0\xff\n%%EOF', 'binary');
      await fs.mkdir(path.join(h.source.rootPath, root, 'empty'), { recursive: true });
      await fs.writeFile(path.join(h.source.rootPath, root, 'manual.pdf'), pdf, { mode: 0o600, flag: 'wx' });
      const initial = await importExcalidrawDocumentFile({ workspace: owner,
        actor: { userId: 'owner', actorId: 'owner', actorType: 'user', sessionId: 'session-owner' }, path: `${root}/diagram.excalidraw`, content: JSON.stringify({
          type: 'excalidraw', version: 2, elements: [{ id: 'image', type: 'image', fileId: assetId, version: 1, versionNonce: 1, isDeleted: false }],
          appState: { viewBackgroundColor: '#ffffff' }, files: { [assetId]: { id: assetId, mimeType: 'image/png',
            dataURL: `data:image/png;base64,${png.toString('base64')}`, created: 123, version: 2 } } }) });
      const latest = await applyExcalidrawScenePatch({ documentId: initial.documentId, lifecycleGeneration: initial.lifecycleGeneration,
        baseSequence: initial.sceneSequence, messageId: crypto.randomUUID(), actorType: 'user', actorId: 'owner', initiatedByUserId: 'owner',
        elements: [{ id: 'latest', type: 'rectangle', version: 1, versionNonce: 7, isDeleted: false, x: 42 }] });
      for (const name of ['note.md', 'target.md', 'diagram.excalidraw']) await fs.unlink(path.join(h.source.rootPath, root, name));
      await h.admin.query('UPDATE collaboration_excalidraw_assets SET last_referenced_at=456 WHERE workspace_id=$1 AND file_id=$2', [h.source.workspaceId, assetId]);
      const stored = (await h.admin.query('SELECT elements_json,shared_app_state_json,assets_json,canonical_hash FROM collaboration_excalidraw_states WHERE document_id=$1', [initial.documentId])).rows[0];
      const expectedPortable = portable({ elements: stored.elements_json, appState: stored.shared_app_state_json,
        assets: stored.assets_json, canonicalHash: stored.canonical_hash }, [{ metadata: stored.assets_json[0], bytes: png }]);
      const ids = [note.documentId, target.documentId, incoming.documentId, initial.documentId];
      return { operationId: crypto.randomUUID(), root, destinationPath, assetId, png, pdf, ids, initial, latest, expectedPortable,
        selections: [{ sourcePath: root, destinationPath }], sourceBefore: await sourceRows(ids, assetId),
        plan: undefined as WorkspaceOperationManagedCopyPlan | undefined, original: undefined as WorkspaceOperationCopyMcpOrigin | undefined };
    };
    type Job = Awaited<ReturnType<typeof seed>>;
    const invoke = async (job: Job, token = tokenA) => capture(authInfo(token), selection, async mcpPrincipal => {
      const origin = await callerOrigin(mcpPrincipal); job.original ??= origin;
      job.plan ??= await preview({ origin, mcpPrincipal, selections: job.selections });
      assert.equal(job.plan.version, 3);
      const result = await execute({ origin, mcpPrincipal, operationId: job.operationId, expectedPlanId: job.plan.planId, selections: job.selections });
      return { result, current: origin };
    });
    const complete = async (job: Job, result: Awaited<ReturnType<typeof invoke>>['result'], alreadyKnown: boolean) => {
      assert.equal(result.execution.status, 'complete', String(result.execution.errorCode)); assert.equal(result.alreadyKnown, alreadyKnown);
      assert.deepEqual(result.copied, [job.destinationPath]); assert.equal(result.execution.errorCode, null);
      const native = await nativeLedger(job.operationId), scene = await sceneLedger(job.operationId); assert(native && scene?.birth_json);
      const intent = captureExcalidrawCopyIntent(scene.intent_json), birth = captureExcalidrawCopyBirthReceipt(scene.birth_json);
      assert.deepEqual(intent.origin, job.original); assert.deepEqual(birth.intent, intent); assert.equal(intent.documents.length, 1);
      assert.equal(native.actor_user_id, 'member'); assert.equal(native.actor_session_id, job.original!.actor.sessionId);
      assert.equal(native.publication_status, 'published'); assert.equal(scene.xmin, xid32(birth.b2TransactionId));
      const operation = await journal.get(job.operationId); assert(operation); assert.equal(operation.status, 'completed');
      assert.deepEqual(JSON.parse(operation.requestJson).origin, job.original); assert(operation.steps.every(step => step.status === 'applied'));
      assert.equal(operation.steps.length, operation.expectedStepCount);
      const receipt = native.private_result as Omit<NativeCopyReceipt, 'publicationStatus'>; assert.equal(receipt.documents.length, 2);
      for (const clone of receipt.documents) {
        const before = await load(h.connection, clone.source.documentId), after = await load(h.connection, clone.clone.documentId); assert(before && after);
        assert.notEqual(before.documentId, after.documentId); assert.equal(after.workspaceId, h.destination.workspaceId); assert.equal(after.lifecycleGeneration, 1);
        assert.notEqual(clone.clone.lineageId, (await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [before.documentId])).rows[0].lineage_id);
        const sourceClients = Y.decodeStateVector(before.stateVector), targetClients = Y.decodeStateVector(after.stateVector);
        assert([...targetClients.keys()].every(client => !sourceClients.has(client)), 'Native copies have fresh Yjs client identities.');
        const inventory = links(after), previous = links(before); assert(inventory.coverage.complete && previous.coverage.complete);
        const recipes = job.plan!.nativePathPlan.mutations.filter(item => item.source.documentId === before.documentId && item.sourcePathAfter === after.path);
        const literal = (link: typeof inventory.links[number]) => String(link.ref.kind === 'link-mark' ? link.ref.expected.href : link.ref.expected);
        assert.deepEqual(inventory.links.map(literal), previous.links.map(link => recipes.find(recipe => recipe.linkId === link.id)?.nextValue ?? literal(link)));
        await assert.rejects(fs.lstat(path.join(h.destination.rootPath, after.path)), { code: 'ENOENT' });
      }
      const targetScene = intent.documents[0]; assert.notEqual(targetScene.documentId, job.initial.documentId); assert.notEqual(targetScene.lineageId, targetScene.sourceLineageId);
      const actual = (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_excalidraw_states WHERE document_id=$1', [targetScene.documentId])).rows[0]; assert(actual);
      assert.equal(actual.path, `${job.destinationPath}/diagram.excalidraw`); assert.equal(Number(actual.lifecycle_generation), 1);
      assert.equal(Number(actual.scene_sequence), 0); assert.equal(actual.canonical_hash, job.latest.state.canonicalHash); assert.equal(actual.xmin, scene.xmin);
      assert(actual.elements_json.some((item: { id: string }) => item.id === 'latest'));
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_yjs_states WHERE document_id=$1', [targetScene.documentId])).rows[0].n, 0);
      const assets = (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_excalidraw_assets WHERE workspace_id=$1 AND file_id=$2', [h.destination.workspaceId, job.assetId])).rows;
      assert.equal(assets.length, 1); assert.equal(assets[0].content_sha256, sha(job.png)); assert.equal(assets[0].xmin, scene.xmin);
      const publicBlob = blob(h.destination.workspaceId, sha(job.png)), info = await fs.lstat(publicBlob);
      assert.equal(String(info.dev), birth.assetReceipt.blobs[0].identity.dev); assert.equal(String(info.ino), birth.assetReceipt.blobs[0].identity.ino);
      assert.equal(info.nlink, 1); assert.deepEqual(await fs.readFile(publicBlob), job.png);
      assert.deepEqual(await fs.readFile(path.join(h.destination.rootPath, job.destinationPath, 'diagram.excalidraw')), Buffer.from(job.expectedPortable));
      assert.deepEqual(await fs.readFile(path.join(h.destination.rootPath, job.destinationPath, 'manual.pdf')), job.pdf);
      assert.deepEqual(await fs.readdir(path.join(h.destination.rootPath, job.destinationPath, 'empty')), []);
      assert.deepEqual(await sourceRows(job.ids, job.assetId), job.sourceBefore);
      for (const name of ['note.md', 'target.md', 'diagram.excalidraw']) await assert.rejects(fs.lstat(path.join(h.source.rootPath, job.root, name)), { code: 'ENOENT' });
      assert.equal(await staging.loadManagedCopyByOperationId(job.operationId), null); return { native, intent, birth };
    };
    const withRenewed = async <T>(operation: (token: string, sessionId: string) => Promise<T>) => {
      const sessionId = `copy-current-${crypto.randomUUID()}`, now = Date.now();
      await h.admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,'member',$3,$4,$4)`, [sessionId, crypto.randomBytes(32).toString('hex'), now + 3600000, now]);
      const token = await issue(sessionId);
      await h.admin.query(`UPDATE "session" SET expires_at=1 WHERE id='session-member'`);
      try { return await operation(token, sessionId); }
      finally {
        await h.admin.query(`UPDATE "session" SET expires_at=$1 WHERE id='session-member'`, [Date.now() + 3600000]);
        await h.admin.query('DELETE FROM "session" WHERE id=$1', [sessionId]);
      }
    };
    type B1 = { client?: MetadataSqlEvent['client']; xid?: string; intent?: ExcalidrawCopyIntent; stage?: WorkspaceOperationManagedCopyStageV4; fired: boolean };
    const markB1 = async (event: MetadataSqlEvent, job: Job, proof: B1) => {
      if (/^\s*INSERT INTO collaboration_excalidraw_copy_receipts\b/iu.test(event.text) && event.values.includes(job.operationId)) {
        const row = (await event.raw('SELECT intent_json,xmin::text AS xmin FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [job.operationId])).rows[0]; assert(row);
        proof.intent = captureExcalidrawCopyIntent(row.intent_json); proof.client = event.client; proof.xid = proof.intent.b1TransactionId;
        assert.equal(row.xmin, xid32(proof.xid)); const stage = await staging.loadManagedCopyByOperationId(job.operationId); assert(stage); proof.stage = stage;
        assert.deepEqual(stage.origin, job.original); assert.equal(JSON.stringify(stage).includes('mcpPrincipal'), false);
      }
    };
    const group = async (name: string, action: () => Promise<void>) => { currentCase = name; await action(); groups++; console.log(`PASS MCP Copy owner ${groups}: ${name}`); };
    let baseline!: Job;
    await group('actual MCP cross-workspace Copy publishes mixed native/Scene/assets with fresh IDs and unchanged read-only source', async () => {
      baseline = await seed(); const proof: B1 = { fired: false };
      const called = await h.withProbe(event => markB1(event, baseline, proof), () => invoke(baseline));
      const done = await complete(baseline, called.result, false); assert(proof.intent && proof.xid && proof.stage);
      assert.notEqual(done.birth.b2TransactionId, proof.xid);
      const native = done.native.private_result as Omit<NativeCopyReceipt, 'publicationStatus'>;
      for (const clone of native.documents) assert.equal((await h.admin.query('SELECT xmin::text AS xmin FROM collaboration_yjs_states WHERE document_id=$1', [clone.clone.documentId])).rows[0].xmin, xid32(proof.xid));
      assert.equal((await h.admin.query('SELECT title FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [h.destination.workspaceId, `${baseline.destinationPath}/note.md`])).rows[0].title, 'MCP shared source title');
      assert.equal(called.current.actor.sessionId, 'session-member'); assert.equal(called.current.version, 2);
    });
    await group('completed retry uses genuine new SID B and preserves Original A, IDs, SQL xmins, receipts and all filesystem identities', async () => {
      const before = await snapshot(), filesBefore = await filesystem(), originalBytes = JSON.stringify(baseline.original);
      await withRenewed(async (tokenB, sessionB) => {
        const repeated = await invoke(baseline, tokenB); assert.equal(repeated.current.actor.sessionId, sessionB);
        await complete(baseline, repeated.result, true); assert.equal(JSON.stringify(baseline.original), originalBytes);
        await assert.rejects(capture(authInfo(tokenB), selection, mcpPrincipal => execute({ origin: baseline.original!, mcpPrincipal,
          operationId: crypto.randomUUID(), selections: [{ sourcePath: baseline.root, destinationPath: `fresh-old-origin-${crypto.randomUUID()}` }] })),
        expectedCode('NATIVE_COPY_INVALID_REQUEST'), 'Fresh creation cannot claim expired Original A just because a genuine B handle exists.');
        assert.deepEqual(await snapshot(), before); assert.deepEqual(await filesystem(), filesBefore);
      });
    });
    await group('lost actual B1 COMMIT acknowledgement resumes original Stage and fixed Scene/native IDs under fresh SID B', async () => {
      const job = await seed(), proof: B1 = { fired: false };
      const interrupted = await h.withProbe(async event => {
        await markB1(event, job, proof);
        if (!proof.fired && proof.client === event.client && proof.intent && /^\s*COMMIT\s*$/iu.test(event.text)) {
          proof.fired = true;
          const durable = await sceneLedger(job.operationId); assert(durable); assert.equal(durable.xmin, xid32(proof.xid!));
          assert.deepEqual(captureExcalidrawCopyIntent(durable.intent_json), proof.intent); assert.equal(durable.birth_json, null);
          const native = await nativeLedger(job.operationId); assert.equal(native.publication_status, 'native_committed'); assert.equal(native.xmin, xid32(proof.xid!));
          throw Object.assign(new Error('Actual owned B1 COMMIT ACK lost after committed rows are independently visible.'), { code: 'EIO' });
        }
      }, () => invoke(job));
      assert(proof.fired && proof.intent && proof.stage); assert.equal(interrupted.result.execution.status, 'needs_recovery');
      assert.equal(interrupted.result.execution.errorCode, 'NATIVE_COPY_COMMIT_UNCONFIRMED'); assert.deepEqual(interrupted.result.copied, []);
      const retained = await staging.loadManagedCopyByOperationId(job.operationId); assert(retained); assert.equal(retained.payloadSha256, proof.stage.payloadSha256);
      const initial = await nativeLedger(job.operationId), c3 = initial.private_result as Omit<NativeCopyReceipt, 'publicationStatus'>;
      const born = c3.documents.map(item => item.clone.documentId);
      const originalStates = (await h.admin.query('SELECT to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=ANY($1::text[]) ORDER BY document_id', [born])).rows;
      for (const doc of proof.intent.documents) assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_excalidraw_states WHERE document_id=$1', [doc.documentId])).rows[0].n, 0);
      await withRenewed(async (tokenB, sessionB) => {
        const resumed = await invoke(job, tokenB); assert.equal(resumed.current.actor.sessionId, sessionB);
        const done = await complete(job, resumed.result, true); assert.deepEqual(done.intent, proof.intent);
        assert.deepEqual(done.native.private_result, initial.private_result);
        assert.deepEqual((await h.admin.query('SELECT to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=ANY($1::text[]) ORDER BY document_id', [born])).rows, originalStates);
      });
    });
    await group('real destination grant revoked after B1 denies B2 and retains only owned recoverable originals until fresh authorization', async () => {
      const job = await seed(), proof: B1 = { fired: false }; let enteredAfterRevoke = false;
      await assert.rejects(h.withProbe(async event => {
        await markB1(event, job, proof);
        if (!proof.fired && proof.client === event.client && proof.intent && /^\s*COMMIT\s*$/iu.test(event.text)) {
          assert.equal((await nativeLedger(job.operationId)).publication_status, 'native_committed');
          assert.equal((await h.admin.query('DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1 AND user_id=$2 AND workspace_id=$3',
            [clientId, 'member', h.destination.workspaceId])).rowCount, 1); proof.fired = true;
        } else if (proof.fired && /^\s*(INSERT|UPDATE)\s+(?:INTO\s+)?(?:"?\w+"?\.)?"?collaboration_excalidraw_(states|assets)\b/iu.test(event.text)) enteredAfterRevoke = true;
      }, () => invoke(job)), expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
      assert(proof.fired && proof.intent && proof.stage); assert.equal(enteredAfterRevoke, false);
      const denied = await sceneLedger(job.operationId); assert(denied); assert.equal(denied.birth_json, null); assert.deepEqual(captureExcalidrawCopyIntent(denied.intent_json), proof.intent);
      assert.equal((await nativeLedger(job.operationId)).publication_status, 'native_committed');
      assert.notEqual((await journal.get(job.operationId))?.status, 'completed');
      for (const doc of proof.intent.documents) assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_excalidraw_states WHERE document_id=$1', [doc.documentId])).rows[0].n, 0);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_excalidraw_assets WHERE workspace_id=$1 AND file_id=$2', [h.destination.workspaceId, job.assetId])).rows[0].n, 0);
      const retained = await staging.loadManagedCopyByOperationId(job.operationId); assert(retained); assert.equal(retained.payloadSha256, proof.stage.payloadSha256);
      const manifest = path.join(path.dirname(blob(h.destination.workspaceId, sha(job.png))), proof.intent.assetOriginal.privateDirectory.name, 'original.json');
      const manifestStat = await fs.lstat(manifest, { bigint: true }); assert(manifestStat.isFile());
      assert.equal(String(manifestStat.dev), proof.intent.assetOriginal.manifestIdentity.dev);
      assert.equal(String(manifestStat.ino), proof.intent.assetOriginal.manifestIdentity.ino);
      assert.equal(object(JSON.parse(await fs.readFile(manifest, 'utf8'))).originalProof, proof.intent.assetOriginal.originalProof);
      await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
        VALUES($1,'member',$2,100,100)`, [clientId, h.destination.workspaceId]);
      await withRenewed(async tokenB => { const resumed = await invoke(job, tokenB); const done = await complete(job, resumed.result, true); assert.deepEqual(done.intent, proof.intent); });
    });
    await group('missing, forged, inactive and real wrong-brand handles reject before any Owner pool acquisition or durable change', async () => {
      const origin = baseline.original!; assert(origin);
      const before = await snapshot(), filesBefore = await filesystem(), descriptor = Object.getOwnPropertyDescriptor(pool, 'connect'), originalConnect = pool.connect;
      let checking = false, acquisitions = 0;
      Object.defineProperty(pool, 'connect', { configurable: true, writable: true, value: (...args: unknown[]) => {
        if (checking) acquisitions++; return Reflect.apply(originalConnect, pool, args);
      } });
      const noPool = async (operation: () => Promise<unknown>, code: string) => {
        acquisitions = 0; checking = true;
        try { await assert.rejects(operation(), expectedCode(code)); } finally { checking = false; }
        assert.equal(acquisitions, 0, 'Invalid live authority is rejected before Owner checkout.');
      };
      try {
        const selections = baseline.selections;
        await noPool(() => preview({ origin, selections }), 'NATIVE_COPY_INVALID_REQUEST');
        await noPool(() => preview({ origin, selections, mcpPrincipal: Object.freeze({}) as DirectMcpWorkspaceCopyPrincipal }), 'MCP_READ_PRINCIPAL_REQUIRED');
        let escaped: DirectMcpWorkspaceCopyPrincipal | undefined;
        await capture(authInfo(tokenA), selection, async principal => { escaped = principal; }); assert(escaped);
        await noPool(() => preview({ origin, selections, mcpPrincipal: escaped! }), 'MCP_READ_PRINCIPAL_REQUIRED');
        await assert.rejects(captureRead(authInfo(tokenA), { workspaceId: h.source.workspaceId, purpose: 'read' }, () => undefined,
          async readPrincipal => noPool(() => preview({ origin, selections, mcpPrincipal: readPrincipal as unknown as DirectMcpWorkspaceCopyPrincipal }),
            'MCP_READ_PRINCIPAL_REQUIRED')), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      } finally { if (descriptor) Object.defineProperty(pool, 'connect', descriptor); else Reflect.deleteProperty(pool, 'connect'); }
      assert.deepEqual(await snapshot(), before); assert.deepEqual(await filesystem(), filesBefore);
    });
  }); } finally { if (originalBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = originalBase; }
  assert.equal(groups, 5); completed = true;
  console.log(`Direct MCP native Copy Owner: ${groups}/5 actual JWT/PG/FD families; no public tool, SDK, TCP, compiled OAuth or browser acceptance.`);
}

void directMcpNativeCopyOwnerPostgresTest().catch(error => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  console.error('MCP Copy Owner failure:', { currentCase, groups, name: error instanceof Error ? error.name : typeof error,
    code: typeof code === 'string' && /^[A-Za-z0-9_]{1,96}$/u.test(code) ? code : undefined,
    frames: error instanceof Error ? error.stack?.split('\n').slice(1).map(line => line.trim()).filter(line => line.startsWith('at ')).slice(0, 6) : undefined });
  process.exitCode = 1;
});

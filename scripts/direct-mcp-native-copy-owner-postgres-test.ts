import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Notification } from 'pg';
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
// publication acknowledgement is substituted. Public tools and SDK have separate acceptance suites.
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
    const { previewWorkspaceNativeCopyOperation: preview, executeWorkspaceNativeCopyOperation: execute,
      recoverWorkspaceNativeCopyOperation: recover } =
      await import('../app/lib/files/workspace-operation-native-copy-owner');
    const { readMcpWorkspaceNativeCopyOperationStatus: readStatus, assertNativeCopyStatusSessionOnConnection } =
      await import('../app/lib/files/workspace-operation-native-copy-status');
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
    const issue = async (sessionId = 'session-member', actualClientId = clientId) => {
      const seconds = Math.floor(Date.now() / 1000);
      const result = await auth.api.signJWT({ body: { payload: { sub: 'member', azp: actualClientId, sid: sessionId,
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
    // Actual complete native-operation table census, including admissions and
    // link/checkpoint receipts. Auth/session mutations in the fixtures are not
    // domain writes; every selected table's actual rows and xmins are retained.
    const domainSnapshot = async () => {
      const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'
        AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)' OR c.relname='file_revisions')
        ORDER BY c.relname LIMIT 513`, [h.schema])).rows;
      assert(tables.length > 11 && tables.length <= 512);
      const rows: Record<string, unknown> = {};
      for (const table of tables) {
        assert.equal(typeof table.relname, 'string'); assert.equal(typeof table.oid, 'string');
        const name = `"${String(table.relname).replaceAll('"', '""')}"`;
        const actual = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM ${name} t
          ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows;
        assert(actual.length <= 10000); rows[table.relname] = actual;
      }
      return { tables, rows };
    };
    const withoutStatusDml = async <T>(operation: () => Promise<T>, observe?: (event: MetadataSqlEvent) => Promise<void>): Promise<T> => {
      const writes: string[] = []; let statements = 0;
      const result = await h.withProbe(async event => {
        assert(++statements <= 5000);
        // Observe actual statements after execution; CTE DML is included. No
        // SQL result, writer, verifier or permission is replaced by this probe.
        if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/iu.test(event.text)
          || /\bpg_notify\s*\(/iu.test(event.text)) writes.push(event.text);
        await observe?.(event);
      }, operation);
      assert(statements > 0); assert.deepEqual(writes, [], 'Pure status must issue no actual DML or DDL.'); return result;
    };
    const filesystem = async () => {
      const rows: unknown[] = [];
      const visit = async (relative: string): Promise<void> => {
        assert(rows.length < 10000); const full = path.join(h.dataRoot, relative), value = await fs.lstat(full, { bigint: true });
        assert(!value.isSymbolicLink()); const entry = { path: relative, dev: String(value.dev), ino: String(value.ino),
          mode: String(value.mode), uid: String(value.uid), size: String(value.size), nlink: String(value.nlink),
          mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs) };
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
    const recoverJob = async (job: Job, token: string) => capture(authInfo(token), selection, async mcpPrincipal => {
      assert(job.original && job.plan);
      const origin = await callerOrigin(mcpPrincipal);
      const result = await recover({ origin, mcpPrincipal, operationId: job.operationId,
        expectedPlanId: job.plan.planId, selections: job.selections });
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
    // This helper owns the sole fixture probe. The product channel is never
    // used for a test barrier, and source-workspace hints are rejected.
    const observeNativeCopyTerminalNotifications = async <T>(job: Job, mode: 'committed' | 'rollback' | 'none',
      operation: () => Promise<T>, loseCommitAck = false): Promise<T> => {
      const productChannel = 'canvas_workspace_files', payload = JSON.stringify({ workspaceId: h.destination.workspaceId });
      const controlChannel = `canvas_copy_notify_${crypto.randomBytes(12).toString('hex')}`, barrier = crypto.randomUUID();
      const sql = `SELECT 'journal' AS kind,to_jsonb(t)::text AS body,xmin::text AS xmin FROM workspace_file_operations t WHERE operation_id=$1
        UNION ALL SELECT 'native',to_jsonb(t)::text,xmin::text FROM collaboration_native_copy_receipts t WHERE operation_id=$1
        UNION ALL SELECT 'scene',to_jsonb(t)::text,xmin::text FROM collaboration_excalidraw_copy_receipts t WHERE operation_id=$1 ORDER BY kind`;
      const packets: Notification[] = [];
      const subscriberPid = Number((await h.admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      assert(Number.isSafeInteger(subscriberPid) && subscriberPid > 0);
      let selected: MetadataSqlEvent['client'] | undefined, observed: { rows: unknown; pid: number; start: string; xid: string } | undefined;
      let before: unknown, terminal = false, barrierSeen = false, notifyCalls = 0, listenerFailure: unknown;
      let failed = false, failure: unknown, result!: T, probeStage = 'listen';
      const rollbackFault = Object.assign(new Error('FIXTURE_COPY_TERMINAL_NOTIFY_ROLLBACK'), { code: 'FIXTURE_COPY_TERMINAL_NOTIFY_ROLLBACK' });
      const onNativeCopyTerminalNotification = (message: Notification): void => {
        try {
          if (message.channel === controlChannel && message.payload === barrier) {
            assert.equal(message.processId, observed?.pid ?? subscriberPid); barrierSeen = true; return;
          }
          if (message.channel !== productChannel || message.payload !== payload
            && message.payload !== JSON.stringify({ workspaceId: h.source.workspaceId })) return;
          const value = JSON.parse(message.payload);
          if (value?.workspaceId !== h.source.workspaceId && value?.workspaceId !== h.destination.workspaceId) return;
          assert.deepEqual(value, { workspaceId: h.destination.workspaceId }, 'Copy invalidates destination only.');
          assert(packets.length < 8); packets.push(message);
        } catch (error) { listenerFailure ??= error; }
      };
      h.admin.on('notification', onNativeCopyTerminalNotification);
      try {
        await h.admin.query(`LISTEN ${productChannel}`); await h.admin.query(`LISTEN ${controlChannel}`);
        try { result = await h.withProbe(async event => {
          if (/\bpg_notify\s*\(/iu.test(event.text)) {
            // Mixed Copy also emits the existing Scene lifecycle channel. It
            // is a separate real event, not a workspace-files terminal hint.
            if (event.text.trim() === "SELECT pg_notify('canvas_excalidraw_scene',json_build_object(\n    'documentId',document_id,'sceneSequence',scene_sequence)::text) FROM collaboration_excalidraw_states\n    WHERE workspace_id=$1 AND EXISTS (SELECT 1 FROM unnest($2::text[]) scope(path)\n      WHERE collaboration_excalidraw_states.path=scope.path\n        OR left(collaboration_excalidraw_states.path,char_length(scope.path)+1)=scope.path||'/')") {
              assert.notEqual(mode, 'none', 'Historical Copy must execute no Notify statement.');
              assert.equal(event.values.length, 2); assert.equal(event.values[0], h.destination.workspaceId);
              assert(Array.isArray(event.values[1]) && event.values[1].length > 0
                && event.values[1].every(value => typeof value === 'string'));
              return;
            }
            probeStage = 'notify-arguments';
            assert.notEqual(mode, 'none', 'Historical Copy must execute no Notify statement.');
            assert.deepEqual(event.values, [productChannel, payload]); assert.equal(++notifyCalls, 1);
            selected = event.client; probeStage = 'notify-witness';
            const witness = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
              pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
            assert.equal(witness.schema, h.schema); assert(witness.xid); assert.notEqual(Number(witness.pid), subscriberPid); assert.equal(packets.length, 0);
            probeStage = 'publication-rows';
            const rows = (await event.raw(sql, [job.operationId])).rows; assert.equal(rows.length, 3);
            const journalRow = JSON.parse(rows.find(row => row.kind === 'journal')!.body);
            const native = JSON.parse(rows.find(row => row.kind === 'native')!.body);
            const scene = JSON.parse(rows.find(row => row.kind === 'scene')!.body);
            assert.equal(journalRow.operation_id, job.operationId); assert.equal(journalRow.status, 'completed');
            assert.equal(native.operation_id, job.operationId); assert.equal(native.workspace_id, h.destination.workspaceId);
            assert.equal(native.publication_status, 'published'); assert(scene.birth_json);
            probeStage = 'uncommitted-observer';
            before = (await h.admin.query(sql, [job.operationId])).rows;
            assert.notDeepEqual(before, rows, 'Independent admin cannot see uncommitted publication.');
            observed = { rows, pid: Number(witness.pid), start: witness.start, xid: witness.xid };
            if (mode === 'rollback') { probeStage = 'rollback-fault'; throw rollbackFault; }
          }
          if (observed && event.client === selected && /^\s*(?:COMMIT|ROLLBACK)\s*$/iu.test(event.text) && !terminal) {
            probeStage = 'terminal-witness';
            assert.equal(event.result.command, mode === 'rollback' ? 'ROLLBACK' : 'COMMIT'); terminal = true;
            const witness = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
              pg_current_xact_id_if_assigned()::text AS xid FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
            assert.equal(Number(witness.pid), observed.pid); assert.equal(witness.start, observed.start); assert.equal(witness.xid, null);
            assert.deepEqual((await h.admin.query(sql, [job.operationId])).rows, mode === 'rollback' ? before : observed.rows);
            await event.raw('SELECT pg_catalog.pg_notify($1,$2)', [controlChannel, barrier]);
            if (loseCommitAck) throw Object.assign(new Error('FIXTURE_COPY_TERMINAL_NOTIFY_ACK_LOST'), { code: 'FIXTURE_COPY_TERMINAL_NOTIFY_ACK_LOST' });
          }
        }, operation); } catch (error) {
          failed = true; failure = error;
          const queued: unknown[] = [error], diagnostics: Record<string, unknown>[] = [];
          while (queued.length && diagnostics.length < 8) {
            const value = queued.shift();
            if (!value || typeof value !== 'object') continue;
            const fields = Object.getOwnPropertyDescriptors(value), record: Record<string, unknown> = {};
            for (const key of ['name', 'code', 'actual', 'expected']) {
              const scalar = fields[key]?.value;
              if (scalar === null || typeof scalar === 'boolean' || typeof scalar === 'number'
                || typeof scalar === 'string' && /^[A-Za-z0-9_ -]{1,96}$/u.test(scalar)) record[key] = scalar;
            }
            if (value instanceof Error) record.name = value.name;
            diagnostics.push(record);
            if (fields.cause && 'value' in fields.cause) queued.push(fields.cause.value);
            if (Array.isArray(fields.errors?.value)) queued.push(...fields.errors.value.slice(0, 8));
          }
          console.error(JSON.stringify({ test: 'copy-terminal-notify-original-error', mode, probeStage,
            notifyCalls, terminal, observed: Boolean(observed), diagnostics }));
        }
        if (mode === 'none') {
          assert.equal(notifyCalls, 0); await h.admin.query('SELECT pg_catalog.pg_notify($1,$2)', [controlChannel, barrier]);
        } else { assert.equal(notifyCalls, 1); assert(terminal && observed); }
        const deadline = Date.now() + 10_000;
        while (!barrierSeen && listenerFailure === undefined && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 10));
        if (listenerFailure !== undefined) throw listenerFailure;
        assert(barrierSeen, 'Actual Copy terminal-notification server barrier was not delivered.');
        assert.equal(packets.length, mode === 'committed' ? 1 : 0);
        if (mode === 'committed') { assert(observed); assert.equal(packets[0].processId, observed.pid); }
        if (failed) throw failure; return result;
      } finally {
        h.admin.off('notification', onNativeCopyTerminalNotification);
        try { await h.admin.query(`UNLISTEN ${controlChannel}`); }
        finally { await h.admin.query(`UNLISTEN ${productChannel}`); }
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
      const pendingRows = await domainSnapshot(), pendingFiles = await filesystem();
      const origin = job.original; assert(origin && origin.version === 2);
      await withoutStatusDml(() => capture(authInfo(tokenA), selection, async mcpPrincipal => {
        const pending = await readStatus({ origin, mcpPrincipal, operationId: job.operationId });
        assert.equal(pending.operationId, job.operationId); assert.equal(pending.planId, job.plan!.planId);
        assert.deepEqual(pending.completion, { status: 'not_confirmed' });
        assert.notEqual(pending.journal.status, 'completed');
      }));
      assert.deepEqual(await domainSnapshot(), pendingRows); assert.deepEqual(await filesystem(), pendingFiles);
      assert.equal((await staging.loadManagedCopyByOperationId(job.operationId))?.payloadSha256, retained.payloadSha256);
      await withRenewed(async (tokenB, sessionB) => {
        const resumed = await recoverJob(job, tokenB); assert.equal(resumed.current.actor.sessionId, sessionB);
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
    await group('pure completed status under genuine SID B confirms historical receipts and changes no domain rows, xmins or filesystem identities', async () => {
      const original = baseline.original; assert(original && original.version === 2); assert(baseline.plan);
      await withRenewed(async (tokenB, sessionB) => {
        const before = await domainSnapshot(), filesBefore = await filesystem(), originalBytes = JSON.stringify(original);
        const actual = await journal.get(baseline.operationId); assert(actual);
        const visible = await withoutStatusDml(() => capture(authInfo(tokenB), selection, async mcpPrincipal => {
          const current = await callerOrigin(mcpPrincipal); assert.equal(current.actor.sessionId, sessionB);
          assert.notEqual(current.actor.sessionId, original.actor.sessionId);
          return readStatus({ origin: current, mcpPrincipal, operationId: baseline.operationId });
        }));
        assert.deepEqual(Object.keys(visible).sort(), ['completion', 'journal', 'operationId', 'planId', 'revision']);
        assert.equal(visible.operationId, baseline.operationId); assert.equal(visible.planId, baseline.plan!.planId);
        assert.equal(visible.revision, actual.revision);
        assert.deepEqual(visible.journal, { status: actual.status, phase: actual.phase, expectedStepCount: actual.expectedStepCount,
          recordedStepCount: actual.steps.length, appliedStepCount: actual.steps.filter(step => step.status === 'applied').length,
          intentStepCount: actual.steps.filter(step => step.status === 'intent').length, createdAt: actual.createdAt,
          updatedAt: actual.updatedAt, errorCode: actual.errorCode });
        assert.deepEqual(visible.completion, { status: 'confirmed', historical: true, copiedPaths: [baseline.destinationPath] });
        assert.equal(JSON.stringify(original), originalBytes);
        assert.deepEqual(await domainSnapshot(), before); assert.deepEqual(await filesystem(), filesBefore);
      });
    });
    await group('unknown Recover never creates, while journal-only status 404 also preserves a genuine retained pre-B0 Stage for explicit Recover', async () => {
      const notFound = (code: string) => (error: unknown) => {
        expectedCode(code)(error); assert.equal(error && typeof error === 'object' ? Reflect.get(error, 'status') : undefined, 404); return true;
      };
      const absent = await seed();
      await capture(authInfo(tokenA), selection, async mcpPrincipal => {
        absent.original = await callerOrigin(mcpPrincipal);
        absent.plan = await preview({ origin: absent.original, mcpPrincipal, selections: absent.selections });
      });
      const absentOrigin = absent.original; assert(absentOrigin && absentOrigin.version === 2); assert(absent.plan);
      const before = await domainSnapshot(), filesBefore = await filesystem();
      await assert.rejects(capture(authInfo(tokenA), selection, mcpPrincipal => recover({ origin: absentOrigin, mcpPrincipal,
        operationId: absent.operationId, expectedPlanId: absent.plan!.planId, selections: absent.selections })),
      notFound('NATIVE_COPY_OPERATION_NOT_FOUND'));
      await withoutStatusDml(() => assert.rejects(capture(authInfo(tokenA), selection,
        mcpPrincipal => readStatus({ origin: absentOrigin, mcpPrincipal, operationId: absent.operationId })), notFound('NATIVE_COPY_STATUS_NOT_FOUND')));
      assert.equal(await journal.get(absent.operationId), null); assert.equal(await staging.loadManagedCopyByOperationId(absent.operationId), null);
      await assert.rejects(fs.lstat(path.join(h.destination.rootPath, absent.destinationPath)), { code: 'ENOENT' });
      assert.deepEqual(await domainSnapshot(), before); assert.deepEqual(await filesystem(), filesBefore);

      // The real Owner writes its immutable Stage before B0. Observe the next
      // actual BEGIN, after earlier principal table locks were released, and
      // revoke the genuine grant through the independent admin connection.
      const retainedJob = await seed(); let revoked = false, originalStage: WorkspaceOperationManagedCopyStageV4 | undefined;
      await assert.rejects(h.withProbe(async event => {
        if (revoked || !/^\s*BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE\s*$/iu.test(event.text)) return;
        const stage = await staging.loadManagedCopyByOperationId(retainedJob.operationId); if (!stage) return;
        assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM workspace_file_operations WHERE operation_id=$1', [retainedJob.operationId])).rows[0].n, 0);
        assert.equal((await h.admin.query('DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1 AND user_id=$2 AND workspace_id=$3',
          [clientId, 'member', h.destination.workspaceId])).rowCount, 1);
        originalStage = stage; revoked = true;
      }, () => invoke(retainedJob)), expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
      assert(revoked && originalStage); assert.equal(originalStage.origin.version, 2); assert.equal(await journal.get(retainedJob.operationId), null);
      const retained = await staging.loadManagedCopyByOperationId(retainedJob.operationId); assert(retained);
      assert.equal(retained.payloadSha256, originalStage.payloadSha256); assert.deepEqual(retained.origin, retainedJob.original);
      await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
        VALUES($1,'member',$2,100,100)`, [clientId, h.destination.workspaceId]);
      const retainedOrigin = retainedJob.original; assert(retainedOrigin && retainedOrigin.version === 2);
      const retainedRows = await domainSnapshot(), retainedFiles = await filesystem();
      await withoutStatusDml(() => assert.rejects(capture(authInfo(tokenA), selection,
        mcpPrincipal => readStatus({ origin: retainedOrigin, mcpPrincipal, operationId: retainedJob.operationId })), notFound('NATIVE_COPY_STATUS_NOT_FOUND')));
      // A status 404 is journal absence, never evidence that no Stage exists.
      assert.equal(await journal.get(retainedJob.operationId), null);
      assert.equal((await staging.loadManagedCopyByOperationId(retainedJob.operationId))?.payloadSha256, originalStage.payloadSha256);
      assert.deepEqual(await domainSnapshot(), retainedRows); assert.deepEqual(await filesystem(), retainedFiles);
      await withRenewed(async (tokenB, sessionB) => {
        const resumed = await recoverJob(retainedJob, tokenB); assert.equal(resumed.current.actor.sessionId, sessionB);
        const done = await complete(retainedJob, resumed.result, true); assert.deepEqual(done.intent.origin, originalStage!.origin);
      });
    });
    await group('pure status rejects forged, escaped and real wrong-brand captures and cannot mint its private history frame', async () => {
      const origin = baseline.original; assert(origin && origin.version === 2);
      const before = await domainSnapshot(), filesBefore = await filesystem();
      await assert.rejects(readStatus({ origin, mcpPrincipal: Object.freeze({}) as DirectMcpWorkspaceCopyPrincipal,
        operationId: baseline.operationId }), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      let escaped: DirectMcpWorkspaceCopyPrincipal | undefined;
      await capture(authInfo(tokenA), selection, async mcpPrincipal => { escaped = mcpPrincipal; }); assert(escaped);
      await assert.rejects(readStatus({ origin, mcpPrincipal: escaped, operationId: baseline.operationId }), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      await assert.rejects(captureRead(authInfo(tokenA), { workspaceId: h.source.workspaceId, purpose: 'read' }, () => undefined,
        readPrincipal => readStatus({ origin, mcpPrincipal: readPrincipal as unknown as DirectMcpWorkspaceCopyPrincipal,
          operationId: baseline.operationId })), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      await assert.rejects(assertNativeCopyStatusSessionOnConnection(h.connection, origin), expectedCode('NATIVE_COPY_STATUS_REQUIRED'));
      await capture(authInfo(tokenA), selection, async mcpPrincipal => {
        await callerOrigin(mcpPrincipal);
        await assert.rejects(assertNativeCopyStatusSessionOnConnection(h.connection, origin), expectedCode('NATIVE_COPY_STATUS_REQUIRED'));
      });
      assert.deepEqual(await domainSnapshot(), before); assert.deepEqual(await filesystem(), filesBefore);
    });
    await group('pure status denies another genuine client, a read-only destination and revoked source grant without domain or filesystem changes', async () => {
      const origin = baseline.original; assert(origin && origin.version === 2);
      const foreignClient = `copy-status-foreign-${crypto.randomUUID()}`;
      await h.admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
        VALUES($1,$1,'member','Independent actual status fixture client',0,'[]',100,100)`, [foreignClient]);
      await h.admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
        VALUES($1,$2,'member','["knowledge:write","knowledge:read"]','["http://localhost/mcp"]',100,100)`, [crypto.randomUUID(), foreignClient]);
      for (const workspaceId of [h.source.workspaceId, h.destination.workspaceId]) await h.admin.query(`
        INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at) VALUES($1,'member',$2,100,100)`, [foreignClient, workspaceId]);
      const foreignToken = await issue('session-member', foreignClient), before = await domainSnapshot(), filesBefore = await filesystem();
      await withoutStatusDml(() => assert.rejects(capture(authInfo(foreignToken), selection, async mcpPrincipal => {
        const current = await callerOrigin(mcpPrincipal); assert.equal(current.clientId, foreignClient); assert.notEqual(current.clientId, origin.clientId);
        return readStatus({ origin: current, mcpPrincipal, operationId: baseline.operationId });
      }), expectedCode('NATIVE_COPY_STATUS_NOT_FOUND')));
      assert.equal((await h.admin.query('UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id=$2',
        [h.destination.workspaceId, 'member'])).rowCount, 1);
      try {
        await withoutStatusDml(() => assert.rejects(capture(authInfo(tokenA), selection,
          mcpPrincipal => readStatus({ origin, mcpPrincipal, operationId: baseline.operationId })), expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED')));
      } finally { await h.admin.query('UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id=$2', [h.destination.workspaceId, 'member']); }
      assert.equal((await h.admin.query('DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1 AND user_id=$2 AND workspace_id=$3',
        [clientId, 'member', h.source.workspaceId])).rowCount, 1);
      try {
        await withoutStatusDml(() => assert.rejects(capture(authInfo(tokenA), selection,
          mcpPrincipal => readStatus({ origin, mcpPrincipal, operationId: baseline.operationId })), expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED')));
      } finally { await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
        VALUES($1,'member',$2,100,100)`, [clientId, h.source.workspaceId]); }
      let historyClient: MetadataSqlEvent['client'] | undefined, revokedAfterHistory = false, returnedStatus = false;
      try {
        await withoutStatusDml(() => assert.rejects(capture(authInfo(tokenA), selection, async mcpPrincipal => {
          const visible = await readStatus({ origin, mcpPrincipal, operationId: baseline.operationId });
          returnedStatus = true; return visible;
        }), expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED')), async event => {
          if (/^\s*BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY\s*$/iu.test(event.text)) {
            assert.equal(historyClient, undefined); historyClient = event.client;
          }
          if (!revokedAfterHistory && historyClient === event.client && /^\s*COMMIT\s*$/iu.test(event.text)) {
            // The actual RR COMMIT ran before the fixture observer. C1 table
            // locks are already gone; C2 must see this independently committed
            // genuine revocation before any status result can escape.
            assert.equal(event.result.command, 'COMMIT');
            assert.equal((await h.admin.query('DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1 AND user_id=$2 AND workspace_id=$3',
              [clientId, 'member', h.source.workspaceId])).rowCount, 1); revokedAfterHistory = true;
          }
        });
      } finally {
        if (revokedAfterHistory) await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
          VALUES($1,'member',$2,100,100)`, [clientId, h.source.workspaceId]);
      }
      assert(historyClient && revokedAfterHistory); assert.equal(returnedStatus, false, 'A revoked C2 must withhold the already-observed historical status.');
      assert.deepEqual(await domainSnapshot(), before); assert.deepEqual(await filesystem(), filesBefore);
    });
    await group('fresh Copy publication notifies destination on actual B2 COMMIT, rollback is silent and historical retry emits nothing', async () => {
      const job = await seed();
      await assert.rejects(observeNativeCopyTerminalNotifications(job, 'rollback', () => invoke(job)),
        expectedCode('FIXTURE_COPY_TERMINAL_NOTIFY_ROLLBACK'));
      assert.equal((await nativeLedger(job.operationId)).publication_status, 'native_committed');
      assert.equal((await sceneLedger(job.operationId)).birth_json, null);
      const interrupted = await observeNativeCopyTerminalNotifications(job, 'committed', () => recoverJob(job, tokenA), true);
      assert.equal(interrupted.result.execution.status, 'needs_recovery');
      assert.equal(interrupted.result.execution.errorCode, 'NATIVE_COPY_COMMIT_UNCONFIRMED');
      const committedNative = await nativeLedger(job.operationId), committedScene = await sceneLedger(job.operationId);
      assert.equal(committedNative.publication_status, 'published'); assert(committedScene.birth_json);
      const repeated = await observeNativeCopyTerminalNotifications(job, 'none', () => invoke(job));
      await complete(job, repeated.result, true);
      assert.deepEqual(await nativeLedger(job.operationId), committedNative); assert.deepEqual(await sceneLedger(job.operationId), committedScene);
      const before = await domainSnapshot(), files = await filesystem();
      const historical = await observeNativeCopyTerminalNotifications(job, 'none', () => invoke(job));
      await complete(job, historical.result, true);
      await withoutStatusDml(() => capture(authInfo(tokenA), selection, async mcpPrincipal => {
        assert(job.original); const visible = await readStatus({ origin: job.original, mcpPrincipal, operationId: job.operationId });
        assert.deepEqual(visible.completion, { status: 'confirmed', historical: true, copiedPaths: [job.destinationPath] });
      }));
      assert.deepEqual(await domainSnapshot(), before); assert.deepEqual(await filesystem(), files);
    });
  }); } finally { if (originalBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = originalBase; }
  assert.equal(groups, 10); completed = true;
  console.log(`Direct MCP native Copy Owner: ${groups}/10 actual JWT/PG/FD Recover, pure-status and terminal-notification families; no SDK, TCP, compiled OAuth or browser acceptance.`);
}

void directMcpNativeCopyOwnerPostgresTest().catch(error => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  console.error('MCP Copy Owner failure:', { currentCase, groups, name: error instanceof Error ? error.name : typeof error,
    code: typeof code === 'string' && /^[A-Za-z0-9_]{1,96}$/u.test(code) ? code : undefined,
    frames: error instanceof Error ? error.stack?.split('\n').slice(1).map(line => line.trim()).filter(line => line.startsWith('at ')).slice(0, 6) : undefined });
  process.exitCode = 1;
});

import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileEvent } from '../app/lib/filesystem/file-watcher';
import type { NativeCopyReceipt } from '../app/lib/collaboration/native-copy-persistence';
import type { WorkspaceOperationNativeCopyPreviewPublic } from '../app/lib/files/workspace-operation-native-copy-public';
import type { DirectMcpWorkspaceCopyResultV1 } from '../app/lib/mcp/server/workspace-copy-tool-contract';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Real modern HTTP dispatcher, actual signed JWTs/current grants, original Owner,
// PG18/FDs and genuine service publication events. No AuthInfo, verifier, SQL row,
// authority callback, owner result or event-publisher replacement is supplied.
const sha = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const xid32 = (value: string) => (BigInt(value) % BigInt('4294967296')).toString();
let currentCase = 'setup', groups = 0, completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}

export async function directMcpWorkspaceCopyToolPostgresTest(): Promise<void> {
  const originalBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'copy_knowledge_source,read_knowledge_source' });
    const { auth } = await import('../app/lib/auth');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { DIRECT_MCP_PROTOCOL_VERSION: protocol, DIRECT_MCP_DEFAULT_TOOL_IDS, DIRECT_MCP_EXPLICIT_OPT_IN_TOOL_IDS } =
      await import('../app/lib/mcp/server/config');
    const { DIRECT_MCP_WORKSPACE_COPY_INPUT_SCHEMA_V1: inputSchema, DIRECT_MCP_WORKSPACE_COPY_OUTPUT_SCHEMA_V1: outputSchema,
      encodeDirectMcpWorkspaceCopyResultV1: captureResult, WORKSPACE_COPY_TOOL_RESULT_MAX_BYTES } = await import('../app/lib/mcp/server/workspace-copy-tool-contract');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { WorkspaceOperationJournal } = await import('../app/lib/files/workspace-operation-journal');
    const { importExcalidrawDocumentFile } = await import('../app/lib/excalidraw-collaboration/portable-import');
    const { captureExcalidrawCopyIntent, captureExcalidrawCopyBirthReceipt } = await import('../app/lib/excalidraw-collaboration/copy-data');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks: links } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { getFileWatcher } = await import('../app/lib/filesystem/file-watcher');
    const { fileTreeCache, buildFileTreeCacheKey } = await import('../app/lib/utils/file-tree-cache');
    const { persistPristineOriginalWorkspaceFileForWrite } = await import('../app/lib/collaboration/markdown-file-import-persistence');
    const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
    const owner = await readPostgresWorkspaceForActorOnConnection(h.connection,
      resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' }), h.source.workspaceId); assert(owner);
    assert(h.source.permissions.canRead && !h.source.permissions.canWrite); assert(h.destination.permissions.canWrite);
    const clientId = `copy-dispatch-${crypto.randomUUID()}`, staging = new WorkspaceOperationStaging(), journal = new WorkspaceOperationJournal();
    await h.admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
      VALUES($1,$1,'member','Actual Copy dispatcher fixture client',0,'[]',100,100)`, [clientId]);
    await h.admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
      VALUES($1,$2,'member','["knowledge:write","knowledge:read"]','["http://localhost/mcp"]',100,100)`, [crypto.randomUUID(), clientId]);
    for (const workspaceId of [h.source.workspaceId, h.destination.workspaceId]) {
      await h.admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at)
        VALUES($1,'owner',100,100)`, [workspaceId]);
      await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
        VALUES($1,'member',$2,100,100)`, [clientId, workspaceId]);
    }
    const issue = async (sessionId = 'session-member') => {
      const seconds = Math.floor(Date.now() / 1000), value = await auth.api.signJWT({ body: { payload: {
        sub: 'member', azp: clientId, sid: sessionId, iss: 'http://localhost/api/auth', aud: 'http://localhost/mcp',
        iat: seconds - 1, exp: seconds + 600, scope: 'knowledge:read knowledge:write' } } }); assert(value.token); return value.token;
    };
    const tokenA = await issue(); let requestId = 0;
    const rpc = async (method: 'tools/list' | 'tools/call', params: Record<string, unknown>, token = tokenA) => {
      const id = ++requestId, response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol,
        'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': 'copy_knowledge_source' } : {}), authorization: `Bearer ${token}`,
      }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': protocol,
        'io.modelcontextprotocol/clientInfo': { name: 'actual-copy-dispatch-fixture', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } }) }));
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = object(await response.json()); assert.equal(body.jsonrpc, '2.0'); assert.equal(body.id, id); return body;
    };
    const call = async (args: Record<string, unknown>, token = tokenA) => {
      const body = await rpc('tools/call', { name: 'copy_knowledge_source', arguments: args }, token);
      assert.equal(Object.hasOwn(body, 'error'), false); const result = object(body.result);
      assert(Buffer.byteLength(JSON.stringify(result), 'utf8') <= WORKSPACE_COPY_TOOL_RESULT_MAX_BYTES);
      const content = result.content; assert(Array.isArray(content)); assert.equal(content.length, 1);
      assert.equal(object(content[0]).type, 'text'); const text = object(content[0]).text; assert.equal(typeof text, 'string');
      const value = object(result.structuredContent); assert.deepEqual(JSON.parse(text as string), value); assert.equal(value.apiVersion, 1);
      for (const privateValue of [h.dataRoot, tokenA, token]) assert.equal(JSON.stringify(value).includes(privateValue), false);
      return { result, value };
    };
    const success = async (args: Record<string, unknown>, token = tokenA): Promise<DirectMcpWorkspaceCopyResultV1> => {
      const { result, value } = await call(args, token);
      const publicCode = typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value.code) ? value.code : 'NO_VALID_PUBLIC_CODE';
      assert.notEqual(result.isError, true, `Copy tool unexpectedly failed: ${publicCode}`); assert.equal(value.action, args.action);
      const captured = captureResult(value); assert.deepEqual(captured, value); return captured;
    };
    const initializeDestinationMarkdown = async (filePath: string, content: Buffer) => {
      const fullPath = path.join(h.destination.rootPath, filePath);
      // Fixture bytes precede any managed identity. Use the genuine authorized
      // importer so collisions exercise native occupancy, not unsupported raw MD.
      await fs.writeFile(fullPath, content, { flag: 'wx', mode: 0o600 });
      const imported = await persistPristineOriginalWorkspaceFileForWrite(await h.request(h.destination, 'owner'), {
        workspaceId: h.destination.workspaceId, path: filePath, operationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
        expectedTarget: { kind: 'absent' }, expectedFileVersion: filesystemFileVersion(await fs.stat(fullPath)), initialRepresentation: 'plain_text',
      });
      assert.equal(imported.receipt.sourceHash, sha(content)); assert.equal(imported.receipt.target.path, filePath);
      const rows = (await h.admin.query('SELECT id,status,yjs_state_lifecycle FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
        [h.destination.workspaceId, filePath])).rows;
      assert.equal(rows.length, 1); assert.equal(rows[0].id, imported.receipt.target.documentId);
      assert.equal(rows[0].status, 'active'); assert.equal(rows[0].yjs_state_lifecycle, 'initialized');
      const native = await load(h.connection, imported.receipt.target.documentId); assert(native);
      assert.equal(native.status, 'active'); assert.equal(native.representation, 'plain_text');
      assert.equal(native.workspaceId, h.destination.workspaceId); assert.equal(native.path, filePath);
      assert.deepEqual(await fs.readFile(fullPath), content);
    };
    const failure = async (args: Record<string, unknown>, code: string, token = tokenA) => {
      const { result, value } = await call(args, token); assert.equal(result.isError, true); assert.equal(value.success, false); assert.equal(value.code, code);
      assert.deepEqual(Object.keys(value).sort(), ['apiVersion', 'code', ...(value.operationId === undefined ? [] : ['operationId']), 'success'].sort());
      return value;
    };
    const slots = { api_version: 1, source_workspace_id: h.source.workspaceId, destination_workspace_id: h.destination.workspaceId };
    const domain = async () => {
      const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'
        AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)' OR c.relname='file_revisions')
        ORDER BY c.relname LIMIT 513`, [h.schema])).rows;
      assert(tables.length > 11 && tables.length <= 512); const rows: Record<string, unknown> = {};
      for (const table of tables) {
        assert.equal(typeof table.relname, 'string'); const name = `"${String(table.relname).replaceAll('"', '""')}"`;
        const actual = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM ${name} t
          ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows; assert(actual.length <= 10000); rows[table.relname] = actual;
      }
      return { tables, rows };
    };
    const filesystem = async (includeStage = false) => {
      const rows: unknown[] = [];
      const visit = async (relative: string): Promise<void> => {
        assert(rows.length < 10000); const full = path.join(h.dataRoot, relative);
        const value = await fs.lstat(full, { bigint: true }).catch((error: unknown) => {
          if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') return null; throw error;
        });
        if (!value) { rows.push({ path: relative, absent: true }); return; }
        assert(!value.isSymbolicLink()); const entry = { path: relative, dev: String(value.dev), ino: String(value.ino), mode: String(value.mode),
          uid: String(value.uid), nlink: String(value.nlink), size: String(value.size), mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs) };
        rows.push(value.isFile() ? { ...entry, sha256: sha(await fs.readFile(full)) } : entry);
        if (value.isDirectory()) for (const name of (await fs.readdir(full)).sort()) await visit(path.join(relative, name));
      };
      for (const root of [h.source.rootPath, h.destination.rootPath, path.join(h.dataRoot, 'collaboration-assets'),
        ...(includeStage ? [path.join(h.dataRoot, 'workspace-operation-staging')] : [])]) {
        const relative = path.relative(h.dataRoot, root); assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await visit(relative);
      }
      return rows;
    };
    const stageNames = async () => {
      try { return (await fs.readdir(path.join(h.dataRoot, 'workspace-operation-staging'))).sort(); }
      catch (error) { if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') return []; throw error; }
    };
    const withRenewed = async <T>(operation: (token: string, sessionId: string) => Promise<T>): Promise<T> => {
      const sessionId = `copy-dispatch-current-${crypto.randomUUID()}`, now = Date.now();
      await h.admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,'member',$3,$4,$4)`, [sessionId, crypto.randomBytes(32).toString('hex'), now + 3600000, now]);
      const token = await issue(sessionId); await h.admin.query(`UPDATE "session" SET expires_at=1 WHERE id='session-member'`);
      try { return await operation(token, sessionId); }
      finally { await h.admin.query(`UPDATE "session" SET expires_at=$1 WHERE id='session-member'`, [Date.now() + 3600000]);
        await h.admin.query('DELETE FROM "session" WHERE id=$1', [sessionId]); }
    };
    const seed = async () => {
      const suffix = crypto.randomUUID(), root = `dispatch-source-${suffix}`, destinationPath = `dispatch-target-${suffix}`, assetId = `png-${suffix}`;
      const png = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), Buffer.from(suffix)]);
      const note = await h.upload(`${root}/note.md`, Buffer.from(`# Copy\n[Scene](/${root}/diagram.excalidraw) [Target](target.md) [PDF](manual.pdf)\n`));
      const target = await h.upload(`${root}/target.md`, Buffer.from('# Target\n')); await h.metadata(h.source, `${root}/note.md`, { title: 'Dispatcher Copy title' });
      const pdf = Buffer.from('%PDF-1.7\n\0\xff\n%%EOF', 'binary'); await fs.mkdir(path.join(h.source.rootPath, root, 'empty'), { recursive: true });
      await fs.writeFile(path.join(h.source.rootPath, root, 'manual.pdf'), pdf, { mode: 0o600, flag: 'wx' });
      const scene = await importExcalidrawDocumentFile({ workspace: owner,
        actor: { userId: 'owner', actorId: 'owner', actorType: 'user', sessionId: 'session-owner' }, path: `${root}/diagram.excalidraw`, content: JSON.stringify({
          type: 'excalidraw', version: 2, elements: [{ id: 'image', type: 'image', fileId: assetId, version: 1, versionNonce: 1, isDeleted: false }],
          appState: { viewBackgroundColor: '#ffffff' }, files: { [assetId]: { id: assetId, mimeType: 'image/png',
            dataURL: `data:image/png;base64,${png.toString('base64')}`, created: 123, version: 2 } } }) });
      for (const name of ['note.md', 'target.md', 'diagram.excalidraw']) await fs.unlink(path.join(h.source.rootPath, root, name));
      const sourceIds = [note.documentId, target.documentId, scene.documentId];
      const sourceRows = async () => (await h.admin.query(`SELECT 'native' AS kind,document_id AS id,to_jsonb(s)::text AS body,xmin::text AS xmin
        FROM collaboration_yjs_states s WHERE document_id=ANY($1::text[])
        UNION ALL SELECT 'scene',document_id,to_jsonb(s)::text,xmin::text FROM collaboration_excalidraw_states s WHERE document_id=ANY($1::text[])
        UNION ALL SELECT 'registry',id,to_jsonb(s)::text,xmin::text FROM collaboration_documents s WHERE id=ANY($1::text[])
        UNION ALL SELECT 'asset',file_id,to_jsonb(s)::text,xmin::text FROM collaboration_excalidraw_assets s WHERE workspace_id=$2 AND file_id=$3
        ORDER BY kind,id`, [sourceIds, h.source.workspaceId, assetId])).rows;
      return { root, destinationPath, assetId, png, pdf, scene, note, target, sourceIds, sourceRows, sourceBefore: await sourceRows(),
        operationId: crypto.randomUUID(), preview: undefined as WorkspaceOperationNativeCopyPreviewPublic | undefined };
    };
    type Job = Awaited<ReturnType<typeof seed>>;
    const argumentsFor = (job: Job, action: 'preview' | 'apply' | 'recover') => ({ ...slots, action,
      selections: [{ source_path: job.root, destination_path: job.destinationPath }],
      ...(action === 'preview' ? {} : { operation_id: job.operationId, plan_id: job.preview!.planId }) });
    const preview = async (job: Job) => {
      const value = await success(argumentsFor(job, 'preview')); assert.equal(value.action, 'preview'); assert.equal(value.preview.version, 4);
      assert.equal(value.preview.readiness, 'ready'); assert.equal(value.preview.sourceWorkspaceId, h.source.workspaceId);
      assert.equal(value.preview.destinationWorkspaceId, h.destination.workspaceId); assert.match(value.preview.planId, /^[a-f0-9]{64}$/u);
      assert(value.preview.pathMappings.length >= 6); assert(value.preview.linkEdits.some(link => link.previousTargetLiteral !== link.nextTargetLiteral));
      const roots = value.preview.pathMappings.filter(mapping => mapping.sourcePath === job.root); assert.equal(roots.length, 1);
      assert.equal(roots[0].destinationPath, job.destinationPath);
      job.preview = value.preview; return value.preview;
    };
    const receipt = async (operationId: string) => (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [operationId])).rows[0];
    const sceneReceipt = async (operationId: string) => (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [operationId])).rows[0];
    const verifyComplete = async (job: Job, value: DirectMcpWorkspaceCopyResultV1, alreadyKnown: boolean) => {
      assert(value.action === 'apply' || value.action === 'recover'); assert.equal(value.execution.status, 'complete');
      assert.equal(value.execution.errorCode, null); assert.equal(value.alreadyKnown, alreadyKnown); assert.deepEqual(value.copied, [job.destinationPath]);
      const native = await receipt(job.operationId), scene = await sceneReceipt(job.operationId); assert(native && scene?.birth_json);
      assert.equal(native.publication_status, 'published'); assert.equal(native.actor_user_id, 'member'); assert.equal(native.actor_session_id, 'session-member');
      const original = object(JSON.parse((await journal.get(job.operationId))!.requestJson)).origin, parsed = object(original);
      assert.equal(parsed.version, 2); assert.equal(parsed.transport, 'direct-mcp'); assert.equal(parsed.clientId, clientId);
      assert.equal(object(parsed.actor).sessionId, 'session-member'); assert.equal(object(parsed.actor).actorId, `direct-mcp:${sha(clientId).slice(0, 32)}`);
      const intent = captureExcalidrawCopyIntent(scene.intent_json), birth = captureExcalidrawCopyBirthReceipt(scene.birth_json);
      assert.deepEqual(intent.origin, original); assert.deepEqual(birth.intent, intent); assert.equal(scene.xmin, xid32(birth.b2TransactionId));
      const cloned = (native.private_result as Omit<NativeCopyReceipt, 'publicationStatus'>).documents; assert.equal(cloned.length, 2);
      for (const pair of cloned) {
        const source = await load(h.connection, pair.source.documentId), copied = await load(h.connection, pair.clone.documentId); assert(source && copied);
        assert.notEqual(copied.documentId, source.documentId); assert.equal(copied.workspaceId, h.destination.workspaceId); assert.equal(copied.lifecycleGeneration, 1);
        const prior = links(source), after = links(copied); assert(prior.coverage.complete && after.coverage.complete);
        const literal = (link: typeof prior.links[number]) => String(link.ref.kind === 'link-mark' ? link.ref.expected.href : link.ref.expected);
        const edits = job.preview!.linkEdits.filter(edit => edit.sourcePathBefore === source.path && edit.sourcePathAfter === copied.path);
        assert.deepEqual(after.links.map(literal), prior.links.map(link => edits.find(edit => edit.previousTargetLiteral === literal(link))?.nextTargetLiteral ?? literal(link)));
        await assert.rejects(fs.lstat(path.join(h.destination.rootPath, copied.path)), { code: 'ENOENT' });
      }
      assert.equal(intent.documents.length, 1); assert.notEqual(intent.documents[0].documentId, job.scene.documentId);
      const sceneTarget = intent.documents[0], sceneState = (await h.admin.query(`SELECT path,lifecycle_generation,scene_sequence,canonical_hash,xmin::text AS xmin
        FROM collaboration_excalidraw_states WHERE document_id=$1`, [sceneTarget.documentId])).rows[0]; assert(sceneState);
      assert.equal(sceneState.path, `${job.destinationPath}/diagram.excalidraw`); assert.equal(Number(sceneState.lifecycle_generation), 1);
      assert.equal(Number(sceneState.scene_sequence), 0); assert.equal(sceneState.xmin, scene.xmin);
      assert.equal(sceneState.canonical_hash, (await h.admin.query('SELECT canonical_hash FROM collaboration_excalidraw_states WHERE document_id=$1', [job.scene.documentId])).rows[0].canonical_hash);
      const asset = (await h.admin.query('SELECT content_sha256,xmin::text AS xmin FROM collaboration_excalidraw_assets WHERE workspace_id=$1 AND file_id=$2', [h.destination.workspaceId, job.assetId])).rows;
      assert.equal(asset.length, 1); assert.equal(asset[0].content_sha256, sha(job.png)); assert.equal(asset[0].xmin, scene.xmin);
      const blob = path.join(h.dataRoot, 'collaboration-assets/excalidraw', sha(h.destination.workspaceId).slice(0, 32), sha(job.png));
      assert.deepEqual(await fs.readFile(blob), job.png); const info = await fs.lstat(blob); assert.equal(String(info.ino), birth.assetReceipt.blobs[0].identity.ino);
      const portable = JSON.parse(await fs.readFile(path.join(h.destination.rootPath, job.destinationPath, 'diagram.excalidraw'), 'utf8'));
      assert(portable.elements.some((element: { id: string }) => element.id === 'image')); assert.equal(portable.files[job.assetId].dataURL, `data:image/png;base64,${job.png.toString('base64')}`);
      assert.deepEqual(await fs.readFile(path.join(h.destination.rootPath, job.destinationPath, 'manual.pdf')), job.pdf);
      assert.deepEqual(await fs.readdir(path.join(h.destination.rootPath, job.destinationPath, 'empty')), []);
      assert.equal((await h.admin.query('SELECT title FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [h.destination.workspaceId, `${job.destinationPath}/note.md`])).rows[0].title, 'Dispatcher Copy title');
      assert.deepEqual(await job.sourceRows(), job.sourceBefore); assert.equal(await staging.loadManagedCopyByOperationId(job.operationId), null);
      assert.equal(JSON.stringify(original).includes(tokenA), false); assert.equal(JSON.stringify(original).includes('mcpPrincipal'), false);
      return { native, scene, original };
    };
    const group = async (name: string, action: () => Promise<void>) => { currentCase = name; await action(); groups++; console.log(`PASS MCP Copy dispatcher ${groups}: ${name}`); };
    const watcherRuntime = globalThis as typeof globalThis & { __canvasFileWatcherService?: ReturnType<typeof getFileWatcher> };
    assert.equal(watcherRuntime.__canvasFileWatcherService, undefined, 'Fixture must own its actual event service.');
    const watcher = getFileWatcher(), events: FileEvent[] = [], listenerId = `copy-http-${crypto.randomUUID()}`;
    const unsubscribe = watcher.subscribe({ id: listenerId, workspaceId: h.destination.workspaceId, workspace: h.destination, send: event => events.push(event) });
    try {
      // Keep a genuine public client subscription, but remove its raw directory
      // watch after initialization. This isolates service publication broadcasts
      // from separate platform fs.watch notices; it is no UI/raw-watcher claim.
      const deadline = Date.now() + 5000;
      while (!watcher.getSubscribedDirs(h.destination.workspaceId).includes('.')) {
        assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
      }
      watcher.unsubscribeAll(listenerId); assert.deepEqual(watcher.getSubscribedDirs(h.destination.workspaceId), []);
      const eventSummary = () => events.map(event => ({ workspaceId: event.workspaceId, path: event.relativePath, type: event.type }));
      const targetCache = buildFileTreeCacheKey('.', 4, h.destination.workspaceId), sourceCache = buildFileTreeCacheKey('.', 4, h.source.workspaceId);
      const seedCaches = () => { fileTreeCache.set(targetCache, []); fileTreeCache.set(sourceCache, []); };
      const assertBirths = (job: Job) => {
        const expected = job.preview!.pathMappings.map(mapping => ({ workspaceId: h.destination.workspaceId, path: mapping.destinationPath,
          type: mapping.sourceKind === 'directory' ? 'addDir' : 'add' })).sort((a, b) => a.path.localeCompare(b.path));
        assert.deepEqual(eventSummary().sort((a, b) => a.path.localeCompare(b.path)), expected);
        assert.equal(new Set(events.map(event => event.relativePath)).size, expected.length);
        assert.equal(fileTreeCache.get(targetCache), undefined); assert.deepEqual(fileTreeCache.get(sourceCache), []);
      };
      let baseline!: Job;
      await group('actual catalog requires explicit Copy opt-in; disabled/default and strict version decoding preserve domain', async () => {
        assert.equal((DIRECT_MCP_DEFAULT_TOOL_IDS as readonly string[]).includes('copy_knowledge_source'), false);
        assert((DIRECT_MCP_EXPLICIT_OPT_IN_TOOL_IDS as readonly string[]).includes('copy_knowledge_source'));
        const before = await domain(), filesBefore = await filesystem();
        const tools = process.env.CANVAS_MCP_DIRECT_TOOLS; assert(tools);
        for (const setting of [undefined, 'read_knowledge_source']) {
          if (setting === undefined) delete process.env.CANVAS_MCP_DIRECT_TOOLS; else process.env.CANVAS_MCP_DIRECT_TOOLS = setting;
          const listed = object((await rpc('tools/list', {})).result); assert(Array.isArray(listed.tools));
          assert.equal(listed.tools.some(tool => object(tool).name === 'copy_knowledge_source'), false);
          const refused = await rpc('tools/call', { name: 'copy_knowledge_source', arguments: { ...slots, action: 'status', operation_id: crypto.randomUUID() } });
          assert.equal(object(refused.error).code, -32601); assert.equal(Object.hasOwn(refused, 'result'), false);
        }
        process.env.CANVAS_MCP_DIRECT_TOOLS = tools;
        const listed = object((await rpc('tools/list', {})).result); assert(Array.isArray(listed.tools));
        const toolsNamed = listed.tools.filter(tool => object(tool).name === 'copy_knowledge_source'); assert.equal(toolsNamed.length, 1);
        assert.deepEqual(object(toolsNamed[0]).inputSchema, inputSchema); assert.deepEqual(object(toolsNamed[0]).outputSchema, outputSchema);
        assert.equal(object(object(toolsNamed[0]).annotations).readOnlyHint, false);
        const advertisedSecurity = [{ type: 'oauth2', scopes: ['knowledge:write'] }];
        assert.deepEqual(object(toolsNamed[0]).securitySchemes, advertisedSecurity);
        assert.deepEqual(object(object(toolsNamed[0])._meta).securitySchemes, advertisedSecurity);
        await failure({ ...slots, api_version: 2, action: 'preview', selections: [{ source_path: 'anything.md', destination_path: 'nothing.md' }] }, 'INVALID_REQUEST');
        await failure({ ...slots, action: 'preview', origin: {}, selections: [{ source_path: 'anything.md', destination_path: 'nothing.md' }] }, 'INVALID_REQUEST');
        assert.deepEqual(await domain(), before); assert.deepEqual(await filesystem(), filesBefore); assert.deepEqual(events, []);
      });
      await group('registered preview/apply publishes actual native/Scene/assets/link receipts and exactly one set of service birth events', async () => {
        baseline = await seed(); events.length = 0; const before = await domain(), filesBefore = await filesystem(); seedCaches();
        await preview(baseline); assert.deepEqual(await domain(), before); assert.deepEqual(await filesystem(), filesBefore); assert.deepEqual(events, []);
        await verifyComplete(baseline, await success(argumentsFor(baseline, 'apply')), false); assertBirths(baseline);
      });
      await group('genuine renewed SID B reads historical Original A, retries without births, and preserves status under mutation gate-off', async () => {
        const before = await domain(), filesBefore = await filesystem(), stagesBefore = await stageNames();
        const original = object(JSON.parse((await journal.get(baseline.operationId))!.requestJson)).origin; events.length = 0; seedCaches();
        await withRenewed(async (tokenB, sessionB) => {
          assert.notEqual(sessionB, 'session-member');
          const statusArgs = { ...slots, action: 'status', operation_id: baseline.operationId };
          const statusRows = await domain(), statusFiles = await filesystem(true);
          const seen = await success(statusArgs, tokenB); assert.equal(seen.action, 'status');
          assert.deepEqual(seen.operation.completion, { status: 'confirmed', historical: true, copiedPaths: [baseline.destinationPath] });
          assert.deepEqual(await domain(), statusRows); assert.deepEqual(await filesystem(true), statusFiles);
          assert.deepEqual(fileTreeCache.get(targetCache), []); assert.deepEqual(events, []);
          await verifyComplete(baseline, await success(argumentsFor(baseline, 'apply'), tokenB), true);
          assert.equal(fileTreeCache.get(targetCache), undefined); assert.deepEqual(events, []);
          const absentId = crypto.randomUUID(); const absent = await failure({ ...argumentsFor(baseline, 'recover'), operation_id: absentId }, 'COPY_OPERATION_NOT_FOUND', tokenB);
          assert.equal(absent.operationId, absentId); assert.equal(await staging.loadManagedCopyByOperationId(absentId), null); assert.equal(await journal.get(absentId), null);
          await failure({ ...slots, action: 'status', operation_id: absentId }, 'COPY_STATUS_NOT_FOUND', tokenB);
          process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '0';
          try {
            seedCaches(); const gatedStatusRows = await domain(), gatedStatusFiles = await filesystem(true);
            const stillReadable = await success(statusArgs, tokenB); assert.deepEqual(stillReadable, seen);
            assert.deepEqual(await domain(), gatedStatusRows); assert.deepEqual(await filesystem(true), gatedStatusFiles);
            assert.deepEqual(fileTreeCache.get(targetCache), []); assert.deepEqual(events, []);
            for (const action of ['preview', 'apply', 'recover'] as const) await failure(argumentsFor(baseline, action), 'COPY_NATIVE_REQUIRED', tokenB);
          } finally { process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1'; }
        });
        assert.deepEqual(object(JSON.parse((await journal.get(baseline.operationId))!.requestJson)).origin, original);
        assert.deepEqual(await domain(), before); assert.deepEqual(await filesystem(), filesBefore); assert.deepEqual(await stageNames(), stagesBefore); assert.deepEqual(events, []);
      });
      await group('registered recover resumes independently committed B1 after lost ACK under real SID B with no replacement native IDs', async () => {
        const job = await seed(); await preview(job); events.length = 0; seedCaches();
        let b1Client: MetadataSqlEvent['client'] | undefined, b1Xid: string | undefined, fired = false;
        const interrupted = await h.withProbe(async event => {
          if (/^\s*INSERT INTO collaboration_excalidraw_copy_receipts\b/iu.test(event.text) && event.values.includes(job.operationId)) {
            const row = (await event.raw('SELECT intent_json FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [job.operationId])).rows[0];
            b1Xid = captureExcalidrawCopyIntent(row.intent_json).b1TransactionId; b1Client = event.client;
          }
          if (!fired && b1Client === event.client && b1Xid && /^\s*COMMIT\s*$/iu.test(event.text)) {
            assert.equal(event.result.command, 'COMMIT'); const row = await sceneReceipt(job.operationId); assert(row);
            assert.equal(row.xmin, xid32(b1Xid)); assert.equal(row.birth_json, null); assert.equal((await receipt(job.operationId)).publication_status, 'native_committed');
            fired = true; throw Object.assign(new Error('Actual B1 commit ACK fault after independent durable receipt visibility.'), { code: 'EIO' });
          }
        }, () => success(argumentsFor(job, 'apply')));
        assert(fired && b1Client && b1Xid); assert.equal(interrupted.action, 'apply'); assert.equal(interrupted.execution.status, 'needs_recovery');
        assert.equal(interrupted.execution.errorCode, 'COPY_OUTCOME_UNCONFIRMED'); assert.deepEqual(interrupted.copied, []); assert.deepEqual(events, []);
        const retained = await staging.loadManagedCopyByOperationId(job.operationId); assert(retained);
        const nativeBefore = await receipt(job.operationId), privateBefore = nativeBefore.private_result as Omit<NativeCopyReceipt, 'publicationStatus'>;
        const ids = privateBefore.documents.map(pair => pair.clone.documentId);
        const bornBefore = (await h.admin.query('SELECT to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=ANY($1::text[]) ORDER BY document_id', [ids])).rows;
        const pendingRows = await domain(), pendingFiles = await filesystem(true); seedCaches();
        const pending = await success({ ...slots, action: 'status', operation_id: job.operationId }); assert.equal(pending.action, 'status');
        assert.deepEqual(pending.operation.completion, { status: 'not_confirmed' });
        assert.deepEqual(await domain(), pendingRows); assert.deepEqual(await filesystem(true), pendingFiles);
        assert.equal((await staging.loadManagedCopyByOperationId(job.operationId))?.payloadSha256, retained.payloadSha256);
        assert.deepEqual(fileTreeCache.get(targetCache), []); assert.deepEqual(events, []);
        await withRenewed(async tokenB => { await verifyComplete(job, await success(argumentsFor(job, 'recover'), tokenB), true); });
        assert.deepEqual((await receipt(job.operationId)).private_result, nativeBefore.private_result);
        assert.deepEqual((await h.admin.query('SELECT to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=ANY($1::text[]) ORDER BY document_id', [ids])).rows, bornBefore);
        assertBirths(job);

        // A custom basename is resolved only during Preview. Retain the exact
        // ROOT mapping in original selection order, not all sorted child maps.
        const prefix = `dispatch-collision-${crypto.randomUUID()}`, sourcePath = `${prefix}/a.md`, requestedPath = `${prefix}/custom.md`;
        await h.upload(sourcePath, Buffer.from('Native collision source\n')); await fs.unlink(path.join(h.source.rootPath, sourcePath));
        await fs.mkdir(path.join(h.destination.rootPath, prefix), { recursive: true });
        const occupied = path.join(h.destination.rootPath, requestedPath), occupiedBytes = Buffer.from('Existing custom destination\n');
        await initializeDestinationMarkdown(requestedPath, occupiedBytes); const occupiedBefore = await fs.lstat(occupied, { bigint: true });
        const collisionPreview = await success({ ...slots, action: 'preview', rename_on_collision: true,
          selections: [{ source_path: sourcePath, destination_path: requestedPath }] }); assert.equal(collisionPreview.action, 'preview');
        const mapping = collisionPreview.preview.pathMappings.filter(entry => entry.sourcePath === sourcePath); assert.equal(mapping.length, 1);
        const resolvedPath = mapping[0].destinationPath; assert.equal(resolvedPath, `${prefix}/custom (1).md`);
        const collisionId = crypto.randomUUID(), selected = [{ source_path: sourcePath, destination_path: resolvedPath }];
        const applyCollision = { ...slots, action: 'apply', operation_id: collisionId, plan_id: collisionPreview.preview.planId,
          selections: selected, rename_on_collision: false }; events.length = 0; seedCaches();
        let collisionClient: MetadataSqlEvent['client'] | undefined, collisionXmin: string | undefined, collisionFaulted = false;
        const collisionInterrupted = await h.withProbe(async event => {
          if (/^\s*INSERT INTO collaboration_native_copy_receipts\b/iu.test(event.text) && event.values.includes(collisionId)) {
            collisionClient = event.client; collisionXmin = String((await event.raw('SELECT xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [collisionId])).rows[0].xmin);
          }
          if (!collisionFaulted && collisionClient === event.client && collisionXmin && /^\s*COMMIT\s*$/iu.test(event.text)) {
            assert.equal(event.result.command, 'COMMIT'); const durable = await receipt(collisionId); assert.equal(durable.xmin, collisionXmin);
            assert.equal(durable.publication_status, 'native_committed'); collisionFaulted = true;
            throw Object.assign(new Error('Actual custom-name native B1 ACK lost after durable independent visibility.'), { code: 'EIO' });
          }
        }, () => success(applyCollision));
        assert(collisionFaulted); assert.equal(collisionInterrupted.action, 'apply'); assert.equal(collisionInterrupted.execution.status, 'needs_recovery');
        assert.equal(collisionInterrupted.execution.errorCode, 'COPY_OUTCOME_UNCONFIRMED'); assert.deepEqual(events, []);
        const retainedCollision = await staging.loadManagedCopyByOperationId(collisionId); assert(retainedCollision);
        assert.equal(retainedCollision.plan.planId, collisionPreview.preview.planId);
        assert.deepEqual(retainedCollision.request.selections, [{ sourcePath, destinationPath: resolvedPath }]);
        const collisionNative = await receipt(collisionId), collisionPrivate = collisionNative.private_result as Omit<NativeCopyReceipt, 'publicationStatus'>;
        assert.equal(collisionPrivate.documents.length, 1); assert.equal(collisionPrivate.documents[0].clone.path, resolvedPath);
        const collisionDocumentId = collisionPrivate.documents[0].clone.documentId;
        const collisionState = (await h.admin.query('SELECT to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [collisionDocumentId])).rows;
        await withRenewed(async tokenB => {
          const resumed = await success({ ...applyCollision, action: 'recover' }, tokenB); assert.equal(resumed.action, 'recover');
          assert.equal(resumed.execution.status, 'complete'); assert.equal(resumed.alreadyKnown, true); assert.deepEqual(resumed.copied, [resolvedPath]);
          assert.deepEqual(eventSummary(), [{ workspaceId: h.destination.workspaceId, path: resolvedPath, type: 'add' }]);
          assert.deepEqual((await receipt(collisionId)).private_result, collisionNative.private_result);
          assert.equal((await receipt(collisionId)).actor_session_id, 'session-member');
          assert.deepEqual((await h.admin.query('SELECT to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [collisionDocumentId])).rows, collisionState);
          assert.equal(await staging.loadManagedCopyByOperationId(collisionId), null); events.length = 0;
          const repeatedRows = await domain(), repeatedFiles = await filesystem(true), repeated = await success(applyCollision, tokenB);
          assert.equal(repeated.action, 'apply'); assert.equal(repeated.execution.status, 'complete'); assert.equal(repeated.alreadyKnown, true); assert.deepEqual(repeated.copied, [resolvedPath]);
          assert.deepEqual(await domain(), repeatedRows); assert.deepEqual(await filesystem(true), repeatedFiles); assert.deepEqual(events, []);
        });
        assert.deepEqual(await fs.readFile(occupied), occupiedBytes); const occupiedAfter = await fs.lstat(occupied, { bigint: true });
        assert.equal(occupiedAfter.dev, occupiedBefore.dev); assert.equal(occupiedAfter.ino, occupiedBefore.ino);
        await assert.rejects(fs.lstat(path.join(h.destination.rootPath, resolvedPath)), { code: 'ENOENT' });
        await assert.rejects(fs.lstat(path.join(h.destination.rootPath, prefix, 'custom (2).md')), { code: 'ENOENT' });

        const racePath = `${prefix}/race.md`; await initializeDestinationMarkdown(racePath, Buffer.from('Existing race target\n'));
        const racePreview = await success({ ...slots, action: 'preview', rename_on_collision: true,
          selections: [{ source_path: sourcePath, destination_path: racePath }] }); assert.equal(racePreview.action, 'preview');
        const raceMapping = racePreview.preview.pathMappings.filter(entry => entry.sourcePath === sourcePath); assert.equal(raceMapping.length, 1);
        assert.equal(raceMapping[0].destinationPath, `${prefix}/race (1).md`);
        await initializeDestinationMarkdown(raceMapping[0].destinationPath, Buffer.from('Occupied after Preview\n'));
        const raceId = crypto.randomUUID(), raceRows = await domain(), raceFiles = await filesystem(), raceStages = await stageNames(); events.length = 0;
        const raceFailure = await call({ ...slots, action: 'apply', operation_id: raceId, plan_id: racePreview.preview.planId,
          selections: [{ source_path: sourcePath, destination_path: raceMapping[0].destinationPath }], rename_on_collision: false });
        assert.equal(raceFailure.result.isError, true); assert.equal(raceFailure.value.success, false);
        assert(['COPY_PLAN_CHANGED', 'COPY_CONFLICT', 'COPY_NATIVE_REQUIRED'].includes(String(raceFailure.value.code)));
        assert.equal(await journal.get(raceId), null); assert.equal(await staging.loadManagedCopyByOperationId(raceId), null);
        assert.deepEqual(await domain(), raceRows); assert.deepEqual(await filesystem(), raceFiles); assert.deepEqual(await stageNames(), raceStages); assert.deepEqual(events, []);
        await assert.rejects(fs.lstat(path.join(h.destination.rootPath, prefix, 'race (2).md')), { code: 'ENOENT' });
      });
      await group('actual prelude COMMIT and actual release ACK faults return bounded unavailable without entering Owner', async () => {
        const job = await seed(); await preview(job);
        for (const fault of ['commit', 'close'] as const) {
          job.operationId = crypto.randomUUID(); const before = await domain(), filesBefore = await filesystem(), stagesBefore = await stageNames(); events.length = 0;
          let prelude: MetadataSqlEvent['client'] | undefined, fired = false, ownerEntered = false, releaseCalled = false;
          let restore: (() => void) | undefined;
          try {
            await h.withProbe(async event => {
              if (/^\s*SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE\s*$/iu.test(event.text)) { assert.equal(prelude, undefined); prelude = event.client; }
              if (/^\s*SET statement_timeout='5s'\s*$/iu.test(event.text) || /\bpg_advisory_lock\s*\(/iu.test(event.text)) ownerEntered = true;
              if (fired || prelude !== event.client || !/^\s*COMMIT\s*$/iu.test(event.text)) return;
              assert.equal(event.result.command, 'COMMIT'); fired = true;
              if (fault === 'commit') throw Object.assign(new Error('Actual prelude commit ACK fault after COMMIT.'), { code: 'EIO' });
              const client = event.client, descriptor = Object.getOwnPropertyDescriptor(client, 'release'), release = client.release;
              restore = () => { if (descriptor) Object.defineProperty(client, 'release', descriptor); else Reflect.deleteProperty(client, 'release'); };
              Object.defineProperty(client, 'release', { configurable: true, writable: true, value: (error?: Error | boolean) => {
                assert.equal(releaseCalled, false); releaseCalled = true; restore!();
                release.call(client, error ?? new Error('Discarding actual fixture prelude connection before lost release ACK.'));
                throw Object.assign(new Error('Actual release completed before close ACK fault.'), { code: 'EIO' });
              } });
            }, () => failure(argumentsFor(job, 'apply'), 'COPY_UNAVAILABLE'));
          } finally { restore?.(); }
          assert(prelude && fired); assert.equal(releaseCalled, fault === 'close'); assert.equal(ownerEntered, false);
          assert.equal(await staging.loadManagedCopyByOperationId(job.operationId), null); assert.equal(await journal.get(job.operationId), null);
          assert.deepEqual(await domain(), before); assert.deepEqual(await filesystem(), filesBefore); assert.deepEqual(await stageNames(), stagesBefore); assert.deepEqual(events, []);
        }
      });
      await group('genuine grant revocation after prelude commit denies fresh Owner authority without Stage or publication', async () => {
        const job = await seed(); await preview(job); const before = await domain(), filesBefore = await filesystem(), stagesBefore = await stageNames(); events.length = 0;
        let prelude: MetadataSqlEvent['client'] | undefined, revoked = false, ownerEntered = false;
        try {
          await h.withProbe(async event => {
            if (/^\s*SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE\s*$/iu.test(event.text)) { assert.equal(prelude, undefined); prelude = event.client; }
            if (/^\s*SET statement_timeout='5s'\s*$/iu.test(event.text)) ownerEntered = true;
            if (!revoked && prelude === event.client && /^\s*COMMIT\s*$/iu.test(event.text)) {
              assert.equal(event.result.command, 'COMMIT');
              assert.equal((await h.admin.query('DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1 AND user_id=$2 AND workspace_id=$3',
                [clientId, 'member', h.destination.workspaceId])).rowCount, 1); revoked = true;
            }
          }, () => failure(argumentsFor(job, 'apply'), 'ACCESS_DENIED'));
        } finally { if (revoked) await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
          VALUES($1,'member',$2,100,100)`, [clientId, h.destination.workspaceId]); }
        assert(prelude && revoked && ownerEntered); assert.equal(await staging.loadManagedCopyByOperationId(job.operationId), null); assert.equal(await journal.get(job.operationId), null);
        assert.deepEqual(await domain(), before); assert.deepEqual(await filesystem(), filesBefore); assert.deepEqual(await stageNames(), stagesBefore); assert.deepEqual(events, []);
      });
    } finally {
      unsubscribe(); watcher.stop(); assert.equal(watcherRuntime.__canvasFileWatcherService, watcher); delete watcherRuntime.__canvasFileWatcherService;
    }
  }); } finally { if (originalBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = originalBase; }
  assert.equal(groups, 6); completed = true;
  console.log(`Direct MCP Copy tool: ${groups}/6 actual modern HTTP dispatcher/JWT/PG18/FD and service-event families; no TCP, OAuth approval, SDK or UI claim.`);
}

void directMcpWorkspaceCopyToolPostgresTest().catch(error => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  console.error('MCP Copy dispatcher failure:', { currentCase, groups, name: error instanceof Error ? error.name : typeof error,
    code: typeof code === 'string' && /^[A-Za-z0-9_]{1,96}$/u.test(code) ? code : undefined,
    frames: error instanceof Error ? error.stack?.split('\n').slice(1).map(line => line.trim()).filter(line => line.startsWith('at ')).slice(0, 6) : undefined });
  process.exitCode = 1;
});

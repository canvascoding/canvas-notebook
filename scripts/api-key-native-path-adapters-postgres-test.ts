import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DirectMcpWorkspacePathOperationV1 } from '../app/lib/mcp/server/workspace-path-tool-contract';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

type Kind = 'move' | 'delete';
type Job = { kind: Kind; operationId: string; sourcePath: string; destinationPath: string; planId: string };
let stage = 'setup', groups = 0;
async function main() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { BASE_URL: 'http://localhost', FILE_VERSION_CENTER_MODE: 'off', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS: 'move_knowledge_source,delete_knowledge_source,read_knowledge_source' });
    assert.equal((await import('../app/lib/file-version-center/policy-v1')).resolveFileVersionRolloutV1(process.env.FILE_VERSION_CENTER_MODE).capture, false);
    assert.equal((await import('../app/lib/files/workspace-file-undo-policy')).WORKSPACE_FILE_UNDO_ENABLED, false);
    await h.admin.query("UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id='principal-org' AND user_id='member'");
    await h.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [h.source.workspaceId]);
    const { NextRequest } = await import('next/server');
    const { POST: movePost } = await import('../app/api/documents/move/route');
    const { POST: deletePost } = await import('../app/api/documents/delete/route');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { createApiIntegration, rotateApiKey, updateApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { decodeApiKeyWorkspaceMoveRequest } = await import('../app/lib/documents/path-contract');
    const { apiKeyWorkspacePathFailure } = await import('../app/lib/documents/path-public-service');
    const { config } = await import('../proxy');
    const { unstable_doesMiddlewareMatch } = await import('next/experimental/testing/server');
    const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/server/validators/ajv');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { loadCollaborationStateOnConnection } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const manager = new Headers((await h.request()).headers); manager.set('Origin', 'http://localhost');
    const workspaceId = h.source.workspaceId, actions = ['move', 'delete', 'status', 'recover'] as const;
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Actual Key path adapters', workspaceIds: [workspaceId],
      actions: [...actions], expiresAt: Date.now() + 3_600_000 });
    let key = issued.key, credentialId = issued.credential.id, revision = issued.integration.revision, rpcId = 0;
    const store = new WorkspaceOperationBatchStore(), outputChecks = new Map<Kind, (value: unknown) => { valid: boolean }>();
    const job = (kind: Kind, sourcePath = `path-adapter-${randomUUID()}.md`): Job => ({ kind, sourcePath,
      destinationPath: `path-adapter-${randomUUID()}-moved${path.posix.extname(sourcePath)}`, operationId: randomUUID(), planId: '' });
    const input = (j: Job, action: 'preview' | 'apply' | 'status' | 'recover') => ({ apiVersion: 1, workspaceId, action,
      ...(action === 'preview' ? {} : { operationId: j.operationId }), ...(action === 'apply' || action === 'recover' ? { planId: j.planId } : {}),
      ...(action === 'status' ? {} : j.kind === 'move' ? { selections: [{ sourcePath: j.sourcePath, destinationPath: j.destinationPath }] } : { path: j.sourcePath }) });
    const wire = (j: Job, action: 'preview' | 'apply' | 'status' | 'recover') => ({ api_version: 1, workspace_id: workspaceId, action,
      ...(action === 'preview' ? {} : { operation_id: j.operationId }), ...(action === 'apply' || action === 'recover' ? { plan_id: j.planId } : {}),
      ...(action === 'status' ? {} : j.kind === 'move' ? { selections: [{ source_path: j.sourcePath, destination_path: j.destinationPath }] } : { path: j.sourcePath }) });
    const safe = (value: unknown) => {
      const text = JSON.stringify(value);
      for (const privateValue of [key, h.dataRoot, issued.credential.id, 'apiKeyPrincipal', 'authorization_json']) assert.equal(text.includes(privateValue), false);
      assert(Buffer.byteLength(text) <= 1024 * 1024);
    };
    const post = async (kind: Kind, value: unknown, extras: Record<string, string> = {}, raw?: string | Uint8Array<ArrayBuffer>) => {
      const request = new NextRequest(`http://localhost/api/documents/${kind}`, { method: 'POST', headers: {
        'content-type': 'application/json', 'X-Canvas-API-Key': key, ...extras }, body: raw ?? JSON.stringify(value) });
      const response = await (kind === 'move' ? movePost : deletePost)(request);
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('www-authenticate'), null); const body = await response.json(); safe(body);
      return { status: response.status, body };
    };
    const rpc = async (method: 'tools/list' | 'tools/call', params: Record<string, unknown>, modern = false) => {
      const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'X-Canvas-API-Key': key,
        'mcp-protocol-version': modern ? '2026-07-28' : '2025-11-25', ...(modern ? { 'mcp-method': method,
          ...(method === 'tools/call' ? { 'mcp-name': params.name as string } : {}) } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: { ...params, ...(modern ? { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'actual-key-path-adapters', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } : {}) } }) }));
      assert.equal(response.headers.get('www-authenticate'), null); assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json(); safe(body); return { status: response.status, body };
    };
    const mcp = async (j: Job, action: 'preview' | 'apply' | 'status' | 'recover', modern = false) => {
      const response = await rpc('tools/call', { name: j.kind === 'move' ? 'move_knowledge_source' : 'delete_knowledge_source', arguments: wire(j, action) }, modern);
      assert.equal(response.status, 200); assert.equal(response.body.error, undefined);
      const result = response.body.result; assert.equal(result.content.length, 1);
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      assert.equal(outputChecks.get(j.kind)!(result.structuredContent).valid, true); return result;
    };
    const snapshot = async () => {
      const tables = (await h.admin.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind='r' AND c.relname ~ '^(collaboration_|file_collaboration_|workspace_|file_revision)' ORDER BY c.relname`, [h.schema])).rows;
      const data: Record<string, unknown> = {};
      for (const { relname } of tables) { assert(/^[a-z][a-z0-9_]*$/u.test(relname));
        data[relname] = (await h.admin.query(`SELECT to_jsonb(t)::text AS data,xmin::text AS row_xmin FROM "${h.schema}"."${relname}" t ORDER BY data,row_xmin`)).rows; }
      return data;
    };
    const check = async (name: string, test: () => Promise<void>) => { stage = name; await test(); groups++; console.log(`API-key native path adapters passed: ${name}`); };
    const preview = async (j: Job) => {
      const before = await snapshot(), result = await post(j.kind, input(j, 'preview'));
      assert.equal(result.status, 200); assert.equal(result.body.action, 'preview'); j.planId = result.body.preview.planId;
      assert.match(j.planId, /^[a-f0-9]{64}$/u); assert.equal(outputChecks.get(j.kind)!(result.body).valid, true); assert.deepEqual(await snapshot(), before);
    };
    const confirmed = async (j: Job, value: Readonly<{ operation: DirectMcpWorkspacePathOperationV1 }>) => {
      assert.equal(value.operation.operationId, j.operationId); assert.equal(value.operation.planId, j.planId);
      assert.equal(value.operation.journal.status, 'applied'); assert.equal(value.operation.completion.status, 'confirmed');
      const batch = await store.get(value.operation.batchId); assert(batch?.authorization.mode === 'api-key');
      assert.equal(batch.authorization.actorSessionId, null); assert.equal(batch.authorization.integrationId, issued.integration.id);
      return batch;
    };
    await check('both registered MCP protocols advertise exact native Key schemas without implicit import previews', async () => {
      for (const modern of [false, true]) {
        const list = await rpc('tools/list', {}, modern); assert.equal(list.status, 200);
        for (const kind of ['move', 'delete'] as const) {
          const descriptor = list.body.result.tools.find((tool: { name: string }) => tool.name === `${kind}_knowledge_source`); assert(descriptor);
          assert.deepEqual(descriptor.securitySchemes, [{ type: 'apiKey', in: 'header', name: 'X-Canvas-API-Key' }]);
          const schemas = new AjvJsonSchemaValidator(), validate = schemas.getValidator(descriptor.outputSchema); outputChecks.set(kind, validate);
          assert.equal(schemas.getValidator(descriptor.inputSchema)(wire(job(kind), 'preview')).valid, true);
          assert.equal(schemas.getValidator(descriptor.inputSchema)({ sources: ['legacy'], overwrite: true }).valid, false);
          assert.equal(validate({ apiVersion: 1, success: false, code: 'API_KEY_ACCESS_DENIED' }).valid, true);
          const canonical = (await import('../app/lib/mcp/server/workspace-tools')).getDirectMcpWorkspaceToolDescriptor(`${kind}_knowledge_source`);
          const branches = descriptor.outputSchema.anyOf[0].oneOf;
          assert.equal(branches.length, (canonical.outputSchema!.oneOf as unknown[]).length - 2);
        }
      }
    });
    await check('strict REST/UTF-8/body bounds, hidden MCP paths and exact proxy routes reject before domain writes', async () => {
      const before = await snapshot(); let getters = 0;
      assert.throws(() => decodeApiKeyWorkspaceMoveRequest({ ...input(job('move'), 'preview'), get selections() { getters++; return []; } }, 'request'));
      const hostile = new Proxy({}, { getPrototypeOf() { getters++; throw new Error('No proxy inspection.'); } });
      assert.equal(apiKeyWorkspacePathFailure(hostile, hostile, 'request').body.code, 'PATH_UNAVAILABLE'); assert.equal(getters, 0);
      for (const kind of ['move', 'delete'] as const) {
        assert.equal(unstable_doesMiddlewareMatch({ config, url: `/api/documents/${kind}` }), false);
        for (const url of [`/api/documents/${kind}/status`, `/api/documents/${kind}-extra`, `/api/files/${kind}`, '/api/secrets'])
          assert.equal(unstable_doesMiddlewareMatch({ config, url }), true);
        for (const value of [{ ...input(job(kind), 'preview'), actor: { userId: 'owner' } }, { ...input(job(kind), 'preview'), apiVersion: 2 },
          { sources: ['legacy'], overwrite: true }]) assert.equal((await post(kind, value)).status, 400);
        assert.equal((await post(kind, {}, {}, new Uint8Array([123, 34, 255, 34, 125]))).status, 400);
        assert.equal((await post(kind, {}, {}, ' '.repeat(65537))).status, 413);
        assert.equal((await post(kind, {}, { 'X-Canvas-API-Key': 'invalid-key' }, ' '.repeat(65537))).status, 401);
        const hidden = job(kind, '.hidden.md'), result = await mcp(hidden, 'preview');
        assert(result.isError); assert.equal(result.structuredContent.code, 'ACCESS_DENIED');
      }
      assert.deepEqual(await snapshot(), before);
    });

    let baseline: Job | undefined;
    for (const kind of ['move', 'delete'] as const) for (const profile of ['native', 'native-only', 'physical', 'cohort'] as const) {
      await check(`${kind}: ${profile} REST Apply and cross-protocol Status/Apply/Recover retain real originals and links`, async () => {
        const root = `adapter-${randomUUID()}`, j = job(kind, profile === 'cohort' ? root : `${root}.${profile === 'physical' ? 'pdf' : 'md'}`);
        if (profile === 'cohort') await fs.mkdir(path.join(h.source.rootPath, root), { mode: 0o700 });
        const targetPath = profile === 'cohort' ? `${root}/note.md` : j.sourcePath, bytes = Buffer.from(profile === 'physical' ? '%PDF-1.7\nPreserve original PDF\n' : '# Preserve native original\n');
        const target = profile === 'physical' ? null : await h.upload(targetPath, bytes);
        if (profile === 'physical') await fs.writeFile(path.join(h.source.rootPath, targetPath), bytes, { mode: 0o600, flag: 'wx' });
        if (profile === 'cohort') await fs.writeFile(path.join(h.source.rootPath, root, 'paper.pdf'), Buffer.from('%PDF-1.7\nPreserve cohort PDF\n'), { mode: 0o600, flag: 'wx' });
        if (profile === 'native-only') await fs.unlink(path.join(h.source.rootPath, targetPath));
        const incoming = await h.upload(`adapter-incoming-${randomUUID()}.md`, Buffer.from(`[Keep label](${targetPath})\n`));
        const beforeState = target ? await loadCollaborationStateOnConnection(h.connection, target.documentId) : null;
        await preview(j); const applied = await post(kind, input(j, 'apply')); assert.equal(applied.status, 200);
        const batch = await confirmed(j, applied.body); assert.equal(batch.plan.version, kind === 'move' ? 3 : profile === 'cohort' ? 6 : profile === 'physical' ? 5 : 2);
        const linked = await loadCollaborationStateOnConnection(h.connection, incoming.documentId); assert(linked);
        const destinationTarget = profile === 'cohort' ? `${j.destinationPath}/note.md` : j.destinationPath;
        assert.equal(inspectPersistedDocumentLinks(linked).links.some(link => link.targetPathText === targetPath), false);
        if (kind === 'move') assert(inspectPersistedDocumentLinks(linked).links.some(link => link.targetPathText === destinationTarget));
        if (target) {
          assert(beforeState); const raw = (await h.admin.query('SELECT path,status,yjs_state,state_vector FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId])).rows[0];
          assert.equal(raw.status, kind === 'move' ? 'active' : 'archived'); assert.equal(raw.path, kind === 'move' ? destinationTarget : targetPath);
          assert.deepEqual(raw.yjs_state, Buffer.from(beforeState.yjsState)); assert.deepEqual(raw.state_vector, Buffer.from(beforeState.stateVector));
        }
        await assert.rejects(fs.lstat(path.join(h.source.rootPath, j.sourcePath)), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
        if (kind === 'move' && profile === 'physical') assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, j.destinationPath)), bytes);
        const after = await snapshot();
        for (const modern of [false, true]) {
          const status = await mcp(j, 'status', modern); assert.equal(status.isError, undefined); assert.deepEqual(status.structuredContent.operation, applied.body.operation);
          const repeated = await mcp(j, modern ? 'recover' : 'apply', modern); assert.equal(repeated.isError, undefined);
          assert.equal(repeated.structuredContent.alreadyKnown, true); assert.deepEqual(repeated.structuredContent.operation, applied.body.operation); assert.deepEqual(await snapshot(), after);
        }
        baseline ??= j;
      });
    }
    assert(baseline); const saved = baseline;
    await check('actual rotation retains original attribution across REST/MCP and denies the old key', async () => {
      const original = (await post(saved.kind, input(saved, 'status'))).body.operation, row = await store.get(original.batchId); assert(row?.authorization.mode === 'api-key');
      const before = await snapshot(), old = key, rotated = await rotateApiKey(manager, issued.integration.id, { requestId: randomUUID(), expectedRevision: revision++, expiresAt: Date.now() + 3_600_000 });
      key = rotated.key; credentialId = rotated.credential.id;
      const recovered = await mcp(saved, 'recover', true); assert.equal(recovered.isError, undefined); assert.deepEqual(recovered.structuredContent.operation, original);
      assert.deepEqual((await store.get(original.batchId))?.authorization, row.authorization); assert.deepEqual(await snapshot(), before);
      assert.equal((await post(saved.kind, input(saved, 'status'), { 'X-Canvas-API-Key': old })).status, 401);
    });
    for (const kind of ['move', 'delete'] as const) for (const phase of ['claim', 'completion'] as const) await check(`${kind}: actual ${phase} COMMIT acknowledgement loss retains one operation for explicit recovery`, async () => {
      const j = job(kind); await h.upload(j.sourcePath, Buffer.from('# Original acknowledgement loss document\n')); await preview(j);
      const table = phase === 'claim' ? 'workspace_file_operation_batches' : `workspace_file_operation_${kind}_receipts`;
      let client: MetadataSqlEvent['client'] | undefined, fired = false, batchId = '', insertedRows: unknown;
      const response = await h.withProbe(async event => {
        if (/^\s*INSERT\s+INTO\b/iu.test(event.text) && event.text.includes(table) && !client) {
          assert.equal(event.result.command, 'INSERT'); assert.equal(event.result.rowCount, 1); client = event.client; batchId = String(event.values[0]); assert.match(batchId, /^[a-f0-9]{64}$/u);
          insertedRows = (await event.raw(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM "${table}" t WHERE batch_id=$1`, [batchId])).rows;
          assert.equal((await h.admin.query(`SELECT count(*)::int AS n FROM "${table}" WHERE batch_id=$1`, [batchId])).rows[0].n, 0);
        }
        if (!fired && event.client === client && /^\s*COMMIT\s*$/iu.test(event.text)) {
          assert.equal(event.result.command, 'COMMIT'); assert.deepEqual((await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM "${table}" t WHERE batch_id=$1`, [batchId])).rows, insertedRows);
          fired = true; throw Object.assign(new Error('Lost acknowledgement after independently confirmed COMMIT.'), { code: 'FIXTURE_KEY_PATH_COMMIT_ACK_LOST' });
        }
      }, () => post(kind, input(j, 'apply')));
      assert(fired && client && batchId); assert.equal(response.status, 503); assert.equal(response.body.code, 'PATH_OUTCOME_UNCONFIRMED'); assert.equal(response.body.operationId, j.operationId);
      const beforeStatus = await snapshot(), status = await mcp(j, 'status'); assert.equal(status.isError, undefined); assert.equal(status.structuredContent.operation.batchId, batchId); assert.deepEqual(await snapshot(), beforeStatus);
      if (phase === 'claim') assert.equal((await h.admin.query("UPDATE workspace_file_operation_batches SET lease_expires_at=1 WHERE batch_id=$1 AND status='applying' RETURNING batch_id", [batchId])).rowCount, 1);
      else { assert.equal(status.structuredContent.operation.completion.status, 'confirmed'); assert.equal(status.structuredContent.operation.journal.status, 'needs_recovery'); }
      const recovered = await mcp(j, 'recover', true); assert.equal(recovered.isError, undefined); const batch = await confirmed(j, recovered.structuredContent); assert.equal(batch.batchId, batchId);
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM workspace_file_operation_batches WHERE batch_id=$1', [batchId])).rows[0].n, 1);
    });
    await check('missing jobs, withdrawn grants/ACL, mixed credentials, disabled MCP and actual revocation remain bounded denials', async () => {
      const before = await snapshot(), missing = { ...saved, operationId: randomUUID() };
      assert.equal((await post(saved.kind, input(missing, 'status'))).status, 404); assert.equal((await post(saved.kind, input(missing, 'recover'))).status, 404);
      await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name, workspaceIds: [workspaceId], actions: ['move', 'delete'] });
      assert.equal((await post(saved.kind, input(saved, 'status'))).status, 403); assert.equal((await post(saved.kind, input(saved, 'recover'))).status, 403);
      await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name, workspaceIds: [workspaceId], actions: [...actions] });
      await h.admin.query("UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id='member'", [workspaceId]);
      assert.equal((await post(saved.kind, input(saved, 'status'))).status, 403);
      await h.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [workspaceId]);
      for (const headers of [{ cookie: 'better-auth.session_token=invalid' }, { authorization: 'Bearer invalid' }] as Record<string, string>[]) assert.equal((await post(saved.kind, input(saved, 'status'), headers)).status, 401);
      const sessionOnly = await movePost(new NextRequest('http://localhost/api/documents/move', { method: 'POST', headers: manager, body: JSON.stringify(input(saved, 'status')) })); assert.equal(sessionOnly.status, 401);
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source';
      const list = await rpc('tools/list', {}); assert.equal(list.body.result.tools.some((tool: { name: string }) => ['move_knowledge_source', 'delete_knowledge_source'].includes(tool.name)), false);
      const disabled = await rpc('tools/call', { name: 'move_knowledge_source', arguments: wire(saved, 'status') }); assert.equal(disabled.body.error.code, -32601);
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'move_knowledge_source,delete_knowledge_source,read_knowledge_source'; assert.deepEqual(await snapshot(), before);
      await revokeApiKey(manager, issued.integration.id, { expectedRevision: revision, credentialId }); assert.equal((await post(saved.kind, input(saved, 'status'))).status, 401); assert.deepEqual(await snapshot(), before);
    });
  });
  console.log(`API-key native path adapters: ${groups} genuine REST/registered-MCP/SQL groups passed; installed SDK and compiled-image acceptance remain separate.`);
}
main().catch(error => { console.error(JSON.stringify({ suite: 'api-key-native-path-adapters', stage, name: error instanceof Error ? error.name : undefined,
  code: error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined,
  assertion: error instanceof assert.AssertionError ? { operator: error.operator, actual: typeof error.actual === 'number' ? error.actual : typeof error.actual,
    expected: typeof error.expected === 'number' ? error.expected : typeof error.expected } : undefined,
  stack: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s*at\b/u.test(line)).slice(0, 5) : undefined })); process.exitCode = 1; });

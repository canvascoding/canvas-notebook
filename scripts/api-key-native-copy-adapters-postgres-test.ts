import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DirectMcpWorkspaceCopyResultV1 } from '../app/lib/mcp/server/workspace-copy-tool-contract';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';
import { seedNativeCopyMixedSource } from './helpers/native-copy-mixed-source-fixture';

let stage = 'setup', groups = 0;
async function main() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { BASE_URL: 'http://localhost', FILE_VERSION_CENTER_MODE: 'shadow', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS: 'copy_knowledge_source,read_knowledge_source' });
    const { NextRequest } = await import('next/server');
    const { POST } = await import('../app/api/documents/copy/route');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { createApiIntegration, rotateApiKey, updateApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { decodeApiKeyWorkspaceCopyRequest } = await import('../app/lib/documents/copy-contract');
    const { apiKeyWorkspaceCopyFailure } = await import('../app/lib/documents/copy-public-service');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { config } = await import('../proxy');
    const { unstable_doesMiddlewareMatch } = await import('next/experimental/testing/server');
    const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/server/validators/ajv');
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const manager = new Headers((await h.request()).headers); manager.set('Origin', 'http://localhost');
    const workspaceIds = [h.source.workspaceId, h.destination.workspaceId], actions = ['read', 'copy', 'status', 'recover'] as const;
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Actual native Copy adapters', workspaceIds,
      actions: [...actions], expiresAt: Date.now() + 3_600_000 });
    let key = issued.key, credentialId = issued.credential.id, revision = 1, rpcId = 0;
    const original = await seedNativeCopyMixedSource(h), staging = new WorkspaceOperationStaging();
    const job = () => { const destinationPath = `adapter-copy-${randomUUID()}`; return { operationId: randomUUID(), destinationPath,
      selections: [{ sourcePath: original.root, destinationPath }], planId: '' }; };
    type Job = ReturnType<typeof job>;
    const input = (selected: Job, action: 'preview' | 'apply' | 'recover' | 'status') => ({ apiVersion: 1, action,
      sourceWorkspaceId: workspaceIds[0], destinationWorkspaceId: workspaceIds[1], ...(action === 'preview' ? {} : { operationId: selected.operationId }),
      ...(action === 'apply' || action === 'recover' ? { planId: selected.planId } : {}), ...(action === 'status' ? {} : { selections: selected.selections }) });
    const mcpInput = (selected: Job, action: 'preview' | 'apply' | 'recover' | 'status') => ({ api_version: 1, action,
      source_workspace_id: workspaceIds[0], destination_workspace_id: workspaceIds[1], ...(action === 'preview' ? {} : { operation_id: selected.operationId }),
      ...(action === 'apply' || action === 'recover' ? { plan_id: selected.planId } : {}), ...(action === 'status' ? {} : {
        selections: selected.selections.map(item => ({ source_path: item.sourcePath, destination_path: item.destinationPath })) }) });
    const safe = (value: unknown) => {
      const text = JSON.stringify(value); assert(!text.includes(key)); assert(!text.includes(h.dataRoot));
      assert(!text.includes('apiKeyPrincipal')); assert(!text.includes(issued.credential.id));
    };
    const post = async (value: unknown, extras: Record<string, string> = {}, raw?: string | Uint8Array) => {
      const response = await POST(new NextRequest('http://localhost/api/documents/copy', { method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Canvas-API-Key': key, ...extras }, body: raw ?? JSON.stringify(value) }));
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
        'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'native-key-copy-adapter', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } : {}) } }) }));
      assert.equal(response.headers.get('www-authenticate'), null); assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json(); safe(body); return { status: response.status, body };
    };
    const mcp = (selected: Job, action: 'preview' | 'apply' | 'recover' | 'status', modern = false) =>
      rpc('tools/call', { name: 'copy_knowledge_source', arguments: mcpInput(selected, action) }, modern);
    const snapshot = async () => {
      const rows: Record<string, unknown> = {};
      for (const name of ['collaboration_documents', 'collaboration_yjs_states', 'collaboration_excalidraw_states', 'collaboration_excalidraw_assets',
        'collaboration_native_copy_receipts', 'collaboration_excalidraw_copy_receipts', 'workspace_file_operations', 'workspace_file_operation_steps', 'file_revisions']) {
        rows[name] = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM "${name}" t ORDER BY to_jsonb(t)::text,xmin::text`)).rows;
      }
      return rows;
    };
    const completed = async (selected: Job, result: Extract<DirectMcpWorkspaceCopyResultV1, { action: 'apply' | 'recover' }>, known: boolean) => {
      assert.equal(result.apiVersion, 1); assert.equal(result.execution.status, 'complete', result.execution.errorCode);
      assert.equal(result.alreadyKnown, known); assert.deepEqual(result.copied, [selected.destinationPath]);
      const row = (await h.admin.query('SELECT * FROM workspace_file_operations WHERE operation_id=$1', [selected.operationId])).rows[0];
      assert.equal(row.status, 'completed'); assert.equal(JSON.parse(row.request_json).origin.version, 3);
      const native = (await h.admin.query('SELECT * FROM collaboration_native_copy_receipts WHERE operation_id=$1', [selected.operationId])).rows[0];
      assert.equal(native.actor_session_id, null); assert.equal(native.private_result.documents.length, 2);
      assert.deepEqual(await fs.readFile(path.join(h.destination.rootPath, selected.destinationPath, 'manual.pdf')), original.pdf);
      assert.deepEqual(await original.sourceSnapshot(), original.sourceBefore);
      assert.equal(await staging.loadManagedCopyByOperationId(selected.operationId), null);
    };
    const preview = async (selected: Job) => {
      const result = await post(input(selected, 'preview')); assert.equal(result.status, 200);
      assert.equal(result.body.action, 'preview'); assert.equal(result.body.preview.readiness, 'ready'); selected.planId = result.body.preview.planId;
      assert(/^[a-f0-9]{64}$/u.test(selected.planId)); return result;
    };
    const check = async (name: string, action: () => Promise<void>) => { stage = name; await action(); groups++;
      console.log(`API-key native Copy adapters passed: ${name}`); };
    await check('strict data-only REST/native decoding, bounded bodies and exact proxy exclusion preserve protected neighboring routes', async () => {
      let getters = 0;
      assert.throws(() => decodeApiKeyWorkspaceCopyRequest({ ...input(job(), 'preview'), get selections() { getters++; return []; } }, 'request'));
      const hostile = new Proxy({}, { getPrototypeOf() { getters++; throw new Error('No proxy inspection.'); } });
      assert.equal(apiKeyWorkspaceCopyFailure(hostile, hostile, 'request').body.code, 'COPY_UNAVAILABLE'); assert.equal(getters, 0);
      const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });
      assert.equal(matches('/api/documents/copy'), false); assert.equal(matches('/api/documents/copy/status'), true);
      assert.equal(matches('/api/documents/copy-extra'), true); assert.equal(matches('/api/files/copy'), true); assert.equal(matches('/api/secrets'), true);
      const before = await snapshot();
      for (const value of [{ ...input(job(), 'preview'), actor: { userId: 'owner' } }, { ...input(job(), 'preview'), apiVersion: 2 },
        { sources: [original.root], destDir: 'legacy', overwrite: true }, { ...input(job(), 'preview'), selections: [{ sourcePath: '../escape', destinationPath: 'x' }] }]) {
        const response = await post(value); assert.equal(response.status, 400); assert.equal(response.body.code, 'INVALID_REQUEST');
      }
      assert.equal((await post({}, {}, new Uint8Array([123, 34, 255, 34, 125]))).status, 400);
      assert.equal((await post({}, {}, ' '.repeat(65537))).status, 413);
      assert.equal((await post({}, { 'X-Canvas-API-Key': 'invalid-key' }, ' '.repeat(65537))).status, 401);
      const hidden = await rpc('tools/call', { name: 'copy_knowledge_source', arguments: { ...mcpInput(job(), 'preview'),
        selections: [{ source_path: '.hidden', destination_path: 'visible' }] } });
      assert.equal(hidden.body.result.structuredContent.code, 'ACCESS_DENIED');
      assert.deepEqual(await snapshot(), before);
    });
    let baseline!: Job;
    await check('genuine REST preview/apply publishes native mixed Copy with original source and explicit key attribution', async () => {
      baseline = job(); await preview(baseline);
      const result = await post(input(baseline, 'apply')); assert.equal(result.status, 200); await completed(baseline, result.body, false);
    });
    await check('both actual MCP protocols advertise native Copy V1 key schemas and execute exact arguments through the registered tool', async () => {
      for (const modern of [false, true]) {
        const list = await rpc('tools/list', {}, modern); assert.equal(list.status, 200);
        const descriptor = list.body.result.tools.find((tool: { name: string }) => tool.name === 'copy_knowledge_source'); assert(descriptor);
        assert.deepEqual(descriptor.securitySchemes, [{ type: 'apiKey', in: 'header', name: 'X-Canvas-API-Key' }]);
        const schema = new AjvJsonSchemaValidator();
        assert.equal(schema.getValidator(descriptor.inputSchema)({ sources: ['legacy'], overwrite: true }).valid, false);
        assert.equal(schema.getValidator(descriptor.outputSchema)({ apiVersion: 1, success: false, code: 'API_KEY_ACCESS_DENIED' }).valid, true);
        const selected = job(), plan = await mcp(selected, 'preview', modern); assert.equal(plan.status, 200); assert.equal(plan.body.result.isError, undefined);
        selected.planId = plan.body.result.structuredContent.preview.planId;
        const result = await mcp(selected, 'apply', modern); assert.equal(result.status, 200); assert.equal(result.body.result.isError, undefined);
        const value = result.body.result.structuredContent; assert.equal(schema.getValidator(descriptor.outputSchema)(value).valid, true);
        await completed(selected, value, false);
      }
    });
    await check('rotation and cross-transport exact retry preserve original receipt, history rows and all SQL xmins', async () => {
      const before = await snapshot(), originalRow = (await h.admin.query('SELECT request_json FROM workspace_file_operations WHERE operation_id=$1', [baseline.operationId])).rows[0];
      assert.equal(JSON.parse(originalRow.request_json).origin.entryPoint, 'request');
      const old = key, rotated = await rotateApiKey(manager, issued.integration.id, { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
      key = rotated.key; credentialId = rotated.credential.id;
      const retry = await mcp(baseline, 'apply', true); assert.equal(retry.body.result.isError, undefined); await completed(baseline, retry.body.result.structuredContent, true);
      assert.deepEqual(await snapshot(), before); assert.equal((await post(input(baseline, 'status'), { 'X-Canvas-API-Key': old })).status, 401);
      const status = await post(input(baseline, 'status')); assert.equal(status.status, 200); assert.equal(status.body.operation.completion.status, 'confirmed');
      assert.deepEqual(await snapshot(), before);
    });
    await check('actual B1 acknowledgement loss keeps original IDs and Stage for explicit public MCP recovery without replay', async () => {
      const selected = job(); await preview(selected); let b1: MetadataSqlEvent['client'] | undefined, fired = false;
      const result = await h.withProbe(async event => {
        if (/^\s*INSERT INTO collaboration_excalidraw_copy_receipts\b/iu.test(event.text) && event.values.includes(selected.operationId)) b1 = event.client;
        if (!fired && b1 === event.client && /^\s*COMMIT\s*$/iu.test(event.text)) {
          fired = true; assert.equal((await h.admin.query('SELECT publication_status FROM collaboration_native_copy_receipts WHERE operation_id=$1', [selected.operationId])).rows[0].publication_status, 'native_committed');
          throw Object.assign(new Error('Fixture loses actual committed Copy response.'), { code: 'EIO' });
        }
      }, () => post(input(selected, 'apply')));
      assert(fired); assert.equal(result.status, 200); assert.equal(result.body.execution.status, 'needs_recovery');
      assert.equal(result.body.execution.errorCode, 'COPY_OUTCOME_UNCONFIRMED'); const retained = await staging.loadManagedCopyByOperationId(selected.operationId); assert(retained);
      const before = await snapshot(), status = await mcp(selected, 'status'); assert.equal(status.body.result.structuredContent.operation.completion.status, 'not_confirmed');
      assert.deepEqual(await snapshot(), before); assert.equal((await staging.loadManagedCopyByOperationId(selected.operationId))?.payloadSha256, retained.payloadSha256);
      const recovered = await mcp(selected, 'recover', true); assert.equal(recovered.body.result.isError, undefined); await completed(selected, recovered.body.result.structuredContent, true);
    });
    await check('unknown status/recovery, withdrawn actions and current destination ACL are safe bounded public denials', async () => {
      const unknown = job(); unknown.planId = baseline.planId; const before = await snapshot();
      assert.equal((await post(input(unknown, 'status'))).status, 404); assert.equal((await post(input(unknown, 'recover'))).status, 404);
      await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name, workspaceIds, actions: ['read', 'copy'] });
      assert.equal((await post(input(baseline, 'status'))).status, 403); assert.equal((await post(input(baseline, 'recover'))).status, 403);
      await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name, workspaceIds, actions: [...actions] });
      await h.admin.query("UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id='member'", [workspaceIds[1]]);
      assert.equal((await post(input(baseline, 'status'))).status, 403);
      await h.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [workspaceIds[1]]);
      assert.deepEqual(await snapshot(), before);
    });
    await check('mixed credentials and the actual MCP tool switch cannot bypass the separate key authority', async () => {
      const before = await snapshot();
      assert.equal((await post(input(baseline, 'status'), { cookie: 'better-auth.session_token=invalid' })).status, 401);
      assert.equal((await post(input(baseline, 'status'), { authorization: 'Bearer invalid' })).status, 401);
      const sessionOnly = await POST(new NextRequest('http://localhost/api/documents/copy', { method: 'POST', headers: manager, body: JSON.stringify(input(baseline, 'status')) }));
      assert.equal(sessionOnly.status, 401);
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source';
      const disabledList = await rpc('tools/list', {});
      assert(!disabledList.body.result.tools.some((tool: { name: string }) => tool.name === 'copy_knowledge_source'));
      const disabled = await mcp(baseline, 'status'); assert.equal(disabled.body.error.code, -32601);
      assert.equal((await post(input(baseline, 'status'))).body.operation.completion.status, 'confirmed');
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'copy_knowledge_source,read_knowledge_source'; assert.deepEqual(await snapshot(), before);
    });
    await check('real manager revocation denies the next public key request and preserves every protected original', async () => {
      const before = await snapshot(); await revokeApiKey(manager, issued.integration.id, { expectedRevision: revision, credentialId });
      assert.equal((await post(input(baseline, 'status'))).status, 401);
      assert.deepEqual(await snapshot(), before); assert.deepEqual(await original.sourceSnapshot(), original.sourceBefore);
    });
  });
  console.log(`API-key native Copy adapters: ${groups} genuine REST/registered-MCP/SQL/FD groups passed. Installed SDK Copy remains separate.`);
}
main().catch(error => { console.error(JSON.stringify({ suite: 'api-key-native-copy-adapters', stage, error: error instanceof Error ? error.name : 'UnknownError',
  code: error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string' ? Reflect.get(error, 'code') : undefined,
  ...(error instanceof assert.AssertionError ? { actual: typeof error.actual === 'number' ? error.actual : typeof error.actual,
    expected: typeof error.expected === 'number' ? error.expected : typeof error.expected } : {}) })); process.exitCode = 1; });

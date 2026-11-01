import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import type { ApiKeyAction } from '../app/lib/api-keys/contracts';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';
import { withNativeApiKeyEditRuntime } from './helpers/native-api-key-edit-runtime';

let stage = 'setup', groups = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
async function main() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    const enabled = 'get_knowledge_manifest,create_knowledge_source,import_knowledge_file,read_knowledge_source,edit_knowledge_source';
    Object.assign(process.env, { FILE_VERSION_CENTER_MODE: 'shadow', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: enabled });
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { decodeApiKeyOriginalMarkdownImportMcpSelection: decode } = await import('../app/lib/mcp/server/original-markdown-import-tool');
    const { getDirectMcpIngestToolDescriptor } = await import('../app/lib/mcp/server/ingest-tools');
    const { createApiIntegration, updateApiIntegration, rotateApiKey, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { NextRequest } = await import('next/server');
    const { POST: restImport } = await import('../app/api/documents/import-existing/route');
    const { POST: restStatus } = await import('../app/api/documents/import-existing/status/route');
    const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/server/validators/ajv');
    const originalHeaders = new Headers((await h.request(h.source, 'owner')).headers); originalHeaders.set('Origin', 'http://localhost');
    const actions: ApiKeyAction[] = ['read', 'create', 'import', 'edit', 'status'];
    const issued = await createApiIntegration(originalHeaders, { requestId: randomUUID(), name: 'MCP original importer',
      workspaceIds: [h.source.workspaceId], actions, expiresAt: Date.now() + 3_600_000 });
    const managerToken = randomBytes(32).toString('hex');
    await h.admin.query("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('mcp-original-manager',$1,'owner',$2,$3,$3)",
      [managerToken, Date.now() + 3_600_000, Date.now()]);
    const manager = new Headers({ Authorization: `Bearer ${managerToken}`, Origin: 'http://localhost' });
    let key = issued.key, credentialId = issued.credential.id, revision = 1, rpcId = 0;
    const rpc = async (method: 'tools/list' | 'tools/call', params: Record<string, unknown>, modern = false) => {
      const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'X-Canvas-API-Key': key,
        'mcp-protocol-version': modern ? '2026-07-28' : '2025-11-25', ...(modern ? { 'mcp-method': method,
          ...(method === 'tools/call' ? { 'mcp-name': params.name as string } : {}) } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: { ...params, ...(modern ? { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'key-original-import-fixture', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } : {}) } }) }));
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('www-authenticate'), null);
      const body = await response.json(); assert(!JSON.stringify(body).includes(key));
      if (body.error || body.result?.isError) console.log(JSON.stringify({ suite: 'mcp-original-import-response', request: rpcId,
        tool: params.name, status: response.status, code: body.result?.structuredContent?.code, protocolCode: body.error?.code }));
      return { status: response.status, body };
    };
    const call = (name: string, args: Record<string, unknown>, modern = false) => rpc('tools/call', { name, arguments: args }, modern);
    const invoke = (args: Record<string, unknown>, modern = false) => call('import_knowledge_file', args, modern);
    const rest = async (action: 'import' | 'status', body: unknown) => {
      const response = await (action === 'import' ? restImport : restStatus)(new NextRequest(`http://localhost/api/documents/import-existing${action === 'status' ? '/status' : ''}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-API-Key': key }, body: JSON.stringify(body) }));
      return { status: response.status, body: await response.json() };
    };
    const physical = async (file: string, text = 'Before MCP original.\n') => {
      await fs.writeFile(path.join(h.source.rootPath, file), text, { flag: 'wx', mode: 0o600 });
      return { api_version: 1, action: 'import_existing', workspace_id: h.source.workspaceId, path: file,
        operation_id: `mcp_original_${randomUUID().replaceAll('-', '')}`, initial_representation: 'plain_text' };
    };
    const statusOf = (value: Record<string, unknown>) => ({ api_version: 1, action: 'status_existing', workspace_id: value.workspace_id, operation_id: value.operation_id });
    const stored = async (caller: unknown) => (await h.admin.query(`SELECT o.original_text,o.xmin::text AS original_xmin,r.private_result,r.xmin::text AS receipt_xmin
      FROM collaboration_original_markdown_import_api_keys o JOIN collaboration_markdown_file_import_receipts r USING(workspace_id,operation_id)
      WHERE o.workspace_id=$1 AND o.original_text::jsonb->>'callerOperationId'=$2`, [h.source.workspaceId, caller])).rows;
    const check = async (name: string, consume: () => Promise<void>) => { stage = name; await consume(); groups++;
      console.log(`API-key original import MCP passed: ${name}`); };
    const validator = new AjvJsonSchemaValidator();
    let selected: Record<string, unknown>, original: Record<string, unknown>;
    await withNativeApiKeyEditRuntime(h, async () => {
      await check('finite exact decoding never evaluates accessors/proxies or accepts serialized authority', async () => {
        let reads = 0;
        const base = { api_version: 1, action: 'import_existing', workspace_id: h.source.workspaceId, operation_id: 'mcp-original-probe',
          path: 'probe.md', expected_file_version: '1:2:3:4:5' };
        assert.throws(() => decode({ ...base, get path() { reads++; return 'probe.md'; } }));
        assert.throws(() => decode(new Proxy(base, { getPrototypeOf() { reads++; throw new Error('Must not inspect proxy.'); } })));
        assert.equal(reads, 0);
        for (const bad of [{ ...base, origin: { userId: 'owner' } }, { ...base, file: { file_id: 'host-reference' } },
          { ...base, initial_representation: null }, { ...statusOf(base), path: 'probe.md' },
          { ...statusOf(base), operation_id: '_invalid_first_character' }]) assert.throws(() => decode(bad));
        assert.equal(decode({ api_version: 1, workspace_id: h.source.workspaceId, path: 'upload.md', idempotency_key: 'normal-upload-1', file: {} }), null);
      });
      await check('both discovery protocols expose exact upload/original/status branches and bounded outputs', async () => {
        for (const modern of [false, true]) {
          const list = await rpc('tools/list', {}, modern); assert.equal(list.status, 200); assert.equal(list.body.error, undefined);
          const tool = list.body.result.tools.find((value: { name: string }) => value.name === 'import_knowledge_file'); assert(tool);
          assert.deepEqual(tool.securitySchemes, [{ type: 'apiKey', in: 'header', name: 'X-Canvas-API-Key' }]);
          assert.equal(tool.inputSchema.oneOf.length, 3);
          const input = validator.getValidator(tool.inputSchema), output = validator.getValidator(tool.outputSchema);
          const apply = { api_version: 1, action: 'import_existing', workspace_id: h.source.workspaceId,
            path: 'probe.md', operation_id: 'mcp-original-schema', expected_file_version: '1:2:3:4:5' };
          assert.equal(input(apply).valid, true); assert.equal(input(statusOf(apply)).valid, true);
          const upload = { api_version: 1, workspace_id: h.source.workspaceId, path: 'new.md', idempotency_key: 'original-upload-1',
            file: { download_url: 'https://example.test/file.md', file_id: 'host-file-1' } };
          assert.equal(input(upload).valid, true); assert.equal(input({ ...upload, action: 'import_existing' }).valid, false);
          assert.equal(input({ ...statusOf(apply), path: 'probe.md' }).valid, false); assert.equal(input({ ...apply, file: upload.file }).valid, false);
          assert.equal(input({ ...upload, file: undefined }).valid, false);
          assert.equal(output({ apiVersion: 1, operationId: apply.operation_id, status: 'not_found', requiresFreshFileActionPreview: true }).valid, true);
          assert.equal(output({ apiVersion: 1, success: false, code: 'MARKDOWN_IMPORT_REQUEST_CONFLICT' }).valid, true);
          const create = list.body.result.tools.find((value: { name: string }) => value.name === 'create_knowledge_source');
          assert.equal(validator.getValidator(create.inputSchema)({ api_version: 1, workspace_id: h.source.workspaceId, path: 'new.md', idempotency_key: 'create-shape-1' }).valid, false);
        }
        const oauth = getDirectMcpIngestToolDescriptor('import_knowledge_file');
        assert.deepEqual(oauth.inputSchema.properties?.action, { type: 'string', enum: ['create', 'status'], default: 'create',
          description: 'Use status with workspace_id, path and the original idempotency_key to inspect durable storage without writing or resubmitting content.' });
        assert.equal(Object.hasOwn(oauth.inputSchema.properties ?? {}, 'expected_file_version'), false);
      });
      for (const modern of [false, true]) await check(`${modern ? 'modern' : 'legacy'} actual manifest -> original import -> native Read/Edit -> historical Status`, async () => {
        const value = await physical(`mcp-original-${modern}.md`), bytes = await fs.readFile(path.join(h.source.rootPath, value.path));
        const manifest = await call('get_knowledge_manifest', { workspace_id: h.source.workspaceId }, modern);
        assert.equal(manifest.status, 200); assert.equal(manifest.body.result?.isError, undefined);
        const entry = manifest.body.result.structuredContent.entries.find((row: { path: string }) => row.path === value.path); assert(entry?.file_version);
        const args = { ...value, expected_file_version: entry.file_version };
        const wrong = await invoke({ ...args, expected_file_version: entry.revision }, modern); assert.equal(wrong.body.error?.code, -32602);
        const applied = await invoke(args, modern); assert.equal(applied.status, 200); assert.equal(applied.body.result?.isError, undefined);
        const result = applied.body.result.structuredContent; assert.equal(result.status, 'confirmed'); assert.equal(result.outcome, 'imported');
        assert.equal(result.operationId, value.operation_id); assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, value.path)), bytes);
        const list = await rpc('tools/list', {}, modern); const descriptor = list.body.result.tools.find((row: { name: string }) => row.name === 'import_knowledge_file');
        assert.equal(validator.getValidator(descriptor.outputSchema)(result).valid, true);
        const before = await stored(value.operation_id), origin = JSON.parse(before[0].original_text).origin;
        assert.equal(origin.entryPoint, 'mcp'); assert.equal(origin.purpose, 'import_existing'); assert.equal(origin.credentialId, issued.credential.id);
        assert(!Object.keys(origin).some(name => /session|token|secret/iu.test(name)));
        const read = await call('read_knowledge_source', { workspace_id: h.source.workspaceId,
          document_id: result.documentAtImport.documentId, format: 'markdown' }, modern);
        assert.equal(read.body.result?.isError, undefined); const page = read.body.result.structuredContent; assert.equal(page.fragment, bytes.toString('utf8'));
        const edited = await call('edit_knowledge_source', { api_version: 1, action: 'edit', workspace_id: h.source.workspaceId,
          document_id: result.documentAtImport.documentId, expected_version: page.document.version,
          idempotency_key: `mcp-original-edit-${modern}`, patch: { kind: 'native_text_replace', edits: [{ oldText: 'Before', newText: 'After' }] } }, modern);
        assert.equal(edited.body.result?.isError, undefined); assert.equal(edited.body.result.structuredContent.state, 'confirmed');
        const historical = await invoke(statusOf(value), modern); assert.equal(historical.body.result?.isError, undefined);
        assert.deepEqual(historical.body.result.structuredContent.documentAtImport, result.documentAtImport);
        assert.deepEqual((await invoke(args, modern)).body.result.structuredContent.documentAtImport, result.documentAtImport);
        assert.deepEqual(await stored(value.operation_id), before); selected = args; original = result;
      });
      await check('rotation and REST cross-entry retry retain original MCP attribution and immutable rows', async () => {
        const before = await stored(selected.operation_id);
        const next = await rotateApiKey(manager, issued.integration.id, { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
        key = next.key; credentialId = next.credential.id;
        const repeated = await invoke(selected, true); assert.equal(repeated.body.result?.isError, undefined);
        const known = await rest('status', { apiVersion: 1, workspaceId: h.source.workspaceId, operationId: selected.operation_id });
        assert.equal(known.status, 200); assert.deepEqual(known.body.documentAtImport, original.documentAtImport);
        assert.deepEqual(await stored(selected.operation_id), before);
      });
      await check('mixed shapes, wrong tools and changed selections reject without fallback or a new native receipt', async () => {
        const before = await stored(selected.operation_id);
        for (const modern of [false, true]) {
          for (const bad of [{ ...selected, file: { file_id: 'never-download' } }, { ...selected, origin: { userId: 'owner' } },
            { ...statusOf(selected), expected_file_version: selected.expected_file_version }]) assert.equal((await invoke(bad, modern)).body.error?.code, -32602);
          assert.equal((await call('create_knowledge_source', selected, modern)).body.error?.code, -32602);
          const changed = await invoke({ ...selected, path: 'changed-original.md' }, modern); assert.equal(changed.body.result?.isError, true);
          assert.deepEqual(changed.body.result.structuredContent, { apiVersion: 1, success: false, code: 'MARKDOWN_IMPORT_REQUEST_CONFLICT' });
        }
        assert.deepEqual(await stored(selected.operation_id), before);
      });
      await check('hidden originals created through HTTP never leak through MCP import or historical Status', async () => {
        const hidden = await physical('.mcp-original-hidden.md'); const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
        const fileVersion = filesystemFileVersion(await fs.stat(path.join(h.source.rootPath, hidden.path)));
        const applied = await rest('import', { apiVersion: 1, workspaceId: h.source.workspaceId, path: hidden.path,
          operationId: hidden.operation_id, expectedFileVersion: fileVersion, initialRepresentation: 'plain_text' }); assert.equal(applied.status, 200);
        assert.equal((await invoke({ ...hidden, expected_file_version: fileVersion })).body.error?.code, -32602);
        const status = await invoke(statusOf(hidden), true); assert.equal(status.body.result?.isError, true);
        assert.deepEqual(status.body.result.structuredContent, { apiVersion: 1, success: false, code: 'MARKDOWN_IMPORT_REQUEST_CONFLICT' });
      });
      await check('Import and Status grants are distinct and the real import tool switch controls discovery/execution', async () => {
        await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
          workspaceIds: [h.source.workspaceId], actions: ['import'] });
        assert.equal((await invoke(selected)).body.result?.isError, undefined);
        assert.deepEqual((await invoke(statusOf(selected))).body.result.structuredContent, { apiVersion: 1, success: false, code: 'API_KEY_ACCESS_DENIED' });
        await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
          workspaceIds: [h.source.workspaceId], actions });
        process.env.CANVAS_MCP_DIRECT_TOOLS = enabled.replace('import_knowledge_file,', '');
        const list = await rpc('tools/list', {}); assert(!list.body.result.tools.some((row: { name: string }) => row.name === 'import_knowledge_file'));
        assert.equal((await invoke(selected)).body.error?.code, -32601); process.env.CANVAS_MCP_DIRECT_TOOLS = enabled;
      });
      await check('real COMMIT acknowledgement loss returns the same caller operation with one durable original', async () => {
        const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
        const value = await physical('mcp-original-commit-ack.md');
        const args = { ...value, expected_file_version: filesystemFileVersion(await fs.stat(path.join(h.source.rootPath, value.path))) };
        let mutation: PoolClient | undefined, internalId = '', inserted = 0, faulted = false;
        const response = await h.withProbe(async event => {
          if (/INSERT\s+INTO\s+(?:"[^".]+"\.)?collaboration_original_markdown_import_api_keys\b/iu.test(event.text)) {
            mutation = event.client; internalId = String(event.values[1]); inserted++;
          }
          if (/^COMMIT\s*;?\s*$/iu.test(event.text.trim()) && event.client === mutation && !faulted) {
            assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_original_markdown_import_api_keys WHERE operation_id=$1', [internalId])).rows[0].n, 1);
            faulted = true; throw new Error('FIXTURE_MCP_ORIGINAL_COMMIT_ACK_LOST');
          }
        }, () => invoke(args, true));
        assert(faulted); assert.equal(inserted, 1); assert.equal(response.body.result?.isError, undefined);
        assert.equal(response.body.result.structuredContent.operationId, value.operation_id);
        assert.deepEqual((await invoke(statusOf(value))).body.result.structuredContent.documentAtImport, response.body.result.structuredContent.documentAtImport);
      });
      await check('issuer Session expiration leaves genuine key access valid', async () => {
        assert.equal((await h.admin.query("UPDATE session SET expires_at=1 WHERE id='session-owner' RETURNING id")).rowCount, 1);
        assert.equal((await invoke(selected, true)).body.result?.isError, undefined);
        assert.equal((await invoke(statusOf(selected))).body.result?.isError, undefined);
      });
      await check('actual key revocation returns HTTP 401 without adopting another principal', async () => {
        const before = await stored(selected.operation_id); await revokeApiKey(manager, issued.integration.id, { expectedRevision: revision++, credentialId });
        assert.equal((await invoke(statusOf(selected), true)).status, 401); assert.equal((await rpc('tools/list', {})).status, 401);
        assert.deepEqual(await stored(selected.operation_id), before);
      });
    });
    console.log(JSON.stringify({ suite: 'api-key-original-import-mcp', groups, jsonRpcRequests: rpcId, protocols: ['2025-11-25', '2026-07-28'],
      actualHandlers: true, actualPostgres: true, actualNativeEdit: true, actualCommitAckLoss: true, tcpOrInstalledClient: false }));
  });
  complete = true;
}
main().catch(error => { console.error(JSON.stringify({ suite: 'api-key-original-import-mcp', passed: false, stage,
  name: error?.name, code: error?.code, message: error?.message, stack: error?.stack })); process.exitCode = 1; });

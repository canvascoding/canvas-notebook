import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { Hocuspocus } from '@hocuspocus/server';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { DocumentReadPageV1 } from '../app/lib/documents/contracts';
import type { DocumentEditOperationResultV1 } from '../app/lib/documents/edit-result-contract';
import { withDocumentReadToolDispatchFixture, type DispatchDocument } from './helpers/document-read-tool-dispatch-fixture';

// Genuine signed fixture JWTs and current PG grants enter the registered
// modern MCP Web Request transport. PI enters the actual registry, argument
// preparation/validation and execution wrapper. A real local Hocuspocus/PG
// room owner performs the edits. This is no compiled/OAuth-issuance, browser,
// live chat-turn or OS/FD-sandbox acceptance claim. No authority/writer/SQL
// result or runtime-config reader is substituted.
type Row = Record<string, unknown>;
let currentCase = 'setup', passed = 0, completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
function object(value: unknown): Row {
  assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Row;
}
function ownCode(value: unknown): unknown {
  return value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'code')?.value : undefined;
}
function text(value: { content: unknown }): string {
  assert(Array.isArray(value.content)); assert.equal(value.content.length, 1);
  const entry = object(value.content[0]); assert.equal(entry.type, 'text'); assert.equal(typeof entry.text, 'string'); return entry.text as string;
}
async function bounded<T>(value: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([value, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), 12000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function publicOnly(value: unknown): void {
  const row = object(value);
  for (const field of ['original', 'after', 'origin', 'actor', 'targets', 'stateProof', 'stateVector', 'yjsState',
    'rootPath', 'schemaOid', 'databaseOid', 'accessToken', 'sessionId', 'clientId', 'requestFingerprint']) {
    assert.equal(Object.hasOwn(row, field), false, field);
  }
  if (row.document) {
    assert.deepEqual(Object.keys(object(row.document)).sort(), ['documentId', 'kind', 'lifecycleGeneration', 'lineageId',
      'organizationId', 'representation', 'schemaVersion', 'workspaceId'].sort());
  }
}

export async function nativeDocumentEditToolDispatchPostgresTest(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { admin, workspaceId, clientId, agentId, piSessionId } = fixture;
    // Actual fixture settings/SQL rows grant Write. The fixture initially
    // proves only Read; no WorkspaceContext/permissions DTO is manufactured.
    process.env.FILE_VERSION_CENTER_MODE = 'shadow';
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,edit_knowledge_source';
    await admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=1
      WHERE organization_id='tool-dispatch-org' AND user_id='reader' AND status='active'`);
    await admin.query('UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2 AND user_id=$3',
      [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write']), clientId, 'reader']);
    await fixture.setPiEnabledTools(['read_document', 'edit_file']);
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { DIRECT_MCP_PROTOCOL_VERSION: protocol } = await import('../app/lib/mcp/server/config');
    const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/server/validators/ajv');
    const { DOCUMENT_EDIT_OPERATION_RESULT_JSON_SCHEMA_V1, encodeDocumentEditOperationResultV1 } = await import('../app/lib/documents/edit-result-contract');
    const { DOCUMENT_EDIT_FAILURE_JSON_SCHEMA_V1 } = await import('../app/lib/documents/edit-tool-contract');
    const { captureNativeDocumentEditOriginal, nativeDocumentEditLedgerKey } = await import('../app/lib/collaboration/native-document-edit-operation-contract');
    const { getPiTools, piTools } = await import('../app/lib/pi/tool-registry');
    const { getAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { captureCurrentAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
    const { validateToolArguments } = await import('@earendil-works/pi-ai');
    const { createCollaborationServer, flushCollaborationDocuments } = await import('../server/collaboration-server');
    const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
    const runtime = await import('../app/lib/db'); const pool = runtime.getPostgresRuntimeQueryable(); assert(pool);
    const schema = String((await admin.query('SELECT current_schema() AS schema')).rows[0].schema);
    assert.match(schema, /^document_tool_dispatch_[a-f0-9]+$/u);
    const applicationName = String((await admin.query("SELECT current_setting('application_name') AS value")).rows[0].value);
    const ownerClients = new Set<Client>(), owners = new Set<Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>>();
    const backends: Array<{ pid: number; start: string }> = [];
    const ownerRuntime: { current?: Hocuspocus } = {}, originalHooks = Hocuspocus.prototype.hooks;
    let wss: ReturnType<typeof createCollaborationServer> | undefined, primary: unknown;
    const server = http.createServer((_request, response) => { response.statusCode = 404; response.end(); });
    const createSession = async (onInvalidated: () => void) => {
      const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: applicationName,
        options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`, connectionTimeoutMillis: 5000 });
      ownerClients.add(client); client.on('error', () => undefined); await client.connect();
      const actual = (await client.query(`SELECT current_schema() AS schema,pg_backend_pid() AS pid,
        extract(epoch FROM backend_start)::text AS start FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
      assert.equal(actual.schema, schema); backends.push({ pid: actual.pid, start: actual.start });
      const owner = await createCollaborationRoomOwnerSession({ query: client.query.bind(client), on: client.on.bind(client),
        end: async () => { await client.end(); ownerClients.delete(client); } }, onInvalidated);
      owners.add(owner); return owner;
    };
    const validator = new AjvJsonSchemaValidator();
    const validateResult = validator.getValidator<DocumentEditOperationResultV1>(DOCUMENT_EDIT_OPERATION_RESULT_JSON_SCHEMA_V1);
    const validateFailure = validator.getValidator(DOCUMENT_EDIT_FAILURE_JSON_SCHEMA_V1);
    let inputValidator: ReturnType<typeof validator.getValidator<unknown>> | undefined;
    let outputValidator: ReturnType<typeof validator.getValidator<unknown>> | undefined;
    let token = await fixture.issue({ scope: 'knowledge:read knowledge:search knowledge:write' }), rpcId = 0;
    const rpc = async (method: string, params: Row = {}, actualToken: string | null = token) => {
      const id = ++rpcId;
      const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol,
        'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}),
        ...(actualToken === null ? {} : { authorization: `Bearer ${actualToken}` }),
      }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': protocol,
        'io.modelcontextprotocol/clientInfo': { name: 'native-edit-dispatch-fixture', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } }) }));
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const body = object(await response.json());
      if (response.status === 200) { assert.equal(body.id, id); assert.equal(body.jsonrpc, '2.0'); }
      else { assert.equal(response.status, 401); assert.equal(body.error, 'invalid_token'); assert.equal(Object.hasOwn(body, 'result'), false); }
      return { response, body };
    };
    const call = async (name: string, args: Row, actualToken: string | null = token): Promise<Row> => {
      const out = await rpc('tools/call', { name, arguments: args }, actualToken);
      assert.equal(out.response.status, 200); assert.equal(Object.hasOwn(out.body, 'error'), false); return object(out.body.result);
    };
    const selected = (target: DispatchDocument, expectedVersion: string, key: string, oldText: string, newText: string): Row => ({
      api_version: 1, action: 'edit', workspace_id: workspaceId, document_id: target.documentId,
      expected_version: expectedVersion, idempotency_key: key, patch: { kind: 'native_text_replace', edits: [{ oldText, newText }] },
    });
    const status = (operationId: string): Row => ({ api_version: 1, action: 'status', workspace_id: workspaceId, operation_id: operationId });
    const result = (out: Row): DocumentEditOperationResultV1 => {
      if (out.isError === true) console.error(JSON.stringify({ diagnostic: 'Unexpected public Edit tool error', currentCase, code: object(out.structuredContent).code }));
      assert.notEqual(out.isError, true); const body = object(out.structuredContent); assert.deepEqual(JSON.parse(text(out as { content: unknown })), body);
      const checked = validateResult(body); assert.equal(checked.valid, true, checked.errorMessage ?? 'Native result schema');
      assert(outputValidator); assert.equal(outputValidator(body).valid, true); publicOnly(body);
      assert.deepEqual(encodeDocumentEditOperationResultV1(body), body); assert(Buffer.byteLength(JSON.stringify(body)) <= 8192);
      return checked.data!;
    };
    const failure = (out: Row, code: string) => {
      assert.equal(out.isError, true); const body = object(out.structuredContent); assert.equal(body.apiVersion, 1);
      assert.equal(body.success, false); assert.equal(body.code, code); assert.deepEqual(JSON.parse(text(out as { content: unknown })), body);
      assert.equal(validateFailure(body).valid, true); assert(outputValidator); assert.equal(outputValidator(body).valid, true);
      publicOnly(body); assert.equal(Object.hasOwn(body, 'document'), false); assert.equal(Object.hasOwn(body, 'effect'), false);
    };
    const challenge = (out: Row, code: string, oauth: string) => {
      failure(out, code); const challenges = object(out._meta)['mcp/www_authenticate']; assert(Array.isArray(challenges)); assert.equal(challenges.length, 1);
      assert.equal(typeof challenges[0], 'string'); assert.match(challenges[0], /^Bearer /u); assert(challenges[0].includes(`error="${oauth}"`));
      if (oauth === 'insufficient_scope') assert(challenges[0].includes('knowledge:write'));
    };
    const read = async (target: DispatchDocument): Promise<DocumentReadPageV1> => {
      const out = await call('read_knowledge_source', { workspace_id: workspaceId, document_id: target.documentId, format: 'text' });
      assert.notEqual(out.isError, true); const page = object(out.structuredContent) as unknown as DocumentReadPageV1;
      assert.equal(page.document.documentId, target.documentId); assert.equal(page.complete, true); assert.equal(page.nextCursor, null); return page;
    };
    const rows = async () => ({ domain: await fixture.snapshot(),
      operations: (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_agent_operations ORDER BY operation_id')).rows,
      payloads: (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_agent_native_edit_payloads ORDER BY operation_id')).rows,
      contents: (await admin.query('SELECT *,xmin::text AS original_xmin FROM file_revision_contents ORDER BY revision_id')).rows,
      blobs: (await admin.query('SELECT *,xmin::text AS original_xmin FROM file_version_blobs ORDER BY blob_id')).rows,
    });
    const stored = async (operationId: string) => {
      const row = (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_agent_operations WHERE operation_id=$1', [operationId])).rows[0];
      assert(row); return { row, original: captureNativeDocumentEditOriginal(row.native_edit_original_json) };
    };
    const unchanged = async (action: () => Promise<void>) => {
      await flushCollaborationDocuments(); const before = await rows(); await action(); assert.deepEqual(await rows(), before);
    };
    const check = async (name: string, action: () => Promise<void>) => { currentCase = name; await action(); passed++; console.log(`PASS native Edit registered dispatch: ${name}`); };
    const plain = await fixture.seed({ text: 'Target MCP unique 😀 and stable tail.', filePath: 'native-mcp.md' });
    const rich = await fixture.seed({ representation: 'tiptap_xml', text: 'Target PI unique 🧪 and stable tail.', filePath: 'native-pi.md' });
    let originalRequest: Row | undefined, mcpFirst: DocumentEditOperationResultV1 | undefined, piFirst: DocumentEditOperationResultV1 | undefined;
    let registered: AgentTool | undefined;
    const piResult = (out: AgentToolResult<unknown>): DocumentEditOperationResultV1 => {
      assert.notEqual(Reflect.get(out, 'isError'), true); const body = object(JSON.parse(text(out))), { toolOutput, ...canonical } = object(out.details);
      assert.deepEqual(canonical, body); assert.equal(object(toolOutput).storedBytes, 0); assert.deepEqual(object(toolOutput).references, []);
      assert.equal(Object.hasOwn(object(out.details), 'toolOutputView'), false); assert.equal(validateResult(body).valid, true); publicOnly(body);
      return encodeDocumentEditOperationResultV1(body);
    };
    const piInvoke = async (tool: AgentTool, args: Row, toolCallId = `edit-dispatch-${crypto.randomUUID()}`) => {
      const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
      const validated = validateToolArguments(tool, { type: 'toolCall', id: toolCallId, name: tool.name,
        arguments: prepared as Parameters<typeof validateToolArguments>[1]['arguments'] });
      return tool.execute(toolCallId, validated);
    };
    const piSelection = (args: Row): Row => ({ apiVersion: args.api_version, action: args.action, workspaceId: args.workspace_id,
      documentId: args.document_id, expectedVersion: args.expected_version, idempotencyKey: args.idempotency_key, patch: args.patch });
    try {
      Hocuspocus.prototype.hooks = (async function(this: Hocuspocus, name: string, payload: Record<string, unknown>, ...args: unknown[]) {
        ownerRuntime.current = this; return Reflect.apply(originalHooks, this, [name, payload, ...args]);
      }) as typeof originalHooks;
      wss = createCollaborationServer(server, { roomOwner: { createSession, heartbeatMs: 1000 } });
      await bounded(new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); }), 'Own HTTP owner server did not listen.');

      await check('modern registered discovery/list advertises both strict native actions and the preserved legacy branch', async () => {
        const discovered = await rpc('server/discover'); assert.equal(discovered.response.status, 200);
        const discovery = object(discovered.body.result); assert(Array.isArray(discovery.supportedVersions)); assert(discovery.supportedVersions.includes(protocol));
        const listed = await rpc('tools/list'); assert.equal(listed.response.status, 200); const tools = object(listed.body.result).tools; assert(Array.isArray(tools));
        const edit = object(tools.find(value => object(value).name === 'edit_knowledge_source'));
        const input = object(edit.inputSchema), output = object(edit.outputSchema); assert.equal(input.type, 'object'); assert.equal(output.type, 'object');
        assert(Array.isArray(input.oneOf) && input.oneOf.length === 3); assert(Array.isArray(output.oneOf) && output.oneOf.length === 3);
        assert.deepEqual(output.oneOf[1], DOCUMENT_EDIT_OPERATION_RESULT_JSON_SCHEMA_V1); assert.deepEqual(output.oneOf[2], DOCUMENT_EDIT_FAILURE_JSON_SCHEMA_V1);
        assert(object(object(input.oneOf[0]).properties).path); assert(object(object(output.oneOf[0]).properties).path);
        inputValidator = validator.getValidator(input); outputValidator = validator.getValidator(output);
      });
      await check('registered MCP edit persists the actual room effect and pure status/read report its full version', async () => {
        await assert.rejects(lstat(path.join(fixture.workspaceRoot, plain.filePath)), { code: 'ENOENT' });
        const before = await read(plain); assert.equal(before.fragment, plain.text);
        originalRequest = selected(plain, before.document.version, 'mcp-caller-key-001', 'Target MCP', 'Changed MCP');
        assert(inputValidator); assert.equal(inputValidator(originalRequest).valid, true);
        const first = result(await call('edit_knowledge_source', originalRequest)); mcpFirst = first;
        assert.equal(first.state, 'confirmed'); assert(first.effect);
        assert.equal(first.effect.outcome, 'applied'); assert.equal(first.effect.beforeVersion, before.document.version);
        assert.equal(first.document.documentId, plain.documentId); assert.equal(first.document.lineageId, plain.lineageId);
        assert.equal(first.persistence.status, 'confirmed'); assert(first.persistence.confirmedInSequence! > 7);
        const after = await read(plain); assert.equal(after.fragment, 'Changed MCP unique 😀 and stable tail.');
        assert.equal(after.fragment.includes('Target MCP'), false); assert.equal(after.document.version, first.effect.afterVersion);
        const saved = await stored(first.operationId); assert.equal(saved.original.origin.transport, 'direct-mcp');
        assert(saved.original.origin.transport === 'direct-mcp'); assert.equal(saved.original.origin.sessionId, 'reader-session');
        assert.equal(saved.row.idempotency_key, nativeDocumentEditLedgerKey(saved.original.origin, 'mcp-caller-key-001'));
        assert.equal(saved.row.actor_session_id, 'reader-session');
        await unchanged(async () => { assert.deepEqual(result(await call('edit_knowledge_source', status(first.operationId))), first); });
      });
      await check('different calls and actual renewed SID B retain the caller key and immutable A operation without replay', async () => {
        const first = mcpFirst, original = originalRequest; assert(first && original);
        await unchanged(async () => { assert.deepEqual(result(await call('edit_knowledge_source', original)), first); });
        const prior = await stored(first.operationId), before = await rows(), sessionB = `dispatch-edit-B-${crypto.randomUUID()}`, now = Date.now(), tokenA = token;
        await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,'reader',$3,$4,$4)`,
          [sessionB, crypto.randomBytes(32).toString('hex'), now + 3600000, now]);
        try {
          token = await fixture.issue({ sid: sessionB, scope: 'knowledge:read knowledge:write' });
          await admin.query('UPDATE "session" SET expires_at=1 WHERE id=$1', ['reader-session']);
          const rejected = await rpc('tools/call', { name: 'edit_knowledge_source', arguments: status(first.operationId) }, tokenA);
          assert.equal(rejected.response.status, 401); assert.equal(Object.hasOwn(rejected.body, 'result'), false);
          assert.deepEqual(result(await call('edit_knowledge_source', original)), first);
          assert.deepEqual(result(await call('edit_knowledge_source', status(first.operationId))), first);
          assert.deepEqual(await stored(first.operationId), prior); assert.deepEqual(await rows(), before);
          assert.equal((await read(plain)).fragment, 'Changed MCP unique 😀 and stable tail.');
        } finally { token = tokenA; await fixture.restoreReaderSession(); await admin.query('DELETE FROM "session" WHERE id=$1', [sessionB]); }
      });
      await check('bad supplied API versions/mixed aliases never reach legacy and stale native keys return bounded errors', async () => unchanged(async () => {
        const original = originalRequest; assert(original && mcpFirst);
        for (const args of [{ ...original, api_version: 2 }, { ...original, api_version: '1' },
          { ...original, path: plain.filePath }, { ...original, apiVersion: 1 },
          { api_version: 1, workspace_id: workspaceId, path: plain.filePath, old_text: 'Changed', new_text: 'BAD' }]) {
          assert(inputValidator); assert.equal(inputValidator(args).valid, false);
          const rejected = await rpc('tools/call', { name: 'edit_knowledge_source', arguments: args });
          // The registered low-level server delegates to the strict native
          // selector, which returns the advertised bounded tool failure.
          assert.equal(rejected.response.status, 200); assert.equal(Object.hasOwn(rejected.body, 'error'), false);
          failure(object(rejected.body.result), 'INVALID_REQUEST');
        }
        failure(await call('edit_knowledge_source', { ...original, patch: { kind: 'native_text_replace', edits: [{ oldText: 'Target MCP', newText: 'Wrong second request' }] } }), 'DOCUMENT_IDEMPOTENCY_CONFLICT');
        failure(await call('edit_knowledge_source', { ...original, idempotency_key: 'different-stale-key' }), 'DOCUMENT_VERSION_CONFLICT');
      }));
      await check('real scope/session/tool/grant revocation denies Edit AND historical status without changing any document/operation rows', async () => unchanged(async () => {
        const first = mcpFirst; assert(first); const args = status(first.operationId);
        const deniedEdit = selected(plain, (await read(plain)).document.version, 'denied-edit-key-001', 'Changed MCP', 'UNAUTHORIZED');
        const readOnly = await fixture.issue({ scope: 'knowledge:read' });
        for (const selection of [args, deniedEdit]) challenge(await call('edit_knowledge_source', selection, readOnly), 'ACCESS_DENIED', 'insufficient_scope');
        const writeOnly = await fixture.issue({ scope: 'knowledge:write' }); assert.deepEqual(result(await call('edit_knowledge_source', args, writeOnly)), first);
        const deniedRead = await call('read_knowledge_source', { workspace_id: workspaceId, document_id: plain.documentId }, writeOnly);
        assert.equal(deniedRead.isError, true); const readChallenges = object(deniedRead._meta)['mcp/www_authenticate']; assert(Array.isArray(readChallenges)); assert(String(readChallenges[0]).includes('knowledge:read'));
        for (const selection of [args, deniedEdit]) challenge(await call('edit_knowledge_source', selection, null), 'AUTHENTICATION_REQUIRED', 'invalid_token');
        await admin.query('DELETE FROM mcp_direct_workspace_grant WHERE workspace_id=$1 AND client_id=$2', [workspaceId, clientId]);
        try { for (const selection of [args, deniedEdit]) failure(await call('edit_knowledge_source', selection), 'ACCESS_DENIED'); }
        finally { await admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at) VALUES($1,'reader',$2,100,100)`, [clientId, workspaceId]); }
        await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='reader' AND organization_id='tool-dispatch-org'");
        try { for (const selection of [args, deniedEdit]) failure(await call('edit_knowledge_source', selection), 'ACCESS_DENIED'); }
        finally { await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader' AND organization_id='tool-dispatch-org'"); }
        const enabled = process.env.CANVAS_MCP_DIRECT_TOOLS;
        try {
          process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source';
          const listing = await rpc('tools/list'); const tools = object(listing.body.result).tools; assert(Array.isArray(tools)); assert(!tools.some(value => object(value).name === 'edit_knowledge_source'));
          const missing = await rpc('tools/call', { name: 'edit_knowledge_source', arguments: args }); assert.equal(object(missing.body.error).code, -32601);
        } finally { process.env.CANVAS_MCP_DIRECT_TOOLS = enabled; }
      }));
      await check('actual PI registry preparation/validation/wrapper edits native XML and status remains pure', async () => {
        assert.equal(getAgentExecutionContext(), null); assert.throws(captureCurrentAgentToolInvocation, { code: 'AGENT_TOOL_INVOCATION_REQUIRED' });
        const tools = await getPiTools('reader', agentId, piSessionId, { strictAuthorization: true, metadataOnlyExternal: true });
        registered = tools.find(tool => tool.name === 'edit_file'); assert(registered); assert(registered.prepareArguments);
        const core = piTools.find(tool => tool.name === 'edit_file'); assert(core && core !== registered);
        const before = await read(rich), request = piSelection(selected(rich, before.document.version, 'pi-caller-key-001', 'Target PI', 'Changed PI'));
        assert.equal(before.fragment.split('Target PI').length - 1, 1);
        const firstCall = 'pi-first-call-distinct-001', first = piResult(await piInvoke(registered, request, firstCall)); piFirst = first;
        assert.equal(first.state, 'confirmed'); assert(first.effect); assert.equal(first.effect.beforeVersion, before.document.version);
        const after = await read(rich); assert.equal(after.fragment, before.fragment.replace('Target PI', 'Changed PI'));
        assert.equal(after.fragment.includes('Target PI'), false); assert.equal(after.document.version, first.effect.afterVersion);
        const saved = await stored(first.operationId); assert.equal(saved.original.origin.transport, 'agent-tool'); assert(saved.original.origin.transport === 'agent-tool');
        assert.equal(saved.original.origin.toolCallId, firstCall); assert.equal(saved.original.actor.sessionId, piSessionId);
        assert.equal(saved.row.idempotency_key, nativeDocumentEditLedgerKey(saved.original.origin, 'pi-caller-key-001'));
        await unchanged(async () => {
          assert.deepEqual(piResult(await piInvoke(registered!, request, 'pi-retry-call-distinct-002')), first);
          assert.deepEqual(piResult(await piInvoke(registered!, { apiVersion: 1, action: 'status', workspaceId, operationId: first.operationId })), first);
        });
        await unchanged(async () => { failure(await call('edit_knowledge_source', status(first.operationId)), 'DOCUMENT_NOT_FOUND'); });
        assert.equal(getAgentExecutionContext(), null); assert.throws(captureCurrentAgentToolInvocation, { code: 'AGENT_TOOL_INVOCATION_REQUIRED' });
      });
      await check('PI rejects native selector coercion and rechecks fresh tool/session policy after offering', async () => unchanged(async () => {
        const first = piFirst, tool = registered; assert(tool && first); const args = { apiVersion: 1, action: 'status', workspaceId, operationId: first.operationId };
        const deniedEdit = piSelection(selected(rich, (await read(rich)).document.version, 'denied-pi-edit-001', 'Changed PI', 'UNAUTHORIZED'));
        for (const malformed of [{ ...args, apiVersion: 2 }, { ...args, apiVersion: null }, { ...args, apiVersion: '1' },
          { ...args, path: rich.filePath }, { ...args, api_version: 1 }]) {
          assert.throws(() => tool.prepareArguments!(malformed), { code: 'INVALID_REQUEST' });
          const raw = await tool.execute(`raw-invalid-${crypto.randomUUID()}`, malformed);
          assert.equal(Reflect.get(raw, 'isError'), true); assert.equal(object(JSON.parse(text(raw))).code, 'INVALID_REQUEST');
        }
        await fixture.setPiEnabledTools(['read_document']);
        try { for (const selection of [args, deniedEdit]) await assert.rejects(piInvoke(tool, selection), { code: 'TOOL_POLICY_DENIED' }); }
        finally { await fixture.setPiEnabledTools(['read_document', 'edit_file']); }
        await admin.query('UPDATE pi_sessions SET archived_at=1 WHERE session_id=$1', [piSessionId]);
        try { for (const selection of [args, deniedEdit]) await assert.rejects(piInvoke(tool, selection), { code: 'PRINCIPAL_AUTH_REVOKED' }); }
        finally { await admin.query('UPDATE pi_sessions SET archived_at=NULL WHERE session_id=$1', [piSessionId]); }
      }));
      await check('the actual registered legacy path/SHA edit still matches its unchanged advertised output branch', async () => {
        const relative = 'legacy/ordinary.txt', target = path.join(fixture.workspaceRoot, relative), source = 'Legacy exact old body\n';
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, source, { flag: 'wx', mode: 0o600 });
        const old = await lstat(target); assert(old.isFile() && !old.isSymbolicLink());
        const out = await call('edit_knowledge_source', { workspace_id: workspaceId, path: relative,
          old_text: 'Legacy exact old', new_text: 'Legacy exact new', expected_sha256: crypto.createHash('sha256').update(source).digest('hex'), idempotency_key: 'legacy-edit-key-001' });
        assert.notEqual(out.isError, true); const payload = object(out.structuredContent); assert.equal(Object.hasOwn(payload, 'apiVersion'), false);
        assert(outputValidator); assert.equal(outputValidator(payload).valid, true); assert.equal(validateResult(payload).valid, false);
        assert.equal(await readFile(target, 'utf8'), 'Legacy exact new body\n');
        assert.equal(payload.path, relative); assert.equal(payload.status, 'applied'); assert.equal(payload.changed, true);
        assert.match(text(out as { content: unknown }), /Updated legacy\/ordinary\.txt\./u);
        assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
      });
    } catch (error) { primary = error; }
    finally {
      const cleanup: unknown[] = [];
      try { await flushCollaborationDocuments(); } catch (error) { cleanup.push(error); }
      const instance = ownerRuntime.current;
      if (instance) {
        for (const doc of [...instance.documents.values()]) try { assert.equal(doc.getConnectionsCount(), 0); await instance.unloadDocument(doc); } catch (error) { cleanup.push(error); }
        for (const pending of [...instance.unloadingDocuments.values()]) try { await bounded(pending, 'Owned room unload did not settle.'); } catch (error) { cleanup.push(error); }
      }
      if (wss) try { await bounded(new Promise<void>((resolve, reject) => wss!.close(error => error ? reject(error) : resolve())), 'Own WSS close did not settle.'); } catch (error) { cleanup.push(error); }
      try { await bounded(new Promise<void>((resolve, reject) => server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())), 'Own HTTP close did not settle.'); } catch (error) { cleanup.push(error); }
      for (const owner of owners) try { await owner.close(); } catch (error) { cleanup.push(error); }
      for (const client of ownerClients) try { await client.end(); ownerClients.delete(client); } catch (error) { cleanup.push(error); }
      Hocuspocus.prototype.hooks = originalHooks;
      for (const backend of backends) try { assert.equal((await admin.query(`SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE pid=$1 AND extract(epoch FROM backend_start)::text=$2`, [backend.pid, backend.start])).rows[0].count, 0); } catch (error) { cleanup.push(error); }
      if (primary !== undefined && cleanup.length) throw new AggregateError([primary, ...cleanup], 'Registered native Edit and owned room cleanup failed.');
      if (primary !== undefined) throw primary;
      if (cleanup.length) throw new AggregateError(cleanup, 'Registered native Edit owned room cleanup was not confirmed.');
      console.log(JSON.stringify({ closure: 'native-edit-tool-dispatch', ownHttpAndWssClosed: true, dedicatedOwnerBackendsClosed: backends.length,
        fixtureTcpServers: 0, testOwnedTcpServers: 1 }));
    }
  });
  assert.equal(passed, 8); completed = true;
  console.log(JSON.stringify({ suite: 'native-document-edit-tool-dispatch', groups: passed, actualRegisteredModernMcp: true,
    actualPiRegistryWrapper: true, actualLocalPgRoomOwner: true, compiledOrOAuthIssuanceE2e: false, osSandboxAcceptance: false }));
}
nativeDocumentEditToolDispatchPostgresTest().catch(error => {
  console.error(JSON.stringify({ suite: 'native-document-edit-tool-dispatch', currentCase, passed,
    name: error instanceof Error ? error.name : 'UnknownError', code: ownCode(error) ?? null }));
  console.error(error); process.exitCode = 1;
});

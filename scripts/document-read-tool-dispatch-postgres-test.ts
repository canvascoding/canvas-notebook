import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { DocumentReadPageV1 } from '../app/lib/documents/contracts';
import { withDocumentReadToolDispatchFixture, type DispatchDocument } from './helpers/document-read-tool-dispatch-fixture';

// Actual registered Web Request/Response MCP protocol transport, real signed
// Bearer/current SQL authority, and actual getPiTools -> runtime wrapper ->
// read_document -> public service. No adapter/service/auth/SQL result mocks.
// The stored PI conversation resolves its actual workspace; getPiTools does
// not create a live runtime agentTurnId. This is neither TCP/compiled OAuth
// E2E nor a full live chat-turn acceptance claim. Root alone runs this suite.
let currentCase = 'setup', passed = 0, finished = false;
process.once('beforeExit', () => { if (!finished) process.exitCode = 1; });
type ObjectValue = Record<string, unknown>;
function record(value: unknown): ObjectValue {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as ObjectValue;
}
function text(result: { content: unknown }): string {
  assert(Array.isArray(result.content)); assert.equal(result.content.length, 1);
  const item = record(result.content[0]); assert.equal(item.type, 'text'); assert.equal(typeof item.text, 'string');
  return item.text as string;
}
function noPage(value: unknown): void {
  const entry = record(value);
  for (const key of ['fragment', 'nextCursor', 'complete', 'document', 'currency', 'projection', 'sha256',
    'yjsState', 'stateVector', 'rootPath', 'accessToken']) assert.equal(Object.hasOwn(entry, key), false, key);
}
function summary(error: unknown, depth = 0): unknown {
  if (!error || typeof error !== 'object' || depth > 3) return { name: typeof error };
  const value = error as ObjectValue;
  return { name: typeof value.name === 'string' ? value.name.slice(0, 80) : 'unknown',
    code: typeof value.code === 'string' ? value.code.slice(0, 80) : null,
    ...(typeof value.stack === 'string' ? { frames: value.stack.split('\n').slice(1)
      .map(line => line.trim()).filter(line => line.startsWith('at ')).slice(0, 8) } : {}),
    ...(value.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' && typeof value.message === 'string'
      ? { packageExportMessage: value.message.slice(0, 1024) } : {}),
    ...(error instanceof AggregateError ? { causes: error.errors.slice(0, 8).map(entry => summary(entry, depth + 1)) } : {}) };
}

async function main(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { admin, workspaceId, clientId, agentId, piSessionId } = fixture;
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { DOCUMENT_READ_PAGE_JSON_SCHEMA_V1, DOCUMENT_READ_ERROR_JSON_SCHEMA_V1 } = await import('../app/lib/documents/read-json-schema');
    const { DocumentReadError } = await import('../app/lib/documents/contracts');
    const { WorkspaceRequestPrincipalError } = await import('../app/lib/workspaces/request-principal');
    const { SeatLimitGuardError } = await import('../app/lib/license/seat-limit');
    const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/server/validators/ajv');
    const { getPiTools, piTools } = await import('../app/lib/pi/tool-registry');
    const { captureCurrentAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
    const { getAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const validator = new AjvJsonSchemaValidator();
    const validatePage = validator.getValidator<DocumentReadPageV1>(DOCUMENT_READ_PAGE_JSON_SCHEMA_V1);
    const validatePublicError = validator.getValidator(DOCUMENT_READ_ERROR_JSON_SCHEMA_V1);
    let validateAdvertised: ReturnType<typeof validator.getValidator<unknown>> | undefined;
    const token = await fixture.issue();
    let requestId = 0;
    const rpc = async (method: string, params: ObjectValue, actualToken: string | null = token) => {
      const id = ++requestId;
      const request = new Request('http://localhost/mcp', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25', ...(actualToken === null ? {} : { authorization: `Bearer ${actualToken}` }),
      }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      const response = await handleDirectMcpPost(request);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const body = record(await response.json());
      if (response.status === 200) {
        assert.equal(body.jsonrpc, '2.0'); assert.equal(body.id, id);
      } else {
        // The HTTP verifier rejects invalid/currently revoked tokens before
        // the protocol transport; its public error has no JSON-RPC envelope.
        assert.equal(response.status, 401); assert.equal(body.error, 'invalid_token');
        assert.equal(Object.hasOwn(body, 'result'), false); noPage(body);
      }
      return { response, body };
    };
    const call = async (args: ObjectValue, actualToken: string | null = token) => {
      const outcome = await rpc('tools/call', { name: 'read_knowledge_source', arguments: args }, actualToken);
      assert.equal(outcome.response.status, 200);
      assert.equal(Object.hasOwn(outcome.body, 'error'), false);
      return record(outcome.body.result);
    };
    const mcpArgs = (target: DispatchDocument, extra: ObjectValue = {}): ObjectValue => ({
      workspace_id: workspaceId, document_id: target.documentId, ...extra,
    });
    const piArgs = (target: DispatchDocument, extra: ObjectValue = {}): ObjectValue => ({
      workspaceId, documentId: target.documentId, ...extra,
    });
    const mcpPage = (outcome: ObjectValue): DocumentReadPageV1 => {
      if (outcome.isError === true) {
        const failure = validatePublicError(outcome.structuredContent);
        console.error('Unexpected MCP read outcome:', JSON.stringify(failure.valid
          ? failure.data : { diagnostic: 'No valid public document error envelope.' }));
      }
      assert.notEqual(outcome.isError, true);
      const parsed = record(JSON.parse(text(outcome as { content: unknown })));
      assert.deepEqual(parsed, outcome.structuredContent);
      const validated = validatePage(parsed); assert.equal(validated.valid, true, validated.errorMessage ?? 'The actual page must match the shared schema.');
      assert(validateAdvertised); const advertised = validateAdvertised(parsed); assert.equal(advertised.valid, true, advertised.errorMessage ?? 'The actual page must match the advertised schema.');
      assert.equal(Object.hasOwn(parsed, 'sha256'), false, 'Native pages do not fabricate legacy file SHA authority.');
      return validated.data!;
    };
    const mcpFailure = (outcome: ObjectValue, code: string) => {
      assert.equal(outcome.isError, true);
      assert.deepEqual(outcome.structuredContent, { apiVersion: 1, success: false, code });
      assert.deepEqual(JSON.parse(text(outcome as { content: unknown })), outcome.structuredContent);
      noPage(outcome.structuredContent);
      assert(validateAdvertised); assert.equal(validateAdvertised(outcome.structuredContent).valid, true);
    };
    const challenge = (outcome: ObjectValue, code: 'invalid_token' | 'insufficient_scope') => {
      assert.equal(outcome.isError, true); assert.equal(Object.hasOwn(outcome, 'structuredContent'), false);
      const challenges = record(outcome._meta)['mcp/www_authenticate']; assert(Array.isArray(challenges));
      assert.equal(challenges.length, 1); assert.equal(typeof challenges[0], 'string');
      assert.match(challenges[0], /^Bearer /u); assert(challenges[0].includes(`error="${code}"`));
      if (code === 'insufficient_scope') assert(challenges[0].includes('knowledge:read'));
      noPage(outcome);
    };
    const invoke = (tool: AgentTool, params: ObjectValue, signal?: AbortSignal) =>
      tool.execute(`dispatch-${crypto.randomUUID()}`, params, signal);
    const piPage = (result: AgentToolResult<unknown>): DocumentReadPageV1 => {
      assert.notEqual(Reflect.get(result, 'isError'), true);
      const parsed = record(JSON.parse(text(result)));
      const validated = validatePage(parsed); assert.equal(validated.valid, true, validated.errorMessage ?? 'The actual page must match the shared schema.');
      const details = record(result.details), { toolOutput, ...canonical } = details;
      assert.deepEqual(canonical, parsed);
      const output = record(toolOutput); assert.equal(output.storedBytes, 0); assert.deepEqual(output.references, []);
      assert.equal(Object.hasOwn(output, 'storageError'), false);
      assert.equal(Object.hasOwn(details, 'toolOutputView'), false);
      assert.equal(text(result).includes('Text excerpt (not complete JSON):'), false);
      return validated.data!;
    };
    const piFailure = (result: AgentToolResult<unknown>, code: string, wrapped = true) => {
      assert.equal(Reflect.get(result, 'isError'), true);
      const value = record(JSON.parse(text(result)));
      assert.equal(value.apiVersion, 1); assert.equal(value.success, false); assert.equal(value.code, code);
      assert.equal(value.safeToAutoRetry, false); noPage(value);
      const details = record(result.details);
      if (wrapped) { const { toolOutput, ...canonical } = details; assert.deepEqual(canonical, value);
        assert.equal(record(toolOutput).storedBytes, 0); assert.deepEqual(record(toolOutput).references, []); }
      else assert.deepEqual(details, value);
    };
    // Existing wrapper poison retains failed genuine principal/service calls
    // even if an inner adapter formats an error. Do not mistake the pure
    // formatter's result contract for all wrapped failure outcomes.
    const publicRejection = (code: ConstructorParameters<typeof DocumentReadError>[0]) => (error: unknown) => {
      assert(error instanceof DocumentReadError); assert.equal(error.code, code); return true;
    };
    const piNative = async (tool: AgentTool, target: DispatchDocument) => {
      const first = piPage(await invoke(tool, piArgs(target)));
      const fragments = [first.fragment]; let next = first.nextCursor, offset = first.byteLength;
      for (let count = 0; next !== null && count < 32; count++) {
        const page = piPage(await invoke(tool, piArgs(target, { cursor: next, expectedVersion: first.document.version })));
        assert.deepEqual(page.document, first.document); assert.deepEqual(page.currency, first.currency);
        assert.equal(page.byteOffset, offset); assert.equal(page.byteLength, Buffer.byteLength(page.fragment));
        assert(page.byteLength > 0 && page.byteLength <= 1024);
        offset += page.byteLength; fragments.push(page.fragment); next = page.nextCursor;
        assert.equal(page.complete, next === null);
      }
      assert.equal(next, null); assert.equal(offset, first.totalBytes);
      return { page: first, body: record(JSON.parse(fragments.join(''))), serialized: fragments.join('') };
    };
    const unchanged = async (operation: () => Promise<void>) => {
      const before = await fixture.snapshot(); await operation(); assert.deepEqual(await fixture.snapshot(), before,
        'Actual tool dispatch reads leave D/L/S, shared titles, revisions and projections including xmin unchanged.');
    };
    const check = async (name: string, operation: () => Promise<void>) => {
      currentCase = name; await operation(); passed++;
      console.log('Document tool dispatch case passed:', JSON.stringify({ passed, name }));
    };

    await check('actual HTTP initialization and registered tools/list advertise the complete native and legacy output schema', async () => {
      const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {},
        clientInfo: { name: 'owned-dispatch-fixture', version: '1' } });
      assert.equal(initialized.response.status, 200); assert(record(initialized.body.result).serverInfo);
      const listed = await rpc('tools/list', {}); assert.equal(listed.response.status, 200);
      const tools = record(listed.body.result).tools; assert(Array.isArray(tools));
      const read = record(tools.find(entry => record(entry).name === 'read_knowledge_source'));
      const schema = record(read.inputSchema), properties = record(schema.properties);
      assert(Object.hasOwn(properties, 'document_id')); assert(Object.hasOwn(properties, 'path'));
      assert.equal(record(properties.max_bytes).minimum, 4); assert.equal(record(properties.max_bytes).maximum, 262144);
      const output = record(read.outputSchema); assert(Array.isArray(output.oneOf)); assert.equal(output.oneOf.length, 3);
      assert.deepEqual(output.oneOf[1], DOCUMENT_READ_PAGE_JSON_SCHEMA_V1);
      assert.deepEqual(output.oneOf[2], DOCUMENT_READ_ERROR_JSON_SCHEMA_V1);
      validateAdvertised = validator.getValidator(output);
    });
    const plain = await fixture.seed({ filePath: 'native-only.bin' });
    const rich = await fixture.seed({ representation: 'tiptap_xml', text: '# Native heading\n\nActual **rich** body.', filePath: 'rich-only.bin' });
    const blocks = await fixture.seed({ representation: 'tiptap_blocks', nonexportable: true, filePath: 'table-only.bin' });

    await check('registered MCP ID branch reads missing-projection plain/native and XML bodies without legacy SHA or Markdown prerequisite', async () => {
      for (const target of [plain, rich]) await unchanged(async () => {
        await assert.rejects(lstat(path.join(fixture.workspaceRoot, target.filePath)), { code: 'ENOENT' });
        const native = mcpPage(await call(mcpArgs(target, { format: 'native' })));
        assert.equal(native.document.documentId, target.documentId); assert.equal(native.document.lineageId, target.lineageId);
        assert.equal(native.document.path, target.filePath); assert.equal(native.document.title, 'Shared fixture title');
        assert.equal(native.document.representation, target.representation);
        assert.equal(native.currency.source, 'persisted_yjs'); assert.equal(native.currency.observedDurable, true);
        assert.equal(native.currency.durableSequence, 7); assert.equal(native.projection.status, 'pending');
        assert.equal(native.complete, true); assert.equal(native.nextCursor, null);
        const body = record(JSON.parse(native.fragment)); assert.equal(body.bodyVersion, 1); assert.equal(body.representation, target.representation);
        const semantic = mcpPage(await call(mcpArgs(target, { format: 'text' })));
        assert.deepEqual(semantic.document, native.document); assert.deepEqual(semantic.currency, native.currency);
        if (target === plain) assert.equal(semantic.fragment, plain.text); else assert.match(semantic.fragment, /Native heading[\s\S]*Actual rich body/u);
        assert.equal(validatePage({ ...native, document: { ...native.document, version: 'not-a-version' } }).valid, false);
        assert.equal(validateAdvertised!({ ...native, currency: { ...native.currency, observedDurable: 'true' } }).valid, false);
      });
    });
    await check('valid nonexportable blocks preserve native table attributes and text while explicit Markdown returns its public error', async () => unchanged(async () => {
      const native = mcpPage(await call(mcpArgs(blocks))); assert.match(native.fragment, /"colwidth":\[120\]/u);
      assert.match(mcpPage(await call(mcpArgs(blocks, { format: 'text' }))).fragment, /Keep[\s\S]*Target/u);
      mcpFailure(await call(mcpArgs(blocks, { format: 'markdown' })), 'DOCUMENT_FORMAT_UNAVAILABLE');
    }));
    await check('MCP Unicode continuations retain full versions and exact UTF-8 offsets across genuine calls', async () => unchanged(async () => {
      const fragments: string[] = [], offsets: number[] = [];
      let cursor: string | undefined, version: string | undefined, offset = 0;
      for (let count = 0; count < 8; count++) {
        const page = mcpPage(await call(mcpArgs(plain, { format: 'text', max_bytes: 4,
          ...(cursor ? { cursor } : {}), ...(version ? { expected_version: version } : {}) })));
        version ??= page.document.version; assert.equal(page.document.version, version);
        assert.equal(page.byteOffset, offset); assert.equal(page.byteLength, Buffer.byteLength(page.fragment));
        assert(page.byteLength > 0 && page.byteLength <= 4); assert.equal(page.fragment.includes('\ufffd'), false);
        assert.equal(page.totalBytes, 11); offsets.push(page.byteOffset); fragments.push(page.fragment); offset += page.byteLength;
        if (page.complete) { assert.equal(page.nextCursor, null); break; }
        assert.equal(typeof page.nextCursor, 'string'); cursor = page.nextCursor!;
      }
      assert.deepEqual(fragments, ['A', '😀', 'B', '🧪', 'C']); assert.deepEqual(offsets, [0, 1, 5, 6, 10]); assert.equal(offset, 11);
    }));
    const hidden = await fixture.seed({ filePath: '.private/hidden.bin' });
    await check('registered native selector rejects mixed legacy offsets/path, missing and hidden IDs and foreign workspace selectors', async () => unchanged(async () => {
      for (const extra of [{ path: plain.filePath }, { offset: 0 }, { max_characters: 100 }, { apiVersion: 1 }, { max_bytes: 3 }]) {
        const rejected = await rpc('tools/call', { name: 'read_knowledge_source', arguments: mcpArgs(plain, extra) });
        assert.equal(record(rejected.body.error).code, -32602); assert.equal(Object.hasOwn(rejected.body, 'result'), false);
      }
      mcpFailure(await call({ workspace_id: workspaceId, document_id: `absent-${crypto.randomUUID()}` }), 'DOCUMENT_NOT_FOUND');
      mcpFailure(await call(mcpArgs(hidden)), 'ACCESS_DENIED');
      mcpFailure(await call(mcpArgs(plain, { workspace_id: `foreign-${crypto.randomUUID()}` })), 'ACCESS_DENIED');
    }));
    await check('missing Bearer yields a tool challenge and invalid Bearer yields the actual HTTP401 challenge', async () => unchanged(async () => {
      challenge(await call(mcpArgs(plain), null), 'invalid_token');
      const denied = await rpc('tools/call', { name: 'read_knowledge_source', arguments: mcpArgs(plain) }, 'invalid-fixture-token');
      assert.equal(denied.response.status, 401); assert.match(denied.response.headers.get('www-authenticate') ?? '', /^Bearer /u);
      assert.equal(Object.hasOwn(denied.body, 'result'), false); noPage(denied.body);
    }));
    const searchable = await fixture.seed({ text: 'Native search needle', filePath: 'searchable.md' });
    await check('search-only OAuth scope can actually search but cannot call native reads or infer a read grant from the same token', async () => unchanged(async () => {
      const searchToken = await fixture.issue({ scope: 'knowledge:search' });
      const searched = await rpc('tools/call', { name: 'search_knowledge', arguments: { workspace_id: workspaceId, query: 'needle' } }, searchToken);
      assert.equal(searched.response.status, 200); const result = record(searched.body.result); assert.notEqual(result.isError, true);
      const payload = record(result.structuredContent); assert(Array.isArray(payload.results));
      assert(payload.results.some(row => record(row).path === searchable.filePath));
      challenge(await call(mcpArgs(plain), searchToken), 'insufficient_scope');
    }));
    await check('disabled registered tool is omitted from tools/list and rejected as MethodNotFound without invoking the read service', async () => unchanged(async () => {
      const originalTools = process.env.CANVAS_MCP_DIRECT_TOOLS;
      try {
        process.env.CANVAS_MCP_DIRECT_TOOLS = 'search_knowledge';
        const listed = await rpc('tools/list', {}); const tools = record(listed.body.result).tools; assert(Array.isArray(tools));
        assert.equal(tools.some(entry => record(entry).name === 'read_knowledge_source'), false);
        const rejected = await rpc('tools/call', { name: 'read_knowledge_source', arguments: mcpArgs(plain) });
        assert.equal(record(rejected.body.error).code, -32601); assert.equal(Object.hasOwn(rejected.body, 'result'), false);
      } finally { process.env.CANVAS_MCP_DIRECT_TOOLS = originalTools; }
    }));
    await check('fresh MCP grant revocation blocks a previously working ID and cursor without changing document SQL', async () => unchanged(async () => {
      const first = mcpPage(await call(mcpArgs(plain, { format: 'text', max_bytes: 4 }))); assert(first.nextCursor);
      await admin.query('DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1 AND workspace_id=$2', [clientId, workspaceId]);
      try { mcpFailure(await call(mcpArgs(plain, { format: 'text', max_bytes: 4, cursor: first.nextCursor })), 'ACCESS_DENIED'); }
      finally { await admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
        VALUES($1,'reader',$2,100,100)`, [clientId, workspaceId]); }
      assert.equal(mcpPage(await call(mcpArgs(plain))).document.documentId, plain.documentId);
    }));

    let registered: AgentTool | undefined;
    await check('actual getPiTools resolves the stored conversation and returns the registered wrapper; unwrapped core is denied', async () => unchanged(async () => {
      assert.equal(getAgentExecutionContext(), null);
      assert.throws(captureCurrentAgentToolInvocation, { code: 'AGENT_TOOL_INVOCATION_REQUIRED' });
      const tools = await getPiTools('reader', agentId, piSessionId, { strictAuthorization: true, metadataOnlyExternal: true });
      registered = tools.find(tool => tool.name === 'read_document'); assert(registered);
      const core = piTools.find(tool => tool.name === 'read_document'); assert(core); assert.notEqual(registered, core);
      piFailure(await invoke(core, piArgs(plain)), 'AUTHENTICATION_REQUIRED', false);
      const page = piPage(await invoke(registered, piArgs(plain))); assert.equal(page.document.documentId, plain.documentId);
      await fixture.setPiEnabledTools(['read']);
      try {
        assert.equal((await admin.query('SELECT enabled_tools_json FROM agents WHERE agent_id=$1', [agentId])).rows[0].enabled_tools_json, '["read"]');
        const legacyOnly = await getPiTools('reader', agentId, piSessionId, { strictAuthorization: true, metadataOnlyExternal: true });
        assert.equal(legacyOnly.some(tool => tool.name === 'read_document'), false);
        assert.equal(legacyOnly.some(tool => tool.name === 'read'), true);
      } finally { await fixture.setPiEnabledTools(['read_document']); }
      assert.equal(getAgentExecutionContext(), null);
      assert.throws(captureCurrentAgentToolInvocation, { code: 'AGENT_TOOL_INVOCATION_REQUIRED' });
    }));
    // Mechanical stored-header size fixture, not an ordinary title-writer
    // acceptance claim. Both path/title satisfy the kernel's actual bounds.
    const budgetPath = `${Array.from({ length: 17 }, () => 'p'.repeat(226)).join('/')}/budget.bin`;
    assert(budgetPath.length < 4096 && budgetPath.split('/').every(segment => segment.length < 255));
    const budget = await fixture.seed({ filePath: budgetPath, text: 'ok' });
    await admin.query('UPDATE workspace_file_metadata SET title=$3 WHERE workspace_id=$1 AND path=$2',
      [workspaceId, budget.filePath, '"'.repeat(4096)]);
    await check('actual PI wrapper preserves complete plain/XML/blocks pages and native-only paths, including nonexportable rich text', async () => unchanged(async () => {
      assert(registered);
      for (const target of [plain, rich, blocks]) {
        const collected = await piNative(registered, target), native = collected.page;
        assert.equal(native.document.documentId, target.documentId); assert.equal(native.document.representation, target.representation);
        assert.equal(native.document.path, target.filePath);
        assert.equal(collected.body.representation, target.representation);
        const semantic = piPage(await invoke(registered, piArgs(target, { format: 'text' })));
        assert.deepEqual(native.document, semantic.document); assert.equal(native.currency.observedDurable, true);
        if (target === blocks) assert.match(collected.serialized, /"colwidth":\[120\]/u);
      }
      await assert.rejects(invoke(registered, piArgs(blocks, { format: 'markdown' })), publicRejection('DOCUMENT_FORMAT_UNAVAILABLE'));
      const fullEnvelope = mcpPage(await call(mcpArgs(budget, { max_bytes: 4 })));
      assert.equal(fullEnvelope.document.path, budgetPath); assert.equal(fullEnvelope.document.title, '"'.repeat(4096));
      assert(JSON.stringify(fullEnvelope).length > 12000, 'A real successful native read precedes the formatter budget failure.');
      piFailure(await invoke(registered, piArgs(budget, { maxBytes: 4 })), 'DOCUMENT_READ_OUTPUT_BUDGET_EXCEEDED');
    }));
    await check('PI Unicode continuations preserve offsets while selector errors and version conflicts never fabricate a continuation', async () => unchanged(async () => {
      assert(registered); const fragments: string[] = []; let cursor: string | undefined, version: string | undefined, offset = 0;
      for (let count = 0; count < 8; count++) {
        const page = piPage(await invoke(registered, piArgs(plain, { format: 'text', maxBytes: 4,
          ...(cursor ? { cursor } : {}), ...(version ? { expectedVersion: version } : {}) })));
        version ??= page.document.version; assert.equal(page.document.version, version); assert.equal(page.byteOffset, offset);
        assert.equal(Buffer.byteLength(page.fragment), page.byteLength); assert.equal(page.fragment.includes('\ufffd'), false);
        fragments.push(page.fragment); offset += page.byteLength;
        if (page.complete) { assert.equal(page.nextCursor, null); break; }
        assert(page.nextCursor); cursor = page.nextCursor;
      }
      assert.deepEqual(fragments, ['A', '😀', 'B', '🧪', 'C']); assert.equal(offset, 11);
      for (const extra of [{ path: plain.filePath }, { maxBytes: 1025 }, { apiVersion: 1 }]) {
        piFailure(await invoke(registered, piArgs(plain, extra)), 'INVALID_REQUEST');
      }
      const wrong = `canvas-document-v1:${'0'.repeat(64)}`;
      await assert.rejects(invoke(registered, piArgs(plain, { expectedVersion: wrong })), publicRejection('DOCUMENT_VERSION_CONFLICT'));
      mcpFailure(await call(mcpArgs(plain, { expected_version: wrong })), 'DOCUMENT_VERSION_CONFLICT');
    }));
    await check('a retained PI wrapper rechecks the real persisted session instead of retaining its old invocation authority', async () => unchanged(async () => {
      assert(registered); assert.equal(piPage(await invoke(registered, piArgs(plain))).document.documentId, plain.documentId);
      await admin.query('UPDATE pi_sessions SET archived_at=200 WHERE session_id=$1 AND user_id=$2', [piSessionId, 'reader']);
      try { await assert.rejects(invoke(registered, piArgs(plain)), error => {
        assert(error instanceof WorkspaceRequestPrincipalError); assert.equal(error.code, 'PRINCIPAL_AUTH_REVOKED'); return true;
      }); }
      finally { await admin.query('UPDATE pi_sessions SET archived_at=NULL WHERE session_id=$1 AND user_id=$2', [piSessionId, 'reader']); }
    }));
    await check('current member ACL revocation denies registered PI and MCP calls while document bytes and neighbors remain untouched', async () => unchanged(async () => {
      assert(registered);
      await admin.query("UPDATE organization_user_permissions SET status='disabled' WHERE user_id='reader' AND organization_id='tool-dispatch-org'");
      try {
        await assert.rejects(invoke(registered, piArgs(plain)), error => {
          assert(error instanceof SeatLimitGuardError); assert.equal(error.code, 'SEAT_MEMBERSHIP_REQUIRED'); return true;
        });
        const denied = await rpc('tools/call', { name: 'read_knowledge_source', arguments: mcpArgs(plain) });
        // The actual HTTP verifier maps a current failed seat check to
        // invalid_token before the protocol handler receives an AuthInfo.
        assert.equal(denied.response.status, 401); assert.equal(Object.hasOwn(denied.body, 'result'), false);
        assert.match(denied.response.headers.get('www-authenticate') ?? '', /error="invalid_token"/u);
      } finally {
        await admin.query("UPDATE organization_user_permissions SET status='active' WHERE user_id='reader' AND organization_id='tool-dispatch-org'");
        await fixture.restoreReaderSession();
      }
    }));
    await check('legacy path read still returns its advertised legacy branch and preserves actual file bytes', async () => {
      const relative = 'legacy/ordinary.txt', file = path.join(fixture.workspaceRoot, relative);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, 'Legacy ordinary asset read', { mode: 0o600, flag: 'wx' });
      const target = await fixture.seed({ filePath: relative, text: 'Legacy ordinary asset read' });
      const before = record(await fixture.snapshot()), originalBytes = await readFile(file), identity = await lstat(file);
      const outcome = await call({ workspace_id: workspaceId, path: relative, offset: 0, max_characters: 100 });
      assert.notEqual(outcome.isError, true); const payload = record(outcome.structuredContent);
      assert.equal(payload.path, relative); assert.equal(payload.content, originalBytes.toString('utf8'));
      assert.equal(payload.sha256, crypto.createHash('sha256').update(originalBytes).digest('hex'));
      const checked = validateAdvertised!(payload); assert.equal(checked.valid, true, checked.errorMessage ?? 'The legacy output must match the advertised schema.');
      assert.equal(validatePage(payload).valid, false);
      assert.deepEqual(await readFile(file), originalBytes);
      const retained = await lstat(file); assert.equal(retained.dev, identity.dev); assert.equal(retained.ino, identity.ino);
      const after = record(await fixture.snapshot());
      // The preserved legacy ensureDocument path unconditionally upserts its
      // own lineage and touches its own document.updated_at. Account for only
      // these exact old bookkeeping effects; native state, IDs, revisions,
      // projections and every neighboring row (including xmin) stay identical.
      for (const [table, id, allowed] of [
        ['documents', target.documentId, ['updated_at', 'original_xmin']],
        ['lineages', target.lineageId, ['original_xmin']],
      ] as const) {
        const priorRows = before[table], actualRows = after[table];
        assert(Array.isArray(priorRows) && Array.isArray(actualRows));
        const original = record(priorRows.find(row => record(row).id === id));
        const actual = record(actualRows.find(row => record(row).id === id));
        if (table === 'documents') assert(Number(actual.updated_at) >= Number(original.updated_at));
        after[table] = actualRows.map(row => record(row).id === id
          ? { ...record(row), ...Object.fromEntries(allowed.map(key => [key, original[key]])) } : row);
      }
      assert.deepEqual(after, before, 'Legacy read preserves exact native content and identity, allowing only its existing bookkeeping touches.');
    });
    assert.equal(passed, 15);
  });
  finished = true;
  console.log(JSON.stringify({ suite: 'document-read-tool-dispatch-postgres', groups: passed, passed: true,
    actualRegisteredWebMcpTransport: true, actualPiRegistryWrapper: true, tcpOrCompiledOAuthE2e: false }));
}
main().catch(error => {
  console.error('Document tool dispatch fixture failed:', JSON.stringify({ currentCase, passed, error: summary(error) }));
  process.exitCode = 1;
});

import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { DocumentSearchPageV1 } from '../app/lib/documents/search-contract';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Real signed Web MCP transport and getPiTools -> actual invocation wrapper.
// Not TCP/compiled OAuth, a live chat turn, or an entire model-context budget.
let currentCase = 'setup', groups = 0, finished = false;
process.once('beforeExit', () => { if (!finished) process.exitCode = 1; });
type Row = Record<string, unknown>;
function record(value: unknown): Row { assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Row; }
function text(result: { content: unknown }): string {
  assert(Array.isArray(result.content)); assert.equal(result.content.length, 1);
  const part = record(result.content[0]); assert.equal(part.type, 'text'); assert(typeof part.text === 'string'); return part.text;
}
function noPage(value: unknown): void {
  const object = record(value);
  for (const key of ['hits', 'nextCursor', 'coverage', 'document', 'fragment', 'rootPath', 'accessToken', 'stateVector']) {
    assert.equal(Object.hasOwn(object, key), false, key);
  }
}

export async function documentSearchToolDispatchPostgresTest(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { workspaceId, admin, agentId, piSessionId } = fixture;
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { getPiTools, piTools } = await import('../app/lib/pi/tool-registry');
    const { filterToolsForPlanningMode } = await import('../app/lib/pi/planning-mode');
    const { resolveDelegatedWorkerToolNames } = await import('../app/lib/pi/toolsets');
    const { DocumentSearchError } = await import('../app/lib/documents/search-contract');
    const { PublicShareToolPolicyError } = await import('../app/lib/public-sharing/tool-policy');
    const { DOCUMENT_SEARCH_PAGE_JSON_SCHEMA_V1, DOCUMENT_SEARCH_ERROR_JSON_SCHEMA_V1 } = await import('../app/lib/documents/search-json-schema');
    const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/server/validators/ajv');
    const validator = new AjvJsonSchemaValidator();
    const validatePage = validator.getValidator<DocumentSearchPageV1>(DOCUMENT_SEARCH_PAGE_JSON_SCHEMA_V1);
    const validateError = validator.getValidator(DOCUMENT_SEARCH_ERROR_JSON_SCHEMA_V1);
    let advertised: ReturnType<typeof validator.getValidator<unknown>> | undefined;
    const token = await fixture.issue(); let requestId = 0;
    const rpc = async (method: string, params: Row, actualToken = token) => {
      const id = ++requestId;
      const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25', authorization: `Bearer ${actualToken}`,
      }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }));
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = record(await response.json()); assert.equal(body.id, id); return body;
    };
    const call = async (name: string, args: Row, actualToken = token): Promise<Row> => {
      const body = await rpc('tools/call', { name, arguments: args }, actualToken);
      assert.equal(Object.hasOwn(body, 'error'), false); return record(body.result);
    };
    const searchArgs = (extra: Row = {}): Row => ({ api_version: 1, workspace_id: workspaceId, query: 'Target', ...extra });
    const mcpPage = (outcome: Row): DocumentSearchPageV1 => {
      assert.notEqual(outcome.isError, true); const parsed = JSON.parse(text(outcome as { content: unknown }));
      assert.deepEqual(parsed, outcome.structuredContent); const result = validatePage(parsed);
      assert.equal(result.valid, true, result.errorMessage ?? 'Invalid document search page'); assert(advertised); assert.equal(advertised(parsed).valid, true);
      assert(Buffer.byteLength(JSON.stringify(parsed), 'utf8') <= 12_000); return result.data!;
    };
    const piPage = (result: AgentToolResult<unknown>): DocumentSearchPageV1 => {
      assert.notEqual(Reflect.get(result, 'isError'), true); const actualText = text(result), parsed = JSON.parse(actualText);
      const valid = validatePage(parsed); assert.equal(valid.valid, true, valid.errorMessage ?? 'Invalid document search page');
      const details = record(result.details), { toolOutput, ...canonical } = details;
      assert.deepEqual(canonical, parsed); assert(actualText.length <= 12_000);
      assert(Buffer.byteLength(actualText, 'utf8') <= 12_000); assert(JSON.stringify(canonical).length <= 12_000);
      const output = record(toolOutput); assert.equal(output.storedBytes, 0); assert.deepEqual(output.references, []);
      assert.equal(Object.hasOwn(output, 'storageError'), false); assert.equal(Object.hasOwn(details, 'toolOutputView'), false);
      assert.equal(actualText.includes('Text excerpt (not complete JSON):'), false); return valid.data!;
    };
    const invoke = (tool: AgentTool, extra: Row = {}) => tool.execute(`search-dispatch-${randomUUID()}`,
      { workspaceId, query: 'Target', ...extra });
    const registry = () => getPiTools('reader', agentId, piSessionId, { strictAuthorization: true, metadataOnlyExternal: true });
    const unchanged = async (operation: () => Promise<void>) => {
      const before = await fixture.snapshot(); await operation(); assert.deepEqual(await fixture.snapshot(), before);
    };
    const check = async (name: string, operation: () => Promise<void>) => {
      currentCase = name; await operation(); console.log(`PASS document-search-dispatch ${++groups}: ${name}`);
    };

    await check('actual MCP tools/list advertises strict V1 and exact native/legacy output contracts', async () => {
      await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'owned-search-dispatch', version: '1' } });
      const listed = await rpc('tools/list', {}), tools = record(listed.result).tools; assert(Array.isArray(tools));
      const tool = record(tools.find(value => record(value).name === 'search_knowledge'));
      const input = record(tool.inputSchema); assert.equal(input.additionalProperties, false); assert.equal(input.oneOf, undefined);
      assert.equal(record(record(input.properties).api_version).const, 1);
      const output = record(tool.outputSchema); assert(Array.isArray(output.oneOf)); assert.equal(output.oneOf.length, 3);
      assert.deepEqual(output.oneOf[1], DOCUMENT_SEARCH_PAGE_JSON_SCHEMA_V1);
      assert.deepEqual(output.oneOf[2], DOCUMENT_SEARCH_ERROR_JSON_SCHEMA_V1); advertised = validator.getValidator(output);
    });
    const documents = [await fixture.seed({ filePath: 'plain.bin', text: 'Actual Target plain 😀 content.' }),
      await fixture.seed({ representation: 'tiptap_xml', filePath: 'xml.bin', text: '# Actual Target\n\nRich **Target** body.' }),
      await fixture.seed({ representation: 'tiptap_blocks', filePath: 'blocks.bin', nonexportable: true })];

    await check('registered native MCP search pages reach all real plain/XML/blocks IDs and full-version ID reads without projections', async () => unchanged(async () => {
      const seen = new Map<string, string>(); let cursor: string | undefined, complete = false;
      for (let count = 0; count < 8; count++) {
        const page = mcpPage(await call('search_knowledge', searchArgs({ max_results: count ? 25 : 1, ...(cursor ? { cursor } : {}) })));
        assert.equal(page.coverage.corpus, 'visible_initialized_native_yjs'); assert.equal(page.coverage.remoteLive, 'unknown');
        assert.equal(page.coverage.globalCurrentContent, 'not_certified'); assert.equal(page.coverage.ranking, 'within_scan_window');
        for (const hit of page.hits) {
          assert.equal(seen.has(hit.document.documentId), false); seen.set(hit.document.documentId, hit.document.version);
          assert(hit.matchedIn.includes('content')); assert(Buffer.byteLength(hit.snippet, 'utf8') <= 512);
          const target = documents.find(value => value.documentId === hit.document.documentId); assert(target);
          assert.equal(hit.document.lineageId, target.lineageId); assert.equal(hit.document.representation, target.representation);
          await assert.rejects(lstat(path.join(fixture.workspaceRoot, target.filePath)), { code: 'ENOENT' });
          const read = await call('read_knowledge_source', { workspace_id: workspaceId, document_id: hit.document.documentId,
            expected_version: hit.document.version, format: 'text', max_bytes: 65536 });
          assert.notEqual(read.isError, true); const body = record(read.structuredContent);
          assert.equal(record(body.document).version, hit.document.version); assert.equal(body.complete, true);
          assert.equal(body.nextCursor, null); assert.match(String(body.fragment), /Target/u);
        }
        if (page.nextCursor === null) { complete = true; break; } cursor = page.nextCursor;
      }
      assert.equal(complete, true, 'All reachable native hits must end with nextCursor:null, not an endless empty continuation.');
      assert.deepEqual([...seen.keys()].sort(), documents.map(value => value.documentId).sort());
      assert.equal(mcpPage(await call('search_knowledge', searchArgs({ query: '.*' }))).hits.length, 0);
    }));

    await check('real search-only OAuth scope cannot read and invalid V1 never falls back to retained physical legacy search', async () => {
      const searchToken = await fixture.issue({ scope: 'knowledge:search' });
      assert(mcpPage(await call('search_knowledge', searchArgs(), searchToken)).hits.length > 0);
      const denied = await call('read_knowledge_source', { workspace_id: workspaceId, document_id: documents[0].documentId }, searchToken);
      assert.equal(denied.isError, true); assert.equal(Object.hasOwn(denied, 'structuredContent'), false);
      const challenges = record(denied._meta)['mcp/www_authenticate']; assert(Array.isArray(challenges));
      assert.match(String(challenges[0]), /insufficient_scope/u); assert.match(String(challenges[0]), /knowledge:read/u);
      await writeFile(path.join(fixture.workspaceRoot, 'legacy.csv'), 'Target,physical\n');
      const legacy = await call('search_knowledge', { workspace_id: workspaceId, query: 'Target' });
      assert.notEqual(legacy.isError, true); assert(advertised); assert.equal(advertised(legacy.structuredContent).valid, true);
      const legacyBody = record(legacy.structuredContent); assert(Array.isArray(legacyBody.results));
      assert(legacyBody.results.some(value => record(value).path === 'legacy.csv'));
      for (const extra of [{ api_version: 2 }, { api_version: 1, unknown: true }, { cursor: 'bad' }]) {
        const invalid = await rpc('tools/call', { name: 'search_knowledge', arguments: { workspace_id: workspaceId, query: 'Target', ...extra } });
        assert.equal(record(invalid.error).code, -32602); assert.equal(Object.hasOwn(invalid, 'result'), false);
      }
    });

    let registered: AgentTool | undefined;
    await check('PI default/fixed/none offering, file-worker classification and planning use the actual search_documents name', async () => {
      await fixture.setPiEnabledTools([]);
      const defaults = await registry(); registered = defaults.find(tool => tool.name === 'search_documents'); assert(registered);
      const core = piTools.find(tool => tool.name === 'search_documents'); assert(core); assert.notEqual(registered, core);
      assert(filterToolsForPlanningMode(defaults).some(tool => tool.name === 'search_documents'));
      assert(resolveDelegatedWorkerToolNames(['file'], ['search_documents']).has('search_documents'));
      assert.equal(resolveDelegatedWorkerToolNames(['web'], ['search_documents']).has('search_documents'), false);
      const unwrapped = await invoke(core); assert.equal(Reflect.get(unwrapped, 'isError'), true);
      const failure = record(JSON.parse(text(unwrapped))); assert.equal(failure.code, 'AUTHENTICATION_REQUIRED'); noPage(failure);
      await fixture.setPiEnabledTools(['read_document']); assert.equal((await registry()).some(tool => tool.name === 'search_documents'), false);
      await fixture.setPiEnabledTools(['__none__']); assert.equal((await registry()).some(tool => tool.name === 'search_documents'), false);
      await fixture.setPiEnabledTools(['search_documents', 'read_document']);
      registered = (await registry()).find(tool => tool.name === 'search_documents'); assert(registered);
      await unchanged(async () => {
        const page = piPage(await invoke(registered!)); assert.equal(page.hits.length, 3);
        for (const hit of page.hits) assert(documents.some(value => value.documentId === hit.document.documentId));
      });
    });

    await check('a genuinely offered retained PI wrapper rejects tool disablement before its fresh principal capture', async () => {
      assert(registered); await fixture.setPiEnabledTools(['read_document']);
      try { await unchanged(async () => assert.rejects(invoke(registered!), error => {
        assert(error instanceof PublicShareToolPolicyError); assert.equal(error.code, 'TOOL_POLICY_DENIED'); assert.equal(error.status, 403); return true;
      })); } finally { await fixture.setPiEnabledTools(['search_documents', 'read_document']); }
    });

    await check('actual PI runtime output preserves large complete text/details and returns no page when even one full hit exceeds the shared cap', async () => {
      assert(registered); const budget = await fixture.seed({ filePath: 'budget.bin', text: 'BudgetNeedle' });
      await admin.query('UPDATE workspace_file_metadata SET title=$3 WHERE workspace_id=$1 AND path=$2', [workspaceId, budget.filePath, '"'.repeat(4090)]);
      await unchanged(async () => {
        const result = await invoke(registered!, { query: 'BudgetNeedle' }); const page = piPage(result);
        assert.equal(page.hits.length, 1); assert.equal(page.hits[0].document.documentId, budget.documentId);
        assert(Buffer.byteLength(text(result), 'utf8') > 9000, 'The actual runtime wrapper must preserve the large full JSON page, not just a small formatter example.');
      });
      await admin.query('UPDATE workspace_file_metadata SET title=$3 WHERE workspace_id=$1 AND path=$2', [workspaceId, budget.filePath, '漢'.repeat(4096)]);
      await unchanged(async () => {
        const failed = await call('search_knowledge', searchArgs({ query: 'BudgetNeedle' })); assert.equal(failed.isError, true);
        assert.deepEqual(failed.structuredContent, { apiVersion: 1, success: false, code: 'SEARCH_OUTPUT_TOO_LARGE' });
        assert.equal(validateError(failed.structuredContent).valid, true); assert(advertised); assert.equal(advertised(failed.structuredContent).valid, true);
        noPage(failed.structuredContent);
        await assert.rejects(invoke(registered!, { query: 'BudgetNeedle' }), error => {
          assert(error instanceof DocumentSearchError); assert.equal(error.code, 'SEARCH_OUTPUT_TOO_LARGE'); return true;
        });
      });
    });
  });
  assert.equal(groups, 6); finished = true;
  console.log(JSON.stringify({ suite: 'document-search-tool-dispatch-postgres', groups, passed: true,
    actualRegisteredWebMcpTransport: true, actualPiRegistryWrapper: true, tcpOrCompiledOAuthE2e: false, wholeModelContextBudget: false }));
}
void documentSearchToolDispatchPostgresTest().catch(error => {
  console.error('Document search dispatcher failed:', { currentCase, groups,
    name: error instanceof Error ? error.name : 'NonError',
    code: error && typeof error === 'object' && 'code' in error ? error.code : null });
  process.exitCode = 1;
});

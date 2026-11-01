import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import * as sdk from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const requireDependency = createRequire(import.meta.url);
function load(file: string, dependencies: Record<string, unknown>) {
  const source = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: path.resolve(file), compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const evaluated = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', source)((name: string) =>
    Object.hasOwn(dependencies, name) ? dependencies[name] : requireDependency(name), evaluated, evaluated.exports);
  return evaluated.exports;
}

test('actual MCP SDK transports structured unexpected failures without exception contents', async () => {
  const correlationId = '557d9324-f04a-41ed-9609-4b5ce61db098';
  const failure = load('app/lib/mcp/server/tool-failure.ts', { 'server-only': {},
    './diagnostics': { directMcpCorrelationId: () => correlationId } }) as unknown as typeof import('../app/lib/mcp/server/tool-failure');
  let thrown: unknown = Object.assign(new Error('private-token-and-document-content'), { collaborationPhase: 'receipt_finalize' });
  let failed = 0;
  const directServer = load('app/lib/mcp/server/direct-server.ts', {
    'server-only': {}, '@modelcontextprotocol/server': sdk,
    '@/app/lib/mcp/server/auth-probe': { DIRECT_MCP_AUTH_PROBE_TOOL: 'auth_probe' },
    '@/app/lib/mcp/server/config': { DIRECT_MCP_TOOL_IDS: ['create_knowledge_source'] },
    '@/app/lib/mcp/server/diagnostics': { recordDirectMcpRequestOperation() {}, recordDirectMcpToolFailure() { failed++; },
      async recordDirectMcpSuccessfulOperation() {} },
    '@/app/lib/mcp/server/workspace-tools': { getDirectMcpWorkspaceToolDefinitions: () => [] },
    '@/app/lib/mcp/server/version': { DIRECT_MCP_SERVER_VERSION: 'test' },
    './ingest-tools': { getDirectMcpIngestToolDefinitions: () => [{ id: 'create_knowledge_source',
      descriptor: { name: 'create_knowledge_source', inputSchema: { type: 'object', properties: {} } },
      execute: async () => { throw thrown; } }] },
    './excalidraw-tools': { getDirectMcpExcalidrawToolDefinitions: () => [] }, './tool-failure': failure,
  }) as unknown as typeof import('../app/lib/mcp/server/direct-server');
  const server = directServer.createDirectMcpServer(['create_knowledge_source']);
  const client = new Client({ name: 'failure-contract-test', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const warnings: unknown[][] = [], originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const result = await client.callTool({ name: 'create_knowledge_source', arguments: {} });
    assert.equal(result.isError, true);
    const body = result.structuredContent!;
    assert.equal(body.code, 'MCP_TOOL_FAILED'); assert.equal(body.storage_status, 'unknown');
    assert.equal(body.correlation_id, correlationId); assert.equal(body.phase, 'receipt_finalize');
    assert.equal(body.retryable, false); assert.equal(failed, 1);
    assert(!JSON.stringify([result, warnings]).includes('private-token-and-document-content'));
    assert(JSON.stringify(warnings).includes(correlationId));
    thrown = new sdk.ProtocolError(sdk.ProtocolErrorCode.InternalError, 'private-token-and-document-content');
    const internal = await client.callTool({ name: 'create_knowledge_source', arguments: {} });
    assert.equal(internal.isError, true); assert.equal(internal.structuredContent?.code, 'MCP_TOOL_FAILED');
    assert(!JSON.stringify([internal, warnings]).includes('private-token-and-document-content'));
    thrown = new sdk.ProtocolError(sdk.ProtocolErrorCode.InvalidParams, 'Valid parameter validation');
    await assert.rejects(client.callTool({ name: 'create_knowledge_source', arguments: {} }),
      (error: unknown) => error instanceof Error && Reflect.get(error, 'code') === sdk.ProtocolErrorCode.InvalidParams);
    let getters = 0;
    const hostile = Object.defineProperty({}, 'collaborationPhase', { get() { getters++; throw new Error('must not run'); } });
    assert.equal(failure.directMcpFailurePhase(hostile, 'create'), 'create'); assert.equal(getters, 0);
    assert.equal(failure.directMcpFailurePhase(new Proxy({}, { ownKeys() { throw new Error('must not run'); } }), 'dispatch'), 'dispatch');
  } finally { console.warn = originalWarn; await client.close(); await server.close(); }
});

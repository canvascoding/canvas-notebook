import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { DocumentReadPageV1 } from '../app/lib/documents/contracts';
import { measureDocumentDatabaseActivity, withDocumentOperationMetricObserver,
  type DocumentDatabaseActivityMeasurement, type DocumentOperationMeasurement } from '../app/lib/observability/document-operation-metrics';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';
import { documentBaselineSize, fillDocumentBaselineFixture } from './helpers/document-baseline-fixture';

assert.equal(process.env.NODE_ENV, 'test');
const adapter = process.env.CANVAS_DOCUMENT_BASELINE_ADAPTER;
assert(adapter === 'http' || adapter === 'agent' || adapter === 'mcp');
const agentKind = process.env.CANVAS_DOCUMENT_BASELINE_AGENT_KIND ?? 'main';
assert(agentKind === 'main' || agentKind === 'organization-member');
assert(adapter === 'agent' || agentKind === 'main');
const size = documentBaselineSize(process.env.CANVAS_DOCUMENT_BASELINE_DOCUMENTS, 10);
const output = process.env.CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT;
assert(output && path.isAbsolute(output));
const profiles: Array<{ label: string; measurement: DocumentDatabaseActivityMeasurement }> = [];
const operations: DocumentOperationMeasurement[] = [];
let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

await withDocumentOperationMetricObserver(value => operations.push(value), () => withDocumentReadToolDispatchFixture(async h => {
  const expected = '# Matrix document\n\n[Sibling](source.md)\n\nKept body 😀.\n';
  const target = await h.seed({ filePath: 'matrix/target.md', text: expected, representation: 'tiptap_blocks' });
  await fillDocumentBaselineFixture({ target: size,
    count: async () => Number((await h.admin.query("SELECT count(*)::integer AS n FROM collaboration_documents WHERE workspace_id=$1 AND status='active'",
      [h.workspaceId])).rows[0].n),
    seed: index => h.seed({ filePath: `matrix/extra-${index}.md`, representation: 'tiptap_blocks',
      text: `# Matrix source ${index}\n\n[Target](target.md)\n` }),
  });
  const before = await h.snapshot();
  const profile = async <T>(label: string, execute: () => Promise<T>): Promise<T> =>
    measureDocumentDatabaseActivity('read', adapter === 'http' ? 'request' : adapter, execute,
      measurement => profiles.push({ label, measurement }));
  const validate = (value: unknown): DocumentReadPageV1 => {
    const page = object(value) as unknown as DocumentReadPageV1;
    assert.equal(page.apiVersion, 1); assert.equal(page.complete, true); assert.equal(page.format, 'markdown');
    assert.equal(page.fragment, expected); assert.equal(page.nextCursor, null); assert.equal(page.byteOffset, 0);
    assert.equal(page.byteLength, Buffer.byteLength(expected)); assert.equal(page.totalBytes, page.byteLength);
    assert.equal(page.document.documentId, target.documentId); assert.equal(page.document.lineageId, target.lineageId);
    assert.equal(page.document.path, target.filePath); assert.equal(page.document.workspaceId, h.workspaceId);
    return page;
  };
  let cookie: string | undefined, token: string | undefined, registered: AgentTool | undefined;
  if (adapter === 'http') {
    const session = (await h.admin.query('SELECT token FROM session WHERE id=$1', ['reader-session'])).rows[0]; assert(session);
    cookie = (await serializeSignedCookie('better-auth.session_token', session.token, process.env.BETTER_AUTH_SECRET!)).split(';')[0];
  } else if (adapter === 'mcp') token = await h.issue();
  let rpcId = 0;
  const rpc = async (method: string, params: object) => {
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const id = ++rpcId;
    const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25', authorization: `Bearer ${token!}`,
    }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }));
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const envelope = object(await response.json()); assert.equal(envelope.id, id); assert.equal(envelope.jsonrpc, '2.0');
    assert.equal(Object.hasOwn(envelope, 'error'), false); return object(envelope.result);
  };
  const read = async (first: boolean): Promise<DocumentReadPageV1> => {
    if (adapter === 'http') {
      const { POST } = await import('../app/api/documents/read/route');
      const response = await POST(new NextRequest('http://localhost/api/documents/read', { method: 'POST', headers: {
        cookie: cookie!, 'content-type': 'application/json', 'x-canvas-workspace-id': h.workspaceId,
      }, body: JSON.stringify({ apiVersion: 1, workspaceId: h.workspaceId, documentId: target.documentId, format: 'markdown' }) }));
      assert.equal(response.status, 200); return validate(await response.json());
    }
    if (adapter === 'agent') {
      const { getPiTools } = await import('../app/lib/pi/tool-registry');
      if (!registered) registered = (await getPiTools('reader', h.agentId, h.piSessionId,
        { strictAuthorization: true, metadataOnlyExternal: true })).find(tool => tool.name === 'read_document');
      assert(registered);
      const result = await registered.execute(`matrix-${crypto.randomUUID()}`,
        { workspaceId: h.workspaceId, documentId: target.documentId, format: 'markdown' });
      assert.notEqual(Reflect.get(result, 'isError'), true); assert.equal(result.content.length, 1);
      const text = object(result.content[0]); assert.equal(text.type, 'text'); assert(typeof text.text === 'string');
      const page = validate(JSON.parse(text.text));
      const { toolOutput: _toolOutput, ...details } = object(result.details); assert.deepEqual(details, page);
      return page;
    }
    if (first) {
      const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {},
        clientInfo: { name: 'owned-matrix-fixture', version: '1' } }); assert(initialized.serverInfo);
      const listed = await rpc('tools/list', {}); assert(Array.isArray(listed.tools));
      assert(listed.tools.some(tool => object(tool).name === 'read_knowledge_source'));
    }
    const result = await rpc('tools/call', { name: 'read_knowledge_source', arguments: {
      workspace_id: h.workspaceId, document_id: target.documentId, format: 'markdown',
    } });
    assert.notEqual(result.isError, true); assert(Array.isArray(result.content)); assert.equal(result.content.length, 1);
    const text = object(result.content[0]); assert.equal(text.type, 'text'); assert(typeof text.text === 'string');
    assert.deepEqual(JSON.parse(text.text), result.structuredContent); return validate(result.structuredContent);
  };
  const first = await profile('first-adapter-entry-and-read', () => read(true));
  for (let index = 1; index <= 2; index++) {
    const next = await profile(`warm-read-${index}`, () => read(false));
    assert.deepEqual(next, first, 'All adapters preserve the same complete stable read through repeated entry.');
  }
  assert.deepEqual(await h.snapshot(), before, 'Read measurements preserve native bytes, identities, metadata, revisions and projection rows.');
  console.log(JSON.stringify({ documentAdapterMatrix: true, adapter, agentKind, nativeDocuments: size, windows: profiles.length,
    nativeIdentityAndBytesUnchanged: true, completeCanonicalMarkdown: true }));
}, { agentKind }));
assert.equal(profiles.length, 3);
assert(profiles.every(item => item.measurement.unsupportedQueryForms === 0 && item.measurement.failedStatements === 0));
await fs.writeFile(output, JSON.stringify({ version: 1, fixture: 'document-adapter-matrix', adapter, agentKind, nativeDocuments: size,
  scope: 'fresh-fixture-process-per-adapter-first-entry-and-two-warm-reads',
  exclusions: ['not-browser-or-TCP-acceptance', 'not-a-live-agent-turn-or-production-OAuth-issuance'],
  nativeIdentityAndBytesUnchanged: true, completeCanonicalMarkdown: true, profiles, operations }, null, 2) + '\n',
{ mode: 0o600, flag: 'wx' });
completed = true;

import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { WorkspaceDocumentLinkIndex } from '../app/lib/markdown/workspace-document-link-index-contract';
import { getWorkspaceDocumentRelations } from '../app/lib/markdown/workspace-document-relations';
import { measureDocumentDatabaseActivity, type DocumentDatabaseActivityMeasurement } from '../app/lib/observability/document-operation-metrics';
import { withDocumentReadToolDispatchFixture, type DispatchDocument } from './helpers/document-read-tool-dispatch-fixture';

assert.equal(process.env.NODE_ENV, 'test');
const output = process.env.CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT;
assert(output && path.isAbsolute(output));
const agentKind = process.env.CANVAS_DOCUMENT_BASELINE_AGENT_KIND ?? 'main';
assert(agentKind === 'main' || agentKind === 'organization-member');
assert.equal(process.env.FILE_VERSION_CENTER_MODE ?? 'off', 'off');
const profiles: Array<{ label: string; measurement: DocumentDatabaseActivityMeasurement }> = [];
let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const profile = <T>(label: string, actor: 'request' | 'agent' | 'mcp', execute: () => Promise<T>) =>
  measureDocumentDatabaseActivity('links', actor, execute, measurement => profiles.push({ label, measurement }));

await withDocumentReadToolDispatchFixture(async h => {
  process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
  process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,search_knowledge,create_knowledge_source';
  assert.equal((await h.admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=1
    WHERE organization_id='tool-dispatch-org' AND user_id='reader' AND status='active'`)).rowCount, 1);
  await h.admin.query(`UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2 AND user_id='reader'`,
    [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write']), h.clientId]);
  await h.setPiEnabledTools(['read_document', 'inspect_document_relations']);
  const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
  const { WORKSPACE_FILE_UNDO_ENABLED } = await import('../app/lib/files/workspace-file-undo-policy');
  assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
  assert.equal(WORKSPACE_FILE_UNDO_ENABLED, false);
  await fs.mkdir(path.join(h.workspaceRoot, 'docs'), { recursive: true });
  const target = await h.seed({ filePath: 'docs/target.md', text: '---\naliases: [Goal]\n---\n# Target\n\n## Section\n' });
  await h.seed({ filePath: 'docs/one.md', text: '---\naliases: [Duplicate]\n---\n# One\n' });
  await h.seed({ filePath: 'docs/two.md', text: '---\naliases: [Duplicate]\n---\n# Two\n' });
  const content = '# Source\n\n[[Goal#Section|Label]]\n\n[Relative](target.md#Section)\n\n[[Missing]]\n\n[[Duplicate]]\n';
  const sources: DispatchDocument[] = [];
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    sources.push(await h.seed({ filePath: `docs/source-${representation}.md`, representation, text: content }));
  }
  await fs.writeFile(path.join(h.workspaceRoot, 'metadata.md'), '---\ntags: [broken\n---\n# Metadata\n');
  await fs.writeFile(path.join(h.workspaceRoot, 'html.md'), '# HTML\n\n<a href="docs/target.md">Target</a>\n');
  const token = await h.issue({ scope: 'knowledge:read knowledge:search knowledge:write' });
  let rpcId = 0;
  const rpc = async (method: string, params: object): Promise<Record<string, unknown>> => {
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const id = ++rpcId;
    const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }));
    assert.equal(response.status, 200); const envelope = object(await response.json());
    assert.equal(envelope.id, id); assert.equal(Object.hasOwn(envelope, 'error'), false);
    return object(envelope.result);
  };
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'owned-link-parity', version: '1' } });
  const createdPath = 'docs/source-mcp.md';
  await profile('mcp-create-shared-link-input', 'mcp', async () => {
    const result = await rpc('tools/call', { name: 'create_knowledge_source', arguments: {
      workspace_id: h.workspaceId, path: createdPath, content, idempotency_key: randomUUID(),
    } });
    assert.notEqual(result.isError, true);
    assert.equal(typeof result.structuredContent, 'object');
  });
  const created = (await h.admin.query('SELECT id,lineage_id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
    [h.workspaceId, createdPath])).rows;
  assert.equal(created.length, 1); assert.equal(typeof created[0].lineage_id, 'string');
  const session = (await h.admin.query('SELECT token FROM session WHERE id=$1', ['reader-session'])).rows[0]; assert(session);
  const cookie = (await serializeSignedCookie('better-auth.session_token', session.token, process.env.BETTER_AUTH_SECRET!)).split(';')[0];
  const request = (url: string, body?: object) => new NextRequest(`http://localhost${url}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { cookie,
      'content-type': 'application/json', 'x-canvas-workspace-id': h.workspaceId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let registered: AgentTool[] | undefined;
  const tool = async (name: string): Promise<AgentTool> => {
    registered ??= await (await import('../app/lib/pi/tool-registry')).getPiTools('reader', h.agentId, h.piSessionId,
      { strictAuthorization: true, metadataOnlyExternal: true });
    const found = registered.find(value => value.name === name); assert(found); return found;
  };
  const beforeReads = await h.snapshot();
  const snapshotPhysical = () => Promise.all(['metadata.md', 'html.md', createdPath].map(async filePath => {
    const fullPath = path.join(h.workspaceRoot, filePath), stat = await fs.lstat(fullPath, { bigint: true });
    return { filePath, bytes: await fs.readFile(fullPath), device: stat.dev, inode: stat.ino, mode: stat.mode,
      links: stat.nlink, size: stat.size, modified: stat.mtimeNs, changed: stat.ctimeNs };
  }));
  const originalPhysical = await snapshotPhysical();
  const assertReadSnapshot = async (expected: unknown, message: string) => {
    assert.deepEqual(await h.snapshot(), expected, message);
    assert.deepEqual(await snapshotPhysical(), originalPhysical, 'Reads preserve physical bytes, identity and modification times.');
  };
  const index = async (label: string): Promise<WorkspaceDocumentLinkIndex> => profile(label, 'request', async () => {
    const { GET } = await import('../app/api/markdown/link-index/route');
    const response = await GET(request('/api/markdown/link-index')); assert.equal(response.status, 200);
    return object(await response.json()).index as WorkspaceDocumentLinkIndex;
  });
  const compareRelations = async (label: string, current: WorkspaceDocumentLinkIndex, sourcePath: string) =>
    profile(label, 'agent', async () => {
      const result = await (await tool('inspect_document_relations')).execute(randomUUID(),
        { path: sourcePath, depth: 2, direction: 'both', includeBroken: true, limit: 20 });
      assert.notEqual(Reflect.get(result, 'isError'), true); const details = object(result.details);
      const expected = getWorkspaceDocumentRelations(current, sourcePath, { includeRelated: true, relatedLimit: 20 });
      assert.equal(details.source, 'native_and_physical');
      for (const field of ['document', 'incoming', 'outgoing', 'brokenLinks', 'related'] as const) {
        assert.deepEqual(details[field], expected[field], `${label}: actual registered Agent ${field} must match the Editor's actual HTTP index.`);
      }
      assert.deepEqual(details.coverage, current.coverage); assert.deepEqual(details.gaps, current.gaps);
    });
  for (const phase of ['first', 'warm'] as const) {
    const current = await index(`${phase}-http-index`); assert(current.diagnostics);
    assert.equal(current.diagnostics.sourcesComplete, true);
    assert(current.diagnostics.metadataErrors.includes('metadata.md'));
    assert(current.diagnostics.htmlSources.includes('html.md'));
    assert(current.brokenLinks.some(edge => edge.status === 'missing'));
    assert(current.brokenLinks.some(edge => edge.status === 'ambiguous'));
    for (const sourcePath of [...sources.map(source => source.filePath), createdPath]) {
      const edges = current.edges.filter(edge => edge.sourcePath === sourcePath);
      assert(edges.some(edge => edge.kind === 'wiki' && edge.status === 'resolved' && edge.targetPath === 'docs/target.md'));
      assert(edges.some(edge => edge.kind === 'markdown' && edge.status === 'resolved' && edge.targetPath === 'docs/target.md'));
      assert(edges.some(edge => edge.status === 'missing' && edge.targetText === 'Missing'));
      assert(edges.some(edge => edge.status === 'ambiguous' && edge.targetText === 'Duplicate'));
      await compareRelations(`${phase}-agent-relations-${sourcePath === createdPath ? 'mcp-created' : sources.findIndex(source => source.filePath === sourcePath)}`,
        current, sourcePath);
    }
    await assertReadSnapshot(beforeReads, 'Both real index adapters preserve all native bytes, rows and xmin.');
  }
  const { POST } = await import('../app/api/documents/read/route');
  for (const source of sources) {
    const expected = await profile(`native-http-${source.representation}`, 'request', async () => {
      const response = await POST(request('/api/documents/read', { apiVersion: 1, workspaceId: h.workspaceId,
        documentId: source.documentId, format: 'markdown' })); assert.equal(response.status, 200);
      const page = object(await response.json());
      assert.equal(page.apiVersion, 1); assert.equal(page.complete, true); assert.equal(page.nextCursor, null);
      const document = object(page.document);
      assert.equal(document.documentId, source.documentId); assert.equal(document.lineageId, source.lineageId);
      assert.equal(document.lifecycleGeneration, 1); assert.equal(document.representation, source.representation);
      assert.equal(document.path, source.filePath); assert.equal(document.workspaceId, h.workspaceId);
      assert.equal(typeof document.version, 'string'); assert.equal(typeof document.metadataVersion, 'string');
      assert.equal(typeof page.fragment, 'string'); assert.equal(page.byteLength, Buffer.byteLength(page.fragment as string));
      assert.equal(page.totalBytes, page.byteLength);
      return page;
    });
    await profile(`native-agent-${source.representation}`, 'agent', async () => {
      const result = await (await tool('read_document')).execute(randomUUID(),
        { workspaceId: h.workspaceId, documentId: source.documentId, format: 'markdown' });
      assert.notEqual(Reflect.get(result, 'isError'), true);
      assert.deepEqual(JSON.parse(String(object(result.content[0]).text)), expected);
    });
    await profile(`native-mcp-${source.representation}`, 'mcp', async () => {
      const result = await rpc('tools/call', { name: 'read_knowledge_source', arguments: {
        workspace_id: h.workspaceId, document_id: source.documentId, format: 'markdown',
      } });
      assert.notEqual(result.isError, true); assert.deepEqual(result.structuredContent, expected);
    });
  }
  await assertReadSnapshot(beforeReads, 'All three actual native read adapters preserve the complete snapshot.');
  const originalState = (await h.admin.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId])).rows[0];
  assert(originalState);
  for (const fault of ['inactive', 'invalid-binary'] as const) {
    await h.admin.query('UPDATE collaboration_yjs_states SET status=$2,yjs_state=$3 WHERE document_id=$1',
      [target.documentId, fault === 'inactive' ? 'archived' : originalState.status,
        fault === 'invalid-binary' ? Buffer.concat([originalState.yjs_state, Buffer.from([255])]) : originalState.yjs_state]);
    try {
      const damaged = await h.snapshot();
      const current = await index(`${fault}-http-index`); assert(current.diagnostics);
      assert.equal(current.diagnostics.sourcesComplete, false);
      assert(current.diagnostics.sourceGaps.some(gap => gap.path === target.filePath && gap.code ===
        (fault === 'inactive' ? 'inactive-native-state' : 'unreadable-native-source')));
      assert(current.diagnostics.sourceGaps.every(gap => gap.path === target.filePath));
      assert(current.diagnostics.metadataErrors.includes('metadata.md'));
      assert(current.diagnostics.htmlSources.includes('html.md'));
      await compareRelations(`${fault}-agent-relations`, current, sources[0].filePath);
      await assertReadSnapshot(damaged, 'Real HTTP/Agent reads diagnose but never repair the intentionally damaged owned fixture.');
    } finally {
      await h.admin.query('UPDATE collaboration_yjs_states SET status=$2,yjs_state=$3 WHERE document_id=$1',
        [target.documentId, originalState.status, originalState.yjs_state]);
      assert.deepEqual((await h.admin.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1',
        [target.documentId])).rows[0], originalState);
    }
  }
  // Fault updates intentionally change this owned row's xmin. Only each read
  // phase promises an unchanged complete snapshot, including xmin.
  const restored = await h.snapshot();
  const current = await index('restored-http-index'); assert.equal(current.diagnostics?.sourcesComplete, true);
  await compareRelations('restored-agent-relations', current, sources[0].filePath);
  await assertReadSnapshot(restored, 'Reads after exact restoration preserve the complete snapshot.');
}, { agentKind });
assert(profiles.every(({ measurement }) => measurement.failedStatements === 0 && measurement.unsupportedQueryForms === 0
  && measurement.openQueriesAtCompletion === 0 && measurement.openConnectionsAtCompletion === 0));
await fs.writeFile(output, JSON.stringify({ version: 1, passed: true, fixture: 'actual-link-adapter-parity', agentKind,
  realRegisteredAgentRelations: true, sameNativeReadPagesAcrossHttpAgentMcp: true,
  mcpCreatedLinkEffectsObserved: true, separateMetadataHtmlAndUnresolvedDiagnostics: true,
  warmCacheDoesNotHideInactiveOrInvalidNativeSources: true, ownedFaultStateExactlyRestored: true,
  physicalFilesAndIdentityPreservedDuringReads: true,
  nativeRowsXminAndBytesPreservedDuringReads: true, reviewCenterAndUndoEnabled: false,
  exclusions: ['not-a-browser-or-model-turn', 'not-a-new-public-MCP-relations-tool', 'not-a-production-OAuth-issuance'],
  profiles }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
completed = true;

import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { measureDocumentDatabaseActivity, withDocumentOperationMetricObserver,
  type DocumentDatabaseActivityMeasurement, type DocumentOperationMeasurement } from '../app/lib/observability/document-operation-metrics';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';
import { documentBaselineSize, fillDocumentBaselineFixture } from './helpers/document-baseline-fixture';

assert.equal(process.env.NODE_ENV, 'test');
const configuredAdapter = process.env.CANVAS_DOCUMENT_BASELINE_ADAPTER;
assert(configuredAdapter === 'agent' || configuredAdapter === 'mcp');
const adapter: 'agent' | 'mcp' = configuredAdapter;
const agentKind = process.env.CANVAS_DOCUMENT_BASELINE_AGENT_KIND as 'main' | 'organization-member' | undefined ?? 'main';
assert(agentKind === 'main' || agentKind === 'organization-member');
assert(adapter === 'agent' || agentKind === 'main');
const requestedSize = documentBaselineSize(process.env.CANVAS_DOCUMENT_BASELINE_DOCUMENTS, 10);
const output = process.env.CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT;
assert(output && path.isAbsolute(output));
const profiles: Array<{ label: string; documentsBefore: number; measurement: DocumentDatabaseActivityMeasurement }> = [];
const operations: DocumentOperationMeasurement[] = [];
let completed = false, seededDocuments = 0;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

async function documentCreateMatrixBaseline(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async h => {
    // All authority is real fixture data, checked by the ordinary handlers.
    // This is neither production OAuth issuance nor a live model invocation.
    process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
    process.env.FILE_VERSION_CENTER_MODE = 'shadow';
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,search_knowledge,create_knowledge_source';
    assert.equal((await h.admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=1
      WHERE organization_id='tool-dispatch-org' AND user_id='reader' AND status='active'`)).rowCount, 1);
    await h.admin.query(`UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2 AND user_id='reader'`,
      [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write']), h.clientId]);
    await h.setPiEnabledTools(['read_document', 'write']);
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    const { WORKSPACE_FILE_UNDO_ENABLED } = await import('../app/lib/files/workspace-file-undo-policy');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    assert.equal(WORKSPACE_FILE_UNDO_ENABLED, false);

    const session = (await h.admin.query('SELECT token FROM session WHERE id=$1', ['reader-session'])).rows[0]; assert(session);
    const cookie = (await serializeSignedCookie('better-auth.session_token', session.token, process.env.BETTER_AUTH_SECRET!)).split(';')[0];
    const original = new NextRequest('http://localhost/api/files/upload', { method: 'POST',
      headers: { cookie, Origin: 'http://localhost', 'x-canvas-workspace-id': h.workspaceId } });
    const { requireRequestWorkspace } = await import('../app/lib/workspaces/request');
    const selected = await requireRequestWorkspace(original, { permissions: 'canWrite' });
    assert.equal(selected.response, null); assert(selected.workspace); const workspace = selected.workspace;
    const uploads = await import('../app/lib/files/workspace-upload-service');
    const { persistAndProjectAuthenticatedMarkdownUploadFile } = await import('../app/lib/collaboration/markdown-file-import-persistence');
    const upload = async (filePath: string, content: string): Promise<void> => {
      const bytes = Buffer.from(content);
      const staged = await uploads.createWorkspaceUploadSession({ userId: 'reader', workspace, targetDir: '.',
        files: [{ path: filePath, size: bytes.length, mimeType: 'text/markdown' }] });
      await uploads.writeWorkspaceUploadChunk({ sessionId: staged.id, userId: 'reader', workspace, fileId: staged.files[0].id,
        offset: 0, expectedBytes: bytes.length, body: new Blob([new Uint8Array(bytes)]).stream() });
      const applied = await persistAndProjectAuthenticatedMarkdownUploadFile(original, {
        uploadSessionId: staged.id, fileId: staged.files[0].id, workspaceId: h.workspaceId, targetPath: filePath,
        actorUserId: 'reader', actorSessionId: 'reader-session', requestId: randomUUID(), operationId: randomUUID() });
      assert.equal(applied.projection.status, 'projected');
      assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, filePath)), bytes);
    };
    const count = async (): Promise<number> => Number((await h.admin.query(`SELECT count(*)::integer AS n
      FROM collaboration_documents WHERE workspace_id=$1 AND status='active'`, [h.workspaceId])).rows[0].n);
    await upload('matrix/seed-0.md', '# Seed document\n\nKept original body 😀.\n');
    seededDocuments = await fillDocumentBaselineFixture({ target: requestedSize, count,
      seed: index => upload(`matrix/seed-${index}.md`, `# Seed document ${index}\n\nKept original body.\n`) });
    const initialDocuments = (await h.admin.query(`SELECT id,path FROM collaboration_documents
      WHERE workspace_id=$1 AND status='active' ORDER BY id`, [h.workspaceId])).rows as Array<{ id: string; path: string }>;
    assert.equal(initialDocuments.length, requestedSize);
    const initialIds = initialDocuments.map(row => row.id);
    const observeOriginals = async () => (await h.admin.query(`SELECT to_jsonb(d) AS registry,d.xmin::text AS registry_xmin,
      to_jsonb(l) AS lineage,l.xmin::text AS lineage_xmin,to_jsonb(s) AS native,s.xmin::text AS native_xmin,
      to_jsonb(m) AS metadata,m.xmin::text AS metadata_xmin
      FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
      JOIN collaboration_yjs_states s ON s.document_id=d.id
      LEFT JOIN workspace_file_metadata m ON m.workspace_id=d.workspace_id AND m.path=d.path
      WHERE d.workspace_id=$1 AND d.id=ANY($2::text[]) ORDER BY d.id`, [h.workspaceId, initialIds])).rows;
    const before = await observeOriginals(); assert.equal(before.length, requestedSize);
    const originalFiles = new Map<string, string>();
    for (const document of initialDocuments) originalFiles.set(document.path, sha256(await fs.readFile(path.join(h.workspaceRoot, document.path))));

    const token = adapter === 'mcp' ? await h.issue({ scope: 'knowledge:read knowledge:search knowledge:write' }) : undefined;
    let registered: AgentTool | undefined, rpcId = 0;
    const rpc = async (method: string, params: object): Promise<Record<string, unknown>> => {
      const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
      const id = ++rpcId;
      const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        authorization: `Bearer ${token!}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }));
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const envelope = object(await response.json()); assert.equal(envelope.id, id); assert.equal(Object.hasOwn(envelope, 'error'), false);
      return object(envelope.result);
    };
    const content = '# Matrix created\n\n[Seed](../../seed-0.md)\n\nKept original body 😀.\n';
    const selections = [0, 1, 2].map(index => ({ filePath: `matrix/campaign/linkedin/created-${index}.md`, key: randomUUID(), callId: randomUUID() }));
    type Selection = typeof selections[number];
    const create = async (selection: Selection, first: boolean): Promise<void> => {
      if (adapter === 'agent') {
        if (!registered) {
          const { getPiTools } = await import('../app/lib/pi/tool-registry');
          registered = (await getPiTools('reader', h.agentId, h.piSessionId,
            { strictAuthorization: true, metadataOnlyExternal: true })).find(tool => tool.name === 'write');
          assert(registered, 'The normal registered write tool must be available.');
        }
        const result = await registered.execute(selection.callId, { path: selection.filePath, content, idempotencyKey: selection.key });
        assert.notEqual(Reflect.get(result, 'isError'), true,
          `Actual registered Agent create failed: ${String(object(result.details).code ?? 'unclassified')}`);
      } else {
        if (first) {
          assert((await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {},
            clientInfo: { name: 'owned-create-matrix', version: '1' } })).serverInfo);
          const tools = (await rpc('tools/list', {})).tools; assert(Array.isArray(tools));
          assert(tools.some(tool => object(tool).name === 'create_knowledge_source'));
        }
        const result = await rpc('tools/call', { name: 'create_knowledge_source', arguments: {
          workspace_id: h.workspaceId, path: selection.filePath, content, idempotency_key: selection.key,
        } });
        assert.notEqual(result.isError, true, `Actual MCP create failed: ${String(object(result.structuredContent).code ?? 'unclassified')}`);
        assert(Array.isArray(result.content)); assert.equal(result.content.length, 1);
        assert.deepEqual(JSON.parse(String(object(result.content[0]).text)), result.structuredContent);
      }
    };
    const verifyCreated = async (selection: Selection): Promise<{ documentId: string; lineageId: string; operationId: string }> => {
      const rows = (await h.admin.query(`SELECT d.id,d.lineage_id,s.document_sequence,s.checkpoint_sequence,s.checkpointed_at,
        s.status,r.operation_id,r.actor_user_id,r.actor_session_id,r.private_result,b.finalized AS birth_finalized,
        b.claim_id,b.claim_fingerprint,b.revision_id AS birth_revision_id,p.revision_id AS projection_revision_id,
        p.finalized AS projection_finalized,p.serialized_hash
        FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id
        JOIN collaboration_markdown_file_import_receipts r ON r.workspace_id=d.workspace_id AND r.private_result->'target'->>'documentId'=d.id
        JOIN collaboration_markdown_create_births b ON b.workspace_id=r.workspace_id AND b.operation_id=r.operation_id
        JOIN collaboration_file_projections p ON p.document_id=d.id AND p.lifecycle_generation=s.lifecycle_generation
        WHERE d.workspace_id=$1 AND d.path=$2`, [h.workspaceId, selection.filePath])).rows;
      assert.equal(rows.length, 1); const row = rows[0];
      assert.equal(row.actor_user_id, 'reader'); assert.equal(row.actor_session_id, adapter === 'agent' ? h.piSessionId : 'reader-session');
      assert.equal(row.status, 'active'); assert.equal(Number(row.document_sequence), Number(row.checkpoint_sequence));
      assert.notEqual(row.checkpointed_at, null); assert.equal(Number(row.birth_finalized), 1); assert.equal(Number(row.projection_finalized), 1);
      assert.equal(row.serialized_hash, sha256(content));
      assert.equal(row.projection_revision_id, row.birth_revision_id);
      const { observeMarkdownCreateBirth } = await import('../app/lib/files/markdown-create-birth');
      const birth = await observeMarkdownCreateBirth({ workspaceRoot: h.workspaceRoot, workspaceId: h.workspaceId, operationId: row.operation_id });
      assert.equal(birth.complete, true); assert.equal(birth.id, row.claim_id); assert.equal(birth.fingerprint, row.claim_fingerprint);
      const { readDocumentForRequest } = await import('../app/lib/documents/service');
      const page = await readDocumentForRequest(original, { apiVersion: 1, workspaceId: h.workspaceId, documentId: row.id, format: 'markdown' });
      assert.equal(page.complete, true); assert.equal(page.fragment, content); assert.equal(page.document.lineageId, row.lineage_id);
      assert.equal(page.document.path, selection.filePath); assert.equal(page.projection.status, 'current');
      assert.deepEqual(await fs.readFile(path.join(h.workspaceRoot, selection.filePath)), Buffer.from(content));
      return { documentId: row.id, lineageId: row.lineage_id, operationId: row.operation_id };
    };
    const firstIdentities: Array<Awaited<ReturnType<typeof verifyCreated>>> = [];
    for (let index = 0; index < selections.length; index++) {
      const documentsBefore = await count();
      await measureDocumentDatabaseActivity('create', adapter, () => create(selections[index], index === 0),
        measurement => profiles.push({ label: index === 0 ? 'first-adapter-entry-and-create' : `warm-fresh-create-${index}`, documentsBefore, measurement }));
      firstIdentities.push(await verifyCreated(selections[index]));
      assert.equal(await count(), requestedSize + index + 1);
    }
    const documentsBefore = await count();
    await measureDocumentDatabaseActivity('create', adapter, () => create(selections[0], false),
      measurement => profiles.push({ label: 'same-original-idempotent-retry', documentsBefore, measurement }));
    assert.deepEqual(await verifyCreated(selections[0]), firstIdentities[0]);
    assert.equal(await count(), requestedSize + 3);
    assert.deepEqual(await observeOriginals(), before, 'Create and retry preserve every original native/metadata row and xmin.');
    for (const [filePath, fingerprint] of originalFiles) assert.equal(sha256(await fs.readFile(path.join(h.workspaceRoot, filePath))), fingerprint);
    assert(profiles.every(item => item.measurement.failedStatements === 0 && item.measurement.unsupportedQueryForms === 0
      && item.measurement.openQueriesAtCompletion === 0 && item.measurement.openConnectionsAtCompletion === 0));
    console.log(JSON.stringify({ documentCreateMatrix: true, adapter, normalUploadSources: seededDocuments,
      windows: profiles.length, unrelatedNativeAndPhysicalUnchanged: true, originalRetryIdentityPreserved: true }));
  }, { agentKind });
}

try {
  await withDocumentOperationMetricObserver(value => operations.push(value), documentCreateMatrixBaseline);
  completed = true;
} finally {
  await fs.writeFile(output, JSON.stringify({ version: 1, passed: completed, fixture: 'document-create-matrix', adapter, agentKind,
    nativeDocumentsBeforeFirstCreate: seededDocuments, normalUploadSources: true,
    scope: 'fresh-process-per-adapter-first-entry-two-warm-fresh-creates-and-separate-original-retry',
    exclusions: ['no-live-model-turn', 'no-production-OAuth-issuance', 'no-browser-or-Next-middleware', 'not-a-cold-PostgreSQL-buffer-cache'],
    profiles, operations }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

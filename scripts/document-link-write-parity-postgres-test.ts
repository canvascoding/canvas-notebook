import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';
import { withNativeApiKeyEditRuntime } from './helpers/native-api-key-edit-runtime';
import { withInstalledApiKeySdkMcpFixture } from './helpers/installed-api-key-sdk-mcp-fixture';
import type { WorkspaceDocumentLinkIndex } from '../app/lib/markdown/workspace-document-link-index-contract';

async function main() {
  const python = process.env.CANVAS_SDK_TEST_PYTHON, wheel = process.env.CANVAS_SDK_TEST_WHEEL;
  assert(python && wheel && path.isAbsolute(python) && path.isAbsolute(wheel));
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { FILE_VERSION_CENTER_MODE: 'off', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS: 'read_knowledge_source,create_knowledge_source,edit_knowledge_source' });
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    const { WORKSPACE_FILE_UNDO_ENABLED } = await import('../app/lib/files/workspace-file-undo-policy');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false); assert.equal(WORKSPACE_FILE_UNDO_ENABLED, false);
    const { createApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { withFreshDocumentLinkReadProjection } = await import('../app/lib/markdown/document-link-read-projection');
    const { POST: create } = await import('../app/api/documents/create/route');
    const { POST: edit } = await import('../app/api/documents/edit/route');
    const { POST: read } = await import('../app/api/documents/read/route');
    const { GET: index } = await import('../app/api/markdown/link-index/route');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const manager = new Headers((await h.request(h.source, 'owner')).headers); manager.set('Origin', 'http://localhost');
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Link mutation parity',
      workspaceIds: [h.source.workspaceId], actions: ['read', 'create', 'edit', 'status'], expiresAt: Date.now() + 3_600_000 });
    const post = async (route: typeof create, body: object) => {
      const response = await route(new NextRequest(`http://localhost/api/documents/${route === create ? 'create' : route === read ? 'read' : 'edit'}`, { method: 'POST',
        headers: { 'X-Canvas-API-Key': issued.key, 'Content-Type': 'application/json', Origin: 'http://localhost' },
        body: JSON.stringify({ apiVersion: 1, workspaceId: h.source.workspaceId, ...body }) }));
      assert([200, 201].includes(response.status), `Actual document handler returned ${response.status}`);
      return response.json();
    };
    const createDoc = async (filePath: string, content: string) => {
      const result = await post(create, { path: filePath, content, idempotencyKey: randomUUID() });
      assert.equal(result.outcome, 'created'); return result.document.documentId as string;
    };
    let groups = 0, indexRateLimitRetries = 0;
    try {
      await withNativeApiKeyEditRuntime(h, async () => {
        for (const transport of ['rest', 'mcp-2025-11-25', 'mcp-2026-07-28', 'installed-sdk'] as const) {
          const directory = transport, sourcePath = `${directory}/source.md`, targetPath = `${directory}/target.md`, otherPath = `${directory}/other.md`;
          const shared = `Shared-${transport}`, renamed = `New-${transport}`, future = `Future-${transport}`;
          const original = `---\naliases: [${shared}]\n---\n# Original title\n`;
          const updated = `---\naliases: [${renamed}]\n---\n# Updated title\n`;
          const other = '---\naliases: [Other]\n---\n# Other title\n';
          const ambiguous = `---\naliases: [${renamed}]\n---\n# Other title\n`;
          const unique = `---\naliases: [${shared}]\n---\n# Other title\n`;
          const final = `---\naliases: [${renamed}]\n---\n# Final title\n`;
          const source = await createDoc(sourcePath, `# Source\n\n[[${shared}]] [[${renamed}]] [[${future}]] [Exact](target.md)\n`);
          const target = await createDoc(targetPath, original), second = await createDoc(otherPath, other);
          const protectedSnapshot = async () => ({
            documents: (await h.admin.query('SELECT to_jsonb(d) AS row,xmin::text AS xmin FROM collaboration_documents d WHERE id=$1', [source])).rows,
            states: (await h.admin.query('SELECT to_jsonb(s) AS row,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [source])).rows,
            bytes: await readFile(path.join(h.source.rootPath, sourcePath)),
          });
          const protectedBefore = await protectedSnapshot();
          const observe = async () => {
            for (let attempt = 0; attempt < 2; attempt++) {
              const headers = new Headers((await h.request(h.source, 'owner')).headers);
              const response = await index(new NextRequest('http://localhost/api/markdown/link-index', { headers }));
              if (response.status === 429 && attempt === 0) {
                const retryAfter = response.headers.get('Retry-After'); assert(retryAfter && /^\d+$/u.test(retryAfter));
                const seconds = Number(retryAfter); assert(seconds >= 1 && seconds <= 60);
                await response.arrayBuffer(); indexRateLimitRetries++;
                console.log(JSON.stringify({ suite: 'document-link-write-parity-rate-limit', seconds }));
                await new Promise(resolve => setTimeout(resolve, seconds * 1000 + 100)); continue;
              }
              assert.equal(response.status, 200); const result = await response.json();
              const { generatedAt, ...semantic } = result.index as WorkspaceDocumentLinkIndex;
              assert.equal(typeof generatedAt, 'string'); assert.equal(semantic.diagnostics?.sourcesComplete, true);
              return semantic;
            }
            throw new Error('Link index retry exceeded its bounded read budget.');
          };
          const verify = async (phase: number) => {
            const actual = await observe(), rebuilt = await withFreshDocumentLinkReadProjection(observe);
            assert.deepEqual(actual, rebuilt, `${transport}/${phase}: incremental index must equal the current full rebuild`);
            const edge = (literal: string) => {
              const result = actual.edges.find(e => e.sourcePath === sourcePath && e.targetLiteral === literal); assert(result); return result;
            };
            assert.equal(edge('target.md').targetPath, targetPath);
            if (phase === 0) { assert.equal(edge(shared).targetPath, targetPath); assert.equal(edge(renamed).status, 'missing'); }
            if (phase === 1) { assert.equal(edge(shared).status, 'missing'); assert.equal(edge(renamed).targetPath, targetPath); }
            if (phase === 2) { assert.equal(edge(renamed).status, 'ambiguous'); assert.deepEqual(edge(renamed).candidates, [otherPath, targetPath]); }
            if (phase >= 3) { assert.equal(edge(shared).targetPath, otherPath); assert.equal(edge(renamed).targetPath, targetPath); }
            assert.equal(edge(future).status, phase >= 4 ? 'resolved' : 'missing');
            if (phase >= 4) assert.equal(edge(future).targetPath, `${directory}/${future}.md`);
            assert.equal(actual.documents.find(d => d.path === targetPath)?.title, phase === 0 ? 'Original title' : phase === 5 ? 'Final title' : 'Updated title');
            assert.deepEqual(await protectedSnapshot(), protectedBefore, 'Target edits never rewrite the linked source or its xmin');
            groups++;
          };
          const steps = [
            { kind: 'edit', documentId: target, before: original, after: updated, edits: [{ oldText: `aliases: [${shared}]`, newText: `aliases: [${renamed}]`, expectedOccurrences: 1 }, { oldText: 'Original title', newText: 'Updated title', expectedOccurrences: 1 }], idempotencyKey: randomUUID() },
            { kind: 'edit', documentId: second, before: other, after: ambiguous, edits: [{ oldText: 'aliases: [Other]', newText: `aliases: [${renamed}]`, expectedOccurrences: 1 }], idempotencyKey: randomUUID() },
            { kind: 'edit', documentId: second, before: ambiguous, after: unique, edits: [{ oldText: `aliases: [${renamed}]`, newText: `aliases: [${shared}]`, expectedOccurrences: 1 }], idempotencyKey: randomUUID() },
            { kind: 'create', path: `${directory}/${future}.md`, text: '# Future\n', idempotencyKey: randomUUID() },
            { kind: 'edit', documentId: target, before: updated, after: final, edits: [{ oldText: 'Updated title', newText: 'Final title', expectedOccurrences: 1 }], idempotencyKey: randomUUID() },
          ];
          const semantic = (markdown: string) => markdown.replace(/^# /gmu, '').trimEnd();
          await verify(0);
          if (transport === 'installed-sdk') {
            const result = await withInstalledApiKeySdkMcpFixture({ python, wheel, key: issued.key,
              probe: path.resolve('scripts/helpers/python_sdk_link_mutation_probe.py'), config: { workspaceId: h.source.workspaceId, steps: steps.map(step => step.kind === 'edit' ? { ...step, before: semantic(step.before!), after: semantic(step.after!) } : step) },
              event: async (event, send) => {
                if (event.event === 'updated') { assert(Number.isInteger(event.index)); await verify(Number(event.index) + 1); send({ checked: event.index }); }
                else { assert.equal(event.event, 'complete'); assert.equal(event.groups, 5); }
              } });
            assert.equal(result.stderrBytes, 0); assert.equal(result.droppedAcknowledgements, 0);
          } else {
            const protocol = transport === 'rest' ? null : transport.slice(4);
            let rpcId = 0;
            const rpc = async (method: string, params: Record<string, unknown>) => {
              const modern = protocol === '2026-07-28';
              const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
                'X-Canvas-API-Key': issued.key, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
                'mcp-protocol-version': protocol!, ...(modern ? { 'mcp-method': method,
                  ...(method === 'tools/call' ? { 'mcp-name': params.name as string } : {}) } : {}),
              }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: { ...params, ...(modern ? { _meta: {
                'io.modelcontextprotocol/protocolVersion': protocol,
                'io.modelcontextprotocol/clientInfo': { name: 'link-parity', version: '1' },
                'io.modelcontextprotocol/clientCapabilities': {},
              } } : {}) } }) }));
              assert.equal(response.status, 200); const envelope = await response.json(); assert(!envelope.error, `MCP ${method} failed with code ${envelope.error?.code}`);
              assert.notEqual(envelope.result.isError, true); return envelope.result;
            };
            if (protocol === '2026-07-28') await rpc('tools/list', {});
            else if (protocol) await rpc('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'link-parity', version: '1' } });
            for (const [i, step] of steps.entries()) {
              if (step.kind === 'create') {
                if (protocol) await rpc('tools/call', { name: 'create_knowledge_source', arguments: { api_version: 1, workspace_id: h.source.workspaceId,
                  path: step.path, content: step.text, idempotency_key: step.idempotencyKey } });
                else await post(create, { path: step.path, content: step.text, idempotencyKey: step.idempotencyKey });
              } else {
                const before = await post(read, { documentId: step.documentId, format: 'text' }); assert.equal(before.fragment, semantic(step.before!));
                const patch = { kind: 'native_text_replace', edits: step.edits };
                if (protocol) await rpc('tools/call', { name: 'edit_knowledge_source', arguments: { api_version: 1, action: 'edit',
                  workspace_id: h.source.workspaceId, document_id: step.documentId, expected_version: before.document.version,
                  idempotency_key: step.idempotencyKey, patch } });
                else { const result = await post(edit, { documentId: step.documentId, expectedVersion: before.document.version, idempotencyKey: step.idempotencyKey, patch }); assert.equal(result.state, 'confirmed'); }
              }
              await verify(i + 1);
            }
          }
          console.log(JSON.stringify({ suite: 'document-link-write-parity-profile', transport, groups: 6, passed: true }));
        }
      });
      assert.equal(groups, 24);
      console.log(JSON.stringify({ suite: 'document-link-write-parity', groups, passed: true, actualPostgres: true, indexRateLimitRetries,
        transports: ['key-rest', 'key-mcp-2025-11-25', 'key-mcp-2026-07-28', 'installed-key-sdk-http'],
        fullRebuildParity: true, protectedSourceXminAndBytesPreserved: true, compiledNext: false }));
    } finally { await revokeApiKey(manager, issued.integration.id, { expectedRevision: 1, credentialId: issued.credential.id }); }
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });

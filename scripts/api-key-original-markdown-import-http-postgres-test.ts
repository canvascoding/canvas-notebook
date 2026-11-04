import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { ApiKeyAction } from '../app/lib/api-keys/contracts';
import type { DocumentReadPageV1 } from '../app/lib/documents/contracts';
import type { DocumentEditOperationResultV1 } from '../app/lib/documents/edit-result-contract';
import type { MarkdownOriginalImportResultV1 } from '../app/lib/documents/original-markdown-import-http';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';
import { withNativeApiKeyEditRuntime } from './helpers/native-api-key-edit-runtime';

// Real loopback HTTP -> actual Next POST exports -> genuine keys/PG/native
// import/read/edit. The bridge supplies bytes, never an auth or SQL result.
// Compiled Next routing, browser UI and installed SDK remain separate gates.
const networkFetch = globalThis.fetch;
let stage = 'setup', groups = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
const sha = (input: Uint8Array) => createHash('sha256').update(input).digest('hex');
async function main() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    process.env.FILE_VERSION_CENTER_MODE = 'shadow';
    const { createApiIntegration, updateApiIntegration, rotateApiKey, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
    const { POST: importHttp } = await import('../app/api/documents/import-existing/route');
    const { POST: statusHttp } = await import('../app/api/documents/import-existing/status/route');
    const { POST: readHttp } = await import('../app/api/documents/read/route');
    const { POST: editHttp } = await import('../app/api/documents/edit/route');
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const headers = new Headers((await h.request(h.source, 'owner')).headers); headers.set('Origin', 'http://localhost');
    const actions: ApiKeyAction[] = ['read', 'import', 'edit', 'status'];
    const issued = await createApiIntegration(headers, { requestId: randomUUID(), name: 'HTTP original importer',
      workspaceIds: [h.source.workspaceId], actions, expiresAt: Date.now() + 3_600_000 });
    let key = issued.key, credentialId = issued.credential.id, revision = 1, calls = 0, importCalls = 0, dropNext = false;
    let serverFailure: unknown;
    const source = async (filePath: string, text: string) => {
      await fs.writeFile(path.join(h.source.rootPath, filePath), text, { flag: 'wx', mode: 0o600 });
      return { apiVersion: 1 as const, workspaceId: h.source.workspaceId, path: filePath,
        operationId: `http_original_${randomUUID().replaceAll('-', '')}`,
        expectedFileVersion: filesystemFileVersion(await fs.stat(path.join(h.source.rootPath, filePath))), initialRepresentation: 'plain_text' as const };
    };
    const check = async (name: string, consume: () => Promise<void>) => { stage = name; await consume(); groups++;
      console.log(`API-key original import HTTP passed: ${name}`); };
    await withNativeApiKeyEditRuntime(h, async ({ server, origin }) => {
      const routes: Record<string, (request: NextRequest) => Promise<Response>> = {
        '/api/documents/import-existing': importHttp, '/api/documents/import-existing/status': statusHttp,
        '/api/documents/read': readHttp, '/api/documents/edit': editHttp,
      };
      server.on('request', (incoming, outgoing) => { void (async () => {
        const handler = routes[incoming.url ?? ''];
        if (incoming.method !== 'POST' || !handler) { outgoing.writeHead(405); outgoing.end(); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of incoming) { const value = Buffer.from(chunk); bytes += value.length;
          assert(bytes <= 1024 * 1024); chunks.push(value); }
        const requestHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach(item => requestHeaders.append(name, item));
          else if (value !== undefined) requestHeaders.set(name, value);
        }
        if (incoming.url === '/api/documents/import-existing') importCalls++;
        const response = await handler(new NextRequest(`${origin}${incoming.url}`, { method: 'POST',
          headers: requestHeaders, body: new Uint8Array(Buffer.concat(chunks)) }));
        if (incoming.url === '/api/documents/import-existing' && dropNext && response.status === 200) {
          dropNext = false; outgoing.destroy(); return;
        }
        response.headers.forEach((value, name) => outgoing.setHeader(name, value));
        outgoing.writeHead(response.status); outgoing.end(Buffer.from(await response.arrayBuffer()));
      })().catch(error => { serverFailure ??= error; if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end(); }); });
      const post = async <T = Record<string, unknown>>(route: string, value: unknown,
        overrides: Record<string, string> = {}, raw?: Uint8Array) => {
        const url = new URL(route, origin); assert.equal(url.origin, origin); assert(server.listening); calls++;
        const response = await networkFetch(url, { method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000),
          headers: { 'Content-Type': 'application/json', 'X-Canvas-API-Key': key, ...overrides },
          body: raw ? new Uint8Array(raw) : JSON.stringify(value) });
        assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('pragma'), 'no-cache');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        return { status: response.status, headers: response.headers, body: await response.json() as T };
      };
      const importRoute = '/api/documents/import-existing', statusRoute = `${importRoute}/status`;
      const selected = await source('key-rest-original.md', 'Before original through real HTTP.\n');
      const statusSelection = { apiVersion: 1, workspaceId: selected.workspaceId, operationId: selected.operationId };
      let original: Extract<MarkdownOriginalImportResultV1, { status: 'confirmed' }>;
      const stored = async () => (await h.admin.query(`SELECT o.original_text,o.xmin::text AS original_xmin,
        r.private_result,r.actor_session_id,r.xmin::text AS receipt_xmin
        FROM collaboration_original_markdown_import_api_keys o JOIN collaboration_markdown_file_import_receipts r USING(workspace_id,operation_id)
        WHERE o.workspace_id=$1 AND o.original_text::jsonb->>'callerOperationId'=$2`, [selected.workspaceId, selected.operationId])).rows;
      const failure = async (route: string, value: unknown, status: number, code: string, overrides?: Record<string, string>, raw?: Uint8Array) => {
        const result = await post(route, value, overrides, raw); assert.equal(result.status, status);
        assert.deepEqual(result.body, { apiVersion: 1, success: false, code });
      };
      await check('actual key-only TCP import, bounded public DTO and native API Read retain the source', async () => {
        const bytes = await fs.readFile(path.join(h.source.rootPath, selected.path));
        const result = await post<MarkdownOriginalImportResultV1>(importRoute, selected); assert.equal(result.status, 200);
        assert(result.body.status === 'confirmed'); original = result.body;
        assert.equal(original.operationId, selected.operationId); assert.equal(original.outcome, 'imported');
        assert.deepEqual(Object.keys(original).sort(), ['apiVersion', 'operationId', 'status', 'outcome', 'documentAtImport', 'source', 'requiresFreshFileActionPreview'].sort());
        assert.equal(original.requiresFreshFileActionPreview, true); assert.deepEqual(original.source, { sha256: sha(bytes), bytes: bytes.length });
        assert.equal(original.documentAtImport.documentSequence, 0);
        assert(!JSON.stringify(original).includes(issued.integration.id)); assert(!JSON.stringify(original).includes(key));
        assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, selected.path)), bytes);
        assert.equal(filesystemFileVersion(await fs.stat(path.join(h.source.rootPath, selected.path))), selected.expectedFileVersion);
        const read = await post<DocumentReadPageV1>('/api/documents/read', { apiVersion: 1, workspaceId: selected.workspaceId,
          documentId: original.documentAtImport.documentId, format: 'markdown', maxBytes: 65536 });
        assert.equal(read.status, 200); assert.equal(read.body.fragment, bytes.toString('utf8'));
        const rows = await stored(); assert.equal(rows.length, 1); assert.equal(rows[0].actor_session_id, null);
        assert.equal(JSON.parse(rows[0].original_text).origin.credentialId, issued.credential.id);
      });
      await check('the imported document is editable through the real key API; import history remains initial', async () => {
        const before = await stored();
        const read = await post<DocumentReadPageV1>('/api/documents/read', { apiVersion: 1, workspaceId: selected.workspaceId,
          documentId: original.documentAtImport.documentId, format: 'markdown' }); assert.equal(read.status, 200);
        const edited = await post<DocumentEditOperationResultV1>('/api/documents/edit', { apiVersion: 1, workspaceId: selected.workspaceId,
          documentId: original.documentAtImport.documentId, expectedVersion: read.body.document.version,
          idempotencyKey: 'original-import-http-native-edit', patch: { kind: 'native_text_replace', edits: [{ oldText: 'Before', newText: 'After' }] } });
        assert.equal(edited.status, 200); assert.equal(edited.body.state, 'confirmed'); assert.equal(edited.body.effect?.outcome, 'applied');
        const after = await post<DocumentReadPageV1>('/api/documents/read', { apiVersion: 1, workspaceId: selected.workspaceId,
          documentId: original.documentAtImport.documentId, format: 'markdown' });
        assert.equal(after.body.fragment, 'After original through real HTTP.\n'); assert.notEqual(after.body.document.version, read.body.document.version);
        const historical = await post<MarkdownOriginalImportResultV1>(statusRoute, statusSelection); assert.equal(historical.status, 200);
        assert(historical.body.status === 'confirmed'); assert.deepEqual(historical.body.documentAtImport, original.documentAtImport);
        assert.deepEqual(historical.body.source, original.source);
        const retry = await post<MarkdownOriginalImportResultV1>(importRoute, selected); assert.equal(retry.status, 200);
        assert(retry.body.status === 'confirmed'); assert.equal(retry.body.outcome, 'already_imported');
        assert.deepEqual(await stored(), before);
      });
      await check('actual rotation retains caller operation and original credential; changed selections return bounded 409', async () => {
        const before = await stored();
        const next = await rotateApiKey(headers, issued.integration.id, { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
        key = next.key; credentialId = next.credential.id;
        const result = await post<MarkdownOriginalImportResultV1>(importRoute, selected); assert.equal(result.status, 200);
        assert(result.body.status === 'confirmed'); assert.equal(result.body.operationId, selected.operationId);
        assert.deepEqual(result.body.documentAtImport, original.documentAtImport); assert.deepEqual(await stored(), before);
        await failure(importRoute, { ...selected, path: 'different-original.md' }, 409, 'MARKDOWN_IMPORT_REQUEST_CONFLICT');
        await failure(importRoute, { ...selected, expectedFileVersion: selected.expectedFileVersion + '1' }, 409, 'MARKDOWN_IMPORT_REQUEST_CONFLICT');
      });
      await check('Import-only retry and exact Status grants remain distinct at the HTTP boundary', async () => {
        await updateApiIntegration(headers, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
          workspaceIds: [selected.workspaceId], actions: ['import'] });
        assert.equal((await post(importRoute, selected)).status, 200);
        await failure(statusRoute, statusSelection, 403, 'API_KEY_ACCESS_DENIED');
        await updateApiIntegration(headers, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
          workspaceIds: [selected.workspaceId], actions });
        const missing = await post<MarkdownOriginalImportResultV1>(statusRoute, { ...statusSelection, operationId: 'unknown_original_http_operation' });
        assert.equal(missing.status, 200); assert.deepEqual(missing.body, { apiVersion: 1, operationId: 'unknown_original_http_operation', status: 'not_found', requiresFreshFileActionPreview: true });
      });
      await check('invalid and mixed credentials cannot fall back to an existing real Session', async () => {
        const cookie = (await h.request(h.source, 'owner', true)).headers.get('cookie'); assert(cookie);
        await failure(importRoute, selected, 401, 'API_KEY_CREDENTIALS_CONFLICT', { cookie });
        await failure(statusRoute, statusSelection, 401, 'API_KEY_CREDENTIALS_CONFLICT', { Authorization: headers.get('Authorization')! });
        await failure(importRoute, selected, 401, 'API_KEY_INVALID', { 'X-Canvas-API-Key': 'invalid-key' });
        await failure(statusRoute, statusSelection, 401, 'API_KEY_INVALID', { 'X-Canvas-API-Key': '' });
      });
      await check('strict body shape, physical version, UTF-8 and bounded stream reject before native writes', async () => {
        const before = await stored();
        await failure(importRoute, { ...selected, origin: { userId: 'owner' } }, 400, 'MARKDOWN_IMPORT_INVALID_INPUT');
        await failure(importRoute, { ...selected, expectedFileVersion: undefined }, 400, 'MARKDOWN_IMPORT_INVALID_INPUT');
        await failure(statusRoute, { ...statusSelection, receipt: original }, 400, 'MARKDOWN_IMPORT_INVALID_INPUT');
        await failure(importRoute, null, 400, 'MARKDOWN_IMPORT_INVALID_INPUT', {}, Buffer.from([123, 255, 125]));
        await failure(importRoute, null, 400, 'MARKDOWN_IMPORT_INVALID_INPUT', {}, Buffer.from(' '.repeat(32769)));
        assert.deepEqual(await stored(), before);
      });
      await check('a real lost HTTP response retains one native import and permits explicit Status/retry', async () => {
        const next = await source('key-rest-ack.md', 'Persist once despite a lost HTTP response.\n');
        const before = importCalls; dropNext = true;
        await assert.rejects(post(importRoute, next), TypeError); assert.equal(dropNext, false); assert.equal(importCalls, before + 1);
        const confirmed = await post<MarkdownOriginalImportResultV1>(statusRoute, { apiVersion: 1, workspaceId: next.workspaceId, operationId: next.operationId });
        assert.equal(confirmed.status, 200); assert(confirmed.body.status === 'confirmed');
        const retry = await post<MarkdownOriginalImportResultV1>(importRoute, next); assert.equal(retry.status, 200);
        assert(retry.body.status === 'confirmed'); assert.deepEqual(retry.body.documentAtImport, confirmed.body.documentAtImport);
        assert.equal((await h.admin.query(`SELECT count(*)::int AS n FROM collaboration_original_markdown_import_api_keys
          WHERE workspace_id=$1 AND original_text::jsonb->>'callerOperationId'=$2`, [next.workspaceId, next.operationId])).rows[0].n, 1);
      });
      await check('actual revocation returns a bounded 401 and cannot rewrite the imported native receipt', async () => {
        const before = await stored(); await revokeApiKey(headers, issued.integration.id, { expectedRevision: revision++, credentialId });
        await failure(statusRoute, statusSelection, 401, 'API_KEY_INVALID'); await failure(importRoute, selected, 401, 'API_KEY_INVALID');
        assert.deepEqual(await stored(), before);
      });
      assert.ifError(serverFailure);
    });
    console.log(JSON.stringify({ suite: 'api-key-original-import-http', groups, actualTcpRequests: calls, importHandlerCalls: importCalls,
      genuineKeys: true, actualPostgres: true, actualNativeEdit: true, compiledNextOrBrowser: false }));
  });
  complete = true;
}
main().catch(error => { console.error(JSON.stringify({ suite: 'api-key-original-import-http', passed: false, stage,
  name: error?.name, code: error?.code, message: error?.message, stack: error?.stack })); process.exitCode = 1; });

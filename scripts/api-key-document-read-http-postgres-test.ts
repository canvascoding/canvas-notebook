import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DocumentReadPageV1 } from '../app/lib/documents/contracts';
import type { DocumentSearchPageV1 } from '../app/lib/documents/search-contract';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

let stage = 'setup', cases = 0;
async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { NextRequest } = await import('next/server');
    const { POST: readRoute } = await import('../app/api/documents/read/route');
    const { POST: searchRoute } = await import('../app/api/documents/search/route');
    const management = await import('../app/lib/api-keys/management');
    const session = (await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0];
    const sessionHeaders = new Headers({ Authorization: `Bearer ${session.token}`, Origin: 'http://localhost' });
    const issue = () => management.createApiIntegration(sessionHeaders, { requestId: randomUUID(), name: 'Read API HTTP acceptance',
      workspaceIds: [fixture.workspaceId], actions: ['read'], expiresAt: Date.now() + 3_600_000 });
    const first = await issue(), other = await issue();
    let key = first.key;
    const body = 'Nativeneedle: Äpfel 😀 日本語; vollständig.';
    const document = await fixture.seed({ representation: 'plain_text', text: body, filePath: 'reads/native.payload' });
    for (let index = 0; index < 10; index++) await fixture.seed({ representation: 'plain_text', text: `Windowneedle ${index}`,
      filePath: `windows/${String(index).padStart(2, '0')}.md` });
    const baseline = await fixture.snapshot();
    const request = async (route: 'read' | 'search', input: unknown, selected: string | null = key, extra: Record<string, string> = {}) => {
      const response = await (route === 'read' ? readRoute : searchRoute)(new NextRequest(`http://localhost/api/documents/${route}`,
        { method: 'POST', headers: { 'content-type': 'application/json', ...(selected === null ? {} : { 'X-Canvas-API-Key': selected }), ...extra },
          body: JSON.stringify(input) }));
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const readInput = (extra: Record<string, unknown> = {}) => ({ apiVersion: 1, workspaceId: fixture.workspaceId,
      documentId: document.documentId, format: 'text', maxBytes: 16, ...extra });
    const searchInput = (extra: Record<string, unknown> = {}) => ({ apiVersion: 1, workspaceId: fixture.workspaceId,
      query: 'Windowneedle', scopePath: 'windows', ...extra });
    const failure = async (route: 'read' | 'search', input: unknown, status: number, code: string,
      selected = key, extra: Record<string, string> = {}) => {
      const result = await request(route, input, selected, extra); assert.equal(result.status, status);
      assert.deepEqual(result.body, { apiVersion: 1, success: false, code });
      if (selected) assert(!JSON.stringify(result.body).includes(selected)); return result;
    };
    const check = async (name: string, operation: () => Promise<void>) => {
      stage = name; await operation(); cases++; console.log(`API-key document read HTTP passed: ${name}`);
    };
    let firstPage: DocumentReadPageV1;
    await check('actual issued key reads native ID and full version through real route/core/auth', async () => {
      const result = await request('read', readInput()); assert.equal(result.status, 200); firstPage = result.body;
      assert.equal(firstPage.document.documentId, document.documentId); assert.equal(firstPage.document.lineageId, document.lineageId);
      assert.equal(firstPage.document.workspaceId, fixture.workspaceId); assert.equal(firstPage.document.path, document.filePath);
      assert(firstPage.document.version && firstPage.nextCursor); assert.equal(firstPage.complete, false);
      assert.equal(firstPage.currency.source, 'persisted_yjs'); assert.equal(firstPage.currency.observedVersion, firstPage.document.version);
    });
    await check('rotation preserves same-integration cursor; another integration cannot borrow it', async () => {
      await failure('read', readInput({ cursor: firstPage.nextCursor }), 409, 'DOCUMENT_SCOPE_CHANGED', other.key);
      const rotated = await management.rotateApiKey(sessionHeaders, first.integration.id,
        { requestId: randomUUID(), expectedRevision: 1, expiresAt: Date.now() + 3_600_000 });
      await failure('read', readInput(), 401, 'API_KEY_INVALID', key); key = rotated.key;
      let cursor = firstPage.nextCursor, joined = firstPage.fragment, offset = firstPage.byteLength;
      for (let index = 0; index < 30 && cursor; index++) {
        const result = await request('read', readInput({ cursor, expectedVersion: firstPage.document.version }));
        assert.equal(result.status, 200); const page: DocumentReadPageV1 = result.body;
        assert.equal(page.byteOffset, offset); assert.equal(page.document.version, firstPage.document.version);
        joined += page.fragment; offset += page.byteLength; cursor = page.nextCursor;
        assert.equal(page.complete, cursor === null);
      }
      assert.equal(cursor, null); assert.equal(joined, body); assert.equal(offset, Buffer.byteLength(body));
    });
    await check('progressive search returns every stable native identity and version', async () => {
      const seen = new Set<string>(); let cursor: string | null | undefined;
      for (let index = 0; index < 20; index++) {
        const result = await request('search', searchInput({ limit: 3, ...(cursor ? { cursor } : {}) }));
        assert.equal(result.status, 200); const page: DocumentSearchPageV1 = result.body;
        for (const hit of page.hits) { assert(!seen.has(hit.document.documentId)); seen.add(hit.document.documentId);
          assert.equal(hit.document.workspaceId, fixture.workspaceId); assert.equal(hit.document.version, hit.currency.observedVersion); }
        cursor = page.nextCursor; if (cursor === null) break;
      }
      assert.equal(cursor, null); assert.equal(seen.size, 10);
    });
    await check('malformed and mixed credentials fail without fallback to valid session', async () => {
      for (const route of ['read', 'search'] as const) {
        const input = route === 'read' ? readInput() : searchInput();
        for (const invalid of ['', 'invalid', `${key},${key}`]) await failure(route, input, 401, 'API_KEY_INVALID', invalid);
        await failure(route, input, 401, 'API_KEY_CREDENTIALS_CONFLICT', key, { Authorization: `Bearer ${session.token}` });
        await failure(route, input, 401, 'API_KEY_CREDENTIALS_CONFLICT', key, { Cookie: 'better-auth.session_token=present' });
      }
      const sessionResult = await request('read', readInput({ maxBytes: 65536 }), null, { Authorization: `Bearer ${session.token}` });
      assert.equal(sessionResult.status, 200); assert.equal(sessionResult.body.fragment, body);
    });
    await check('current seat, grant and workspace restrictions return sanitized 403', async () => {
      await fixture.admin.query("UPDATE team_memberships SET status='suspended' WHERE user_id='reader'");
      try { await failure('read', readInput(), 403, 'ACCESS_DENIED'); }
      finally { await fixture.admin.query("UPDATE team_memberships SET status='active' WHERE user_id='reader'"); }
      await management.updateApiIntegration(sessionHeaders, first.integration.id, { expectedRevision: 2, name: first.integration.name,
        workspaceIds: [fixture.workspaceId], actions: ['status'] });
      await failure('read', readInput(), 403, 'API_KEY_ACCESS_DENIED');
      await failure('search', searchInput(), 403, 'API_KEY_ACCESS_DENIED');
      await management.updateApiIntegration(sessionHeaders, first.integration.id, { expectedRevision: 3, name: first.integration.name,
        workspaceIds: [fixture.workspaceId], actions: ['read'] });
      await failure('read', readInput({ workspaceId: 'different-workspace' }), 403, 'API_KEY_ACCESS_DENIED');
    });
    await check('shared key budget produces bounded 429 and revocation produces 401', async () => {
      const current = await management.listApiIntegrationCredentials(sessionHeaders, first.integration.id);
      const credentialId = current.credentials.find(entry => !entry.revokedAt)!.id;
      const bucket = `document-api-key:key:${credentialId}`;
      await fixture.admin.query('UPDATE security_public_rate_limits SET count=240,reset_at=$2 WHERE bucket_key=$1', [bucket, Date.now() + 60_000]);
      const limited = await failure('read', readInput(), 429, 'API_KEY_RATE_LIMITED');
      assert(Number(limited.headers.get('retry-after')) >= 1 && Number(limited.headers.get('retry-after')) <= 60);
      await fixture.admin.query('UPDATE security_public_rate_limits SET count=0 WHERE bucket_key=$1', [bucket]);
      await management.revokeApiKey(sessionHeaders, first.integration.id, { expectedRevision: 4, credentialId });
      await failure('read', readInput(), 401, 'API_KEY_INVALID'); await failure('search', searchInput(), 401, 'API_KEY_INVALID');
      await management.revokeApiKey(sessionHeaders, other.integration.id, { expectedRevision: 1, credentialId: other.credential.id });
    });
    assert.deepEqual(await fixture.snapshot(), baseline, 'Read/search authorization must preserve original documents and Yjs rows.');
  });
  console.log(`API-key document read HTTP/PostgreSQL: ${cases} groups passed. Compiled TCP/SDK acceptance remains separate.`);
}
main().catch(error => {
  const message = error instanceof Error ? error.message.split('\n')[0].replace(/cnk_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/gu, '[redacted-api-key]') : 'Unknown failure';
  console.error(`API-key document read HTTP failed (${stage}): ${message}`); process.exitCode = 1;
});

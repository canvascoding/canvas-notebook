import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

let stage = 'setup', cases = 0;
async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { NextRequest } = await import('next/server');
    const quick = await import('../app/api/files/quick-access/route');
    const marp = await import('../app/api/files/marp-detect/route');
    const operations = await import('../app/api/files/collaboration/operations/route');
    const { readFileVisits } = await import('../app/lib/files/file-visit-storage');
    const content = '---\nmarp: true\n---\n\n# Auxiliary route acceptance\n';
    const document = await fixture.seed({ filePath: 'slides.md', text: content });
    const physical = path.join(fixture.workspaceRoot, document.filePath);
    await writeFile(physical, content, { mode: 0o600, flag: 'wx' });
    const baseline = await fixture.snapshot();
    let token = String((await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0].token);
    const request = (endpoint: string, options: {
      method?: string; body?: unknown; workspaceId?: string | null; authenticated?: boolean;
    } = {}) => new NextRequest(`http://localhost${endpoint}`, {
      method: options.method ?? 'GET',
      headers: { ...(options.authenticated === false ? {} : { authorization: `Bearer ${token}` }),
        ...(options.workspaceId === null ? {} : { 'x-canvas-workspace-id': options.workspaceId ?? fixture.workspaceId }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const endpoints = [
      { name: 'Marp detection', budget: 10, run: (options = {}) => marp.GET(request('/api/files/marp-detect?path=slides.md', options)) },
      { name: 'Agent operations', budget: 11, run: (options = {}) => operations.GET(request(
        `/api/files/collaboration/operations?documentId=${encodeURIComponent(document.documentId)}`, options)) },
      { name: 'personal file visit', budget: 10, run: (options = {}) => quick.POST(request('/api/files/quick-access',
        { ...options, method: 'POST', body: { path: document.filePath } })) },
    ];
    const allEndpoints = [...endpoints,
      { name: 'personal recent files', run: (options = {}) => quick.GET(request('/api/files/quick-access?view=recent', options)) }];
    const check = async (name: string, operation: () => Promise<void>) => {
      stage = name; await operation(); cases++; console.log(`File-open auxiliary HTTP passed: ${name}`);
    };
    const measured = async (run: () => Promise<Response>) => {
      const sql: string[] = [], original = Client.prototype.query;
      Client.prototype.query = function (this: Client, ...args: Parameters<typeof original>) {
        const first: unknown = args[0];
        sql.push(typeof first === 'string' ? first : String((first as { text?: string })?.text ?? ''));
        return Reflect.apply(original, this, args);
      } as typeof original;
      try { return { response: await run(), sql }; }
      finally { Client.prototype.query = original; }
    };
    await check('selected read-only user retains all three functions without workspace bootstrap queries', async () => {
      assert.equal((await endpoints[0].run()).status, 200, 'Initialize ordinary auth before measuring warm document switches');
      for (const endpoint of endpoints) {
        const { response, sql } = await measured(() => endpoint.run());
        assert.equal(response.status, 200, endpoint.name);
        const payload = await response.json(); assert.equal(payload.success, true);
        if (endpoint.name === 'Marp detection') assert.equal(payload.isMarp, true);
        if (endpoint.name === 'Agent operations') assert.deepEqual(payload.operations, []);
        console.log(`File-open auxiliary SQL families: ${endpoint.name}; ${JSON.stringify(sql.map(query => ({
          command: query.trim().match(/^\w+/u)?.[0],
          tables: [...query.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+"?([a-z_][a-z0-9_]*)/giu)].map(match => match[1]),
        })))}`);
        // This source fixture includes nine genuine session/license/seat/JWK
        // queries, one workspace snapshot, and one optional operations query.
        assert(sql.length > 0 && sql.length <= endpoint.budget,
          `${endpoint.name} used ${sql.length} SQL statements; budget is ${endpoint.budget}`);
        assert(!sql.some(query => /^(?:BEGIN|COMMIT|ROLLBACK)\b/iu.test(query.trim())),
          `${endpoint.name} must not run workspace bootstrap transactions`);
        console.log(`File-open auxiliary SQL: ${endpoint.name}; statements=${sql.length}`);
      }
      assert((await readFileVisits('reader', fixture.workspaceId)).some(visit => visit.path === document.filePath));
      const recent = await allEndpoints.at(-1)!.run(); assert.equal(recent.status, 200);
      assert((await recent.json()).data.files.some((file: { path: string }) => file.path === document.filePath));
      assert.deepEqual(await fixture.snapshot(), baseline, 'Auxiliary reads/visits cannot change native document rows or xmin');
    });
    await check('missing session and foreign workspace cannot inspect or record files', async () => {
      for (const endpoint of allEndpoints) {
        assert.equal((await endpoint.run({ authenticated: false })).status, 401, endpoint.name);
        assert.equal((await endpoint.run({ workspaceId: 'foreign-selection' })).status, 404, endpoint.name);
      }
    });
    const denied = async (freshSessionPerEndpoint = false) => {
      for (const endpoint of allEndpoints) {
        if (freshSessionPerEndpoint) {
          await fixture.restoreReaderSession();
          token = String((await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0].token);
        }
        const response = await endpoint.run();
        assert([401, 403, 404].includes(response.status), `${endpoint.name} did not deny revoked access: ${response.status}`);
      }
    };
    await check('current account ban, seat suspension and workspace archive are rechecked after successful reads', async () => {
      for (const [revoke, restore] of [
        ["UPDATE \"user\" SET banned=1 WHERE id='reader'", "UPDATE \"user\" SET banned=0 WHERE id='reader'"],
        ["UPDATE team_memberships SET status='suspended' WHERE user_id='reader'", "UPDATE team_memberships SET status='active' WHERE user_id='reader'"],
        ["UPDATE canvas_workspaces SET status='archived' WHERE id=$1", "UPDATE canvas_workspaces SET status='active' WHERE id=$1"],
      ]) {
        const args = revoke.includes('$1') ? [fixture.workspaceId] : [];
        await fixture.admin.query(revoke, args);
        try { await denied(true); } finally { await fixture.admin.query(restore, args); }
        // Real auth can retire a banned/suspended user's existing session.
        // Restoring access does not manufacture authority for its old token.
        await fixture.restoreReaderSession();
        token = String((await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0].token);
        assert.equal((await endpoints[0].run()).status, 200);
      }
      assert.deepEqual(await fixture.snapshot(), baseline);
    });
    await check('revoked real session stays denied and a fresh session restores access', async () => {
      await fixture.admin.query("DELETE FROM session WHERE id='reader-session'");
      await denied(); await fixture.restoreReaderSession();
      assert.equal((await endpoints[0].run()).status, 401, 'An old token cannot borrow the new session');
      token = String((await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0].token);
      assert.equal((await endpoints[0].run()).status, 200);
    });
    await check('selected, default and legacy workspace contexts retain the existing resolver contract', async () => {
      const { requireRequestWorkspace, requireReadRequestWorkspace } = await import('../app/lib/workspaces/request');
      const { LEGACY_PERSONAL_WORKSPACE_ID } = await import('../app/lib/workspaces/context');
      for (const selection of [fixture.workspaceId, null, LEGACY_PERSONAL_WORKSPACE_ID]) {
        const expected = await requireRequestWorkspace(request('/api/files/quick-access', { workspaceId: selection }),
          { permissions: 'canRead' });
        const actual = await requireReadRequestWorkspace(request('/api/files/quick-access', { workspaceId: selection }));
        if (expected.response) {
          assert.equal(actual.response?.status, expected.response.status);
          assert.deepEqual(await actual.response!.json(), await expected.response.json());
        } else {
          assert.equal(actual.response, null);
          assert.deepEqual(actual.workspace, expected.workspace);
        }
      }
      const queryPath = `/api/files/marp-detect?path=slides.md&workspaceId=${encodeURIComponent(fixture.workspaceId)}`;
      assert.equal((await marp.GET(request(queryPath, { workspaceId: null }))).status, 200);
      assert.equal((await marp.GET(request(queryPath, { workspaceId: 'foreign-selection' }))).status, 404,
        'An explicit header takes precedence over a valid query selection');
    });
  });
  console.log(`File-open auxiliary HTTP: ${cases} groups passed with genuine authentication and PostgreSQL`);
}
main().catch(error => {
  console.error(`File-open auxiliary HTTP failed at ${stage}: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});

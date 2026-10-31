import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { ApiKeyCredential } from '../app/lib/api-keys/authentication';
import type { ApiKeyDocumentReadOrigin, ApiKeyDocumentReadPrincipal } from '../app/lib/api-keys/document-read-principal';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

let stage = 'setup', cases = 0;
async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const pool = getPostgresRuntimeQueryable() as unknown as Pool; assert(pool);
    const { createApiIntegration, updateApiIntegration } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyDocumentReadPrincipal: capture, withApiKeyDocumentReadPrincipalOnConnection: phase } =
      await import('../app/lib/api-keys/document-read-principal');
    const session = (await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0];
    // This is the fixture's real Better Auth session token; management resolves
    // it through auth.api.getSession and rereads current session/account policy.
    const headers = new Headers({ Authorization: `Bearer ${session.token}`, Origin: 'http://localhost' });
    const issued = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Document read authority',
      workspaceIds: [fixture.workspaceId], actions: ['read'], expiresAt: Date.now() + 3_600_000 });
    const credential = await authenticateApiKeyRequest(new Request('http://localhost/api/documents/read',
      { headers: { 'X-Canvas-API-Key': issued.key } }));
    await fixture.seed(); const before = await fixture.snapshot();
    const connection = (client: PoolClient): SqlConnection => ({
      get: async (sql, values) => (await client.query(sql, values)).rows[0],
      all: async (sql, values) => (await client.query(sql, values)).rows,
      run: async (sql, values) => ({ changes: (await client.query(sql, values)).rowCount ?? 0 }),
      close: () => { throw new Error('A principal must not close the borrowed connection.'); },
    });
    const transaction = async <T>(consume: (database: SqlConnection, client: PoolClient) => Promise<T>,
      begin = 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE') => {
      const client = await pool.connect();
      try {
        if (begin) await client.query(begin);
        const result = await consume(connection(client), client);
        await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    };
    const code = (...wanted: string[]) => (error: unknown) => {
      const actual = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
      assert(wanted.includes(String(actual)), `Expected ${wanted.join('/')}, received ${String(actual)}`); return true;
    };
    const origins: ApiKeyDocumentReadOrigin[] = [];
    type Access = Parameters<Parameters<typeof phase>[2]>[0];
    const read = <T>(consume: (access: Access, client: PoolClient) => Promise<T>, actual: ApiKeyCredential = credential) =>
      capture(actual, { workspaceId: fixture.workspaceId, purpose: 'read' }, origin => { origins.push(origin); },
        principal => transaction((database, client) => phase(database, principal, access => consume(access, client))));
    const check = async (name: string, consume: () => Promise<void>) => {
      stage = name; await consume(); cases++; console.log(`API-key document read principal passed: ${name}`);
    };
    await check('real issued credential, current account/seat/workspace and same held backend/xid', async () => {
      await read(async (access, client) => {
        assert.equal(access.userId, 'reader'); assert.equal(access.integrationId, issued.integration.id);
        assert.equal(access.workspace.workspaceId, fixture.workspaceId);
        assert.equal(access.workspace.permissions.canRead, true); assert.equal(access.workspace.permissions.canWrite, false);
        assert.equal(access.workspace.permissions.canDelete, false);
        const before = (await client.query('SELECT pg_backend_pid() AS backend,pg_current_xact_id()::text AS xid')).rows[0];
        await access.assertCurrent();
        assert.deepEqual((await client.query('SELECT pg_backend_pid() AS backend,pg_current_xact_id()::text AS xid')).rows[0], before);
      });
      assert(origins.length >= 3); assert.equal(origins[0].kind, 'api_key');
      assert.equal(origins[0].integrationId, issued.integration.id); assert.equal(origins[0].credentialId, issued.credential.id);
      for (const origin of origins) assert.deepEqual(origin, origins[0]);
      assert(!JSON.stringify(origins).includes(issued.key));
    });
    await check('current write permission cannot enlarge a read principal', async () => {
      await fixture.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'");
      try { await read(async access => {
        assert.equal(access.workspace.permissions.canWrite, false); assert.equal(access.workspace.permissions.canDelete, false);
        assert.equal(access.workspace.permissions.canRunAgent, false); assert.equal(access.workspace.permissions.canManageWorkspace, false);
      }); } finally { await fixture.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='reader'"); }
    });
    await check('fake/copied/detached principal and credential do not authorize a consumer', async () => {
      let stale: ApiKeyDocumentReadPrincipal | undefined;
      await capture(credential, { workspaceId: fixture.workspaceId, purpose: 'read' }, () => undefined, async principal => { stale = principal; });
      for (const fake of [{}, JSON.parse(JSON.stringify(stale)), stale]) {
        await assert.rejects(transaction(database => phase(database, fake as ApiKeyDocumentReadPrincipal, async () => assert.fail('Unauthorized consumer'))),
          code('API_KEY_PRINCIPAL_REQUIRED'));
      }
      await assert.rejects(read(async () => assert.fail('Fake credential'), {} as ApiKeyCredential), code('API_KEY_INVALID'));
    });
    await check('fresh action grant, workspace allowlist, account and seat are required', async () => {
      await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 1, name: issued.integration.name,
        workspaceIds: [fixture.workspaceId], actions: ['status'] });
      await assert.rejects(read(async () => assert.fail('Read grant removed')), code('API_KEY_ACCESS_DENIED'));
      await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 2, name: issued.integration.name,
        workspaceIds: [fixture.workspaceId], actions: ['read'] });
      for (const [alter, restore, codes] of [
        ["UPDATE team_memberships SET status='suspended' WHERE user_id='reader'", "UPDATE team_memberships SET status='active' WHERE user_id='reader'", ['SEAT_MEMBERSHIP_REQUIRED']],
        ["UPDATE \"user\" SET banned=1 WHERE id='reader'", "UPDATE \"user\" SET banned=0 WHERE id='reader'", ['API_KEY_ACCOUNT_INACTIVE']],
        ["UPDATE canvas_workspaces SET status='archived'", "UPDATE canvas_workspaces SET status='active'", ['API_KEY_ACCESS_DENIED']],
      ] as const) {
        await fixture.admin.query(alter);
        try { await assert.rejects(read(async () => assert.fail('Current rights denied')), code(...codes)); }
        finally { await fixture.admin.query(restore); }
      }
      await fixture.admin.query('UPDATE canvas_api_integrations SET workspace_ids_json=$2 WHERE id=$1', [issued.integration.id, JSON.stringify(['different-workspace'])]);
      try { await assert.rejects(read(async () => assert.fail('Outside allowlist')), code('API_KEY_ACCESS_DENIED')); }
      finally { await fixture.admin.query('UPDATE canvas_api_integrations SET workspace_ids_json=$2 WHERE id=$1', [issued.integration.id, JSON.stringify([fixture.workspaceId])]); }
    });
    await check('reentrancy remains fatal even if the inner rejection is caught', async () => {
      await assert.rejects(capture(credential, { workspaceId: fixture.workspaceId, purpose: 'read' }, () => undefined,
        principal => transaction(database => phase(database, principal, async () => {
          await assert.rejects(phase(database, principal, async () => assert.fail('Reentrant consumer')), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
        }))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
    });
    await check('actual replacement transaction, read-only transaction and missing BEGIN fail closed', async () => {
      await assert.rejects(read(async (access, client) => {
        await client.query('COMMIT'); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        await access.assertCurrent();
      }), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      for (const begin of ['BEGIN READ ONLY', '']) {
        await assert.rejects(capture(credential, { workspaceId: fixture.workspaceId, purpose: 'read' }, () => undefined,
          principal => transaction(database => phase(database, principal, async () => assert.fail('Invalid actual transaction')), begin)),
        code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      }
    });
    await check('logout leaves programmatic access valid; real revocation waits for held phase then blocks the next phase', async () => {
      await fixture.admin.query("DELETE FROM session WHERE id='reader-session'");
      let writer: PoolClient | undefined, write: Promise<unknown> | undefined;
      try {
        await read(async access => {
          writer = await pool.connect();
          await writer.query("SET lock_timeout='3s'"); const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          write = writer.query('UPDATE canvas_api_keys SET revoked_at=$2 WHERE id=$1', [issued.credential.id, Date.now()]);
          void write.catch(() => undefined);
          let blocked = false;
          for (let attempt = 0; attempt < 60; attempt++) {
            const row = (await fixture.admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
            if (row?.wait_event_type === 'Lock') { blocked = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert(blocked, 'The independent revocation must wait on the actual held credential row.');
          await access.assertCurrent();
        });
        await write;
      } finally {
        if (write) await write.catch(() => undefined);
        if (writer) { await writer.query('RESET lock_timeout'); writer.release(); }
      }
      await assert.rejects(read(async () => assert.fail('Revoked key')), code('API_KEY_INVALID'));
    });
    stage = 'unchanged original document storage';
    assert.deepEqual(await fixture.snapshot(), before, 'Principal checks must not mutate documents, Yjs, versions or projections.');
  });
  console.log(`API-key document read principal PostgreSQL: ${cases} cases passed. Public HTTP/MCP/SDK acceptance remains separate.`);
}
main().catch(error => {
  const message = error instanceof Error ? error.message.split('\n')[0].replace(/cnk_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/gu, '[redacted-api-key]') : 'Unknown failure';
  console.error(`API-key document read principal failed (${stage}): ${message}`); process.exitCode = 1;
});

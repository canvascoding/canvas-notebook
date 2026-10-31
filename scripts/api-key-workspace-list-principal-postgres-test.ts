import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { ApiKeyDocumentReadPrincipal, ApiKeyWorkspaceListPrincipal } from '../app/lib/api-keys/document-read-principal';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

let stage = 'setup', cases = 0;
async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { createApiIntegration } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyWorkspaceListPrincipal: capture, withApiKeyWorkspaceListPrincipalOnConnection: phase,
      withApiKeyDocumentReadPrincipalOnConnection: readPhase } = await import('../app/lib/api-keys/document-read-principal');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const session = (await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0];
    const issued = await createApiIntegration(new Headers({ Authorization: `Bearer ${session.token}`, Origin: 'http://localhost' }),
      { requestId: randomUUID(), name: 'Workspace set authority', workspaceIds: [fixture.workspaceId], expiresAt: Date.now() + 3_600_000 });
    const credential = await authenticateApiKeyRequest(new Request('http://localhost/mcp', { headers: { 'X-Canvas-API-Key': issued.key } }));
    await fixture.seed(); const before = await fixture.snapshot();
    const queries: string[] = [];
    const transaction = async <T>(consume: (database: SqlConnection, client: PoolClient) => Promise<T>) => {
      const client = await (getPostgresRuntimeQueryable() as unknown as Pool).connect();
      const query = (sql: string, values?: unknown[]) => { queries.push(sql); return client.query(sql, values); };
      const database: SqlConnection = { get: async (sql, values) => (await query(sql, values)).rows[0],
        all: async (sql, values) => (await query(sql, values)).rows,
        run: async (sql, values) => ({ changes: (await query(sql, values)).rowCount ?? 0 }),
        close: () => { throw new Error('The actual owner must dispose its connection.'); } };
      try { await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); const result = await consume(database, client);
        await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    const code = (wanted: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === wanted);
    const list = () => capture(credential, 'request', principal => transaction(database => phase(database, principal, async access => {
      assert.equal(access.userId, 'reader'); assert.equal(access.integrationId, issued.integration.id);
      await access.assertCurrent(); return access.workspaces;
    })));
    const check = async (name: string, operation: () => Promise<void>) => { stage = name; await operation(); cases++;
      console.log(`API-key workspace-list principal passed: ${name}`); };
    await check('one actual current workspace uses one joint statement per observation', async () => {
      queries.length = 0; const workspaces = await list(); assert.deepEqual(workspaces.map(workspace => workspace.workspaceId), [fixture.workspaceId]);
      assert.equal(queries.filter(sql => sql.includes('workspaces.snapshots AS workspaces')).length, 3);
      assert.equal(queries.length, 8, 'Phase only: three timeouts, one policy lock, one credential row lock, three fresh observations.');
    });
    const ids = [fixture.workspaceId];
    await check('100 explicit workspace selectors keep the same actual-B SQL count and ordinary policies', async () => {
      // Arrange a bounded policy dataset in this owned schema. This is not
      // acceptance of creating 100 workspaces through the public UI/API.
      for (let index = 0; index < 99; index++) {
        const id = `set-workspace-${String(index).padStart(3, '0')}`; ids.push(id);
        await fixture.admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,display_name,root_relative_path,status,created_at,updated_at)
          VALUES($1,'tool-dispatch-org','personal','reader',$1,$2,'active',100,100)`, [id, `users/reader/workspaces/${id}`]);
      }
      await fixture.admin.query('UPDATE canvas_api_integrations SET workspace_ids_json=$2 WHERE id=$1', [issued.integration.id, JSON.stringify(ids)]);
      queries.length = 0; const workspaces = await list(); assert.equal(workspaces.length, 100);
      assert.deepEqual(new Set(workspaces.map(workspace => workspace.workspaceId)), new Set(ids));
      assert.equal(queries.length, 8); assert.equal(queries.filter(sql => sql.includes('workspaces.snapshots AS workspaces')).length, 3);
      for (const workspace of workspaces) { assert(Object.isFrozen(workspace)); assert.equal(workspace.permissions.canRead, true);
        assert.equal(workspace.permissions.canWrite, false); assert.equal(workspace.permissions.canDelete, false); }
    });
    await check('current removed access and archived workspaces are omitted; removed read action denies the entire list', async () => {
      await fixture.admin.query("UPDATE canvas_workspaces SET owner_user_id='owner' WHERE id=$1", [ids[1]]);
      await fixture.admin.query("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [ids[2]]);
      const workspaces = await list(); assert.equal(workspaces.length, 98);
      assert(!workspaces.some(workspace => [ids[1], ids[2]].includes(workspace.workspaceId)));
      await fixture.admin.query('UPDATE canvas_api_integrations SET actions_json=$2 WHERE id=$1', [issued.integration.id, JSON.stringify(['status'])]);
      try { await assert.rejects(list(), code('API_KEY_ACCESS_DENIED')); }
      finally { await fixture.admin.query('UPDATE canvas_api_integrations SET actions_json=$2 WHERE id=$1', [issued.integration.id, JSON.stringify(['read'])]); }
    });
    await check('fixed list family cannot be promoted to a document principal and remains poison-on-caught-rejection', async () => {
      await assert.rejects(capture(credential, 'request', principal => transaction(async database => {
        await assert.rejects(readPhase(database, principal as unknown as ApiKeyDocumentReadPrincipal, async () => assert.fail('Wrong family')),
          code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      })), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      let stale: ApiKeyWorkspaceListPrincipal | undefined;
      await capture(credential, 'request', async principal => { stale = principal; });
      await assert.rejects(transaction(database => phase(database, stale!, async () => assert.fail('Detached list consumer'))), code('API_KEY_PRINCIPAL_REQUIRED'));
      await assert.rejects(transaction(database => phase(database, {} as ApiKeyWorkspaceListPrincipal, async () => assert.fail('Fake list consumer'))), code('API_KEY_PRINCIPAL_REQUIRED'));
    });
    assert.deepEqual(await fixture.snapshot(), before);
  });
  console.log(`API-key workspace-list principal: ${cases} PostgreSQL groups passed. Counts cover only the held principal phase, not full HTTP performance.`);
}
main().catch(error => {
  const message = error instanceof Error ? error.message.split('\n')[0].replace(/cnk_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/gu, '[redacted-api-key]') : 'Unknown failure';
  console.error(`API-key workspace-list principal failed (${stage}): ${message}`); process.exitCode = 1;
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { ApiKeyDocumentReadPrincipal, ApiKeyWorkspaceBrowsePrincipal, ApiKeyWorkspaceBrowsePurpose } from '../app/lib/api-keys/document-read-principal';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

let stage = 'setup', cases = 0;
async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { createApiIntegration } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyWorkspaceBrowsePrincipal: capture, withApiKeyWorkspaceBrowsePrincipalOnConnection: phase,
      withApiKeyWorkspaceListPrincipal: listCapture, withApiKeyDocumentReadPrincipalOnConnection: readPhase } =
      await import('../app/lib/api-keys/document-read-principal');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const session = (await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0];
    const issued = await createApiIntegration(new Headers({ Authorization: `Bearer ${session.token}`, Origin: 'http://localhost' }),
      { requestId: randomUUID(), name: 'Fixed browse authority', workspaceIds: [fixture.workspaceId], expiresAt: Date.now() + 3_600_000 });
    const credential = await authenticateApiKeyRequest(new Request('http://localhost/mcp', { headers: { 'X-Canvas-API-Key': issued.key } }));
    await fixture.seed(); const baseline = await fixture.snapshot();
    const transaction = async <T>(consume: (database: SqlConnection) => Promise<T>) => {
      const client = await (getPostgresRuntimeQueryable() as unknown as Pool).connect();
      const database: SqlConnection = { get: async (sql, values) => (await client.query(sql, values)).rows[0],
        all: async (sql, values) => (await client.query(sql, values)).rows,
        run: async (sql, values) => ({ changes: (await client.query(sql, values)).rowCount ?? 0 }),
        close: () => { throw new Error('The actual owner disposes B.'); } };
      try { await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); const result = await consume(database);
        await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    const code = (wanted: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === wanted);
    const browse = (purpose: ApiKeyWorkspaceBrowsePurpose, source: 'request' | 'mcp' = 'request') =>
      capture(credential, { workspaceId: fixture.workspaceId, purpose, source }, principal => transaction(database =>
        phase(database, principal, purpose, async access => {
          assert.equal(access.workspace.workspaceId, fixture.workspaceId); assert.equal(access.userId, 'reader');
          assert.equal(access.workspace.permissions.canRead, true); assert.equal(access.workspace.permissions.canWrite, false);
          assert.equal(access.workspace.permissions.canDelete, false); await access.assertCurrent();
        })));
    const check = async (name: string, operation: () => Promise<void>) => { stage = name; await operation(); cases++;
      console.log(`API-key workspace-browse principal passed: ${name}`); };
    const purposes = ['tree', 'overview', 'manifest'] as const;
    await check('all fixed browse purposes use actual current read-only authority on B', async () => {
      for (const purpose of purposes) await browse(purpose);
    });
    await check('MCP checks the exact browse tool; REST does not inherit an unrelated MCP switch', async () => {
      const tools = process.env.CANVAS_MCP_DIRECT_TOOLS;
      try {
        for (const purpose of purposes) {
          process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,search_knowledge';
          await assert.rejects(browse(purpose, 'mcp'), code('API_KEY_TOOL_DISABLED')); await browse(purpose, 'request');
          process.env.CANVAS_MCP_DIRECT_TOOLS = { tree: 'list_knowledge_tree', overview: 'get_workspace_overview', manifest: 'get_knowledge_manifest' }[purpose];
          await browse(purpose, 'mcp');
        }
      } finally { process.env.CANVAS_MCP_DIRECT_TOOLS = tools; }
    });
    await check('purpose/family mismatch, forged handles and detached handles fail closed', async () => {
      await assert.rejects(capture(credential, { workspaceId: fixture.workspaceId, purpose: 'tree', source: 'request' }, principal =>
        transaction(database => phase(database, principal, 'manifest', async () => assert.fail('Wrong browse purpose')))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(capture(credential, { workspaceId: fixture.workspaceId, purpose: 'tree', source: 'request' }, principal =>
        transaction(async database => {
          await assert.rejects(readPhase(database, principal as unknown as ApiKeyDocumentReadPrincipal, async () => assert.fail('Promoted browse principal')),
            code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
        })), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(listCapture(credential, 'request', principal => transaction(database => phase(database,
        principal as unknown as ApiKeyWorkspaceBrowsePrincipal, 'list' as ApiKeyWorkspaceBrowsePurpose, async () => assert.fail('Malformed purpose promotion')))),
      code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      let detached: ApiKeyWorkspaceBrowsePrincipal | undefined;
      await capture(credential, { workspaceId: fixture.workspaceId, purpose: 'tree', source: 'request' }, async principal => { detached = principal; });
      for (const fake of [{}, detached]) await assert.rejects(transaction(database => phase(database, fake as ApiKeyWorkspaceBrowsePrincipal,
        'tree', async () => assert.fail('Invalid browse handle'))), code('API_KEY_PRINCIPAL_REQUIRED'));
    });
    await check('removed read action, archived workspace and actual credential revocation deny every purpose', async () => {
      await fixture.admin.query('UPDATE canvas_api_integrations SET actions_json=$2 WHERE id=$1', [issued.integration.id, JSON.stringify(['status'])]);
      try { for (const purpose of purposes) await assert.rejects(browse(purpose), code('API_KEY_ACCESS_DENIED')); }
      finally { await fixture.admin.query('UPDATE canvas_api_integrations SET actions_json=$2 WHERE id=$1', [issued.integration.id, JSON.stringify(['read'])]); }
      await fixture.admin.query("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [fixture.workspaceId]);
      try { for (const purpose of purposes) await assert.rejects(browse(purpose), code('API_KEY_ACCESS_DENIED')); }
      finally { await fixture.admin.query("UPDATE canvas_workspaces SET status='active' WHERE id=$1", [fixture.workspaceId]); }
      await fixture.admin.query('UPDATE canvas_api_keys SET revoked_at=$2 WHERE id=$1', [issued.credential.id, Date.now()]);
      for (const purpose of purposes) await assert.rejects(browse(purpose), code('API_KEY_INVALID'));
    });
    assert.deepEqual(await fixture.snapshot(), baseline);
  });
  console.log(`API-key workspace-browse principal: ${cases} actual PostgreSQL groups passed. Browse adapters are a separate required acceptance.`);
}
main().catch(error => {
  const message = error instanceof Error ? error.message.split('\n')[0].replace(/cnk_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/gu, '[redacted-api-key]') : 'Unknown failure';
  console.error(`API-key workspace-browse principal failed (${stage}): ${message}`); process.exitCode = 1;
});

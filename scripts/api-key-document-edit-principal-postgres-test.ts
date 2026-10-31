import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { ApiKeyDocumentEditPrincipal, ApiKeyDocumentReadPrincipal, ApiKeyDocumentReadOrigin } from '../app/lib/api-keys/document-read-principal';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

let stage = 'setup', cases = 0;
async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { createApiIntegration, updateApiIntegration } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyDocumentEditPrincipal: capture, withApiKeyDocumentEditPrincipalOnConnection: phase,
      withApiKeyDocumentReadPrincipal: readCapture, withApiKeyDocumentReadPrincipalOnConnection: readPhase,
      withApiKeyWorkspaceListPrincipal: listCapture, withApiKeyWorkspaceBrowsePrincipal: browseCapture } =
      await import('../app/lib/api-keys/document-read-principal');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const session = (await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0];
    const headers = new Headers({ Authorization: `Bearer ${session.token}`, Origin: 'http://localhost' });
    await fixture.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'");
    const issued = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Native edit authority',
      workspaceIds: [fixture.workspaceId], actions: ['read', 'edit', 'status'], expiresAt: Date.now() + 3_600_000 });
    const credential = await authenticateApiKeyRequest(new Request('http://localhost/api/documents/edit', { headers: { 'X-Canvas-API-Key': issued.key } }));
    await fixture.seed(); const baseline = await fixture.snapshot();
    const statementLog: string[] = [];
    const transaction = async <T>(consume: (database: SqlConnection) => Promise<T>) => {
      const client = await (getPostgresRuntimeQueryable() as unknown as Pool).connect();
      const database: SqlConnection = {
        get: async (sql, values) => { statementLog.push(sql); return (await client.query(sql, values)).rows[0]; },
        all: async (sql, values) => { statementLog.push(sql); return (await client.query(sql, values)).rows; },
        run: async (sql, values) => { statementLog.push(sql); return { changes: (await client.query(sql, values)).rowCount ?? 0 }; },
        close: () => assert.fail('The actual owner disposes B.'),
      };
      try { await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); const value = await consume(database);
        await client.query('COMMIT'); return value; }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    const code = (wanted: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === wanted);
    const edit = (purpose: 'edit' | 'edit_status' = 'edit', source: 'request' | 'mcp' = 'request') =>
      capture(credential, { workspaceId: fixture.workspaceId, purpose, source }, () => undefined, principal => transaction(database =>
        phase(database, principal, async access => { access.assertActive(); await access.assertCurrent(); access.assertActive(); })));
    const check = async (name: string, consume: () => Promise<void>) => { stage = name; await consume(); cases++;
      console.log(`API-key native edit principal passed: ${name}`); };
    await check('actual current edit rights are bounded and preserve the borrowed connection phase', async () => {
      const origins: ApiKeyDocumentReadOrigin[] = []; statementLog.length = 0;
      await capture(credential, { workspaceId: fixture.workspaceId, purpose: 'edit', source: 'request' }, value => origins.push(value),
        principal => transaction(database => phase(database, principal, async access => {
          assert.equal(access.userId, 'reader'); assert.equal(access.integrationId, issued.integration.id);
          assert.deepEqual(access.workspace.permissions, { canRead: true, canWrite: true, canRunAgent: true,
            canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false });
          access.assertActive(); await access.assertCurrent(); access.assertActive();
        })));
      assert.equal(statementLog.length, 8, 'Same phase engine: five settings/locks plus three current observations.');
      assert.equal(origins.length, 3);
      for (const value of origins) { assert.deepEqual(value, origins[0]); assert(Object.isFrozen(value)); }
      assert.equal(origins[0].kind, 'api_key'); assert.equal(origins[0].credentialId, issued.credential.id);
      assert(!Object.keys(origins[0]).some(key => /session|token|secret/iu.test(key)));
      await edit('edit_status');
      await readCapture(credential, { workspaceId: fixture.workspaceId, purpose: 'read' }, () => undefined,
        principal => transaction(database => readPhase(database, principal, async access => {
          assert.equal(access.workspace.permissions.canWrite, false); assert.equal(access.workspace.permissions.canRunAgent, false);
        })));
    });
    await check('read/list/browse, fake and detached handles cannot become native edit authority', async () => {
      const deny = (principal: unknown) => transaction(database => phase(database, principal as ApiKeyDocumentEditPrincipal,
        async () => assert.fail('A non-edit handle cannot write.')));
      await assert.rejects(readCapture(credential, { workspaceId: fixture.workspaceId, purpose: 'read' }, () => undefined, deny), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(listCapture(credential, 'request', deny), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(browseCapture(credential, { workspaceId: fixture.workspaceId, purpose: 'tree', source: 'request' }, deny), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      let detached: ApiKeyDocumentEditPrincipal | undefined;
      await capture(credential, { workspaceId: fixture.workspaceId, purpose: 'edit', source: 'request' }, () => undefined, async principal => { detached = principal; });
      for (const handle of [{}, detached]) await assert.rejects(deny(handle), code('API_KEY_PRINCIPAL_REQUIRED'));
      await assert.rejects(capture(credential, { workspaceId: fixture.workspaceId, purpose: 'edit', source: 'request' }, () => undefined,
        principal => transaction(async database => {
          await assert.rejects(readPhase(database, principal as unknown as ApiKeyDocumentReadPrincipal, async () => assert.fail('Wrong family')),
            code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
        })), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
    });
    await check('edit and status actions are independent; current ordinary write permission is required', async () => {
      await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 1, name: issued.integration.name,
        workspaceIds: [fixture.workspaceId], actions: ['read'] });
      await assert.rejects(edit(), code('API_KEY_ACCESS_DENIED')); await assert.rejects(edit('edit_status'), code('API_KEY_ACCESS_DENIED'));
      await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 2, name: issued.integration.name,
        workspaceIds: [fixture.workspaceId], actions: ['edit'] });
      await edit(); await assert.rejects(edit('edit_status'), code('API_KEY_ACCESS_DENIED'));
      await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 3, name: issued.integration.name,
        workspaceIds: [fixture.workspaceId], actions: ['status'] });
      await assert.rejects(edit('edit_status'), code('API_KEY_ACCESS_DENIED'));
      await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 4, name: issued.integration.name,
        workspaceIds: [fixture.workspaceId], actions: ['read', 'edit', 'status'] });
      await fixture.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='reader'");
      try { await assert.rejects(edit(), code('API_KEY_ACCESS_DENIED')); }
      finally { await fixture.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'"); }
    });
    await check('MCP requires its actual edit switch; reentrancy remains terminal when caught', async () => {
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source';
      await assert.rejects(edit('edit', 'mcp'), code('API_KEY_TOOL_DISABLED')); await edit();
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'edit_knowledge_source'; await edit('edit', 'mcp');
      await assert.rejects(capture(credential, { workspaceId: fixture.workspaceId, purpose: 'edit', source: 'request' }, () => undefined,
        principal => transaction(database => phase(database, principal, async access => {
          await assert.rejects(phase(database, principal, async () => assert.fail('Reentrant phase')), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
          assert.throws(access.assertActive, code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
        }))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
    });
    await check('the synchronous final guard rejects a genuinely expired credential without another SQL read', async () => {
      const expiresAt = Date.now() + 2000;
      await fixture.admin.query('UPDATE canvas_api_keys SET expires_at=$2 WHERE id=$1', [issued.credential.id, expiresAt]);
      await assert.rejects(capture(credential, { workspaceId: fixture.workspaceId, purpose: 'edit', source: 'request' }, () => undefined,
        principal => transaction(database => phase(database, principal, async access => {
          access.assertActive(); const before = statementLog.length;
          await new Promise(resolve => setTimeout(resolve, Math.max(1, expiresAt - Date.now() + 20)));
          assert.throws(access.assertActive, code('API_KEY_INVALID')); assert.equal(statementLog.length, before);
        }))), code('API_KEY_INVALID'));
    });
    assert.deepEqual(await fixture.snapshot(), baseline);
  });
  console.log(`API-key native edit principal: ${cases} actual PostgreSQL groups passed. Native mutation/adapters remain a separate required acceptance.`);
}
main().catch(error => {
  const message = error instanceof Error ? error.message.split('\n')[0].replace(/cnk_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/gu, '[redacted-api-key]') : 'Unknown failure';
  console.error(`API-key native edit principal failed (${stage}): ${message}`); process.exitCode = 1;
});

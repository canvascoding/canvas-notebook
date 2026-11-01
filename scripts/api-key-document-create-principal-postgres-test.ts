import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { ApiKeyAction } from '../app/lib/api-keys/contracts';
import type { ApiKeyDocumentCreateOrigin, ApiKeyDocumentCreatePrincipal, ApiKeyDocumentCreatePurpose,
  ApiKeyDocumentEditPrincipal, ApiKeyDocumentReadPrincipal } from '../app/lib/api-keys/document-read-principal';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

let stage = 'setup', groups = 0;
const code = (wanted: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === wanted);
async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { createApiIntegration, updateApiIntegration } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyDocumentCreatePrincipal: capture, withApiKeyDocumentCreatePrincipalOnConnection: phase,
      assertApiKeyDocumentCreatePrincipalActiveOnConnection: active,
      withApiKeyDocumentReadPrincipal: readCapture, withApiKeyDocumentReadPrincipalOnConnection: readPhase,
      withApiKeyDocumentEditPrincipal: editCapture, withApiKeyDocumentEditPrincipalOnConnection: editPhase,
      withApiKeyWorkspaceListPrincipal: listCapture, withApiKeyWorkspaceBrowsePrincipal: browseCapture } =
      await import('../app/lib/api-keys/document-read-principal');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const pool = getPostgresRuntimeQueryable() as unknown as Pool;
    const session = (await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0];
    const headers = new Headers({ Authorization: `Bearer ${session.token}`, Origin: 'http://localhost' });
    await fixture.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'");
    const issued = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Native Create and Import authority',
      workspaceIds: [fixture.workspaceId], actions: ['read', 'create', 'import', 'edit', 'status'], expiresAt: Date.now() + 3_600_000 });
    const credential = await authenticateApiKeyRequest(new Request('http://localhost/api/documents/create', { headers: { 'X-Canvas-API-Key': issued.key } }));
    await fixture.seed(); const baseline = await fixture.snapshot(), statements: string[] = [];
    const transaction = async <T>(consume: (database: SqlConnection) => Promise<T>) => {
      const client = await pool.connect();
      const database: SqlConnection = {
        get: async (sql, values) => { statements.push(sql); return (await client.query(sql, values)).rows[0]; },
        all: async (sql, values) => { statements.push(sql); return (await client.query(sql, values)).rows; },
        run: async (sql, values) => { statements.push(sql); return { changes: (await client.query(sql, values)).rowCount ?? 0 }; },
        close: () => assert.fail('The actual owner closes its own transaction.'),
      };
      try { await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); const value = await consume(database);
        await client.query('COMMIT'); return value; }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    const run = (purpose: ApiKeyDocumentCreatePurpose, source: 'request' | 'mcp' = 'request') =>
      capture(credential, { workspaceId: fixture.workspaceId, purpose, source }, () => undefined, principal =>
        transaction(database => phase(database, principal, purpose, async access => {
          assert.equal(access.purpose, purpose); access.assertActive(); await access.assertCurrent(); access.assertActive();
        })));
    const check = async (name: string, consume: () => Promise<void>) => { stage = name; await consume(); groups++;
      console.log(`API-key Create/Import principal passed: ${name}`); };
    await check('both fixed actions use real current rights, actual eight-statement phases and key-only attribution', async () => {
      for (const purpose of ['create', 'import'] as const) {
        const origins: ApiKeyDocumentCreateOrigin[] = []; statements.length = 0;
        await capture(credential, { workspaceId: fixture.workspaceId, purpose, source: 'request' }, value => origins.push(value),
          principal => transaction(database => phase(database, principal, purpose, async access => {
            assert.equal(access.userId, 'reader'); assert.equal(access.integrationId, issued.integration.id); assert.equal(access.purpose, purpose);
            assert.deepEqual(access.workspace.permissions, { canRead: true, canWrite: true, canRunAgent: true,
              canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false });
            access.assertActive(); await access.assertCurrent(); access.assertActive();
          })));
        assert.equal(statements.length, 8); assert.equal(origins.length, 3);
        for (const origin of origins) { assert(Object.isFrozen(origin)); assert.deepEqual(origin, origins[0]); }
        assert.equal(origins[0].kind, 'api_key'); assert.equal(origins[0].purpose, purpose); assert.equal(origins[0].entryPoint, 'request');
        assert.equal(origins[0].credentialId, issued.credential.id);
        assert(!Object.keys(origins[0]).some(key => /session|token|secret/iu.test(key)));
        assert(!JSON.stringify(origins[0]).includes(issued.key));
      }
    });
    await check('Create, Import, Read, Edit, List and Browse handles cannot cross fixed families', async () => {
      const deny = (principal: unknown, purpose: ApiKeyDocumentCreatePurpose = 'create') => transaction(database =>
        phase(database, principal as ApiKeyDocumentCreatePrincipal, purpose, async () => assert.fail('Wrong principal family.')));
      await assert.rejects(readCapture(credential, { workspaceId: fixture.workspaceId, purpose: 'read' }, () => undefined, deny), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(editCapture(credential, { workspaceId: fixture.workspaceId, purpose: 'edit', source: 'request' }, () => undefined, deny), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(listCapture(credential, 'request', deny), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(browseCapture(credential, { workspaceId: fixture.workspaceId, purpose: 'tree', source: 'request' }, deny), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      for (const purpose of ['create', 'import'] as const) {
        await assert.rejects(capture(credential, { workspaceId: fixture.workspaceId, purpose, source: 'request' }, () => undefined,
          principal => deny(principal, purpose === 'create' ? 'import' : 'create')), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
        await assert.rejects(capture(credential, { workspaceId: fixture.workspaceId, purpose, source: 'request' }, () => undefined,
          principal => transaction(database => readPhase(database, principal as unknown as ApiKeyDocumentReadPrincipal,
            async () => assert.fail('A create handle is not a read handle.')))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
        await assert.rejects(capture(credential, { workspaceId: fixture.workspaceId, purpose, source: 'request' }, () => undefined,
          principal => transaction(database => editPhase(database, principal as unknown as ApiKeyDocumentEditPrincipal,
            async () => assert.fail('A create handle is not an edit handle.')))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      }
      // A runtime cast cannot select Edit through the Create API's purpose argument.
      await assert.rejects(editCapture(credential, { workspaceId: fixture.workspaceId, purpose: 'edit', source: 'request' }, () => undefined,
        principal => transaction(database => editPhase(database, principal, async () => {
          assert.throws(() => active(database, principal as unknown as ApiKeyDocumentCreatePrincipal,
            'edit' as ApiKeyDocumentCreatePurpose), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
        }))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      let detached: ApiKeyDocumentCreatePrincipal | undefined;
      await capture(credential, { workspaceId: fixture.workspaceId, purpose: 'create', source: 'request' }, () => undefined,
        async principal => { detached = principal; });
      for (const value of [{}, detached]) await assert.rejects(deny(value), code('API_KEY_PRINCIPAL_REQUIRED'));
      let getters = 0;
      const options = { workspaceId: fixture.workspaceId, purpose: 'create' as const, source: 'request' as const };
      Object.defineProperty(options, 'purpose', { enumerable: true, get() { getters++; throw new Error('Untrusted getter.'); } });
      await assert.rejects(capture(credential, options, () => undefined, async () => assert.fail('Getter input.')), code('API_KEY_PRINCIPAL_REQUIRED'));
      assert.equal(getters, 0);
    });
    await check('current action grants are independent and never replace ordinary workspace or seat rights', async () => {
      let revision = 1;
      for (const actions of [['create'], ['import'], ['edit', 'status'], ['read'], ['create', 'import']] as ApiKeyAction[][]) {
        await updateApiIntegration(headers, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
          workspaceIds: [fixture.workspaceId], actions });
        for (const purpose of ['create', 'import'] as const) {
          if (actions.includes(purpose)) await run(purpose); else await assert.rejects(run(purpose), code('API_KEY_ACCESS_DENIED'));
        }
      }
      await fixture.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='reader'");
      try { for (const purpose of ['create', 'import'] as const) await assert.rejects(run(purpose), code('API_KEY_ACCESS_DENIED')); }
      finally { await fixture.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'"); }
      await fixture.admin.query("UPDATE team_memberships SET status='suspended' WHERE user_id='reader'");
      try { for (const purpose of ['create', 'import'] as const) await assert.rejects(run(purpose),
        error => Boolean(error && typeof error === 'object' && Reflect.get(error, 'status') === 403)); }
      finally { await fixture.admin.query("UPDATE team_memberships SET status='active' WHERE user_id='reader'"); }
    });
    await check('MCP checks each actual tool and rechecks a withdrawn switch inside the held phase', async () => {
      for (const purpose of ['create', 'import'] as const) {
        process.env.CANVAS_MCP_DIRECT_TOOLS = purpose === 'create' ? 'create_knowledge_source' : 'import_knowledge_file';
        await run(purpose, 'mcp'); await run(purpose === 'create' ? 'import' : 'create');
        await assert.rejects(run(purpose === 'create' ? 'import' : 'create', 'mcp'), code('API_KEY_TOOL_DISABLED'));
        await assert.rejects(capture(credential, { workspaceId: fixture.workspaceId, purpose, source: 'mcp' }, origin => {
          assert.equal(origin.entryPoint, 'mcp'); assert.equal(origin.purpose, purpose);
        }, principal => transaction(database => phase(database, principal, purpose, async access => {
          process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source'; await access.assertCurrent();
        }))), code('API_KEY_TOOL_DISABLED'));
      }
    });
    await check('caught reentrancy is terminal and synchronous expiry fences the later writer without extra SQL', async () => {
      await assert.rejects(capture(credential, { workspaceId: fixture.workspaceId, purpose: 'create', source: 'request' }, () => undefined,
        principal => transaction(database => phase(database, principal, 'create', async access => {
          await assert.rejects(phase(database, principal, 'create', async () => assert.fail('Reentrant consumer')), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
          assert.throws(access.assertActive, code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
        }))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      for (const purpose of ['create', 'import'] as const) {
        const expiresAt = Date.now() + 1800;
        await fixture.admin.query('UPDATE canvas_api_keys SET expires_at=$2 WHERE id=$1', [issued.credential.id, expiresAt]);
        await assert.rejects(capture(credential, { workspaceId: fixture.workspaceId, purpose, source: 'request' }, () => undefined,
          principal => transaction(database => phase(database, principal, purpose, async access => {
            access.assertActive(); const before = statements.length;
            await new Promise(resolve => setTimeout(resolve, Math.max(1, expiresAt - Date.now() + 20)));
            assert.throws(access.assertActive, code('API_KEY_INVALID')); assert.equal(statements.length, before);
          }))), code('API_KEY_INVALID'));
      }
      await fixture.admin.query('UPDATE canvas_api_keys SET expires_at=$2 WHERE id=$1', [issued.credential.id, Date.now() + 3_600_000]);
    });
    await check('actual logout does not revoke the key; a separate revocation waits on the phase then denies both actions', async () => {
      assert.equal((await fixture.admin.query("DELETE FROM session WHERE id='reader-session'")).rowCount, 1);
      let writer: PoolClient | undefined, write: Promise<unknown> | undefined;
      try {
        await capture(credential, { workspaceId: fixture.workspaceId, purpose: 'create', source: 'request' }, () => undefined,
          principal => transaction(database => phase(database, principal, 'create', async access => {
            writer = await pool.connect(); await writer.query("SET lock_timeout='3s'");
            const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            write = writer.query('UPDATE canvas_api_keys SET revoked_at=$2 WHERE id=$1', [issued.credential.id, Date.now()]); void write.catch(() => undefined);
            let blocked = false;
            for (let attempt = 0; attempt < 60; attempt++) {
              if ((await fixture.admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock') { blocked = true; break; }
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert(blocked); await access.assertCurrent(); access.assertActive();
          })));
        await write;
      } finally {
        if (write) await write.catch(() => undefined);
        if (writer) { await writer.query('RESET lock_timeout'); writer.release(); }
      }
      for (const purpose of ['create', 'import'] as const) await assert.rejects(run(purpose), code('API_KEY_INVALID'));
    });
    assert.deepEqual(await fixture.snapshot(), baseline, 'Principal checks preserve all original document/Yjs/revision/projection rows and xmin.');
  });
  console.log(`API-key Create/Import principal: ${groups} actual PostgreSQL groups passed. Native writers, public adapters and SDK remain separate acceptance.`);
}
main().catch(error => {
  console.error(JSON.stringify({ suite: 'api-key-document-create-principal', stage, error: error instanceof Error ? error.name : 'UnknownError' }));
  process.exitCode = 1;
});

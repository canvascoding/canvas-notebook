import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { ApiKeyAction } from '../app/lib/api-keys/contracts';
import type { ApiKeyOriginalMarkdownImportOrigin, ApiKeyOriginalMarkdownImportPrincipal,
  ApiKeyOriginalMarkdownImportPurpose, ApiKeyOriginalMarkdownImportPrincipalAccess,
  ApiKeyDocumentCreatePrincipal } from '../app/lib/api-keys/document-read-principal';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

let stage = 'setup', groups = 0;
const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === expected);
const purposes = ['import_existing', 'import_existing_status'] as const;
async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { createApiIntegration, updateApiIntegration, rotateApiKey, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyOriginalMarkdownImportPrincipal: capture, withApiKeyOriginalMarkdownImportPrincipalOnConnection: phase,
      assertApiKeyOriginalMarkdownImportPrincipalActiveOnConnection: active,
      withApiKeyDocumentCreatePrincipal: createCapture, withApiKeyDocumentCreatePrincipalOnConnection: createPhase,
      withApiKeyDocumentReadPrincipal: readCapture, withApiKeyDocumentEditPrincipal: editCapture,
      withApiKeyWorkspaceListPrincipal: listCapture, withApiKeyWorkspaceBrowsePrincipal: browseCapture,
      withApiKeyWorkspaceCopyPrincipal: copyCapture, withApiKeyWorkspacePathPrincipal: pathCapture } =
      await import('../app/lib/api-keys/document-read-principal');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const pool = getPostgresRuntimeQueryable() as unknown as Pool;
    const token = (await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0].token;
    const headers = new Headers({ Authorization: `Bearer ${token}`, Origin: 'http://localhost' });
    await fixture.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'");
    const fullActions: ApiKeyAction[] = ['read', 'create', 'import', 'edit', 'status'];
    const issued = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Explicit original import authority',
      workspaceIds: [fixture.workspaceId], actions: fullActions, expiresAt: Date.now() + 3_600_000 });
    const authenticate = (key: string) => authenticateApiKeyRequest(new Request('http://localhost/api/documents/import-existing',
      { headers: { 'X-Canvas-API-Key': key } }));
    let credential = await authenticate(issued.key), revision = 1;
    await fixture.seed(); const baseline = await fixture.snapshot(), statements: string[] = [];
    const transaction = async <T>(consume: (database: SqlConnection) => Promise<T>) => {
      const client = await pool.connect();
      const database: SqlConnection = {
        get: async (sql, values) => { statements.push(sql); return (await client.query(sql, values)).rows[0]; },
        all: async (sql, values) => { statements.push(sql); return (await client.query(sql, values)).rows; },
        run: async (sql, values) => { statements.push(sql); return { changes: (await client.query(sql, values)).rowCount ?? 0 }; },
        close: () => assert.fail('Only the actual owner closes this transaction.'),
      };
      try { await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); const value = await consume(database);
        await client.query('COMMIT'); return value; }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    const options = (purpose: ApiKeyOriginalMarkdownImportPurpose, source: 'request' | 'mcp' = 'request') =>
      ({ workspaceId: fixture.workspaceId, purpose, source });
    const run = (purpose: ApiKeyOriginalMarkdownImportPurpose, source: 'request' | 'mcp' = 'request') =>
      capture(credential, options(purpose, source), () => undefined, principal =>
        transaction(database => phase(database, principal, purpose, async access => {
          access.assertActive(); await access.assertCurrent(); access.assertActive();
        })));
    const update = async (actions: ApiKeyAction[], workspaceIds = [fixture.workspaceId]) => {
      await updateApiIntegration(headers, issued.integration.id, { expectedRevision: revision, name: issued.integration.name,
        workspaceIds, actions }); revision++;
    };
    const check = async (name: string, operation: () => Promise<void>) => {
      stage = name; await operation(); groups++; assert.deepEqual(await fixture.snapshot(), baseline);
      console.log(`API-key original import principal passed: ${name}`);
    };
    await check('two distinct purposes retain real Write/Agent rights, realm and sessionless origin', async () => {
      for (const purpose of purposes) {
        const origins: ApiKeyOriginalMarkdownImportOrigin[] = []; statements.length = 0;
        await capture(credential, options(purpose), value => origins.push(value), principal =>
          transaction(database => phase(database, principal, purpose, async access => {
            assert.equal(access.purpose, purpose); assert.equal(access.entryPoint, 'request');
            assert.equal(access.credentialId, issued.credential.id); assert.equal(access.userId, 'reader');
            assert.equal(access.integrationId, issued.integration.id);
            assert.deepEqual(access.workspace.permissions, { canRead: true, canWrite: true, canRunAgent: true,
              canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false });
            assert(!Object.keys(access).some(key => /session|token|secret/iu.test(key)));
            access.assertActive(); await access.assertCurrent(); access.assertActive();
          })));
        assert.equal(statements.length, 9); assert.equal(origins.length, 3);
        for (const origin of origins) {
          assert(Object.isFrozen(origin)); assert.deepEqual(origin, origins[0]);
          assert.equal(origin.kind, 'api_key'); assert.equal(origin.purpose, purpose); assert.equal(origin.entryPoint, 'request');
          assert(!Object.keys(origin).some(key => /session|token|secret/iu.test(key)));
          assert(!JSON.stringify(origin).includes(issued.key));
        }
      }
    });
    await check('import is mandatory for both purposes; status alone and Create do not authorize them', async () => {
      for (const actions of [['read'], ['status'], ['create'], ['import'], ['import', 'read'], ['import', 'status']] as ApiKeyAction[][]) {
        await update(actions);
        for (const purpose of purposes) {
          if (actions.includes('import') && (purpose === 'import_existing' || actions.includes('status'))) await run(purpose);
          else await assert.rejects(run(purpose), code('API_KEY_ACCESS_DENIED'));
        }
      }
      await update(fullActions);
      for (const [sql, restore] of [
        ["UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='reader'",
          "UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'"],
        ["UPDATE team_memberships SET status='suspended' WHERE user_id='reader'",
          "UPDATE team_memberships SET status='active' WHERE user_id='reader'"],
      ]) {
        await fixture.admin.query(sql);
        try { for (const purpose of purposes) await assert.rejects(run(purpose), error =>
          Boolean(error && typeof error === 'object' && Reflect.get(error, 'status') === 403)); }
        finally { await fixture.admin.query(restore); }
      }
      await fixture.admin.query("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [fixture.workspaceId]);
      try { for (const purpose of purposes) await assert.rejects(run(purpose), code('API_KEY_ACCESS_DENIED')); }
      finally { await fixture.admin.query("UPDATE canvas_workspaces SET status='active' WHERE id=$1", [fixture.workspaceId]); }
    });
    await check('old read/create/import/edit/list/browse/copy/path handles cannot substitute for original authority', async () => {
      const deny = (principal: unknown) => transaction(database => phase(database, principal as ApiKeyOriginalMarkdownImportPrincipal,
        'import_existing', async () => assert.fail('A different principal family entered original import.')));
      await assert.rejects(readCapture(credential, { workspaceId: fixture.workspaceId, purpose: 'read' }, () => undefined, deny), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      for (const purpose of ['create', 'import'] as const) await assert.rejects(createCapture(credential,
        { workspaceId: fixture.workspaceId, purpose, source: 'request' }, () => undefined, deny), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(editCapture(credential, { workspaceId: fixture.workspaceId, purpose: 'edit', source: 'request' }, () => undefined, deny), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(listCapture(credential, 'request', deny), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(browseCapture(credential, { workspaceId: fixture.workspaceId, purpose: 'manifest', source: 'request' }, deny), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(copyCapture(credential, { sourceWorkspaceId: fixture.workspaceId, destinationWorkspaceId: fixture.workspaceId,
        purpose: 'copy_apply', source: 'request' }, deny), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(pathCapture(credential, { workspaceId: fixture.workspaceId, purpose: 'move_apply', source: 'request' }, deny), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      for (const purpose of purposes) {
        await assert.rejects(capture(credential, options(purpose), () => undefined, principal => transaction(database =>
          phase(database, principal, purpose === 'import_existing' ? 'import_existing_status' : 'import_existing', async () =>
            assert.fail('Original purposes were confused.')))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
        await assert.rejects(capture(credential, options(purpose), () => undefined, principal => transaction(database =>
          createPhase(database, principal as unknown as ApiKeyDocumentCreatePrincipal, 'import', async () =>
            assert.fail('An original handle entered a new-upload consumer.')))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      }
    });
    await check('serialized/detached handles and malformed options never establish authority', async () => {
      let detached: ApiKeyOriginalMarkdownImportPrincipal | undefined;
      await capture(credential, options('import_existing'), () => undefined, async principal => { detached = principal; });
      for (const principal of [{}, detached, JSON.parse(JSON.stringify(detached))]) await assert.rejects(transaction(database =>
        phase(database, principal as ApiKeyOriginalMarkdownImportPrincipal, 'import_existing', async () => assert.fail('Detached principal.'))), code('API_KEY_PRINCIPAL_REQUIRED'));
      let getters = 0;
      const getter = { workspaceId: fixture.workspaceId, source: 'request' };
      Object.defineProperty(getter, 'purpose', { enumerable: true, get() { getters++; return 'import_existing'; } });
      for (const invalid of [getter, new Proxy(options('import_existing'), {}), { ...options('import_existing'), actorSessionId: 'forged' },
        { ...options('import_existing'), purpose: 'import' }, { ...options('import_existing'), source: 'session' }]) {
        await assert.rejects(capture(credential, invalid as ReturnType<typeof options>, () => undefined,
          async () => assert.fail('Malformed original options.')), code('API_KEY_PRINCIPAL_REQUIRED'));
      }
      assert.equal(getters, 0);
    });
    await check('the actual enabled import tool is required and a withdrawn switch fails inside the phase', async () => {
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'import_knowledge_file';
      for (const purpose of purposes) await run(purpose, 'mcp');
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'create_knowledge_source';
      for (const purpose of purposes) { await run(purpose); await assert.rejects(run(purpose, 'mcp'), code('API_KEY_TOOL_DISABLED')); }
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'import_knowledge_file';
      await assert.rejects(capture(credential, options('import_existing', 'mcp'), origin => {
        assert.equal(origin.entryPoint, 'mcp');
      }, principal => transaction(database => phase(database, principal, 'import_existing', async access => {
        process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source'; await access.assertCurrent();
      }))), code('API_KEY_TOOL_DISABLED'));
    });
    await check('current phase row fences, canonical realm and synchronous final guards are genuine', async () => {
      const writer = await pool.connect();
      try {
        await writer.query("SET lock_timeout='100ms'");
        await capture(credential, options('import_existing'), () => undefined, principal => transaction(database =>
          phase(database, principal, 'import_existing', async access => {
            await assert.rejects(writer.query('UPDATE canvas_api_integrations SET updated_at=updated_at WHERE id=$1',
              [issued.integration.id]), code('55P03'));
            access.assertActive(); await access.assertCurrent(); access.assertActive();
          })));
      } finally { await writer.query('RESET lock_timeout'); writer.release(); }
      await assert.rejects(capture(credential, options('import_existing'), () => undefined, principal => transaction(database =>
        phase(database, principal, 'import_existing', async () => {
          assert.throws(() => active(database, principal, 'import_existing_status'), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
        }))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(capture(credential, options('import_existing_status'), () => undefined, principal => transaction(database =>
        phase(database, principal, 'import_existing_status', async access => {
          await database.run("SELECT set_config('search_path','pg_catalog',true)"); await access.assertCurrent();
        }))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      let escaped: ApiKeyOriginalMarkdownImportPrincipalAccess | undefined;
      await capture(credential, options('import_existing'), () => undefined, principal => transaction(database =>
        phase(database, principal, 'import_existing', async access => { escaped = access; })));
      assert(escaped); assert.throws(escaped.assertActive, code('API_KEY_PRINCIPAL_REQUIRED'));
    });
    await check('a reused capture rechecks withdrawn grants between actual transactions', async () => {
      await capture(credential, options('import_existing_status'), () => undefined, async principal => {
        await transaction(database => phase(database, principal, 'import_existing_status', async access => { await access.assertCurrent(); }));
        await update(['status']);
        await assert.rejects(transaction(database => phase(database, principal, 'import_existing_status', async () =>
          assert.fail('A status grant replaced import authority.'))), code('API_KEY_ACCESS_DENIED'));
      }).then(() => assert.fail('Revoked capture did not retain failure.'), error => { assert(code('API_KEY_ACCESS_DENIED')(error)); });
      await update(fullActions);
    });
    await check('actual rotation/logout retain integration ownership and revocation ends both purposes', async () => {
      stage = 'rotation_capture_original';
      const original: ApiKeyOriginalMarkdownImportOrigin[] = [];
      await capture(credential, options('import_existing'), value => original.push(value), principal => transaction(database =>
        phase(database, principal, 'import_existing', async access => { access.assertActive(); })));
      const frozen = JSON.stringify(original[0]);
      stage = 'rotation_execute';
      const rotated = await rotateApiKey(headers, issued.integration.id, { expectedRevision: revision,
        requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 }); revision++;
      stage = 'rotation_old_key_denied';
      for (const purpose of purposes) await assert.rejects(run(purpose), code('API_KEY_INVALID'));
      stage = 'rotation_authenticate_replacement';
      credential = await authenticate(rotated.key);
      const current: ApiKeyOriginalMarkdownImportOrigin[] = [];
      stage = 'rotation_capture_replacement';
      await capture(credential, options('import_existing_status'), value => current.push(value), principal => transaction(database =>
        phase(database, principal, 'import_existing_status', async access => { access.assertActive(); })));
      assert.equal(original[0].integrationId, current[0].integrationId); assert.equal(original[0].instanceId, current[0].instanceId);
      assert.equal(original[0].credentialId, issued.credential.id); assert.equal(current[0].credentialId, rotated.credential.id);
      assert.equal(JSON.stringify(original[0]), frozen);
      stage = 'rotation_create_manager';
      const manager = randomBytes(32).toString('hex'), now = Date.now();
      await fixture.admin.query("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('original-import-manager',$1,'reader',$2,$3,$3)",
        [manager, now + 3_600_000, now]);
      await fixture.admin.query("DELETE FROM session WHERE id='reader-session'");
      stage = 'rotation_issuer_logout';
      for (const purpose of purposes) await run(purpose);
      headers.set('Authorization', `Bearer ${manager}`);
      stage = 'rotation_revoke';
      await revokeApiKey(headers, issued.integration.id, { expectedRevision: revision, credentialId: rotated.credential.id });
      stage = 'rotation_revoked_key_denied';
      for (const purpose of purposes) await assert.rejects(run(purpose), code('API_KEY_INVALID'));
    });
  });
  console.log(`API-key original import principal: ${groups} genuine PostgreSQL/key/realm groups passed; writer, historical binding and public adapters remain separate.`);
}
void main().catch(error => {
  const candidate = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  const name = error instanceof Error ? error.name : typeof error;
  console.error(JSON.stringify({ suite: 'api-key-original-import-principal', passed: false, stage,
    errorType: /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name) ? name : 'Error',
    code: typeof candidate === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(candidate) ? candidate : 'TEST_FAILED' }));
  process.exitCode = 1;
});

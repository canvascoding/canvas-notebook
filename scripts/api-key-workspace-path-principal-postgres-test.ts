import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { ApiKeyAction } from '../app/lib/api-keys/contracts';
import type { ApiKeyWorkspacePathPrincipal, ApiKeyWorkspacePathPurpose, ApiKeyDocumentReadPrincipal } from '../app/lib/api-keys/document-read-principal';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

const purposes = ['move_preview', 'move_apply', 'move_status', 'move_recover',
  'delete_preview', 'delete_apply', 'delete_status', 'delete_recover'] as const;
const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === expected);
let stage = 'setup', groups = 0;
async function main() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { FILE_VERSION_CENTER_MODE: 'shadow', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS: 'move_knowledge_source,delete_knowledge_source' });
    const { createApiIntegration, updateApiIntegration, rotateApiKey, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyWorkspacePathPrincipal: capture, withApiKeyWorkspacePathPrincipalOnConnection: phase,
      assertApiKeyWorkspacePathPrincipalCaptured: captured, withApiKeyDocumentReadPrincipal: readCapture,
      withApiKeyDocumentReadPrincipalOnConnection: readPhase, withApiKeyDocumentEditPrincipal: editCapture,
      withApiKeyDocumentCreatePrincipal: createCapture, withApiKeyWorkspaceListPrincipal: listCapture,
      withApiKeyWorkspaceBrowsePrincipal: browseCapture, withApiKeyWorkspaceCopyPrincipal: copyCapture } = await import('../app/lib/api-keys/document-read-principal');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const pool = getPostgresRuntimeQueryable() as unknown as Pool;
    const manager = new Headers((await h.request()).headers); manager.set('Origin', 'http://localhost');
    const ids = [h.source.workspaceId, h.destination.workspaceId], workspaceId = ids[1];
    // Provision the real organization delete permission; the common Copy
    // fixture deliberately gives its writer no destructive file permission.
    await h.admin.query("UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id='principal-org' AND user_id='member'");
    let revision = 1;
    const allActions: ApiKeyAction[] = ['read', 'copy', 'move', 'delete', 'status', 'recover'];
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Native path principal',
      workspaceIds: ids, actions: allActions, expiresAt: Date.now() + 3_600_000 });
    let key = issued.key, credentialId = issued.credential.id;
    const authenticate = () => authenticateApiKeyRequest(new Request('http://localhost/api/documents/move', { headers: { 'X-Canvas-API-Key': key } }));
    let credential = await authenticate();
    const selected = (purpose: ApiKeyWorkspacePathPurpose, source: 'request' | 'mcp' = 'request') => ({ workspaceId, purpose, source });
    const statements: string[] = [];
    const transaction = async <T>(consume: (database: SqlConnection) => Promise<T>, canonical = false) => {
      const client = await pool.connect();
      const database: SqlConnection = { get: async (sql, values) => { statements.push(sql); return (await client.query(sql, values)).rows[0]; },
        all: async (sql, values) => { statements.push(sql); return (await client.query(sql, values)).rows; },
        run: async (sql, values) => { statements.push(sql); return { changes: (await client.query(sql, values)).rowCount ?? 0 }; },
        close: () => assert.fail('The caller owns the transaction.') };
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        if (canonical) await client.query("SELECT set_config('search_path',quote_ident($1)||', pg_catalog, pg_temp',true)", [h.schema]);
        const result = await consume(database); await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    const run = (purpose: ApiKeyWorkspacePathPurpose, source: 'request' | 'mcp' = 'request') => capture(credential, selected(purpose, source),
      principal => transaction(database => phase(database, principal, purpose, async access => { access.assertActive(); await access.assertCurrent(); access.assertActive(); })));
    const grant = (actions: ApiKeyAction[], workspaceIds = [workspaceId]) => updateApiIntegration(manager, issued.integration.id,
      { expectedRevision: revision++, name: issued.integration.name, workspaceIds, actions });
    const check = async (name: string, consume: () => Promise<void>) => { stage = name; await consume(); groups++; console.log(`API-key path principal passed: ${name}`); };
    const protectedPath = 'key-path/protected.md', originalBytes = Buffer.from('Native path principal protected source.');
    const original = await h.upload(protectedPath, originalBytes);
    const snapshot = async () => ({ document: (await h.admin.query('SELECT to_jsonb(d) AS body,xmin::text AS xmin FROM collaboration_documents d WHERE id=$1', [original.documentId])).rows,
      state: (await h.admin.query('SELECT to_jsonb(s) AS body,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [original.documentId])).rows,
      revisions: (await h.admin.query('SELECT to_jsonb(r) AS body,xmin::text AS xmin FROM file_revisions r WHERE lineage_id=(SELECT lineage_id FROM collaboration_documents WHERE id=$1) ORDER BY id', [original.documentId])).rows,
      bytes: await readFile(path.join(h.source.rootPath, protectedPath)) });
    const before = await snapshot();
    await check('all eight fixed purposes use genuine current SQL rights with bounded destructive capabilities', async () => {
      for (const purpose of purposes) {
        statements.length = 0;
        await capture(credential, selected(purpose), async principal => {
          captured(principal, { workspaceId, purpose });
          await transaction(database => phase(database, principal, purpose, async access => {
            assert.equal(access.workspace.workspaceId, workspaceId); assert.equal(access.userId, 'member');
            assert.equal(access.integrationId, issued.integration.id); assert.equal(access.credentialId, credentialId);
            assert.equal(access.purpose, purpose); assert.equal(access.entryPoint, 'request');
            assert.equal(access.workspace.permissions.canWrite, true); assert.equal(access.workspace.permissions.canDelete, true);
            assert.equal(access.workspace.permissions.canRunAgent, true); assert.equal(access.workspace.permissions.canManageWorkspace, false);
            assert.equal(access.workspace.permissions.canCreatePublicLinks, false); assert(Object.isFrozen(access));
            assert(!Object.keys(access).some(name => /session|token|secret/iu.test(name)));
            access.assertActive(); await access.assertCurrent(); access.assertActive();
          }));
        });
        assert.equal(statements.length, 9);
      }
    });
    await check('status and recovery require independent grants for the exact operation kind', async () => {
      for (const kind of ['move', 'delete'] as const) {
        await grant([kind]); await run(`${kind}_preview`); await run(`${kind}_apply`);
        await assert.rejects(run(`${kind}_status`), code('API_KEY_ACCESS_DENIED'));
        await assert.rejects(run(`${kind}_recover`), code('API_KEY_ACCESS_DENIED'));
        await grant([kind, 'recover']); await run(`${kind}_recover`);
        await assert.rejects(run(`${kind}_status`), code('API_KEY_ACCESS_DENIED'));
        const other = kind === 'move' ? 'delete' : 'move';
        await assert.rejects(run(`${other}_apply`), code('API_KEY_ACCESS_DENIED'));
      }
      await grant(['read', 'copy', 'status', 'recover']);
      for (const purpose of purposes) await assert.rejects(run(purpose), code('API_KEY_ACCESS_DENIED'));
      await grant(allActions);
    });
    await check('read-only Copy sources, missing allowlists and actual ACL withdrawal cannot become path targets', async () => {
      await grant(allActions, ids);
      stage = 'readonly_source';
      await assert.rejects(capture(credential, { ...selected('move_apply'), workspaceId: ids[0] }, principal => transaction(database =>
        phase(database, principal, 'move_apply', async () => assert.fail('Read-only source cannot be moved.')))), code('API_KEY_ACCESS_DENIED'));
      stage = 'allowlist_withdrawal';
      await grant(allActions, [ids[0]]); await assert.rejects(run('delete_apply'), code('API_KEY_ACCESS_DENIED')); await grant(allActions);
      stage = 'write_permission_withdrawal';
      await assert.rejects(capture(credential, selected('delete_apply'), principal =>
        transaction(database => phase(database, principal, 'delete_apply', async access => {
          await database.run("UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id='member'", [workspaceId]);
          await access.assertCurrent();
        }))), code('API_KEY_ACCESS_DENIED'));
      stage = 'all_read_permissions_withdrawn';
      await assert.rejects(capture(credential, selected('delete_apply'), principal => transaction(database => phase(database, principal, 'delete_apply', async access => {
        // Existing permissions make Write/Delete imply Read. Withdraw all
        // actual read-conferring rights instead of changing that policy.
        await database.run("UPDATE canvas_workspace_members SET can_read=0,can_write=0 WHERE workspace_id=$1 AND user_id='member'", [workspaceId]);
        await database.run("UPDATE organization_user_permissions SET can_delete_team_files=0 WHERE organization_id='principal-org' AND user_id='member'");
        await access.assertCurrent();
      }))), code('API_KEY_ACCESS_DENIED'));
      stage = 'delete_permission_withdrawal';
      await assert.rejects(capture(credential, selected('move_apply'), principal => transaction(database => phase(database, principal, 'move_apply', async access => {
        await database.run("UPDATE organization_user_permissions SET can_delete_team_files=0 WHERE organization_id='principal-org' AND user_id='member'");
        await access.assertCurrent();
      }))), code('API_KEY_ACCESS_DENIED'));
      await run('move_apply'); await run('delete_apply');
    });
    await check('purpose, family, forged-handle and accessor substitutions fail without lending authority', async () => {
      for (const purpose of purposes) for (const wrong of purposes.filter(value => value !== purpose)) await assert.rejects(
        capture(credential, selected(purpose), principal => transaction(database => phase(database, principal, wrong,
          async () => assert.fail('Wrong fixed purpose.')))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      const borrowed = (principal: object) => transaction(database => phase(database, principal as ApiKeyWorkspacePathPrincipal,
        'move_preview', async () => assert.fail('Another principal family.')));
      await assert.rejects(borrowed(Object.freeze({})), code('API_KEY_PRINCIPAL_REQUIRED'));
      await assert.rejects(readCapture(credential, { workspaceId, purpose: 'read' }, () => undefined, borrowed), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(editCapture(credential, { workspaceId, purpose: 'edit', source: 'request' }, () => undefined, borrowed), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(createCapture(credential, { workspaceId, purpose: 'create', source: 'request' }, () => undefined, borrowed), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(listCapture(credential, 'request', borrowed), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(browseCapture(credential, { workspaceId, purpose: 'tree', source: 'request' }, borrowed), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(copyCapture(credential, { sourceWorkspaceId: ids[0], destinationWorkspaceId: workspaceId, purpose: 'copy_preview', source: 'request' }, borrowed), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(capture(credential, selected('move_preview'), principal => transaction(database => readPhase(database,
        principal as unknown as ApiKeyDocumentReadPrincipal, async () => assert.fail('Path is not Read.')))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      let getters = 0;
      await assert.rejects(capture(credential, { ...selected('move_apply'), get workspaceId() { getters++; return workspaceId; } }, async () => assert.fail('Getter.')), code('API_KEY_PRINCIPAL_REQUIRED'));
      await assert.rejects(capture(credential, new Proxy(selected('delete_apply'), { ownKeys() { getters++; return []; } }), async () => assert.fail('Proxy.')), code('API_KEY_PRINCIPAL_REQUIRED'));
      assert.equal(getters, 0);
    });
    await check('canonical native realm works but shadow relations and altered search paths fail closed', async () => {
      await capture(credential, selected('move_preview'), principal => transaction(database => phase(database, principal, 'move_preview',
        async access => { access.assertActive(); await access.assertCurrent(); }), true));
      for (const value of ['pg_catalog', `${h.schema}, pg_catalog, pg_temp, public`]) await assert.rejects(
        capture(credential, selected('move_preview'), principal => transaction(async database => {
          await database.get("SELECT set_config('search_path',$1,true)", [value]);
          return phase(database, principal, 'move_preview', async () => assert.fail('Wrong realm.'));
        })), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      // The native canonical path explicitly puts pg_temp last: a same-named
      // temp relation cannot shadow it. The raw entry must still reject one.
      await capture(credential, selected('delete_preview'), principal => transaction(database => phase(database, principal, 'delete_preview', async access => {
        await database.run('CREATE TEMP TABLE canvas_api_keys(id text) ON COMMIT DROP'); await access.assertCurrent(); access.assertActive();
      })));
      await assert.rejects(capture(credential, selected('delete_preview'), principal => transaction(async database => {
        await database.run('CREATE TEMP TABLE canvas_api_keys(id text) ON COMMIT DROP');
        return phase(database, principal, 'delete_preview', async () => assert.fail('Raw realm shadow.'));
      })), code('API_KEY_STATE_INVALID'));
    });
    await check('tool opt-ins are independent and withdrawn switches poison held MCP phases', async () => {
      await run('move_preview', 'mcp'); await run('delete_preview', 'mcp');
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'move_knowledge_source';
      await run('move_preview', 'mcp'); await assert.rejects(run('delete_preview', 'mcp'), code('API_KEY_TOOL_DISABLED'));
      await run('delete_preview', 'request');
      await assert.rejects(capture(credential, selected('move_apply', 'mcp'), principal => transaction(database => phase(database, principal, 'move_apply', async access => {
        process.env.CANVAS_MCP_DIRECT_TOOLS = 'delete_knowledge_source'; await access.assertCurrent();
      }))), code('API_KEY_TOOL_DISABLED'));
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'move_knowledge_source,delete_knowledge_source';
    });
    await check('detached handles, caught reentrancy and actual synchronous expiry cannot authorize later work', async () => {
      let detached: ApiKeyWorkspacePathPrincipal | undefined;
      await capture(credential, selected('delete_preview'), async principal => { detached = principal; }); assert(detached);
      assert.throws(() => captured(detached!, { workspaceId, purpose: 'delete_preview' }), code('API_KEY_PRINCIPAL_REQUIRED'));
      await assert.rejects(capture(credential, selected('move_apply'), principal => transaction(database => phase(database, principal, 'move_apply', async access => {
        await assert.rejects(phase(database, principal, 'move_apply', async () => assert.fail('Reentrant.')), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
        assert.throws(access.assertActive, code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      }))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      const expiry = Date.now() + 1200;
      await h.admin.query('UPDATE canvas_api_keys SET expires_at=$2 WHERE id=$1', [credentialId, expiry]);
      await assert.rejects(capture(credential, selected('delete_apply'), principal => transaction(database => phase(database, principal, 'delete_apply', async access => {
        const count = statements.length; await new Promise(resolve => setTimeout(resolve, Math.max(1, expiry - Date.now() + 20)));
        assert.throws(access.assertActive, code('API_KEY_INVALID')); assert.equal(statements.length, count);
      }))), code('API_KEY_INVALID'));
      await h.admin.query('UPDATE canvas_api_keys SET expires_at=$2 WHERE id=$1', [credentialId, Date.now() + 3_600_000]);
    });
    await check('real rotation and independent revocation fence the current key phase', async () => {
      const old = credential, rotated = await rotateApiKey(manager, issued.integration.id,
        { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
      key = rotated.key; credentialId = rotated.credential.id; credential = await authenticate();
      await assert.rejects(capture(old, selected('move_preview'), principal => transaction(database => phase(database, principal,
        'move_preview', async () => assert.fail('Rotated key.')))), code('API_KEY_INVALID'));
      let writer: PoolClient | undefined, write: Promise<unknown> | undefined;
      try {
        await capture(credential, selected('delete_apply'), principal => transaction(database => phase(database, principal, 'delete_apply', async access => {
          writer = await pool.connect(); await writer.query("SET lock_timeout='3s'");
          const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          write = writer.query('UPDATE canvas_api_keys SET revoked_at=$2 WHERE id=$1', [credentialId, Date.now()]); void write.catch(() => undefined);
          let blocked = false;
          for (let attempt = 0; attempt < 60; attempt++) {
            if ((await h.admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock') { blocked = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert(blocked); await access.assertCurrent(); access.assertActive();
        })));
        await write;
      } finally { if (write) await write.catch(() => undefined); if (writer) { await writer.query('RESET lock_timeout'); writer.release(); } }
      for (const purpose of purposes) await assert.rejects(run(purpose), code('API_KEY_INVALID'));
      await revokeApiKey(manager, issued.integration.id, { expectedRevision: revision, credentialId });
    });
    assert.deepEqual(await snapshot(), before, 'Principal checks must not mutate documents, Yjs, history, xmin or original bytes.');
  });
  console.log(`API-key path principal: ${groups} genuine PostgreSQL/auth/scope/lifetime groups passed; job owners and public adapters remain separate.`);
}
main().catch(error => { console.error(JSON.stringify({ suite: 'api-key-path-principal', stage, error: error instanceof Error ? error.name : 'UnknownError',
  code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined,
  ...(error instanceof assert.AssertionError ? { actual: typeof error.actual === 'number' ? error.actual : typeof error.actual,
    expected: typeof error.expected === 'number' ? error.expected : typeof error.expected } : {}) })); process.exitCode = 1; });

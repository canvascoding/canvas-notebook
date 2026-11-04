import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { ApiKeyAction } from '../app/lib/api-keys/contracts';
import type { ApiKeyWorkspaceCopyPrincipal, ApiKeyWorkspaceCopyPurpose, ApiKeyDocumentReadPrincipal,
  ApiKeyDocumentCreatePrincipal } from '../app/lib/api-keys/document-read-principal';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

let stage = 'setup', groups = 0;
const purposes = ['copy_preview', 'copy_apply', 'copy_status', 'copy_recover'] as const;
const code = (wanted: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === wanted);
async function main() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { FILE_VERSION_CENTER_MODE: 'shadow', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'copy_knowledge_source' });
    const { createApiIntegration, updateApiIntegration, rotateApiKey, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyWorkspaceCopyPrincipal: capture, withApiKeyWorkspaceCopyPrincipalOnConnection: phase,
      assertApiKeyWorkspaceCopyPrincipalCaptured: captured, withApiKeyDocumentReadPrincipal: readCapture,
      withApiKeyDocumentReadPrincipalOnConnection: readPhase, withApiKeyDocumentCreatePrincipal: createCapture,
      withApiKeyDocumentCreatePrincipalOnConnection: createPhase, withApiKeyDocumentEditPrincipal: editCapture,
      withApiKeyDocumentEditPrincipalOnConnection: editPhase, withApiKeyWorkspaceListPrincipal: listCapture,
      withApiKeyWorkspaceBrowsePrincipal: browseCapture } = await import('../app/lib/api-keys/document-read-principal');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const pool = getPostgresRuntimeQueryable() as unknown as Pool;
    const manager = new Headers((await h.request()).headers); manager.set('Origin', 'http://localhost');
    const workspaces = [h.source.workspaceId, h.destination.workspaceId];
    let revision = 1;
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Genuine read-source/write-target Copy',
      workspaceIds: workspaces, actions: ['copy', 'status', 'recover'], expiresAt: Date.now() + 3_600_000 });
    let key = issued.key, credentialId = issued.credential.id;
    const authenticate = () => authenticateApiKeyRequest(new Request('http://localhost/api/files/copy', { headers: { 'X-Canvas-API-Key': key } }));
    let credential = await authenticate();
    const selected = (purpose: ApiKeyWorkspaceCopyPurpose, source: 'request' | 'mcp' = 'request') =>
      ({ sourceWorkspaceId: workspaces[0], destinationWorkspaceId: workspaces[1], purpose, source });
    const statements: string[] = [];
    const transaction = async <T>(consume: (database: SqlConnection) => Promise<T>, canonical = false) => {
      const client = await pool.connect();
      const database: SqlConnection = {
        get: async (sql, values) => { statements.push(sql); return (await client.query(sql, values)).rows[0]; },
        all: async (sql, values) => { statements.push(sql); return (await client.query(sql, values)).rows; },
        run: async (sql, values) => { statements.push(sql); return { changes: (await client.query(sql, values)).rowCount ?? 0 }; },
        close: () => assert.fail('Caller owns transaction disposal.'),
      };
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        if (canonical) await client.query("SELECT set_config('search_path',quote_ident($1)||', pg_catalog, pg_temp',true)", [h.schema]);
        const result = await consume(database); await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    const run = (purpose: ApiKeyWorkspaceCopyPurpose, source: 'request' | 'mcp' = 'request') => capture(credential, selected(purpose, source),
      principal => transaction(database => phase(database, principal, purpose, async access => { access.assertActive(); await access.assertCurrent(); access.assertActive(); })));
    const grant = (actions: ApiKeyAction[], ids = workspaces) => updateApiIntegration(manager, issued.integration.id,
      { expectedRevision: revision++, name: issued.integration.name, workspaceIds: ids, actions });
    const check = async (name: string, consume: () => Promise<void>) => { stage = name; await consume(); groups++;
      console.log(`API-key Copy principal passed: ${name}`); };
    const protectedPath = 'key-copy/protected.md', protectedBytes = Buffer.from('Original Copy-principal control.');
    const protectedDoc = await h.upload(protectedPath, protectedBytes);
    const snapshot = async () => ({ document: (await h.admin.query('SELECT to_jsonb(d) AS row,xmin::text AS xmin FROM collaboration_documents d WHERE id=$1', [protectedDoc.documentId])).rows,
      state: (await h.admin.query('SELECT to_jsonb(s) AS row,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [protectedDoc.documentId])).rows,
      revisions: (await h.admin.query('SELECT to_jsonb(r) AS row,xmin::text AS xmin FROM file_revisions r WHERE lineage_id=(SELECT lineage_id FROM collaboration_documents WHERE id=$1) ORDER BY id', [protectedDoc.documentId])).rows,
      bytes: await readFile(path.join(h.source.rootPath, protectedPath)) });
    const before = await snapshot();
    await check('all four exact actions share a real nine-statement pair snapshot with read-only source and bounded destination rights', async () => {
      for (const purpose of purposes) {
        statements.length = 0;
        await capture(credential, selected(purpose), async principal => {
          captured(principal, { sourceWorkspaceId: workspaces[0], destinationWorkspaceId: workspaces[1], purpose });
          await transaction(database => phase(database, principal, purpose, async access => {
            assert.equal(access.userId, 'member'); assert.equal(access.integrationId, issued.integration.id); assert.equal(access.credentialId, credentialId);
            assert.equal(access.purpose, purpose); assert.equal(access.entryPoint, 'request');
            assert.equal(access.sourceWorkspace.workspaceId, workspaces[0]); assert.equal(access.destinationWorkspace.workspaceId, workspaces[1]);
            assert.equal(access.sourceWorkspace.permissions.canRead, true); assert.equal(access.sourceWorkspace.permissions.canWrite, false);
            assert.equal(access.sourceWorkspace.permissions.canRunAgent, false); assert.equal(access.destinationWorkspace.permissions.canWrite, true);
            assert.equal(access.destinationWorkspace.permissions.canDelete, false); assert.equal(access.destinationWorkspace.permissions.canManageWorkspace, false);
            assert.equal(access.destinationWorkspace.permissions.canCreatePublicLinks, false); assert(Object.isFrozen(access));
            assert(!Object.keys(access).some(name => /session|token|secret/iu.test(name)));
            access.assertActive(); await access.assertCurrent(); access.assertActive();
          }));
        });
        assert.equal(statements.length, 9);
      }
    });
    await check('same-workspace Copy still requires destination write and exposes a separate read-only source view', async () => {
      await capture(credential, { ...selected('copy_apply'), sourceWorkspaceId: workspaces[1] }, principal =>
        transaction(database => phase(database, principal, 'copy_apply', async access => {
          assert.equal(access.sourceWorkspace.workspaceId, access.destinationWorkspace.workspaceId);
          assert.notEqual(access.sourceWorkspace, access.destinationWorkspace); assert.equal(access.sourceWorkspace.permissions.canWrite, false);
          assert.equal(access.destinationWorkspace.permissions.canWrite, true);
        })));
      await assert.rejects(capture(credential, { ...selected('copy_apply'), destinationWorkspaceId: workspaces[0] }, principal =>
        transaction(database => phase(database, principal, 'copy_apply', async () => assert.fail('Read-only destination.')))), code('API_KEY_ACCESS_DENIED'));
    });
    await check('both explicit allowlist entries and each actual source/destination role are required', async () => {
      await assert.rejects(capture(credential, { ...selected('copy_apply'), sourceWorkspaceId: workspaces[1], destinationWorkspaceId: workspaces[0] }, principal =>
        transaction(database => phase(database, principal, 'copy_apply', async () => assert.fail('Cannot reverse roles.')))), code('API_KEY_ACCESS_DENIED'));
      await grant(['copy', 'status', 'recover'], [workspaces[0]]);
      await assert.rejects(run('copy_preview'), code('API_KEY_ACCESS_DENIED'));
      await grant(['copy', 'status', 'recover']);
      await assert.rejects(capture(credential, { ...selected('copy_preview'), sourceWorkspaceId: 'not-allowed' }, principal =>
        transaction(database => phase(database, principal, 'copy_preview', async () => assert.fail('Unknown scope.')))), code('API_KEY_ACCESS_DENIED'));
    });
    await check('Copy purposes and all existing families cannot lend handles or copied metadata', async () => {
      for (const purpose of purposes) for (const wrong of purposes.filter(value => value !== purpose)) {
        await assert.rejects(capture(credential, selected(purpose), principal => transaction(database =>
          phase(database, principal, wrong, async () => assert.fail('Wrong Copy action.')))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      }
      await assert.rejects(transaction(database => phase(database, Object.freeze({}) as ApiKeyWorkspaceCopyPrincipal, 'copy_preview',
        async () => assert.fail('Uncaptured handle.'))), code('API_KEY_PRINCIPAL_REQUIRED'));
      const borrowed = (principal: object) => transaction(database => phase(database, principal as ApiKeyWorkspaceCopyPrincipal,
        'copy_preview', async () => assert.fail('Wrong family.')));
      await assert.rejects(readCapture(credential, { workspaceId: workspaces[0], purpose: 'read' }, () => undefined, borrowed), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(editCapture(credential, { workspaceId: workspaces[1], purpose: 'edit', source: 'request' }, () => undefined, borrowed), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(createCapture(credential, { workspaceId: workspaces[1], purpose: 'create', source: 'request' }, () => undefined, borrowed), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(listCapture(credential, 'request', borrowed), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(browseCapture(credential, { workspaceId: workspaces[0], purpose: 'tree', source: 'request' }, borrowed), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(capture(credential, selected('copy_preview'), principal => transaction(database => readPhase(database,
        principal as unknown as ApiKeyDocumentReadPrincipal, async () => assert.fail('Copy is not Read.')))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(capture(credential, selected('copy_preview'), principal => transaction(database => createPhase(database,
        principal as unknown as ApiKeyDocumentCreatePrincipal, 'create', async () => assert.fail('Copy is not Create.')))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      let getters = 0;
      await assert.rejects(capture(credential, { ...selected('copy_preview'), get sourceWorkspaceId() { getters++; return workspaces[0]; } },
        async () => assert.fail('No getter input.')), code('API_KEY_PRINCIPAL_REQUIRED')); assert.equal(getters, 0);
      let expired: ApiKeyWorkspaceCopyPrincipal | undefined;
      await capture(credential, selected('copy_preview'), async principal => { expired = principal; }); assert(expired);
      assert.throws(() => captured(expired!, { sourceWorkspaceId: workspaces[0], destinationWorkspaceId: workspaces[1], purpose: 'copy_preview' }), code('API_KEY_PRINCIPAL_REQUIRED'));
    });
    await check('current action grants remain independent and Copy issuance never grants unrelated source writes', async () => {
      await grant(['copy']); await run('copy_preview'); await run('copy_apply');
      await assert.rejects(run('copy_status'), code('API_KEY_ACCESS_DENIED')); await assert.rejects(run('copy_recover'), code('API_KEY_ACCESS_DENIED'));
      await grant(['copy', 'recover']); await run('copy_recover'); await assert.rejects(run('copy_status'), code('API_KEY_ACCESS_DENIED'));
      await grant(['read']); for (const purpose of purposes) await assert.rejects(run(purpose), code('API_KEY_ACCESS_DENIED'));
      await grant(['copy', 'edit', 'delete', 'status', 'recover']);
      await assert.rejects(editCapture(credential, { workspaceId: workspaces[0], purpose: 'edit', source: 'request' }, () => undefined,
        principal => transaction(database => editPhase(database, principal, async () => assert.fail('Copy source cannot become Edit target.')))), code('API_KEY_ACCESS_DENIED'));
      await editCapture(credential, { workspaceId: workspaces[1], purpose: 'edit', source: 'request' }, () => undefined,
        principal => transaction(database => editPhase(database, principal, async access => { assert.equal(access.workspace.permissions.canWrite, true); })));
      await assert.rejects(readCapture(credential, { workspaceId: workspaces[0], purpose: 'read' }, () => undefined,
        principal => transaction(database => readPhase(database, principal, async () => assert.fail('Copy is not public Read.')))), code('API_KEY_ACCESS_DENIED'));
    });
    await check('the genuine native-inspection canonical path is accepted only by Copy, while wrong realms are terminal', async () => {
      await capture(credential, selected('copy_preview'), principal => transaction(database => phase(database, principal, 'copy_preview',
        async access => { access.assertActive(); await access.assertCurrent(); }), true));
      for (const value of ['pg_catalog', `${h.schema}, pg_catalog, pg_temp, public`]) {
        await assert.rejects(capture(credential, selected('copy_preview'), principal => transaction(async database => {
          await database.get("SELECT set_config('search_path',$1,true)", [value]);
          return phase(database, principal, 'copy_preview', async () => assert.fail('Changed realm.'));
        })), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      }
      await grant(['read', 'copy', 'edit', 'delete', 'status', 'recover']);
      await assert.rejects(readCapture(credential, { workspaceId: workspaces[0], purpose: 'read' }, () => undefined,
        principal => transaction(database => readPhase(database, principal, async () => assert.fail('Read keeps its raw realm.')), true)), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
    });
    await check('current normal ACL and MCP switch withdrawal stop a held Copy phase before further work', async () => {
      await run('copy_preview', 'mcp');
      await assert.rejects(capture(credential, selected('copy_apply', 'mcp'), principal => transaction(database => phase(database, principal, 'copy_apply', async access => {
        process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source'; await access.assertCurrent();
      }))), code('API_KEY_TOOL_DISABLED'));
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'copy_knowledge_source';
      for (const [id, field] of [[workspaces[0], 'can_read'], [workspaces[1], 'can_write']] as const) {
        await assert.rejects(capture(credential, selected('copy_preview'), principal => transaction(database => phase(database, principal, 'copy_preview', async access => {
          await database.run(`UPDATE canvas_workspace_members SET ${field}=0 WHERE workspace_id=$1 AND user_id='member'`, [id]);
          await access.assertCurrent();
        }))), code('API_KEY_ACCESS_DENIED'));
      }
      await run('copy_preview');
    });
    await check('caught reentrancy and actual synchronous key expiry cannot authorize later storage', async () => {
      await assert.rejects(capture(credential, selected('copy_apply'), principal => transaction(database => phase(database, principal, 'copy_apply', async access => {
        await assert.rejects(phase(database, principal, 'copy_apply', async () => assert.fail('Nested Copy.')), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
        assert.throws(access.assertActive, code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      }))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      const expiresAt = Date.now() + 1400;
      await h.admin.query('UPDATE canvas_api_keys SET expires_at=$2 WHERE id=$1', [credentialId, expiresAt]);
      await assert.rejects(capture(credential, selected('copy_apply'), principal => transaction(database => phase(database, principal, 'copy_apply', async access => {
        const before = statements.length; await new Promise(resolve => setTimeout(resolve, Math.max(1, expiresAt - Date.now() + 20)));
        assert.throws(access.assertActive, code('API_KEY_INVALID')); assert.equal(statements.length, before);
      }))), code('API_KEY_INVALID'));
      await h.admin.query('UPDATE canvas_api_keys SET expires_at=$2 WHERE id=$1', [credentialId, Date.now() + 3_600_000]);
    });
    await check('actual issuer logout and rotation preserve the integration; a real independent revocation waits for the held phase', async () => {
      const managerToken = randomBytes(32).toString('hex');
      await h.admin.query("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('key-copy-manager',$1,'member',$2,$3,$3)",
        [managerToken, Date.now() + 3_600_000, Date.now()]);
      assert.equal((await h.admin.query("DELETE FROM session WHERE id='session-member'")).rowCount, 1); await run('copy_preview');
      manager.set('Authorization', `Bearer ${managerToken}`);
      const oldCredential = credential, rotated = await rotateApiKey(manager, issued.integration.id,
        { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
      key = rotated.key; credentialId = rotated.credential.id; credential = await authenticate();
      await assert.rejects(capture(oldCredential, selected('copy_preview'), principal => transaction(database => phase(database, principal,
        'copy_preview', async () => assert.fail('Old key.')))), code('API_KEY_INVALID'));
      await run('copy_preview');
      let writer: PoolClient | undefined, write: Promise<unknown> | undefined;
      try {
        await capture(credential, selected('copy_preview'), principal => transaction(database => phase(database, principal, 'copy_preview', async access => {
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
      // Also exercise the genuine manager revocation endpoint's already-revoked path.
      await revokeApiKey(manager, issued.integration.id, { expectedRevision: revision, credentialId });
    });
    assert.deepEqual(await snapshot(), before, 'Copy principal work must preserve original document/Yjs/history/xmin and file bytes.');
  });
  console.log(`API-key Copy principal: ${groups} genuine PostgreSQL/auth/pair/role/lifetime groups passed. Copy origin/writer/adapters and installed SDK remain separate.`);
}
main().catch(error => { console.error(JSON.stringify({ suite: 'api-key-copy-principal', stage, error: error instanceof Error ? error.name : 'UnknownError',
  code: error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string' ? Reflect.get(error, 'code') : undefined,
  ...(error instanceof assert.AssertionError ? { actual: typeof error.actual === 'number' ? error.actual : typeof error.actual,
    expected: typeof error.expected === 'number' ? error.expected : typeof error.expected } : {}) })); process.exitCode = 1; });

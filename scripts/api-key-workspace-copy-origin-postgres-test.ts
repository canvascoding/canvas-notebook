import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { ApiKeyWorkspaceCopyPrincipal, ApiKeyWorkspaceCopyPurpose } from '../app/lib/api-keys/document-read-principal';
import type { WorkspaceOperationCopyApiKeyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

let stage = 'setup', groups = 0;
const code = (wanted: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === wanted);
async function main() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { FILE_VERSION_CENTER_MODE: 'shadow', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'copy_knowledge_source' });
    const { createApiIntegration, updateApiIntegration, rotateApiKey, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyWorkspaceCopyPrincipal: capture, withApiKeyWorkspaceCopyPrincipalOnConnection: phase } =
      await import('../app/lib/api-keys/document-read-principal');
    const { captureWorkspaceOperationCopyApiKeyOrigin: provenance, captureWorkspaceOperationCopyOrigin: legacy,
      captureWorkspaceOperationCopyMcpOrigin: mcp, decodeWorkspaceOperationCopyOrigin: decode,
      assertWorkspaceOperationCopyOriginCurrent: same } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { withWorkspaceCopyApiKeyOnConnection: compose, withWorkspaceCopyRequestOnConnection: session,
      withWorkspaceCopyAgentOnConnection: pi, withWorkspaceCopyMcpOnConnection: oauth } = await import('../app/lib/workspaces/copy-principal');
    const { serializeWorkspaceOperationRequest, prepareWorkspaceOperationOnConnection } = await import('../app/lib/files/workspace-operation-journal');
    const { apiKeyActorId } = await import('../app/lib/api-keys/actor');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const pool = getPostgresRuntimeQueryable() as unknown as Pool;
    const manager = new Headers((await h.request()).headers); manager.set('Origin', 'http://localhost');
    const workspaces = [h.source.workspaceId, h.destination.workspaceId], actions = ['copy', 'status', 'recover'] as const;
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Copy origin integration',
      workspaceIds: workspaces, actions: [...actions], expiresAt: Date.now() + 3_600_000 });
    let revision = 1, key = issued.key, credentialId = issued.credential.id, statements = 0;
    const authenticate = () => authenticateApiKeyRequest(new Request('http://localhost/api/files/copy', { headers: { 'X-Canvas-API-Key': key } }));
    let credential = await authenticate();
    const selected = (purpose: ApiKeyWorkspaceCopyPurpose, source: 'request' | 'mcp' = 'request') =>
      ({ sourceWorkspaceId: workspaces[0], destinationWorkspaceId: workspaces[1], purpose, source });
    const transaction = async <T>(consume: (database: SqlConnection) => Promise<T>, canonical = false) => {
      const client = await pool.connect();
      const database: SqlConnection = {
        get: async (sql, values) => { statements++; return (await client.query(sql, values)).rows[0]; },
        all: async (sql, values) => { statements++; return (await client.query(sql, values)).rows; },
        run: async (sql, values) => { statements++; return { changes: (await client.query(sql, values)).rowCount ?? 0 }; },
        close: () => assert.fail('Caller owns disposal.'),
      };
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        if (canonical) await client.query("SELECT set_config('search_path',quote_ident($1)||', pg_catalog, pg_temp',true)", [h.schema]);
        const result = await consume(database); await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    const origin = await capture(credential, selected('copy_preview'), principal => transaction(database => phase(database, principal,
      'copy_preview', async current => provenance({ userId: current.userId, integrationId: current.integrationId,
        instanceId: current.instanceId, credentialId: current.credentialId, entryPoint: current.entryPoint,
        sourceWorkspace: current.sourceWorkspace, destinationWorkspace: current.destinationWorkspace }))));
    const check = async (name: string, consume: () => Promise<void>) => { stage = name; await consume(); groups++;
      console.log(`API-key Copy origin passed: ${name}`); };
    const originalPath = 'key-copy-origin/protected.md', originalBytes = Buffer.from('Original Copy-origin control.');
    const originalDocument = await h.upload(originalPath, originalBytes);
    const snapshot = async () => ({ document: (await h.admin.query('SELECT to_jsonb(d) AS row,xmin::text AS xmin FROM collaboration_documents d WHERE id=$1', [originalDocument.documentId])).rows,
      state: (await h.admin.query('SELECT to_jsonb(s) AS row,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [originalDocument.documentId])).rows,
      revisions: (await h.admin.query('SELECT to_jsonb(r) AS row,xmin::text AS xmin FROM file_revisions r WHERE lineage_id=(SELECT lineage_id FROM collaboration_documents WHERE id=$1) ORDER BY id', [originalDocument.documentId])).rows,
      bytes: await readFile(path.join(h.source.rootPath, originalPath)) });
    const before = await snapshot();
    const operationId = randomUUID(), planId = 'a'.repeat(64);
    const prepareOriginal = () => capture(credential, selected('copy_apply'), principal => transaction(database =>
      compose(database, principal, 'copy_apply', origin, current => prepareWorkspaceOperationOnConnection(database, {
        operationId, planId, actor: { type: current.originalOrigin.actor.type, id: current.originalOrigin.actor.userId },
        sourceWorkspaceId: workspaces[0], destinationWorkspaceId: workspaces[1], expectedStepCount: 1,
        request: { kind: 'copy', selections: [{ sourcePath: originalPath, destinationPath: 'target.md' }], origin: current.originalOrigin },
      }))));
    const originalJournal = async () => (await h.admin.query('SELECT request_json,request_hash,xmin::text AS xmin FROM workspace_file_operations WHERE operation_id=$1', [operationId])).rows;
    let savedJournal: Awaited<ReturnType<typeof originalJournal>> | undefined;
    const run = (purpose: ApiKeyWorkspaceCopyPurpose, original = origin, source: 'request' | 'mcp' = 'request', canonical = false) =>
      capture(credential, selected(purpose, source), principal => transaction(database => compose(database, principal, purpose, original, async current => {
        assert.equal(current.sourceWorkspace.permissions.canWrite, false); assert.equal(current.destinationWorkspace.permissions.canWrite, true);
        assert.equal(current.destinationWorkspace.permissions.canDelete, false); assert.equal(current.currentActor.type, 'agent');
        assert.equal(current.currentActor.sessionId, null); assert.deepEqual(current.originalOrigin, original);
        assert.equal(current.currentActor.actorId, original.actor.actorId); assert(Object.isFrozen(current));
        return current.originalOrigin;
      }), canonical));
    await check('strict detached V3 attribution carries stable integration identity and no session or secret', async () => {
      assert.equal(origin.version, 3); assert.equal(origin.transport, 'api-key'); assert.equal(origin.credentialId, credentialId);
      assert.equal(origin.entryPoint, 'request'); assert.equal(origin.actor.sessionId, null);
      assert.equal(origin.actor.actorId, apiKeyActorId({ userId: 'member', integrationId: issued.integration.id, instanceId: process.env.CANVAS_INSTANCE_ID! }));
      assert(Object.isFrozen(origin)); assert(Object.isFrozen(origin.actor)); assert(!JSON.stringify(origin).includes(key));
      assert.deepEqual(decode(JSON.parse(JSON.stringify(origin))), origin);
      for (const invalid of [{ ...origin, actor: { ...origin.actor, sessionId: 'invented-login' } },
        { ...origin, actor: { ...origin.actor, type: 'user' } }, { ...origin, actor: { ...origin.actor, actorId: 'other' } },
        { ...origin, credentialId: '' }, { ...origin, transport: 'direct-mcp' }, { ...origin, entryPoint: 'pi' },
        { ...origin, integrationId: 'different' }, { ...origin, clientId: 'oauth-confusion' }, { ...origin, version: 4 },
        new Proxy(origin, {})]) assert.throws(() => decode(invalid), code('COPY_ORIGIN_INVALID'));
      let getter = false;
      assert.throws(() => decode({ ...origin, get credentialId() { getter = true; return credentialId; } }), code('COPY_ORIGIN_INVALID'));
      assert.equal(getter, false);
      const request = { kind: 'copy' as const, selections: [{ sourcePath: originalPath, destinationPath: 'target.md' }], origin };
      assert.deepEqual(JSON.parse(serializeWorkspaceOperationRequest(request).requestJson).origin, origin);
    });
    await check('all fixed purposes compose genuine current pair authority in raw and native canonical realms', async () => {
      for (const purpose of ['copy_preview', 'copy_apply', 'copy_status', 'copy_recover'] as const) {
        await run(purpose); await run(purpose, origin, 'mcp', true);
      }
    });
    await check('the actual journal durably retains canonical V3 provenance and an exact retry leaves its row unchanged', async () => {
      const prepared = await prepareOriginal();
      assert.equal(prepared.operationId, operationId); assert.deepEqual(JSON.parse(prepared.requestJson).origin, origin);
      savedJournal = await originalJournal(); assert.equal(savedJournal.length, 1);
      await prepareOriginal(); assert.deepEqual(await originalJournal(), savedJournal);
    });
    await check('historical provenance cannot select PI, session, OAuth or another fixed purpose', async () => {
      await transaction(async database => {
        await assert.rejects(session(database, await h.request(), origin, async () => assert.fail('Session provenance confusion.')), code('COPY_ORIGIN_CHANGED'));
        await assert.rejects(pi(database, origin, async () => assert.fail('PI provenance confusion.')), code('COPY_ORIGIN_CHANGED'));
        await assert.rejects(oauth(database, {} as never, origin, async () => assert.fail('OAuth provenance confusion.')), code('COPY_ORIGIN_CHANGED'));
      });
      for (const purpose of ['copy_preview', 'copy_status', 'copy_recover'] as const) await assert.rejects(capture(credential, selected(purpose), principal =>
        transaction(async database => {
          const count = statements;
          await assert.rejects(compose(database, principal, 'copy_apply', origin, async () => assert.fail('Purpose confusion.')), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
          assert.equal(statements, count);
        })), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      const inactive = await capture(credential, selected('copy_apply'), async principal => principal);
      await transaction(async database => {
        for (const principal of [inactive, {}, JSON.parse(JSON.stringify(origin))]) await assert.rejects(
          compose(database, principal as ApiKeyWorkspaceCopyPrincipal, 'copy_apply', origin, async () => assert.fail('No live handle.')),
          code('API_KEY_PRINCIPAL_REQUIRED'));
      });
    });
    await check('another integration, original scope or owner cannot be substituted despite valid current key rights', async () => {
      const other = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Independent Copy owner', workspaceIds: workspaces,
        actions: [...actions], expiresAt: Date.now() + 3_600_000 });
      const otherCredential = await authenticateApiKeyRequest(new Request('http://localhost/api/files/copy', { headers: { 'X-Canvas-API-Key': other.key } }));
      await assert.rejects(capture(otherCredential, selected('copy_apply'), principal => transaction(database =>
        compose(database, principal, 'copy_apply', origin, async () => assert.fail('Other integration.')))), code('COPY_ORIGIN_CHANGED'));
      await revokeApiKey(manager, other.integration.id, { expectedRevision: 1, credentialId: other.credential.id });
      for (const changed of [provenance({ userId: 'owner', integrationId: origin.integrationId, instanceId: origin.instanceId,
        credentialId, entryPoint: 'request', sourceWorkspace: h.source, destinationWorkspace: h.destination }),
      provenance({ userId: 'member', integrationId: origin.integrationId, instanceId: 'another-instance',
        credentialId, entryPoint: 'request', sourceWorkspace: h.source, destinationWorkspace: h.destination }),
      { ...origin, sourceScope: { ...origin.sourceScope, rootPath: `${origin.sourceScope.rootPath}-other` } }]) {
        await assert.rejects(run('copy_apply', changed as WorkspaceOperationCopyApiKeyOrigin), code('COPY_ORIGIN_CHANGED'));
      }
    });
    await check('current ACL, integration allowlist and actual MCP switch remain mandatory around the composed callback', async () => {
      await assert.rejects(capture(credential, selected('copy_apply'), principal => transaction(database => compose(database, principal, 'copy_apply', origin, async () => {
        await database.run("UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id='member'", [workspaces[1]]);
      }))), code('API_KEY_ACCESS_DENIED'));
      await run('copy_apply');
      await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
        workspaceIds: [workspaces[0]], actions: [...actions] });
      await assert.rejects(run('copy_apply'), code('API_KEY_ACCESS_DENIED'));
      await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
        workspaceIds: workspaces, actions: [...actions] });
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source';
      await assert.rejects(run('copy_status', origin, 'mcp'), code('API_KEY_TOOL_DISABLED'));
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'copy_knowledge_source';
    });
    await check('rotation and entry-point changes retain the original credential audit while rejecting old key authority', async () => {
      const oldCredential = credential, rotated = await rotateApiKey(manager, issued.integration.id,
        { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
      key = rotated.key; credentialId = rotated.credential.id; credential = await authenticate();
      assert.notEqual(credentialId, origin.credentialId);
      for (const purpose of ['copy_preview', 'copy_apply', 'copy_status', 'copy_recover'] as const) {
        const original = await run(purpose, origin, 'mcp'); assert.deepEqual(original, origin);
        assert.equal(original.version, 3); if (original.version === 3) {
          assert.equal(original.credentialId, issued.credential.id); assert.equal(original.entryPoint, 'request');
        }
      }
      await assert.rejects(capture(oldCredential, selected('copy_apply'), principal => transaction(database => compose(database, principal,
        'copy_apply', origin, async () => assert.fail('Rotated key.')))), code('API_KEY_INVALID'));
      await prepareOriginal(); assert.deepEqual(await originalJournal(), savedJournal, 'Rotation must preserve all original journal bytes and xmin.');
    });
    await check('legacy and OAuth original sessions keep their established renewal and cross-family behavior', async () => {
      const user = legacy({ actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: 'A' },
        sourceWorkspace: h.source, destinationWorkspace: h.destination });
      assert.deepEqual(same(user, { ...user, actor: { ...user.actor, sessionId: 'B' } }), user);
      const oauthOrigin = mcp({ userId: 'member', clientId: 'real-copy-client', sessionId: 'A', sourceWorkspace: h.source, destinationWorkspace: h.destination });
      assert.deepEqual(same(oauthOrigin, { ...oauthOrigin, actor: { ...oauthOrigin.actor, sessionId: 'B' } }), oauthOrigin);
      assert.throws(() => same(oauthOrigin, origin), code('COPY_ORIGIN_CHANGED'));
      assert.throws(() => same(origin, user), code('COPY_ORIGIN_CHANGED'));
      assert.throws(() => decode({ ...oauthOrigin, actor: { ...oauthOrigin.actor, sessionId: null } }), code('COPY_ORIGIN_INVALID'));
    });
    await check('issuer logout preserves key ownership; actual key revocation ends all subsequent Copy phases', async () => {
      const managerToken = randomBytes(32).toString('hex');
      await h.admin.query("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('key-copy-origin-manager',$1,'member',$2,$3,$3)",
        [managerToken, Date.now() + 3_600_000, Date.now()]);
      assert.equal((await h.admin.query("DELETE FROM session WHERE id='session-member'")).rowCount, 1);
      for (const purpose of ['copy_preview', 'copy_apply', 'copy_status', 'copy_recover'] as const) await run(purpose);
      manager.set('Authorization', `Bearer ${managerToken}`);
      await revokeApiKey(manager, issued.integration.id, { expectedRevision: revision, credentialId });
      for (const purpose of ['copy_preview', 'copy_apply', 'copy_status', 'copy_recover'] as const) await assert.rejects(run(purpose), code('API_KEY_INVALID'));
    });
    assert.deepEqual(await snapshot(), before, 'Provenance/composition must preserve original document, Yjs, revisions, xmin and bytes.');
  });
  console.log(`API-key Copy origin: ${groups} genuine PostgreSQL/auth/origin/composition groups passed. Native Copy writer and public adapters remain separate.`);
}
main().catch(error => { console.error(JSON.stringify({ suite: 'api-key-copy-origin', stage, error: error instanceof Error ? error.name : 'UnknownError',
  code: error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string' ? Reflect.get(error, 'code') : undefined,
  ...(error instanceof assert.AssertionError ? { actual: typeof error.actual === 'number' ? error.actual : typeof error.actual,
    expected: typeof error.expected === 'number' ? error.expected : typeof error.expected } : {}) })); process.exitCode = 1; });

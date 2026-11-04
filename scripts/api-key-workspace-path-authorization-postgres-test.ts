import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { ApiKeyAction } from '../app/lib/api-keys/contracts';
import type { ApiKeyWorkspacePathPrincipal, ApiKeyWorkspacePathPurpose } from '../app/lib/api-keys/document-read-principal';
import type { WorkspaceOperationApiKeyAuthorizationCurrent, WorkspaceOperationApiKeyAuthorization } from '../app/lib/files/workspace-operation-api-key-authorization';
import type { WorkspaceOperationProgrammaticPlan } from '../app/lib/files/workspace-operation-programmatic-plan';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === expected);
let stage = 'setup', groups = 0;
async function main() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { FILE_VERSION_CENTER_MODE: 'shadow', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS: 'move_knowledge_source,delete_knowledge_source' });
    await h.admin.query("UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id='principal-org' AND user_id='member'");
    await h.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [h.source.workspaceId]);
    const { createApiIntegration, rotateApiKey, updateApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyWorkspacePathPrincipal: capture, withApiKeyWorkspacePathPrincipalOnConnection: phase } = await import('../app/lib/api-keys/document-read-principal');
    const { createWorkspaceOperationApiKeyAuthorization: create, decodeWorkspaceOperationApiKeyAuthorization: decode,
      assertWorkspaceOperationApiKeyAuthorizationCurrent: current, workspaceOperationApiKeyBatchId: batchId } = await import('../app/lib/files/workspace-operation-api-key-authorization');
    const { createWorkspaceOperationMcpAuthorization: createMcp, decodeWorkspaceOperationMcpAuthorization: decodeMcp } = await import('../app/lib/files/workspace-operation-mcp-authorization');
    const { buildWorkspaceOperationBatchPlan } = await import('../app/lib/files/workspace-operation-batch-plan');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { apiKeyActorId } = await import('../app/lib/api-keys/actor');
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const pool = getPostgresRuntimeQueryable() as unknown as Pool;
    const workspaceId = h.source.workspaceId, manager = new Headers((await h.request()).headers); manager.set('Origin', 'http://localhost');
    const actions: ApiKeyAction[] = ['move', 'delete', 'status', 'recover']; let revision = 1;
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Native path original attribution',
      workspaceIds: [workspaceId], actions, expiresAt: Date.now() + 3_600_000 });
    let key = issued.key, credentialId = issued.credential.id;
    const authenticate = () => authenticateApiKeyRequest(new Request('http://localhost/api/documents/move', { headers: { 'X-Canvas-API-Key': key } }));
    let credential = await authenticate();
    const transaction = async <T>(principal: ApiKeyWorkspacePathPrincipal, purpose: ApiKeyWorkspacePathPurpose,
      consume: (facts: WorkspaceOperationApiKeyAuthorizationCurrent) => Promise<T>) => {
      const client = await pool.connect();
      const db: SqlConnection = { get: async (sql, values) => (await client.query(sql, values)).rows[0],
        all: async (sql, values) => (await client.query(sql, values)).rows,
        run: async (sql, values) => ({ changes: (await client.query(sql, values)).rowCount ?? 0 }),
        close: () => assert.fail('Caller owns actual transaction disposal.') };
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        const result = await phase(db, principal, purpose, async access => {
          access.assertActive();
          const value = await consume({ userId: access.userId, integrationId: access.integrationId, instanceId: access.instanceId,
            credentialId: access.credentialId, entryPoint: access.entryPoint, workspace: access.workspace,
            kind: purpose.startsWith('move_') ? 'move' : 'delete' });
          await access.assertCurrent(); access.assertActive(); return value;
        });
        await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    const run = <T>(purpose: ApiKeyWorkspacePathPurpose, consume: (facts: WorkspaceOperationApiKeyAuthorizationCurrent) => Promise<T>,
      source: 'request' | 'mcp' = 'request') => capture(credential, { workspaceId, purpose, source }, principal => transaction(principal, purpose, consume));
    const check = async (name: string, consume: () => Promise<void>) => { stage = name; await consume(); groups++; console.log(`API-key path original passed: ${name}`); };
    const targetPath = 'key-path-origin-target.md', incomingPath = 'key-path-origin-incoming.md';
    const target = await h.upload(targetPath, Buffer.from('# Genuine native path original\n'));
    const incoming = await h.upload(incomingPath, Buffer.from(`[Target](${targetPath})\n`));
    const protectedRows = async () => ({ documents: (await h.admin.query('SELECT to_jsonb(d) AS body,xmin::text AS xmin FROM collaboration_documents d ORDER BY id')).rows,
      states: (await h.admin.query('SELECT to_jsonb(s) AS body,xmin::text AS xmin FROM collaboration_yjs_states s ORDER BY document_id')).rows,
      revisions: (await h.admin.query('SELECT to_jsonb(r) AS body,xmin::text AS xmin FROM file_revisions r ORDER BY id')).rows,
      bytes: [await readFile(path.join(h.source.rootPath, targetPath)), await readFile(path.join(h.source.rootPath, incomingPath))],
      jobs: (await h.admin.query('SELECT to_jsonb(j) AS body,xmin::text AS xmin FROM workspace_file_operation_batches j ORDER BY batch_id')).rows });
    const before = await protectedRows(); assert(target.documentId !== incoming.documentId);
    const plans = new Map<'move' | 'delete', WorkspaceOperationProgrammaticPlan>();
    for (const kind of ['move', 'delete'] as const) {
      const scope = await run(`${kind}_preview`, async value => ({ workspace: value.workspace, fileOptions: { workspace: value.workspace } }));
      const actual = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: randomUUID(), kind,
        selections: [{ sourcePath: targetPath, ...(kind === 'move' ? { destinationPath: 'key-path-origin-moved.md' } : {}) }] }] });
      assert(actual.version === (kind === 'move' ? 3 : 2)); assert.equal(actual.readiness, 'ready');
      plans.set(kind, actual as WorkspaceOperationProgrammaticPlan);
    }
    const originals = new Map<'move' | 'delete', WorkspaceOperationApiKeyAuthorization>(), ids = new Map<'move' | 'delete', string>();
    const operationId = 'Key_Path_Operation_0001';
    await check('actual native plans and genuine key phases capture exact sessionless original metadata without effects', async () => {
      for (const kind of ['move', 'delete'] as const) await run(`${kind}_apply`, async facts => {
        const nativePlan = plans.get(kind)!, original = create({ ...facts, plan: nativePlan });
        originals.set(kind, original); ids.set(kind, batchId({ userId: facts.userId, integrationId: facts.integrationId,
          instanceId: facts.instanceId, workspaceId, kind, operationId }));
        assert.equal(Reflect.ownKeys(original).length, 14); assert.equal(original.mode, 'api-key'); assert.equal(original.version, 1);
        assert.equal(original.actorSessionId, null); assert.equal(original.actorType, 'agent'); assert.equal(original.actorDisplayName, 'API integration');
        assert.equal(original.credentialId, issued.credential.id); assert.equal(original.actorUserId, 'member');
        assert.equal(original.actorId, apiKeyActorId(facts)); assert.equal(original.entryPoint, 'request');
        assert(Object.isFrozen(original)); assert(Object.isFrozen(original.jobScope));
        assert(!JSON.stringify(original).includes(key)); assert(!Object.hasOwn(original, 'plan'));
        assert.deepEqual(decode(JSON.parse(JSON.stringify(original))), original);
        assert.deepEqual(current(original, facts, nativePlan), original);
        const mcp = createMcp({ userId: facts.userId, clientId: 'actual-data-only-client', sessionId: 'data-only-session',
          workspace: facts.workspace, tool: kind === 'move' ? 'move_knowledge_source' : 'delete_knowledge_source', plan: nativePlan });
        assert.throws(() => decode(mcp), code('API_KEY_JOB_AUTHORIZATION_INVALID'));
        assert.throws(() => decodeMcp(original), code('MCP_JOB_AUTHORIZATION_INVALID'));
      });
      assert.notEqual(ids.get('move'), ids.get('delete'));
    });
    await check('stored fields, real actor binding, identity, session and hidden authority fields are strict data', async () => {
      const original = originals.get('move')!;
      for (const field of Object.keys(original)) { const missing: Record<string, unknown> = { ...original }; delete missing[field];
        assert.throws(() => decode(missing), code('API_KEY_JOB_AUTHORIZATION_INVALID')); }
      for (const mutation of [{ actorSessionId: 'invented-session' }, { actorType: 'user' }, { actorDisplayName: 'MCP client' },
        { mode: 'direct' }, { mode: 'direct-mcp' }, { version: 2 }, { kind: 'copy' }, { entryPoint: 'pi' },
        { integrationId: 'another-integration' }, { instanceId: 'another-instance' }, { credentialId: '' }, { actorUserId: 'another-user' },
        { actorId: 'unbound-actor' }, { clientId: 'invented-oauth' }, { permissions: { canDelete: true } }, { apiKey: key },
        { requestHash: 'A'.repeat(64) }, { jobScope: { ...original.jobScope, legacy: true } }]) {
        assert.throws(() => decode({ ...original, ...mutation }), code('API_KEY_JOB_AUTHORIZATION_INVALID'));
      }
      let traps = 0;
      assert.throws(() => decode({ ...original, get credentialId() { traps++; return original.credentialId; } }), code('API_KEY_JOB_AUTHORIZATION_INVALID'));
      assert.throws(() => decode(new Proxy(original, { ownKeys() { traps++; return []; } })), code('API_KEY_JOB_AUTHORIZATION_INVALID'));
      assert.equal(traps, 0);
      const mutable = { ...structuredClone(original), jobScope: { ...original.jobScope } }, detached = decode(mutable); mutable.jobScope.rootPath = '/another';
      assert.deepEqual(detached, original);
    });
    await check('full native plan and exact scope integrity reject tampered originals and current selections', async () => {
      for (const kind of ['move', 'delete'] as const) await run(`${kind}_status`, async facts => {
        const nativePlan = plans.get(kind)!, original = originals.get(kind)!;
        for (const mutation of [{ integrationId: 'another' }, { instanceId: 'another' }, { userId: 'another' },
          { workspace: { ...facts.workspace, rootPath: '/another' } }, { kind: kind === 'move' ? 'delete' : 'move' }]) {
          assert.throws(() => current(original, { ...facts, ...mutation } as typeof facts, nativePlan), code('API_KEY_JOB_AUTHORIZATION_CHANGED'));
        }
        assert.throws(() => current({ ...original, requestHash: '0'.repeat(64) }, facts, nativePlan), code('API_KEY_JOB_AUTHORIZATION_CHANGED'));
        for (const mutation of [{ planId: '0'.repeat(64) }, { integrityProof: '0'.repeat(64) }, { unexpected: true }]) {
          assert.throws(() => current(original, facts, { ...nativePlan, ...mutation }), code('API_KEY_JOB_AUTHORIZATION_INVALID'));
        }
        assert.throws(() => current(original, facts, plans.get(kind === 'move' ? 'delete' : 'move')), code('API_KEY_JOB_AUTHORIZATION_INVALID'));
      });
    });
    await check('stable batch identity binds integration, instance, user, workspace, kind and exact caller key', async () => {
      await run('move_status', async facts => {
        const value = { userId: facts.userId, integrationId: facts.integrationId, instanceId: facts.instanceId, workspaceId, kind: 'move' as const, operationId };
        assert.equal(batchId(value), ids.get('move')); assert.match(batchId(value), /^[a-f0-9]{64}$/u);
        for (const mutation of [{ userId: 'different' }, { integrationId: 'different' }, { instanceId: 'different' },
          { workspaceId: 'different' }, { kind: 'delete' as const }, { operationId: operationId.toUpperCase() }]) assert.notEqual(batchId({ ...value, ...mutation }), batchId(value));
        for (const invalid of ['', 'x'.repeat(15), 'x'.repeat(129), operationId + '.', ' ' + operationId, operationId + '\n']) {
          assert.throws(() => batchId({ ...value, operationId: invalid }), code('API_KEY_JOB_AUTHORIZATION_INVALID'));
        }
        const extraCredential = { ...value, credentialId: issued.credential.id };
        assert.throws(() => batchId(extraCredential), code('API_KEY_JOB_AUTHORIZATION_INVALID'));
      });
    });
    await check('actual rotation and another allowed entry point retain original credential and entry attribution', async () => {
      const old = credential, rotated = await rotateApiKey(manager, issued.integration.id,
        { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
      key = rotated.key; credentialId = rotated.credential.id; credential = await authenticate();
      await assert.rejects(capture(old, { workspaceId, purpose: 'move_recover', source: 'request' }, principal => transaction(principal, 'move_recover', async () => assert.fail('Old key.'))), code('API_KEY_INVALID'));
      for (const kind of ['move', 'delete'] as const) await run(`${kind}_recover`, async facts => {
        const original = originals.get(kind)!, observed = current(original, facts, plans.get(kind));
        assert.notEqual(facts.credentialId, original.credentialId); assert.equal(facts.entryPoint, 'mcp'); assert.deepEqual(observed, original);
        assert.equal(batchId({ userId: facts.userId, integrationId: facts.integrationId, instanceId: facts.instanceId,
          workspaceId, kind, operationId }), ids.get(kind));
        const newlyCaptured = create({ ...facts, plan: plans.get(kind) });
        assert.equal(newlyCaptured.credentialId, rotated.credential.id); assert.notEqual(newlyCaptured.requestHash, original.requestHash);
      }, 'mcp');
    });
    await check('stored metadata cannot bypass actual action, current permissions, tool policy or key revocation', async () => {
      await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name, workspaceIds: [workspaceId], actions: ['move'] });
      for (const kind of ['move', 'delete'] as const) await assert.rejects(run(`${kind}_recover`, async facts => current(originals.get(kind), facts, plans.get(kind))), code('API_KEY_ACCESS_DENIED'));
      await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name, workspaceIds: [workspaceId], actions });
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'move_knowledge_source';
      await assert.rejects(run('delete_recover', async facts => current(originals.get('delete'), facts, plans.get('delete')), 'mcp'), code('API_KEY_TOOL_DISABLED'));
      await h.admin.query("UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id='member'", [workspaceId]);
      await assert.rejects(run('move_recover', async facts => current(originals.get('move'), facts, plans.get('move'))), code('API_KEY_ACCESS_DENIED'));
      await h.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [workspaceId]);
      await revokeApiKey(manager, issued.integration.id, { expectedRevision: revision, credentialId });
      await assert.rejects(run('move_status', async facts => current(originals.get('move'), facts, plans.get('move'))), code('API_KEY_INVALID'));
    });
    assert.deepEqual(await protectedRows(), before, 'Metadata preparation must preserve all original document/Yjs/history/job rows and bytes.');
  });
  console.log(`API-key path original: ${groups} genuine PostgreSQL/key/native-plan groups passed; native key job owners and public adapters remain separate.`);
}
main().catch(error => { console.error(JSON.stringify({ suite: 'api-key-path-original', stage, error: error instanceof Error ? error.name : 'UnknownError',
  code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined,
  ...(error instanceof assert.AssertionError ? { actual: typeof error.actual === 'number' ? error.actual : typeof error.actual,
    expected: typeof error.expected === 'number' ? error.expected : typeof error.expected } : {}) })); process.exitCode = 1; });

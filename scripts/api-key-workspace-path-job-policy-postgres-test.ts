import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceOperationBatchClaim, WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import type { WorkspaceOperationApiKeyJobPrincipal } from '../app/lib/workspaces/workspace-operation-api-key-job-principal';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

type Kind = 'move' | 'delete';
type Purpose = WorkspaceOperationApiKeyJobPrincipal['purpose'];
const errorCode = (error: unknown): string | undefined => {
  const value = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  return typeof value === 'string' && /^[A-Z0-9_]{1,128}$/u.test(value) ? value : undefined;
};
const code = (...expected: string[]) => (error: unknown) => expected.includes(errorCode(error) ?? '');
let stage = 'setup', groups = 0;
async function main() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    await h.admin.query("UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id='principal-org' AND user_id='member'");
    await h.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [h.source.workspaceId]);
    const { auth } = await import('../app/lib/auth');
    const { openDb } = await import('../app/lib/db');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { createApiIntegration, rotateApiKey, updateApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyWorkspacePathPrincipal: capture } = await import('../app/lib/api-keys/document-read-principal');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { buildWorkspaceOperationBatchPlan } = await import('../app/lib/files/workspace-operation-batch-plan');
    const { captureWorkspaceOperationApiKeyJobPrincipal: holder } =
      await import('../app/lib/workspaces/workspace-operation-api-key-job-principal');
    const { withWorkspaceOperationProgrammaticJobPolicyOnConnection: policy, captureWorkspaceOperationProgrammaticJobOptions: options } =
      await import('../app/lib/workspaces/workspace-operation-programmatic-job-principal');
    const manager = new Headers((await h.request()).headers); manager.set('Origin', 'http://localhost');
    const session = await auth.api.getSession({ headers: manager }); assert(session); assert.equal(session.user.id, 'member');
    const workspace = await readPostgresWorkspaceForActorOnConnection(h.connection, resolveWorkspaceActor(session.user), h.source.workspaceId); assert(workspace);
    const workspaceId = workspace.workspaceId, actions = ['move', 'delete', 'status', 'recover'] as const;
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Native path job policy', workspaceIds: [workspaceId],
      actions: [...actions], expiresAt: Date.now() + 3_600_000 });
    let key = issued.key, credentialId = issued.credential.id, revision = 1;
    const authenticate = (value = key) => authenticateApiKeyRequest(new Request('http://localhost/api/documents/move',
      { headers: { 'X-Canvas-API-Key': value } }));
    const sourcePath = 'key-job-policy-source.md', incomingPath = 'key-job-policy-incoming.md';
    await h.upload(sourcePath, Buffer.from('# Actual policy original\n'));
    await h.upload(incomingPath, Buffer.from(`[Source](${sourcePath})\n`));
    const protectedSnapshot = async () => ({
      documents: (await h.admin.query('SELECT to_jsonb(d) AS body,xmin::text AS xmin FROM collaboration_documents d ORDER BY id')).rows,
      states: (await h.admin.query('SELECT to_jsonb(s) AS body,xmin::text AS xmin FROM collaboration_yjs_states s ORDER BY document_id')).rows,
      history: (await h.admin.query('SELECT to_jsonb(r) AS body,xmin::text AS xmin FROM file_revisions r ORDER BY id')).rows,
      intents: (await h.admin.query('SELECT to_jsonb(i) AS body,xmin::text AS xmin FROM collaboration_native_file_operation_intents i ORDER BY operation_id')).rows,
      bytes: [await readFile(path.join(workspace.rootPath, sourcePath)), await readFile(path.join(workspace.rootPath, incomingPath))],
    });
    const before = await protectedSnapshot(), store = new WorkspaceOperationBatchStore();
    const scope = { workspace, fileOptions: { workspace } };
    const move = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: randomUUID(), kind: 'move',
      selections: [{ sourcePath, destinationPath: 'key-job-policy-moved.md' }] }] });
    const deletion = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: randomUUID(), kind: 'delete', selections: [{ sourcePath }] }] });
    assert(move.version === 3); assert(deletion.version === 2);
    const jobs = { move: { plan: move, operationId: randomUUID() }, delete: { plan: deletion, operationId: randomUUID() } };
    const originals = new Map<Kind, { batch: WorkspaceOperationBatchRecord; authorization: string; plan: string }>();
    const transaction = async <T>(claim: WorkspaceOperationBatchClaim, principal: WorkspaceOperationApiKeyJobPrincipal,
      consume: Parameters<typeof policy<T>>[2], options: { readOnly?: boolean; changeRealm?: boolean } = {}): Promise<T> => {
      const database = await openDb(); let failure: Error | undefined;
      try {
        await database.run(options.readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        if (options.changeRealm) await database.run('SET LOCAL search_path=pg_catalog');
        const result = await policy(database, { claim, principal }, consume); await database.run('COMMIT'); return result;
      } catch (error) {
        failure = error instanceof Error ? error : new Error('Policy phase failed.');
        try { await database.run('ROLLBACK'); } catch (rollback) { failure = new AggregateError([failure, rollback]); }
        throw failure;
      } finally { await database.close(failure); }
    };
    type CurrentJob = { claim: WorkspaceOperationBatchClaim; principal: WorkspaceOperationApiKeyJobPrincipal; batch: WorkspaceOperationBatchRecord };
    const withJob = async <T>(kind: Kind, purpose: Purpose, consume: (job: CurrentJob) => Promise<T>): Promise<T> => {
      const credential = await authenticate(), job = jobs[kind]; let claimed: WorkspaceOperationBatchRecord | undefined;
      try {
        return await capture(credential, { workspaceId, purpose, source: 'request' }, async principal => {
          const result = originals.has(kind)
            ? await store.claimExistingApiKeyPath(principal, purpose, { operationId: job.operationId, workspaceId, planId: job.plan.planId })
            : kind === 'move' ? await store.createApiKeyMoveAndClaim(principal, { operationId: job.operationId, plan: move })
              : await store.createApiKeyDeleteAndClaim(principal, { operationId: job.operationId, plan: deletion });
          assert(result.kind === 'claimed'); claimed = result.batch;
          if (!originals.has(kind)) {
            const row = (await h.admin.query('SELECT authorization_json,plan_json FROM workspace_file_operation_batches WHERE batch_id=$1', [claimed.batchId])).rows[0];
            originals.set(kind, { batch: claimed, authorization: row.authorization_json, plan: row.plan_json });
          }
          const selected = options({ apiKeyPrincipal: holder({ transport: 'api-key', kind, purpose, principal }) });
          assert(selected && 'transport' in selected); assert.equal(selected.principal, principal);
          return store.withClaim(claimed, async claim => {
            const value = await consume({ claim, batch: result.batch, principal: selected });
            assert(await store.finishClaim(result.batch, { status: 'needs_recovery', errorCode: 'FIXTURE_POLICY_ONLY' })); return value;
          });
        });
      } finally {
        // A failed genuine phase may poison its in-memory claim. Simulate only
        // its dead lease; a subsequent genuine explicit Recover must reclaim
        // it. Never manufacture a completed header or change Original bytes.
        if (claimed && (await store.get(claimed.batchId))?.status === 'applying')
          await h.admin.query('UPDATE workspace_file_operation_batches SET lease_expires_at=$2 WHERE batch_id=$1', [claimed.batchId, Date.now() - 1000]);
      }
    };
    const assertOriginals = async () => {
      for (const original of originals.values()) {
        const row = (await h.admin.query('SELECT authorization_json,plan_json FROM workspace_file_operation_batches WHERE batch_id=$1', [original.batch.batchId])).rows[0];
        assert.equal(row.authorization_json, original.authorization); assert.equal(row.plan_json, original.plan);
      }
    };
    const check = async (name: string, consume: () => Promise<void>) => { stage = name; await consume(); groups++; console.log(`API-key job policy passed: ${name}`); };
    await check('strict holder data cannot execute getters, coercions or substitute stored metadata for a claim', async () => {
      let touched = false;
      const principal = { transport: 'api-key', kind: 'move', purpose: 'move_apply', principal: {} };
      assert.throws(() => holder({ ...principal, kind: { toString() { touched = true; throw new Error('Unexpected coercion.'); } } }), code('API_KEY_JOB_PRINCIPAL_INVALID'));
      assert.throws(() => holder(Object.defineProperty({ ...principal }, 'purpose', { enumerable: true, get() { touched = true; return 'move_apply'; } })), code('API_KEY_JOB_PRINCIPAL_INVALID'));
      assert.throws(() => holder(new Proxy(principal, { get() { touched = true; throw new Error('Unexpected Proxy access.'); } })), code('API_KEY_JOB_PRINCIPAL_INVALID'));
      for (const purpose of ['move_preview', 'move_status', 'delete_preview', 'delete_status'])
        assert.throws(() => holder({ ...principal, purpose }), code('API_KEY_JOB_PRINCIPAL_INVALID'));
      assert.throws(() => options({ mcpPrincipal: principal }), code('MCP_JOB_PRINCIPAL_INVALID'));
      assert.throws(() => options({ mcpPrincipal: { kind: 'move', principal: {} }, apiKeyPrincipal: principal }), code('BATCH_CLAIM_CHANGED'));
      assert.throws(() => options(Object.defineProperty({}, 'apiKeyPrincipal', { enumerable: true, get() { touched = true; return principal; } })), code('BATCH_CLAIM_CHANGED'));
      assert.equal(touched, false);
      const credential = await authenticate();
      await capture(credential, { workspaceId, purpose: 'move_apply', source: 'request' }, async live => {
        let queries = 0;
        const unused = { get: async () => { queries++; assert.fail('No claim may reach SQL.'); } } as unknown as SqlConnection;
        await assert.rejects(policy(unused, { claim: {} as WorkspaceOperationBatchClaim,
          principal: holder({ ...principal, principal: live }) }, async () => assert.fail('Forged claim.')), code('BATCH_CLAIM_REQUIRED'));
        await assert.rejects(policy(unused, { claim: {} as WorkspaceOperationBatchClaim,
          principal: holder({ ...principal, principal: live }), permissions: { canWrite: true } } as unknown as Parameters<typeof policy>[1],
        async () => assert.fail('Unexpected authority field.')), code('BATCH_CLAIM_CHANGED'));
        assert.equal(queries, 0);
      });
    });
    await check('actual Move and Delete claims share current key authority and retain the original sessionless actor', async () => {
      for (const kind of ['move', 'delete'] as const) await withJob(kind, `${kind}_apply`, job => transaction(job.claim, job.principal, async access => {
        assert(access.transport === 'api-key'); assert.equal(access.userId, 'member'); assert.equal(access.integrationId, issued.integration.id);
        assert.equal(access.currentCredentialId, credentialId); assert.equal(access.actorSessionId, null); assert.equal(access.actorType, 'agent');
        assert.equal(Object.hasOwn(access, 'piSessionId'), false); assert.equal(access.batchId, job.batch.batchId);
        assert(job.batch.authorization.mode === 'api-key'); assert.equal(access.actorId, job.batch.authorization.actorId);
        await access.assertCurrent(); assert.equal(access.workspace.workspaceId, workspaceId);
      }));
      await assertOriginals(); assert.deepEqual(await protectedSnapshot(), before);
    });
    await check('wrong operation, fixed purpose and forged live handles cannot borrow a genuine claim', async () => {
      await assert.rejects(withJob('move', 'move_recover', job => transaction(job.claim,
        holder({ ...job.principal, kind: 'delete', purpose: 'delete_recover' }), async () => assert.fail('Wrong kind.'))), code('API_KEY_JOB_PRINCIPAL_CHANGED'));
      await assert.rejects(withJob('move', 'move_recover', job => transaction(job.claim,
        holder({ ...job.principal, purpose: 'move_apply' }), async () => assert.fail('Wrong purpose.'))), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(withJob('move', 'move_recover', job => transaction(job.claim,
        holder({ ...job.principal, principal: {} }), async () => assert.fail('Forged handle.'))), code('API_KEY_PRINCIPAL_REQUIRED'));
      await withJob('move', 'move_recover', job => transaction(job.claim, job.principal, async access => { await access.assertCurrent(); }));
      await assertOriginals(); assert.deepEqual(await protectedSnapshot(), before);
    });
    await check('actual wrong-realm and read-only transactions are rejected without domain changes', async () => {
      for (const options of [{ changeRealm: true }, { readOnly: true }]) await assert.rejects(withJob('delete', 'delete_recover', job =>
        transaction(job.claim, job.principal, async () => assert.fail('Invalid B.'), options)), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await withJob('delete', 'delete_recover', job => transaction(job.claim, job.principal, async access => { await access.assertCurrent(); }));
      await assertOriginals(); assert.deepEqual(await protectedSnapshot(), before);
    });
    await check('actual rotation retains original attribution while a renewed key proves current authority', async () => {
      const oldKey = key, rotated = await rotateApiKey(manager, issued.integration.id,
        { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
      key = rotated.key; credentialId = rotated.credential.id; await assert.rejects(authenticate(oldKey), code('API_KEY_INVALID'));
      for (const kind of ['move', 'delete'] as const) await withJob(kind, `${kind}_recover`, job => transaction(job.claim, job.principal, async access => {
        assert(access.transport === 'api-key'); assert.equal(access.currentCredentialId, credentialId); assert(job.batch.authorization.mode === 'api-key');
        assert.equal(job.batch.authorization.credentialId, issued.credential.id); await access.assertCurrent();
      }));
      await assertOriginals(); assert.deepEqual(await protectedSnapshot(), before);
    });
    await check('real action withdrawal and key revocation after claim COMMIT deny the next policy B', async () => {
      await assert.rejects(withJob('move', 'move_recover', async job => {
        await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
          workspaceIds: [workspaceId], actions: ['read'] });
        return transaction(job.claim, job.principal, async () => assert.fail('Withdrawn action.'));
      }), code('API_KEY_ACCESS_DENIED'));
      await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
        workspaceIds: [workspaceId], actions: [...actions] });
      await withJob('move', 'move_recover', job => transaction(job.claim, job.principal, async access => { await access.assertCurrent(); }));
      await assert.rejects(withJob('delete', 'delete_recover', async job => {
        await revokeApiKey(manager, issued.integration.id, { expectedRevision: revision, credentialId });
        return transaction(job.claim, job.principal, async () => assert.fail('Revoked key.'));
      }), code('API_KEY_INVALID'));
      await assertOriginals(); assert.deepEqual(await protectedSnapshot(), before);
    });
  });
  console.log(`API-key job policy: ${groups} genuine PostgreSQL/key/claim/policy groups passed; native effects and public adapters remain separate.`);
}
main().catch(error => { console.error(JSON.stringify({ suite: 'api-key-path-job-policy', stage,
  name: error instanceof Error ? error.name : 'UnknownError', code: errorCode(error),
  assertion: error instanceof assert.AssertionError ? { operator: error.operator, actualCode: errorCode(error.actual) } : undefined,
  stack: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s*at\b/u.test(line)).slice(0, 4) : [] })); process.exitCode = 1; });

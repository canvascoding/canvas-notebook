import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApiKeyWorkspacePathPrincipal, ApiKeyWorkspacePathPurpose } from '../app/lib/api-keys/document-read-principal';
import type { WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === expected);
let stage = 'setup', groups = 0;
async function main() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    await h.admin.query("UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id='principal-org' AND user_id='member'");
    await h.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [h.source.workspaceId]);
    const { auth } = await import('../app/lib/auth');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { createApiIntegration, rotateApiKey, updateApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyWorkspacePathPrincipal: capture, withApiKeyDocumentReadPrincipal: readCapture } = await import('../app/lib/api-keys/document-read-principal');
    const { WorkspaceOperationBatchStore, readWorkspaceOperationBatchClaimBinding } = await import('../app/lib/files/workspace-operation-batch-store');
    const { buildWorkspaceOperationBatchPlan } = await import('../app/lib/files/workspace-operation-batch-plan');
    const { workspaceOperationApiKeyBatchId } = await import('../app/lib/files/workspace-operation-api-key-authorization');
    const manager = new Headers((await h.request()).headers); manager.set('Origin', 'http://localhost');
    const session = await auth.api.getSession({ headers: manager }); assert.equal(session?.user.id, 'member'); assert(session);
    const workspace = await readPostgresWorkspaceForActorOnConnection(h.connection, resolveWorkspaceActor(session.user), h.source.workspaceId); assert(workspace);
    const workspaceId = workspace.workspaceId, scope = { workspace, fileOptions: { workspace } };
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Native key path claim', workspaceIds: [workspaceId],
      actions: ['move', 'delete', 'status', 'recover'], expiresAt: Date.now() + 3_600_000 });
    let key = issued.key, credentialId = issued.credential.id, revision = 1;
    const authenticate = () => authenticateApiKeyRequest(new Request('http://localhost/api/documents/move', { headers: { 'X-Canvas-API-Key': key } }));
    let credential = await authenticate();
    const run = <T>(purpose: ApiKeyWorkspacePathPurpose, consume: (principal: ApiKeyWorkspacePathPrincipal) => Promise<T>) =>
      capture(credential, { workspaceId, purpose, source: 'request' }, consume);
    const targetPath = 'key-claim-target.md', incomingPath = 'key-claim-incoming.md';
    await h.upload(targetPath, Buffer.from('# Native key claim target\n')); await h.upload(incomingPath, Buffer.from(`[Target](${targetPath})\n`));
    const protectedSnapshot = async () => ({
      docs: (await h.admin.query('SELECT to_jsonb(d) AS body,xmin::text AS xmin FROM collaboration_documents d ORDER BY id')).rows,
      states: (await h.admin.query('SELECT to_jsonb(s) AS body,xmin::text AS xmin FROM collaboration_yjs_states s ORDER BY document_id')).rows,
      history: (await h.admin.query('SELECT to_jsonb(r) AS body,xmin::text AS xmin FROM file_revisions r ORDER BY id')).rows,
      intents: (await h.admin.query('SELECT to_jsonb(i) AS body,xmin::text AS xmin FROM collaboration_native_file_operation_intents i ORDER BY operation_id')).rows,
      bytes: [await readFile(path.join(workspace.rootPath, targetPath)), await readFile(path.join(workspace.rootPath, incomingPath))],
    });
    const before = await protectedSnapshot(), store = new WorkspaceOperationBatchStore();
    const move = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: randomUUID(), kind: 'move', selections: [{ sourcePath: targetPath, destinationPath: 'key-claim-moved.md' }] }] });
    const deletion = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: randomUUID(), kind: 'delete', selections: [{ sourcePath: targetPath }] }] });
    assert(move.version === 3); assert(deletion.version === 2);
    const jobs = [{ kind: 'move' as const, plan: move, operationId: randomUUID() }, { kind: 'delete' as const, plan: deletion, operationId: randomUUID() }];
    const release = (batch: WorkspaceOperationBatchRecord) => store.withClaim(batch, async claim => {
      const bound = readWorkspaceOperationBatchClaimBinding(claim); assert.equal(bound.authorization.mode, 'api-key');
      assert.equal(bound.actionMode, 'apply'); assert.equal(bound.source.schemaName, h.schema);
      stage = 'finish_registered_key_claim';
      const ordinary = await h.connection.get("SELECT pg_catalog.current_setting('search_path') AS path");
      if (ordinary.path !== bound.source.searchPath) console.log(JSON.stringify({ test: 'key-claim-realm-diagnostic',
        ordinaryPath: ordinary.path, boundPath: bound.source.searchPath }));
      const finished = await store.finishClaim(batch, { status: 'needs_recovery', errorCode: 'FIXTURE_CLAIM_ONLY' }); assert(finished);
      assert.equal(finished.status, 'needs_recovery'); return finished;
    });
    const check = async (name: string, consume: () => Promise<void>) => { stage = name; await consume(); groups++; console.log(`API-key path claim passed: ${name}`); };
    const originals = new Map<string, { batch: WorkspaceOperationBatchRecord; authorization: string; plan: string }>();
    await check('genuine Move/Delete claim COMMIT mints opaque proof and preserves exact key Original without domain effects', async () => {
      for (const job of jobs) await run(`${job.kind}_apply`, async principal => {
        const result = job.kind === 'move' ? await store.createApiKeyMoveAndClaim(principal, { operationId: job.operationId, plan: move })
          : await store.createApiKeyDeleteAndClaim(principal, { operationId: job.operationId, plan: deletion });
        assert.equal(result.kind, 'claimed'); assert(result.kind === 'claimed');
        const original = result.batch.authorization; assert(original.mode === 'api-key'); assert.equal(original.actorSessionId, null);
        assert.equal(original.credentialId, credentialId); assert.equal(original.entryPoint, 'request'); assert.equal(original.actorUserId, 'member');
        const row = (await h.admin.query('SELECT authorization_json,plan_json FROM workspace_file_operation_batches WHERE batch_id=$1', [result.batch.batchId])).rows[0];
        assert(!row.authorization_json.includes(key)); assert.deepEqual(JSON.parse(row.authorization_json), original);
        await assert.rejects(store.withClaim({ ...result.batch }, async () => assert.fail('Copied header is not a claim.')), code('BATCH_CLAIM_REQUIRED'));
        const batch = await release(result.batch); originals.set(job.kind, { batch, authorization: row.authorization_json, plan: row.plan_json });
      });
      assert.deepEqual(await protectedSnapshot(), before);
    });
    await check('fixed purposes, Read family and forged handles cannot borrow actual claim authority', async () => {
      await assert.rejects(run('move_preview', principal => store.createApiKeyMoveAndClaim(principal, { operationId: randomUUID(), plan: move })), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(run('delete_apply', principal => store.createApiKeyMoveAndClaim(principal, { operationId: randomUUID(), plan: move })), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(store.createApiKeyMoveAndClaim(Object.freeze({}) as ApiKeyWorkspacePathPrincipal, { operationId: randomUUID(), plan: move }), code('API_KEY_PRINCIPAL_REQUIRED'));
      await assert.rejects(readCapture(credential, { workspaceId, purpose: 'read' }, () => undefined,
        principal => store.createApiKeyMoveAndClaim(principal as unknown as ApiKeyWorkspacePathPrincipal, { operationId: randomUUID(), plan: move })), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
    });
    await check('genuine issuer Cookie cannot read or resume a key job through ordinary Web batch routes', async () => {
      const { NextRequest } = await import('next/server');
      const { GET, POST } = await import('../app/api/files/operations/batches/[batchId]/route');
      const batchRows = async () => (await h.admin.query(`SELECT to_jsonb(b) AS body,xmin::text AS xmin
        FROM workspace_file_operation_batches b ORDER BY batch_id`)).rows;
      const originalRows = await batchRows(), protectedBefore = await protectedSnapshot();
      for (const job of jobs) {
        const original = originals.get(job.kind)!;
        const context = { params: Promise.resolve({ batchId: original.batch.batchId }) };
        const url = `http://localhost/api/files/operations/batches/${original.batch.batchId}`;
        for (const response of [await GET(new NextRequest(url, { headers: manager }), context),
          await POST(new NextRequest(url, { method: 'POST', headers: manager,
            body: JSON.stringify({ action: 'resume', planId: job.plan.planId }) }), context)]) {
          assert.equal(response.status, 403);
          assert.equal((await response.json()).code, 'BATCH_API_KEY_AUTHORIZATION_REQUIRED');
        }
      }
      assert.deepEqual(await batchRows(), originalRows);
      assert.deepEqual(await protectedSnapshot(), protectedBefore);
    });
    await check('actual rotation and explicit recovery retain original attribution and the exact native plan', async () => {
      const old = credential, rotated = await rotateApiKey(manager, issued.integration.id,
        { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
      key = rotated.key; credentialId = rotated.credential.id; credential = await authenticate();
      await assert.rejects(capture(old, { workspaceId, purpose: 'move_recover', source: 'request' }, principal =>
        store.claimExistingApiKeyPath(principal, 'move_recover', { operationId: jobs[0].operationId, workspaceId, planId: move.planId })), code('API_KEY_INVALID'));
      for (const job of jobs) await run(`${job.kind}_recover`, async principal => {
        const result = await store.claimExistingApiKeyPath(principal, `${job.kind}_recover`, { operationId: job.operationId, workspaceId, planId: job.plan.planId });
        assert(result.kind === 'claimed'); const original = originals.get(job.kind)!;
        assert.deepEqual(result.batch.authorization, original.batch.authorization); assert.notEqual(result.batch.authorization.mode === 'api-key' && result.batch.authorization.credentialId, credentialId);
        const rows = (await h.admin.query('SELECT authorization_json,plan_json FROM workspace_file_operation_batches WHERE batch_id=$1', [result.batch.batchId])).rows[0];
        assert.equal(rows.authorization_json, original.authorization); assert.equal(rows.plan_json, original.plan); await release(result.batch);
      });
    });
    await check('ordinary queue, claim, loose heartbeat and finish cannot adopt expired API-key jobs', async () => {
      for (const [kind, original] of originals) {
        await h.admin.query("UPDATE workspace_file_operation_batches SET status='applying',lease_owner='fixture-dead-owner',lease_token='fixture-dead-token',lease_expires_at=$2 WHERE batch_id=$1", [original.batch.batchId, Date.now() - 1]);
        const snapshot = async () => (await h.admin.query('SELECT to_jsonb(b) AS body,xmin::text AS xmin FROM workspace_file_operation_batches b WHERE batch_id=$1', [original.batch.batchId])).rows;
        const frozen = await snapshot(); assert.equal(await store.claim('ordinary-fixture-worker'), null);
        await assert.rejects(store.enqueue({ batchId: original.batch.batchId, planId: original.batch.planId, userId: 'member', displayName: 'Member', action: 'resume' }), code('BATCH_DIRECT_AUTHORIZATION_REQUIRED'));
        await assert.rejects(store.heartbeat(original.batch.batchId, 'fixture-dead-owner'), code('BATCH_DIRECT_AUTHORIZATION_REQUIRED'));
        await assert.rejects(store.finish(original.batch.batchId, 'fixture-dead-owner', { status: 'applied' }), code('BATCH_DIRECT_AUTHORIZATION_REQUIRED'));
        assert.deepEqual(await snapshot(), frozen);
        // Keep the production invariant of one applying header per workspace:
        // explicitly recover this dead lease before arranging the next one.
        const job = jobs.find(value => value.kind === kind)!;
        await run(`${job.kind}_recover`, async principal => {
          const result = await store.claimExistingApiKeyPath(principal, `${job.kind}_recover`, { operationId: job.operationId, workspaceId, planId: job.plan.planId }); assert(result.kind === 'claimed'); await release(result.batch);
        });
      }
    });
    await check('lost actual claim COMMIT acknowledgement grants no copied-header capability and explicit recovery retains Original', async () => {
      const operationId = randomUUID(); let faulted = false, writer: unknown;
      await assert.rejects(h.withProbe(async event => {
        if (/^\s*INSERT INTO\s+(?:"[^"]+"\.)?workspace_file_operation_batches\b/iu.test(event.text)) writer = event.client;
        if (!faulted && writer === event.client && /^\s*COMMIT\s*$/iu.test(event.text)) { faulted = true;
          throw Object.assign(new Error('Lost actual key claim COMMIT acknowledgement.'), { code: 'EIO' }); }
      }, () => run('move_apply', principal => store.createApiKeyMoveAndClaim(principal, { operationId, plan: move }))), code('BATCH_CLAIM_COMMIT_UNCONFIRMED'));
      assert(faulted);
      const batchId = workspaceOperationApiKeyBatchId({ userId: 'member', integrationId: issued.integration.id, instanceId: process.env.CANVAS_INSTANCE_ID!, workspaceId, kind: 'move', operationId });
      const persisted = await store.get(batchId); assert(persisted); assert.equal(persisted.authorization.mode, 'api-key');
      await assert.rejects(store.withClaim(persisted, async () => assert.fail('Unconfirmed header grants no claim.')), code('BATCH_CLAIM_REQUIRED'));
      await h.admin.query('UPDATE workspace_file_operation_batches SET lease_expires_at=$2 WHERE batch_id=$1', [batchId, Date.now() - 1]);
      await run('move_recover', async principal => { const result = await store.claimExistingApiKeyPath(principal, 'move_recover', { operationId, workspaceId, planId: move.planId });
        assert(result.kind === 'claimed'); assert.deepEqual(result.batch.authorization, persisted.authorization); await release(result.batch); });
    });
    await check('unknown recovery and actual withdrawn grants/revocation never prepare or resume a job', async () => {
      const count = async () => Number((await h.admin.query('SELECT count(*)::integer AS n FROM workspace_file_operation_batches')).rows[0].n), originalCount = await count();
      await run('move_recover', async principal => assert.deepEqual(await store.claimExistingApiKeyPath(principal, 'move_recover', { operationId: randomUUID(), workspaceId, planId: move.planId }), { kind: 'absent' }));
      assert.equal(await count(), originalCount);
      await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name, workspaceIds: [workspaceId], actions: ['move'] });
      await assert.rejects(run('move_recover', principal => store.claimExistingApiKeyPath(principal, 'move_recover', { operationId: jobs[0].operationId, workspaceId, planId: move.planId })), code('API_KEY_ACCESS_DENIED'));
      await revokeApiKey(manager, issued.integration.id, { expectedRevision: revision, credentialId });
      await assert.rejects(run('move_apply', principal => store.createApiKeyMoveAndClaim(principal, { operationId: randomUUID(), plan: move })), code('API_KEY_INVALID'));
    });
    assert.deepEqual(await protectedSnapshot(), before);
  });
  console.log(`API-key path claims: ${groups} genuine PostgreSQL/key/claim groups passed; native effects and public adapters remain separate.`);
}
main().catch(error => { console.error(JSON.stringify({ suite: 'api-key-path-claim', stage, error: error instanceof Error ? error.name : 'UnknownError',
  code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined,
  ...(error instanceof assert.AssertionError ? { actual: typeof error.actual === 'number' ? error.actual : typeof error.actual,
    expected: typeof error.expected === 'number' ? error.expected : typeof error.expected } : {}) })); process.exitCode = 1; });

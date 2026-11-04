import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';
import { seedNativeCopyMixedSource } from './helpers/native-copy-mixed-source-fixture';
import { withInstalledApiKeySdkMcpFixture } from './helpers/installed-api-key-sdk-mcp-fixture';

let stage = 'setup';
async function main() {
  const python = process.env.CANVAS_SDK_TEST_PYTHON, wheel = process.env.CANVAS_SDK_TEST_WHEEL;
  assert(python && wheel);
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { BASE_URL: 'http://localhost', FILE_VERSION_CENTER_MODE: 'shadow', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS: 'copy_knowledge_source,read_knowledge_source,get_knowledge_manifest' });
    const { createApiIntegration, rotateApiKey, updateApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const manager = new Headers((await h.request()).headers); manager.set('Origin', 'http://localhost');
    const workspaceIds = [h.source.workspaceId, h.destination.workspaceId], actions = ['read', 'copy', 'status', 'recover'] as const;
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Installed native Copy SDK', workspaceIds,
      actions: [...actions], expiresAt: Date.now() + 3_600_000 });
    let revision = 1, credentialId = issued.credential.id;
    const managerToken = randomBytes(32).toString('hex');
    await h.admin.query("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('sdk-copy-manager',$1,'member',$2,$3,$3)",
      [managerToken, Date.now() + 3_600_000, Date.now()]);
    const original = await seedNativeCopyMixedSource(h), staging = new WorkspaceOperationStaging();
    const job = (name: string) => ({ operationId: randomUUID(), destinationPath: `sdk-${name}-${randomUUID()}` });
    const baseline = job('baseline'), collision = job('collision'), lostHttp = job('http-loss'), lostB1 = job('b1-loss');
    const count = async () => Number((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_native_copy_receipts')).rows[0].n);
    const beforeCount = await count();
    const receipt = async (id: string) => (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [id])).rows[0];
    const immutable = async (id: string) => (await h.admin.query(`SELECT 'native' AS kind,to_jsonb(r)::text AS body,xmin::text AS xmin FROM collaboration_native_copy_receipts r WHERE operation_id=$1
      UNION ALL SELECT 'scene',to_jsonb(r)::text,xmin::text FROM collaboration_excalidraw_copy_receipts r WHERE operation_id=$1
      UNION ALL SELECT 'journal',to_jsonb(r)::text,xmin::text FROM workspace_file_operations r WHERE operation_id=$1
      UNION ALL SELECT 'step',to_jsonb(r)::text,xmin::text FROM workspace_file_operation_steps r WHERE operation_id=$1 ORDER BY kind,body`, [id])).rows;
    const verify = async (selected: typeof baseline) => {
      const native = await receipt(selected.operationId); assert(native); assert.equal(native.actor_session_id, null);
      assert.equal(native.publication_status, 'published'); assert.equal(native.private_result.documents.length, 2);
      const journal = (await h.admin.query('SELECT status,request_json FROM workspace_file_operations WHERE operation_id=$1', [selected.operationId])).rows[0];
      assert.equal(journal.status, 'completed'); assert.equal(JSON.parse(journal.request_json).origin.version, 3);
      assert.deepEqual(await readFile(path.join(h.destination.rootPath, selected.destinationPath, 'manual.pdf')), original.pdf);
      assert.deepEqual(await original.sourceSnapshot(), original.sourceBefore); assert.equal(await staging.loadManagedCopyByOperationId(selected.operationId), null);
    };
    const milestones: string[] = [];
    let baselineRows: Awaited<ReturnType<typeof immutable>> | undefined, collisionRows: Awaited<ReturnType<typeof immutable>> | undefined;
    let lostRows: Awaited<ReturnType<typeof immutable>> | undefined, pendingDocuments: unknown, pendingDigest: string | undefined;
    let armedHttp = false, httpCalls = 0, droppedHttp = 0, armedB1 = false, b1: MetadataSqlEvent['client'] | undefined, lostB1Ack = false;
    const result = await h.withProbe(async event => {
      if (!armedB1) return;
      if (/^\s*INSERT INTO collaboration_excalidraw_copy_receipts\b/iu.test(event.text) && event.values.includes(lostB1.operationId)) b1 = event.client;
      if (!lostB1Ack && b1 === event.client && /^\s*COMMIT\s*$/iu.test(event.text)) {
        lostB1Ack = true; assert.equal((await receipt(lostB1.operationId)).publication_status, 'native_committed');
        throw Object.assign(new Error('Fixture loses actual durable B1 acknowledgement.'), { code: 'EIO' });
      }
    }, () => withInstalledApiKeySdkMcpFixture({ python, wheel, probe: path.resolve('scripts/helpers/python_sdk_api_key_copy_probe.py'), key: issued.key,
      config: { sourceWorkspaceId: workspaceIds[0], destinationWorkspaceId: workspaceIds[1], sourcePath: original.root,
        baseline, collision, lostHttp, lostB1, unknownOperationId: randomUUID() },
      exchange: async (rpc, response, body) => {
        if (rpc?.method !== 'tools/call' || rpc.params?.name !== 'copy_knowledge_source'
          || rpc.params.arguments?.operation_id !== lostHttp.operationId || rpc.params.arguments.action !== 'apply') return;
        httpCalls++;
        if (!armedHttp) return;
        assert.equal(response.status, 200); assert.equal(JSON.parse(body.toString()).result.structuredContent.execution.status, 'complete');
        await verify(lostHttp); lostRows = await immutable(lostHttp.operationId);
        armedHttp = false; droppedHttp++; return 'drop';
      },
      event: async (value, send) => {
        stage = value.event; milestones.push(stage);
        if (stage === 'manifest_observed') {
          assert(Array.isArray(value.paths) && value.paths.length <= 20 && value.paths.every(item => typeof item === 'string' && item.length <= 1024 && !item.startsWith('/')));
          console.log(JSON.stringify({ suite: 'installed-copy-manifest-observation', paths: value.paths }));
        } else if (stage === 'baseline_complete') {
          await verify(baseline); assert.equal(await count(), beforeCount + 1); assert.equal(typeof value.documentId, 'string');
          const document = (await h.admin.query('SELECT workspace_id,path FROM collaboration_documents WHERE id=$1', [value.documentId])).rows[0];
          assert.equal(document.workspace_id, workspaceIds[1]); assert.equal(document.path, `${baseline.destinationPath}/note.md`);
          baselineRows = await immutable(baseline.operationId); send({ ready: true });
        } else if (stage === 'collision_complete') {
          assert.equal(typeof value.destinationPath, 'string'); assert.notEqual(value.destinationPath, baseline.destinationPath);
          collision.destinationPath = value.destinationPath as string; await verify(collision);
          assert.equal(await count(), beforeCount + 2); assert.deepEqual(await immutable(baseline.operationId), baselineRows);
          collisionRows = await immutable(collision.operationId); send({ ready: true });
        } else if (stage === 'ready_rotate' || stage === 'b1_pending') {
          if (stage === 'b1_pending') {
            assert(lostB1Ack); assert.equal((await receipt(lostB1.operationId)).publication_status, 'native_committed');
            const retained = await staging.loadManagedCopyByOperationId(lostB1.operationId); assert(retained); pendingDigest = retained.payloadSha256;
            pendingDocuments = (await receipt(lostB1.operationId)).private_result.documents; assert.equal(await count(), beforeCount + 4);
          }
          const replacement = await rotateApiKey(manager, issued.integration.id, { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
          credentialId = replacement.credential.id; send({ key: replacement.key });
        } else if (stage === 'rotated_retry') {
          assert.deepEqual(await immutable(baseline.operationId), baselineRows); assert.equal(await count(), beforeCount + 2); send({ ready: true });
        } else if (stage === 'arm_http_loss') { armedHttp = true; send({ ready: true });
        } else if (stage === 'http_loss_observed') {
          assert.equal(httpCalls, 1); assert.equal(droppedHttp, 1); assert.equal(await count(), beforeCount + 3);
          assert.deepEqual(await immutable(lostHttp.operationId), lostRows); send({ ready: true });
        } else if (stage === 'http_loss_recovered') {
          assert.equal(httpCalls, 2); assert.deepEqual(await immutable(lostHttp.operationId), lostRows); send({ ready: true });
        } else if (stage === 'arm_b1_loss') { armedB1 = true; send({ ready: true });
        } else if (stage === 'b1_recovered') {
          assert(pendingDigest && lostB1Ack); await verify(lostB1);
          assert.deepEqual((await receipt(lostB1.operationId)).private_result.documents, pendingDocuments); send({ ready: true });
        } else if (stage === 'ready_reduce') {
          await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name, workspaceIds, actions: ['read', 'copy'] }); send({ ready: true });
        } else if (stage === 'ready_allowlist') {
          await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name, workspaceIds: [workspaceIds[0]], actions: [...actions] }); send({ ready: true });
        } else if (stage === 'ready_acl') {
          await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name, workspaceIds, actions: [...actions] });
          await h.admin.query("UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id='member'", [workspaceIds[1]]); send({ ready: true });
        } else if (stage === 'ready_restore') {
          await h.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [workspaceIds[1]]); send({ ready: true });
        } else if (stage === 'logout_issuer') {
          assert.equal((await h.admin.query("DELETE FROM session WHERE id='session-member'")).rowCount, 1);
          manager.set('Authorization', `Bearer ${managerToken}`); send({ ready: true });
        } else if (stage === 'ready_revoke') {
          assert.equal(await count(), beforeCount + 4); await revokeApiKey(manager, issued.integration.id, { expectedRevision: revision, credentialId }); send({ ready: true });
        } else if (stage === 'complete') { assert.equal(value.groups, 8); assert.equal(value.compiledNext, false); assert.equal(value.oauthIssuance, false); }
        else assert.fail('Unexpected installed SDK Copy milestone.');
      },
    }));
    assert.equal(result.droppedAcknowledgements, 1); assert.equal(result.calls[`${lostHttp.operationId}:apply`], 2);
    assert.equal(result.calls[`${baseline.operationId}:apply`], 2); assert.equal(result.calls[`${collision.operationId}:apply`], 1);
    assert.equal(result.calls[`${lostB1.operationId}:apply`], 1); assert.equal(result.calls[`${lostB1.operationId}:recover`], 1);
    assert(result.deniedMethods.includes('tools/call')); assert(result.deniedMethods.every(method => ['tools/call', 'server/discover', 'initialize'].includes(method)));
    assert.equal(await count(), beforeCount + 4); assert.deepEqual(await immutable(baseline.operationId), baselineRows);
    assert.deepEqual(await immutable(collision.operationId), collisionRows); assert.deepEqual(await immutable(lostHttp.operationId), lostRows);
    assert.deepEqual(await original.sourceSnapshot(), original.sourceBefore);
    console.log(JSON.stringify({ suite: 'installed-api-key-sdk-native-copy-http', passed: true, groups: 8, wheelSha256: result.wheelSha256,
      keyHeaderOnlyRequests: result.keyHeaderOnlyRequests, actual401: result.deniedMethods.length, deniedMethods: result.deniedMethods,
      nativeOperationsCreated: 4, droppedHttpAcknowledgements: droppedHttp, lostB1Acknowledgements: Number(lostB1Ack), automaticWriteReplays: 0,
      protectedSourceUnchanged: true, stderrBytes: result.stderrBytes, compiledNext: false, oauthIssuance: false, reviewCenterEnabled: false }));
  });
}
main().catch(error => { console.error(JSON.stringify({ suite: 'installed-api-key-sdk-native-copy-http', passed: false, stage,
  error: error instanceof Error ? error.name : 'UnknownError', code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined,
  ...(error instanceof assert.AssertionError ? { actual: typeof error.actual === 'number' ? error.actual : typeof error.actual,
    expected: typeof error.expected === 'number' ? error.expected : typeof error.expected } : {}) })); process.exitCode = 1; });

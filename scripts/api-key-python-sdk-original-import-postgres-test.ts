import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';
import { withNativeApiKeyEditRuntime } from './helpers/native-api-key-edit-runtime';
import { withInstalledApiKeySdkMcpFixture } from './helpers/installed-api-key-sdk-mcp-fixture';

let stage = 'setup', complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
async function main() {
  const python = process.env.CANVAS_SDK_TEST_PYTHON, wheel = process.env.CANVAS_SDK_TEST_WHEEL;
  assert(python && wheel);
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { FILE_VERSION_CENTER_MODE: 'shadow', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS: 'get_knowledge_manifest,import_knowledge_file,read_knowledge_source,edit_knowledge_source' });
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const { createApiIntegration, rotateApiKey, updateApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
    const issuer = new Headers((await h.request(h.source, 'owner')).headers); issuer.set('Origin', 'http://localhost');
    const actions = ['read', 'import', 'edit', 'status'];
    const issued = await createApiIntegration(issuer, { requestId: randomUUID(), name: 'Installed original import SDK',
      workspaceIds: [h.source.workspaceId], actions, expiresAt: Date.now() + 3_600_000 });
    const managerToken = randomBytes(32).toString('hex');
    await h.admin.query("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('sdk-original-manager',$1,'owner',$2,$3,$3)",
      [managerToken, Date.now() + 3_600_000, Date.now()]);
    const manager = new Headers({ Authorization: `Bearer ${managerToken}`, Origin: 'http://localhost' });
    let revision = 1, credentialId = issued.credential.id, armed = false, lostCalls = 0;
    const file = 'sdk-original/cafe\u0301 😀.md', lostPath = 'sdk-original/lost.md', stalePath = 'sdk-original/stale.md';
    const text = 'Before installed original SDK. Äpfel 😀 日本語.\n', bytes = Buffer.from(text);
    await fs.mkdir(path.join(h.source.rootPath, 'sdk-original'));
    for (const selected of [file, lostPath, stalePath]) await fs.writeFile(path.join(h.source.rootPath, selected), bytes, { flag: 'wx', mode: 0o600 });
    const pristineId = `collab-${randomUUID()}`;
    await h.admin.query(`INSERT INTO collaboration_documents(id,organization_id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at,yjs_state_lifecycle)
      VALUES($1,$2,$3,$4,$5,'yjs','active',0,1,1,'never_initialized')`,
    [pristineId, h.source.organizationId, h.source.workspaceId, h.source.workspaceType, file]);
    const identity = await fs.stat(path.join(h.source.rootPath, file));
    const protectedFile = await h.upload('sdk-original-protected.md', Buffer.from('Preserve the unrelated native document.'));
    const snapshot = async () => ({ document: (await h.admin.query('SELECT to_jsonb(d) AS row,xmin::text AS xmin FROM collaboration_documents d WHERE id=$1', [protectedFile.documentId])).rows,
      state: (await h.admin.query('SELECT to_jsonb(s) AS row,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [protectedFile.documentId])).rows,
      bytes: await fs.readFile(path.join(h.source.rootPath, 'sdk-original-protected.md')) });
    const before = await snapshot();
    const stored = async (caller: string) => (await h.admin.query(`SELECT o.original_text,o.xmin::text AS original_xmin,r.private_result,r.xmin::text AS receipt_xmin
      FROM collaboration_original_markdown_import_api_keys o JOIN collaboration_markdown_file_import_receipts r USING(workspace_id,operation_id)
      WHERE o.workspace_id=$1 AND o.original_text::jsonb->>'callerOperationId'=$2`, [h.source.workspaceId, caller])).rows;
    const baseline = Number((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_markdown_file_import_receipts')).rows[0].n);
    const count = async () => Number((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_markdown_file_import_receipts')).rows[0].n);
    let original: Awaited<ReturnType<typeof stored>> = [], lost: Awaited<ReturnType<typeof stored>> = [];
    let transportOutcome: unknown;
    await withNativeApiKeyEditRuntime(h, async () => {
      const proof = await withInstalledApiKeySdkMcpFixture({ python, wheel,
        probe: path.resolve('scripts/helpers/python_sdk_api_key_original_import_probe.py'), key: issued.key,
        config: { workspaceId: h.source.workspaceId, path: file, lostPath, stalePath, pristineId, text },
        exchange: async (rpc, response, body) => {
          if (rpc?.method !== 'tools/call' || rpc.params?.name !== 'import_knowledge_file'
            || rpc.params.arguments?.operation_id !== 'sdk-original-import-lost-1' || rpc.params.arguments?.action !== 'import_existing') return;
          lostCalls++;
          if (!armed) return;
          assert.equal(response.status, 200); const data = JSON.parse(body.toString()).result?.structuredContent;
          assert.equal(data?.status, 'confirmed'); assert.equal(data?.outcome, 'imported');
          assert.equal(await count(), baseline + 2); lost = await stored('sdk-original-import-lost-1'); assert.equal(lost.length, 1);
          assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, lostPath)), bytes);
          armed = false; return 'drop';
        },
        event: async (value, send) => {
          stage = value.event;
          if (value.event === 'ready_rotate') {
            assert.equal(value.operationId, 'sdk-original-import-1'); assert.equal(await count(), baseline + 1);
            original = await stored('sdk-original-import-1'); assert.equal(original.length, 1);
            const origin = JSON.parse(original[0].original_text).origin;
            assert.equal(origin.entryPoint, 'mcp'); assert.equal(origin.credentialId, issued.credential.id);
            const actual = await fs.stat(path.join(h.source.rootPath, file)); assert.equal(actual.ino, identity.ino); assert.equal(actual.dev, identity.dev);
            const replacement = await rotateApiKey(manager, issued.integration.id, { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
            credentialId = replacement.credential.id; send({ key: replacement.key });
          } else if (value.event === 'ready_reduce' || value.event === 'ready_restore') {
            assert.deepEqual(await stored('sdk-original-import-1'), original);
            await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
              workspaceIds: [h.source.workspaceId], actions: value.event === 'ready_reduce' ? ['read', 'import', 'edit'] : actions });
            send({ ready: true });
          } else if (value.event === 'ready_logout') {
            assert.equal(await count(), baseline + 1); assert.equal((await h.admin.query("DELETE FROM session WHERE id='session-owner'")).rowCount, 1);
            send({ ready: true });
          } else if (value.event === 'ready_loss') {
            assert.equal(await count(), baseline + 1); armed = true; send({ ready: true });
          } else if (value.event === 'loss_seen') {
            assert.equal(value.operationId, 'sdk-original-import-lost-1'); assert.equal(lostCalls, 1); assert.equal(armed, false);
            assert(value.transportOutcome === 'unknown_result' || value.transportOutcome === 'cancelled_after_http_failure');
            transportOutcome = value.transportOutcome;
            assert.deepEqual(await stored('sdk-original-import-lost-1'), lost); send({ ready: true });
          } else if (value.event === 'ready_revoke') {
            assert.equal(await count(), baseline + 2); assert.equal(lostCalls, 2);
            assert.deepEqual(await stored('sdk-original-import-1'), original); assert.deepEqual(await stored('sdk-original-import-lost-1'), lost);
            await revokeApiKey(manager, issued.integration.id, { expectedRevision: revision++, credentialId }); send({ ready: true });
          } else if (value.event === 'complete') {
            assert.equal(value.groups, 7); assert.equal(value.compiledNext, false); assert.equal(value.oauthIssuance, false); complete = true;
          } else assert.fail('Unexpected original import SDK milestone.');
        } });
      assert.equal(proof.droppedAcknowledgements, 1); assert.equal(lostCalls, 2); assert.equal(await count(), baseline + 2);
      assert.deepEqual(await stored('sdk-original-import-1'), original); assert.deepEqual(await stored('sdk-original-import-lost-1'), lost);
      assert(proof.deniedMethods.length >= 3); assert(proof.keyHeaderOnlyRequests > 20);
      assert.deepEqual(await snapshot(), before); assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, stalePath)), bytes);
      console.log(JSON.stringify({ suite: 'installed-api-key-sdk-original-import-http', passed: true, groups: 7, ...proof,
        originalImportCalls: lostCalls, automaticMutationReplays: 0, transportOutcome, pristineIdentityPreserved: true, immutableOriginalReceipts: true,
        protectedNativeDocumentUnchanged: true, reviewCenterEnabled: false, compiledNext: false, oauthIssuance: false }));
    });
  });
}
main().catch(error => { process.exitCode = 1;
  console.error(JSON.stringify({ suite: 'installed-api-key-sdk-original-import-http', stage, error: error instanceof Error ? error.name : 'UnknownError' })); });

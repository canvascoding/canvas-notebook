import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';
import type { DirectMcpWorkspacePathResultV1 } from '../app/lib/mcp/server/workspace-path-tool-contract';

let stage = 'setup', groups = 0;
function code(error: unknown): unknown {
  return error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
}
async function main() {
  process.env.FILE_VERSION_CENTER_MODE = 'off';
  process.env.BASE_URL = 'http://localhost';
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'move_knowledge_source,delete_knowledge_source' });
    await h.admin.query("UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id='principal-org' AND user_id='member'");
    await h.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [h.source.workspaceId]);
    assert.equal((await import('../app/lib/file-version-center/policy-v1')).resolveFileVersionRolloutV1(process.env.FILE_VERSION_CENTER_MODE).capture, false);
    assert.equal((await import('../app/lib/files/workspace-file-undo-policy')).WORKSPACE_FILE_UNDO_ENABLED, false);
    const { createApiIntegration, rotateApiKey, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyWorkspacePathPrincipal } = await import('../app/lib/api-keys/document-read-principal');
    const { captureWorkspaceOperationApiKeyJobReadPrincipal } = await import('../app/lib/workspaces/workspace-operation-api-key-job-principal');
    const { lookupWorkspaceOperationNativePathStatus } = await import('../app/lib/files/workspace-operation-native-path-status');
    const { runApiKeyWorkspaceMoveService, runApiKeyWorkspaceDeleteService } = await import('../app/lib/files/workspace-operation-mcp-path-service');
    const { decodeDirectMcpWorkspaceMoveRequestV1, decodeDirectMcpWorkspaceDeleteRequestV1, workspacePathFailureV1 } = await import('../app/lib/mcp/server/workspace-path-tool-contract');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { loadCollaborationStateOnConnection } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const manager = new Headers((await h.request()).headers); manager.set('Origin', 'http://localhost');
    const workspaceId = h.source.workspaceId, store = new WorkspaceOperationBatchStore();
    const issue = (name: string, actions: ('move' | 'delete' | 'status' | 'recover')[] = ['move', 'delete', 'status', 'recover']) =>
      createApiIntegration(manager, { requestId: randomUUID(), name, workspaceIds: [workspaceId], actions, expiresAt: Date.now() + 3_600_000 });
    const issued = await issue('Actual public Key path service');
    let key = issued.key;
    const credential = (selectedKey = key) => authenticateApiKeyRequest(new Request('http://localhost/api/documents/move', {
      headers: { 'X-Canvas-API-Key': selectedKey } }));
    const call = async (kind: 'move' | 'delete', input: Record<string, unknown>, selectedKey = key, source: 'request' | 'mcp' = 'request', signal?: AbortSignal) => {
      const raw = { api_version: 1, workspace_id: workspaceId, ...input }, actual = await credential(selectedKey);
      const result = kind === 'move' ? await runApiKeyWorkspaceMoveService(decodeDirectMcpWorkspaceMoveRequestV1(raw), actual, source, signal)
        : await runApiKeyWorkspaceDeleteService(decodeDirectMcpWorkspaceDeleteRequestV1(raw), actual, source, signal);
      const encoded = JSON.stringify(result);
      for (const privateValue of [selectedKey, h.dataRoot, h.schema]) assert.equal(encoded.includes(privateValue), false);
      assert(Buffer.byteLength(encoded) <= 1024 * 1024); return result;
    };
    const operation = (result: DirectMcpWorkspacePathResultV1) => { assert(result.action !== 'preview'); return result.operation; };
    const domain = async () => {
      const tables = (await h.admin.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind='r' AND c.relname ~ '^(collaboration_|file_collaboration_|workspace_|file_revision)'
        ORDER BY c.relname`, [h.schema])).rows;
      const snapshot: Record<string, unknown> = {};
      for (const { relname } of tables) {
        assert(/^[a-z][a-z0-9_]*$/u.test(relname));
        snapshot[relname] = (await h.admin.query(`SELECT to_jsonb(t)::text AS data,xmin::text AS row_xmin FROM "${h.schema}"."${relname}" t ORDER BY data,row_xmin`)).rows;
      }
      return snapshot;
    };
    const check = async (name: string, test: () => Promise<void>) => { stage = name; await test(); groups++; console.log(`Public Key path service passed: ${name}`); };

    await check('absent lookup returns factual namespace after one snapshot and two real authority phases', async () => {
      const before = await domain(), operationId = randomUUID(), actual = await credential();
      let snapshots = 0, authorizations = 0;
      await withApiKeyWorkspacePathPrincipal(actual, { workspaceId, purpose: 'move_status', source: 'request' }, async principal => {
        await h.withProbe(async event => {
          if (/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/iu.test(event.text.trim())) snapshots++;
          if (/^BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE$/iu.test(event.text.trim())) authorizations++;
        }, async () => {
          const result = await lookupWorkspaceOperationNativePathStatus({ workspaceId, operationId,
            apiKeyPrincipal: captureWorkspaceOperationApiKeyJobReadPrincipal({ transport: 'api-key', kind: 'move', purpose: 'move_status', principal }) });
          assert.equal(result.status, null); assert.equal(result.scope.workspace.workspaceId, workspaceId);
          assert.equal(result.scope.fileOptions.workspace, result.scope.workspace); assert.equal(typeof result.batchId, 'string');
          assert.equal(await store.get(result.batchId), null);
        });
      });
      assert.equal(snapshots, 1); assert.equal(authorizations, 2); assert.deepEqual(await domain(), before);
      await assert.rejects(call('move', { action: 'status', operation_id: operationId }), error => code(error) === 'PATH_STATUS_NOT_FOUND');
      await assert.rejects(call('move', { action: 'recover', operation_id: operationId, plan_id: 'a'.repeat(64),
        selections: [{ source_path: 'absent.md', destination_path: 'absent-moved.md' }] }), error => code(error) === 'PATH_OPERATION_NOT_FOUND');
      assert.deepEqual(await domain(), before);
    });

    await check('absent lookup withholds all factual results when the actual key is revoked before C2', async () => {
      const separate = await issue('Revoked absent lookup'), actual = await credential(separate.key), before = await domain();
      let snapshotClient: object | undefined, revoked = false, returned = false;
      await assert.rejects(withApiKeyWorkspacePathPrincipal(actual, { workspaceId, purpose: 'move_status', source: 'request' }, principal =>
        h.withProbe(async event => {
          if (/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/iu.test(event.text.trim())) snapshotClient = event.client;
          if (event.client === snapshotClient && /^COMMIT$/iu.test(event.text.trim()) && !revoked) {
            revoked = true; await revokeApiKey(manager, separate.integration.id, { expectedRevision: separate.integration.revision, credentialId: separate.credential.id });
          }
        }, async () => {
          await lookupWorkspaceOperationNativePathStatus({ workspaceId, operationId: randomUUID(), apiKeyPrincipal:
            captureWorkspaceOperationApiKeyJobReadPrincipal({ transport: 'api-key', kind: 'move', purpose: 'move_status', principal }) });
          returned = true;
        })), error => code(error) === 'API_KEY_INVALID');
      assert(revoked); assert.equal(returned, false); assert.deepEqual(await domain(), before);
    });

    let completedMove: { input: Record<string, unknown>; batchId: string; original: unknown } | undefined;
    for (const missingProjection of [false, true]) await check(`public native Move, physical projection ${!missingProjection}`, async () => {
      const sourcePath = `public-key-${randomUUID()}.md`, destinationPath = `public-key-${randomUUID()}-moved.md`;
      const bytes = Buffer.from('# Preserve the native original\n');
      const target = await h.upload(sourcePath, bytes), incoming = await h.upload(`public-incoming-${randomUUID()}.md`, Buffer.from(`[Keep label](${sourcePath})\n`));
      const beforeState = await loadCollaborationStateOnConnection(h.connection, target.documentId); assert(beforeState);
      if (missingProjection) await fs.unlink(path.join(h.source.rootPath, sourcePath));
      const before = await domain(), selections = [{ source_path: sourcePath, destination_path: destinationPath }];
      const preview = await call('move', { action: 'preview', selections }); assert(preview.action === 'preview');
      assert.deepEqual(await domain(), before); assert.equal(preview.preview.planId.length, 64);
      const input = { action: 'apply', operation_id: randomUUID(), plan_id: preview.preview.planId, selections };
      const applied = await call('move', input); assert(applied.action === 'apply'); assert.equal(applied.alreadyKnown, false);
      assert.equal(applied.operation.journal.status, 'applied'); assert.equal(applied.operation.completion.status, 'confirmed');
      const batch = await store.get(applied.operation.batchId); assert(batch?.authorization.mode === 'api-key'); assert.equal(batch.plan.version, 3);
      assert.equal(batch.authorization.actorSessionId, null); assert.equal(batch.authorization.credentialId, issued.credential.id);
      const afterState = await loadCollaborationStateOnConnection(h.connection, target.documentId); assert(afterState);
      assert.equal(afterState.path, destinationPath); assert.equal(afterState.lifecycleGeneration, beforeState.lifecycleGeneration);
      assert.deepEqual(Buffer.from(afterState.yjsState), Buffer.from(beforeState.yjsState)); assert.deepEqual(Buffer.from(afterState.stateVector), Buffer.from(beforeState.stateVector));
      const linked = await loadCollaborationStateOnConnection(h.connection, incoming.documentId); assert(linked);
      assert(inspectPersistedDocumentLinks(linked).links.some(link => link.targetPathText === destinationPath));
      await assert.rejects(fs.lstat(path.join(h.source.rootPath, sourcePath)), error => code(error) === 'ENOENT');
      if (missingProjection) await assert.rejects(fs.lstat(path.join(h.source.rootPath, destinationPath)), error => code(error) === 'ENOENT');
      else assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, destinationPath)), bytes);
      const after = await domain();
      assert.deepEqual(operation(await call('move', { action: 'status', operation_id: input.operation_id })), applied.operation);
      for (const action of ['apply', 'recover']) {
        const repeated = await call('move', { ...input, action }); assert(repeated.action !== 'preview' && repeated.action !== 'status');
        assert.equal(repeated.alreadyKnown, true); assert.deepEqual(repeated.operation, applied.operation); assert.deepEqual(await domain(), after);
      }
      await assert.rejects(call('move', { ...input, selections: [{ source_path: sourcePath, destination_path: 'different.md' }] }), error => code(error) === 'PATH_PLAN_CHANGED');
      assert.deepEqual(await domain(), after);
      completedMove = { input, batchId: batch.batchId, original: batch.authorization };
    });

    for (const profile of ['native', 'native-only', 'physical', 'cohort'] as const) await check(`public ${profile} Delete retains original content and never replays`, async () => {
      const root = `public-delete-${randomUUID()}`, selectedPath = profile === 'cohort' ? root : `${root}.${profile === 'physical' ? 'pdf' : 'md'}`;
      if (profile === 'cohort') await fs.mkdir(path.join(h.source.rootPath, root), { mode: 0o700 });
      const nativePath = profile === 'cohort' ? `${root}/note.md` : selectedPath;
      const bytes = Buffer.from(profile === 'physical' ? '%PDF-1.7\nPreserve these exact original bytes\n' : '# Preserve these exact native bytes\n');
      const target = profile === 'physical' ? null : await h.upload(nativePath, bytes);
      if (profile === 'physical') await fs.writeFile(path.join(h.source.rootPath, selectedPath), bytes, { flag: 'wx', mode: 0o600 });
      if (profile === 'native-only') await fs.unlink(path.join(h.source.rootPath, nativePath));
      if (profile === 'cohort') await fs.writeFile(path.join(h.source.rootPath, root, 'paper.pdf'), Buffer.from('%PDF-1.7\nCohort original\n'), { flag: 'wx', mode: 0o600 });
      const emailBytes = Buffer.from('# Contact\n**Studio <alex@example.test>**\n');
      const emailPath = `public-delete-email-${randomUUID()}.md`;
      const email = profile === 'physical' ? await h.upload(emailPath, emailBytes) : null;
      const emailBefore = email ? await loadCollaborationStateOnConnection(h.connection, email.documentId) : null;
      const incoming = await h.upload(`public-delete-incoming-${randomUUID()}.md`, Buffer.from(`[Preserved label](${nativePath})\n`));
      const beforeState = target ? await loadCollaborationStateOnConnection(h.connection, target.documentId) : null, before = await domain();
      const preview = await call('delete', { action: 'preview', path: selectedPath }); assert(preview.action === 'preview'); assert.deepEqual(await domain(), before);
      const input = { action: 'apply', operation_id: randomUUID(), plan_id: preview.preview.planId, path: selectedPath };
      const applied = await call('delete', input); assert(applied.action === 'apply'); assert.equal(applied.alreadyKnown, false);
      assert.equal(applied.operation.journal.status, 'applied'); assert.equal(applied.operation.completion.status, 'confirmed');
      const batch = await store.get(applied.operation.batchId); assert(batch?.authorization.mode === 'api-key');
      assert.equal(batch.plan.version, profile === 'cohort' ? 6 : profile === 'physical' ? 5 : 2); assert.equal(batch.authorization.actorSessionId, null);
      if (target) {
        assert(beforeState); const archived = (await h.admin.query('SELECT status,yjs_state,state_vector FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId])).rows[0];
        assert.equal(archived.status, 'archived'); assert.deepEqual(archived.yjs_state, Buffer.from(beforeState.yjsState)); assert.deepEqual(archived.state_vector, Buffer.from(beforeState.stateVector));
      }
      const trash = (await h.admin.query('SELECT metadata_json,trash_relative_path FROM workspace_trash_entries WHERE original_path=$1', [selectedPath])).rows;
      assert.equal(trash.length, 1);
      if (profile === 'physical') assert.deepEqual(await fs.readFile(path.join(h.dataRoot, trash[0].trash_relative_path)), bytes);
      if (email) {
        const emailAfter = await loadCollaborationStateOnConnection(h.connection, email.documentId);
        assert(emailBefore && emailAfter);
        assert.deepEqual(emailAfter.yjsState, emailBefore.yjsState);
        assert.deepEqual(emailAfter.stateVector, emailBefore.stateVector);
        assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, emailPath)), emailBytes);
      }
      const linked = await loadCollaborationStateOnConnection(h.connection, incoming.documentId); assert(linked);
      assert.equal(inspectPersistedDocumentLinks(linked).links.some(link => link.targetPathText === nativePath), false);
      await assert.rejects(fs.lstat(path.join(h.source.rootPath, selectedPath)), error => code(error) === 'ENOENT');
      const after = await domain();
      assert.deepEqual(operation(await call('delete', { action: 'status', operation_id: input.operation_id })), applied.operation);
      for (const action of ['apply', 'recover']) {
        const repeated = await call('delete', { ...input, action }); assert(repeated.action !== 'preview' && repeated.action !== 'status');
        assert.equal(repeated.alreadyKnown, true); assert.deepEqual(repeated.operation, applied.operation); assert.deepEqual(await domain(), after);
      }
    });

    await check('rotation and another entry point retain actual original attribution and stable operation namespace', async () => {
      assert(completedMove); const original = completedMove;
      const rotated = await rotateApiKey(manager, issued.integration.id, { requestId: randomUUID(), expectedRevision: issued.integration.revision, expiresAt: Date.now() + 3_600_000 }); key = rotated.key;
      const before = await domain(), result = await call('move', { ...original.input, action: 'recover' }, key, 'mcp');
      assert(result.action === 'recover'); assert(result.alreadyKnown); assert.equal(result.operation.batchId, original.batchId);
      assert.deepEqual((await store.get(original.batchId))?.authorization, original.original); assert.deepEqual(await domain(), before);
      await assert.rejects(call('move', { action: 'status', operation_id: original.input.operation_id }, issued.key), error => code(error) === 'API_KEY_INVALID');
    });

    await check('Move/Delete never implicitly import originals; denied grants and pre-aborted requests create no domain changes', async () => {
      const originalPath = `public-unimported-${randomUUID()}.md`, bytes = Buffer.from('# Existing original awaiting explicit import\n');
      await fs.writeFile(path.join(h.source.rootPath, originalPath), bytes, { flag: 'wx', mode: 0o600 });
      const before = await domain();
      await assert.rejects(call('move', { action: 'preview', selections: [{ source_path: originalPath, destination_path: 'should-not-exist.md' }] }), error => workspacePathFailureV1(error).body.code === 'PATH_NATIVE_REQUIRED');
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, originalPath)), bytes); assert.deepEqual(await domain(), before);
      const denied = await issue('Status without move', ['status']);
      await assert.rejects(call('move', { action: 'status', operation_id: randomUUID() }, denied.key), error => code(error) === 'API_KEY_ACCESS_DENIED');
      process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
      try {
        await assert.rejects(call('move', { action: 'status', operation_id: randomUUID() }, key, 'mcp'), error => code(error) === 'API_KEY_TOOL_DISABLED');
      } finally { process.env.CANVAS_MCP_DIRECT_ENABLED = 'true'; }
      const actual = await credential(), signal = AbortSignal.abort(); let statements = 0;
      await h.withProbe(async () => { statements++; }, async () => {
        await assert.rejects(runApiKeyWorkspaceMoveService(decodeDirectMcpWorkspaceMoveRequestV1({ api_version: 1, workspace_id: workspaceId,
          action: 'apply', operation_id: randomUUID(), plan_id: 'a'.repeat(64), selections: [{ source_path: originalPath, destination_path: 'never.md' }] }), actual, 'request', signal), error => code(error) === 'PATH_OUTCOME_UNCONFIRMED');
      });
      assert.equal(statements, 0); assert.deepEqual(await domain(), before);
    });
  });
  console.log(`Public API-key path service: ${groups} genuine Preview/Apply/Status/Recover groups passed. HTTP adapters and installed SDK are separate gates.`);
}
main().catch(error => {
  console.error(JSON.stringify({ suite: 'api-key-public-path-service', stage, name: error instanceof Error ? error.name : undefined,
    code: code(error), assertion: error instanceof assert.AssertionError ? { operator: error.operator,
      actual: typeof error.actual, expected: typeof error.expected, rejectionCode: code(error.actual) } : undefined,
    stack: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s*at\b/u.test(line)).slice(0, 5) : undefined })); process.exitCode = 1;
});

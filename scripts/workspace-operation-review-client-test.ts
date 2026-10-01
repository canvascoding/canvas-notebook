import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import type * as Client from '../app/lib/files/workspace-operation-review-client';

async function loadClient() {
  const filename = path.resolve('app/lib/files/workspace-operation-review-client.ts');
  const native = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} as typeof Client };
  new Function('require', 'module', 'exports', source)((name: string) => name === './client'
    ? { workspaceHeaders: (workspaceId: string) => ({ 'x-canvas-workspace-id': workspaceId }) }
    : native(name), loaded, loaded.exports);
  return loaded.exports;
}

test('batch client binds preview, approval, refresh and status to the requested workspace and plan', async () => {
  const client = await loadClient();
  const requests: Array<{ url: string; body: unknown; credentials?: RequestCredentials; signal?: AbortSignal | null }> = [];
  const originalFetch = globalThis.fetch;
  let responseBody: object = { batch: { batchId: 'batch/one', workspaceId: 'workspace-one', planId: 'plan-one', preview: { planId: 'plan-one' } } };
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      credentials: init?.credentials, signal: init?.signal });
    return Response.json(responseBody);
  };
  try {
    await client.previewWorkspaceOperationBatch(['review-one', 'review-two'], 'workspace-one');
    assert.deepEqual(requests[0].body, { action: 'preview', reviewIds: ['review-one', 'review-two'] });
    assert.equal(requests[0].url, '/api/files/operation-reviews/batches');
    await client.acceptWorkspaceOperationBatch({ batchId: 'batch/one', planId: 'plan-one', workspaceId: 'workspace-one' });
    assert.deepEqual(requests[1].body, { action: 'accept', batchId: 'batch/one', planId: 'plan-one' });
    const controller = new AbortController();
    await client.readWorkspaceOperationBatch('batch/one', 'workspace-one', controller.signal);
    assert.equal(requests[2].url, '/api/files/operation-reviews/batches/batch%2Fone');
    assert.equal(requests[2].signal, controller.signal, 'closing a panel can cancel status polling without cancelling the durable worker');
    await client.updateWorkspaceOperationBatch({ batchId: 'batch/one', planId: 'plan-one', workspaceId: 'workspace-one', action: 'undo' });
    assert.deepEqual(requests[3].body, { action: 'undo', planId: 'plan-one' });
    responseBody = { review: { reviewId: 'successor', sourceWorkspaceId: 'workspace-one', destinationWorkspaceId: 'workspace-one' } };
    await client.refreshWorkspaceOperationReview({ reviewId: 'review-one', planId: 'old-plan', workspaceId: 'workspace-one' });
    assert.deepEqual(requests[4].body, { action: 'refresh', planId: 'old-plan' });
    assert.ok(requests.every((request) => request.credentials === 'include'));
    responseBody = { batch: { batchId: 'batch/one', workspaceId: 'other-workspace', preview: {} } };
    await assert.rejects(client.readWorkspaceOperationBatch('batch/one', 'workspace-one'), /passt nicht zur Anfrage/u);
    responseBody = { batch: { batchId: 'different-batch', workspaceId: 'workspace-one', preview: {} } };
    await assert.rejects(client.acceptWorkspaceOperationBatch({ batchId: 'batch/one', planId: 'plan-one', workspaceId: 'workspace-one' }), /passt nicht zur Anfrage/u);
    responseBody = { review: { reviewId: 'successor', sourceWorkspaceId: 'other-workspace', destinationWorkspaceId: 'other-workspace' } };
    await assert.rejects(client.refreshWorkspaceOperationReview({ reviewId: 'review-one', planId: 'old-plan', workspaceId: 'workspace-one' }), /passt nicht zum Workspace/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

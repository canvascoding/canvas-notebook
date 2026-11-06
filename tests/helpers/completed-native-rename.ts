import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type { APIRequestContext } from '@playwright/test';
import { readWorkspaceImplicitMoveBinding, readWorkspaceImplicitMovePreparation } from '../../app/lib/files/workspace-implicit-move-parser';
import { readWorkspacePathOperation } from '../../app/lib/files/workspace-path-operation-parser';
import type { WorkspaceImplicitMoveBindingPublic } from '../../app/lib/files/workspace-implicit-move-public';
import type { WorkspacePathOperationResponse } from '../../app/lib/files/workspace-path-operation-public';

/** Complete one owned native action using the public binding/resume protocol.
 * A fresh explicit attempt keeps its original key; unknown/transport outcomes
 * retain that identity and data, rather than creating another file action.
 */
export async function completeNativeFixtureRename(api: APIRequestContext, input: {
  workspaceId: string; oldPath: string; newPath: string; operationId?: string;
}): Promise<WorkspacePathOperationResponse> {
  const operationId = input.operationId ?? randomUUID();
  assert.match(operationId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  for (const path of [input.oldPath, input.newPath]) assert(path && !path.startsWith('/')
    && !path.includes('\\') && !path.split('/').some(part => ['', '.', '..'].includes(part)));
  const session = await api.get('/api/auth/get-session', { timeout: 15_000 });
  assert.equal(session.status(), 200);
  const actorUserId = (await session.json()).user?.id;
  assert.equal(typeof actorUserId, 'string');
  assert(actorUserId.length > 0);
  const expected = { actorUserId, workspaceId: input.workspaceId, operationId,
    action: 'rename' as const, selections: [{ sourcePath: input.oldPath, destinationPath: input.newPath }] };
  const headers = { 'x-canvas-workspace-id': input.workspaceId };
  const original = { oldPath: input.oldPath, newPath: input.newPath, updateLinks: false, idempotencyKey: operationId };
  const deadline = Date.now() + 90_000;
  let binding: WorkspaceImplicitMoveBindingPublic | undefined;
  let initialBusy = 0;
  while (Date.now() < deadline) {
    const endpoint = binding ? `/api/files/operations/implicit-moves/${binding.requestId}` : '/api/files/rename';
    let response;
    try {
      response = await api.post(endpoint, { headers, data: binding ? {} : original,
        timeout: Math.min(55_000, Math.max(1, deadline - Date.now())) });
    } catch (cause) {
      throw new Error(`Native rename outcome unknown; retain operation ${operationId} and its fixture data.`, { cause });
    }
    const payload = await response.json();
    assert(payload && typeof payload === 'object' && !Array.isArray(payload));
    if (!binding && response.status() === 503 && payload.success === false && payload.code === 'IMPLICIT_MOVE_BUSY'
      && payload.operationId === operationId && Object.keys(payload).every(key => ['success', 'error', 'code', 'operationId'].includes(key))
      && initialBusy++ < 2) {
      await wait(500);
      continue;
    }
    if (Object.hasOwn(payload, 'preparation')) {
      assert.equal(response.status(), 202);
      assert.equal(payload.success, true);
      assert.deepEqual(Object.keys(payload).sort(), ['preparation', 'success']);
      const preparation = readWorkspaceImplicitMovePreparation(payload.preparation, { ...expected,
        ...(binding ? { requestId: binding.requestId, selectionDigest: binding.selectionDigest } : {}) });
      assert(preparation.state === 'pending' && preparation.canResume, 'Retain the native preparation requiring recovery.');
      binding = readWorkspaceImplicitMoveBinding({ version: 1, kind: 'implicit-move-binding',
        actorUserId: preparation.actorUserId, workspaceId: preparation.workspaceId, operationId: preparation.operationId,
        requestId: preparation.requestId, selectionDigest: preparation.selectionDigest }, expected);
    } else {
      assert([200, 202].includes(response.status()), `Native rename retained (${response.status()}/${String(payload.code ?? 'unknown')}/${operationId}).`);
      assert.equal(payload.success, true);
      const operation = readWorkspacePathOperation(payload.operation, { workspaceId: input.workspaceId });
      assert.equal(operation.kind, 'rename');
      assert.deepEqual(operation.selections, expected.selections);
      assert(!operation.preparation && !operation.legacyImplicitReplay);
      binding = readWorkspaceImplicitMoveBinding(operation.implicitBinding, { ...expected,
        ...(binding ? { requestId: binding.requestId, selectionDigest: binding.selectionDigest } : {}) });
      if (operation.status === 'applied') {
        assert.equal(response.status(), 200);
        assert.equal(payload.linkStatus, 'complete');
        if (payload.historical !== true) {
          assert.equal(payload.mutation?.type, 'rename');
          assert.equal(payload.mutation.workspaceId, input.workspaceId);
          assert.equal(payload.mutation.oldPath, input.oldPath);
          assert.equal(payload.mutation.newPath, input.newPath);
        }
        return { ...payload, operation };
      }
      assert.equal(response.status(), 202);
      assert(['queued', 'applying'].includes(operation.status), 'Retain the native action requiring recovery.');
    }
    await wait(500);
  }
  throw new Error(`Native rename deadline; retain operation ${operationId} and its fixture data.`);
}

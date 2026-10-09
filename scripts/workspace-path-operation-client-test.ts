import assert from 'node:assert/strict';
import { WORKSPACE_ID_HEADER } from '../app/lib/workspaces/constants';
import { undoWorkspacePathOperation, waitForWorkspacePathOperationResult, WorkspacePathOperationClientError } from '../app/lib/files/workspace-path-operation-client';
import type { WorkspacePathOperationPublic, WorkspacePathOperationResponse } from '../app/lib/files/workspace-path-operation-public';

const operation = (status: WorkspacePathOperationPublic['status']): WorkspacePathOperationPublic => ({
  batchId: 'direct-client-batch-1234567890', planId: 'a'.repeat(64), workspaceId: 'workspace-client',
  status, completedActions: ['applied', 'undone'].includes(status) ? 2 : 0, totalActions: 2,
  phase: ['applied', 'undone'].includes(status) ? 'complete' : 'preparing', errorCode: null,
  kind: 'move', selections: [{ sourcePath: 'old.md', destinationPath: 'new.md' }],
});

async function main() {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let replies: Array<{ status?: number; body: unknown }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), init });
    const reply = replies.shift();
    assert.ok(reply, 'unexpected extra status poll');
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  const poll = (initial: WorkspacePathOperationResponse, timeoutMs = 1000) =>
    waitForWorkspacePathOperationResult(initial, 'workspace-client', { intervalMs: 0, timeoutMs });
  try {
    const legacy: { operation?: WorkspacePathOperationPublic; deleted: string[] } = { deleted: ['old.md'] };
    assert.equal(await waitForWorkspacePathOperationResult(legacy), legacy, 'unrelated legacy responses stay unchanged');
    const applied: WorkspacePathOperationResponse = { operation: operation('applied'), linkStatus: 'complete',
      mutation: { type: 'rename', operationId: 'actual-filesystem-mutation', workspaceId: 'workspace-client',
        oldPath: 'old.md', newPath: 'new.md' } };
    assert.deepEqual(await poll(applied), applied);
    assert.equal(requests.length, 0, 'settled success does not poll');
    const privateApplied = { ...applied, operation: { ...applied.operation,
      privatePlan: { documentText: 'private' }, errorCode: 'Private document contents https://private.test',
      selections: [{ ...applied.operation.selections[0], absolutePath: '/private/old.md' }],
    } };
    assert.deepEqual(await poll(privateApplied), applied, 'settled success validates and projects the operation before returning it');

    replies = [{ body: { operation: operation('applying') } }, { body: applied }];
    assert.deepEqual(await poll({ operation: operation('queued') }), applied);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.url, '/api/files/operations/batches/direct-client-batch-1234567890');
      assert.equal(request.init?.credentials, 'include');
      assert.equal(request.init?.cache, 'no-store');
      assert.equal(new Headers(request.init?.headers).get(WORKSPACE_ID_HEADER), 'workspace-client');
    }

    for (const status of ['blocked', 'needs_review', 'failed', 'needs_recovery', 'preview', 'undone'] as const) {
      const failed = { ...operation(status), errorCode: 'ACTION_SAFE_GUARD' };
      await assert.rejects(poll({ operation: failed }), (error: unknown) => {
        assert.ok(error instanceof WorkspacePathOperationClientError);
        assert.deepEqual(error.operation, failed, 'terminal failure retains durable operation identity and cause');
        assert.match(error.message, /Notification Center/u);
        return true;
      });
    }
    const failedOperation = { ...operation('failed'), errorCode: 'CURRENT_CONTENT_CHANGED',
      issues: [{ code: 'source-unreadable', path: 'Notizen.md' }] };
    replies = [{ body: { operation: { ...failedOperation, privatePlan: { documentText: 'private' },
      issues: [{ ...failedOperation.issues[0], absolutePath: '/private/Notizen.md', diagnostic: 'private detail' }] } } }];
    await assert.rejects(poll({ operation: operation('queued') }), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.deepEqual(error.operation, failedOperation, 'terminal polling keeps safe issues and removes private diagnostics');
      return true;
    });

    for (const mismatch of [
      { workspaceId: 'workspace-foreign' }, { batchId: 'other-client-batch-1234567890' }, { planId: 'b'.repeat(64) },
    ]) {
      replies = [{ body: { operation: { ...operation('applied'), ...mismatch } } }];
      await assert.rejects(poll({ operation: operation('queued') }), /Invalid file action status response|identity changed/u);
    }
    await assert.rejects(poll({ operation: { ...operation('queued'), workspaceId: 'workspace-foreign' } }),
      /Invalid file action status response/u);
    const invalidOperations = [null, {}, { ...operation('applied'), batchId: '../foreign' },
      { ...operation('applied'), planId: 'invalid' }, { ...operation('applied'), status: 'invented' },
      { ...operation('applied'), phase: 'preparing' }, { ...operation('applied'), completedActions: 1 },
      { ...operation('applying'), completedActions: -1 }, { ...operation('applying'), completedActions: 3 },
      { ...operation('applying'), completedActions: 0.5 }, { ...operation('applying'), totalActions: 1.5 },
      { ...operation('applying'), totalActions: Number.MAX_SAFE_INTEGER + 1 },
      { ...operation('applying'), phase: 'invented' }, { ...operation('applying'), kind: 'invented' },
      { ...operation('applying'), selections: [{ sourcePath: '../foreign.md' }] },
      { ...operation('applying'), selections: [{ sourcePath: 'old.md', destinationPath: '/private/new.md' }] },
      { ...operation('applying'), issues: [{ code: 'PRIVATE_DETAILS', path: 'Notizen.md' }] },
      ...['../private.md', '/private/data.md', 'folder\\private.md', 'https://private.test/file', 'private\u0000.md'].map((path) =>
        ({ ...operation('applying'), issues: [{ code: 'source-unreadable', path }] })),
    ];
    for (const invalid of invalidOperations) {
      replies = [{ body: { operation: invalid } }];
      await assert.rejects(poll({ operation: operation('queued') }), /Invalid file action status response/u);
    }

    const blockedOperation = { ...operation('blocked'), errorCode: 'PREVIEW_BLOCKED',
      issues: [{ code: 'unevaluated-link', path: 'HTML.md' }] };
    replies = [{ status: 409, body: { error: 'Links could not be checked', operation: { ...blockedOperation,
      privatePlan: { content: 'private' }, issues: [{ ...blockedOperation.issues[0], rawHtml: '<private>' }] } } }];
    await assert.rejects(poll({ operation: operation('queued') }), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.deepEqual(error.operation, blockedOperation, 'a rejected poll retains a validated current operation and safe cause');
      assert.equal(error.message, 'Links could not be checked');
      return true;
    });
    for (const invalid of [...invalidOperations,
      { ...blockedOperation, workspaceId: 'foreign-workspace' },
      { ...blockedOperation, batchId: 'other-client-batch-1234567890' },
      { ...blockedOperation, planId: 'b'.repeat(64) },
    ]) {
      replies = [{ status: 409, body: { error: 'Rejected status response', operation: invalid } }];
      await assert.rejects(poll({ operation: operation('queued') }), (error: unknown) => {
        assert.ok(error instanceof WorkspacePathOperationClientError);
        assert.deepEqual(error.operation, operation('queued'), 'rejected foreign or malformed polling payloads keep the known identity');
        assert.equal(error.message, 'Rejected status response');
        return true;
      });
    }
    const progressing = { ...operation('applying'), completedActions: 1 };
    replies = [{ body: { operation: progressing } },
      { status: 403, body: { error: 'Workspace access has changed', operation: { ...progressing, workspaceId: 'foreign-workspace' } } }];
    await assert.rejects(poll({ operation: operation('queued') }), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.deepEqual(error.operation, progressing, 'rejected polling retains the most recent validated progress');
      return true;
    });

    replies = [{ status: 403, body: { error: 'Workspace access has changed' } }];
    await assert.rejects(poll({ operation: operation('queued') }), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.equal(error.operation.batchId, operation('queued').batchId);
      assert.equal(error.operation.status, 'queued');
      assert.equal(error.message, 'Workspace access has changed');
      return true;
    });

    replies = [];
    const callsBeforeTimeout = requests.length;
    const durable = operation('applying');
    await assert.rejects(poll({ operation: durable }, 0), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.deepEqual(error.operation, durable, 'timeout does not cancel or pretend to complete durable work');
      assert.match(error.message, /still running/u);
      return true;
    });
    assert.equal(requests.length, callsBeforeTimeout);

    const undone = { operation: operation('undone') };
    assert.deepEqual(await waitForWorkspacePathOperationResult(undone, 'workspace-client', { expectedOutcome: 'undone' }), undone);
    await assert.rejects(waitForWorkspacePathOperationResult(applied, 'workspace-client', { expectedOutcome: 'undone' }),
      WorkspacePathOperationClientError, 'an unchanged forward operation does not imply successful Undo');
    replies = [{ body: { operation: operation('queued') } }, { body: undone }];
    assert.deepEqual(await waitForWorkspacePathOperationResult({ operation: operation('queued') }, 'workspace-client',
      { expectedOutcome: 'undone', intervalMs: 0, timeoutMs: 1000 }), undone);

    replies = [{ body: undone }];
    await undoWorkspacePathOperation(applied.operation);
    const undoRequest = requests.at(-1)!;
    assert.equal(undoRequest.url, '/api/files/operations/batches/direct-client-batch-1234567890');
    assert.equal(undoRequest.init?.method, 'POST');
    assert.equal(undoRequest.init?.credentials, 'include');
    assert.equal(new Headers(undoRequest.init?.headers).get(WORKSPACE_ID_HEADER), 'workspace-client');
    assert.equal(new Headers(undoRequest.init?.headers).get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(String(undoRequest.init?.body)), { action: 'undo', planId: 'a'.repeat(64) });
    replies = [{ status: 409, body: { error: 'Current document has changed' } }];
    await assert.rejects(undoWorkspacePathOperation(applied.operation), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.deepEqual(error.operation, applied.operation);
      assert.equal(error.message, 'Current document has changed');
      return true;
    });
    const undoBlocked = { ...operation('blocked'), errorCode: 'UNDO_CURRENT_CONTENT_CHANGED',
      issues: [{ code: 'content-changed', path: 'new.md' }] };
    replies = [{ status: 409, body: { error: 'Current document has changed', operation: { ...undoBlocked,
      privatePlan: { content: 'private' }, issues: [{ ...undoBlocked.issues[0], currentText: 'private document text' }] } } }];
    await assert.rejects(undoWorkspacePathOperation(applied.operation), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.deepEqual(error.operation, undoBlocked, 'Undo rejection retains the current safe cause for the same durable operation');
      assert.equal(error.message, 'Current document has changed');
      return true;
    });
    for (const invalid of [...invalidOperations,
      { ...undoBlocked, workspaceId: 'foreign-workspace' },
      { ...undoBlocked, batchId: 'other-client-batch-1234567890' },
      { ...undoBlocked, planId: 'b'.repeat(64) },
    ]) {
      replies = [{ status: 409, body: { error: 'Rejected Undo response', operation: invalid } }];
      await assert.rejects(undoWorkspacePathOperation(applied.operation), (error: unknown) => {
        assert.ok(error instanceof WorkspacePathOperationClientError);
        assert.deepEqual(error.operation, applied.operation, 'foreign or malformed Undo rejections cannot replace the known operation');
        assert.equal(error.message, 'Rejected Undo response');
        return true;
      });
    }
    for (const body of [
      {}, { operation: { ...undone.operation, batchId: 'other-client-batch-1234567890' } },
      { operation: { ...undone.operation, planId: 'b'.repeat(64) } },
      { operation: { ...undone.operation, workspaceId: 'foreign-workspace' } },
    ]) {
      replies = [{ body }];
      await assert.rejects(undoWorkspacePathOperation(applied.operation),
        /Invalid file action status response|identity changed/u, 'Undo cannot acknowledge a missing or unrelated result');
    }
    replies = [];
    const beforeInvalidUndo = requests.length;
    await assert.rejects(undoWorkspacePathOperation({ ...applied.operation, batchId: '../private/batch' }),
      /Invalid file action status response/u, 'an invalid input operation never constructs an Undo request');
    assert.equal(requests.length, beforeInvalidUndo);
    console.log('workspace path client: scoped polling, settled success, durable failures, identity protection and timeout passed');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

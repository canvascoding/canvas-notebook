import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIRequestContext } from '@playwright/test';
import { completeNativeFixtureRename } from '../tests/helpers/completed-native-rename';

const input = { workspaceId: 'workspace', oldPath: 'owned.md', newPath: 'moved.md',
  operationId: '11111111-1111-4111-8111-111111111111' };
const requestId = '22222222-2222-4222-8222-222222222222';
const binding = { version: 1, kind: 'implicit-move-binding', actorUserId: 'actor', workspaceId: input.workspaceId,
  operationId: input.operationId, requestId, selectionDigest: 'a'.repeat(64) };
const preparation = { ...binding, version: 2, kind: 'implicit-move-preparation', action: 'rename',
  selections: [{ sourcePath: input.oldPath, destinationPath: input.newPath }], state: 'pending', status: 'draining', canResume: true,
  statusUrl: `/api/files/operations/implicit-moves/${requestId}`, resumeUrl: `/api/files/operations/implicit-moves/${requestId}` };
const completed = { success: true, operation: { batchId: 'batch-identifier-12345', workspaceId: input.workspaceId,
  planId: 'b'.repeat(64), kind: 'rename', selections: preparation.selections, status: 'applied', phase: 'complete',
  completedActions: 1, totalActions: 1, errorCode: null, implicitBinding: binding }, linkStatus: 'complete',
  mutation: { type: 'rename', workspaceId: input.workspaceId, oldPath: input.oldPath, newPath: input.newPath } };
const busy = { success: false, code: 'IMPLICIT_MOVE_BUSY', operationId: input.operationId };

function target(responses: Array<[number, unknown] | Error>) {
  const calls: Array<{ endpoint: string; data: unknown; timeout?: number }> = [];
  const api = {
    get: async () => ({ status: () => 200, json: async () => ({ user: { id: 'actor' } }) }),
    post: async (endpoint: string, options: { data: unknown; timeout?: number }) => {
      calls.push({ endpoint, ...options });
      const next = responses.shift(); assert(next, 'Unexpected extra file action.');
      if (next instanceof Error) throw next;
      return { status: () => next[0], json: async () => structuredClone(next[1]) };
    },
  } as unknown as APIRequestContext;
  return { api, calls };
}

test('an explicit busy retry retains the exact original key and selection', async () => {
  const t = target([[503, busy], [200, completed]]);
  const result = await completeNativeFixtureRename(t.api, input);
  assert.equal(result.operation.status, 'applied');
  assert.equal(t.calls.length, 2); assert.deepEqual(t.calls[0].data, t.calls[1].data);
  assert.equal((t.calls[0].data as { idempotencyKey: string }).idempotencyKey, input.operationId);
  assert.equal(t.calls[0].timeout, 55_000);
});

test('a bound pending preparation resumes only its canonical saved request', async () => {
  const t = target([[202, { success: true, preparation }], [200, completed]]);
  await completeNativeFixtureRename(t.api, input);
  assert.equal(t.calls[1].endpoint, preparation.resumeUrl); assert.deepEqual(t.calls[1].data, {});
});

for (const [label, status, payload] of [
  ['unknown busy', 503, { ...busy, code: 'UNKNOWN' }],
  ['changed original ID', 503, { ...busy, operationId: 'other' }],
  ['a request already exists', 503, { ...busy, requestId }],
  ['an operation already exists', 503, { ...busy, operation: {} }],
  ['denied access', 403, { code: 'FORBIDDEN' }],
  ['changed saved actor', 202, { success: true, preparation: { ...preparation, actorUserId: 'other' } }],
  ['recovery required', 202, { success: true, preparation: { ...preparation, status: 'recovery_required', canResume: false } }],
  ['changed final document selection', 200, { ...completed, operation: { ...completed.operation, selections: [{ sourcePath: 'other.md', destinationPath: 'moved.md' }] } }],
] as const) test(`retain data without a new action: ${label}`, async () => {
  const t = target([[status, payload]]);
  await assert.rejects(completeNativeFixtureRename(t.api, input)); assert.equal(t.calls.length, 1);
});

test('an ambiguous transport outcome never repeats the write and retains its key', async () => {
  const t = target([new Error('Connection reset')]);
  await assert.rejects(completeNativeFixtureRename(t.api, input), new RegExp(input.operationId));
  assert.equal(t.calls.length, 1);
});

test('selection contention has a strict retry bound', async () => {
  const t = target([[503, busy], [503, busy], [503, busy]]);
  await assert.rejects(completeNativeFixtureRename(t.api, input)); assert.equal(t.calls.length, 3);
});

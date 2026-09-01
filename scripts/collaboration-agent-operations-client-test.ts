import assert from 'node:assert/strict';

import { loadCollaborationAgentOperations } from '../app/lib/collaboration/agent-operations-client';

const operation = {
  operationId: 'operation-1',
  operationStatus: 'needs_review' as const,
  status: 'needs_review' as const,
  durability: 'needs_review' as const,
  actorId: 'canvas-agent',
  appliedTargetIds: [],
  conflicts: [],
};

async function main() {
  const successfulOperations = await loadCollaborationAgentOperations({
    documentId: 'document/with spaces',
    headers: { 'X-Workspace-Id': 'workspace-1' },
    fetchImpl: async (input, init) => {
      assert.equal(input, '/api/files/collaboration/operations?documentId=document%2Fwith%20spaces');
      assert.equal(init?.cache, 'no-store');
      assert.deepEqual(init?.headers, { 'X-Workspace-Id': 'workspace-1' });
      return Response.json({ operations: Array.from({ length: 24 }, (_, index) => ({
        ...operation,
        operationId: `operation-${index + 1}`,
      })) });
    },
  });
  assert.equal(successfulOperations?.length, 20, 'successful polling should keep enough history for the activity panel');

  const rejectedRequest = await loadCollaborationAgentOperations({
    documentId: 'document-1',
    headers: {},
    fetchImpl: async () => {
      throw new TypeError('Load failed');
    },
  });
  assert.equal(rejectedRequest, null, 'transient mobile fetch failures should be ignored so polling can retry');

  const failedResponse = await loadCollaborationAgentOperations({
    documentId: 'document-1',
    headers: {},
    fetchImpl: async () => new Response(null, { status: 503 }),
  });
  assert.equal(failedResponse, null, 'failed responses should preserve the current operation state');

  const controller = new AbortController();
  controller.abort();
  const abortedRequest = await loadCollaborationAgentOperations({
    documentId: 'document-1',
    headers: {},
    signal: controller.signal,
    fetchImpl: async () => Response.json({ operations: [operation] }),
  });
  assert.equal(abortedRequest, null, 'aborted polling should not update operation state');

  console.log('collaboration agent operations client test passed');
}

void main();

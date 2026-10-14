import assert from 'node:assert/strict';
import Module from 'node:module';
import { NextRequest, NextResponse } from 'next/server';
import { AgentWorkflowError } from '../app/lib/agents/workflow-public-contracts';

// Exercise the actual HTTP adapter with controlled authorization/storage/service
// boundaries. This proves transport behavior, never SQL ownership or execution.
async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const previousLoad = loader._load;
  let existing = false, failure: Error | null = null, writes = 0, reads = 0;
  let received: unknown[][] = [];
  const todo = { id: 'todo-a', title: 'Actual title', description: null, sourceSessionId: 'session-a',
    sourceAgentId: 'agent-a', workspaceId: 'workspace-a', status: 'done' };
  class DeliveryError extends Error { constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); } }
  loader._load = (name, parent, isMain) => {
    if (parent?.filename.endsWith('/api/todos/[id]/follow-up/route.ts')) {
      if (name === '@/app/lib/todos/api') return {
        requireTodoSession: async () => ({ session: { user: { id: 'alice' } } }),
        applyTodoRateLimit: () => ({ ok: true }),
        todoErrorResponse: (error: Error) => NextResponse.json({ success: false, error: error.message }, { status: 400 }),
      };
      if (name === '@/app/lib/todos/store') return { getTodo: async () => ({ ...todo }), updateTodo: async (_userId: string, _id: string, patch: object) => { writes++; return { ...todo, ...patch }; } };
      if (name === '@/app/lib/todos/read-state-actions') return { setTodoReadStateForUser: async () => { writes++; } };
      if (name === '@/app/lib/user-preferences') return { getUserPreferredLocale: async () => 'de' };
      if (name === '@/app/lib/pi/session-runtime-access') return { assertUnambiguousOwnedPiSessionForRuntime: async () => {}, PiSessionRuntimeAccessError: class extends Error {} };
      if (name === '@/app/lib/pi/message-delivery-receipt') return { MessageDeliveryError: DeliveryError };
      if (name === '@/app/lib/pi/durable-message-admission') return { readOwnedAcceptedChatMessage: async () => { reads++; return existing ? Object.freeze({ existingRow: true }) : null; } };
      if (name === '@/app/lib/pi/runtime-service') return {
        getErrorStatusCode: (error: unknown) => error instanceof AgentWorkflowError ? error.status : 500,
        sendFollowUpMessage: async (...args: unknown[]) => { received.push(args); if (failure) throw failure; return null; },
      };
    }
    return previousLoad(name, parent, isMain);
  };
  try {
    const { POST } = await import('../app/api/todos/[id]/follow-up/route');
    const call = (payload: object) => POST(new NextRequest('http://localhost/api/todos/todo-a/follow-up?todoMode=lifecycle', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }), { params: Promise.resolve({ id: 'todo-a' }) });
    const request = { clientMessageId: 'todo-stable', expectedSessionId: 'session-a', comment: 'Fertig', locale: 'de' };
    assert.equal((await call({ comment: 'Fertig' })).status, 400);
    assert.equal((await call({ clientMessageId: 'todo-stable', comment: 'Fertig' })).status, 400);
    assert.equal((await call({ ...request, expectedSessionId: 'other-session' })).status, 409);
    assert.equal(writes, 0); assert.equal(reads, 0); assert.equal(received.length, 0);

    const admitted = await call(request); assert.equal(admitted.status, 200);
    assert.equal((await admitted.json()).data.runtimeStatus, null);
    assert.equal(writes, 2); assert.equal(reads, 1); assert.equal(received.length, 1);
    const args = received[0]; assert.equal(args[0], 'session-a'); assert.equal(args[1], 'alice');
    assert.equal((args[2] as Record<string, unknown>).clientMessageId, request.clientMessageId);
    assert.deepEqual(args[4], { expectedAgentId: 'agent-a' });

    existing = true; writes = 0; received = [];
    const replay = await call(request); assert.equal(replay.status, 200);
    assert.equal((await replay.json()).data.runtimeStatus, null);
    assert.equal(writes, 0, 'Confirmed HTTP replay does not rewrite the to-do, read state, sent time or error');
    assert.equal(received.length, 1, 'The service still validates the exact replay intent');
    failure = new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'Use was revoked.', 403);
    const denied = await call(request); assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'AGENT_EXTENSION_CONTEXT_DENIED');
    assert.equal(writes, 0, 'Denied replay does not mutate task bookkeeping');
    console.log('PASS actual Todo follow-up HTTP adapter: stable CID and original Session fence, nullable ACK, readonly replay and denied error code; no SQL/source/execution authority claimed.');
  } finally { loader._load = previousLoad; }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

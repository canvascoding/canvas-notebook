import assert from 'node:assert/strict';
import { DirectMcpEditCompletionBusyError, readDirectMcpEditCompletion } from '../app/lib/mcp/server/edit-completion';

const busy = () => Object.assign(new Error('room handoff'), { code: 'ROOM_OWNER_BUSY' });
let reads = 0, checks = 0;
assert.equal(await readDirectMcpEditCompletion({ operationId: 'saved-operation', idempotencyKey: 'original-key', assertCurrent: async () => { checks++; },
  read: async () => { if (++reads < 3) throw busy(); return 'verified snapshot'; } }), 'verified snapshot');
assert.equal(reads, 3); assert.equal(checks, 4);
const completionDenied = busy(); reads = 0; checks = 0;
await assert.rejects(readDirectMcpEditCompletion({ operationId: 'saved-operation', idempotencyKey: 'original-key',
  assertCurrent: async () => { if (++checks > 1) throw completionDenied; },
  read: async () => { reads++; return 'snapshot'; } }), error => error === completionDenied);
assert.equal(reads, 1, 'Never retry an authority failure, even when it carries the busy code.');
const denied = new Error('authority revoked'); reads = 0; checks = 0;
await assert.rejects(readDirectMcpEditCompletion({ operationId: 'saved-operation', idempotencyKey: 'original-key',
  assertCurrent: async () => { if (++checks > 1) throw denied; },
  read: async () => { reads++; throw busy(); } }), error => error === denied);
assert.equal(reads, 1);
for (const code of ['ROOM_OWNER_LOST', 'DOCUMENT_SCOPE_CHANGED', 'unknown']) {
  reads = 0; const failure = Object.assign(new Error('not retryable'), { code });
  await assert.rejects(readDirectMcpEditCompletion({ operationId: 'saved-operation', idempotencyKey: 'original-key', assertCurrent: async () => {},
    read: async () => { reads++; throw failure; } }), error => error === failure);
  assert.equal(reads, 1);
}
await assert.rejects(readDirectMcpEditCompletion({ operationId: 'saved-operation', idempotencyKey: 'original-key', assertCurrent: async () => {},
  read: async () => { throw busy(); } }), error => error instanceof DirectMcpEditCompletionBusyError
    && error.operationId === 'saved-operation' && error.idempotencyKey === 'original-key' && error.code === 'MCP_EDIT_COMPLETION_BUSY');
console.log('PASS MCP completion: bounded read-only handoff retry, fresh authority, terminal errors and durable operation identity');

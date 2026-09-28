import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DIRECT_MCP_TOOL_CONFIGURATION_VERSION } from '../app/lib/mcp/server/config';
import {
  buildDirectMcpDocumentUrl,
  buildDirectMcpReviewUrl,
  createDirectMcpEditIdentity,
  parseDirectMcpEditIdempotencyKey,
} from '../app/lib/mcp/server/document-edit-contract';

test('edit tool advertises review-aware receipts and stable retries', async () => {
  const previousBaseUrl = process.env.BASE_URL;
  const previousBetterAuthBaseUrl = process.env.BETTER_AUTH_BASE_URL;
  process.env.BASE_URL = 'https://canvas.example.test';
  process.env.BETTER_AUTH_BASE_URL = 'https://canvas.example.test';
  const { getDirectMcpWorkspaceToolDescriptor } = await import('../app/lib/mcp/server/workspace-tools');
  if (previousBaseUrl === undefined) delete process.env.BASE_URL;
  else process.env.BASE_URL = previousBaseUrl;
  if (previousBetterAuthBaseUrl === undefined) delete process.env.BETTER_AUTH_BASE_URL;
  else process.env.BETTER_AUTH_BASE_URL = previousBetterAuthBaseUrl;
  const descriptor = getDirectMcpWorkspaceToolDescriptor('edit_knowledge_source');
  const input = descriptor.inputSchema as {
    properties: Record<string, { description?: string }>;
  };
  const output = descriptor.outputSchema as {
    properties: Record<string, unknown>;
    required: string[];
  };

  assert.equal(DIRECT_MCP_TOOL_CONFIGURATION_VERSION, 5);
  assert.ok(input.properties.idempotency_key);
  for (const field of [
    'status',
    'authoritative_updated',
    'requires_user_action',
    'current_sha256',
    'proposed_sha256',
    'operation_id',
    'proposal_id',
    'proposal_lifecycle',
    'review_url',
    'document_url',
    'idempotency_key',
    'message',
  ]) {
    assert.ok(output.properties[field], `missing output field ${field}`);
    assert.ok(output.required.includes(field), `output field ${field} is not required`);
  }
  assert.match(descriptor.description ?? '', /review_required/u);
  assert.match(descriptor.description ?? '', /review_url/u);
});

test('external MCP identities are bounded and retry keys are request scoped', () => {
  const first = createDirectMcpEditIdentity({
    clientId: 'client with unsafe spaces/and/a/very/long/provider/name',
    userId: 'user-1',
    idempotencyKey: 'request.retry-0001',
  });
  const retry = createDirectMcpEditIdentity({
    clientId: 'client with unsafe spaces/and/a/very/long/provider/name',
    userId: 'user-1',
    idempotencyKey: 'request.retry-0001',
  });
  const otherUser = createDirectMcpEditIdentity({
    clientId: 'client with unsafe spaces/and/a/very/long/provider/name',
    userId: 'user-2',
    idempotencyKey: 'request.retry-0001',
  });

  assert.match(first.actorId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  assert.deepEqual(first, retry);
  assert.notEqual(first.operationIdempotencyKey, first.proposalIdempotencyKey);
  assert.notEqual(first.proposalIdempotencyKey, otherUser.proposalIdempotencyKey);
  assert.equal(first.publicIdempotencyKey, 'request.retry-0001');
  assert.equal(first.retryRequested, true);
  assert.equal(parseDirectMcpEditIdempotencyKey(undefined), null);
  assert.throws(() => parseDirectMcpEditIdempotencyKey('bad key'), /idempotency_key/u);
});

test('review links target the exact workspace lineage and operation without credentials', () => {
  const origin = 'https://canvas.example.test';
  const documentUrl = new URL(buildDirectMcpDocumentUrl({ workspaceId: 'workspace-1', origin }));
  const reviewUrl = new URL(buildDirectMcpReviewUrl({
    workspaceId: 'workspace-1',
    lineageId: 'lineage-1',
    operationId: 'operation-1',
    origin,
  }));

  assert.equal(documentUrl.origin, origin);
  assert.equal(documentUrl.pathname, '/notebook');
  assert.equal(documentUrl.searchParams.get('workspaceId'), 'workspace-1');
  assert.equal(reviewUrl.origin, origin);
  assert.equal(reviewUrl.pathname, '/notebook');
  assert.equal(reviewUrl.searchParams.get('workspaceId'), 'workspace-1');
  assert.equal(reviewUrl.searchParams.get('fvrcTarget'), 'lineage');
  assert.equal(reviewUrl.searchParams.get('fvrcRef'), 'lineage-1');
  assert.equal(reviewUrl.searchParams.get('fvrcSelectedKind'), 'agent_operation');
  assert.equal(reviewUrl.searchParams.get('fvrcSelectedId'), 'operation-1');
  assert.equal(reviewUrl.username, '');
  assert.equal(reviewUrl.password, '');
});

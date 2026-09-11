import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { closeDatabaseConnections, getPostgresRuntimeQueryable } from '../app/lib/db';
import { ensureAgentGrantIntegrationFixture } from './agent-grant-integration-fixture';
import { createCollaborationSessionGrant, parseCollaborationSessionRequest } from '../app/lib/collaboration/session-service';
import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { loadCollaborationState, persistCollaborationYDoc } from '../app/lib/collaboration/persistence';
import { installCollaborationDirectConnection } from '../app/lib/collaboration/direct-connection';
import { applyPersistedAgentTextOperation, createAgentTextTarget, getAgentOperation } from '../app/lib/collaboration/agent-operations';
import { getAgentDirectEditGrantForOperation } from '../app/lib/collaboration/agent-direct-edit-grants';

async function main() {
  assert.equal(process.env.CANVAS_POSTGRES_POOL_MAX, '10', 'Run against the deliberately bounded ten-client pool.');
  const fixture = await ensureAgentGrantIntegrationFixture();
  const { workspace, userId, execution } = fixture;
  const docs = new Map<string, Y.Doc>();
  const requests: Parameters<typeof applyPersistedAgentTextOperation>[0][] = [];
  const uninstall = installCollaborationDirectConnection(async (input, apply, onApplied) => {
    const stored = await loadCollaborationState(input.documentId);
    assert(stored);
    const doc = docs.get(input.documentId)!;
    const result = apply(doc);
    await onApplied?.(result);
    await persistCollaborationYDoc(input.documentId, stored.lifecycleGeneration, doc);
    return result;
  });
  try {
    for (let index = 0; index < 20; index++) {
      const filePath = `capacity-${index}.txt`;
      await fs.writeFile(path.join(workspace.rootPath, filePath), 'Original');
      const request = parseCollaborationSessionRequest({ path: filePath, representation: 'plain_text', ...COLLABORATION_CLIENT_CAPABILITIES });
      assert(request);
      const session = await createCollaborationSessionGrant({ workspace, fileOptions: { workspace }, request });
      const state = await loadCollaborationState(session.documentId);
      assert(state);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, state.yjsState);
      docs.set(session.documentId, doc);
      await fixture.grantForDocument({ documentId: session.documentId });
      requests.push({ documentId: session.documentId, workspace, initiatedByUserId: userId,
        actorId: execution.agentId!, actorSessionId: execution.sessionId, actorDisplayName: 'Capacity test agent',
        idempotencyKey: randomUUID(), runGeneration: 1, requestedMode: 'direct_apply',
        targets: [createAgentTextTarget({ text: doc.getText('content'), from: 0, to: 8, replacement: `Updated ${index}`, groupId: 'edit' })] });
    }
    const startedAt = Date.now();
    const results = await Promise.all(requests.map((request) => applyPersistedAgentTextOperation(request)));
    for (let index = 0; index < results.length; index++) {
      assert.equal(results[index].durability, 'persisted_yjs');
      assert.equal(docs.get(requests[index].documentId)!.getText('content').toString(), `Updated ${index}`);
    }
    await Promise.all(results.flatMap((operation) => [
      getAgentOperation({ operationId: operation.operationId, workspace, userId }).then((result) => {
        assert(result); assert.equal(result.durability, 'persisted_yjs');
        assert.equal(result.operationStatus, 'persisted_yjs');
      }),
      getAgentDirectEditGrantForOperation({ operationId: operation.operationId, workspace, userId }).then((result) => assert(result.grant?.active)),
    ]));
    const pool = getPostgresRuntimeQueryable()!;
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.totalCount, pool.idleCount, 'All operation and grant leases are returned.');
    console.log(`PostgreSQL capacity passed: 20 documents, 20 durable live edits, 40 concurrent review/grant reads; ${Date.now() - startedAt} ms.`);
  } finally {
    uninstall();
    for (const doc of docs.values()) doc.destroy();
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(closeDatabaseConnections);

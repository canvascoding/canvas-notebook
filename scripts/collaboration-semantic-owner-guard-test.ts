import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as Y from 'yjs';

import {
  applyPersistedAgentTextOperation,
  createAgentTextTarget,
  detectLateAgentSemanticConflicts,
  getAgentOperation,
} from '../app/lib/collaboration/agent-operations';
import { installCollaborationDirectConnection } from '../app/lib/collaboration/direct-connection';
import {
  ensureCollaborationState,
  loadCollaborationState,
  persistCollaborationYDoc,
} from '../app/lib/collaboration/persistence';
import { closeDatabaseConnections } from '../app/lib/db';
import { getFileCollaborationState } from '../app/lib/files/collaboration-policy';
import { ensureAgentGrantIntegrationFixture } from './agent-grant-integration-fixture';

const databaseUrl = new URL(process.env.DATABASE_URL || '');
assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
assert.equal(databaseUrl.hostname, '127.0.0.1');
assert.equal(databaseUrl.port, '55433');
assert.match(databaseUrl.pathname, /^\/canvas_editor_test_[0-9a-f]{32}$/u);
assert(process.env.DATA && path.isAbsolute(process.env.DATA), 'An isolated absolute DATA directory is required.');
assert.equal(process.env.CANVAS_DATA_ROOT, process.env.DATA, 'CANVAS_DATA_ROOT must use the isolated DATA directory.');

const suffix = randomUUID();
const userId = `semantic-owner-guard-user-${suffix}`;
const workspaceId = `semantic-owner-guard-workspace-${suffix}`;
const relativePath = `semantic-owner-guard-${suffix}.txt`;
const actorId = 'semantic-owner-guard-agent';
const actorSessionId = `semantic-owner-guard-session-${suffix}`;

async function main(): Promise<void> {
  const fixture = await ensureAgentGrantIntegrationFixture({
    userId,
    agentId: actorId,
    sessionId: actorSessionId,
    workspace: {
      workspaceId,
      rootPath: path.join(process.env.DATA!, 'workspace'),
      workspaceType: 'organization',
    },
  });
  const workspace = fixture.workspace;
  const identity = await getFileCollaborationState({
    workspace,
    path: relativePath,
    ensureDocument: true,
  });
  assert(identity.document, 'The normal file API must allocate a canonical collaboration document.');
  const documentId = identity.document.id;
  const initial = await ensureCollaborationState({
    documentId,
    workspaceId: workspace.workspaceId,
    organizationId: workspace.organizationId || null,
    path: relativePath,
    representation: 'plain_text',
    initialContent: 'Alpha',
  });
  const doc = new Y.Doc({ gc: true });
  Y.applyUpdate(doc, initial.yjsState);

  const uninstallDirectConnection = installCollaborationDirectConnection(async (input, apply, onApplied) => {
    assert.equal(input.documentId, documentId);
    const state = await loadCollaborationState(documentId);
    assert(state);
    const result = apply(doc);
    if (onApplied) await onApplied(result);
    await persistCollaborationYDoc(documentId, state.lifecycleGeneration, doc);
    return result;
  });

  try {
    const text = doc.getText('content');
    const target = createAgentTextTarget({
      text,
      from: 0,
      to: text.length,
      replacement: 'Agent alpha',
      groupId: 'semantic-owner-guard',
    });
    await fixture.grantForDocument({ documentId, agentId: actorId, actorSessionId, targets: [target] });
    const applied = await applyPersistedAgentTextOperation({
      documentId,
      workspace,
      initiatedByUserId: userId,
      actorId,
      actorSessionId,
      actorDisplayName: 'Semantic owner guard agent',
      idempotencyKey: `semantic-owner-guard-${suffix}`,
      runGeneration: 1,
      explicitUserRequest: true,
      documentPath: initial.path,
      documentRepresentation: initial.representation,
      documentLifecycleGeneration: initial.lifecycleGeneration,
      documentSchemaVersion: initial.schemaVersion,
      targets: [target],
    });
    assert.deepEqual(applied.appliedTargetIds, [target.targetId]);
    assert(['applied_to_ydoc', 'persisted_yjs', 'checkpointed_file'].includes(applied.operationStatus));

    text.delete(0, text.length);
    text.insert(0, 'User alpha');
    const beforeGuardedConflict = await getAgentOperation({ operationId: applied.operationId, workspace, userId });
    assert(beforeGuardedConflict);

    const entryGuardError = new Error('injected owner loss before semantic conflict detection');
    let entryGuardCalls = 0;
    await assert.rejects(detectLateAgentSemanticConflicts({
      documentId,
      doc,
      assertRoomActive: () => {
        entryGuardCalls += 1;
        throw entryGuardError;
      },
    }), (error) => error === entryGuardError);
    assert.equal(entryGuardCalls, 1);
    const afterEntryGuard = await getAgentOperation({ operationId: applied.operationId, workspace, userId });
    assert.equal(afterEntryGuard?.operationStatus, beforeGuardedConflict.operationStatus);
    assert.equal(afterEntryGuard?.casVersion, beforeGuardedConflict.casVersion);

    const postReadGuardError = new Error('injected owner loss after semantic conflict operation read');
    let postReadGuardCalls = 0;
    await assert.rejects(detectLateAgentSemanticConflicts({
      documentId,
      doc,
      assertRoomActive: () => {
        postReadGuardCalls += 1;
        if (postReadGuardCalls === 2) throw postReadGuardError;
      },
    }), (error) => error === postReadGuardError);
    assert.equal(postReadGuardCalls, 2);
    const afterPostReadGuard = await getAgentOperation({ operationId: applied.operationId, workspace, userId });
    assert.equal(afterPostReadGuard?.operationStatus, beforeGuardedConflict.operationStatus);
    assert.equal(afterPostReadGuard?.casVersion, beforeGuardedConflict.casVersion);

    let retryGuardCalls = 0;
    await detectLateAgentSemanticConflicts({
      documentId,
      doc,
      assertRoomActive: () => { retryGuardCalls += 1; },
    });
    assert.equal(retryGuardCalls, 2, 'the retained memory window must reach the operation read on retry');
    const conflicted = await getAgentOperation({ operationId: applied.operationId, workspace, userId });
    assert.equal(conflicted?.operationStatus, 'semantic_conflict');
    assert.equal(conflicted.casVersion, beforeGuardedConflict.casVersion + 1);
  } finally {
    uninstallDirectConnection();
    doc.destroy();
  }
}

main()
  .then(() => console.log('collaboration-semantic-owner-guard-test: ok'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabaseConnections();
  });

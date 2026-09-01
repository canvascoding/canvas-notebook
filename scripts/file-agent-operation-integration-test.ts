import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import * as Y from 'yjs';

import {
  executePreparedCollaborationTextEdit,
  prepareCollaborationTextEdit,
  readCurrentCollaborationTextSnapshot,
} from '../app/lib/collaboration/agent-file-edits';
import { materializeCollaborationCheckpoint } from '../app/lib/collaboration/checkpoint';
import {
  acceptAgentOperation,
  applyAgentTextTargets,
  applyPersistedAgentTextOperation,
  cancelAgentOperation,
  createAgentTextTarget,
  createRichAgentTextTargets,
  detectLateAgentSemanticConflicts,
  getAgentOperation,
  listAgentOperations,
  recoverCollaborationAgentOperations,
  rejectAgentOperation,
  revertAgentOperation,
} from '../app/lib/collaboration/agent-operations';
import {
  applyPersistedAgentTextSaga,
  compensateAgentTextSaga,
} from '../app/lib/collaboration/agent-sagas';
import { installCollaborationDirectConnection } from '../app/lib/collaboration/direct-connection';
import { installCollaborationDocumentReader } from '../app/lib/collaboration/document-access';
import {
  CollaborationRepresentationMigrationError,
  CollaborationStateInactiveError,
  CollaborationStateStaleError,
  archivePersistedCollaborationPaths,
  ensureCollaborationState,
  changeCollaborationRepresentation,
  changeCollaborationRepresentationWithSafeMarkdownNormalization,
  compactCollaborationState,
  loadCollaborationState,
  markCollaborationCheckpoint,
  persistCollaborationYDoc,
  reactivatePersistedCollaborationPath,
  serializeCanonicalText,
  withCollaborationCheckpointFence,
} from '../app/lib/collaboration/persistence';
import { createRichMarkdownYDoc, richMarkdownFromYDoc } from '../app/lib/collaboration/markdown-state';
import { removeDocumentPresenceEntry, upsertDocumentPresenceEntry } from '../app/lib/collaboration/presence';
import { installCollaborationRoomInspector } from '../app/lib/collaboration/runtime-state';
import {
  CollaborationSessionError,
  createCollaborationSessionGrant,
} from '../app/lib/collaboration/session-service';
import { openDb } from '../app/lib/db';
import { composeCanvasMarkdownDocument } from '../app/lib/markdown/obsidian-metadata';
import { analyzeMarkdownRichMode } from '../app/lib/markdown/rich-markdown-codec';
import {
  ensureFileRevisionForCurrentContent,
  getFileCollaborationState,
} from '../app/lib/files/collaboration-policy';
import { runWithAgentExecutionContext, type AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { piTools } from '../app/lib/pi/core-tools';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) {
  console.log('file-agent-operation-integration-test: skipped (Postgres test profile is not enabled)');
  process.exit(0);
}

const suffix = randomUUID();
const documentId = `agent-operation-test-${suffix}`;
let richDocumentId = `agent-operation-rich-test-${suffix}`;
const compactionDocumentId = `agent-operation-compaction-test-${suffix}`;
const sagaFirstDocumentId = `agent-operation-saga-first-${suffix}`;
const sagaSecondDocumentId = `agent-operation-saga-second-${suffix}`;
const archivedDocumentId = `agent-operation-archived-${suffix}`;
const checkpointRaceDocumentId = `agent-operation-checkpoint-race-${suffix}`;
const workspaceId = `agent-operation-workspace-${suffix}`;
const userId = `agent-operation-user-${suffix}`;
let toolDocumentId: string | null = null;
let uninitializedToolDocumentId: string | null = null;
let representationRoutingDocumentId: string | null = null;
let autoMigrationDocumentId: string | null = null;
let safeNormalizationMigrationDocumentId: string | null = null;
let concurrentAutoMigrationDocumentId: string | null = null;
const workspace: WorkspaceContext = {
  workspaceId,
  workspaceType: 'organization',
  organizationId: process.env.CANVAS_ORGANIZATION_ID || null,
  rootPath: path.join(process.env.DATA || '/tmp', 'agent-operation-test', suffix),
  permissions: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    canCreatePublicLinks: true,
    canManageWorkspace: true,
    canRunAgent: true,
  },
  legacy: false,
};
const agentExecutionContext: AgentExecutionContext = {
  userId,
  sessionId: `agent-tool-session-${suffix}`,
  agentId: 'canvas-agent',
  workspaceId,
  workspaceType: workspace.workspaceType,
  workspaceName: 'Agent operation integration workspace',
  organizationId: workspace.organizationId || null,
  customerId: null,
  projectId: null,
  workspaceRoot: workspace.rootPath,
  workspaceRootRelativePath: null,
  canWrite: true,
  canDelete: true,
  canShare: true,
  legacy: false,
};

async function runPiTool(
  name: 'read' | 'edit_file' | 'apply_patch' | 'move_path',
  toolCallId: string,
  params: Record<string, unknown>,
) {
  const tool = piTools.find((candidate) => candidate.name === name);
  assert(tool, `PI tool ${name} must exist`);
  return runWithAgentExecutionContext(
    agentExecutionContext,
    () => tool.execute(toolCallId, params),
  );
}

function targetFor(state: Awaited<ReturnType<typeof loadCollaborationState>>, search: string, replacement: string, groupId = 'default') {
  assert(state, 'collaboration state must exist');
  const doc = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(doc, state.yjsState);
    const text = doc.getText('content');
    const from = text.toString().indexOf(search);
    assert.notEqual(from, -1, `target text ${JSON.stringify(search)} must exist`);
    return createAgentTextTarget({ text, from, to: from + search.length, replacement, groupId });
  } finally {
    doc.destroy();
  }
}

async function persistedText(targetDocumentId = documentId): Promise<string> {
  const state = await loadCollaborationState(targetDocumentId);
  assert(state);
  const doc = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(doc, state.yjsState);
    return state.representation === 'plain_text'
      ? doc.getText('content').toString()
      : richMarkdownFromYDoc(doc);
  } finally {
    doc.destroy();
  }
}

async function persistUserMutation(
  mutate: (text: Y.Text) => void,
  targetDocumentId = documentId,
): Promise<Y.Doc> {
  const state = await loadCollaborationState(targetDocumentId);
  assert(state);
  const doc = new Y.Doc({ gc: true });
  Y.applyUpdate(doc, state.yjsState);
  mutate(doc.getText('content'));
  const persisted = await persistCollaborationYDoc(
    targetDocumentId,
    state.lifecycleGeneration,
    doc,
  );
  const canonical = doc.getText('content').toString();
  await markCollaborationCheckpoint({
    documentId: targetDocumentId,
    workspaceId: persisted.workspaceId,
    path: persisted.path,
    lifecycleGeneration: persisted.lifecycleGeneration,
    schemaVersion: persisted.schemaVersion,
    sequence: persisted.documentSequence,
    canonicalContent: canonical,
    serializedContent: serializeCanonicalText(canonical, persisted),
  });
  return doc;
}

async function main(): Promise<void> {
await ensureCollaborationState({
  documentId,
  workspaceId,
  organizationId: workspace.organizationId || null,
  path: `agent-operation-${suffix}.txt`,
  representation: 'plain_text',
  initialContent: 'Alpha\nBeta\nGamma',
});

const activeDocuments = new Map<string, Y.Doc>();
const directConnectionInputs: Array<{ operationId: string; actorSessionId?: string }> = [];
const uninstallDocumentReader = installCollaborationDocumentReader(async (targetDocumentId, targetWorkspaceId, read) => {
  const state = await loadCollaborationState(targetDocumentId);
  assert(state);
  assert.equal(state.workspaceId, targetWorkspaceId);
  const activeDocument = activeDocuments.get(targetDocumentId);
  if (activeDocument) return read(activeDocument);

  const doc = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(doc, state.yjsState);
    return read(doc);
  } finally {
    doc.destroy();
  }
});

const uninstallDirectConnection = installCollaborationDirectConnection(async (input, apply, onApplied) => {
  directConnectionInputs.push({ operationId: input.operationId, actorSessionId: input.actorSessionId });
  const state = await loadCollaborationState(input.documentId);
  assert(state);
  assert.equal(input.documentPath, state.path);
  assert.equal(input.documentRepresentation, state.representation);
  assert.equal(input.documentLifecycleGeneration, state.lifecycleGeneration);
  assert.equal(input.documentSchemaVersion, state.schemaVersion);
  const activeDocument = activeDocuments.get(input.documentId);
  const doc = activeDocument || new Y.Doc({ gc: true });
  try {
    if (!activeDocument) Y.applyUpdate(doc, state.yjsState);
    const result = apply(doc);
    if (onApplied) await onApplied(result);
    const persisted = await persistCollaborationYDoc(
      input.documentId,
      state.lifecycleGeneration,
      doc,
    );
    const canonical = state.representation === 'plain_text'
      ? doc.getText('content').toString()
      : richMarkdownFromYDoc(doc);
    const projection = input.requiresFileCheckpointIdentity
      ? getFileCollaborationState({
          workspace: input.workspace,
          path: persisted.path,
          ensureDocument: false,
        })
      : null;
    if (projection?.document?.id === input.documentId) {
      await materializeCollaborationCheckpoint({
        state: persisted,
        workspace: input.workspace,
        actorUserId: input.initiatedByUserId,
        actorType: input.actorType || 'agent',
        sourceSessionId: input.actorSessionId || input.operationId,
      });
    } else {
      const checkpointedState = await markCollaborationCheckpoint({
        documentId: input.documentId,
        workspaceId: persisted.workspaceId,
        path: persisted.path,
        lifecycleGeneration: persisted.lifecycleGeneration,
        schemaVersion: persisted.schemaVersion,
        sequence: persisted.documentSequence,
        canonicalContent: canonical,
        serializedContent: serializeCanonicalText(canonical, persisted),
      });
      assert(checkpointedState, 'The test collaboration checkpoint CAS must confirm the persisted state.');
      assert.equal(checkpointedState.checkpointSequence, persisted.documentSequence);
      assert.equal(
        (await loadCollaborationState(input.documentId))?.checkpointSequence,
        persisted.documentSequence,
      );
    }
    return result;
  } finally {
    if (!activeDocument) doc.destroy();
  }
});

try {
  await ensureCollaborationState({
    documentId: checkpointRaceDocumentId,
    workspaceId,
    organizationId: workspace.organizationId || null,
    path: `agent-operation-checkpoint-race-${suffix}.txt`,
    representation: 'plain_text',
    initialContent: 'Checkpoint sequence N',
  });
  const checkpointRaceInitial = await loadCollaborationState(checkpointRaceDocumentId);
  assert(checkpointRaceInitial);
  const checkpointRaceDoc = new Y.Doc({ gc: true });
  Y.applyUpdate(checkpointRaceDoc, checkpointRaceInitial.yjsState);
  checkpointRaceDoc.getText('content').insert(checkpointRaceDoc.getText('content').length, ' persisted');
  const checkpointRacePersisted = await persistCollaborationYDoc(
    checkpointRaceDocumentId,
    checkpointRaceInitial.lifecycleGeneration,
    checkpointRaceDoc,
  );
  let releaseCheckpointMaterialization!: () => void;
  let reportCheckpointMaterialization!: () => void;
  const checkpointMaterializationReleased = new Promise<void>((resolve) => {
    releaseCheckpointMaterialization = resolve;
  });
  const checkpointMaterializationStarted = new Promise<void>((resolve) => {
    reportCheckpointMaterialization = resolve;
  });
  const fencedCheckpoint = withCollaborationCheckpointFence({
    documentId: checkpointRaceDocumentId,
    workspaceId,
    path: checkpointRacePersisted.path,
    representation: checkpointRacePersisted.representation,
    lifecycleGeneration: checkpointRacePersisted.lifecycleGeneration,
    schemaVersion: checkpointRacePersisted.schemaVersion,
    sequence: checkpointRacePersisted.documentSequence,
    stateVector: checkpointRacePersisted.stateVector,
    materialize: async (lockedState) => {
      reportCheckpointMaterialization();
      await checkpointMaterializationReleased;
      const canonicalContent = 'Checkpoint sequence N persisted';
      return {
        canonicalContent,
        serializedContent: serializeCanonicalText(canonicalContent, lockedState),
        result: canonicalContent,
      };
    },
  });
  await checkpointMaterializationStarted;
  const checkpointRaceNextDoc = new Y.Doc({ gc: true });
  Y.applyUpdate(checkpointRaceNextDoc, checkpointRacePersisted.yjsState);
  checkpointRaceNextDoc.getText('content').insert(
    checkpointRaceNextDoc.getText('content').length,
    ' plus sequence N+1',
  );
  const concurrentPersist = persistCollaborationYDoc(
    checkpointRaceDocumentId,
    checkpointRacePersisted.lifecycleGeneration,
    checkpointRaceNextDoc,
  );
  assert.equal(
    await Promise.race([
      concurrentPersist.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]),
    false,
    'a newer Yjs persist must wait while the checkpoint file/CAS fence holds the document row',
  );
  releaseCheckpointMaterialization();
  const checkpointRaceConfirmed = await fencedCheckpoint;
  assert(checkpointRaceConfirmed);
  assert.equal(
    checkpointRaceConfirmed.state.checkpointSequence,
    checkpointRacePersisted.documentSequence,
  );
  const checkpointRaceAdvanced = await concurrentPersist;
  assert.equal(
    checkpointRaceAdvanced.documentSequence,
    checkpointRacePersisted.documentSequence + 1,
  );
  checkpointRaceDoc.destroy();
  checkpointRaceNextDoc.destroy();

  let state = await loadCollaborationState(documentId);
  const betaTarget = targetFor(state, 'Beta', 'Beta by agent');
  const idempotencyKey = `direct-${suffix}`;
  const direct = await applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey,
    runGeneration: 1,
    targets: [betaTarget],
    explicitUserRequest: true,
  });
  assert.equal(direct.operationStatus, 'checkpointed_file', JSON.stringify(direct));
  assert.equal(direct.durability, 'checkpointed_file');
  assert.equal(await persistedText(), 'Alpha\nBeta by agent\nGamma');

  const duplicate = await applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey,
    runGeneration: 1,
    targets: [betaTarget],
    explicitUserRequest: true,
  });
  assert.equal(duplicate.operationId, direct.operationId);
  assert.equal(await persistedText(), 'Alpha\nBeta by agent\nGamma', 'idempotent redelivery must not apply twice');

  state = await loadCollaborationState(documentId);
  const review = await applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey: `review-${suffix}`,
    runGeneration: 1,
    targets: [targetFor(state, 'Gamma', 'Gamma reviewed')],
    requestedMode: 'review',
  });
  assert.equal(review.operationStatus, 'needs_review');
  assert.equal(await persistedText(), 'Alpha\nBeta by agent\nGamma');
  const accepted = await acceptAgentOperation({
    operationId: review.operationId,
    workspace,
    userId,
    idempotencyKey: `accept-${suffix}`,
  });
  assert.equal(accepted.operationStatus, 'checkpointed_file');
  const acceptedAgain = await acceptAgentOperation({
    operationId: review.operationId,
    workspace,
    userId,
    idempotencyKey: `accept-${suffix}`,
  });
  assert.equal(acceptedAgain.operationStatus, 'checkpointed_file');
  assert.equal(await persistedText(), 'Alpha\nBeta by agent\nGamma reviewed');

  state = await loadCollaborationState(documentId);
  const rejectedReview = await applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey: `reject-review-${suffix}`,
    runGeneration: 1,
    targets: [targetFor(state, 'Alpha', 'Rejected alpha')],
    requestedMode: 'review',
  });
  const rejected = await rejectAgentOperation({
    operationId: rejectedReview.operationId,
    workspace,
    userId,
    idempotencyKey: `reject-${suffix}`,
  });
  assert.equal(rejected.operationStatus, 'rejected');
  assert.equal((await rejectAgentOperation({
    operationId: rejectedReview.operationId,
    workspace,
    userId,
    idempotencyKey: `reject-${suffix}`,
  })).operationStatus, 'rejected');
  assert.equal(await persistedText(), 'Alpha\nBeta by agent\nGamma reviewed');

  state = await loadCollaborationState(documentId);
  const cancellable = await applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey: `cancel-review-${suffix}`,
    runGeneration: 1,
    targets: [targetFor(state, 'Alpha', 'Cancelled alpha')],
    requestedMode: 'review',
  });
  const cancelled = await cancelAgentOperation({
    operationId: cancellable.operationId,
    workspace,
    userId,
    idempotencyKey: `cancel-${suffix}`,
  });
  assert.equal(cancelled.operationStatus, 'cancelled');
  assert.equal((await acceptAgentOperation({
    operationId: cancellable.operationId,
    workspace,
    userId,
    idempotencyKey: `late-accept-${suffix}`,
  })).operationStatus, 'cancelled');
  assert.equal(await persistedText(), 'Alpha\nBeta by agent\nGamma reviewed');

  upsertDocumentPresenceEntry({
    workspaceId,
    documentId,
    path: `agent-operation-${suffix}.txt`,
    userId: 'active-human',
    sessionId: 'active-human-session',
    actorType: 'user',
    initiatedByUserId: null,
    displayName: 'Active Human',
    color: '#123456',
    colorLight: '#abcdef',
    activity: 'editing',
    updatedAt: Date.now(),
  });
  state = await loadCollaborationState(documentId);
  const autonomous = await applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'automation-agent',
    actorDisplayName: 'Automation Agent',
    idempotencyKey: `autonomous-${suffix}`,
    runGeneration: 1,
    targets: [targetFor(state, 'Alpha', 'Autonomous alpha')],
    requestedMode: 'direct_apply',
    explicitUserRequest: false,
  });
  assert.equal(autonomous.operationStatus, 'needs_review', 'autonomous work must default to review while a human is active');
  const collaboratorWorkspace: WorkspaceContext = {
    ...workspace,
    permissions: { ...workspace.permissions, canManageWorkspace: false },
  };
  const collaboratorView = await getAgentOperation({
    operationId: autonomous.operationId,
    workspace: collaboratorWorkspace,
    userId: `agent-operation-collaborator-${suffix}`,
  });
  assert.equal(collaboratorView?.initiatedByCurrentUser, false);
  assert.equal(collaboratorView?.actionsAllowed, false);
  assert.equal(collaboratorView?.targetAnchors.length, 1, 'collaborators must receive stable target anchors for inline activity');
  assert.ok(
    (await listAgentOperations({
      documentId,
      workspace: collaboratorWorkspace,
      userId: `agent-operation-collaborator-${suffix}`,
    })).some((operation) => operation.operationId === autonomous.operationId),
    'workspace readers must see agent activity from other collaborators',
  );
  await assert.rejects(
    rejectAgentOperation({
      operationId: autonomous.operationId,
      workspace: collaboratorWorkspace,
      userId: `agent-operation-collaborator-${suffix}`,
      idempotencyKey: `reject-other-${suffix}`,
    }),
    /not found/i,
    'a reader must not be able to act on another collaborator\'s operation',
  );
  removeDocumentPresenceEntry({ workspaceId, documentId, userId: 'active-human', actorType: 'user' });
  await rejectAgentOperation({ operationId: autonomous.operationId, workspace, userId, idempotencyKey: `reject-autonomous-${suffix}` });

  state = await loadCollaborationState(documentId);
  const safeRevertSource = await applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey: `revert-source-${suffix}`,
    runGeneration: 1,
    targets: [targetFor(state, 'Alpha', 'Applied alpha')],
    explicitUserRequest: true,
    actorSessionId: `revert-session-${suffix}`,
  });
  assert.equal(safeRevertSource.operationStatus, 'checkpointed_file');
  const reverted = await revertAgentOperation({
    operationId: safeRevertSource.operationId,
    workspace,
    userId,
    idempotencyKey: `revert-${suffix}`,
  });
  assert.equal(reverted.operationStatus, 'reverted');
  assert.ok(
    directConnectionInputs.some((input) => (
      input.operationId === reverted.operationId
      && input.actorSessionId === `revert-session-${suffix}`
    )),
    'Revert operations must preserve the originating agent session for direct collaboration authorization.',
  );
  assert.equal(await persistedText(), 'Alpha\nBeta by agent\nGamma reviewed');

  state = await loadCollaborationState(documentId);
  const overlapRevertSource = await applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey: `overlap-revert-source-${suffix}`,
    runGeneration: 1,
    targets: [targetFor(state, 'Alpha', 'Agent alpha')],
    explicitUserRequest: true,
  });
  const userDoc = await persistUserMutation((text) => {
    text.delete(0, 'Agent alpha'.length);
    text.insert(0, 'User alpha');
  });
  await detectLateAgentSemanticConflicts({ documentId, doc: userDoc });
  userDoc.destroy();
  const conflicted = await getAgentOperation({ operationId: overlapRevertSource.operationId, workspace, userId });
  assert.equal(conflicted?.operationStatus, 'semantic_conflict');
  const unsafeRevert = await revertAgentOperation({
    operationId: overlapRevertSource.operationId,
    workspace,
    userId,
    idempotencyKey: `unsafe-revert-${suffix}`,
  });
  assert.equal(unsafeRevert.operationStatus, 'needs_review');
  assert.equal(await persistedText(), 'User alpha\nBeta by agent\nGamma reviewed');

  // A connection that acknowledged the agent checkpoint may intentionally edit
  // the same text later without being misclassified as an offline race.
  state = await loadCollaborationState(documentId);
  const seenAgentEdit = await applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey: `seen-agent-${suffix}`,
    runGeneration: 1,
    targets: [targetFor(state, 'Beta by agent', 'Beta seen by user')],
    explicitUserRequest: true,
  });
  assert.equal(seenAgentEdit.operationStatus, 'checkpointed_file');
  const seenState = await loadCollaborationState(documentId);
  assert(seenState);
  const seenUserDoc = await persistUserMutation((text) => {
    const from = text.toString().indexOf('Beta seen by user');
    text.delete(from, 'Beta seen by user'.length);
    text.insert(from, 'Beta human after seeing agent');
  });
  await detectLateAgentSemanticConflicts({
    documentId,
    doc: seenUserDoc,
    observedDocumentSequence: seenState.documentSequence,
  });
  seenUserDoc.destroy();
  assert.equal(
    (await getAgentOperation({ operationId: seenAgentEdit.operationId, workspace, userId }))?.operationStatus,
    'checkpointed_file',
    'an acknowledged agent change must not make every later human edit a semantic conflict',
  );

  // Degraded persistence blocks new authoritative writes and returns review.
  let database = await openDb();
  try {
    await database.run('UPDATE collaboration_yjs_states SET degraded = 1 WHERE document_id = ?', [documentId]);
  } finally {
    await database.close();
  }
  state = await loadCollaborationState(documentId);
  const degradedOperation = await applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey: `degraded-${suffix}`,
    runGeneration: 1,
    targets: [targetFor(state, 'Gamma reviewed', 'Must not apply')],
    explicitUserRequest: true,
  });
  assert.equal(degradedOperation.operationStatus, 'needs_review');
  assert.equal(degradedOperation.conflicts[0]?.code, 'persistence_degraded');
  database = await openDb();
  try {
    await database.run('UPDATE collaboration_yjs_states SET degraded = 0 WHERE document_id = ?', [documentId]);
  } finally {
    await database.close();
  }
  await rejectAgentOperation({
    operationId: degradedOperation.operationId,
    workspace,
    userId,
    idempotencyKey: `reject-degraded-${suffix}`,
  });

  // One causal chain cannot create the same semantic operation twice even if
  // an outbox consumer changes its transport idempotency key.
  state = await loadCollaborationState(documentId);
  const chainTarget = targetFor(state, 'Gamma reviewed', 'Gamma chain preview');
  const chainCorrelationId = `chain-${suffix}`;
  const chainFirst = await applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'automation-agent',
    actorDisplayName: 'Automation Agent',
    idempotencyKey: `chain-first-${suffix}`,
    runGeneration: 1,
    targets: [chainTarget],
    requestedMode: 'review',
    correlationId: chainCorrelationId,
    causationId: 'file-watcher-event',
    triggerDepth: 1,
  });
  const chainDuplicate = await applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'automation-agent',
    actorDisplayName: 'Automation Agent',
    idempotencyKey: `chain-redelivery-${suffix}`,
    runGeneration: 1,
    targets: [chainTarget],
    requestedMode: 'review',
    correlationId: chainCorrelationId,
    causationId: 'file-watcher-event',
    triggerDepth: 1,
  });
  assert.equal(chainDuplicate.operationId, chainFirst.operationId);
  await assert.rejects(() => applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'automation-agent',
    actorDisplayName: 'Automation Agent',
    idempotencyKey: `loop-depth-${suffix}`,
    runGeneration: 1,
    targets: [chainTarget],
    requestedMode: 'review',
    correlationId: chainCorrelationId,
    causationId: chainFirst.operationId,
    triggerDepth: 5,
  }), /feedback-loop limit/u);
  await rejectAgentOperation({
    operationId: chainFirst.operationId,
    workspace,
    userId,
    idempotencyKey: `reject-chain-${suffix}`,
  });

  // Restart recovery never blindly replays an uncertain applying operation.
  state = await loadCollaborationState(documentId);
  const restartReview = await applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey: `restart-review-${suffix}`,
    runGeneration: 1,
    targets: [targetFor(state, 'Gamma reviewed', 'Restart preview')],
    requestedMode: 'review',
  });
  const expiringReview = await applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey: `restart-expired-${suffix}`,
    runGeneration: 1,
    targets: [targetFor(state, 'Gamma reviewed', 'Expired preview')],
    requestedMode: 'review',
  });
  database = await openDb();
  try {
    await database.run(
      "UPDATE collaboration_agent_operations SET status = 'applying', result_json = NULL, resulting_state_vector_hash = NULL WHERE operation_id = ?",
      [restartReview.operationId],
    );
    await database.run(
      "UPDATE collaboration_agent_operations SET status = 'preparing', result_json = NULL, expires_at = ? WHERE operation_id = ?",
      [Date.now() - 1, expiringReview.operationId],
    );
    await database.run(
      "UPDATE collaboration_agent_operations SET status = 'applied_to_ydoc' WHERE operation_id = ?",
      [seenAgentEdit.operationId],
    );
  } finally {
    await database.close();
  }
  await recoverCollaborationAgentOperations();
  assert.equal(
    (await getAgentOperation({ operationId: restartReview.operationId, workspace, userId }))?.operationStatus,
    'needs_review',
  );
  assert.equal(
    (await getAgentOperation({ operationId: expiringReview.operationId, workspace, userId }))?.operationStatus,
    'expired',
  );
  assert.equal(
    (await getAgentOperation({ operationId: seenAgentEdit.operationId, workspace, userId }))?.operationStatus,
    'checkpointed_file',
  );

  database = await openDb();
  try {
    const durability = await database.get(
      `SELECT applied_at, persisted_at, checkpointed_at, applied_document_sequence
       FROM collaboration_agent_operations WHERE operation_id = ?`,
      [direct.operationId],
    ) as { applied_at: number; persisted_at: number; checkpointed_at: number; applied_document_sequence: number };
    assert(durability.applied_at > 0);
    assert(durability.persisted_at >= durability.applied_at);
    assert(durability.checkpointed_at >= durability.persisted_at);
    assert(durability.applied_document_sequence > 0);
  } finally {
    await database.close();
  }

  // Rich Markdown agent edits use stable anchors inside Y.XmlText and pass a
  // schema/stable-ID/roundtrip clone before the authoritative transaction.
  const richPath = `agent-operation-rich-${suffix}.md`;
  const richInitialContent = 'Rich **bold** paragraph\n\nOther paragraph';
  await fs.mkdir(workspace.rootPath, { recursive: true });
  await fs.writeFile(path.join(workspace.rootPath, richPath), richInitialContent, 'utf8');
  ensureFileRevisionForCurrentContent({
    workspace,
    path: richPath,
    contentHash: createHash('sha256').update(richInitialContent, 'utf8').digest('hex'),
    sizeBytes: Buffer.byteLength(richInitialContent, 'utf8'),
    actorUserId: userId,
    actorType: 'user',
  });
  const richProjection = getFileCollaborationState({
    workspace,
    path: richPath,
    ensureDocument: true,
  });
  assert(richProjection.document);
  richDocumentId = richProjection.document.id;
  await ensureCollaborationState({
    documentId: richDocumentId,
    workspaceId,
    organizationId: workspace.organizationId || null,
    path: richPath,
    representation: 'tiptap_xml',
    initialContent: richInitialContent,
  });
  const richState = await loadCollaborationState(richDocumentId);
  assert(richState);
  const richDoc = new Y.Doc({ gc: true });
  Y.applyUpdate(richDoc, richState.yjsState);
  const richTargets = createRichAgentTextTargets({ doc: richDoc, search: 'bold', replacement: 'strong' });
  const richExpected = richMarkdownFromYDoc(richDoc).replace('bold', 'strong');
  richDoc.destroy();
  const richOperation = await applyPersistedAgentTextOperation({
    documentId: richDocumentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey: `rich-${suffix}`,
    runGeneration: 1,
    targets: richTargets,
    explicitUserRequest: true,
    expectedCanonicalHash: createHash('sha256').update(richExpected, 'utf8').digest('hex'),
  });
  assert.equal(richOperation.operationStatus, 'checkpointed_file');
  assert.match(await persistedText(richDocumentId), /Rich \*\*strong\*\* paragraph/u);

  // The real PI tools read and validate against the current in-memory Y.Doc,
  // not the older materialized file checkpoint. A stale checkpoint hash is
  // rejected with the new live hash; the retried stable edit applies directly.
  const toolPath = `agent-tool-live-${suffix}.md`;
  const checkpointContent = 'Tool **checkpoint** paragraph\n\nLive paragraph';
  const liveContent = 'Tool **checkpoint** paragraph\n\nLive paragraph edited by user';
  await fs.mkdir(workspace.rootPath, { recursive: true });
  await fs.writeFile(path.join(workspace.rootPath, toolPath), checkpointContent, 'utf8');
  ensureFileRevisionForCurrentContent({
    workspace,
    path: toolPath,
    contentHash: createHash('sha256').update(checkpointContent, 'utf8').digest('hex'),
    sizeBytes: Buffer.byteLength(checkpointContent, 'utf8'),
    actorUserId: userId,
    actorType: 'user',
  });
  const toolCollaboration = getFileCollaborationState({
    workspace,
    path: toolPath,
    ensureDocument: false,
  });
  assert(toolCollaboration.document);
  toolDocumentId = toolCollaboration.document.id;
  await ensureCollaborationState({
    documentId: toolDocumentId,
    workspaceId,
    organizationId: workspace.organizationId || null,
    path: toolPath,
    representation: 'tiptap_xml',
    initialContent: checkpointContent,
  });
  const activeToolDocument = createRichMarkdownYDoc(liveContent);
  activeDocuments.set(toolDocumentId, activeToolDocument);

  const toolRead = await runPiTool('read', `tool-read-${suffix}`, { path: toolPath });
  const toolReadDetails = toolRead.details as {
    sha256?: string;
    collaboration?: {
      source?: string;
      stateVector?: string;
      lifecycleGeneration?: number;
      documentSequence?: number;
    };
  };
  const liveHash = createHash('sha256').update(liveContent, 'utf8').digest('hex');
  assert.equal(toolReadDetails.sha256, liveHash);
  assert.equal(toolReadDetails.collaboration?.source, 'live_yjs');
  assert.equal(toolReadDetails.collaboration?.lifecycleGeneration, 1);
  assert.equal(toolReadDetails.collaboration?.documentSequence, 0);
  assert.match(
    String((toolRead.content[0] as { text?: string } | undefined)?.text || ''),
    /Source: live Yjs collaboration state/u,
  );

  const staleToolEdit = await runPiTool('edit_file', `tool-stale-${suffix}`, {
    path: toolPath,
    expectedSha256: createHash('sha256').update(checkpointContent, 'utf8').digest('hex'),
    oldText: 'Live paragraph edited by user',
    newText: 'Stale edit must not apply',
  });
  const staleToolError = String((staleToolEdit.details as { error?: string }).error || '');
  assert.match(staleToolError, /current live collaboration state/u);
  assert.match(staleToolError, new RegExp(liveHash, 'u'));
  assert.equal(richMarkdownFromYDoc(activeToolDocument), liveContent);

  const directToolEdit = await runPiTool('edit_file', `tool-direct-${suffix}`, {
    path: toolPath,
    expectedSha256: liveHash,
    oldText: 'Live paragraph edited by user',
    newText: 'Live paragraph updated by agent',
  });
  const directToolDetails = directToolEdit.details as {
    collaboration?: {
      operationId?: string;
      reviewRequired?: boolean;
      operationStatus?: string;
      durability?: string;
    };
  };
  assert.equal(directToolDetails.collaboration?.reviewRequired, false);
  assert.equal(directToolDetails.collaboration?.operationStatus, 'checkpointed_file');
  assert.equal(directToolDetails.collaboration?.durability, 'checkpointed_file');
  assert(directToolDetails.collaboration?.operationId);
  const operationDatabase = await openDb();
  try {
    const operationRow = await operationDatabase.get(
      `SELECT document_path, document_representation, document_lifecycle_generation,
              base_state_vector, base_document_sequence, checkpoint_revision_id
       FROM collaboration_agent_operations WHERE operation_id = ?`,
      [directToolDetails.collaboration.operationId],
    ) as {
      document_path: string;
      document_representation: string;
      document_lifecycle_generation: number;
      base_state_vector: Buffer;
      base_document_sequence: number;
      checkpoint_revision_id: string | null;
    } | undefined;
    assert(operationRow);
    assert.equal(operationRow.document_path, toolPath);
    assert.equal(operationRow.document_representation, 'tiptap_xml');
    assert.equal(Number(operationRow.document_lifecycle_generation), 1);
    assert.equal(Buffer.from(operationRow.base_state_vector).toString('base64'), toolReadDetails.collaboration?.stateVector);
    assert.equal(Number(operationRow.base_document_sequence), toolReadDetails.collaboration?.documentSequence);
    assert(operationRow.checkpoint_revision_id);
    const checkpointProjection = getFileCollaborationState({
      workspace,
      path: toolPath,
      ensureDocument: false,
    });
    const checkpointState = await loadCollaborationState(toolDocumentId);
    assert(checkpointState);
    assert.equal(checkpointProjection.document?.stateVersion, checkpointState.checkpointSequence);
    assert.equal(checkpointProjection.document?.snapshotRevisionId, operationRow.checkpoint_revision_id);
    const staleCheckpoint = await markCollaborationCheckpoint({
      documentId: toolDocumentId,
      workspaceId: checkpointState.workspaceId,
      path: checkpointState.path,
      lifecycleGeneration: checkpointState.lifecycleGeneration + 1,
      schemaVersion: checkpointState.schemaVersion,
      sequence: checkpointState.documentSequence,
      canonicalContent: 'This stale checkpoint must not be confirmed',
      serializedContent: 'This stale checkpoint must not be confirmed',
    });
    assert.equal(staleCheckpoint, null);
  } finally {
    await operationDatabase.close();
  }
  assert.ok(
    directConnectionInputs.some((input) => input.actorSessionId === agentExecutionContext.sessionId),
    'Agent tool operations must forward their PI session to the direct collaboration connection.',
  );
  assert.equal(
    richMarkdownFromYDoc(activeToolDocument),
    'Tool **checkpoint** paragraph\n\nLive paragraph updated by agent',
  );

  // A same-content Y.Doc rebuilt from a checkpoint has different client clocks.
  // The prepared agent edit must not treat that reset as the state it observed.
  const staleVectorPrepared = await prepareCollaborationTextEdit({
    documentId: toolDocumentId,
    workspace,
    path: toolPath,
    edits: [{
      oldText: 'Live paragraph updated by agent',
      newText: 'Reset state must reject this edit',
      expectedOccurrences: 1,
    }],
    expectedSha256: createHash('sha256')
      .update('Tool **checkpoint** paragraph\n\nLive paragraph updated by agent', 'utf8')
      .digest('hex'),
    groupId: 'stale-vector',
  });
  const resetToolDocument = createRichMarkdownYDoc(
    'Tool **checkpoint** paragraph\n\nLive paragraph updated by agent',
  );
  activeDocuments.set(toolDocumentId, resetToolDocument);
  activeToolDocument.destroy();
  const staleVectorResult = await executePreparedCollaborationTextEdit({
    prepared: staleVectorPrepared,
    workspace,
    identity: {
      initiatedByUserId: userId,
      actorId: 'agent-b',
      actorDisplayName: 'Agent B',
      actorSessionId: agentExecutionContext.sessionId,
    },
    idempotencyKey: `stale-vector-${suffix}`,
  });
  assert.equal(staleVectorResult.operationStatus, 'needs_review');
  assert.equal(staleVectorResult.conflicts[0]?.code, 'lifecycle_stale');
  assert.equal(
    richMarkdownFromYDoc(resetToolDocument),
    'Tool **checkpoint** paragraph\n\nLive paragraph updated by agent',
  );

  // Existing shared Markdown can have collaboration metadata from a normal
  // file read without having opened a browser collaboration session yet. The
  // real agent read must initialize that document exactly once before edit.
  const uninitializedToolPath = `agent-tool-uninitialized-${suffix}.md`;
  const uninitializedToolContent = '# Existing note\n\nParagraph before agent';
  await fs.writeFile(path.join(workspace.rootPath, uninitializedToolPath), uninitializedToolContent, 'utf8');
  ensureFileRevisionForCurrentContent({
    workspace,
    path: uninitializedToolPath,
    contentHash: createHash('sha256').update(uninitializedToolContent, 'utf8').digest('hex'),
    sizeBytes: Buffer.byteLength(uninitializedToolContent, 'utf8'),
    actorUserId: userId,
    actorType: 'user',
  });
  const uninitializedMetadata = getFileCollaborationState({
    workspace,
    path: uninitializedToolPath,
    ensureDocument: false,
  });
  assert(uninitializedMetadata.document);
  uninitializedToolDocumentId = uninitializedMetadata.document.id;
  assert.equal(await loadCollaborationState(uninitializedToolDocumentId), null);

  const initializedRead = await runPiTool('read', `tool-uninitialized-read-${suffix}`, {
    path: uninitializedToolPath,
  });
  const initializedReadDetails = initializedRead.details as {
    sha256?: string;
    collaboration?: { documentId?: string; source?: string };
  };
  assert.equal(initializedReadDetails.collaboration?.documentId, uninitializedToolDocumentId);
  assert.equal(initializedReadDetails.collaboration?.source, 'live_yjs');
  assert.equal(
    initializedReadDetails.sha256,
    createHash('sha256').update(uninitializedToolContent, 'utf8').digest('hex'),
  );
  const initializedState = await loadCollaborationState(uninitializedToolDocumentId);
  assert(initializedState);
  assert.equal(initializedState.lifecycleGeneration, 1);
  assert.equal(initializedState.workspaceId, workspaceId);
  assert.equal(initializedState.path, uninitializedToolPath);
  assert.equal(initializedState.representation, 'tiptap_xml');

  const initializedEdit = await runPiTool('edit_file', `tool-uninitialized-edit-${suffix}`, {
    path: uninitializedToolPath,
    expectedSha256: initializedReadDetails.sha256,
    oldText: 'Paragraph before agent',
    newText: 'Paragraph updated by agent',
  });
  const initializedEditDetails = initializedEdit.details as {
    collaboration?: { operationStatus?: string; durability?: string };
  };
  assert.equal(initializedEditDetails.collaboration?.operationStatus, 'checkpointed_file');
  assert.equal(initializedEditDetails.collaboration?.durability, 'checkpointed_file');
  assert.equal(await persistedText(uninitializedToolDocumentId), '# Existing note\n\nParagraph updated by agent');

  // Global replacements retain the same semantics when Markdown is backed by
  // an active Yjs document rather than a materialized file checkpoint.
  const replaceAllToolPath = `agent-tool-replace-all-${suffix}.md`;
  const replaceAllToolContent = 'Status: draft\n\nStatus: draft\n';
  await fs.writeFile(path.join(workspace.rootPath, replaceAllToolPath), replaceAllToolContent, 'utf8');
  ensureFileRevisionForCurrentContent({
    workspace,
    path: replaceAllToolPath,
    contentHash: createHash('sha256').update(replaceAllToolContent, 'utf8').digest('hex'),
    sizeBytes: Buffer.byteLength(replaceAllToolContent, 'utf8'),
    actorUserId: userId,
    actorType: 'user',
  });
  const replaceAllRead = await runPiTool('read', `tool-replace-all-read-${suffix}`, { path: replaceAllToolPath });
  const replaceAllReadDetails = replaceAllRead.details as {
    sha256?: string;
    collaboration?: { documentId?: string; source?: string };
  };
  assert.equal(replaceAllReadDetails.collaboration?.source, 'live_yjs');
  assert(replaceAllReadDetails.collaboration?.documentId);
  const replaceAllEdit = await runPiTool('edit_file', `tool-replace-all-edit-${suffix}`, {
    path: replaceAllToolPath,
    expectedSha256: replaceAllReadDetails.sha256,
    oldText: 'Status: draft',
    newText: 'Status: ready',
    replaceAll: true,
  });
  assert.equal((replaceAllEdit.details as { collaboration?: { operationStatus?: string } }).collaboration?.operationStatus, 'checkpointed_file');
  assert.equal(
    await persistedText(replaceAllReadDetails.collaboration!.documentId),
    'Status: ready\n\nStatus: ready\n',
  );
  const movedReplaceAllPath = `agent-tool-replace-all-moved-${suffix}.md`;
  const moveLiveMarkdown = await runPiTool('move_path', `tool-replace-all-move-${suffix}`, {
    sourcePath: replaceAllToolPath,
    destinationPath: movedReplaceAllPath,
  });
  assert.equal((moveLiveMarkdown.details as { verified?: boolean }).verified, true);
  const movedReplaceAllRead = await runPiTool('read', `tool-replace-all-moved-read-${suffix}`, {
    path: movedReplaceAllPath,
  });
  const movedReplaceAllDetails = movedReplaceAllRead.details as {
    collaboration?: { documentId?: string; source?: string };
  };
  assert.equal(movedReplaceAllDetails.collaboration?.documentId, replaceAllReadDetails.collaboration?.documentId);
  assert.equal(movedReplaceAllDetails.collaboration?.source, 'live_yjs');
  assert.match(String((movedReplaceAllRead.content[0] as { text?: string } | undefined)?.text || ''), /Status: ready\n\nStatus: ready/u);
  const oldReplaceAllRead = await runPiTool('read', `tool-replace-all-old-read-${suffix}`, { path: replaceAllToolPath });
  assert.match(String((oldReplaceAllRead.content[0] as { text?: string } | undefined)?.text || ''), /ENOENT|no such file|does not exist/i);

  // The durable Yjs representation must win over a source-only checkpoint.
  // This is the regression path for a document that an agent has changed
  // before a browser opens it again.
  const representationRoutingPath = `agent-representation-routing-${suffix}.md`;
  const routingRichInitialContent = '# Strategy update\n\nInitial paragraph\n';
  const sourceOnlyCheckpoint = '# Strategy update\n\nInitial paragraph\n\n%% agent-generated note %%\n';
  await fs.writeFile(path.join(workspace.rootPath, representationRoutingPath), routingRichInitialContent, 'utf8');
  ensureFileRevisionForCurrentContent({
    workspace,
    path: representationRoutingPath,
    contentHash: createHash('sha256').update(routingRichInitialContent, 'utf8').digest('hex'),
    sizeBytes: Buffer.byteLength(routingRichInitialContent, 'utf8'),
    actorUserId: userId,
    actorType: 'user',
  });
  const representationRoutingProjection = getFileCollaborationState({
    workspace,
    path: representationRoutingPath,
    ensureDocument: true,
  });
  assert(representationRoutingProjection.document);
  representationRoutingDocumentId = representationRoutingProjection.document.id;
  const representationRoutingState = await ensureCollaborationState({
    documentId: representationRoutingDocumentId,
    workspaceId,
    organizationId: workspace.organizationId || null,
    path: representationRoutingPath,
    representation: 'tiptap_xml',
    initialContent: routingRichInitialContent,
  });
  const sourceOnlyDoc = createRichMarkdownYDoc(sourceOnlyCheckpoint);
  await persistCollaborationYDoc(
    representationRoutingDocumentId,
    representationRoutingState.lifecycleGeneration,
    sourceOnlyDoc,
  );
  sourceOnlyDoc.destroy();
  await fs.writeFile(path.join(workspace.rootPath, representationRoutingPath), sourceOnlyCheckpoint, 'utf8');

  const resolvedGrant = await createCollaborationSessionGrant({
    workspace,
    fileOptions: { workspace },
    request: { path: representationRoutingPath, provider: 'yjs', representation: 'auto' },
  });
  assert.equal(resolvedGrant.representation, 'tiptap_xml');
  const explicitRichGrant = await createCollaborationSessionGrant({
    workspace,
    fileOptions: { workspace },
    request: { path: representationRoutingPath, provider: 'yjs', representation: 'tiptap_xml' },
  });
  assert.equal(explicitRichGrant.representation, 'tiptap_xml');
  await assert.rejects(
    () => createCollaborationSessionGrant({
      workspace,
      fileOptions: { workspace },
      request: { path: representationRoutingPath, provider: 'yjs', representation: 'plain_text' },
    }),
    (error: unknown) => error instanceof CollaborationSessionError && error.code === 'representation_mismatch',
  );

  // A healthy, idle Markdown document that was historically initialized as
  // plain text is upgraded by the authoritative session resolver when its
  // exact source is now rich-editor safe. Frontmatter is preserved verbatim.
  const autoMigrationPath = `agent-auto-rich-migration-${suffix}.md`;
  const autoMigrationContent = [
    '---',
    'title: Strategy update',
    'tags:',
    '  - topic/strategy',
    '---',
    '',
    '# Strategy update',
    '',
    '**Status:** Ready for rich collaboration.',
    '',
  ].join('\n');
  await fs.writeFile(path.join(workspace.rootPath, autoMigrationPath), autoMigrationContent, 'utf8');
  ensureFileRevisionForCurrentContent({
    workspace,
    path: autoMigrationPath,
    contentHash: createHash('sha256').update(autoMigrationContent, 'utf8').digest('hex'),
    sizeBytes: Buffer.byteLength(autoMigrationContent, 'utf8'),
    actorUserId: userId,
    actorType: 'user',
  });
  const autoMigrationProjection = getFileCollaborationState({
    workspace,
    path: autoMigrationPath,
    ensureDocument: true,
  });
  assert(autoMigrationProjection.document);
  autoMigrationDocumentId = autoMigrationProjection.document.id;
  const autoMigrationInitialState = await ensureCollaborationState({
    documentId: autoMigrationDocumentId,
    workspaceId,
    organizationId: workspace.organizationId || null,
    path: autoMigrationPath,
    representation: 'plain_text',
    initialContent: autoMigrationContent,
  });
  const autoMigrationGrant = await createCollaborationSessionGrant({
    workspace,
    fileOptions: { workspace },
    request: { path: autoMigrationPath, provider: 'yjs', representation: 'auto' },
  });
  assert.equal(autoMigrationGrant.representation, 'tiptap_xml');
  assert.equal(autoMigrationGrant.lifecycleGeneration, 2);
  assert.equal(await persistedText(autoMigrationDocumentId), autoMigrationContent);
  const stalePlainDoc = new Y.Doc({ gc: true });
  Y.applyUpdate(stalePlainDoc, autoMigrationInitialState.yjsState);
  stalePlainDoc.getText('content').insert(0, 'stale room update\n');
  await assert.rejects(
    () => persistCollaborationYDoc(
      autoMigrationInitialState.documentId,
      autoMigrationInitialState.lifecycleGeneration,
      stalePlainDoc,
    ),
    (error: unknown) => error instanceof CollaborationStateStaleError
      && error.code === 'COLLABORATION_STATE_STALE',
  );
  stalePlainDoc.destroy();
  const stateAfterStaleStore = await loadCollaborationState(autoMigrationDocumentId);
  assert.equal(stateAfterStaleStore?.representation, 'tiptap_xml');
  assert.equal(stateAfterStaleStore?.lifecycleGeneration, 2);
  assert.equal(await persistedText(autoMigrationDocumentId), autoMigrationContent);

  // Serializer-only entity and table formatting changes are normalized once,
  // checkpointed, and then promoted from source collaboration to rich text.
  const safeNormalizationMigrationPath = `agent-safe-normalization-migration-${suffix}.md`;
  const safeNormalizationMigrationContent = [
    '---',
    'title: Brand & UI options',
    '---',
    '',
    '# Brand & UI options',
    '',
    '| Name | Meaning |',
    '| ---- | ------- |',
    '| **Bradley** | Calm help inside Canvas Notebook |',
    '| **Lino** | Woven structure |',
    '',
  ].join('\n');
  const safeNormalizationAnalysis = analyzeMarkdownRichMode(safeNormalizationMigrationContent);
  assert.equal(safeNormalizationAnalysis.mode, 'normalizable');
  assert(safeNormalizationAnalysis.mode === 'normalizable');
  const safeNormalizationExpected = composeCanvasMarkdownDocument(
    safeNormalizationAnalysis.prefix,
    safeNormalizationAnalysis.normalizedBody,
  );
  await fs.writeFile(
    path.join(workspace.rootPath, safeNormalizationMigrationPath),
    safeNormalizationMigrationContent,
    'utf8',
  );
  ensureFileRevisionForCurrentContent({
    workspace,
    path: safeNormalizationMigrationPath,
    contentHash: createHash('sha256').update(safeNormalizationMigrationContent, 'utf8').digest('hex'),
    sizeBytes: Buffer.byteLength(safeNormalizationMigrationContent, 'utf8'),
    actorUserId: userId,
    actorType: 'user',
  });
  const safeNormalizationProjection = getFileCollaborationState({
    workspace,
    path: safeNormalizationMigrationPath,
    ensureDocument: true,
  });
  assert(safeNormalizationProjection.document);
  safeNormalizationMigrationDocumentId = safeNormalizationProjection.document.id;
  await ensureCollaborationState({
    documentId: safeNormalizationMigrationDocumentId,
    workspaceId,
    organizationId: workspace.organizationId || null,
    path: safeNormalizationMigrationPath,
    representation: 'plain_text',
    initialContent: safeNormalizationMigrationContent,
  });
  const safeNormalizationStateBeforeFailedCheckpoint = await loadCollaborationState(
    safeNormalizationMigrationDocumentId,
  );
  assert(safeNormalizationStateBeforeFailedCheckpoint);
  let restoredFailedNormalizationCheckpoint = false;
  await assert.rejects(
    () => changeCollaborationRepresentationWithSafeMarkdownNormalization({
      documentId: safeNormalizationMigrationDocumentId!,
      expectedLifecycleGeneration: safeNormalizationStateBeforeFailedCheckpoint.lifecycleGeneration,
      schemaVersion: 1,
      checkpoint: {
        write: async ({ canonicalContent }) => {
          await fs.writeFile(
            path.join(workspace.rootPath, safeNormalizationMigrationPath),
            canonicalContent,
            'utf8',
          );
          throw new Error('synthetic normalized checkpoint failure');
        },
        restore: async ({ canonicalContent }) => {
          restoredFailedNormalizationCheckpoint = true;
          await fs.writeFile(
            path.join(workspace.rootPath, safeNormalizationMigrationPath),
            canonicalContent,
            'utf8',
          );
        },
        finalize: () => {
          assert.fail('A failed normalized checkpoint must not finalize its file projection.');
        },
      },
    }),
    (error: unknown) => error instanceof CollaborationRepresentationMigrationError
      && error.code === 'checkpoint_failed',
  );
  assert.equal(restoredFailedNormalizationCheckpoint, true);
  const safeNormalizationStateAfterFailedCheckpoint = await loadCollaborationState(
    safeNormalizationMigrationDocumentId,
  );
  assert(safeNormalizationStateAfterFailedCheckpoint);
  assert.equal(safeNormalizationStateAfterFailedCheckpoint.representation, 'plain_text');
  assert.equal(
    safeNormalizationStateAfterFailedCheckpoint.lifecycleGeneration,
    safeNormalizationStateBeforeFailedCheckpoint.lifecycleGeneration,
  );
  assert.equal(
    safeNormalizationStateAfterFailedCheckpoint.documentSequence,
    safeNormalizationStateBeforeFailedCheckpoint.documentSequence,
  );
  assert.equal(
    await fs.readFile(path.join(workspace.rootPath, safeNormalizationMigrationPath), 'utf8'),
    safeNormalizationMigrationContent,
  );
  const safeNormalizationGrant = await createCollaborationSessionGrant({
    workspace,
    fileOptions: { workspace },
    request: { path: safeNormalizationMigrationPath, provider: 'yjs', representation: 'auto' },
  });
  assert.equal(safeNormalizationGrant.representation, 'tiptap_xml');
  assert.equal(safeNormalizationGrant.lifecycleGeneration, 2);
  const safeNormalizationState = await loadCollaborationState(safeNormalizationMigrationDocumentId);
  assert(safeNormalizationState);
  assert.equal(safeNormalizationState.checkpointSequence, safeNormalizationState.documentSequence);
  assert.equal(safeNormalizationState.degraded, false);
  assert.equal(await persistedText(safeNormalizationMigrationDocumentId), safeNormalizationExpected);
  assert.equal(
    await fs.readFile(path.join(workspace.rootPath, safeNormalizationMigrationPath), 'utf8'),
    safeNormalizationExpected,
  );

  // Connected source clients block migration. Once the room is empty, two
  // simultaneous session requests converge on the same new rich lifecycle;
  // the earlier plain-text grant is stale and cannot re-enter that room.
  const concurrentMigrationPath = `agent-concurrent-rich-migration-${suffix}.md`;
  await fs.writeFile(path.join(workspace.rootPath, concurrentMigrationPath), autoMigrationContent, 'utf8');
  ensureFileRevisionForCurrentContent({
    workspace,
    path: concurrentMigrationPath,
    contentHash: createHash('sha256').update(autoMigrationContent, 'utf8').digest('hex'),
    sizeBytes: Buffer.byteLength(autoMigrationContent, 'utf8'),
    actorUserId: userId,
    actorType: 'user',
  });
  const concurrentMigrationProjection = getFileCollaborationState({
    workspace,
    path: concurrentMigrationPath,
    ensureDocument: true,
  });
  assert(concurrentMigrationProjection.document);
  concurrentAutoMigrationDocumentId = concurrentMigrationProjection.document.id;
  await ensureCollaborationState({
    documentId: concurrentAutoMigrationDocumentId,
    workspaceId,
    organizationId: workspace.organizationId || null,
    path: concurrentMigrationPath,
    representation: 'plain_text',
    initialContent: autoMigrationContent,
  });
  const uninstallRoomInspector = installCollaborationRoomInspector(
    (targetDocumentId) => targetDocumentId === concurrentAutoMigrationDocumentId ? 2 : 0,
  );
  const connectedGrant = await (async () => {
    try {
      return await createCollaborationSessionGrant({
        workspace,
        fileOptions: { workspace },
        request: { path: concurrentMigrationPath, provider: 'yjs', representation: 'auto' },
      });
    } finally {
      uninstallRoomInspector();
    }
  })();
  assert.equal(connectedGrant.representation, 'plain_text');
  assert.equal(connectedGrant.lifecycleGeneration, 1);
  const concurrentGrants = await Promise.all([
    createCollaborationSessionGrant({
      workspace,
      fileOptions: { workspace },
      request: { path: concurrentMigrationPath, provider: 'yjs', representation: 'auto' },
    }),
    createCollaborationSessionGrant({
      workspace,
      fileOptions: { workspace },
      request: { path: concurrentMigrationPath, provider: 'yjs', representation: 'auto' },
    }),
  ]);
  assert.deepEqual(concurrentGrants.map((grant) => grant.representation), ['tiptap_xml', 'tiptap_xml']);
  assert.deepEqual(concurrentGrants.map((grant) => grant.lifecycleGeneration), [2, 2]);
  assert.notEqual(connectedGrant.lifecycleGeneration, concurrentGrants[0]?.lifecycleGeneration);
  assert.equal(await persistedText(concurrentAutoMigrationDocumentId), autoMigrationContent);

  // Cross-node Markdown edits are persisted as real review operations. Accept
  // reapplies the exact patch to the then-current Yjs document, preserving an
  // unrelated human edit outside the reviewed target.
  const richSnapshot = await readCurrentCollaborationTextSnapshot({
    documentId: richDocumentId,
    workspace,
  });
  const structuralPrepared = await prepareCollaborationTextEdit({
    documentId: richDocumentId,
    workspace,
    path: `agent-operation-rich-${suffix}.md`,
    edits: [{ oldText: 'Rich **strong** paragraph\n\n', newText: '' }],
    expectedSha256: richSnapshot.sha256,
    groupId: 'structural-review',
  });
  assert.equal(structuralPrepared.requestedMode, 'review');
  const structuralReview = await executePreparedCollaborationTextEdit({
    prepared: structuralPrepared,
    workspace,
    identity: {
      initiatedByUserId: userId,
      actorId: 'agent-b',
      actorDisplayName: 'Agent B',
      actorSessionId: `structural-session-${suffix}`,
    },
    idempotencyKey: `structural-review-${suffix}`,
  });
  assert.equal(structuralReview.operationStatus, 'needs_review');
  assert.match(await persistedText(richDocumentId), /Rich \*\*strong\*\* paragraph/u);

  const concurrentRichState = await loadCollaborationState(richDocumentId);
  assert(concurrentRichState);
  const concurrentRichDoc = new Y.Doc({ gc: true });
  Y.applyUpdate(concurrentRichDoc, concurrentRichState.yjsState);
  const concurrentRichTargets = createRichAgentTextTargets({
    doc: concurrentRichDoc,
    search: 'Other paragraph',
    replacement: 'Other paragraph updated by user',
  });
  const concurrentRichEdit = applyAgentTextTargets({
    doc: concurrentRichDoc,
    targets: concurrentRichTargets,
    origin: {
      actorType: 'agent',
      actorId: userId,
      initiatedByUserId: userId,
      operationId: `concurrent-user-${suffix}`,
    },
  });
  assert.equal(concurrentRichEdit.status, 'applied_to_ydoc');
  const concurrentRichContent = richMarkdownFromYDoc(concurrentRichDoc);
  const concurrentPersisted = await persistCollaborationYDoc(
    richDocumentId,
    concurrentRichState.lifecycleGeneration,
    concurrentRichDoc,
  );
  await markCollaborationCheckpoint({
    documentId: richDocumentId,
    workspaceId: concurrentPersisted.workspaceId,
    path: concurrentPersisted.path,
    lifecycleGeneration: concurrentPersisted.lifecycleGeneration,
    schemaVersion: concurrentPersisted.schemaVersion,
    sequence: concurrentPersisted.documentSequence,
    canonicalContent: concurrentRichContent,
    serializedContent: serializeCanonicalText(concurrentRichContent, concurrentPersisted),
  });
  concurrentRichDoc.destroy();

  const acceptedStructural = await acceptAgentOperation({
    operationId: structuralReview.operationId,
    workspace,
    userId,
    idempotencyKey: `accept-structural-${suffix}`,
  });
  assert.equal(acceptedStructural.operationStatus, 'checkpointed_file');
  assert.equal(await persistedText(richDocumentId), 'Other paragraph updated by user');

  // Compaction and representation migration require an empty room, a healthy
  // checkpoint, and no pending review. Both create a rollback marker and a new
  // lifecycle generation so stale clients/runs cannot re-enter silently.
  await ensureCollaborationState({
    documentId: compactionDocumentId,
    workspaceId,
    organizationId: workspace.organizationId || null,
    path: `agent-operation-compaction-${suffix}.md`,
    representation: 'plain_text',
    initialContent: 'Compaction content',
  });
  const compactionState = await loadCollaborationState(compactionDocumentId);
  assert(compactionState);
  const compactionReview = await applyPersistedAgentTextOperation({
    documentId: compactionDocumentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey: `compaction-review-${suffix}`,
    runGeneration: 1,
    targets: [targetFor(compactionState, 'Compaction', 'Pending', 'compaction')],
    requestedMode: 'review',
  });
  await assert.rejects(() => compactCollaborationState({
    documentId: compactionDocumentId,
    expectedLifecycleGeneration: compactionState.lifecycleGeneration,
  }), /pending/u);
  await rejectAgentOperation({
    operationId: compactionReview.operationId,
    workspace,
    userId,
    idempotencyKey: `reject-compaction-${suffix}`,
  });
  const compacted = await compactCollaborationState({
    documentId: compactionDocumentId,
    expectedLifecycleGeneration: compactionState.lifecycleGeneration,
  });
  assert.equal(compacted.lifecycleGeneration, compactionState.lifecycleGeneration + 1);
  assert.equal(await persistedText(compactionDocumentId), 'Compaction content');
  const migrated = await changeCollaborationRepresentation({
    documentId: compactionDocumentId,
    expectedLifecycleGeneration: compacted.lifecycleGeneration,
    representation: 'tiptap_xml',
    schemaVersion: 1,
  });
  assert.equal(migrated.representation, 'tiptap_xml');
  assert.equal(migrated.lifecycleGeneration, compacted.lifecycleGeneration + 1);
  assert.equal(await persistedText(compactionDocumentId), 'Compaction content');
  database = await openDb();
  try {
    const backup = await database.get(
      'SELECT COUNT(*) AS count FROM collaboration_yjs_state_backups WHERE document_id = ?',
      [compactionDocumentId],
    ) as { count?: number | string };
    assert.equal(Number(backup.count), 2);
  } finally {
    await database.close();
  }

  // Cross-document requests are explicit sagas. A conflict in a later
  // document exposes the already applied item and requires compensation;
  // distributed all-or-nothing is refused before any document is changed.
  await ensureCollaborationState({
    documentId: sagaFirstDocumentId,
    workspaceId,
    organizationId: workspace.organizationId || null,
    path: `agent-operation-saga-first-${suffix}.txt`,
    representation: 'plain_text',
    initialContent: 'Saga A',
  });
  await ensureCollaborationState({
    documentId: sagaSecondDocumentId,
    workspaceId,
    organizationId: workspace.organizationId || null,
    path: `agent-operation-saga-second-${suffix}.txt`,
    representation: 'plain_text',
    initialContent: 'Saga B',
  });
  const sagaFirstState = await loadCollaborationState(sagaFirstDocumentId);
  const sagaSecondState = await loadCollaborationState(sagaSecondDocumentId);
  const sagaFirstTarget = targetFor(sagaFirstState, 'Saga A', 'Saga A applied');
  const staleSagaSecondTarget = targetFor(sagaSecondState, 'Saga B', 'Saga B applied');
  const sagaUserDoc = await persistUserMutation(
    (text) => {
      text.delete(5, 1);
      text.insert(5, 'C');
    },
    sagaSecondDocumentId,
  );
  sagaUserDoc.destroy();
  const saga = await applyPersistedAgentTextSaga({
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey: `saga-${suffix}`,
    runGeneration: 1,
    documents: [
      { documentId: sagaFirstDocumentId, targets: [sagaFirstTarget] },
      { documentId: sagaSecondDocumentId, targets: [staleSagaSecondTarget] },
    ],
  });
  assert.equal(saga.status, 'partially_applied');
  assert.equal(saga.documents[0]?.status, 'compensation_required');
  assert.equal(saga.documents[1]?.status, 'needs_review');
  assert.equal(await persistedText(sagaFirstDocumentId), 'Saga A applied');
  assert.equal(await persistedText(sagaSecondDocumentId), 'Saga C');
  const sagaRedelivery = await applyPersistedAgentTextSaga({
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey: `saga-${suffix}`,
    runGeneration: 1,
    documents: [
      { documentId: sagaFirstDocumentId, targets: [sagaFirstTarget] },
      { documentId: sagaSecondDocumentId, targets: [staleSagaSecondTarget] },
    ],
  });
  assert.equal(sagaRedelivery.sagaId, saga.sagaId);
  const compensatedSaga = await compensateAgentTextSaga({
    sagaId: saga.sagaId,
    workspace,
    userId,
    idempotencyKey: `compensate-${suffix}`,
  });
  const compensationOperationId = compensatedSaga.documents[0]?.compensationOperationId;
  const compensationOperation = compensationOperationId
    ? await getAgentOperation({ operationId: compensationOperationId, workspace, userId })
    : null;
  assert.equal(
    compensatedSaga.status,
    'compensated',
    JSON.stringify({ compensatedSaga, compensationOperation }),
  );
  assert.equal(compensatedSaga.documents[0]?.status, 'compensated');
  assert.equal(await persistedText(sagaFirstDocumentId), 'Saga A');

  const atomicSaga = await applyPersistedAgentTextSaga({
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey: `atomic-saga-${suffix}`,
    runGeneration: 1,
    requestedAtomicity: 'all_or_nothing',
    documents: [
      { documentId: sagaFirstDocumentId, targets: [targetFor(await loadCollaborationState(sagaFirstDocumentId), 'Saga A', 'Forbidden A')] },
      { documentId: sagaSecondDocumentId, targets: [targetFor(await loadCollaborationState(sagaSecondDocumentId), 'Saga C', 'Forbidden B')] },
    ],
  });
  assert.equal(atomicSaga.status, 'needs_review');
  assert.equal(atomicSaga.errorCode, 'distributed_atomicity_unsupported');
  assert.equal(await persistedText(sagaFirstDocumentId), 'Saga A');
  assert.equal(await persistedText(sagaSecondDocumentId), 'Saga C');

  // A debounce queued before delete/archive may fire once afterwards. It is
  // a lifecycle no-op, not a degraded persistence incident or resurrection.
  await ensureCollaborationState({
    documentId: archivedDocumentId,
    workspaceId,
    organizationId: workspace.organizationId || null,
    path: `agent-operation-archived-${suffix}.txt`,
    representation: 'plain_text',
    initialContent: 'Archived content',
  });
  const beforeArchive = await loadCollaborationState(archivedDocumentId);
  assert(beforeArchive);
  const archivedDoc = new Y.Doc({ gc: true });
  Y.applyUpdate(archivedDoc, beforeArchive.yjsState);
  await archivePersistedCollaborationPaths({
    workspaceId,
    paths: [beforeArchive.path],
  });
  await assert.rejects(
    () => persistCollaborationYDoc(
      archivedDocumentId,
      beforeArchive.lifecycleGeneration,
      archivedDoc,
    ),
    (error: unknown) => error instanceof CollaborationStateInactiveError
      && error.code === 'COLLABORATION_STATE_INACTIVE',
  );
  archivedDoc.destroy();

  // Only the explicit restore lifecycle may reactivate an archived state.
  await assert.rejects(
    () => ensureCollaborationState({
      documentId: archivedDocumentId,
      workspaceId,
      organizationId: workspace.organizationId || null,
      path: beforeArchive.path,
      representation: 'plain_text',
      initialContent: 'Archived content',
    }),
    (error: unknown) => error instanceof CollaborationStateInactiveError,
  );
  await reactivatePersistedCollaborationPath({
    workspaceId,
    path: beforeArchive.path,
  });
  const reactivated = await loadCollaborationState(archivedDocumentId);
  assert(reactivated);
  assert.equal(reactivated.status, 'active');
  assert.equal(reactivated.lifecycleGeneration, beforeArchive.lifecycleGeneration + 2);
  assert.equal(await persistedText(archivedDocumentId), 'Archived content');

  state = await loadCollaborationState(documentId);
  const staleReview = await applyPersistedAgentTextOperation({
    documentId,
    workspace,
    initiatedByUserId: userId,
    actorId: 'agent-b',
    actorDisplayName: 'Agent B',
    idempotencyKey: `stale-${suffix}`,
    runGeneration: 1,
    targets: [targetFor(state, 'Gamma reviewed', 'Stale gamma')],
    requestedMode: 'review',
  });
  database = await openDb();
  try {
    await database.run(
      'UPDATE collaboration_yjs_states SET lifecycle_generation = lifecycle_generation + 1 WHERE document_id = ?',
      [documentId],
    );
  } finally {
    await database.close();
  }
  const staleAccept = await acceptAgentOperation({
    operationId: staleReview.operationId,
    workspace,
    userId,
    idempotencyKey: `stale-accept-${suffix}`,
  });
  assert.equal(staleAccept.operationStatus, 'needs_review');
  assert.equal(staleAccept.conflicts[0]?.code, 'lifecycle_stale');
  assert.equal(await persistedText(), 'User alpha\nBeta human after seeing agent\nGamma reviewed');
} finally {
  uninstallDirectConnection();
  uninstallDocumentReader();
  for (const doc of activeDocuments.values()) doc.destroy();
  activeDocuments.clear();
  removeDocumentPresenceEntry({ workspaceId, documentId, userId: 'active-human', actorType: 'user' });
  const database = await openDb();
  try {
    await database.run(
      'DELETE FROM collaboration_agent_saga_documents WHERE saga_id IN (SELECT saga_id FROM collaboration_agent_sagas WHERE workspace_id = ?)',
      [workspaceId],
    );
    await database.run('DELETE FROM collaboration_agent_sagas WHERE workspace_id = ?', [workspaceId]);
    for (const cleanupDocumentId of [
      documentId,
      richDocumentId,
      compactionDocumentId,
      sagaFirstDocumentId,
      sagaSecondDocumentId,
      archivedDocumentId,
      checkpointRaceDocumentId,
      ...(toolDocumentId ? [toolDocumentId] : []),
      ...(uninitializedToolDocumentId ? [uninitializedToolDocumentId] : []),
      ...(representationRoutingDocumentId ? [representationRoutingDocumentId] : []),
      ...(autoMigrationDocumentId ? [autoMigrationDocumentId] : []),
      ...(safeNormalizationMigrationDocumentId ? [safeNormalizationMigrationDocumentId] : []),
      ...(concurrentAutoMigrationDocumentId ? [concurrentAutoMigrationDocumentId] : []),
    ]) {
      await database.run('DELETE FROM collaboration_agent_operations WHERE document_id = ?', [cleanupDocumentId]);
      await database.run('DELETE FROM collaboration_yjs_state_backups WHERE document_id = ?', [cleanupDocumentId]);
      await database.run('DELETE FROM collaboration_yjs_states WHERE document_id = ?', [cleanupDocumentId]);
    }
  } finally {
    await database.close();
  }
}

console.log('file-agent-operation-integration-test: ok');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

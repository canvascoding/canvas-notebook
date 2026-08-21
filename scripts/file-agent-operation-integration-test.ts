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
import {
  acceptAgentOperation,
  applyPersistedAgentTextOperation,
  cancelAgentOperation,
  createAgentTextTarget,
  createRichAgentTextTargets,
  detectLateAgentSemanticConflicts,
  getAgentOperation,
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
  CollaborationStateInactiveError,
  archivePersistedCollaborationPaths,
  ensureCollaborationState,
  changeCollaborationRepresentation,
  compactCollaborationState,
  loadCollaborationState,
  markCollaborationCheckpoint,
  persistCollaborationYDoc,
  serializeCanonicalText,
} from '../app/lib/collaboration/persistence';
import { createRichMarkdownYDoc, richMarkdownFromYDoc } from '../app/lib/collaboration/markdown-state';
import { removeDocumentPresenceEntry, upsertDocumentPresenceEntry } from '../app/lib/collaboration/presence';
import { openDb } from '../app/lib/db';
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
const richDocumentId = `agent-operation-rich-test-${suffix}`;
const compactionDocumentId = `agent-operation-compaction-test-${suffix}`;
const sagaFirstDocumentId = `agent-operation-saga-first-${suffix}`;
const sagaSecondDocumentId = `agent-operation-saga-second-${suffix}`;
const archivedDocumentId = `agent-operation-archived-${suffix}`;
const workspaceId = `agent-operation-workspace-${suffix}`;
const userId = `agent-operation-user-${suffix}`;
let toolDocumentId: string | null = null;
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
  name: 'read' | 'edit_file' | 'apply_patch',
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
  const persisted = await persistCollaborationYDoc(targetDocumentId, doc);
  const canonical = doc.getText('content').toString();
  await markCollaborationCheckpoint({
    documentId: targetDocumentId,
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
  const activeDocument = activeDocuments.get(input.documentId);
  const doc = activeDocument || new Y.Doc({ gc: true });
  try {
    if (!activeDocument) Y.applyUpdate(doc, state.yjsState);
    const result = apply(doc);
    if (onApplied) await onApplied(result);
    const persisted = await persistCollaborationYDoc(input.documentId, doc);
    const canonical = state.representation === 'plain_text'
      ? doc.getText('content').toString()
      : richMarkdownFromYDoc(doc);
    await markCollaborationCheckpoint({
      documentId: input.documentId,
      sequence: persisted.documentSequence,
      canonicalContent: canonical,
      serializedContent: serializeCanonicalText(canonical, persisted),
    });
    return result;
  } finally {
    if (!activeDocument) doc.destroy();
  }
});

try {
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
  });
  assert.equal(safeRevertSource.operationStatus, 'checkpointed_file');
  const reverted = await revertAgentOperation({
    operationId: safeRevertSource.operationId,
    workspace,
    userId,
    idempotencyKey: `revert-${suffix}`,
  });
  assert.equal(reverted.operationStatus, 'reverted');
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
  await ensureCollaborationState({
    documentId: richDocumentId,
    workspaceId,
    organizationId: workspace.organizationId || null,
    path: `agent-operation-rich-${suffix}.md`,
    representation: 'tiptap_xml',
    initialContent: 'Rich **bold** paragraph\n\nOther paragraph',
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
  const toolReadDetails = toolRead.details as { sha256?: string; collaboration?: { source?: string } };
  const liveHash = createHash('sha256').update(liveContent, 'utf8').digest('hex');
  assert.equal(toolReadDetails.sha256, liveHash);
  assert.equal(toolReadDetails.collaboration?.source, 'live_yjs');
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
    collaboration?: { reviewRequired?: boolean; operationStatus?: string; durability?: string };
  };
  assert.equal(directToolDetails.collaboration?.reviewRequired, false);
  assert.equal(directToolDetails.collaboration?.operationStatus, 'checkpointed_file');
  assert.equal(directToolDetails.collaboration?.durability, 'checkpointed_file');
  assert.ok(
    directConnectionInputs.some((input) => input.actorSessionId === agentExecutionContext.sessionId),
    'Agent tool operations must forward their PI session to the direct collaboration connection.',
  );
  assert.equal(
    richMarkdownFromYDoc(activeToolDocument),
    'Tool **checkpoint** paragraph\n\nLive paragraph updated by agent',
  );

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

  const concurrentRichContent = (await persistedText(richDocumentId)).replace(
    'Other paragraph',
    'Other paragraph updated by user',
  );
  const concurrentRichDoc = createRichMarkdownYDoc(concurrentRichContent);
  const concurrentPersisted = await persistCollaborationYDoc(richDocumentId, concurrentRichDoc);
  await markCollaborationCheckpoint({
    documentId: richDocumentId,
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
    () => persistCollaborationYDoc(archivedDocumentId, archivedDoc),
    (error: unknown) => error instanceof CollaborationStateInactiveError
      && error.code === 'COLLABORATION_STATE_INACTIVE',
  );
  archivedDoc.destroy();

  // A restored active file may request its collaboration state before the
  // asynchronous restore path has reactivated Postgres. Reuse the archived
  // state in that narrow case rather than preventing the editor from opening.
  const reactivated = await ensureCollaborationState({
    documentId: archivedDocumentId,
    workspaceId,
    organizationId: workspace.organizationId || null,
    path: beforeArchive.path,
    representation: 'plain_text',
    initialContent: 'Archived content',
  });
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
      ...(toolDocumentId ? [toolDocumentId] : []),
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

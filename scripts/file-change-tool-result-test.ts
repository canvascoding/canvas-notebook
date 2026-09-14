import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { FileChangeGroupV1 } from '../app/lib/file-version-center/contracts/v1';
import type { FileVersionCaptureResult } from '../app/lib/file-version-center/history-service';
import type { FileCollaborationState, FileRevisionRecord } from '../app/lib/files/collaboration-policy';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { AgentFileChangeResult } from '../app/lib/pi/agent-file-operations';
import { asAgentFileToolError } from '../app/lib/pi/agent-file-tool-results';
import { createAgentFileToolAppSuccess, type AgentFileToolAppSuccess } from '../app/lib/pi/file-change-tool-result';
import { projectAgentMessageForLoadedContext } from '../app/lib/pi/message-projection';
import { prepareToolOutput } from '../app/lib/pi/tool-output-preparation';
import { FILE_CHANGE_APP_URI, readBuiltinToolAppMessage } from '../app/lib/tool-apps/types';

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireWidget(value: { outcome: string }): asserts value is AgentFileToolAppSuccess {
  assert.ok('changeGroup' in value && 'toolApp' in value, 'expected a file-change widget binding');
}

function captureResult(input: { contentHash: string; outcome?: FileVersionCaptureResult['outcome'] }): FileVersionCaptureResult {
  const revision = {
    id: 'revision-1', lineageId: 'lineage-1', organizationId: null, customerId: null, projectId: null,
    workspaceId: 'workspace-1', workspaceType: 'personal', path: 'docs/plan.md', contentHash: input.contentHash,
    sizeBytes: 12, createdByUserId: 'user-1', createdByActorType: 'agent', sourceSessionId: 'session-1',
    baseRevisionId: null, createdAt: 1,
  } satisfies FileRevisionRecord;
  return {
    outcome: input.outcome ?? 'captured',
    revision,
    binding: {
      revisionId: revision.id, workspaceId: revision.workspaceId, lineageId: revision.lineageId!, blobId: 'blob-1',
      format: 'markdown', source: 'agent_apply', stateVectorHash: null, sha256: input.contentHash,
      rawSizeBytes: revision.sizeBytes, storedSizeBytes: revision.sizeBytes, createdAt: 1,
    },
  };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-file-change-result-'));
  const resolvedPath = path.join(root, 'docs', 'plan.md');
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  const content = Buffer.from('new content\n', 'utf8');
  await fs.writeFile(resolvedPath, content);
  const context: AgentExecutionContext = {
    userId: 'user-1', sessionId: 'session-1', agentId: 'agent-1', workspaceId: 'workspace-1',
    workspaceType: 'personal', workspaceName: 'Workspace', organizationId: null, customerId: null, projectId: null,
    workspaceRoot: root, workspaceRootRelativePath: null, canWrite: true, canDelete: true, canShare: true, legacy: false,
  };
  const result: AgentFileChangeResult = {
    path: 'docs/plan.md', resolvedPath, changed: true, snapshot: null, beforeSha256: null,
    afterSha256: hash(content), size: content.byteLength, diff: '--- before\n+++ after\n-old\n+new\n+line',
    validation: { ok: true, checks: [] },
  };
  let captures = 0;
  let groupCreates = 0;
  let groupFailure = false;
  let captured = captureResult({ contentHash: result.afterSha256 });
  const createGroup = async (input: {
    sourceSessionId: string;
    toolCallId: string;
    operation: 'write' | 'edit_file' | 'apply_patch';
    entries: Array<{ pathHint: string; outcome: 'applied' | 'review_required' | 'conflict' | 'failed'; additions?: number; deletions?: number;
      lineageId?: string | null; documentId?: string | null; operationId?: string | null; revisionId?: string | null }>;
  }): Promise<FileChangeGroupV1> => {
    groupCreates += 1;
    if (groupFailure) throw new Error('group store unavailable');
    const id = `fvcg-${hash(`${context.userId}:${context.workspaceId}:${input.sourceSessionId}:${input.toolCallId}`)}`;
    return {
      contractVersion: 1, id, workspaceId: context.workspaceId, sourceSessionId: input.sourceSessionId,
      toolCallId: input.toolCallId, operation: input.operation, status: input.entries[0]!.outcome,
      createdAt: '2026-09-14T12:00:00.000Z',
      entries: input.entries.map((entry, ordinal) => ({ ...entry, id: `entry-${ordinal}`, ordinal })),
    };
  };
  const collaborationState = {
    lineageId: 'lineage-1', path: 'docs/plan.md', strategy: 'crdt_text', crdtCapable: true, sceneCapable: false,
    lockRequired: false, requiresRevisionCheck: false, latestRevision: null, activeLock: null,
    document: {
      id: 'document-1', organizationId: null, customerId: null, projectId: null, workspaceId: context.workspaceId,
      workspaceType: context.workspaceType, path: 'docs/plan.md', provider: 'yjs', stateVersion: 1,
      snapshotRevisionId: null, status: 'active', createdAt: 1, updatedAt: 1,
    },
  } satisfies FileCollaborationState;
  const persisted = {
    documentId: 'document-1', workspaceId: context.workspaceId, organizationId: null, path: 'docs/plan.md',
    representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1, yjsState: new Uint8Array(),
    stateVector: new Uint8Array(), documentSequence: 1, persistedAt: 1, checkpointedAt: null,
    checkpointSequence: 0, canonicalHash: result.afterSha256, serializedHash: result.afterSha256,
    newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active',
  } satisfies PersistedCollaborationState;
  let collaborationCaptures = 0;
  const attach = createAgentFileToolAppSuccess({
    captureFile: async () => { captures += 1; return captured; },
    captureCollaboration: async () => { collaborationCaptures += 1; return captured; },
    createGroup,
    getCollaborationState: async () => collaborationState,
    getExecutionContext: () => context,
    loadCollaboration: async () => persisted,
    readFile: (filePath: string) => fs.readFile(filePath),
    visibleUiEnabled: () => true,
  });

  try {
    const applied = await attach(result, 'write', 'write-call-1');
    requireWidget(applied);
    assert.equal(applied.outcome, 'applied');
    assert.equal(applied.toolApp?.resourceUri, FILE_CHANGE_APP_URI);
    assert.equal(applied.changeGroup?.entries[0]?.revisionId, 'revision-1');
    assert.equal(applied.changeGroup?.entries[0]?.pathHint, 'docs/plan.md');
    assert.deepEqual([applied.changeGroup?.entries[0]?.additions, applied.changeGroup?.entries[0]?.deletions], [2, 1]);

    const retry = await attach(result, 'write', 'write-call-1');
    requireWidget(retry);
    assert.equal(retry.changeGroup?.id, applied.changeGroup?.id, 'retry resolves the same idempotent group');
    assert.equal(captures, 2, 'capture is revalidated, not a second file mutation');

    const unchanged = await attach({ ...result, changed: false, diff: '(no textual changes)' }, 'edit_file', 'edit-unchanged');
    assert.equal(unchanged.outcome, 'unchanged');
    assert.equal('toolApp' in unchanged, false);
    assert.equal(captures, 2, 'unchanged does not capture or group');

    const failed = asAgentFileToolError(new Error('write failed'), 'write', result.path);
    assert.equal('toolApp' in failed, false, 'error results never receive a widget');

    captured = { outcome: 'disabled', revision: null, binding: null };
    const unavailable = await attach(result, 'edit_file', 'edit-no-capture');
    assert.equal('toolApp' in unavailable, false, 'missing durable revision fails closed');
    captured = captureResult({ contentHash: result.afterSha256, outcome: 'already_captured' });

    groupFailure = true;
    const presentationFailure = await attach(result, 'edit_file', 'edit-group-failed');
    assert.equal(presentationFailure.outcome, 'applied');
    assert.equal('toolApp' in presentationFailure, false, 'presentation failure does not turn a durable write into a retryable error');
    groupFailure = false;

    const reviewResult: AgentFileChangeResult = {
      ...result,
      changed: false,
      collaboration: {
        operationId: 'operation-1', operationStatus: 'needs_review', durability: 'needs_review',
        reviewRequired: true, proposedSha256: hash('proposal'),
      },
    };
    const review = await attach(reviewResult, 'edit_file', 'edit-review');
    requireWidget(review);
    assert.equal(review.outcome, 'review_required');
    assert.equal(review.changeGroup?.entries[0]?.operationId, 'operation-1');
    assert.equal(review.changeGroup?.entries[0]?.documentId, 'document-1');
    assert.equal(review.changeGroup?.entries[0]?.outcome, 'review_required');
    assert.equal(collaborationCaptures, 0, 'a persisted review operation is the durable reference');

    const appliedCollaboration = await attach({
      ...reviewResult, changed: true,
      collaboration: { ...reviewResult.collaboration!, operationStatus: 'persisted_yjs', durability: 'persisted_yjs', reviewRequired: false },
    }, 'edit_file', 'edit-applied');
    requireWidget(appliedCollaboration);
    assert.equal(appliedCollaboration.changeGroup?.entries[0]?.revisionId, 'revision-1');
    assert.equal(collaborationCaptures, 1);

    const largeResult = {
      content: [{ type: 'text' as const, text: `updated\n${'x'.repeat(80_000)}` }],
      details: { ...applied, diff: 'x'.repeat(80_000) },
    };
    const prepared = await prepareToolOutput({
      identity: null,
      toolCallId: 'write-call-1',
      toolName: 'write',
      result: largeResult,
    });
    const message = {
      ...prepared, role: 'toolResult' as const, toolName: 'write', toolCallId: 'write-call-1', isError: false, timestamp: 1,
    };
    assert.equal(readBuiltinToolAppMessage(message)?.entityId, applied.changeGroup?.id,
      'output preparation retains the validated group and descriptor');
    const display = projectAgentMessageForLoadedContext(message as AgentMessage, 'display');
    assert.equal(readBuiltinToolAppMessage(display)?.entityId, applied.changeGroup?.id,
      'persisted message projection retains the reloadable widget binding');
    assert.ok(JSON.stringify(prepared.details).length < 20_000, 'large mutation details retain only bounded widget data');
    assert.ok(groupCreates >= 5);
    console.log('write/edit file-change results, durable references, retries and output preparation passed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });

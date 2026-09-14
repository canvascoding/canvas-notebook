import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { FileChangeGroupV1 } from '../app/lib/file-version-center/contracts/v1';
import type { FileVersionCaptureResult } from '../app/lib/file-version-center/history-service';
import type { FileCollaborationState, FileRevisionRecord } from '../app/lib/files/collaboration-policy';
import { applyAgentFilePatch, type AgentFileChangeResult } from '../app/lib/pi/agent-file-operations';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import {
  createAgentFilePatchToolAppSuccess,
  type AgentFilePatchToolAppSuccess,
} from '../app/lib/pi/file-change-tool-result';
import { paginateFileChangeAppEntries } from '../app/lib/tool-apps/file-change-data';
import { projectAgentMessageForLoadedContext } from '../app/lib/pi/message-projection';
import { prepareToolOutput } from '../app/lib/pi/tool-output-preparation';
import { readBuiltinToolAppMessages } from '../app/lib/tool-apps/types';

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function captureResult(pathHint: string, contentHash: string): FileVersionCaptureResult {
  const suffix = hash(pathHint).slice(0, 12);
  const revision = {
    id: `revision-${suffix}`, lineageId: `lineage-${suffix}`, organizationId: null, customerId: null, projectId: null,
    workspaceId: 'workspace-1', workspaceType: 'personal', path: pathHint, contentHash, sizeBytes: 8,
    createdByUserId: 'user-1', createdByActorType: 'agent', sourceSessionId: 'session-1',
    baseRevisionId: null, createdAt: 1,
  } satisfies FileRevisionRecord;
  return {
    outcome: 'captured', revision,
    binding: {
      revisionId: revision.id, workspaceId: revision.workspaceId, lineageId: revision.lineageId!,
      blobId: `blob-${suffix}`, format: 'markdown', source: 'agent_apply', stateVectorHash: null,
      sha256: contentHash, rawSizeBytes: revision.sizeBytes, storedSizeBytes: revision.sizeBytes, createdAt: 1,
    },
  };
}

function requireWidget(value: { outcome: string }): asserts value is AgentFilePatchToolAppSuccess {
  assert.ok('changeGroup' in value && 'toolApp' in value, 'expected one batch widget binding');
}

async function main() {
  const root = path.join('/tmp', 'canvas-file-change-patch');
  const context: AgentExecutionContext = {
    userId: 'user-1', sessionId: 'session-1', agentId: 'agent-1', workspaceId: 'workspace-1',
    workspaceType: 'personal', workspaceName: 'Workspace', organizationId: null, customerId: null, projectId: null,
    workspaceRoot: root, workspaceRootRelativePath: null, canWrite: true, canDelete: true, canShare: true, legacy: false,
  };
  const contentByPath = new Map<string, Buffer>();
  const fileResult = (index: number, changed = true): AgentFileChangeResult => {
    const pathHint = `docs/file-${index}.md`;
    const content = Buffer.from(`file-${index}\n`, 'utf8');
    const resolvedPath = path.join(root, pathHint);
    contentByPath.set(resolvedPath, content);
    return {
      path: pathHint, resolvedPath, changed, snapshot: null, beforeSha256: changed ? hash('old') : hash(content),
      afterSha256: hash(content), size: content.byteLength,
      diff: changed ? '--- before\n+++ after\n-old\n+new' : '(no textual changes)',
      validation: { ok: true, checks: [] },
    };
  };
  const review = fileResult(1, false);
  review.collaboration = {
    operationId: 'operation-review', operationStatus: 'needs_review', durability: 'needs_review',
    reviewRequired: true, proposedSha256: hash('proposal'),
  };
  const results = [fileResult(0), fileResult(99, false), review, fileResult(2), fileResult(3), fileResult(4), fileResult(5)];
  let groupCreates = 0;
  let captureCalls = 0;
  let missingCapturePath: string | null = null;
  const createGroup = async (input: {
    sourceSessionId: string;
    toolCallId: string;
    operation: 'write' | 'edit_file' | 'apply_patch';
    entries: Array<{ pathHint: string; outcome: 'applied' | 'review_required' | 'conflict' | 'failed';
      lineageId?: string | null; documentId?: string | null; operationId?: string | null; revisionId?: string | null;
      additions?: number; deletions?: number }>;
  }): Promise<FileChangeGroupV1> => {
    groupCreates += 1;
    if (input.entries.length > 100) throw new Error('group limit');
    const id = `fvcg-${hash(`${context.userId}:${input.sourceSessionId}:${input.toolCallId}`)}`;
    const outcomes = new Set(input.entries.map((entry) => entry.outcome));
    return {
      contractVersion: 1, id, workspaceId: context.workspaceId, sourceSessionId: input.sourceSessionId,
      toolCallId: input.toolCallId, operation: input.operation,
      status: outcomes.size === 1 ? input.entries[0]!.outcome : 'mixed',
      createdAt: '2026-09-14T12:00:00.000Z',
      entries: input.entries.map((entry, ordinal) => ({ ...entry, id: `entry-${ordinal}`, ordinal })),
    };
  };
  const collaborationState = {
    lineageId: 'lineage-review', path: review.path, strategy: 'crdt_text', crdtCapable: true, sceneCapable: false,
    lockRequired: false, requiresRevisionCheck: false, latestRevision: null, activeLock: null,
    document: {
      id: 'document-review', organizationId: null, customerId: null, projectId: null,
      workspaceId: context.workspaceId, workspaceType: context.workspaceType, path: review.path,
      provider: 'yjs', stateVersion: 1, snapshotRevisionId: null, status: 'active', createdAt: 1, updatedAt: 1,
    },
  } satisfies FileCollaborationState;
  const attach = createAgentFilePatchToolAppSuccess({
    captureFile: async (input) => {
      captureCalls += 1;
      if (input.path === missingCapturePath) return { outcome: 'unsupported', revision: null, binding: null };
      return captureResult(input.path, hash(input.content));
    },
    captureCollaboration: async () => { throw new Error('review operations do not need a revision capture'); },
    createGroup,
    getCollaborationState: async () => collaborationState,
    getExecutionContext: () => context,
    loadCollaboration: async () => null as PersistedCollaborationState | null,
    readFile: async (resolvedPath: string) => contentByPath.get(resolvedPath)!,
    visibleUiEnabled: () => true,
  });

  const batch = await attach(results, 'patch-call-1');
  requireWidget(batch);
  assert.equal(batch.kind, 'file_patch_batch');
  assert.equal(batch.outcome, 'review_required');
  assert.equal(batch.results.length, results.length, 'unchanged remains visible in the bounded tool result');
  assert.equal(batch.results[1]?.outcome, 'unchanged');
  assert.equal(batch.changeGroup.operation, 'apply_patch');
  assert.equal(batch.changeGroup.status, 'mixed');
  assert.equal(readBuiltinToolAppMessages({
    role: 'toolResult', toolName: 'apply_patch', toolCallId: 'patch-call-1',
    content: [{ type: 'text', text: 'patched' }], details: batch,
  }).length, 1, 'one batch has exactly one descriptor');
  assert.deepEqual(batch.changeGroup.entries.map((entry) => entry.pathHint), [
    'docs/file-0.md', 'docs/file-1.md', 'docs/file-2.md', 'docs/file-3.md', 'docs/file-4.md', 'docs/file-5.md',
  ], 'changed/review entries preserve the original file order while unchanged is not misreported');
  assert.equal(groupCreates, 1, 'one tool call creates one group and one widget');

  const retry = await attach(results, 'patch-call-1');
  requireWidget(retry);
  assert.equal(retry.changeGroup.id, batch.changeGroup.id);
  assert.equal(groupCreates, 2, 'retry reuses the idempotent group service instead of creating per-file groups');

  const pageOne = paginateFileChangeAppEntries(batch.changeGroup.entries, 0);
  const pageTwo = paginateFileChangeAppEntries(batch.changeGroup.entries, 1);
  assert.equal(pageOne.entries.length, 5);
  assert.equal(pageOne.hiddenCount, 1);
  assert.deepEqual(pageTwo.entries.map((entry) => entry.pathHint), ['docs/file-5.md']);
  assert.equal(paginateFileChangeAppEntries(batch.changeGroup.entries, 999).pageIndex, 1, 'overflow page clamps safely');

  const unchangedOnly = await attach([fileResult(50, false)], 'patch-unchanged');
  assert.equal('toolApp' in unchangedOnly, false);
  assert.equal(groupCreates, 2);

  missingCapturePath = 'docs/file-3.md';
  const incomplete = await attach(results, 'patch-incomplete');
  assert.equal('toolApp' in incomplete, false, 'a batch never hides an unreferenced applied entry in a partial card');
  assert.equal(groupCreates, 2);
  missingCapturePath = null;

  const maxResults = Array.from({ length: 100 }, (_, index) => fileResult(index + 200));
  const maxBatch = await attach(maxResults, 'patch-max');
  requireWidget(maxBatch);
  assert.equal(maxBatch.changeGroup.entries.length, 100);
  const prepared = await prepareToolOutput({
    identity: null, toolCallId: 'patch-max', toolName: 'apply_patch',
    result: { content: [{ type: 'text', text: 'patched '.repeat(12_000) }], details: maxBatch },
  });
  const display = projectAgentMessageForLoadedContext({
    ...prepared, role: 'toolResult', toolName: 'apply_patch', toolCallId: 'patch-max', isError: false, timestamp: 1,
  } as AgentMessage, 'display');
  assert.equal((display as unknown as { details: { changeGroup: FileChangeGroupV1 } }).details.changeGroup.entries.length, 100,
    'bounded batches above the generic detail-array limit survive output preparation and reload');
  assert.equal(readBuiltinToolAppMessages(display).length, 1);
  const overflow = await attach([...maxResults, fileResult(999)], 'patch-overflow');
  assert.equal('toolApp' in overflow, false, 'contract overflow fails closed without a partial widget');

  await assert.rejects(applyAgentFilePatch({
    files: Array.from({ length: 101 }, (_, index) => ({
      path: `docs/too-many-${index}.md`, edits: [{ oldText: 'old', newText: 'new' }],
    })),
  }), /at most 100 files/u, 'runtime rejects oversized batches before reading or mutating any file');
  assert.ok(captureCalls > 100);
  console.log('apply_patch single-group, mixed outcomes, max-items, pagination and idempotency passed');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });

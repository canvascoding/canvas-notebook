import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createWorkspaceFileOperationExecutor, type WorkspaceOperationExecutorAdapters } from '../app/lib/files/workspace-file-operation-executor';
import type { WorkspaceOperationWithSteps, WorkspaceOperationStepRecord } from '../app/lib/files/workspace-operation-journal';
import type { WorkspaceOperationStage } from '../app/lib/files/workspace-operation-staging';
import type { WorkspaceFileOperationPreview } from '../app/lib/markdown/workspace-file-operation-planner';
import type { WorkspaceLinkWritePreflight } from '../app/lib/markdown/workspace-link-write-executor';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const operationId = 'operation_1234567890abcdef';
const original = '[x](old.md)';
const rewritten = '[x](new.md)';

function fixture() {
  const preview: WorkspaceFileOperationPreview = {
    contractVersion: 1,
    planId: 'a'.repeat(64),
    kind: 'rename', status: 'planned', readiness: 'ready', issues: [], recoveryReady: true,
    pathMappings: [{ sourceWorkspaceId: 'workspace', sourcePath: 'old.md',
      destinationWorkspaceId: 'workspace', destinationPath: 'new.md', sourceIdentity: 'file-1' }],
    linkEdits: [{ sourceWorkspaceId: 'workspace', destinationWorkspaceId: 'workspace',
      sourcePathBefore: 'note.md', sourcePathAfter: 'note.md', expectedContentHash: hash(original),
      targetRange: { startUtf16: 4, endUtf16: 10, startUtf8Byte: 4, endUtf8Byte: 10 },
      previousTargetLiteral: 'old.md', nextTargetLiteral: 'new.md' }],
    previewContents: [{ workspaceId: 'workspace', path: 'note.md', content: rewritten }],
    expectedPathState: [{ workspaceId: 'workspace', path: 'old.md', identity: 'file-1', contentHash: null },
      { workspaceId: 'workspace', path: 'new.md', identity: null, contentHash: null }],
    collisions: [],
    coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
  };
  const identity = { operationId, planId: preview.planId,
    sourceWorkspaceId: 'workspace', destinationWorkspaceId: 'workspace' };
  const request = { kind: 'rename' as const, selections: [{ sourcePath: 'old.md', destinationPath: 'new.md' }] };
  const events: string[] = [];
  const observedFenceIds: string[] = [];
  const steps: WorkspaceOperationStepRecord[] = [];
  let record: WorkspaceOperationWithSteps | null = null;
  let stage: WorkspaceOperationStage | null = null;
  let pathState: 'before' | 'after' | 'unknown' = 'before';
  let linkState: 'before' | 'after' | 'unknown' = 'before';
  let pathApplyCount = 0;
  let linkApplyCount = 0;
  let throwAfterPathApply = false;
  let throwAfterLinkApply = false;
  let throwAfterPathFinish = false;
  let throwBeforeStaging = false;
  let throwAfterPrepare = false;
  let throwAfterComplete = false;
  let throwDuringLoad = false;

  const journal = {
    async get() { return record ? { ...record, steps: [...steps] } : null; },
    async prepare(input: { expectedStepCount: number }) {
      events.push('prepare');
      if (!record) record = { ...identity, requestHash: hash('request'),
        requestJson: JSON.stringify({ kind: 'rename', selections: [{ destinationPath: 'new.md', sourcePath: 'old.md' }] }),
        actor: { type: 'user', id: 'tester' }, expectedStepCount: input.expectedStepCount,
        status: 'prepared', phase: 'prepared', revision: 1, errorCode: null, createdAt: 0, updatedAt: 0, steps };
      if (throwAfterPrepare) { throwAfterPrepare = false; throw new Error('LOST_PREPARE_RESPONSE'); }
      return record;
    },
    async beginStep(input: { stepKey: string; phase: 'path' | 'link'; beforeFence: string; afterFence: string; backupRef?: string }) {
      events.push(`intent:${input.phase}`);
      let step = steps.find((entry) => entry.stepKey === input.stepKey);
      if (!step) {
        step = { operationId, stepKey: input.stepKey, phase: input.phase, status: 'intent',
          beforeFence: input.beforeFence, afterFence: input.afterFence, backupRef: input.backupRef ?? null,
          receiptJson: null, createdAt: 0, updatedAt: 0 };
        steps.push(step);
      }
      if (!record) throw new Error('missing record');
      record.status = 'running'; record.phase = input.phase; record.revision++;
      return step;
    },
    async finishStep(input: { stepKey: string; receipt: unknown }) {
      const step = steps.find((entry) => entry.stepKey === input.stepKey);
      if (!step || !record) throw new Error('missing step');
      step.status = 'applied'; step.receiptJson = JSON.stringify(input.receipt);
      record.revision++; events.push(`finish:${step.phase}`);
      if (step.phase === 'path' && throwAfterPathFinish) {
        throwAfterPathFinish = false;
        throw new Error('LOST_PATH_FINISH_RESPONSE');
      }
      return step;
    },
    async complete() {
      if (!record) throw new Error('missing record');
      record.status = 'completed'; record.phase = 'completed'; record.revision++; events.push('complete');
      if (throwAfterComplete) { throwAfterComplete = false; throw new Error('LOST_COMPLETE_RESPONSE'); }
      return record;
    },
    async fail(input: { errorCode: string; recoveryRequired: boolean }) {
      if (!record) throw new Error('missing record');
      record.status = input.recoveryRequired ? 'recovery_required' : 'failed';
      record.errorCode = input.errorCode; record.revision++; events.push('fail'); return record;
    },
    async resume(input: { expectedRevision: number }) {
      if (!record || record.revision !== input.expectedRevision) throw new Error('revision mismatch');
      record.status = 'running'; record.errorCode = null; record.revision++; events.push('resume'); return record;
    },
  };
  const staging = {
    async stage(input: { linkPreflight: WorkspaceLinkWritePreflight | null }) { events.push('stage'); if (throwBeforeStaging) throw new Error('STAGING_FAILED'); stage = { identity, preview,
      originalDocuments: [{ workspaceId: 'workspace', path: 'note.md', content: original }],
      payloadSha256: hash('payload'), linkPreflight: input.linkPreflight }; return stage; },
    async load() { if (throwDuringLoad || !stage) throw new Error('stage missing'); return stage; },
    async removeCompleted() { events.push('remove'); stage = null; },
  };
  const adapters: WorkspaceOperationExecutorAdapters = {
    async rebuildPlan() { events.push('rebuild'); return preview; },
    path: {
      async probe(_stage, evidence) {
        if (pathState === 'after' && !evidence.pathReceiptApplied) return 'unknown';
        return pathState;
      },
      async apply() {
        events.push('apply:path'); pathApplyCount++; pathState = 'after';
        if (throwAfterPathApply) throw new Error('PATH_RESULT_LOST');
        return { service: 'renameWorkspacePath', sourceIdentity: 'file-1' };
      },
    },
    links: {
      async preflight() { events.push('preflight'); return { planId: preview.planId, sources: [{
        sourceWorkspaceId: 'workspace', sourcePathBefore: 'note.md', beforeSha256: hash(original),
        documentId: 'active-document-1', mode: 'active-yjs' as const,
      }] }; },
      async probe(_group, staged) {
        observedFenceIds.push(staged.linkPreflight?.sources[0]?.documentId ?? 'missing');
        return linkState;
      },
      async apply(_group, staged) {
        observedFenceIds.push(staged.linkPreflight?.sources[0]?.documentId ?? 'missing');
        events.push('apply:link'); linkApplyCount++; linkState = 'after';
        if (throwAfterLinkApply) throw new Error('LINK_RESULT_LOST');
      },
    },
  };
  const create = () => createWorkspaceFileOperationExecutor({
    journal: journal as unknown as Parameters<typeof createWorkspaceFileOperationExecutor>[0]['journal'],
    staging: staging as unknown as Parameters<typeof createWorkspaceFileOperationExecutor>[0]['staging'],
    adapters,
  });
  const input = { ...identity, actor: { type: 'user' as const, id: 'tester' }, request, preview,
    originalDocuments: [{ workspaceId: 'workspace', path: 'note.md', content: original }] };
  return { create, input, identity, events, steps, observedFenceIds,
    get pathApplyCount() { return pathApplyCount; }, get linkApplyCount() { return linkApplyCount; },
    set throwAfterPathApply(value: boolean) { throwAfterPathApply = value; },
    set throwAfterLinkApply(value: boolean) { throwAfterLinkApply = value; },
    set throwAfterPathFinish(value: boolean) { throwAfterPathFinish = value; },
    set throwBeforeStaging(value: boolean) { throwBeforeStaging = value; },
    set throwAfterPrepare(value: boolean) { throwAfterPrepare = value; },
    set throwAfterComplete(value: boolean) { throwAfterComplete = value; },
    set throwDuringLoad(value: boolean) { throwDuringLoad = value; },
    set pathState(value: 'before' | 'after' | 'unknown') { pathState = value; },
    set linkState(value: 'before' | 'after' | 'unknown') { linkState = value; },
    discardStoredPreflight() { if (stage) stage.linkPreflight = null; },
  };
}

test('stages before path intent, records service receipt, and completes once', async () => {
  const state = fixture();
  const result = await state.create().execute(state.input);
  assert.equal(result.status, 'complete');
  assert.deepEqual(state.events.slice(0, 6), ['rebuild', 'preflight', 'stage', 'prepare', 'intent:path', 'apply:path']);
  assert.equal(JSON.parse(state.steps[0].receiptJson!).service, 'renameWorkspacePath');
  assert.equal(state.pathApplyCount, 1);
  assert.equal(state.linkApplyCount, 1);
  assert.equal((await state.create().execute(state.input)).status, 'complete');
  assert.equal(state.pathApplyCount, 1);
});

test('restart recovers an acknowledged path receipt without replaying the rename', async () => {
  const state = fixture(); state.throwAfterPathFinish = true;
  assert.equal((await state.create().execute(state.input)).status, 'needs_recovery');
  assert.equal((await state.create().recover(state.identity)).status, 'complete');
  assert.equal(state.pathApplyCount, 1);
  assert.equal(state.linkApplyCount, 1);
});

test('unacknowledged path mutation stays unknown after restart', async () => {
  const state = fixture(); state.throwAfterPathApply = true;
  assert.equal((await state.create().execute(state.input)).status, 'needs_recovery');
  const recovered = await state.create().recover(state.identity);
  assert.equal(recovered.status, 'needs_recovery');
  assert.match(recovered.errorCode!, /UNPROVEN_PATH_STATE/);
  assert.equal(state.pathApplyCount, 1);
  assert.equal(state.linkApplyCount, 0);
});

test('restart acknowledges a proven link result without replaying the write', async () => {
  const state = fixture(); state.throwAfterLinkApply = true;
  assert.equal((await state.create().execute(state.input)).status, 'needs_recovery');
  assert.equal((await state.create().recover(state.identity)).status, 'complete');
  assert.equal(state.pathApplyCount, 1);
  assert.equal(state.linkApplyCount, 1);
  assert.ok(state.observedFenceIds.length >= 2);
  assert.ok(state.observedFenceIds.every((id) => id === 'active-document-1'));
});

test('unknown link state stops recovery without another write', async () => {
  const state = fixture(); state.throwAfterLinkApply = true;
  assert.equal((await state.create().execute(state.input)).status, 'needs_recovery');
  state.linkState = 'unknown';
  assert.equal((await state.create().recover(state.identity)).status, 'needs_recovery');
  assert.equal(state.linkApplyCount, 1);
});

test('staging failure prevents every path intent and mutation', async () => {
  const state = fixture(); state.throwBeforeStaging = true;
  const result = await state.create().execute(state.input);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'STAGING_FAILED');
  assert.equal(state.events.includes('prepare'), false);
  assert.equal(state.events.includes('intent:path'), false);
  assert.equal(state.pathApplyCount, 0);
});

test('lost prepare response resumes from the staged plan', async () => {
  const state = fixture(); state.throwAfterPrepare = true;
  assert.equal((await state.create().execute(state.input)).status, 'needs_recovery');
  assert.equal((await state.create().recover(state.identity)).status, 'complete');
  assert.equal(state.pathApplyCount, 1);
});

test('lost complete response returns a complete result and retry removes staging', async () => {
  const state = fixture(); state.throwAfterComplete = true;
  assert.equal((await state.create().execute(state.input)).status, 'complete');
  assert.equal((await state.create().recover(state.identity)).status, 'complete');
  assert.equal(state.events.includes('remove'), true);
  assert.equal(state.pathApplyCount, 1);
});

test('recovery fails closed when the staged Yjs document fence is missing', async () => {
  const state = fixture(); state.throwAfterLinkApply = true;
  assert.equal((await state.create().execute(state.input)).status, 'needs_recovery');
  state.discardStoredPreflight();
  const recovered = await state.create().recover(state.identity);
  assert.equal(recovered.status, 'needs_recovery');
  assert.equal(recovered.errorCode, 'MISSING_SOURCE_DOCUMENT_FENCES');
  assert.equal(state.linkApplyCount, 1);
});

test('missing durable staging returns a partial recovery status', async () => {
  const state = fixture(); state.throwAfterLinkApply = true;
  assert.equal((await state.create().execute(state.input)).status, 'needs_recovery');
  state.throwDuringLoad = true;
  const recovered = await state.create().recover(state.identity);
  assert.equal(recovered.status, 'needs_recovery');
  assert.equal(recovered.errorCode, 'STAGE_LOAD_FAILED');
  assert.deepEqual(recovered.pendingSteps, ['staging:load']);
  assert.equal(state.linkApplyCount, 1);
});

function copyFixture() {
  const copyPreview: WorkspaceFileOperationPreview = {
    contractVersion: 1, planId: 'b'.repeat(64), kind: 'copy', status: 'planned',
    readiness: 'ready', issues: [], recoveryReady: true,
    pathMappings: [
      { sourceWorkspaceId: 'source', sourcePath: 'first.md', destinationWorkspaceId: 'target',
        destinationPath: 'Copies/first.md', sourceIdentity: 'first-id' },
      { sourceWorkspaceId: 'source', sourcePath: 'second.md', destinationWorkspaceId: 'target',
        destinationPath: 'Copies/second.md', sourceIdentity: 'second-id' },
    ],
    linkEdits: [], previewContents: [], expectedPathState: [], collisions: [],
    coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
  };
  const copyIdentity = { operationId: 'copy-operation-1234567890', planId: copyPreview.planId,
    sourceWorkspaceId: 'source', destinationWorkspaceId: 'target' };
  const copyRequest = { kind: 'copy' as const, selections: [
    { sourcePath: 'first.md', destinationPath: 'Copies/first.md' },
    { sourcePath: 'second.md', destinationPath: 'Copies/second.md' },
  ] };
  let record: WorkspaceOperationWithSteps | null = null;
  let stage: WorkspaceOperationStage | null = null;
  const steps: WorkspaceOperationStepRecord[] = [];
  const states: Record<string, 'before' | 'after'> = { 'first.md': 'before', 'second.md': 'before' };
  const applyCounts: Record<string, number> = { 'first.md': 0, 'second.md': 0 };
  let secondFailure: 'none' | 'before' | 'after' = 'none';
  const journal = {
    async get() { return record ? { ...record, steps: [...steps] } : null; },
    async prepare(input: { expectedStepCount: number }) {
      if (!record) record = { ...copyIdentity, requestHash: hash('copy'), requestJson: JSON.stringify(copyRequest),
        actor: { type: 'user', id: 'tester' }, expectedStepCount: input.expectedStepCount,
        status: 'prepared', phase: 'prepared', revision: 1, errorCode: null, createdAt: 0, updatedAt: 0, steps };
      return record;
    },
    async beginStep(input: { stepKey: string; phase: 'path' | 'link'; beforeFence: string; afterFence: string; backupRef?: string }) {
      if (!record) throw new Error('missing record');
      const step: WorkspaceOperationStepRecord = { operationId: copyIdentity.operationId,
        stepKey: input.stepKey, phase: input.phase, status: 'intent', beforeFence: input.beforeFence,
        afterFence: input.afterFence, backupRef: input.backupRef ?? null, receiptJson: null,
        createdAt: 0, updatedAt: 0 };
      steps.push(step); record.status = 'running'; record.phase = input.phase; record.revision++;
      return step;
    },
    async finishStep(input: { stepKey: string; receipt: unknown }) {
      if (!record) throw new Error('missing record');
      const step = steps.find((entry) => entry.stepKey === input.stepKey)!;
      step.status = 'applied'; step.receiptJson = JSON.stringify(input.receipt); record.revision++;
      return step;
    },
    async complete() { if (!record) throw new Error('missing record');
      record.status = 'completed'; record.phase = 'completed'; record.revision++; return record; },
    async fail(input: { errorCode: string; recoveryRequired: boolean }) { if (!record) throw new Error('missing record');
      record.status = input.recoveryRequired ? 'recovery_required' : 'failed';
      record.errorCode = input.errorCode; record.revision++; return record; },
    async resume(input: { expectedRevision: number }) { if (!record || record.revision !== input.expectedRevision) throw new Error('revision mismatch');
      record.status = 'running'; record.errorCode = null; record.revision++; return record; },
  };
  const staging = {
    async stage() { stage = { identity: copyIdentity, preview: copyPreview, originalDocuments: [],
      payloadSha256: hash('copy-payload'), linkPreflight: null }; return stage; },
    async load() { if (!stage) throw new Error('missing stage'); return stage; },
    async removeCompleted() { stage = null; },
  };
  const adapters: WorkspaceOperationExecutorAdapters = {
    async rebuildPlan() { return copyPreview; },
    path: {
      async probe() { throw new Error('whole-batch copy probe must not run'); },
      async apply() { throw new Error('whole-batch copy apply must not run'); },
      async probeSelection(_stage, selection, evidence) {
        const state = states[selection.sourcePath];
        return state === 'after' && !evidence.pathReceiptApplied ? 'unknown' : state;
      },
      async applySelection(_stage, selection) {
        applyCounts[selection.sourcePath]++;
        if (selection.sourcePath === 'second.md' && secondFailure === 'before') {
          secondFailure = 'none'; throw new Error('SECOND_COPY_NOT_STARTED');
        }
        states[selection.sourcePath] = 'after';
        if (selection.sourcePath === 'second.md' && secondFailure === 'after') {
          secondFailure = 'none'; throw new Error('SECOND_COPY_RECEIPT_LOST');
        }
        return { kind: 'copy', sourcePath: selection.sourcePath,
          copiedPath: selection.destinationPath, collaborationInitialized: true };
      },
    },
    links: {
      async preflight() { return null; },
      async probe() { throw new Error('no link groups'); },
      async apply() { throw new Error('no link groups'); },
    },
  };
  const create = () => createWorkspaceFileOperationExecutor({
    journal: journal as unknown as Parameters<typeof createWorkspaceFileOperationExecutor>[0]['journal'],
    staging: staging as unknown as Parameters<typeof createWorkspaceFileOperationExecutor>[0]['staging'],
    adapters,
  });
  const input = { ...copyIdentity, actor: { type: 'user' as const, id: 'tester' },
    request: copyRequest, preview: copyPreview, originalDocuments: [] };
  return { create, input, identity: copyIdentity, steps, applyCounts,
    set secondFailure(value: 'none' | 'before' | 'after') { secondFailure = value; },
    legacyPathAll() { if (!record) throw new Error('missing record');
      steps[0]!.stepKey = 'path:all'; record.expectedStepCount = 1; },
  };
}

test('multi-source copy resumes the remaining selection after a recorded first receipt', async () => {
  const state = copyFixture(); state.secondFailure = 'before';
  const first = await state.create().execute(state.input);
  assert.equal(first.status, 'needs_recovery');
  assert.equal(state.steps.length, 2);
  assert.equal(state.steps[0].status, 'applied');
  assert.equal(state.steps[1].status, 'intent');
  const recovered = await state.create().recover(state.identity);
  assert.equal(recovered.status, 'complete');
  assert.equal(state.applyCounts['first.md'], 1, 'the receipted selection is not replayed');
  assert.equal(state.applyCounts['second.md'], 2, 'only the unstarted selection is retried');
});

test('multi-source copy does not replay an unreceipted completed selection', async () => {
  const state = copyFixture(); state.secondFailure = 'after';
  assert.equal((await state.create().execute(state.input)).status, 'needs_recovery');
  const recovered = await state.create().recover(state.identity);
  assert.equal(recovered.status, 'needs_recovery');
  assert.match(recovered.errorCode!, /UNPROVEN_PATH_STATE/u);
  assert.equal(state.applyCounts['first.md'], 1);
  assert.equal(state.applyCounts['second.md'], 1);
});

test('legacy whole-batch copy journal remains readable without replay', async () => {
  const state = copyFixture(); state.secondFailure = 'before';
  assert.equal((await state.create().execute(state.input)).status, 'needs_recovery');
  state.legacyPathAll();
  const recovered = await state.create().recover(state.identity);
  assert.equal(recovered.status, 'needs_recovery');
  assert.equal(recovered.errorCode, 'LEGACY_COPY_PATH_STEP_REQUIRES_MANUAL_RECOVERY');
  assert.equal(state.applyCounts['first.md'], 1);
  assert.equal(state.applyCounts['second.md'], 1);
});

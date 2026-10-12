import assert from 'node:assert/strict';
import Module from 'node:module';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkspacePathOperationInput } from '../app/lib/files/workspace-path-operation-service';
import type { WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import type { WorkspaceOperationBatchExecutionPublic } from '../app/lib/files/workspace-operation-batch-public';
import type { WorkspacePathOperationProblemInput } from '../app/lib/files/workspace-path-operation-problems';
import type { SubmitAgentWorkspacePathOperationInput } from '../app/lib/files/workspace-operation-review-service';
import type { WorkspaceOperationReviewSubmission } from '../app/lib/files/workspace-operation-review-contract';

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-direct-path-'));
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  const workspaceRoot = path.join(dataRoot, 'workspace');
  await fs.mkdir(path.join(workspaceRoot, 'out'), { recursive: true });
  const directCalls: WorkspacePathOperationInput[] = [];
  const reviewCalls: SubmitAgentWorkspacePathOperationInput[] = [];
  const knownReviews = new Map<string, { input: SubmitAgentWorkspacePathOperationInput; result: WorkspaceOperationReviewSubmission }>();
  const copyCalls: Array<{ kind: string; actorId: string; actorSessionId?: string }> = [];
  const known = new Map<string, { input: WorkspacePathOperationInput; batch: WorkspaceOperationBatchRecord }>();
  const receipts = new Map<string, WorkspaceOperationBatchExecutionPublic>();
  const trashEntries: Array<{ id: string; originalPath: string; expiresAt: Date }> = [];
  let reviewEnabled = false;
  let reviewEnabledOnNextLock = false;
  let disableReviewOnNextSubmission = false;
  let lockDepth = 0;
  let nextStatus: WorkspaceOperationBatchRecord['status'] = 'applied';
  let journalAvailable = true;
  let trashMetadataUnavailable = false;
  let auditUnavailable = false;
  let recorderUnavailable = false;
  let directSubmissionError: Error | null = null;
  const problems: WorkspacePathOperationProblemInput[] = [];
  let reviewMode: 'needs_review' | 'direct' = 'needs_review';
  const inputIdentity = (input: WorkspacePathOperationInput) => JSON.stringify([
    input.kind, input.selections, Boolean(input.overwrite), Boolean(input.ignoreMissing), input.actorUserId, input.actorId,
    input.actorType, input.actorSessionId, input.expectedPlanId,
  ]);
  const reviewKey = (input: SubmitAgentWorkspacePathOperationInput) => JSON.stringify([
    input.source.workspace.workspaceId, input.actorUserId, input.idempotencyKey,
  ]);
  const reviewIdentity = (input: SubmitAgentWorkspacePathOperationInput) => JSON.stringify([
    input.kind, input.requestSelections ?? input.selections, input.requestOptions,
    input.actorUserId, input.actorId, input.actorDisplayName, input.actorSessionId,
  ]);
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/files/workspace-file-lifecycle-guard') return {
      withWorkspaceFileLifecycleGuards: (_scopes: unknown, work: () => Promise<unknown>) => work(),
      withWorkspaceFileLifecycleGuard: (_scope: unknown, work: () => Promise<unknown>) => work(),
    };
    if (request === '@/app/lib/document-review-availability') return {
      readDocumentReviewAvailability: () => ({ documentReviewEnabled: reviewEnabled, updatedAt: null }),
    };
    if (request === '@/app/lib/audit/audit-service') return { recordAuditEvent: async () => {
      if (auditUnavailable) throw new Error('Private audit infrastructure error');
      return { id: 'test-audit' };
    } };
    if (request === '@/app/lib/files/workspace-path-operation-problems') return {
      recordWorkspacePathOperationProblem: async (input: WorkspacePathOperationProblemInput) => {
        if (recorderUnavailable) throw new Error('Private recorder infrastructure error');
        problems.push(input);
      },
    };
    if (request === '@/app/lib/filesystem/workspace-files') return {
      ...originalLoad(request, parent, isMain) as object,
      withWorkspaceFileMutationLocks: async (_paths: unknown, _options: unknown, work: () => Promise<unknown>) => {
        if (reviewEnabledOnNextLock) { reviewEnabled = true; reviewEnabledOnNextLock = false; }
        lockDepth += 1;
        try { return await work(); } finally { lockDepth -= 1; }
      },
    };
    if (request === '@/app/lib/filesystem/workspace-trash') return {
      listWorkspaceTrashEntries: async ({ offset = 0 }: { offset?: number }) => {
        if (trashMetadataUnavailable) throw new Error('Optional trash metadata unavailable.');
        return trashEntries.slice(offset, offset + 1000);
      },
      trashWorkspacePaths: async () => { throw new Error('A workspace deletion bypassed the common service.'); },
    };
    if (request === '@/app/lib/files/workspace-operation-batch-executor') return {
      getWorkspaceOperationBatchExecutionPublic: async ({ batchId }: { batchId: string }) => receipts.get(batchId) ?? null,
    };
    if (request === '@/app/lib/files/workspace-operation-review-service') return {
      getExistingAgentWorkspacePathOperation: async (input: SubmitAgentWorkspacePathOperationInput) => {
        const known = input.idempotencyKey ? knownReviews.get(reviewKey(input)) : undefined;
        if (!known) return null;
        if (reviewIdentity(input) !== reviewIdentity(known.input)) {
          throw Object.assign(new Error('Immutable review request conflict'), { code: 'REVIEW_IDEMPOTENCY_CONFLICT' });
        }
        return known.result;
      },
      submitAgentWorkspacePathOperation: async (input: SubmitAgentWorkspacePathOperationInput) => {
        if (disableReviewOnNextSubmission) {
          disableReviewOnNextSubmission = false; reviewEnabled = false;
          throw Object.assign(new Error('Review gate changed before persistence'), { code: 'DOCUMENT_REVIEW_DISABLED', status: 409 });
        }
        assert.equal(reviewEnabled, true, 'OFF cannot submit a new review');
        reviewCalls.push(input);
        const allMissing = await Promise.all(input.selections.map(async (selection) => {
          try { await fs.lstat(path.join(workspaceRoot, selection.sourcePath)); return false; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
        }));
        const result: WorkspaceOperationReviewSubmission = reviewMode === 'direct' ? { mode: 'direct' }
          : allMissing.every(Boolean) ? { mode: 'blocked', reviewId: `review-${reviewCalls.length}`,
            planId: 'b'.repeat(64), workspaceId: 'direct-workspace', status: 'blocked', code: 'PREVIEW_BLOCKED', message: 'Missing source.' }
            : { mode: 'needs_review', reviewId: `review-${reviewCalls.length}`,
              planId: 'b'.repeat(64), workspaceId: 'direct-workspace', status: 'pending' };
        if (input.idempotencyKey) knownReviews.set(reviewKey(input), { input, result });
        return result;
      },
    };
    if (request === '@/app/lib/files/workspace-file-operation-service') return {
      executeWorkspaceFileOperationService: async (input: { kind: string; actorId: string; actorSessionId?: string;
        selections: Array<{ sourcePath: string; destinationPath: string }> }) => {
        assert.equal(reviewEnabled, false); assert.equal(lockDepth, 1, 'OFF copies keep the existing fenced executor');
        assert.equal(input.kind, 'copy'); copyCalls.push(input);
        for (const selection of input.selections) await fs.cp(path.join(workspaceRoot, selection.sourcePath),
          path.join(workspaceRoot, selection.destinationPath), { force: false, errorOnExist: true });
        return { execution: { operationId: `copy-${copyCalls.length}`, status: 'complete', errorCode: null } };
      },
    };
    if (request === '@/app/lib/files/workspace-path-operation-service') return {
      getExistingDirectWorkspacePathOperation: async (input: WorkspacePathOperationInput) => {
        const row = input.idempotencyKey ? known.get(input.idempotencyKey) : undefined;
        if (!row) return null;
        if (inputIdentity(input) !== inputIdentity(row.input)) {
          throw Object.assign(new Error('Immutable authorization conflict'), { code: 'BATCH_IDEMPOTENCY_CONFLICT' });
        }
        return row.batch;
      },
      submitDirectWorkspacePathOperation: async (input: WorkspacePathOperationInput) => {
        if (directSubmissionError) throw directSubmissionError;
        if (input.selections.some((selection) => selection.sourcePath.startsWith('snapshot-'))) {
          assert.equal(lockDepth, 1, 'snapshot capture and initial direct-plan submission share the workspace lock');
        }
        directCalls.push(input);
        const batchId = `direct-batch-${directCalls.length}`;
        const selected = [];
        for (const selection of input.selections) {
          if (input.kind === 'delete' && input.ignoreMissing) {
            try { await fs.lstat(path.join(workspaceRoot, selection.sourcePath)); } catch (error) {
              if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
              throw error;
            }
          }
          selected.push(selection);
        }
        const originals = await Promise.all(selected.map(async (selection) => ({ path: selection.sourcePath,
          content: await fs.readFile(path.join(workspaceRoot, selection.sourcePath), 'utf8') })));
        const pathSteps = selected.map((selection) => ({ reviewId: `${batchId}-request`, kind: input.kind, ...selection }));
        if (input.overwrite) pathSteps.unshift(...input.selections.map((selection) => ({ reviewId: `${batchId}-replace`,
          kind: 'delete' as const, sourcePath: selection.destinationPath! })));
        const batch = { batchId, planId: 'a'.repeat(64), workspaceId: 'direct-workspace', status: 'queued', actionMode: 'apply',
          authorization: { mode: 'direct', ...input }, reviewIds: [], reviewRefs: [], reviewerUserId: null,
          reviewerDisplayName: null, completedActions: 0, totalActions: pathSteps.length, phase: 'preparing',
          errorCode: null, trashEntryIds: [], leaseOwner: null, createdAt: 1, updatedAt: 1,
          plan: { pathSteps, actions: [{ kind: input.kind, selections: input.selections }], issues: [], linkAssessment: { blockers: [] },
            expectedPathState: originals.map((original) => ({ path: original.path,
              contentHash: createHash('sha256').update(original.content).digest('hex') })),
            deletedDocuments: input.kind === 'delete' ? originals : [],
            pathMappings: input.kind === 'delete' ? [] : input.selections.map((selection) => ({
            ...selection, sourceKind: 'file' })), deletedPaths: input.kind === 'delete'
              ? selected.map((selection) => ({ path: selection.sourcePath, kind: 'file' })) : [] },
        } as unknown as WorkspaceOperationBatchRecord;
        known.set(input.idempotencyKey ?? batchId, { input, batch });
        return batch;
      },
      waitForWorkspacePathOperation: async (batch: WorkspaceOperationBatchRecord) => {
        assert.equal(lockDepth, 0, 'bounded waiting must release the workspace mutation lock for the worker');
        if (batch.status !== 'queued') return batch;
        batch.status = nextStatus;
        batch.phase = nextStatus === 'applied' ? 'complete' : nextStatus === 'needs_recovery' ? 'recovery' : 'preparing';
        batch.errorCode = nextStatus === 'needs_recovery' ? 'LINK_WRITE_STALE' : nextStatus === 'blocked' ? 'PREVIEW_BLOCKED' : null;
        if (nextStatus === 'blocked') {
          batch.plan.issues = [{ code: 'incomplete-index', path: 'Notes/reference.md', detail: 'private diagnostic' }];
          batch.plan.linkAssessment.blockers = [{ reason: 'resolution-changed', status: 'ambiguous',
            sourcePath: 'Notes/reference.md', targetLiteral: 'private target literal' }];
        }
        const applied = ['applied', 'needs_recovery'].includes(nextStatus) && journalAvailable;
        if (applied) {
          for (const step of batch.plan.pathSteps) {
            const source = path.join(workspaceRoot, step.sourcePath);
            if (step.kind === 'delete') {
              const id = `trash-${trashEntries.length + 1}`;
              const trashPath = path.join(dataRoot, 'trash', id);
              await fs.mkdir(path.dirname(trashPath), { recursive: true });
              await fs.rename(source, trashPath);
              trashEntries.push({ id, originalPath: step.sourcePath, expiresAt: new Date('2030-01-01') });
              batch.trashEntryIds.push(id);
            } else await fs.rename(source, path.join(workspaceRoot, step.destinationPath!));
          }
          batch.completedActions = batch.plan.pathSteps.length;
        }
        receipts.set(batch.batchId, { mode: 'apply', receiptStatus: journalAvailable ? applied ? 'available' : 'not_started' : 'unavailable',
          finalization: nextStatus === 'applied' && journalAvailable ? 'complete' : 'pending',
          steps: batch.plan.pathSteps.map((step, index) => ({ key: `path:${index}`, phase: 'path', kind: step.kind,
            path: step.sourcePath, destinationPath: step.destinationPath, state: applied ? 'applied' : 'pending' })) });
        return batch;
      },
    };
    return originalLoad(request, parent, isMain);
  };
  try {
    const { moveAgentPaths, deleteAgentPaths, copyAgentPaths, restoreAgentFileSnapshot } = await import('../app/lib/pi/agent-file-operations');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const context = { userId: 'direct-user', sessionId: 'direct-session', agentId: 'canvas-agent',
      workspaceId: 'direct-workspace', workspaceType: 'personal' as const, workspaceName: 'Direct Test',
      organizationId: null, customerId: null, projectId: null, workspaceRoot, workspaceRootRelativePath: null,
      canWrite: true, canDelete: true, canShare: false, legacy: false };
    const seed = (name: string, content = `# ${name}`) => fs.writeFile(path.join(workspaceRoot, name), content);
    await runWithAgentExecutionContext(context, async () => {
      await seed('move.md');
      const move = await moveAgentPaths({ sourcePaths: ['move.md'], destinationPath: 'out/move.md', idempotencyKey: 'move-call' });
      assert.equal(move.changed, true); assert.equal(move.verified, true); assert.equal(move.linkStatus, 'complete');
      assert.equal(move.review, undefined); assert.equal(move.fileOperation?.status, 'applied');
      assert.equal(move.fileOperation?.kind, 'move');
      assert.deepEqual(move.operationIds, [move.fileOperation?.batchId]);
      assert.equal(directCalls[0].actorId, 'canvas-agent'); assert.equal(directCalls[0].actorSessionId, 'direct-session');
      assert.equal(directCalls[0].actorUserId, 'direct-user'); assert.equal(directCalls[0].actorType, 'agent');
      await assert.rejects(fs.stat(path.join(workspaceRoot, 'move.md')), { code: 'ENOENT' });
      const count = directCalls.length;
      const replay = await moveAgentPaths({ sourcePaths: ['move.md'], destinationPath: 'out/move.md', idempotencyKey: 'move-call' });
      assert.equal(replay.fileOperation?.batchId, move.fileOperation?.batchId);
      assert.equal(replay.changed, true); assert.equal(directCalls.length, count, 'retry never replans missing source');
      reviewEnabled = true;
      const directAfterToggle = await moveAgentPaths({ sourcePaths: ['move.md'], destinationPath: 'out/move.md', idempotencyKey: 'move-call' });
      assert.equal(directAfterToggle.fileOperation?.batchId, move.fileOperation?.batchId);
      assert.equal(directAfterToggle.review, undefined); assert.equal(directAfterToggle.verified, true);
      assert.equal(reviewCalls.length, 0); assert.equal(directCalls.length, count);
      reviewEnabled = false;
      const reverted = known.get('move-call')!.batch;
      reverted.status = 'undone'; reverted.actionMode = 'undo';
      await fs.rename(path.join(workspaceRoot, 'out/move.md'), path.join(workspaceRoot, 'move.md'));
      receipts.set(reverted.batchId, { mode: 'undo', receiptStatus: 'available', finalization: 'complete', steps: [
        { key: 'path:0', phase: 'path', kind: 'move', path: 'out/move.md', destinationPath: 'move.md', state: 'applied' },
      ] });
      reviewEnabled = true;
      const undone = await moveAgentPaths({ sourcePaths: ['move.md'], destinationPath: 'out/move.md', idempotencyKey: 'move-call' });
      assert.equal(undone.fileOperation?.status, 'undone'); assert.equal(undone.changed, false);
      assert.equal(undone.verified, true); assert.equal(undone.linkStatus, 'complete');
      assert.equal(directCalls.length, count, 'an undone direct job is never reapplied or converted into a review on retry');
      reviewEnabled = false;

      await seed('delete.md');
      const deletion = await deleteAgentPaths({ paths: ['delete.md'], idempotencyKey: 'delete-call' });
      assert.equal(deletion.changed, true); assert.equal(deletion.verified, true);
      assert.equal(deletion.fileOperation?.kind, 'delete');
      assert.equal(deletion.trashEntries?.[0].originalPath, 'delete.md');
      assert.equal((await deleteAgentPaths({ paths: ['delete.md'], idempotencyKey: 'delete-call' })).fileOperation?.batchId,
        deletion.fileOperation?.batchId);
      await seed('existing-ignore-missing.md');
      const missingRequest = { paths: ['existing-ignore-missing.md', 'initially-missing.md'], ignoreMissing: true,
        idempotencyKey: 'delete-with-missing' };
      const skippedMissing = await deleteAgentPaths(missingRequest);
      assert.equal(skippedMissing.changed, true); assert.equal(skippedMissing.verified, true);
      assert.equal(directCalls.at(-1)?.ignoreMissing, true);
      assert.deepEqual(directCalls.at(-1)?.selections.map((selection) => selection.sourcePath), missingRequest.paths);
      assert.equal(skippedMissing.entries.find((entry) => entry.sourcePath === 'initially-missing.md')?.changed, false);
      await seed('initially-missing.md', '# created after original completion');
      const missingRetry = await deleteAgentPaths(missingRequest);
      assert.equal(missingRetry.fileOperation?.batchId, skippedMissing.fileOperation?.batchId);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'initially-missing.md'), 'utf8'), '# created after original completion');
      const noOpRequest = { paths: ['all-missing.md'], ignoreMissing: true, idempotencyKey: 'delete-no-op' };
      const noOp = await deleteAgentPaths(noOpRequest);
      assert.equal(noOp.changed, false); assert.equal(noOp.verified, true); assert.equal(noOp.fileOperation?.status, 'applied');
      await seed('all-missing.md', '# created after no-op');
      const noOpRetry = await deleteAgentPaths(noOpRequest);
      assert.equal(noOpRetry.fileOperation?.batchId, noOp.fileOperation?.batchId);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'all-missing.md'), 'utf8'), '# created after no-op');
      await seed('trash-details.md'); trashMetadataUnavailable = true;
      const withoutTrashDetails = await deleteAgentPaths({ paths: ['trash-details.md'] });
      assert.equal(withoutTrashDetails.fileOperation?.status, 'applied'); assert.equal(withoutTrashDetails.verified, true);
      assert.equal(withoutTrashDetails.changed, true); assert.match(withoutTrashDetails.linkWarnings.join(' '), /Trash details/u);
      trashMetadataUnavailable = false;

      await seed('replace.md'); await seed('out/replace.md', '# previous');
      const replacement = await moveAgentPaths({ sourcePaths: ['replace.md'], destinationPath: 'out/replace.md', overwrite: true });
      assert.equal(directCalls.at(-1)?.overwrite, true); assert.equal(replacement.overwritten, true);
      assert.equal(replacement.trashEntries?.[0].originalPath, 'out/replace.md');
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'out/replace.md'), 'utf8'), '# replace.md');

      nextStatus = 'queued'; await seed('queued.md');
      const problemsBeforePending = problems.length;
      const queued = await deleteAgentPaths({ paths: ['queued.md'] });
      assert.equal(queued.changed, false); assert.equal(queued.verified, false);
      assert.equal(queued.fileOperation?.status, 'queued'); assert.equal(queued.linkStatus, 'incomplete');
      assert.match(queued.linkWarnings.join(' '), /is queued/u);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'queued.md'), 'utf8'), '# queued.md');

      nextStatus = 'blocked'; await seed('blocked.md');
      const blocked = await deleteAgentPaths({ paths: ['blocked.md'] });
      assert.equal(blocked.changed, false); assert.equal(blocked.review, undefined);
      assert.equal(blocked.fileOperation?.errorCode, 'PREVIEW_BLOCKED');
      assert.deepEqual(blocked.fileOperation?.issues, [{ code: 'resolution-changed', path: 'Notes/reference.md' }],
        'the agent receives the actionable blocker instead of only PREVIEW_BLOCKED');
      assert.equal(JSON.stringify(blocked.fileOperation).includes('private'), false);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'blocked.md'), 'utf8'), '# blocked.md');

      nextStatus = 'needs_recovery'; await seed('partial.md');
      const partial = await deleteAgentPaths({ paths: ['partial.md'] });
      assert.equal(partial.changed, true); assert.equal(partial.verified, false); assert.equal(partial.linkStatus, 'partial');
      assert.equal(partial.fileOperation?.status, 'needs_recovery');
      assert.equal(problems.length, problemsBeforePending, 'existing durable batch failures are the independent notification source');

      nextStatus = 'applied'; journalAvailable = false; await seed('unproven.md');
      const unproven = await deleteAgentPaths({ paths: ['unproven.md'] });
      assert.equal(unproven.changed, false); assert.equal(unproven.verified, false);
      assert.match(unproven.linkWarnings.join(' '), /journal/u);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'unproven.md'), 'utf8'), '# unproven.md');
      assert.equal((problems.at(-1)!.error as { code: string }).code, 'BATCH_JOURNAL_UNAVAILABLE');
      assert.deepEqual(problems.at(-1)!.selections, [{ sourcePath: 'unproven.md' }]);
      journalAvailable = true;

      reviewEnabled = true; await seed('review-move.md'); await seed('review-delete.md'); await seed('copy.md');
      const beforeReviews = directCalls.length;
      const reviewMoveRequest = { sourcePaths: ['review-move.md'], destinationPath: 'out/review-move.md', idempotencyKey: 'review-move-key' };
      const reviewDeleteRequest = { paths: ['review-delete.md'], idempotencyKey: 'review-delete-key' };
      const pendingMove = await moveAgentPaths(reviewMoveRequest);
      const pendingDelete = await deleteAgentPaths(reviewDeleteRequest);
      assert.equal(pendingMove.review?.status, 'pending'); assert.equal(pendingDelete.review?.status, 'pending');
      assert.equal(pendingMove.changed, false); assert.equal(pendingDelete.changed, false);
      assert.equal(directCalls.length, beforeReviews);
      await seed('review-ignore-missing.md');
      const reviewMissingRequest = { paths: ['review-ignore-missing.md', 'review-absent.md'], ignoreMissing: true,
        idempotencyKey: 'review-ignore-missing-key' };
      const reviewWithMissing = await deleteAgentPaths(reviewMissingRequest);
      assert.equal(reviewWithMissing.review?.status, 'pending');
      const reviewed = reviewCalls.at(-1)!;
      assert.deepEqual(reviewed.selections?.map((selection) => selection.sourcePath), ['review-ignore-missing.md']);
      assert.deepEqual(reviewCalls.at(-1)!.requestSelections?.map((selection) => selection.sourcePath), reviewMissingRequest.paths);
      const allMissingReviewRequest = { paths: ['review-all-missing.md'], ignoreMissing: true, idempotencyKey: 'review-all-missing-key' };
      const allMissingReview = await deleteAgentPaths(allMissingReviewRequest);
      assert.equal(allMissingReview.review?.status, 'blocked'); assert.equal(allMissingReview.changed, false);
      await seed('review-copy.md');
      const reviewCopyRequest = { sourcePaths: ['review-copy.md'], destinationPath: 'out/review-copy.md', idempotencyKey: 'review-copy-key' };
      const pendingCopy = await copyAgentPaths(reviewCopyRequest);
      assert.equal(pendingCopy.review?.status, 'pending'); assert.equal(pendingCopy.changed, false); assert.equal(copyCalls.length, 0);
      reviewEnabled = false;
      const reviewCount = reviewCalls.length;
      await fs.rm(path.join(workspaceRoot, 'review-move.md'));
      await seed('out/review-move.md', '# unrelated destination');
      await fs.rm(path.join(workspaceRoot, 'review-delete.md'));
      await seed('review-absent.md', '# created after original review');
      await seed('review-all-missing.md', '# created after blocked review');
      await fs.rm(path.join(workspaceRoot, 'review-copy.md'));
      await seed('out/review-copy.md', '# occupied after proposal');
      for (const [retry, original] of [
        [await moveAgentPaths(reviewMoveRequest), pendingMove],
        [await deleteAgentPaths(reviewDeleteRequest), pendingDelete],
        [await deleteAgentPaths(reviewMissingRequest), reviewWithMissing],
        [await deleteAgentPaths(allMissingReviewRequest), allMissingReview],
        [await copyAgentPaths(reviewCopyRequest), pendingCopy],
      ]) {
        assert.deepEqual(retry.review, original.review); assert.equal(retry.changed, false);
        assert.equal(retry.fileOperation, undefined, 'OFF retry returns the original review, never a new direct batch');
      }
      assert.equal(directCalls.length, beforeReviews); assert.equal(reviewCalls.length, reviewCount);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'out/review-move.md'), 'utf8'), '# unrelated destination');
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'review-absent.md'), 'utf8'), '# created after original review');
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'review-all-missing.md'), 'utf8'), '# created after blocked review');
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'out/review-copy.md'), 'utf8'), '# occupied after proposal');
      await assert.rejects(moveAgentPaths({ ...reviewMoveRequest, destinationPath: 'out/changed-review.md' }), { code: 'REVIEW_IDEMPOTENCY_CONFLICT' });
      await assert.rejects(moveAgentPaths({ ...reviewMoveRequest, overwrite: true }), { code: 'REVIEW_IDEMPOTENCY_CONFLICT' });
      await assert.rejects(deleteAgentPaths({ ...reviewMissingRequest, ignoreMissing: false }), { code: 'REVIEW_IDEMPOTENCY_CONFLICT' });
      await assert.rejects(deleteAgentPaths({ ...reviewDeleteRequest, recursive: true }), { code: 'REVIEW_IDEMPOTENCY_CONFLICT' });
      await assert.rejects(copyAgentPaths({ ...reviewCopyRequest, recursive: false }), { code: 'REVIEW_IDEMPOTENCY_CONFLICT' });
      for (const changedContext of [{ ...context, agentId: 'other-review-agent' }, { ...context, sessionId: 'other-review-session' }]) {
        await assert.rejects(runWithAgentExecutionContext(changedContext,
          () => deleteAgentPaths(reviewDeleteRequest)), { code: 'REVIEW_IDEMPOTENCY_CONFLICT' });
      }
      const closedReview = knownReviews.get(reviewKey(reviewCalls[1]))!;
      for (const status of ['rejected', 'stale', 'failed', 'needs_recovery', 'applied'] as const) {
        closedReview.result = { mode: 'blocked', reviewId: pendingDelete.review!.reviewId, planId: pendingDelete.review!.planId,
          workspaceId: context.workspaceId, status, code: 'REVIEW_ALREADY_CLOSED', message: 'Original review closed.' };
        const closedRetry = await deleteAgentPaths(reviewDeleteRequest);
        assert.equal(closedRetry.review?.status, status); assert.equal(closedRetry.changed, false);
        assert.equal(closedRetry.fileOperation, undefined);
      }
      const copy = await copyAgentPaths({ sourcePaths: ['copy.md'], destinationPath: 'out/copy.md' });
      assert.equal(copy.review, undefined); assert.equal(copy.changed, true); assert.equal(copy.verified, true);
      assert.deepEqual(copy.operationIds, ['copy-1']); assert.equal(directCalls.length, beforeReviews, 'copy stays outside mandatory move/delete jobs');
      assert.equal(copyCalls[0].actorId, context.agentId); assert.equal(copyCalls[0].actorSessionId, context.sessionId);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'copy.md'), 'utf8'), '# copy.md');
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'out/copy.md'), 'utf8'), '# copy.md');
      await seed('race-copy.md'); reviewEnabledOnNextLock = true;
      const copyRace = await copyAgentPaths({ sourcePaths: ['race-copy.md'], destinationPath: 'out/race-copy.md' });
      assert.equal(copyRace.review?.status, 'pending'); assert.equal(copyCalls.length, 1);
      await assert.rejects(fs.stat(path.join(workspaceRoot, 'out/race-copy.md')), { code: 'ENOENT' });
      await seed('race-disabled-move.md'); disableReviewOnNextSubmission = true;
      const directCountBeforeDisabled = directCalls.length;
      await assert.rejects(moveAgentPaths({ sourcePaths: ['race-disabled-move.md'], destinationPath: 'out/race-disabled-move.md' }),
        { code: 'DOCUMENT_REVIEW_DISABLED' });
      assert.equal(directCalls.length, directCountBeforeDisabled, 'a disabled review submission never falls through to direct execution');
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'race-disabled-move.md'), 'utf8'), '# race-disabled-move.md');
      await assert.rejects(fs.stat(path.join(workspaceRoot, 'out/race-disabled-move.md')), { code: 'ENOENT' });
      reviewEnabled = false;

      const snapshots = path.join(dataRoot, 'cache', 'agent-file-snapshots');
      await fs.mkdir(snapshots, { recursive: true });
      await seed('snapshot-created.md', '# created content');
      await fs.writeFile(path.join(snapshots, 'absent-snapshot.json'), JSON.stringify({ version: 1, id: 'absent-snapshot',
        path: 'snapshot-created.md', resolvedPath: path.join(workspaceRoot, 'snapshot-created.md'), existed: false,
        size: 0, sha256: null, operation: 'write', createdAt: new Date().toISOString() }));
      nextStatus = 'queued';
      const snapshotQueued = await restoreAgentFileSnapshot({ snapshotId: 'absent-snapshot' });
      assert.equal(snapshotQueued.changed, false); assert.equal(snapshotQueued.fileOperation?.status, 'queued');
      assert.equal(snapshotQueued.fileOperation?.kind, 'delete');
      assert.equal(snapshotQueued.validation.ok, false);
      assert.equal(snapshotQueued.afterSha256, createHash('sha256').update('# created content').digest('hex'));
      assert.equal(directCalls.at(-1)?.kind, 'delete'); assert.equal(directCalls.at(-1)?.expectedPlanId, undefined);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'snapshot-created.md'), 'utf8'), '# created content');
      const snapshotCallCount = directCalls.length;
      const snapshotPendingRetry = await restoreAgentFileSnapshot({ snapshotId: 'absent-snapshot' });
      assert.equal(snapshotPendingRetry.fileOperation?.batchId, snapshotQueued.fileOperation?.batchId);
      assert.equal(snapshotPendingRetry.fileOperation?.status, 'queued'); assert.equal(snapshotPendingRetry.validation.ok, false);
      assert.equal(snapshotPendingRetry.afterSha256, snapshotQueued.afterSha256);
      assert.equal(directCalls.length, snapshotCallCount, 'a queued snapshot retry never creates a second action');
      nextStatus = 'applied';
      const snapshotApplied = await restoreAgentFileSnapshot({ snapshotId: 'absent-snapshot' });
      assert.equal(snapshotApplied.changed, true); assert.equal(snapshotApplied.validation.ok, true);
      assert.equal(snapshotApplied.fileOperation?.batchId, snapshotQueued.fileOperation?.batchId);
      assert.equal(snapshotApplied.trashEntry?.originalPath, 'snapshot-created.md');
      assert.equal(snapshotApplied.afterSha256, createHash('sha256').update('').digest('hex'));
      assert.equal(directCalls.length, snapshotCallCount);

      await seed('snapshot-created.md', '# recreated'); reviewEnabled = true;
      const snapshotAfterToggle = await restoreAgentFileSnapshot({ snapshotId: 'absent-snapshot' });
      assert.equal(snapshotAfterToggle.fileOperation?.batchId, snapshotQueued.fileOperation?.batchId);
      assert.equal(snapshotAfterToggle.fileOperation?.status, 'applied'); assert.equal(snapshotAfterToggle.review, undefined);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'snapshot-created.md'), 'utf8'), '# recreated');
      assert.equal(directCalls.length, snapshotCallCount, 'an acknowledged snapshot retry never becomes a new review after toggling ON');
      for (const changedContext of [{ ...context, agentId: 'other-agent' }, { ...context, sessionId: 'other-session' }]) {
        await assert.rejects(runWithAgentExecutionContext(changedContext,
          () => restoreAgentFileSnapshot({ snapshotId: 'absent-snapshot' })), { code: 'BATCH_IDEMPOTENCY_CONFLICT' });
      }
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'snapshot-created.md'), 'utf8'), '# recreated');

      reviewEnabled = false; nextStatus = 'needs_recovery';
      await seed('snapshot-partial.md', '# partial snapshot');
      await fs.writeFile(path.join(snapshots, 'partial-absence-snapshot.json'), JSON.stringify({ version: 1, id: 'partial-absence-snapshot',
        path: 'snapshot-partial.md', resolvedPath: path.join(workspaceRoot, 'snapshot-partial.md'), existed: false,
        size: 0, sha256: null, operation: 'write', createdAt: new Date().toISOString() }));
      const snapshotPartial = await restoreAgentFileSnapshot({ snapshotId: 'partial-absence-snapshot' });
      assert.equal(snapshotPartial.changed, true); assert.equal(snapshotPartial.validation.ok, false);
      assert.equal(snapshotPartial.fileOperation?.status, 'needs_recovery');
      await assert.rejects(fs.stat(path.join(workspaceRoot, 'snapshot-partial.md')), { code: 'ENOENT' });
      const partialSnapshotCallCount = directCalls.length;
      nextStatus = 'applied'; reviewEnabled = true;
      const snapshotPartialRetry = await restoreAgentFileSnapshot({ snapshotId: 'partial-absence-snapshot' });
      assert.equal(snapshotPartialRetry.fileOperation?.batchId, snapshotPartial.fileOperation?.batchId);
      assert.equal(snapshotPartialRetry.fileOperation?.status, 'needs_recovery'); assert.equal(snapshotPartialRetry.validation.ok, false);
      assert.equal(snapshotPartialRetry.changed, true);
      assert.equal(directCalls.length, partialSnapshotCallCount, 'an absent source never hides unfinished snapshot link cleanup');
      await fs.mkdir(path.join(workspaceRoot, 'snapshot-partial.md'));
      const retryWithReplacement = await restoreAgentFileSnapshot({ snapshotId: 'partial-absence-snapshot' });
      assert.equal(retryWithReplacement.fileOperation?.batchId, snapshotPartial.fileOperation?.batchId);
      assert.equal(retryWithReplacement.validation.ok, false);
      assert.equal((await fs.stat(path.join(workspaceRoot, 'snapshot-partial.md'))).isDirectory(), true,
        'the early journal lookup does not read or mutate a replacement at the original path');

      await fs.writeFile(path.join(snapshots, 'review-absence-snapshot.json'), JSON.stringify({ version: 1, id: 'review-absence-snapshot',
        path: 'snapshot-created.md', resolvedPath: path.join(workspaceRoot, 'snapshot-created.md'), existed: false,
        size: 0, sha256: null, operation: 'write', createdAt: new Date().toISOString() }));
      const snapshotReview = await restoreAgentFileSnapshot({ snapshotId: 'review-absence-snapshot' });
      assert.equal(snapshotReview.changed, false); assert.equal(snapshotReview.review?.status, 'pending');
      assert.equal(snapshotReview.fileOperation, undefined);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'snapshot-created.md'), 'utf8'), '# recreated');
      const snapshotReviewCount = reviewCalls.length;
      const snapshotMetadataCount = (await fs.readdir(snapshots)).length;
      reviewEnabled = false;
      await fs.rm(path.join(workspaceRoot, 'snapshot-created.md'));
      const snapshotReviewRetry = await restoreAgentFileSnapshot({ snapshotId: 'review-absence-snapshot' });
      assert.deepEqual(snapshotReviewRetry.review, snapshotReview.review); assert.equal(snapshotReviewRetry.changed, false);
      assert.equal(snapshotReviewRetry.fileOperation, undefined); assert.equal(reviewCalls.length, snapshotReviewCount);
      assert.equal((await fs.readdir(snapshots)).length, snapshotMetadataCount, 'early snapshot review retry creates no undo snapshot');
      reviewEnabled = true;
      reviewMode = 'direct'; await seed('unexpected-direct.md');
      await assert.rejects(moveAgentPaths({ sourcePaths: ['unexpected-direct.md'], destinationPath: 'out/unexpected-direct.md' }),
        /did not record the file action/u);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'unexpected-direct.md'), 'utf8'), '# unexpected-direct.md');
      reviewEnabled = false; reviewMode = 'needs_review'; nextStatus = 'applied';
      const beforeValidation = problems.length;
      await assert.rejects(deleteAgentPaths({ paths: ['missing-before-service.md'] }), /does not exist/u);
      assert.equal(problems.length, beforeValidation + 1);
      assert.equal(problems.at(-1)!.workspace.workspaceId, context.workspaceId);
      assert.equal(problems.at(-1)!.actorUserId, context.userId);
      assert.deepEqual(problems.at(-1)!.selections, [{ sourcePath: 'missing-before-service.md' }]);
      await assert.rejects(moveAgentPaths({ sourcePaths: [], destinationPath: 'out/empty.md' }));
      assert.deepEqual(problems.at(-1)!.selections, [], 'invalid empty input creates a generic problem without private path text');
      await seed('audit-completed.md'); auditUnavailable = true;
      const audited = await moveAgentPaths({ sourcePaths: ['audit-completed.md'], destinationPath: 'out/audit-completed.md' });
      assert.equal(audited.verified, true); assert.equal(audited.fileOperation?.status, 'applied');
      assert.equal((problems.at(-1)!.error as { code: string }).code, 'BATCH_AUDIT_FAILED');
      auditUnavailable = false;
      await seed('early-failed.md');
      const originalError = Object.assign(new Error('Private early service detail'), { code: 'BATCH_OVERWRITE_REQUIRES_FILES', status: 409 });
      directSubmissionError = originalError; recorderUnavailable = true;
      await assert.rejects(moveAgentPaths({ sourcePaths: ['early-failed.md'], destinationPath: 'out/early-failed.md', overwrite: true }),
        (error) => error === originalError, 'unavailable problem persistence never replaces the original thrown error');
      recorderUnavailable = false;
      await assert.rejects(moveAgentPaths({ sourcePaths: ['early-failed.md'], destinationPath: 'out/early-failed.md' }), (error) => error === originalError);
      assert.equal(problems.at(-1)!.error, originalError);
      await seed('snapshot-error.md');
      await fs.writeFile(path.join(snapshots, 'known-delete-error.json'), JSON.stringify({ version: 1, id: 'known-delete-error',
        path: 'snapshot-error.md', resolvedPath: path.join(workspaceRoot, 'snapshot-error.md'), existed: false,
        size: 0, sha256: null, operation: 'write', createdAt: new Date().toISOString() }));
      await assert.rejects(restoreAgentFileSnapshot({ snapshotId: 'known-delete-error' }), (error) => error === originalError);
      assert.equal(problems.at(-1)!.kind, 'delete');
      assert.deepEqual(problems.at(-1)!.selections, [{ sourcePath: 'snapshot-error.md' }]);
      directSubmissionError = null;
      const beforeUnknownSnapshot = problems.length;
      await assert.rejects(restoreAgentFileSnapshot({ snapshotId: 'unknown-snapshot' }));
      assert.equal(problems.length, beforeUnknownSnapshot, 'unknown snapshot metadata never fabricates a deletion');
      await assert.rejects(runWithAgentExecutionContext({ ...context, canDelete: false },
        () => deleteAgentPaths({ paths: ['early-failed.md'] })));
      assert.equal(problems.length, beforeUnknownSnapshot, 'denied mutation authority cannot create a workspace problem');
    });
    console.log('agent direct path bridge: OFF direct move/delete and fenced copy, ON reviews, immutable Review/Direct retries across flags, missing paths, actor/options changes and snapshot recovery passed');
  } finally {
    internals._load = originalLoad;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

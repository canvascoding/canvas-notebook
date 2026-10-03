import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { NextRequest } from 'next/server';
import type * as Route from '../app/api/files/delete/route';
import type { WorkspacePathOperationInput } from '../app/lib/files/workspace-path-operation-service';
import type { WorkspacePathOperationProblemInput } from '../app/lib/files/workspace-path-operation-problems';

async function main(): Promise<void> {
  const file = path.resolve('app/api/files/delete/route.ts');
  const source = ts.transpileModule(await fs.readFile(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const workspace = { workspaceId: 'workspace', rootPath: '/isolated/workspace', organizationId: null, workspaceType: 'personal' };
  const session = { user: { id: 'user', name: 'User' } };
  let reviewEnabled = true;
  let blocked = false;
  let needsReview = true;
  let revoked = false;
  let changedScope = false;
  let accessChecks = 0;
  let submissions = 0;
  let reviews = 0;
  let audits = 0;
  let lockDepth = 0;
  let receiptUnavailable = false;
  let auditUnavailable = false;
  let submitError: Error | null = null;
  const problems: WorkspacePathOperationProblemInput[] = [];
  let existingDirectRequest: WorkspacePathOperationInput | null = null;
  let existingReview = false;
  let status = 'applied';
  const permissions: string[][] = [];
  const submitted: WorkspacePathOperationInput[] = [];
  const operation = () => ({ batchId: 'direct-delete-job', planId: 'a'.repeat(64), workspaceId: 'workspace',
    kind: 'delete', selections: [{ sourcePath: 'target.md' }], status, completedActions: status === 'applied' ? 2 : 0,
    totalActions: 2, phase: status === 'applied' ? 'complete' : 'preparing', errorCode: status === 'needs_recovery' ? 'LINK_WRITE_STALE' : null });
  const json = (value: unknown, code = 200) => Response.json(value, { status: code });
  const route = { exports: {} as typeof Route };
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name.endsWith('/route-helpers')) return {
      applyRateLimit: () => null, invalidateWorkspaceFileViews: () => undefined,
      readJsonBody: (request: Request) => request.json(),
      jsonSuccess: (payload: unknown, init?: ResponseInit) => json({ success: true, ...(payload as object) }, init?.status),
      jsonError: (error: string, code: number, details: object = {}) => json({ success: false, error, ...details }, code),
      jsonServerError: (_prefix: string, error: unknown) => json({ success: false, error: String(error) }, 500),
    };
    if (name.endsWith('/workspaces/request')) return {
      workspaceFileOptions: (scope: typeof workspace) => ({ workspace: scope }),
      requireRequestWorkspace: async (_request: unknown, options: { permissions: string[] }) => {
        permissions.push(options.permissions);
        accessChecks += 1;
        if (revoked && accessChecks > 1) return { response: json({}, 403) };
        return { workspace: changedScope && accessChecks > 1 ? { ...workspace, rootPath: '/changed/root' } : workspace,
          session, response: null };
      },
    };
    if (name.endsWith('/document-review-availability')) return { readDocumentReviewAvailability: () => ({ documentReviewEnabled: reviewEnabled }) };
    if (name.endsWith('/workspace-operation-delete-review')) return {
      getExistingWorkspaceDeletionReview: async (input: { paths: string[]; idempotencyKey?: string }) => {
        assert.equal(lockDepth, 1);
        if (!existingReview) return null;
        if (JSON.stringify(input.paths) !== JSON.stringify(['target.md']) || input.idempotencyKey !== 'delete-request') {
          throw Object.assign(new Error('Stored delete review identity changed'), { status: 409, code: 'REVIEW_IDEMPOTENCY_CONFLICT' });
        }
        return { blocked: false, reviewRequired: { reviewId: 'review-1234567890',
          planId: 'a'.repeat(64), workspaceId: 'workspace', status: 'pending' } };
      },
      reviewWorkspaceDeletionIfRequired: async () => {
        reviews += 1; assert.equal(lockDepth, 1);
        return needsReview ? { blocked, reviewRequired: { reviewId: 'review-1234567890',
          planId: 'a'.repeat(64), workspaceId: 'workspace', status: blocked ? 'blocked' : 'pending' } } : null;
      },
    };
    if (name.endsWith('/workspace-mutation-lock')) return {
      withWorkspaceMutationLock: async (_id: string, action: () => Promise<unknown>) => {
        lockDepth += 1;
        try { return await action(); } finally { lockDepth -= 1; }
      },
    };
    if (name.endsWith('/workspace-path-operation-service')) return {
      getExistingDirectWorkspacePathOperation: async (input: WorkspacePathOperationInput) => {
        assert.equal(lockDepth, 1, 'retry lookup follows the fresh permission check under the mutation lock');
        if (!existingDirectRequest) return null;
        assert.equal(input.scope.workspace.workspaceId, workspace.workspaceId);
        assert.equal(input.scope.fileOptions.workspace?.workspaceId, workspace.workspaceId);
        assert.equal(input.actorUserId, session.user.id);
        assert.equal(input.actorId, session.user.id);
        assert.equal(input.actorType, 'user');
        const identity = ({ scope: _scope, actorDisplayName: _name, ...request }: WorkspacePathOperationInput) => JSON.stringify(request);
        if (identity(input) !== identity(existingDirectRequest)) {
          throw Object.assign(new Error('File action request identity changed'), { status: 409, code: 'BATCH_IDEMPOTENCY_CONFLICT' });
        }
        return { ...operation(), plan: { previewContents: [{ path: 'index.md' }] }, workspaceId: 'workspace' };
      },
      submitDirectWorkspacePathOperation: async (input: (typeof submitted)[number]) => {
        assert.equal(lockDepth, 1); submissions += 1; submitted.push(input);
        if (submitError) throw submitError;
        return { ...operation(), plan: { previewContents: [{ path: 'index.md' }] }, workspaceId: 'workspace' };
      },
      waitForWorkspacePathOperation: async (batch: unknown) => {
        assert.equal(lockDepth, 0, 'waiting under the preparation lock would prevent worker execution');
        return batch;
      },
    };
    if (name.endsWith('/workspace-path-operation-response')) return {
      workspacePathOperationMetadata: operation,
      workspacePathOperationResponse: async () => {
        assert.equal(lockDepth, 0);
        if (receiptUnavailable) throw Object.assign(new Error('Missing receipt'), { status: 409, code: 'BATCH_JOURNAL_UNAVAILABLE' });
        return status === 'applied' ? { operation: operation(), deleted: ['target.md'], failed: [],
          linkStatus: 'complete', linkUpdates: { updatedFiles: ['index.md'], updatedLinks: 1, warnings: [] },
          trashEntries: [{ id: 'trash-id', originalPath: 'target.md', itemType: 'file', sizeBytes: 10,
            expiresAt: new Date(0).toISOString() }] } : { operation: operation() };
      },
    };
    if (name.endsWith('/workspace-path-operation-problems')) return {
      recordWorkspacePathOperationProblem: async (input: WorkspacePathOperationProblemInput) => { problems.push(input); },
    };
    if (name.endsWith('/audit-service')) return { recordAuditEvent: async () => {
      audits += 1;
      if (auditUnavailable) throw new Error('Private audit infrastructure error');
    } };
    if (name.endsWith('/app-output-folders')) return { isProtectedAppOutputFolder: () => false };
    throw new Error(`Unexpected route dependency: ${name}`);
  }, route, route.exports);
  const remove = (body: object = { path: 'target.md', idempotencyKey: 'delete-request' }) => {
    accessChecks = 0;
    return route.exports.DELETE(new Request('http://localhost/api/files/delete', {
      method: 'DELETE', body: JSON.stringify(body),
    }) as unknown as NextRequest);
  };
  const reviewed = await remove();
  const reviewedBody = await reviewed.json();
  assert.equal(reviewed.status, 200);
  assert.deepEqual(reviewedBody.deleted, []);
  assert.equal(reviewedBody.reviewRequired.status, 'pending');
  assert.equal(submissions, 0);
  reviewEnabled = false; existingReview = true;
  const storedReviewRetry = await remove();
  assert.equal(storedReviewRetry.status, 200);
  assert.deepEqual((await storedReviewRetry.json()).reviewRequired, reviewedBody.reviewRequired);
  assert.equal(submissions, 0, 'a pending review never becomes an automatic delete when the experiment is disabled');
  const changedReviewRetry = await remove({ path: 'different.md', idempotencyKey: 'delete-request' });
  assert.equal(changedReviewRetry.status, 409);
  assert.equal((await changedReviewRetry.json()).code, 'REVIEW_IDEMPOTENCY_CONFLICT');
  assert.equal(submissions, 0);
  existingReview = false; reviewEnabled = true;
  blocked = true;
  const blockedReview = await remove();
  assert.equal(blockedReview.status, 409);
  assert.equal((await blockedReview.json()).code, 'PREVIEW_BLOCKED');
  assert.equal(submissions, 0);
  reviewEnabled = false;
  const priorReviews = reviews;
  const direct = await remove();
  const directBody = await direct.json();
  assert.equal(direct.status, 200);
  assert.deepEqual(directBody.deleted, ['target.md']);
  assert.equal(directBody.trashEntries[0].id, 'trash-id');
  assert.equal(directBody.linkStatus, 'complete');
  assert.equal(directBody.operation.status, 'applied');
  assert.equal(directBody.reviewRequired, undefined);
  assert.equal(reviews, priorReviews, 'disabled experiment never creates a delete review');
  assert.equal(submitted[0].idempotencyKey, 'delete-request');
  assert.equal(submitted[0].actorType, 'user');
  assert.deepEqual(submitted[0].selections, [{ sourcePath: 'target.md' }]);
  assert.equal(audits, 1);
  existingDirectRequest = submitted[0];
  reviewEnabled = true;
  const submissionsBeforeRetry = submissions;
  const reviewsBeforeRetry = reviews;
  const retried = await remove();
  const retriedBody = await retried.json();
  assert.equal(retried.status, 200);
  assert.deepEqual(retriedBody.operation, directBody.operation, 'the original completed direct operation survives an OFF-to-ON review toggle');
  assert.deepEqual(retriedBody.deleted, directBody.deleted);
  assert.deepEqual(retriedBody.trashEntries, directBody.trashEntries, 'retry returns the original proven trash receipt');
  assert.equal(retriedBody.linkStatus, 'complete');
  assert.equal(retriedBody.reviewRequired, undefined);
  assert.equal(submissions, submissionsBeforeRetry, 'acknowledged retry never submits another deletion');
  assert.equal(reviews, reviewsBeforeRetry, 'acknowledged direct retry is resolved before the optional review gate');
  const conflictingRetry = await remove({ path: 'different.md', idempotencyKey: 'delete-request' });
  assert.equal(conflictingRetry.status, 409);
  assert.equal((await conflictingRetry.json()).code, 'BATCH_IDEMPOTENCY_CONFLICT');
  assert.equal(submissions, submissionsBeforeRetry);
  assert.equal(reviews, reviewsBeforeRetry, 'a changed request cannot manufacture a review under the same key');
  existingDirectRequest = null;
  reviewEnabled = false;
  const auditsAfterApply = audits;
  const problemsBeforeBatchFailures = problems.length;
  for (const pending of ['queued', 'applying']) {
    status = pending;
    const response = await remove();
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.operation.status, pending);
    assert.equal(body.deleted, undefined);
    assert.equal(body.trashEntries, undefined);
    assert.equal(body.linkStatus, undefined);
  }
  for (const failed of ['blocked', 'needs_review', 'needs_recovery', 'failed']) {
    status = failed;
    const response = await remove();
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.success, false);
    assert.equal(body.operation.status, failed);
    assert.equal(body.deleted, undefined, 'a partial deletion cannot be advertised as complete');
    assert.equal(body.trashEntries, undefined);
  }
  assert.equal(audits, auditsAfterApply, 'queued and failed jobs never create success audit events');
  assert.equal(problems.length, problemsBeforeBatchFailures, 'existing durable failures do not produce duplicate problem notices');
  status = 'applied'; receiptUnavailable = true;
  const missing = await remove();
  const missingBody = await missing.json();
  assert.equal(missing.status, 409);
  assert.equal(missingBody.code, 'BATCH_JOURNAL_UNAVAILABLE');
  assert.equal(missingBody.operation.batchId, 'direct-delete-job');
  assert.equal(missingBody.deleted, undefined);
  assert.equal((problems.at(-1)!.error as { code: string }).code, 'BATCH_JOURNAL_UNAVAILABLE');
  receiptUnavailable = false;
  reviewEnabled = false;
  submitError = Object.assign(new Error('Missing source'), { status: 422, code: 'BATCH_INVALID_REQUEST' });
  const early = await remove();
  assert.equal(early.status, 422);
  assert.equal((await early.json()).operation, undefined);
  assert.equal(problems.at(-1)!.kind, 'delete');
  assert.equal(problems.at(-1)!.actorUserId, 'user');
  assert.deepEqual(problems.at(-1)!.selections, [{ sourcePath: 'target.md' }]);
  submitError = null; auditUnavailable = true;
  const audited = await remove();
  assert.equal(audited.status, 200);
  assert.deepEqual((await audited.json()).deleted, ['target.md']);
  assert.equal((problems.at(-1)!.error as { code: string }).code, 'BATCH_AUDIT_FAILED');
  auditUnavailable = false;
  reviewEnabled = true; needsReview = false;
  const unlinked = await remove();
  assert.equal(unlinked.status, 200, 'unlinked deletion still uses the mandatory durable executor with review enabled');
  assert.equal((await unlinked.json()).operation.status, 'applied');
  const submissionsBeforeDenied = submissions;
  const problemsBeforeDenied = problems.length;
  revoked = true;
  assert.equal((await remove()).status, 403);
  assert.equal(submissions, submissionsBeforeDenied);
  revoked = false; changedScope = true;
  assert.equal((await remove()).status, 403);
  assert.equal(submissions, submissionsBeforeDenied, 'changed scope is rejected before submission');
  assert.equal(problems.length, problemsBeforeDenied);
  changedScope = false;
  assert.equal((await remove({ path: [null] })).status, 400);
  assert.equal(submissions, submissionsBeforeDenied);
  assert.ok(permissions.every((value) => JSON.stringify(value) === JSON.stringify(['canRead', 'canWrite', 'canDelete'])));
  console.log('manual DELETE route: optional review, mandatory durable deletion, queued/failed truth, actual-receipt errors, lock release, refreshed read/write/delete authority and applied audit OK');
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

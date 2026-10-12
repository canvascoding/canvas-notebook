import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import ts from 'typescript';

import type * as Service from '../app/lib/files/workspace-operation-review-service';

const PLAN_A = 'a'.repeat(64);
const PLAN_B = 'b'.repeat(64);
const workspace = { workspaceId: 'workspace-one', organizationId: 'organization-one', status: 'active',
  permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true } };

type Row = Record<string, unknown>;

async function harness() {
  const file = path.resolve('app/lib/files/workspace-operation-review-service.ts');
  const source = ts.transpileModule(await fs.readFile(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const load = createRequire(file);
  const rows = new Map<string, Row>();
  const audits = new Set<string>();
  const controls = { planId: PLAN_A, blocked: false, coverageComplete: true, executionCount: 0,
    lifecycleBusy: false,
    lifecycleScopes: [] as Array<readonly { workspaceId: string; paths: readonly string[] }[]>,
    pathValidationCount: 0,
    reviewEnabled: true, disableDuringPreview: false,
    concurrentInsertStatus: null as string | null,
    auditAvailable: true, auditWrites: 0, journalStatus: 'completed',
    metrics: [] as Array<Record<string, unknown>>,
    lastExecutionInput: null as Record<string, unknown> | null,
    snapshotEntries: [] as Array<{ path: string; kind: 'file' | 'directory'; identity: string;
      markdownContent?: string }> };
  const mutex = new Map<string, Promise<unknown>>();
  const lock = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const prior = mutex.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    mutex.set(key, prior.then(() => current));
    await prior;
    try { return await operation(); } finally { release(); }
  };
  const connection = {
    get: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM audit_events')) return audits.has(String(params[0])) ? { id: 'audit-one' } : undefined;
      if (sql.includes('INSERT INTO workspace_file_operation_reviews')) {
        const id = String(params[0]);
        if (rows.has(id)) {
          if (controls.concurrentInsertStatus) rows.get(id)!.status = controls.concurrentInsertStatus;
          return undefined;
        }
        const row: Row = { review_id: id, plan_id: params[1], request_hash: params[2],
          request_json: params[3], preview_json: params[4], source_workspace_id: params[5],
          destination_workspace_id: params[6], actor_user_id: params[7], actor_id: params[8],
          actor_session_id: params[9], actor_display_name: params[10], status: params[11],
          reason_codes_json: params[12], created_at: params[13], updated_at: params[13],
          operation_id: null, error_code: null, reviewer_user_id: null,
          trash_entry_ids_json: '[]', revision: 1 };
        rows.set(id, row);
        return { ...row };
      }
      if (sql.includes('UPDATE workspace_file_operation_reviews')) {
        const id = String(params[0]); const row = rows.get(id);
        if (!row || row.status !== params[1]) return undefined;
        const changed: Row = { ...row, status: params[2], operation_id: params[3] ?? row.operation_id,
          error_code: params[4], trash_entry_ids_json: params[5] ?? row.trash_entry_ids_json,
          reviewer_user_id: params[6] ?? row.reviewer_user_id,
          updated_at: params[7], revision: Number(row.revision) + 1 };
        rows.set(id, changed);
        return { ...changed };
      }
      if (sql.includes('FROM workspace_file_operation_reviews')) return rows.get(String(params[0]));
      throw new Error(`Unexpected review query: ${sql}`);
    },
    all: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM collaboration_documents')) return [];
      if (sql.includes('SELECT DISTINCT actor_session_id')) return [...new Set([...rows.values()]
        .filter((row) => row.source_workspace_id === params[0] && row.actor_user_id === params[1])
        .map((row) => row.actor_session_id))].slice(0, 1001).map((actor_session_id) => ({ actor_session_id }));
      if (sql.includes('review_id = ANY')) return [...rows.values()].filter((row) => (params[0] as string[]).includes(String(row.review_id)));
      if (sql.includes('FROM workspace_file_operation_reviews')) return [...rows.values()]
        .filter((row) => row.source_workspace_id === params[0]
          && ['pending', 'blocked', 'stale', 'needs_recovery', 'failed', 'applying'].includes(String(row.status)));
      throw new Error(`Unexpected review query: ${sql}`);
    },
    close: async () => undefined,
  };
  const service = { exports: {} as typeof Service };
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/document-review-availability') return {
      readDocumentReviewAvailability: () => ({ documentReviewEnabled: controls.reviewEnabled, updatedAt: null }),
    };
    if (name === '@/app/lib/audit/audit-service') return { recordAuditEvent: async (input: { inputHash: string }) => {
      controls.auditWrites += 1;
      if (!controls.auditAvailable) return null;
      audits.add(input.inputHash); return { id: `audit-${controls.auditWrites}` };
    } };
    if (name === '@/app/lib/api/route-helpers') return { invalidateWorkspaceFileViews: () => undefined };
    if (name === '@/app/lib/db') return { openDb: async () => connection };
    if (name === '@/app/lib/files/collaboration-policy') return { archiveFileCollaborationPaths: async () => undefined };
    if (name === '@/app/lib/files/workspace-mutation-lock') return { withWorkspaceMutationLock: (key: string, op: () => Promise<unknown>) => lock(key, op) };
    if (name === '@/app/lib/files/workspace-file-lifecycle-guard') return {
      withWorkspaceFileLifecycleGuards: async (scopes: readonly { workspaceId: string; paths: readonly string[] }[], op: () => Promise<unknown>) => {
        controls.lifecycleScopes.push(scopes);
        if (controls.lifecycleBusy) throw Object.assign(new Error('Still open.'), { code: 'COLLABORATION_FILE_LIFECYCLE_BUSY', status: 409 });
        return op();
      },
    };
    if (name === '@/app/lib/filesystem/workspace-files') return {
      withWorkspaceCopyMutationLocks: (_a: unknown, _b: unknown, op: () => Promise<unknown>) => lock('workspace-one', op) };
    if (name === '@/app/lib/filesystem/app-output-folders') return { isProtectedAppOutputFolder: () => false };
    if (name === '@/app/lib/filesystem/workspace-trash') return { trashWorkspacePaths: async (input: {
      paths: string[] }) => ({ trashed: input.paths.map((pathValue) => ({ id: `trash-${pathValue}`,
      originalPath: pathValue })), failed: [] }) };
    if (name === '@/app/lib/file-version-center/review-policy-service') return { fileReviewPolicyService: {
      readAuthorized: async () => ({ effectiveMode: 'safe_direct' }) } };
    if (name === '@/app/lib/markdown/workspace-link-index-core') return { buildWorkspaceLinkIndexFromDocuments: () => ({
      edges: [], coverage: { complete: true, omittedSources: [], unresolvedLinks: [] } }) };
    if (name === '@/app/lib/markdown/workspace-file-operation-preview') return {
      buildWorkspaceFileOperationPreview: async () => {
        if (controls.disableDuringPreview) controls.reviewEnabled = false;
        return ({ contractVersion: 1, planId: controls.planId,
        kind: 'move', status: 'planned', pathMappings: [{ sourcePath: 'target.md', destinationPath: 'moved.md',
          sourceIdentity: 'identity', sourceWorkspaceId: 'workspace-one', destinationWorkspaceId: 'workspace-one' }],
        linkEdits: [{ sourcePathBefore: 'index.md', sourcePathAfter: 'index.md',
          previousTargetLiteral: './target.md', nextTargetLiteral: './moved.md' }],
        coverage: { complete: controls.coverageComplete,
          omittedSources: controls.coverageComplete ? [] : [{ path: 'big.md', reason: 'source-too-large' }],
          unresolvedLinks: [] }, expectedPathState: [],
        collisions: controls.blocked ? [{ workspaceId: 'workspace-one', path: 'moved.md' }] : [],
        recoveryReady: true, readiness: controls.blocked || !controls.coverageComplete ? 'blocked' : 'ready',
        issues: controls.blocked ? [{ code: 'destination-collision', workspaceId: 'workspace-one',
          path: 'moved.md', detail: 'occupied' }] : controls.coverageComplete ? [] : [{
          code: 'incomplete-index', workspaceId: 'workspace-one', path: '.', detail: 'big Markdown file',
        }], previewContents: [] });
      },
      buildWorkspacePlannerSnapshot: async () => ({ workspaceId: 'workspace-one', entries: controls.snapshotEntries }),
      assertFreshWorkspaceFileOperationPlan: (_plan: { planId: string }, planId: string) => {
        if (_plan.planId !== planId) throw Error('stale');
      },
    };
    if (name === '@/app/lib/public-sharing/public-file-shares') return { syncPublicSharesAfterDelete: async () => undefined };
    if (name === '@/app/lib/workspaces/path-guard') return { resolveWorkspacePath: (_workspace: unknown, value: string) => {
      controls.pathValidationCount += 1;
      if (path.isAbsolute(value) || value.split(/[\\/]/u).includes('..')) {
        throw Object.assign(new Error('Outside the workspace.'), { code: 'WORKSPACE_PATH_OUTSIDE_ROOT', status: 400 });
      }
      return { relativePath: value };
    } };
    if (name === './workspace-operation-observability') return {
      observeWorkspaceOperation: (input: Record<string, unknown>) => { controls.metrics.push(input); },
    };
    if (name === './workspace-file-operation-service') return { executeWorkspaceFileOperationService: async (input: Record<string, unknown>) => {
      controls.executionCount += 1;
      controls.lastExecutionInput = input;
      return { execution: { status: 'complete' } };
    } };
    if (name === './workspace-operation-journal') return { WorkspaceOperationJournal: class {
      async get() { return { status: controls.journalStatus }; }
    } };
    return load(name);
  }, service, service.exports);
  const scope = { workspace, fileOptions: { workspace } } as Parameters<typeof service.exports.submitAgentWorkspacePathOperation>[0]['source'];
  const submitInput = {
    kind: 'move', source: scope, destination: scope,
    selections: [{ sourcePath: 'target.md', destinationPath: 'moved.md' }],
    actorUserId: 'user-one', actorId: 'agent-one', actorDisplayName: 'Agent',
    actorSessionId: 'session-one', idempotencyKey: 'call-one',
  } as Parameters<typeof service.exports.submitAgentWorkspacePathOperation>[0];
  const submit = () => service.exports.submitAgentWorkspacePathOperation(submitInput);
  const accept = (reviewId: string, planId: string, refreshAccess = async () => ({ source: scope, destination: scope })) =>
    service.exports.acceptWorkspaceOperationReview({ reviewId, planId, source: scope, destination: scope,
      reviewerUserId: 'user-one', reviewerDisplayName: 'User', refreshAccess });
  return { service: service.exports, controls, rows, scope, submitInput, submit, accept };
}

test('unknown review keys do not validate session-temp paths but stored keys remain immutable', async () => {
  const h = await harness();
  h.controls.disableDuringPreview = true;
  for (const sourcePath of ['/data/session-temp/scratch.md', '../session-temp/scratch.md']) {
    assert.equal(await h.service.getExistingAgentWorkspacePathOperation({ ...h.submitInput,
      selections: [{ sourcePath, destinationPath: '/data/session-temp/moved.md' }] }), null);
  }
  assert.equal(h.controls.pathValidationCount, 0, 'unknown keys cannot classify or reject paths before the agent does');
  assert.equal(h.controls.reviewEnabled, true, 'the lookup cannot build a preview');
  assert.equal(h.rows.size, 0);
  assert.equal(h.controls.executionCount, 0);

  h.controls.disableDuringPreview = false;
  const saved = await h.submit();
  if (saved.mode === 'direct') throw new Error('Expected saved review.');
  const immutable = JSON.stringify(h.rows.get(saved.reviewId));
  h.controls.reviewEnabled = false;
  for (const sourcePath of ['/data/session-temp/scratch.md', '../session-temp/scratch.md']) {
    await assert.rejects(h.service.getExistingAgentWorkspacePathOperation({ ...h.submitInput,
      selections: [{ sourcePath, destinationPath: 'moved.md' }] }), { code: 'WORKSPACE_PATH_OUTSIDE_ROOT' });
    await assert.rejects(h.service.getExistingAgentWorkspacePathOperation({ ...h.submitInput,
      requestSelections: [{ sourcePath, destinationPath: 'moved.md' }] }), { code: 'WORKSPACE_PATH_OUTSIDE_ROOT' });
  }
  await assert.rejects(h.service.getExistingAgentWorkspacePathOperation({ ...h.submitInput,
    selections: [{ sourcePath: 'another.md', destinationPath: 'moved.md' }] }), { code: 'REVIEW_IDEMPOTENCY_CONFLICT' });
  assert.equal(JSON.stringify(h.rows.get(saved.reviewId)), immutable);
  assert.equal(h.rows.size, 1);
  assert.equal(h.controls.executionCount, 0);
});

test('disabled experiment blocks new reviews and acceptance while preserving exact pending retries', async () => {
  const h = await harness();
  h.controls.reviewEnabled = false;
  await assert.rejects(h.submit(), { code: 'DOCUMENT_REVIEW_DISABLED', status: 409 });
  assert.equal(h.rows.size, 0);
  h.controls.reviewEnabled = true;
  const saved = await h.submit();
  if (saved.mode === 'direct') throw new Error('Expected saved review.');
  const immutable = JSON.stringify(h.rows.get(saved.reviewId));
  h.controls.reviewEnabled = false;
  assert.deepEqual(await h.service.getExistingAgentWorkspacePathOperation(h.submitInput), saved);
  assert.deepEqual(await h.submit(), saved);
  await assert.rejects(h.accept(saved.reviewId, saved.planId), { code: 'DOCUMENT_REVIEW_DISABLED', status: 409 });
  await assert.rejects(h.service.refreshWorkspaceOperationReview({ reviewId: saved.reviewId, planId: saved.planId,
    source: h.scope, destination: h.scope, reviewerUserId: 'user-one', refreshAccess: async () => ({ source: h.scope, destination: h.scope }) }),
  { code: 'DOCUMENT_REVIEW_DISABLED', status: 409 });
  assert.equal(h.controls.executionCount, 0);
  assert.equal(JSON.stringify(h.rows.get(saved.reviewId)), immutable);
  assert.equal((await h.service.listWorkspaceOperationReviews('workspace-one')).length, 1);
  h.controls.reviewEnabled = true;
  assert.equal((await h.accept(saved.reviewId, saved.planId)).status, 'applied');
  h.controls.reviewEnabled = false;
  assert.equal((await h.accept(saved.reviewId, saved.planId)).status, 'applied', 'an applied retry remains readable OFF');
  assert.equal(h.controls.executionCount, 1);
});

test('disabling during preview or the locked permission refresh cannot persist or accept', async () => {
  const h = await harness();
  h.controls.disableDuringPreview = true;
  await assert.rejects(h.submit(), { code: 'DOCUMENT_REVIEW_DISABLED' });
  assert.equal(h.rows.size, 0);
  h.controls.reviewEnabled = true; h.controls.disableDuringPreview = false;
  const saved = await h.submit();
  if (saved.mode === 'direct') throw new Error('Expected saved review.');
  await assert.rejects(h.accept(saved.reviewId, saved.planId, async () => {
    h.controls.reviewEnabled = false;
    return { source: h.scope, destination: h.scope };
  }), { code: 'DOCUMENT_REVIEW_DISABLED' });
  assert.equal(h.rows.get(saved.reviewId)?.status, 'pending');
  assert.equal(h.controls.executionCount, 0);
  h.controls.reviewEnabled = true; h.controls.disableDuringPreview = true;
  await assert.rejects(h.accept(saved.reviewId, saved.planId), { code: 'DOCUMENT_REVIEW_DISABLED' });
  assert.equal(h.rows.get(saved.reviewId)?.status, 'pending');
  assert.equal(h.controls.executionCount, 0);
});

test('immutable agent retry binds original missing selections, flags, actor, session, and name independently of the feature', async () => {
  const h = await harness();
  const input = { ...h.submitInput, selections: [{ sourcePath: 'target.md' }], kind: 'delete' as const,
    requestSelections: [{ sourcePath: 'target.md' }, { sourcePath: 'absent.md' }],
    requestOptions: { ignoreMissing: true, recursive: true } };
  h.controls.snapshotEntries = [{ path: 'target.md', kind: 'file', identity: 'v1', markdownContent: '# Target' }];
  const saved = await h.service.submitAgentWorkspacePathOperation(input);
  if (saved.mode === 'direct') throw new Error('Expected saved review.');
  h.controls.reviewEnabled = false;
  const retry = { ...input, selections: input.requestSelections };
  assert.deepEqual(await h.service.getExistingAgentWorkspacePathOperation(retry), saved);
  for (const changed of [ { actorId: 'other-agent' }, { actorSessionId: 'other-session' }, { actorDisplayName: 'Other name' },
    { requestOptions: { ignoreMissing: false, recursive: true } }, { requestOptions: { ignoreMissing: true, recursive: false } },
    { requestSelections: [{ sourcePath: 'replacement.md' }] } ]) {
    await assert.rejects(h.service.getExistingAgentWorkspacePathOperation({ ...retry, ...changed }), { code: 'REVIEW_IDEMPOTENCY_CONFLICT' });
  }
  assert.equal(h.rows.size, 1);
  assert.equal(h.controls.executionCount, 0);
});

test('legacy session-bound review keys are found across sessions and ambiguous or oversized scopes fail closed', async () => {
  const h = await harness();
  const saved = await h.submit();
  if (saved.mode === 'direct') throw new Error('Expected saved review.');
  const row = h.rows.get(saved.reviewId)!;
  const legacyId = (sessionId: string) => createHash('sha256').update(JSON.stringify(['workspace-operation-review-v1',
    'workspace-one', 'user-one', sessionId, 'call-one'])).digest('hex');
  h.rows.delete(saved.reviewId);
  row.review_id = legacyId('session-one');
  h.rows.set(String(row.review_id), row);
  h.controls.reviewEnabled = false;
  const prior = await h.service.getExistingAgentWorkspacePathOperation(h.submitInput);
  assert.equal(prior?.mode === 'needs_review' ? prior.reviewId : null, row.review_id);
  const immutable = JSON.stringify(row);
  const beforeUnknownPath = h.controls.pathValidationCount;
  assert.equal(await h.service.getExistingAgentWorkspacePathOperation({ ...h.submitInput,
    idempotencyKey: 'unknown-temp-key', selections: [{ sourcePath: '/data/session-temp/scratch.md', destinationPath: 'out.md' }] }), null);
  assert.equal(h.controls.pathValidationCount, beforeUnknownPath, 'unrelated legacy reviews cannot reject a new temp request');
  await assert.rejects(h.service.getExistingAgentWorkspacePathOperation({ ...h.submitInput,
    selections: [{ sourcePath: '/data/session-temp/scratch.md', destinationPath: 'out.md' }] }),
  { code: 'WORKSPACE_PATH_OUTSIDE_ROOT' });
  assert.equal(JSON.stringify(row), immutable, 'known legacy keys fail before any review mutation');
  await assert.rejects(h.service.getExistingAgentWorkspacePathOperation({ ...h.submitInput, actorSessionId: 'new-session' }),
    { code: 'REVIEW_IDEMPOTENCY_CONFLICT' });
  h.rows.set(legacyId('second-session'), { ...row, review_id: legacyId('second-session'), actor_session_id: 'second-session' });
  await assert.rejects(h.service.getExistingAgentWorkspacePathOperation(h.submitInput), { code: 'REVIEW_IDEMPOTENCY_CONFLICT' });
  for (let index = 0; index < 1001; index += 1) h.rows.set(`unrelated-${index}`, {
    ...row, review_id: `unrelated-${index}`, actor_session_id: `unrelated-session-${index}`,
  });
  await assert.rejects(h.service.getExistingAgentWorkspacePathOperation(h.submitInput), { code: 'REVIEW_IDEMPOTENCY_SCOPE_LIMIT' });
  assert.equal(h.controls.executionCount, 0);
});

test('concurrent same-key creation returns the stored status and checks immutable actor name', async () => {
  const h = await harness();
  h.controls.concurrentInsertStatus = 'queued';
  const submissions = await Promise.all([h.submit(), h.submit()]);
  assert.equal(h.rows.size, 1);
  assert.equal(submissions[0].mode, 'needs_review');
  assert.equal(submissions[1].mode, 'blocked');
  assert.equal(submissions[1].mode === 'blocked' ? submissions[1].status : null, 'queued');
  const changed = await harness();
  const results = await Promise.allSettled([changed.submit(),
    changed.service.submitAgentWorkspacePathOperation({ ...changed.submitInput, actorDisplayName: 'Other name' })]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].status === 'rejected' ? results[1].reason.code : null, 'REVIEW_IDEMPOTENCY_CONFLICT');
  assert.equal(changed.rows.size, 1);
});

test('blocked collision preview remains readable and appears in attention list', async () => {
  const h = await harness(); h.controls.blocked = true;
  const submitted = await h.submit();
  assert.equal(submitted.mode, 'blocked');
  assert.deepEqual(h.controls.metrics, [{ scope: 'review', kind: 'move', phase: 'preview', outcome: 'conflict' }]);
  if (submitted.mode !== 'blocked') return;
  const review = await h.service.getWorkspaceOperationReview(submitted.reviewId);
  assert.equal(review?.status, 'blocked');
  assert.equal(review?.preview.readiness, 'blocked');
  assert.equal((await h.service.listWorkspaceOperationReviews('workspace-one')).length, 1);
  await assert.rejects(h.accept(submitted.reviewId, submitted.planId), { code: 'REVIEW_CONFLICT' });
  const dismissed = await h.service.rejectWorkspaceOperationReview(submitted.reviewId, submitted.planId);
  assert.equal(dismissed.status, 'rejected');
});

test('an incomplete link plan emits one bounded event per persisted proposal', async () => {
  const h = await harness(); h.controls.coverageComplete = false;
  const submitted = await h.submit();
  assert.equal(submitted.mode, 'blocked');
  assert.deepEqual(h.controls.metrics, [{ scope: 'review', kind: 'move', phase: 'preview',
    outcome: 'incomplete_link_plan', omittedSourceCount: 1, unresolvedLinkCount: 0 }]);
  await h.submit();
  assert.equal(h.controls.metrics.length, 1);
});

test('stale plan and revoked access stop before any mutation', async () => {
  const h = await harness();
  const submitted = await h.submit();
  assert.equal(submitted.mode, 'needs_review');
  if (submitted.mode !== 'needs_review') return;
  await assert.rejects(h.accept(submitted.reviewId, submitted.planId,
    async () => { throw new h.service.WorkspaceOperationReviewError('REVIEW_ACCESS_DENIED', 403, 'revoked'); }),
  { code: 'REVIEW_ACCESS_DENIED' });
  assert.equal(h.controls.executionCount, 0);
  assert.equal((await h.service.getWorkspaceOperationReview(submitted.reviewId))?.status, 'pending');
  h.controls.planId = PLAN_B;
  await assert.rejects(h.accept(submitted.reviewId, submitted.planId), { code: 'PREVIEW_STALE' });
  assert.equal(h.controls.executionCount, 0);
  assert.equal((await h.service.getWorkspaceOperationReview(submitted.reviewId))?.status, 'stale');
  assert.deepEqual(h.controls.metrics, [{ scope: 'review', kind: 'move', phase: 'apply', outcome: 'conflict' }]);
});

test('two concurrent accepts execute one operation with one audit receipt', async () => {
  const h = await harness(); const submitted = await h.submit();
  assert.equal(submitted.mode, 'needs_review');
  if (submitted.mode !== 'needs_review') return;
  const results = await Promise.allSettled([
    h.accept(submitted.reviewId, submitted.planId), h.accept(submitted.reviewId, submitted.planId),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(h.controls.executionCount, 1);
  assert.equal(h.controls.lastExecutionInput?.actorType, 'user');
  assert.equal(h.controls.lastExecutionInput?.actorId, 'user-one');
  assert.equal(h.controls.lastExecutionInput?.actorSessionId, undefined);
  assert.equal(h.controls.auditWrites, 1);
  assert.equal((await h.service.getWorkspaceOperationReview(submitted.reviewId))?.status, 'applied');
});

test('an owned lifecycle scope blocks review before applying or touching files', async () => {
  const h = await harness();
  const submitted = await h.submit();
  assert.equal(submitted.mode, 'needs_review');
  if (submitted.mode !== 'needs_review') return;
  h.controls.lifecycleBusy = true;
  await assert.rejects(h.accept(submitted.reviewId, submitted.planId), { code: 'COLLABORATION_FILE_LIFECYCLE_BUSY' });
  assert.equal(h.controls.executionCount, 0);
  assert.equal(h.controls.auditWrites, 0);
  assert.equal((await h.service.getWorkspaceOperationReview(submitted.reviewId))?.status, 'pending');
  assert.deepEqual(h.controls.lifecycleScopes, [[
    { workspaceId: 'workspace-one', paths: ['target.md'] },
    { workspaceId: 'workspace-one', paths: ['moved.md'] },
  ]]);
});

test('interrupted applying state reconciles from journal without replay', async () => {
  const h = await harness(); const submitted = await h.submit();
  assert.equal(submitted.mode, 'needs_review');
  if (submitted.mode !== 'needs_review') return;
  const row = h.rows.get(submitted.reviewId)!;
  row.status = 'applying'; row.operation_id = 'operation-one'; row.updated_at = Date.now() - 180_000;
  row.reviewer_user_id = 'user-one';
  const review = await h.service.getWorkspaceOperationReview(submitted.reviewId);
  assert.equal(review?.status, 'applied');
  assert.equal(h.controls.executionCount, 0);
  assert.equal(h.controls.auditWrites, 1);
});

test('unavailable audit keeps applied data visible for recovery and later receipt retry', async () => {
  const h = await harness(); const submitted = await h.submit();
  assert.equal(submitted.mode, 'needs_review');
  if (submitted.mode !== 'needs_review') return;
  h.controls.auditAvailable = false;
  const first = await h.accept(submitted.reviewId, submitted.planId);
  assert.equal(first.status, 'needs_recovery');
  assert.equal(first.errorCode, 'AUDIT_WRITE_FAILED');
  assert.deepEqual(h.controls.metrics, [{ scope: 'review', kind: 'move', phase: 'recovery', outcome: 'needs_recovery' }]);
  assert.equal(h.controls.executionCount, 1);
  h.controls.auditAvailable = true;
  const recovered = await h.service.getWorkspaceOperationReview(submitted.reviewId);
  assert.equal(recovered?.status, 'applied');
  assert.equal(h.controls.executionCount, 1);
});

test('reviewed delete records a trash receipt without invoking the path executor', async () => {
  const h = await harness();
  h.controls.snapshotEntries = [{ path: 'target.md', kind: 'file', identity: 'file-v1',
    markdownContent: '# Target\n' }];
  const scope = { workspace, fileOptions: { workspace } } as Parameters<typeof h.service.submitAgentWorkspacePathOperation>[0]['source'];
  const submitted = await h.service.submitAgentWorkspacePathOperation({ kind: 'delete', source: scope,
    selections: [{ sourcePath: 'target.md' }], actorUserId: 'user-one', actorId: 'agent-one',
    actorDisplayName: 'Agent', actorSessionId: 'session-one', idempotencyKey: 'delete-call-one' });
  assert.equal(submitted.mode, 'needs_review');
  if (submitted.mode !== 'needs_review') return;
  const applied = await h.accept(submitted.reviewId, submitted.planId);
  assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.trashEntryIds, ['trash-target.md']);
  assert.equal(h.controls.executionCount, 0);
});

test('copy needs read and write but no delete permission at submit and accept', async () => {
  const h = await harness();
  const limitedWorkspace = { ...workspace, permissions: { ...workspace.permissions, canDelete: false } };
  const limited = { workspace: limitedWorkspace, fileOptions: { workspace: limitedWorkspace } } as
    Parameters<typeof h.service.submitAgentWorkspacePathOperation>[0]['source'];
  const submission = await h.service.submitAgentWorkspacePathOperation({
    kind: 'copy', source: limited, destination: limited,
    selections: [{ sourcePath: 'target.md', destinationPath: 'moved.md' }],
    actorUserId: 'user-one', actorId: 'agent-one', actorDisplayName: 'Agent',
    actorSessionId: 'session-one', idempotencyKey: 'copy-without-delete',
  });
  assert.equal(submission.mode, 'needs_review');
  if (submission.mode !== 'needs_review') return;
  const accepted = await h.service.acceptWorkspaceOperationReview({
    reviewId: submission.reviewId, planId: submission.planId,
    source: limited, destination: limited,
    reviewerUserId: 'user-one', reviewerDisplayName: 'User',
    refreshAccess: async () => ({ source: limited, destination: limited }),
  });
  assert.equal(accepted.status, 'applied');
  assert.equal(h.controls.executionCount, 1);
  await assert.rejects(h.service.submitAgentWorkspacePathOperation({
    kind: 'move', source: limited, destination: limited,
    selections: [{ sourcePath: 'target.md', destinationPath: 'moved.md' }],
    actorUserId: 'user-one', actorId: 'agent-one', actorDisplayName: 'Agent',
  }), { code: 'REVIEW_ACCESS_DENIED' });
});

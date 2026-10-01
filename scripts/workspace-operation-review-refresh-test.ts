import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import ts from 'typescript';

import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import type { SqlConnection } from '../app/lib/db';
import type * as Service from '../app/lib/files/workspace-operation-review-service';
import type * as ManualDelete from '../app/lib/files/workspace-operation-delete-review';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { buildWorkspaceOperationBatchPlan } from '../app/lib/files/workspace-operation-batch-plan';

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-review-refresh-'));
  const previousData = process.env.DATA;
  process.env.DATA = root;
  const pg = new PGlite();
  try {
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await pg.exec(statement);
    const connect = async (): Promise<SqlConnection> => ({
      get: async (sql, params = []) => (await pg.query(sql, params)).rows[0],
      all: async (sql, params = []) => (await pg.query(sql, params)).rows,
      run: async (sql, params = []) => pg.query(sql, params), close: () => undefined,
    });
    const workspace: WorkspaceContext = { workspaceId: 'refresh-workspace', workspaceType: 'personal',
      rootPath: path.join(root, 'workspace'), rootRelativePath: 'workspace', status: 'active',
      organizationId: null, ownerUserId: 'reviewer', legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
        canCreatePublicLinks: false, canManageWorkspace: true } };
    await fs.mkdir(path.join(workspace.rootPath, 'Docs'), { recursive: true });
    await fs.mkdir(path.join(workspace.rootPath, 'Archive'));
    await fs.writeFile(path.join(workspace.rootPath, 'Docs', 'target.md'), '# Target\n');
    await fs.writeFile(path.join(workspace.rootPath, 'index.md'), '[Target](Docs/target.md)\n');
    const scope = { workspace, fileOptions: { workspace } };
    const file = path.resolve('app/lib/files/workspace-operation-review-service.ts');
    const source = ts.transpileModule(await fs.readFile(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const load = createRequire(file);
    const service = { exports: {} as typeof Service };
    new Function('require', 'module', 'exports', source)((name: string) => {
      if (name === 'server-only') return {};
      if (name === '@/app/lib/db') return { openDb: connect };
      return load(name);
    }, service, service.exports);
    const manualFile = path.resolve('app/lib/files/workspace-operation-delete-review.ts');
    const manualSource = ts.transpileModule(await fs.readFile(manualFile, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const manualLoad = createRequire(manualFile);
    const manual = { exports: {} as typeof ManualDelete };
    new Function('require', 'module', 'exports', manualSource)((name: string) => {
      if (name === 'server-only') return {};
      if (name === '@/app/lib/db') return { openDb: connect };
      return manualLoad(name);
    }, manual, manual.exports);
    const submit = (kind: 'move' | 'delete', sourcePath: string, destinationPath?: string) => service.exports.submitAgentWorkspacePathOperation({
      kind, source: scope, selections: [{ sourcePath, ...(destinationPath ? { destinationPath } : {}) }],
      actorUserId: 'reviewer', actorId: 'agent', actorDisplayName: 'Agent',
    });
    const forward = await submit('move', 'Docs', 'Archive/Docs');
    const dependent = await submit('delete', 'Docs/target.md');
    assert.equal(forward.mode, 'needs_review');
    assert.equal(dependent.mode, 'needs_review');
    const old = await service.exports.getWorkspaceOperationReview(dependent.reviewId);
    const savedBytes = (await pg.query<{ preview_json: string; request_json: string }>(
      'SELECT preview_json,request_json FROM workspace_file_operation_reviews WHERE review_id=$1', [dependent.reviewId])).rows[0]!;
    const plan = await buildWorkspaceOperationBatchPlan({ scope,
      actions: [{ reviewId: forward.reviewId, kind: 'move', selections: [{ sourcePath: 'Docs', destinationPath: 'Archive/Docs' }] }] });
    assert.equal(plan.readiness, 'ready');
    await fs.rename(path.join(workspace.rootPath, 'Docs'), path.join(workspace.rootPath, 'Archive/Docs'));
    for (const document of plan.previewContents) await fs.writeFile(path.join(workspace.rootPath, document.path), document.content);
    await pg.query(`UPDATE workspace_file_operation_reviews SET status='applied',updated_at=$2 WHERE review_id=$1`, [forward.reviewId, Date.now()]);
    await service.exports.markDependentWorkspaceOperationReviews({ scope, plan, excludedReviewIds: [forward.reviewId] });
    const changed = await service.exports.getWorkspaceOperationReview(dependent.reviewId);
    assert.equal(changed?.status, 'stale');
    assert.equal(changed?.errorCode, 'DEPENDENCY_CHANGED');
    const refreshInput = { reviewId: dependent.reviewId, planId: old!.planId, source: scope, destination: scope,
      reviewerUserId: 'reviewer', refreshAccess: async () => ({ source: scope, destination: scope }) };
    const refreshed = await service.exports.refreshWorkspaceOperationReview(refreshInput);
    assert.equal(refreshed.previousReviewId, dependent.reviewId);
    assert.notEqual(refreshed.reviewId, dependent.reviewId);
    assert.notEqual(refreshed.planId, old!.planId);
    assert.equal(refreshed.status, 'pending');
    assert.equal(refreshed.selections[0]?.sourcePath, 'Archive/Docs/target.md', 'only a proven applied identity rebinds a moved source');
    assert.equal((await service.exports.getWorkspaceOperationReview(dependent.reviewId))?.successorReviewId, refreshed.reviewId);
    const unchanged = (await pg.query<{ preview_json: string; request_json: string }>(
      'SELECT preview_json,request_json FROM workspace_file_operation_reviews WHERE review_id=$1', [dependent.reviewId])).rows[0]!;
    assert.deepEqual(unchanged, savedBytes, 'refresh never replaces immutable history');
    assert.equal((await service.exports.refreshWorkspaceOperationReview(refreshInput)).reviewId, refreshed.reviewId,
      'repeated refresh follows the same immutable successor');
    const listed = await service.exports.listWorkspaceOperationReviews(workspace.workspaceId);
    assert.ok(listed.some((item) => item.reviewId === refreshed.reviewId));
    assert.ok(listed.every((item) => item.reviewId !== dependent.reviewId), 'old history does not duplicate actionable reviews');
    await assert.rejects(service.exports.acceptWorkspaceOperationReview({
      reviewId: refreshed.reviewId, planId: refreshed.planId, source: scope, destination: scope,
      reviewerUserId: 'reviewer', reviewerDisplayName: 'Reviewer',
      refreshAccess: async () => ({ source: scope, destination: scope }),
    }), { code: 'BATCH_REVIEW_REQUIRED' }, 'legacy delete approval cannot leave incoming links broken or grant unreviewed cleanup');
    assert.equal(await fs.readFile(path.join(workspace.rootPath, 'Archive/Docs/target.md'), 'utf8'), '# Target\n');
    assert.equal(await fs.readFile(path.join(workspace.rootPath, 'index.md'), 'utf8'), '[Target](Archive/Docs/target.md)\n');

    await fs.writeFile(path.join(workspace.rootPath, 'unproven.md'), '# Unproven\n');
    const unproven = await submit('delete', 'unproven.md');
    if (unproven.mode === 'direct') throw new Error('Expected saved review.');
    await fs.rename(path.join(workspace.rootPath, 'unproven.md'), path.join(workspace.rootPath, 'elsewhere.md'));
    const blocked = await service.exports.refreshWorkspaceOperationReview({ ...refreshInput,
      reviewId: unproven.reviewId, planId: unproven.planId });
    assert.equal(blocked.selections[0]?.sourcePath, 'unproven.md');
    assert.equal(blocked.status, 'blocked', 'an unreceipted filesystem move is never guessed from a name or inode scan');
    const multiSources = ['multi-a.md', 'multi-b.md'];
    for (const sourcePath of multiSources) await fs.writeFile(path.join(workspace.rootPath, sourcePath), `# ${sourcePath}\n`);
    for (const kind of ['move', 'delete'] as const) {
      const selections = multiSources.map((sourcePath) => ({ sourcePath,
        ...(kind === 'move' ? { destinationPath: `Archive/${sourcePath}` } : {}) }));
      const proposal = await service.exports.submitAgentWorkspacePathOperation({ kind, source: scope, selections,
        actorUserId: 'reviewer', actorId: 'agent', actorDisplayName: 'Agent' });
      assert.equal(proposal.mode, 'needs_review', `${kind} supports one proposal with several root selections`);
      const saved = await service.exports.getWorkspaceOperationReview(proposal.reviewId);
      assert.equal(saved?.selections.length, 2);
      assert.equal(saved?.status, 'pending');
      const combined = await buildWorkspaceOperationBatchPlan({ scope,
        actions: [{ reviewId: proposal.reviewId, kind, selections }] });
      assert.equal(combined.readiness, 'ready');
      assert.equal(combined.pathSteps.length, 2, 'the shared planner includes every selected root');
      await assert.rejects(service.exports.acceptWorkspaceOperationReview({
        reviewId: proposal.reviewId, planId: proposal.planId, source: scope, destination: scope,
        reviewerUserId: 'reviewer', reviewerDisplayName: 'Reviewer',
        refreshAccess: async () => ({ source: scope, destination: scope }),
      }), { code: 'BATCH_REVIEW_REQUIRED' }, 'legacy acceptance cannot reserve or mutate a multi-root operation');
      const unchangedReview = await service.exports.getWorkspaceOperationReview(proposal.reviewId);
      assert.equal(unchangedReview?.status, 'pending');
      assert.equal(unchangedReview?.operationId, null);
      for (const sourcePath of multiSources) {
        assert.equal(await fs.readFile(path.join(workspace.rootPath, sourcePath), 'utf8'), `# ${sourcePath}\n`);
        await assert.rejects(fs.stat(path.join(workspace.rootPath, 'Archive', sourcePath)), { code: 'ENOENT' });
      }
    }
    console.log('workspace review refresh: dependent stale state, proven source rebase, immutable successor, repeat, unproven move blocked OK');
    console.log('workspace review multi-root: move/delete proposals, complete combined plans, legacy approval rejected without reservation or writes OK');
    const manualInput = { scope: { ...scope, workspace: { ...workspace,
      permissions: { ...workspace.permissions, canRunAgent: false } } },
      userId: 'reviewer', displayName: 'Reviewer' };
    assert.equal(await manual.exports.reviewWorkspaceDeletionIfRequired({ ...manualInput, paths: ['multi-a.md'] }), null,
      'a ready link-free manual deletion keeps its existing direct trash path');
    const linkedManual = await manual.exports.reviewWorkspaceDeletionIfRequired({ ...manualInput, paths: ['Archive/Docs/target.md'] });
    assert.equal(linkedManual?.blocked, false);
    const manualReview = await service.exports.getWorkspaceOperationReview(linkedManual!.reviewRequired.reviewId);
    assert.equal(manualReview?.actor.type, 'user', 'manual cleanup approval does not require agent permission');
    assert.equal(manualReview?.status, 'pending');
    assert.equal(manualReview?.preview.kind, 'delete');
    if (manualReview && 'deletedPaths' in manualReview.preview) assert.equal(manualReview.preview.potentialBrokenLinks.length, 1);
    const cleanupPlan = await buildWorkspaceOperationBatchPlan({ scope,
      actions: [{ reviewId: manualReview!.reviewId, kind: 'delete', selections: manualReview!.selections }] });
    assert.equal(cleanupPlan.readiness, 'ready');
    assert.equal(cleanupPlan.linkEdits.length, 1);
    const refreshedManual = await service.exports.refreshWorkspaceOperationReview({ ...refreshInput,
      reviewId: manualReview!.reviewId, planId: manualReview!.planId,
      source: manualInput.scope, destination: manualInput.scope,
      refreshAccess: async () => ({ source: manualInput.scope, destination: manualInput.scope }) });
    assert.equal(refreshedManual.actor.type, 'user', 'refresh preserves manual authorship and original history');
    assert.ok(refreshedManual.reasonCodes.includes('USER_FILE_OPERATION'));
    assert.equal(await fs.readFile(path.join(workspace.rootPath, 'Archive/Docs/target.md'), 'utf8'), '# Target\n');
    assert.equal(await fs.readFile(path.join(workspace.rootPath, 'index.md'), 'utf8'), '[Target](Archive/Docs/target.md)\n',
      'saving a cleanup review leaves both target and inbound link intact until explicit approval');
    for (const dir of ['First', 'Second']) {
      await fs.mkdir(path.join(workspace.rootPath, dir));
      await fs.writeFile(path.join(workspace.rootPath, dir, 'Ambiguous.md'), '# Ambiguous\n');
    }
    await fs.writeFile(path.join(workspace.rootPath, 'ambiguous-links.md'), '[[Ambiguous]]\n');
    const blockedManual = await manual.exports.reviewWorkspaceDeletionIfRequired({ ...manualInput, paths: ['First/Ambiguous.md'] });
    assert.equal(blockedManual?.blocked, true);
    assert.equal(blockedManual?.reviewRequired.status, 'blocked');
    assert.equal(await fs.readFile(path.join(workspace.rootPath, 'First/Ambiguous.md'), 'utf8'), '# Ambiguous\n');
    console.log('manual deletion: direct link-free trash, persisted user cleanup review, complete shared preview, affected ambiguous link blocked without writes OK');
  } finally {
    await pg.close();
    if (previousData === undefined) delete process.env.DATA; else process.env.DATA = previousData;
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import ts from 'typescript';

import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import type { SqlConnection } from '../app/lib/db';
import type * as Service from '../app/lib/files/workspace-operation-review-service';
import type * as ManualDelete from '../app/lib/files/workspace-operation-delete-review';
import type * as BatchService from '../app/lib/files/workspace-operation-batch-service';
import { WorkspaceOperationBatchStore } from '../app/lib/files/workspace-operation-batch-store';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { buildWorkspaceOperationBatchPlan } from '../app/lib/files/workspace-operation-batch-plan';
import { createWorkspaceOperationBatchExecutor } from '../app/lib/files/workspace-operation-batch-executor';
import { groupWorkspaceLinkWrites } from '../app/lib/markdown/workspace-link-write-groups';

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
    const documentStates = new Map<string, { documentId: string; lifecycleGeneration: number; path: string;
      workspaceId: string; degraded: boolean; serializedHash: string }>();
    const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
    const file = path.resolve('app/lib/files/workspace-operation-review-service.ts');
    const source = ts.transpileModule(await fs.readFile(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const load = createRequire(file);
    const service = { exports: {} as typeof Service };
    new Function('require', 'module', 'exports', source)((name: string) => {
      if (name === 'server-only') return {};
      if (name === '@/app/lib/document-review-availability') return { readDocumentReviewAvailability: () => ({ documentReviewEnabled: true, updatedAt: null }) };
      if (name === '@/app/lib/db') return { openDb: connect };
      if (name === '@/app/lib/files/collaboration-policy') return { ...load(name),
        readFileCollaborationState: async ({ path: filePath }: { path: string }) => ({
          document: documentStates.has(filePath) ? { id: documentStates.get(filePath)!.documentId, status: 'active' } : null,
        }) };
      if (name === '@/app/lib/collaboration/persistence') return { ...load(name),
        loadCollaborationState: async (documentId: string) => [...documentStates.values()].find((state) => state.documentId === documentId) ?? null };
      return load(name);
    }, service, service.exports);
    const batchFile = path.resolve('app/lib/files/workspace-operation-batch-service.ts');
    const batchSource = ts.transpileModule(await fs.readFile(batchFile, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const batchLoad = createRequire(batchFile);
    const batchService = { exports: {} as typeof BatchService };
    new Function('require', 'module', 'exports', batchSource)((name: string) => {
      if (name === 'server-only') return {};
      if (name === '@/app/lib/document-review-availability') return { readDocumentReviewAvailability: () => ({ documentReviewEnabled: true, updatedAt: null }) };
      if (name === '@/app/lib/db') return { openDb: connect };
      if (name === './workspace-operation-review-service') return service.exports;
      if (name === './workspace-operation-batch-store') return { ...batchLoad(name),
        WorkspaceOperationBatchStore: class extends WorkspaceOperationBatchStore { constructor() { super(connect); } } };
      return batchLoad(name);
    }, batchService, batchService.exports);
    const manualFile = path.resolve('app/lib/files/workspace-operation-delete-review.ts');
    const manualSource = ts.transpileModule(await fs.readFile(manualFile, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const manualLoad = createRequire(manualFile);
    const manual = { exports: {} as typeof ManualDelete };
    new Function('require', 'module', 'exports', manualSource)((name: string) => {
      if (name === 'server-only') return {};
      if (name === '@/app/lib/document-review-availability') return { readDocumentReviewAvailability: () => ({ documentReviewEnabled: true, updatedAt: null }) };
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
    const atomicExecutor = createWorkspaceOperationBatchExecutor({
      documentProof: async (_scope, filePath) => documentStates.get(filePath) ?? null,
      rename: async (params) => {
        await fs.mkdir(path.dirname(path.join(workspace.rootPath, params.newPath)), { recursive: true });
        await fs.rename(path.join(workspace.rootPath, params.oldPath), path.join(workspace.rootPath, params.newPath));
        for (const [filePath, state] of [...documentStates]) {
          if (filePath === params.oldPath || filePath.startsWith(`${params.oldPath}/`)) {
            documentStates.delete(filePath); state.path = params.newPath + filePath.slice(params.oldPath.length);
            documentStates.set(state.path, state);
          }
        }
        return { warnings: [], backup: null, mutation: { type: 'rename', operationId: randomUUID(),
          workspaceId: workspace.workspaceId, oldPath: params.oldPath, newPath: params.newPath } };
      },
      preflight: async (input) => ({ planId: input.plan.planId, sources: groupWorkspaceLinkWrites(input.plan).map((group) => ({
        sourceWorkspaceId: workspace.workspaceId, sourcePathBefore: group.sourcePathBefore, beforeSha256: group.beforeSha256,
        documentId: documentStates.get(group.sourcePathBefore)?.documentId ?? null,
        mode: documentStates.has(group.sourcePathBefore) ? 'active-yjs' as const : 'plain-file' as const,
      })) }),
      probeLink: async (_input, group) => {
        const bytes = await fs.readFile(path.join(workspace.rootPath, group.path));
        return hash(bytes) === group.afterSha256 ? 'after' : hash(bytes) === group.beforeSha256 ? 'before' : 'unknown';
      },
      applyLink: async (_input, group) => {
        const temporary = path.join(workspace.rootPath, `${group.path}.${randomUUID()}.checkpoint`);
        await fs.writeFile(temporary, group.afterContent);
        await fs.rename(temporary, path.join(workspace.rootPath, group.path));
        const state = documentStates.get(group.path); if (state) state.serializedHash = group.afterSha256;
        return { workspaceId: workspace.workspaceId, path: group.path, beforeSha256: group.beforeSha256,
          afterSha256: group.afterSha256, status: 'applied', mode: state ? 'active-yjs' : 'plain-file', documentId: state?.documentId ?? null };
      },
      checkpointLink: async () => undefined,
    });
    const propose = async (kind: 'move' | 'delete', sourcePath: string, destinationPath?: string) => {
      const proposed = await submit(kind, sourcePath, destinationPath);
      if (proposed.mode === 'direct') throw new Error('Expected persisted review');
      return proposed;
    };
    const applyRecordedMove = async (sourcePath: string, destinationPath: string) => {
      const proposed = await propose('move', sourcePath, destinationPath);
      const batchPlan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: proposed.reviewId,
        kind: 'move', selections: [{ sourcePath, destinationPath }] }] });
      assert.equal(batchPlan.readiness, 'ready');
      const batchId = randomUUID();
      const outcome = await atomicExecutor.execute({ batchId, plan: batchPlan, scope,
        actorUserId: 'reviewer', actorDisplayName: 'Reviewer' });
      assert.equal(outcome.status, 'applied', outcome.errorCode ?? '');
      await pg.query(`INSERT INTO workspace_file_operation_batches
        (batch_id,plan_id,workspace_id,review_ids_json,review_refs_json,plan_json,status,total_actions,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'[]',$5,'applied',$6,$7,$7)`, [batchId, batchPlan.planId, workspace.workspaceId,
        JSON.stringify([proposed.reviewId]), JSON.stringify(batchPlan), batchPlan.pathSteps.length + batchPlan.previewContents.length, Date.now()]);
      await pg.query(`UPDATE workspace_file_operation_reviews SET status='applied',batch_id=$2,updated_at=$3 WHERE review_id=$1`,
        [proposed.reviewId, batchId, Date.now()]);
      await service.exports.markDependentWorkspaceOperationReviews({ scope, plan: batchPlan, excludedReviewIds: [proposed.reviewId] });
      return { batchId, batchPlan };
    };
    await fs.writeFile(path.join(workspace.rootPath, 'lineage-target.md'), '# Shared target\n');
    await fs.writeFile(path.join(workspace.rootPath, 'lineage-source.md'), '[Shared](lineage-target.md)\n');
    documentStates.set('lineage-source.md', { documentId: 'stable-lineage-document', lifecycleGeneration: 1,
      path: 'lineage-source.md', workspaceId: workspace.workspaceId, degraded: false,
      serializedHash: hash('[Shared](lineage-target.md)\n') });
    const atomicDependent = await propose('delete', 'lineage-source.md');
    const chainDependent = await propose('delete', 'lineage-source.md');
    const substitutedDependent = await propose('delete', 'lineage-source.md');
    const returnDependent = await propose('delete', 'lineage-source.md');
    const identityConflictDependent = await propose('delete', 'lineage-source.md');
    const bulkDependent = await propose('delete', 'lineage-source.md');
    const originalInode = (await fs.stat(path.join(workspace.rootPath, 'lineage-source.md'))).ino;
    await applyRecordedMove('lineage-source.md', 'Lineage/lineage-source.md');
    assert.notEqual((await fs.stat(path.join(workspace.rootPath, 'Lineage/lineage-source.md'))).ino, originalInode,
      'real atomic checkpoint replacement changes the moved inode');
    await fs.writeFile(path.join(workspace.rootPath, 'lineage-source.md'), '# Unrelated new file\n');
    const originalBulk = await pg.query<{ request_json: string; preview_json: string }>(
      'SELECT request_json,preview_json FROM workspace_file_operation_reviews WHERE review_id=$1', [bulkDependent.reviewId]);
    const bulk = await batchService.exports.createWorkspaceOperationBatchReview({ scope, reviewIds: [bulkDependent.reviewId] });
    assert.equal(bulk.status, 'preview');
    assert.equal(bulk.preview.actions[0]?.selections[0]?.sourcePath, 'Lineage/lineage-source.md',
      'direct batch preview uses original identity normalization before considering a reused old path');
    assert.ok(bulk.preview.deletedPaths.every((entry) => entry.path !== 'lineage-source.md'));
    assert.deepEqual((await pg.query<{ request_json: string; preview_json: string }>(
      'SELECT request_json,preview_json FROM workspace_file_operation_reviews WHERE review_id=$1', [bulkDependent.reviewId])).rows,
    originalBulk.rows, 'normalization keeps original individual request/preview immutable');
    const persistedBulk = (await pg.query<{ plan_json: string; review_refs_json: string }>(
      'SELECT plan_json,review_refs_json FROM workspace_file_operation_batches WHERE batch_id=$1', [bulk.batchId])).rows[0]!;
    assert.equal(JSON.parse(persistedBulk.plan_json).actions[0].selections[0].sourcePath, 'Lineage/lineage-source.md',
      'worker receives normalized immutable actions');
    assert.equal(JSON.parse(persistedBulk.review_refs_json)[0].planId, bulkDependent.planId,
      'approval retains exact original review reservation references');
    const atomicRefreshed = await service.exports.refreshWorkspaceOperationReview({ ...refreshInput,
      reviewId: atomicDependent.reviewId, planId: atomicDependent.planId });
    assert.equal(atomicRefreshed.selections[0]?.sourcePath, 'Lineage/lineage-source.md');
    assert.equal(atomicRefreshed.status, 'pending');
    assert.equal(await fs.readFile(path.join(workspace.rootPath, 'lineage-source.md'), 'utf8'), '# Unrelated new file\n',
      'reused original slot is preserved while the original document is selected at its verified destination');
    await fs.unlink(path.join(workspace.rootPath, 'lineage-source.md'));
    await applyRecordedMove('Lineage/lineage-source.md', 'LineageFinal/lineage-source.md');
    const chained = await service.exports.refreshWorkspaceOperationReview({ ...refreshInput,
      reviewId: chainDependent.reviewId, planId: chainDependent.planId });
    assert.equal(chained.selections[0]?.sourcePath, 'LineageFinal/lineage-source.md');
    assert.equal(chained.status, 'pending', 'two acknowledged moves preserve exact finalized lineage');
    const originalState = documentStates.get('LineageFinal/lineage-source.md')!;
    documentStates.set(originalState.path, { ...originalState, documentId: 'substituted-document' });
    const substituted = await service.exports.refreshWorkspaceOperationReview({ ...refreshInput,
      reviewId: substitutedDependent.reviewId, planId: substitutedDependent.planId });
    assert.equal(substituted.selections[0]?.sourcePath, 'lineage-source.md');
    assert.equal(substituted.status, 'blocked', 'same path and bytes never replace the acknowledged collaboration document identity');
    await fs.writeFile(path.join(workspace.rootPath, 'lineage-source.md'), '# Unrelated source slot\n');
    await assert.rejects(service.exports.refreshWorkspaceOperationReview({ ...refreshInput,
      reviewId: identityConflictDependent.reviewId, planId: identityConflictDependent.planId }),
    { status: 409, code: 'REVIEW_SOURCE_IDENTITY_CONFLICT' },
    'unproven original lineage never produces a ready deletion of a reused source slot');
    assert.equal((await service.exports.getWorkspaceOperationReview(identityConflictDependent.reviewId))?.successorReviewId, null);
    await assert.rejects(batchService.exports.createWorkspaceOperationBatchReview({ scope, reviewIds: [identityConflictDependent.reviewId] }),
    { status: 409, code: 'REVIEW_SOURCE_IDENTITY_CONFLICT' }, 'combined preview cannot bypass an unproven source conflict');
    assert.equal(await fs.readFile(path.join(workspace.rootPath, 'lineage-source.md'), 'utf8'), '# Unrelated source slot\n');
    await fs.unlink(path.join(workspace.rootPath, 'lineage-source.md'));
    documentStates.set(originalState.path, originalState);
    await applyRecordedMove('LineageFinal/lineage-source.md', 'lineage-source.md');
    const returned = await service.exports.refreshWorkspaceOperationReview({ ...refreshInput,
      reviewId: returnDependent.reviewId, planId: returnDependent.planId });
    assert.equal(returned.selections[0]?.sourcePath, 'lineage-source.md');
    assert.equal(returned.status, 'pending', 'a chain returning to the original path is verified using the finalized endpoint, not the initial seed');
    const unsafePathDependent = await propose('delete', 'lineage-source.md');
    await applyRecordedMove('lineage-source.md', 'LineageOther/lineage-source.md');
    const endpoint = path.join(workspace.rootPath, 'LineageOther/lineage-source.md');
    await fs.writeFile(`${endpoint}.replacement`, await fs.readFile(endpoint)); await fs.rename(`${endpoint}.replacement`, endpoint);
    const unsafePath = await service.exports.refreshWorkspaceOperationReview({ ...refreshInput,
      reviewId: unsafePathDependent.reviewId, planId: unsafePathDependent.planId });
    assert.equal(unsafePath.selections[0]?.sourcePath, 'lineage-source.md');
    assert.equal(unsafePath.status, 'blocked', 'same-byte filesystem substitution must retain the old blocked source');
    await fs.writeFile(path.join(workspace.rootPath, 'ordinary-edit.md'), '# Before edit\n');
    const ordinary = await propose('delete', 'ordinary-edit.md');
    await fs.writeFile(path.join(workspace.rootPath, 'ordinary-edit.md.checkpoint'), '# User edited\n');
    await fs.rename(path.join(workspace.rootPath, 'ordinary-edit.md.checkpoint'), path.join(workspace.rootPath, 'ordinary-edit.md'));
    const edited = await service.exports.refreshWorkspaceOperationReview({ ...refreshInput,
      reviewId: ordinary.reviewId, planId: ordinary.planId });
    assert.equal(edited.selections[0]?.sourcePath, 'ordinary-edit.md');
    assert.equal(edited.status, 'pending', 'ordinary same-path edits remain refreshable without an acknowledged move away');
    console.log('refresh lineage: actual durable manifests, atomic checkpoints, consecutive moves, document substitution and same-byte inode substitution OK');
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

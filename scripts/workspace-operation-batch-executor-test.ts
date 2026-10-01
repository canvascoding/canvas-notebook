import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AsyncResource } from 'node:async_hooks';

import { buildWorkspaceOperationBatchPlan } from '../app/lib/files/workspace-operation-batch-plan';
import { createWorkspaceOperationBatchExecutor } from '../app/lib/files/workspace-operation-batch-executor';
import { groupWorkspaceLinkWrites } from '../app/lib/markdown/workspace-link-write-groups';
import { withWorkspaceMutationLock } from '../app/lib/files/workspace-mutation-lock';
import type { WorkspaceOperationBatchAction, WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import type { WorkspaceTrashEntry } from '../app/lib/filesystem/workspace-trash';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-batch-executor-'));
  const previousData = process.env.DATA;
  const previousRoot = process.env.CANVAS_DATA_ROOT;
  process.env.DATA = dataRoot; process.env.CANVAS_DATA_ROOT = dataRoot;
  try {
    const entries = new Map<string, WorkspaceTrashEntry>();
    const events: string[] = [];
    let archiveFailures = 0;
    let projectionDelay = 0;
    let checkpointFailures = 0;
    const authoritative = new Map<string, string>();
    const projectorContext = new AsyncResource('independent-batch-projector');
    const queuedProjections: Promise<unknown>[] = [];
    const workspace: WorkspaceContext = { workspaceId: 'batch-tests', workspaceType: 'personal', rootPath: path.join(dataRoot, 'workspace'),
      rootRelativePath: 'workspace', actor: { userId: 'tester', role: 'owner' }, ownerUserId: 'tester', organizationId: null,
      legacy: false, status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
        canCreatePublicLinks: false, canManageWorkspace: true } };
    const scope: WorkspaceOperationBatchScope = { workspace, fileOptions: { workspace } };
    const absolute = (relative: string) => path.join(workspace.rootPath, relative);
    const write = async (relative: string, content: string) => {
      await fs.mkdir(path.dirname(absolute(relative)), { recursive: true }); await fs.writeFile(absolute(relative), content);
    };
    const makeExecutor = () => createWorkspaceOperationBatchExecutor({
      documentProof: async () => null,
      storageRoot: path.join(dataRoot, 'manifests'),
      rename: async (params) => {
        await assert.rejects(fs.stat(absolute(params.newPath)), { code: 'ENOENT' });
        await fs.mkdir(path.dirname(absolute(params.newPath)), { recursive: true });
        await fs.rename(absolute(params.oldPath), absolute(params.newPath)); events.push(`move:${params.oldPath}`);
        return { warnings: [], backup: null, mutation: { type: 'rename', operationId: randomUUID(), workspaceId: workspace.workspaceId,
          oldPath: params.oldPath, newPath: params.newPath } };
      },
      trash: async (params) => {
        const source = params.paths[0]; const id = `trash-${randomUUID()}`; const trashRelativePath = `.trash/${id}`;
        await fs.mkdir(path.join(dataRoot, '.trash'), { recursive: true }); await fs.rename(absolute(source), path.join(dataRoot, trashRelativePath));
        const entry: WorkspaceTrashEntry = { id, organizationId: null, workspaceId: workspace.workspaceId, workspaceType: 'personal',
          ownerUserId: 'tester', originalPath: source, trashRelativePath, entryName: path.basename(source), itemType: 'file',
          sizeBytes: 1, fileCount: 1, directoryCount: 0, status: 'trashed', deletedByUserId: 'tester', restoredByUserId: null,
          purgedByUserId: null, deletedAt: new Date(), expiresAt: new Date(Date.now() + 86400_000), restoredAt: null, purgedAt: null, metadataJson: null };
        entries.set(id, entry); events.push(`trash:${source}`); return { trashed: [entry], failed: [] };
      },
      listTrash: async (params) => [...entries.values()].filter((entry) => entry.status === (params.status ?? 'trashed')).slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 100)),
      restoreTrash: async (params) => {
        const entry = entries.get(params.entryId)!; assert.equal(entry.status, 'trashed');
        await assert.rejects(fs.stat(absolute(entry.originalPath)), { code: 'ENOENT' });
        await fs.mkdir(path.dirname(absolute(entry.originalPath)), { recursive: true });
        await fs.rename(path.join(dataRoot, entry.trashRelativePath), absolute(entry.originalPath));
        entry.status = 'restored'; events.push(`restore:${entry.originalPath}`); return entry;
      },
      archive: async () => { if (archiveFailures-- > 0) throw new Error('ARCHIVE_TRANSPORT_FAILED'); events.push('archive'); },
      restoreCollaboration: async () => { events.push('restore-collaboration'); },
      sharesDeleted: async () => { events.push('shares-delete'); },
      preflight: async (input) => ({ planId: input.plan.planId, sources: await Promise.all(groupWorkspaceLinkWrites(input.plan).map(async (group) => {
        assert.equal(sha(await fs.readFile(absolute(group.sourcePathBefore))), group.beforeSha256);
        return { sourceWorkspaceId: workspace.workspaceId, sourcePathBefore: group.sourcePathBefore,
          beforeSha256: group.beforeSha256, documentId: null, mode: 'plain-file' as const };
      })) }),
      probeLink: async (_input, group) => {
        try {
          const content = authoritative.get(group.path) ?? await fs.readFile(absolute(group.path), 'utf8');
          return sha(content) === group.afterSha256 ? 'after' : sha(content) === group.beforeSha256 ? 'before' : 'unknown';
        } catch { return 'unknown'; }
      },
      applyLink: async (_input, group) => {
        const content = authoritative.get(group.path) ?? await fs.readFile(absolute(group.path), 'utf8');
        assert.equal(sha(content), group.beforeSha256);
        events.push(`link:${group.path}`);
        if (projectionDelay) {
          authoritative.set(group.path, group.afterContent);
          if (projectionDelay < 0) {
            queuedProjections.push(projectorContext.runInAsyncScope(() => withWorkspaceMutationLock(workspace.workspaceId, async () => {
              if (authoritative.get(group.path) !== group.afterContent) return;
              await fs.writeFile(absolute(group.path), group.afterContent); authoritative.delete(group.path);
            })));
          } else setTimeout(() => void fs.writeFile(absolute(group.path), group.afterContent).then(() => authoritative.delete(group.path)), projectionDelay);
        } else await fs.writeFile(absolute(group.path), group.afterContent);
        return { workspaceId: workspace.workspaceId, path: group.path, beforeSha256: group.beforeSha256, afterSha256: group.afterSha256,
          status: 'applied', mode: 'plain-file', documentId: null };
      },
      checkpointLink: async (_input, group) => {
        if (projectionDelay >= 0 || !authoritative.has(group.path)) return;
        if (checkpointFailures-- > 0) throw new Error('CHECKPOINT_TRANSPORT_FAILED');
        await withWorkspaceMutationLock(workspace.workspaceId, async () => {
          assert.equal(sha(authoritative.get(group.path)!), group.afterSha256);
          await fs.writeFile(absolute(group.path), group.afterContent); authoritative.delete(group.path); events.push(`checkpoint:${group.path}`);
        });
      },
    });
    const actions: WorkspaceOperationBatchAction[] = [
      { reviewId: 'delete', kind: 'delete', selections: [{ sourcePath: 'old.md' }] },
      { reviewId: 'move', kind: 'move', selections: [{ sourcePath: 'notes/a.md', destinationPath: 'channels/a.md' }] },
    ];
    const baseline = { 'old.md': '# Old', 'notes/a.md': '[Old](../old.md)', 'Home.md': '[A](notes/a.md) [Old](old.md)' };
    for (const [filename, content] of Object.entries(baseline)) await write(filename, content);
    const plan = await buildWorkspaceOperationBatchPlan({ scope, actions });
    assert.equal(plan.readiness, 'ready');
    const batchId = randomUUID();
    projectionDelay = -1;
    const started = Date.now();
    const outcome = await makeExecutor().execute({ batchId, plan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(outcome.status, 'applied', outcome.errorCode ?? '');
    assert.ok(Date.now() - started < 5_000, 'Reentrant checkpoint completes while the independent projector waits for our lock');
    assert.equal(events.filter((event) => event.startsWith('checkpoint:')).length, 2);
    await Promise.all(queuedProjections.splice(0));
    assert.equal(await fs.readFile(absolute('Home.md'), 'utf8'), '[A](channels/a.md) Old');
    assert.equal(await fs.readFile(absolute('channels/a.md'), 'utf8'), 'Old');
    assert.equal(outcome.completedActions, outcome.totalActions);
    assert.equal(outcome.trashEntryIds.length, 1);
    assert.equal(await makeExecutor().has(batchId, workspace.workspaceId), true);
    const eventCount = events.length;
    assert.equal((await makeExecutor().execute({ batchId, plan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' })).status, 'applied');
    assert.equal(events.length, eventCount, 'Restart/repeat acceptance never replays completed steps');
    await write('New.md', '[New backlink](channels/a.md)');
    await assert.rejects(makeExecutor().assertUndoAvailable({ batchId, scope }), { code: 'BATCH_UNDO_NEW_BACKLINK' });
    assert.equal(events.length, eventCount, 'New backlinks block Undo without touching links or paths');
    await fs.unlink(absolute('New.md'));
    await write('notes/a.md', '# User-created file');
    await assert.rejects(makeExecutor().assertUndoAvailable({ batchId, scope }), { code: 'BATCH_UNDO_DESTINATION_OCCUPIED' });
    assert.equal(events.length, eventCount, 'Occupied original slot blocks before backlink mutation');
    await fs.unlink(absolute('notes/a.md'));
    await makeExecutor().assertUndoAvailable({ batchId, scope });
    const undone = await makeExecutor().undo({ batchId, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(undone.status, 'applied', undone.errorCode ?? '');
    await Promise.all(queuedProjections.splice(0));
    for (const [filename, content] of Object.entries(baseline)) assert.equal(await fs.readFile(absolute(filename), 'utf8'), content);
    await assert.rejects(fs.stat(absolute('channels/a.md')), { code: 'ENOENT' });
    assert.equal((await makeExecutor().undo({ batchId, scope, actorUserId: 'tester', actorDisplayName: 'Tester' })).status, 'applied');

    await write('checkpoint-target.md', '# Target'); await write('checkpoint-home.md', '[Target](checkpoint-target.md)');
    const checkpointPlan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: 'checkpoint', kind: 'delete', selections: [{ sourcePath: 'checkpoint-target.md' }] }] });
    const checkpointId = randomUUID(); checkpointFailures = 1;
    const checkpointPending = await makeExecutor().execute({ batchId: checkpointId, plan: checkpointPlan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(checkpointPending.status, 'needs_recovery');
    const committedLinks = events.filter((event) => event === 'link:checkpoint-home.md').length;
    const checkpointResumed = await makeExecutor().execute({ batchId: checkpointId, plan: checkpointPlan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(checkpointResumed.status, 'applied', checkpointResumed.errorCode ?? '');
    assert.equal(events.filter((event) => event === 'link:checkpoint-home.md').length, committedLinks, 'Checkpoint retry never replays an acknowledged Yjs edit');
    await Promise.all(queuedProjections.splice(0));
    assert.equal(await fs.readFile(absolute('checkpoint-home.md'), 'utf8'), 'Target');

    projectionDelay = 0;
    await write('delete-again.md', '# Delete');
    const deleteAction: WorkspaceOperationBatchAction = { reviewId: 'delete-again', kind: 'delete', selections: [{ sourcePath: 'delete-again.md' }] };
    const deletePlan = await buildWorkspaceOperationBatchPlan({ scope, actions: [deleteAction] });
    archiveFailures = 1;
    const recoveryId = randomUUID();
    const recovering = await makeExecutor().execute({ batchId: recoveryId, plan: deletePlan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(recovering.status, 'needs_recovery');
    const trashCount = events.filter((event) => event === 'trash:delete-again.md').length;
    const recovered = await makeExecutor().execute({ batchId: recoveryId, plan: deletePlan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(recovered.status, 'applied', recovered.errorCode ?? '');
    assert.equal(events.filter((event) => event === 'trash:delete-again.md').length, trashCount, 'Receipted trash resumes projections without replay');

    await write('stale.md', '# Before');
    const stalePlan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: 'stale', kind: 'move', selections: [{ sourcePath: 'stale.md', destinationPath: 'stale-moved.md' }] }] });
    await write('stale.md', '# User changed');
    const stale = await makeExecutor().execute({ batchId: randomUUID(), plan: stalePlan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(stale.status, 'failed'); assert.equal(stale.errorCode, 'BATCH_PLAN_STALE');
    assert.equal(await fs.readFile(absolute('stale.md'), 'utf8'), '# User changed');
    await assert.rejects(fs.stat(absolute('stale-moved.md')), { code: 'ENOENT' });

    await write('pause-a.txt', 'A'); await write('pause-b.txt', 'B');
    const pausePlan = await buildWorkspaceOperationBatchPlan({ scope, actions: [
      { reviewId: 'a', kind: 'move', selections: [{ sourcePath: 'pause-a.txt', destinationPath: 'moved-a.txt' }] },
      { reviewId: 'b', kind: 'move', selections: [{ sourcePath: 'pause-b.txt', destinationPath: 'moved-b.txt' }] },
    ] });
    const pauseId = randomUUID();
    const paused = await makeExecutor().execute({ batchId: pauseId, plan: pausePlan, scope, actorUserId: 'tester', actorDisplayName: 'Tester',
      onProgress: (progress) => { if (progress.completedActions === 1) throw new Error('ACCESS_REVOKED'); } });
    assert.equal(paused.status, 'needs_recovery');
    assert.equal(await fs.readFile(absolute('moved-a.txt'), 'utf8'), 'A');
    assert.equal(await fs.readFile(absolute('pause-b.txt'), 'utf8'), 'B');
    assert.equal((await makeExecutor().execute({ batchId: pauseId, plan: pausePlan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' })).status, 'applied');

    await write('resume-shared.md', '# Shared'); await write('resume-a.md', '[Shared](resume-shared.md)');
    await write('resume-home.md', '[A](resume-a.md)');
    const resumePlan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: 'resume', kind: 'move',
      selections: [{ sourcePath: 'resume-a.md', destinationPath: 'deep/resume-a.md' }] }] });
    const resumeId = randomUUID();
    assert.equal((await makeExecutor().execute({ batchId: resumeId, plan: resumePlan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' })).status, 'applied');
    const undoPaused = await makeExecutor().undo({ batchId: resumeId, scope, actorUserId: 'tester', actorDisplayName: 'Tester',
      onProgress: async () => { if (await fs.stat(absolute('resume-a.md')).then(() => true, () => false)) throw new Error('UNDO_WORKER_INTERRUPTED'); } });
    assert.equal(undoPaused.status, 'needs_recovery');
    const resumedUndo = await makeExecutor().undo({ batchId: resumeId, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(resumedUndo.status, 'applied', resumedUndo.errorCode ?? '');
    assert.equal(await fs.readFile(absolute('resume-a.md'), 'utf8'), '[Shared](resume-shared.md)');
    assert.equal(await fs.readFile(absolute('resume-home.md'), 'utf8'), '[A](resume-a.md)');

    await write('empty-target.md', '# Empty target'); await write('empty-home.md', '[](empty-target.md)');
    const emptyPlan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: 'empty', kind: 'delete', selections: [{ sourcePath: 'empty-target.md' }] }] });
    const emptyId = randomUUID();
    assert.equal((await makeExecutor().execute({ batchId: emptyId, plan: emptyPlan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' })).status, 'applied');
    assert.equal(await fs.readFile(absolute('empty-home.md'), 'utf8'), '');
    assert.equal((await makeExecutor().undo({ batchId: emptyId, scope, actorUserId: 'another-authorized-reviewer', actorDisplayName: 'Reviewer' })).status, 'applied');
    assert.equal(await fs.readFile(absolute('empty-home.md'), 'utf8'), '[](empty-target.md)');
    console.log('workspace-operation-batch-executor-test: real backups/files, checkpoint, no replay, recoverable trash, access gate, stale, conflict-safe Undo, resumed Undo and empty document passed');
  } finally {
    if (previousData === undefined) delete process.env.DATA; else process.env.DATA = previousData;
    if (previousRoot === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = previousRoot;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

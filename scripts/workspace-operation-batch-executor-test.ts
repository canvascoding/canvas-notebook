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
    const makeExecutor = (overrides: Parameters<typeof createWorkspaceOperationBatchExecutor>[0] = {}) => createWorkspaceOperationBatchExecutor({
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
      ...overrides,
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
    assert.equal(stale.status, 'needs_review'); assert.equal(stale.errorCode, 'BATCH_PLAN_STALE');
    assert.equal(await fs.readFile(absolute('stale.md'), 'utf8'), '# User changed');
    await assert.rejects(fs.stat(absolute('stale-moved.md')), { code: 'ENOENT' });

    await write('peer-source.md', '# Source'); await write('peer-home.md', '[Source](peer-source.md)');
    const peerPlan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: 'peer', kind: 'move',
      selections: [{ sourcePath: 'peer-source.md', destinationPath: 'peer-moved.md' }] }] });
    const peerId = randomUUID();
    const initialPeer = await makeExecutor().execute({ batchId: peerId, plan: peerPlan, scope,
      actorUserId: 'tester', actorDisplayName: 'Tester', onProgress: (progress) => {
        if (progress.phase === 'preparing') throw new Error('WORKER_INTERRUPTED');
      } });
    assert.equal(initialPeer.status, 'failed');
    assert.equal(await makeExecutor().mutationEvidence(peerId, workspace.workspaceId), 'pristine');
    await write('peer-home.md', '[Source](peer-source.md)\nPeer prose remains exact.');
    const peerRetry = await makeExecutor().execute({ batchId: peerId, plan: peerPlan, scope,
      actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(peerRetry.status, 'needs_review');
    assert.equal(await fs.readFile(absolute('peer-home.md'), 'utf8'), '[Source](peer-source.md)\nPeer prose remains exact.');
    await assert.rejects(fs.stat(absolute('peer-moved.md')), { code: 'ENOENT' });
    const typedConflict = await makeExecutor({ preflight: async () => {
      throw Object.assign(new Error('Private live document content differs.'), { code: 'LINK_WRITE_STALE' });
    } }).execute({ batchId: randomUUID(), plan: peerPlan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    // The changed graph is rejected first, before the injected preflight.
    assert.equal(typedConflict.status, 'needs_review');
    const freshPeer = await buildWorkspaceOperationBatchPlan({ scope, actions: peerPlan.actions });
    const typedPreflight = await makeExecutor({ preflight: async () => {
      throw Object.assign(new Error('Private live document content differs.'), { code: 'LINK_WRITE_STALE' });
    } }).execute({ batchId: randomUUID(), plan: freshPeer, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(typedPreflight.status, 'needs_review'); assert.equal(typedPreflight.errorCode, 'LINK_WRITE_STALE');

    const pristineId = randomUUID();
    const pristine = await makeExecutor().execute({ batchId: pristineId, plan: freshPeer, scope,
      actorUserId: 'tester', actorDisplayName: 'Tester', onProgress: (progress) => {
        if (progress.phase === 'paths') throw Object.assign(new Error('Peer changed the document.'), { code: 'LINK_WRITE_STALE' });
      } });
    assert.equal(pristine.status, 'needs_review');
    assert.equal(await makeExecutor().mutationEvidence(pristineId, workspace.workspaceId), 'pristine');

    const intentId = randomUUID();
    const intent = await makeExecutor({ rename: async (params) => {
      await fs.rename(absolute(params.oldPath), absolute(params.newPath));
      throw Object.assign(new Error('The process died before acknowledging the physical move.'), { code: 'LINK_WRITE_STALE' });
    } }).execute({ batchId: intentId, plan: freshPeer, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(intent.status, 'needs_recovery'); assert.equal(intent.completedActions, 0);
    assert.equal(intent.stepResults?.[0]?.state, 'intent'); assert.equal(intent.errorCode, 'LINK_WRITE_STALE');
    assert.equal(await makeExecutor().mutationEvidence(intentId, workspace.workspaceId), 'started');
    const intentRetry = await makeExecutor().execute({ batchId: intentId, plan: freshPeer, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(intentRetry.status, 'needs_recovery', 'unacknowledged physical mutation never becomes a new preview');
    assert.equal(await fs.readFile(absolute('peer-moved.md'), 'utf8'), '# Source');
    const invalidUndo = await makeExecutor().undo({ batchId: intentId, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(invalidUndo.status, 'needs_recovery', 'Undo cannot promote an incomplete forward receipt to applied');
    assert.equal((await makeExecutor().get({ batchId: intentId, scope }))!.status, 'needs_recovery');
    await fs.writeFile(path.join(dataRoot, 'manifests', `${intentId}.json`), '{corrupt');
    await assert.rejects(makeExecutor().mutationEvidence(intentId, workspace.workspaceId));
    await fs.unlink(path.join(dataRoot, 'manifests', `${intentId}.json`));
    assert.equal(await makeExecutor().mutationEvidence(intentId, workspace.workspaceId), 'absent');

    await write('undo-protected.txt', 'Original');
    const protectedPlan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: 'protected-undo', kind: 'move',
      selections: [{ sourcePath: 'undo-protected.txt', destinationPath: 'undo-protected-moved.txt' }] }] });
    const protectedId = randomUUID();
    assert.equal((await makeExecutor().execute({ batchId: protectedId, plan: protectedPlan, scope,
      actorUserId: 'tester', actorDisplayName: 'Tester' })).status, 'applied');
    await write('undo-protected-moved.txt', 'Peer edit must survive');
    const refusedUndo = await makeExecutor().undo({ batchId: protectedId, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(refusedUndo.status, 'failed'); assert.equal(refusedUndo.errorCode, 'BATCH_UNDO_PATH_CHANGED');
    assert.equal((await makeExecutor().get({ batchId: protectedId, scope }))!.status, 'applied');
    assert.equal(await makeExecutor().mutationEvidence(protectedId, workspace.workspaceId, true), 'pristine');
    assert.equal(await fs.readFile(absolute('undo-protected-moved.txt'), 'utf8'), 'Peer edit must survive');
    await assert.rejects(fs.stat(absolute('undo-protected.txt')), { code: 'ENOENT' });

    await write('boundary-source.txt', 'Source stays untouched');
    const boundaryPlan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: 'path-boundary', kind: 'move',
      selections: [{ sourcePath: 'boundary-source.txt', destinationPath: 'boundary-destination.txt' }] }] });
    let boundaryReads = 0;
    const boundary = await makeExecutor({ rebuild: async (input) => {
      const current = await buildWorkspaceOperationBatchPlan(input);
      if (++boundaryReads === 2) await write('boundary-destination.txt', 'Concurrent destination survives');
      return current;
    } }).execute({ batchId: randomUUID(), plan: boundaryPlan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(boundary.status, 'needs_review'); assert.equal(boundary.errorCode, 'BATCH_UNPROVEN_PATH_INTENT');
    assert.equal(boundary.completedActions, 0); assert.deepEqual(boundary.stepResults, []);
    assert.equal(await fs.readFile(absolute('boundary-source.txt'), 'utf8'), 'Source stays untouched');
    assert.equal(await fs.readFile(absolute('boundary-destination.txt'), 'utf8'), 'Concurrent destination survives');

    await write('checkpoint-boundary-source.md', '# Checkpoint');
    await write('checkpoint-boundary-home.md', '[Checkpoint](checkpoint-boundary-source.md)');
    const checkpointBoundaryPlan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: 'checkpoint-boundary', kind: 'move',
      selections: [{ sourcePath: 'checkpoint-boundary-source.md', destinationPath: 'checkpoint-boundary-moved.md' }] }] });
    const beforeCheckpointIntent = await makeExecutor({ preflight: async () => {
      throw new Error('BATCH_CHECKPOINT_STATE_CHANGED');
    } }).execute({ batchId: randomUUID(), plan: checkpointBoundaryPlan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(beforeCheckpointIntent.status, 'needs_review'); assert.equal(beforeCheckpointIntent.errorCode, 'BATCH_CHECKPOINT_STATE_CHANGED');
    assert.equal(await fs.readFile(absolute('checkpoint-boundary-home.md'), 'utf8'), '[Checkpoint](checkpoint-boundary-source.md)');
    await assert.rejects(fs.stat(absolute('checkpoint-boundary-moved.md')), { code: 'ENOENT' });
    const afterCheckpointIntent = await makeExecutor({ checkpointLink: async () => {
      throw new Error('BATCH_CHECKPOINT_STATE_CHANGED');
    } }).execute({ batchId: randomUUID(), plan: checkpointBoundaryPlan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(afterCheckpointIntent.status, 'needs_recovery'); assert.equal(afterCheckpointIntent.errorCode, 'BATCH_CHECKPOINT_STATE_CHANGED');
    assert.ok(afterCheckpointIntent.stepResults?.some((step) => step.state === 'applied'));
    assert.equal(await fs.readFile(absolute('checkpoint-boundary-moved.md'), 'utf8'), '# Checkpoint');

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
    await write('repair-old/A.md', '# Repaired document');
    await write('repair-home.md', '[[repair-new/A|Visible label]]');
    const repairPlan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: 'exact-repair', kind: 'move',
      selections: [{ sourcePath: 'repair-old', destinationPath: 'repair-new' }] }] });
    assert.equal(repairPlan.readiness, 'ready', JSON.stringify(repairPlan.issues));
    assert.equal(repairPlan.linkAssessment.restoredLinks?.length, 1);
    const repairId = randomUUID();
    assert.equal((await makeExecutor().execute({ batchId: repairId, plan: repairPlan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' })).status, 'applied');
    await write('repair-new-backlink.md', '[Later](repair-new/A.md)');
    await assert.rejects(makeExecutor().assertUndoAvailable({ batchId: repairId, scope }), { code: 'BATCH_UNDO_NEW_BACKLINK' });
    await fs.unlink(absolute('repair-new-backlink.md'));
    await makeExecutor().assertUndoAvailable({ batchId: repairId, scope });
    assert.equal((await makeExecutor().undo({ batchId: repairId, scope, actorUserId: 'tester', actorDisplayName: 'Tester' })).status, 'applied');
    assert.equal(await fs.readFile(absolute('repair-home.md'), 'utf8'), '[[repair-new/A|Visible label]]', 'Undo restores the originally missing path without guessing a target');
    const repairAgain = await buildWorkspaceOperationBatchPlan({ scope, actions: repairPlan.actions });
    const repairAgainId = randomUUID();
    assert.equal((await makeExecutor().execute({ batchId: repairAgainId, plan: repairAgain, scope, actorUserId: 'tester', actorDisplayName: 'Tester' })).status, 'applied');
    await write('repair-home.md', '[[repair-new/A|Visible label]] [Later](repair-new/A.md)');
    await assert.rejects(makeExecutor().assertUndoAvailable({ batchId: repairAgainId, scope }), { code: 'BATCH_UNDO_LINK_CHANGED' });

    await write('mapped-target/A.md', '# Mapped target');
    await write('repair-source.md', '[[repaired-target/A|Repair moved source]]');
    const movedRepair = await buildWorkspaceOperationBatchPlan({ scope, actions: [
      { reviewId: 'mapped-target', kind: 'move', selections: [{ sourcePath: 'mapped-target', destinationPath: 'repaired-target' }] },
      { reviewId: 'repair-source', kind: 'move', selections: [{ sourcePath: 'repair-source.md', destinationPath: 'moved-repair-source.md' }] },
    ] });
    assert.equal(movedRepair.readiness, 'ready', JSON.stringify(movedRepair.issues));
    const movedRepairId = randomUUID();
    const movedRepairResult = await makeExecutor().execute({ batchId: movedRepairId, plan: movedRepair, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(movedRepairResult.status, 'applied', movedRepairResult.errorCode ?? '');
    await write('Other/repaired-target/A.md', '# Later suffix candidate');
    await assert.rejects(makeExecutor().assertUndoAvailable({ batchId: movedRepairId, scope }), { code: 'BATCH_UNDO_NEW_BACKLINK' });
    await fs.unlink(absolute('Other/repaired-target/A.md'));
    await makeExecutor().assertUndoAvailable({ batchId: movedRepairId, scope });
    const movedRepairUndo = await makeExecutor().undo({ batchId: movedRepairId, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(movedRepairUndo.status, 'applied', movedRepairUndo.errorCode ?? '');
    assert.equal(await fs.readFile(absolute('repair-source.md'), 'utf8'), '[[repaired-target/A|Repair moved source]]');

    await write('missing-old/Plan.md', '[Missing](missing.md) [[The First 100 Collection]]');
    await write('missing-home.md', '[Missing](missing-old/absent.md)');
    const missingPlan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: 'missing-intent', kind: 'move',
      selections: [{ sourcePath: 'missing-old', destinationPath: 'missing-new' }] }] });
    assert.equal(missingPlan.readiness, 'ready', JSON.stringify(missingPlan.issues));
    const missingId = randomUUID();
    const missingResult = await makeExecutor().execute({ batchId: missingId, plan: missingPlan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
    assert.equal(missingResult.status, 'applied', missingResult.errorCode ?? '');
    assert.equal(await fs.readFile(absolute('missing-home.md'), 'utf8'), '[Missing](missing-new/absent.md)');
    assert.equal((await makeExecutor().undo({ batchId: missingId, scope, actorUserId: 'tester', actorDisplayName: 'Tester' })).status, 'applied');
    assert.equal(await fs.readFile(absolute('missing-home.md'), 'utf8'), '[Missing](missing-old/absent.md)');

    await write('delete-missing/Present.md', '# Present');
    await write('delete-missing-home.md', '[Gone](delete-missing/absent.md) [[delete-missing/ghost|Ghost]]');
    const missingDelete = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: 'delete-absent', kind: 'delete', selections: [{ sourcePath: 'delete-missing' }] }] });
    const missingDeleteId = randomUUID();
    assert.equal((await makeExecutor().execute({ batchId: missingDeleteId, plan: missingDelete, scope, actorUserId: 'tester', actorDisplayName: 'Tester' })).status, 'applied');
    assert.equal(await fs.readFile(absolute('delete-missing-home.md'), 'utf8'), 'Gone Ghost');
    assert.equal((await makeExecutor().undo({ batchId: missingDeleteId, scope, actorUserId: 'tester', actorDisplayName: 'Tester' })).status, 'applied');
    assert.equal(await fs.readFile(absolute('delete-missing-home.md'), 'utf8'), '[Gone](delete-missing/absent.md) [[delete-missing/ghost|Ghost]]');
    console.log('workspace-operation-batch-executor-test: real backups/files, checkpoint, no replay, recoverable trash, access gate, stale, conflict-safe Undo, resumed Undo and empty document passed');
  } finally {
    if (previousData === undefined) delete process.env.DATA; else process.env.DATA = previousData;
    if (previousRoot === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = previousRoot;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

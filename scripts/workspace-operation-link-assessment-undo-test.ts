import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';

import { captureWorkspaceOperationBackup } from '../app/lib/files/workspace-operation-backup';
import { operationLinkStepKey } from '../app/lib/files/workspace-operation-undo';
import type { WorkspaceOperationWithSteps } from '../app/lib/files/workspace-operation-journal';
import type * as UndoService from '../app/lib/files/workspace-operation-undo-service';
import { assertFreshWorkspaceFileOperationPlan, buildWorkspaceFileOperationPreview as buildFilePreview, buildWorkspacePlannerSnapshot } from '../app/lib/markdown/workspace-file-operation-preview';
import { groupWorkspaceLinkWrites } from '../app/lib/markdown/workspace-link-write-groups';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const buildWorkspaceFileOperationPreview = (input: Parameters<typeof buildFilePreview>[0]) =>
  buildFilePreview(input, { buildSnapshot: buildWorkspacePlannerSnapshot });

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const originalOperationId = 'assessment_undo_original';

/** Real filesystem snapshots, backup, inverse planning, and inverse link guards; journal transport is in memory. */
async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-assessment-undo-'));
  const previousData = process.env.DATA;
  const previousCanvasRoot = process.env.CANVAS_DATA_ROOT;
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  try {
    const rootPath = path.join(dataRoot, 'workspace');
    const workspace: WorkspaceContext = {
      workspaceId: 'assessment-undo', workspaceType: 'personal', rootPath, rootRelativePath: 'workspace',
      organizationId: null, ownerUserId: 'tester', legacy: false, status: 'active',
      permissions: { canRead: true, canWrite: true, canDelete: true,
        canCreatePublicLinks: false, canManageWorkspace: true, canRunAgent: true },
    };
    const sourcePath = 'content/atelier-notes';
    const destinationPath = 'content/channels/atelier-notes';
    const baseline = {
      'shared.md': '# Shared\n',
      'content/atelier-notes/plan.md': '[Shared](../../shared.md)\n',
      'dashboard/index.md': '[Notes](../content/atelier-notes/plan.md)\n',
      'archive/old.md': '[Archived](./missing.md)\n',
    };
    for (const [filename, content] of Object.entries(baseline)) {
      await fs.mkdir(path.dirname(path.join(rootPath, filename)), { recursive: true });
      await fs.writeFile(path.join(rootPath, filename), content);
    }
    await fs.mkdir(path.join(rootPath, 'content/channels'));
    const preview = await buildWorkspaceFileOperationPreview({
      kind: 'move', sourceWorkspaceId: workspace.workspaceId, destinationWorkspaceId: workspace.workspaceId,
      sourceOptions: { workspace }, destinationOptions: { workspace },
      selections: [{ sourcePath, destinationPath }],
    });
    assert.equal(preview.readiness, 'ready');
    assert.equal(preview.coverage.complete, false);
    assert.equal(preview.linkAssessment?.warnings.length, 1);
    const backup = await captureWorkspaceOperationBackup({ workspace, path: sourcePath,
      operationId: originalOperationId });
    const groups = groupWorkspaceLinkWrites(preview);
    await fs.rename(path.join(rootPath, sourcePath), path.join(rootPath, destinationPath));
    for (const document of preview.previewContents) await fs.writeFile(path.join(rootPath, document.path), document.content);
    const record: WorkspaceOperationWithSteps = {
      operationId: originalOperationId, planId: preview.planId, requestHash: hash('request'),
      requestJson: JSON.stringify({ kind: 'move', selections: [{ sourcePath, destinationPath }] }),
      actor: { type: 'user', id: 'tester' }, sourceWorkspaceId: workspace.workspaceId,
      destinationWorkspaceId: workspace.workspaceId, expectedStepCount: groups.length + 1,
      status: 'completed', phase: 'completed', revision: 1, errorCode: null, createdAt: 1, updatedAt: 1,
      steps: [{ operationId: originalOperationId, stepKey: 'path:all', phase: 'path', status: 'applied',
        beforeFence: 'before', afterFence: 'after', backupRef: null,
        receiptJson: JSON.stringify({ kind: 'move', sourcePath, destinationPath, undoBackupId: backup.backupId }),
        createdAt: 1, updatedAt: 1 }, ...groups.map((group) => ({
        operationId: originalOperationId, stepKey: operationLinkStepKey(group.workspaceId, group.path),
        phase: 'link' as const, status: 'applied' as const, beforeFence: group.beforeSha256,
        afterFence: group.afterSha256, backupRef: null, receiptJson: '{}', createdAt: 1, updatedAt: 1,
      }))],
    };
    const rows = new Map([[originalOperationId, record]]);
    let executions = 0;
    const file = path.resolve('app/lib/files/workspace-operation-undo-service.ts');
    const source = ts.transpileModule(await fs.readFile(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        esModuleInterop: true },
    }).outputText;
    const load = createRequire(file);
    const service = { exports: {} as typeof UndoService };
    new Function('require', 'module', 'exports', source)((name: string) => {
      if (name === 'server-only') return {};
      if (name === '@/app/lib/markdown/workspace-file-operation-preview') return { ...load(name), buildWorkspaceFileOperationPreview };
      if (name === './workspace-operation-journal') return { WorkspaceOperationJournal: class {
        async get(operationId: string) { return rows.get(operationId) ?? null; }
      } };
      if (name === '@/app/lib/workspaces/request') return { workspaceFileOptions: () => ({ workspace }) };
      if (name === './workspace-file-operation-service') return { executeWorkspaceFileOperationService: async (input: {
        operationId: string; kind: 'move'; expectedPlanId: string;
        selections: Array<{ sourcePath: string; destinationPath: string }>;
      }) => {
        const inverse = await buildWorkspaceFileOperationPreview({
          kind: input.kind, sourceWorkspaceId: workspace.workspaceId, destinationWorkspaceId: workspace.workspaceId,
          sourceOptions: { workspace }, destinationOptions: { workspace }, selections: input.selections,
        });
        assertFreshWorkspaceFileOperationPlan(inverse, input.expectedPlanId);
        executions += 1;
        const selection = input.selections[0]!;
        await fs.rename(path.join(rootPath, selection.sourcePath), path.join(rootPath, selection.destinationPath));
        for (const document of inverse.previewContents) await fs.writeFile(path.join(rootPath, document.path), document.content);
        rows.set(input.operationId, { ...record, operationId: input.operationId,
          planId: inverse.planId, requestJson: JSON.stringify({ kind: input.kind, selections: input.selections }) });
        return { execution: { status: 'complete' }, alreadyKnown: false };
      } };
      return load(name);
    }, service, service.exports);
    const undoInput = { operationId: originalOperationId, workspace, userId: 'tester', userName: 'Tester' };
    const capability = await service.exports.getWorkspaceOperationUndoCapability(undoInput);
    assert.equal(capability.available, true,
      `unchanged archived broken links must not suppress a safe inverse move: ${capability.reason}`);
    await fs.writeFile(path.join(rootPath, 'dashboard/index.md'), '[Notes](../content/channels/atelier-notes/plan.md)\nNew edit\n');
    assert.equal((await service.exports.getWorkspaceOperationUndoCapability(undoInput)).reasonCode, 'UNDO_CONFLICT');
    await fs.writeFile(path.join(rootPath, 'dashboard/index.md'), preview.previewContents.find((document) =>
      document.path === 'dashboard/index.md')!.content);
    await fs.mkdir(path.join(rootPath, sourcePath));
    assert.equal((await service.exports.getWorkspaceOperationUndoCapability(undoInput)).reasonCode, 'UNDO_CONFLICT');
    await fs.rm(path.join(rootPath, sourcePath), { recursive: true });
    await fs.writeFile(path.join(rootPath, destinationPath, 'extra.md'), '# New user file\n');
    assert.equal((await service.exports.getWorkspaceOperationUndoCapability(undoInput)).reasonCode, 'UNDO_CONFLICT');
    await fs.unlink(path.join(rootPath, destinationPath, 'extra.md'));
    assert.equal(executions, 0, 'conflicting undo checks never write');
    const undone = await service.exports.undoWorkspaceFileOperation(undoInput);
    assert.equal(undone.status, 'applied');
    for (const [filename, content] of Object.entries(baseline)) {
      assert.equal(await fs.readFile(path.join(rootPath, filename), 'utf8'), content,
        `undo restores exact bytes in ${filename}`);
    }
    await assert.rejects(fs.stat(path.join(rootPath, destinationPath)), { code: 'ENOENT' });
    const replay = await service.exports.undoWorkspaceFileOperation(undoInput);
    assert.equal(replay.alreadyKnown, true);
    assert.equal(executions, 1, 'idempotent undo does not repeat the path mutation');
    console.log('workspace operation assessment undo: warning-only inverse, exact links, new edits, collision, extra files, idempotent apply OK');
  } finally {
    if (previousData === undefined) delete process.env.DATA; else process.env.DATA = previousData;
    if (previousCanvasRoot === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = previousCanvasRoot;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { auditEvents, canvasOrganizationSettings, canvasWorkspaces, user } from '../app/lib/db/schema';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { WorkspacePathOperationInput } from '../app/lib/files/workspace-path-operation-service';
import type { WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { MAX_INDEXED_MARKDOWN_BYTES } from '../app/lib/markdown/workspace-link-limits';

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-trash-'));
  process.env.DATA = dataDir;
  process.env.CANVAS_DATA_ROOT = dataDir;
  const workspaceRelativePath = 'workspaces/personal/agent-trash/files';
  const workspaceRoot = path.join(dataDir, workspaceRelativePath);
  await fs.mkdir(workspaceRoot, { recursive: true });

  const testDatabase = await createPiTestDatabase();
  const now = new Date();
  await testDatabase.db.insert(user).values({
    id: 'agent-trash-user', name: 'Agent Trash User', email: 'agent-trash@example.test',
    emailVerified: true, createdAt: now, updatedAt: now,
  });
  await testDatabase.db.insert(canvasOrganizationSettings).values({
    organizationId: 'agent-trash-org', ownerUserId: 'agent-trash-user',
    createdAt: now, updatedAt: now,
  });
  await testDatabase.db.insert(canvasWorkspaces).values({
    id: 'agent-trash-test', organizationId: 'agent-trash-org', type: 'personal',
    ownerUserId: 'agent-trash-user', rootRelativePath: workspaceRelativePath,
    displayName: 'Agent Trash Test', createdAt: now, updatedAt: now,
  });
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  let failTrashFor: string | null = null;
  let directService: typeof import('../app/lib/files/workspace-path-operation-service');
  const directScopes = new Map<string, WorkspaceOperationBatchScope>();
  const directCalls: WorkspacePathOperationInput[] = [];
  moduleInternals._load = (request, parent, isMain) => {
    if (request === '@/app/lib/files/workspace-file-lifecycle-guard') return {
      withWorkspaceFileLifecycleGuards: (_scopes: unknown, work: () => Promise<unknown>) => work(),
      withWorkspaceFileLifecycleGuard: (_scope: unknown, work: () => Promise<unknown>) => work(),
    };
    if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return testDatabase;
    if (request === 'server-only') return {};
    if (request === '@/app/lib/document-review-availability') return {
      readDocumentReviewAvailability: () => ({ documentReviewEnabled: false, updatedAt: null }),
    };
    if (request === '@/app/lib/files/workspace-path-operation-service') return directService;
    if (request === '@/app/lib/files/workspace-operation-review-service') {
      return { getExistingAgentWorkspacePathOperation: async () => null,
        submitAgentWorkspacePathOperation: async () => { throw new Error('Review OFF cannot submit an optional review.'); } };
    }
    if (request === '@/app/lib/filesystem/workspace-trash') {
      const real = originalLoad(request, parent, isMain) as typeof import('../app/lib/filesystem/workspace-trash');
      return {
        ...real,
        trashWorkspacePaths: async (params: Parameters<typeof real.trashWorkspacePaths>[0]) =>
          params.paths[0] === failTrashFor
            ? { trashed: [], failed: [{ path: params.paths[0], error: 'Simulated trash storage failure' }] }
            : real.trashWorkspacePaths(params),
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const service = await import('../app/lib/files/workspace-path-operation-service');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { createWorkspaceOperationBatchWorker } = await import('../app/lib/files/workspace-operation-batch-worker');
    const { getWorkspaceOperationBatchExecution } = await import('../app/lib/files/workspace-operation-batch-executor');
    const { setFileCollaborationConnectionFactoryForTests } = await import('../app/lib/files/collaboration-repository');
    setFileCollaborationConnectionFactoryForTests(testDatabase.openDb);
    const store = new WorkspaceOperationBatchStore(testDatabase.openDb);
    const worker = createWorkspaceOperationBatchWorker({ store, resolveScope: async (batch) => {
      const scope = directScopes.get(batch.batchId);
      assert.ok(scope, 'the worker resolves the original authorized workspace'); return scope;
    }, dependentReviews: async () => undefined });
    directService = { ...service,
      submitDirectWorkspacePathOperation: async (input) => {
        directCalls.push(input);
        const batch = await service.submitDirectWorkspacePathOperation(input, { store });
        directScopes.set(batch.batchId, input.scope); return batch;
      },
      getExistingDirectWorkspacePathOperation: (input) => service.getExistingDirectWorkspacePathOperation(input, store),
      waitForWorkspacePathOperation: async (batch: WorkspaceOperationBatchRecord) => {
        if (['queued', 'applying'].includes(batch.status)) assert.equal(await worker.tick(), true);
        return (await store.get(batch.batchId))!;
      },
    };
    const { deleteAgentPaths, restoreAgentFileSnapshot, writeAgentTextFile } = await import('../app/lib/pi/agent-file-operations');
    const { formatFileChangeResult, formatPathOperationResult } = await import('../app/lib/pi/tool-file-formatters');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { listWorkspaceTrashEntries, restoreWorkspaceTrashEntry } = await import('../app/lib/filesystem/workspace-trash');
    const { restoreFileCollaborationPath } = await import('../app/lib/files/collaboration-policy');
    const workspace = {
      workspaceId: 'agent-trash-test', workspaceType: 'personal' as const,
      rootPath: workspaceRoot, rootRelativePath: workspaceRelativePath,
      organizationId: 'agent-trash-org', ownerUserId: 'agent-trash-user', legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: true },
    };
    const context = {
      userId: 'agent-trash-user', sessionId: 'agent-trash-session', agentId: 'agent-trash-agent',
      workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType,
      workspaceName: 'Agent Trash Test', organizationId: 'agent-trash-org', customerId: null, projectId: null,
      workspaceRoot, workspaceRootRelativePath: workspaceRelativePath,
      canWrite: true, canDelete: true, canShare: false, legacy: false,
    };

    const markdown = Buffer.from(`# Large document\n${'Markdown content with links [ref](./target.md).\n'.repeat(100_000)}`);
    const binary = Buffer.alloc(9 * 1024 * 1024, 0x8f);
    assert(markdown.length > MAX_INDEXED_MARKDOWN_BYTES);
    await fs.writeFile(path.join(workspaceRoot, 'large.md'), markdown);
    await fs.writeFile(path.join(workspaceRoot, 'large.bin'), binary);

    // A remaining oversized Markdown document cannot be skipped when looking for incoming links.
    const coverageBlocked = await runWithAgentExecutionContext(context, () => deleteAgentPaths({ paths: ['large.bin'] }));
    assert.equal(coverageBlocked.changed, false, JSON.stringify(coverageBlocked));
    assert.equal(coverageBlocked.verified, false); assert.equal(coverageBlocked.linkStatus, 'incomplete');
    assert.equal(coverageBlocked.fileOperation?.status, 'blocked');
    assert.equal(coverageBlocked.trashEntries?.length ?? 0, 0);
    assert.equal(sha256(await fs.readFile(path.join(workspaceRoot, 'large.md'))), sha256(markdown));
    assert.equal(sha256(await fs.readFile(path.join(workspaceRoot, 'large.bin'))), sha256(binary));
    const largeBlock = await store.get(coverageBlocked.fileOperation!.batchId);
    assert.equal(largeBlock?.status, 'blocked');
    assert.equal(largeBlock?.authorization.mode, 'direct');
    assert.equal(largeBlock?.plan.coverage.complete, false);
    assert.ok(largeBlock?.plan.issues.length);
    await fs.writeFile(path.join(workspaceRoot, 'large-index.md'), '[large](./large.md)');
    // Deleted Markdown can define Wiki aliases, so unreadable selected documents also stay blocked.
    const result = await runWithAgentExecutionContext(context, () => deleteAgentPaths({ paths: ['large.md', 'large.bin'] }));
    assert.equal(result.changed, false, JSON.stringify(result)); assert.equal(result.verified, false);
    assert.equal(result.fileOperation?.status, 'blocked'); assert.equal(result.linkStatus, 'incomplete');
    assert.equal(result.trashEntries?.length ?? 0, 0);
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'large-index.md'), 'utf8'), '[large](./large.md)');
    const selectedBlock = await store.get(result.fileOperation!.batchId);
    assert.ok(selectedBlock?.plan.issues.some((issue) => issue.path === 'large.md' && issue.code === 'incomplete-index'
      && /Wiki aliases/u.test(issue.detail)));
    const largeExecution = await getWorkspaceOperationBatchExecution({ batchId: result.fileOperation!.batchId,
      scope: directScopes.get(result.fileOperation!.batchId)! });
    assert.equal(largeExecution, null, 'blocked admission never manufactures execution receipts');
    assert.equal(sha256(await fs.readFile(path.join(workspaceRoot, 'large.md'))), sha256(markdown));
    assert.equal(sha256(await fs.readFile(path.join(workspaceRoot, 'large.bin'))), sha256(binary));
    await fs.rename(path.join(workspaceRoot, 'large.md'), path.join(dataDir, 'large-preserved.md'));
    await fs.rename(path.join(workspaceRoot, 'large-index.md'), path.join(dataDir, 'large-index-preserved.md'));
    const smallMarkdown = Buffer.from('# Small document\n[ref](./target.md)\n');
    await fs.writeFile(path.join(workspaceRoot, 'small.md'), smallMarkdown);
    await fs.writeFile(path.join(workspaceRoot, 'target.md'), '# Target');
    await fs.writeFile(path.join(workspaceRoot, 'index.md'), '[small](./small.md)');
    const staleBacklink = await runWithAgentExecutionContext(context, () => deleteAgentPaths({ paths: ['small.md'] }));
    assert.equal(staleBacklink.changed, false); assert.equal(staleBacklink.verified, false);
    assert.equal(staleBacklink.fileOperation?.status, 'needs_review');
    assert.equal(staleBacklink.fileOperation?.errorCode, 'LINK_WRITE_STALE_DOCUMENT');
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'index.md'), 'utf8'), '[small](./small.md)');
    assert.equal(sha256(await fs.readFile(path.join(workspaceRoot, 'small.md'))), sha256(smallMarkdown));
    await fs.rename(path.join(workspaceRoot, 'index.md'), path.join(dataDir, 'index-preserved.md'));
    const deletion = await runWithAgentExecutionContext(context, () => deleteAgentPaths({ paths: ['small.md', 'large.bin'] }));
    assert.equal(deletion.changed, true, JSON.stringify(deletion));
    assert.equal(deletion.verified, true);
    assert.equal(deletion.fileOperation?.status, 'applied'); assert.equal(deletion.linkStatus, 'complete');
    assert.equal(deletion.trashEntries?.length, 2);
    assert.equal(deletion.bytes, smallMarkdown.length + binary.length);
    for (const name of ['small.md', 'large.bin']) {
      await assert.rejects(fs.stat(path.join(workspaceRoot, name)), { code: 'ENOENT' });
      const entry: { id: string; originalPath: string; expiresAt: string } | undefined = deletion.trashEntries!.find((item) => item.originalPath === name);
      assert(entry);
      const restored = await restoreWorkspaceTrashEntry({ workspace, entryId: entry.id, restoredByUserId: context.userId });
      await restoreFileCollaborationPath({ workspace, path: restored.originalPath, trashEntryId: entry.id });
      const actual = await fs.readFile(path.join(workspaceRoot, name));
      assert.equal(sha256(actual), sha256(name === 'small.md' ? smallMarkdown : binary));
    }

    await fs.mkdir(path.join(workspaceRoot, 'nested'));
    await fs.writeFile(path.join(workspaceRoot, 'nested', 'child.txt'), 'child');
    const directory = await runWithAgentExecutionContext(context, () => deleteAgentPaths({ paths: ['nested'], recursive: true }));
    assert.equal(directory.trashEntries?.length, 1);
    assert.equal(directory.verified, true);
    const restoredDirectory = await restoreWorkspaceTrashEntry({ workspace, entryId: directory.trashEntries![0].id, restoredByUserId: context.userId });
    await restoreFileCollaborationPath({ workspace, path: restoredDirectory.originalPath, trashEntryId: directory.trashEntries![0].id });
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'nested', 'child.txt'), 'utf8'), 'child');

    await fs.writeFile(path.join(workspaceRoot, 'first-long-name.md'), 'first');
    await fs.writeFile(path.join(workspaceRoot, 'blocked.md'), 'blocked');
    failTrashFor = 'blocked.md';
    const partialRequest = { paths: ['first-long-name.md', 'blocked.md'], idempotencyKey: 'partial-delete' };
    const partial = await runWithAgentExecutionContext(context, () => deleteAgentPaths(partialRequest));
    failTrashFor = null;
    assert.equal(partial.changed, true);
    assert.equal(partial.verified, false);
    assert.equal(partial.fileOperation?.status, 'needs_recovery');
    assert.equal(partial.fileOperation?.completedActions, 1); assert.equal(partial.fileOperation?.errorCode, 'BATCH_TRASH_FAILED');
    assert.equal(partial.trashEntries?.length, 1);
    assert.deepEqual(partial.failedPaths, partialRequest.paths.map((path) => ({ path, error: 'BATCH_TRASH_FAILED' })));
    assert.match(formatPathOperationResult(partial), /needs_recovery/u);
    assert.match(formatPathOperationResult(partial), /Trash entry: first-long-name\.md/);
    assert.equal(partial.entries.find((entry) => entry.sourcePath === 'first-long-name.md')?.changed, true);
    assert.equal(partial.entries.find((entry) => entry.sourcePath === 'blocked.md')?.changed, false);
    await assert.rejects(fs.stat(path.join(workspaceRoot, 'first-long-name.md')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'blocked.md'), 'utf8'), 'blocked');
    const partialCalls = directCalls.length;
    const partialRetry = await runWithAgentExecutionContext(context, () => deleteAgentPaths(partialRequest));
    assert.equal(partialRetry.fileOperation?.batchId, partial.fileOperation?.batchId);
    assert.equal(partialRetry.fileOperation?.status, 'needs_recovery'); assert.equal(directCalls.length, partialCalls);
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'blocked.md'), 'utf8'), 'blocked');
    const audits = await testDatabase.db.select().from(auditEvents);
    assert(audits.some((entry) => entry.action === 'agent_path.delete_path' && entry.status === 'failure'));

    const createdContent = '# Created after the snapshot\n';
    const created = await runWithAgentExecutionContext(context, () => writeAgentTextFile({
      path: 'snapshot-created.md', content: createdContent,
    }));
    assert.equal(created.snapshot?.existed, false);
    const createdSnapshotId = created.snapshot!.id;
    failTrashFor = 'snapshot-created.md';
    const failedSnapshot = await runWithAgentExecutionContext(context, () => restoreAgentFileSnapshot({ snapshotId: createdSnapshotId }));
    assert.equal(failedSnapshot.changed, false); assert.equal(failedSnapshot.validation.ok, false);
    assert.equal(failedSnapshot.fileOperation?.status, 'needs_recovery');
    assert.equal(failedSnapshot.fileOperation?.errorCode, 'BATCH_TRASH_FAILED');
    failTrashFor = null;
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'snapshot-created.md'), 'utf8'), createdContent);
    await assert.rejects(
      runWithAgentExecutionContext({ ...context, canDelete: false }, () => restoreAgentFileSnapshot({ snapshotId: createdSnapshotId })),
      { code: 'BATCH_ACCESS_DENIED' },
    );
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'snapshot-created.md'), 'utf8'), createdContent);
    const failedSnapshotRetry = await runWithAgentExecutionContext(context, () => restoreAgentFileSnapshot({ snapshotId: createdSnapshotId }));
    assert.equal(failedSnapshotRetry.fileOperation?.batchId, failedSnapshot.fileOperation?.batchId);
    assert.equal(failedSnapshotRetry.fileOperation?.status, 'needs_recovery'); assert.equal(failedSnapshotRetry.changed, false);
    await store.enqueue({ batchId: failedSnapshot.fileOperation!.batchId, planId: failedSnapshot.fileOperation!.planId,
      userId: context.userId, displayName: 'Agent Trash User', action: 'resume' });
    const undo = await runWithAgentExecutionContext(context, () => restoreAgentFileSnapshot({ snapshotId: createdSnapshotId }));
    assert.equal(undo.changed, true);
    assert.equal(undo.trashEntry?.originalPath, 'snapshot-created.md');
    assert.match(formatFileChangeResult(undo), /Trash entry: snapshot-created\.md/u);
    await assert.rejects(fs.stat(path.join(workspaceRoot, 'snapshot-created.md')), { code: 'ENOENT' });
    const trash = await listWorkspaceTrashEntries({ workspace });
    assert(trash.some((entry) => entry.id === undo.trashEntry?.id));
    const restoredCreated = await restoreWorkspaceTrashEntry({
      workspace, entryId: undo.trashEntry!.id, restoredByUserId: context.userId,
    });
    await restoreFileCollaborationPath({
      workspace, path: restoredCreated.originalPath, trashEntryId: undo.trashEntry!.id,
    });
    assert.equal(sha256(await fs.readFile(path.join(workspaceRoot, 'snapshot-created.md'))), sha256(Buffer.from(createdContent)));

    console.log('Agent workspace trash: oversized selected/remaining Markdown block safely, stale backlinks stop deletion, binary/directory hash-identical restore, durable snapshot resume and audited partial failure passed.');
  } finally {
    moduleInternals._load = originalLoad;
    await testDatabase.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

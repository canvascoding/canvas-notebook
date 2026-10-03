import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import { setFileCollaborationConnectionFactoryForTests } from '../app/lib/files/collaboration-repository';
import type { FileEvent } from '../app/lib/filesystem/file-watcher';
import type { WorkspacePathOperationInput } from '../app/lib/files/workspace-path-operation-service';
import type { WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-rename-'));
  // Keep unrelated audit/share tables isolated too. Collaboration uses PostgreSQL below.
  process.env.DATA = root;
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  process.env.DATABASE_URL = 'postgresql://agent-rename-test.invalid/canvas';
  const postgres = new PGlite();
  const query = async (input: string | { text: string; rowMode?: string }, values?: unknown[]) => {
    const result = await postgres.query<Record<string, unknown>>(typeof input === 'string' ? input : input.text, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length,
      rows: typeof input !== 'string' && input.rowMode === 'array' ? result.rows.map((row) => result.fields.map((field) => row[field.name])) : result.rows };
  };
  const original = { query: Pool.prototype.query, connect: Pool.prototype.connect };
  Object.defineProperty(Pool.prototype, 'query', { configurable: true, writable: true, value: query });
  Object.defineProperty(Pool.prototype, 'connect', { configurable: true, writable: true, value: async () => ({ query, release() {} }) });
  const connection: SqlConnection = {
    get: async (sql, params = []) => (await postgres.query(sql, params)).rows[0],
    all: async (sql, params = []) => (await postgres.query(sql, params)).rows,
    run: async (sql, params = []) => ({ changes: (await postgres.query(sql, params)).affectedRows ?? 0 }),
    close: () => undefined,
  };
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  const directScopes = new Map<string, WorkspaceOperationBatchScope>();
  const directCalls: WorkspacePathOperationInput[] = [];
  const reviewCalls: Array<{ kind: string }> = [];
  let directService: typeof import('../app/lib/files/workspace-path-operation-service');
  moduleInternals._load = (request, parent, isMain) => {
    if (request === '@/app/lib/document-review-availability') return {
      readDocumentReviewAvailability: () => ({ documentReviewEnabled: false, updatedAt: null }),
    };
    if (request === '@/app/lib/files/workspace-path-operation-service') return directService;
    if (request === '@/app/lib/files/workspace-operation-review-service') return {
      getExistingAgentWorkspacePathOperation: async () => null,
      submitAgentWorkspacePathOperation: async (input: { kind: string }) => {
        reviewCalls.push(input);
        throw new Error('Review OFF must skip the optional review service.');
      },
    };
    return originalLoad(request, parent, isMain);
  };
  const { getFileWatcher } = await import('../app/lib/filesystem/file-watcher');
  try {
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    await postgres.exec(`
      INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
        VALUES ('test','Test','agent-path-test@example.test',1,1,1);
      INSERT INTO canvas_organization_settings (organization_id,owner_user_id,created_at,updated_at)
        VALUES ('test-org','test',1,1);
      INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,created_at,updated_at)
        VALUES ('test','test-org','personal','test','workspace','Test',1,1);
    `);
    setFileCollaborationConnectionFactoryForTests(async () => connection);
    const service = await import('../app/lib/files/workspace-path-operation-service');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { createWorkspaceOperationBatchWorker } = await import('../app/lib/files/workspace-operation-batch-worker');
    const { getWorkspaceOperationBatchExecution } = await import('../app/lib/files/workspace-operation-batch-executor');
    const store = new WorkspaceOperationBatchStore(async () => connection);
    const worker = createWorkspaceOperationBatchWorker({ store, resolveScope: async (batch) => {
      const scope = directScopes.get(batch.batchId);
      assert.ok(scope, 'the fixture resolves the original authorized workspace');
      return scope;
    }, dependentReviews: async () => undefined });
    directService = { ...service,
      submitDirectWorkspacePathOperation: async (input) => {
        directCalls.push(input);
        const batch = await service.submitDirectWorkspacePathOperation(input, { store });
        directScopes.set(batch.batchId, input.scope);
        return batch;
      },
      getExistingDirectWorkspacePathOperation: (input) => service.getExistingDirectWorkspacePathOperation(input, store),
      waitForWorkspacePathOperation: async (batch: WorkspaceOperationBatchRecord) => {
        if (['queued', 'applying'].includes(batch.status)) assert.equal(await worker.tick(), true);
        return (await store.get(batch.batchId))!;
      },
    };
    const { copyAgentPaths, moveAgentPaths, getAgentWorkspaceContext } = await import('../app/lib/pi/agent-file-operations');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { getFileCollaborationState } = await import('../app/lib/files/collaboration-policy');
    const { getWorkspaceOperationBackup, restoreWorkspaceOperationBackup } = await import('../app/lib/files/workspace-operation-backup');
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(path.join(workspaceRoot, 'notes'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'notes', 'a.md'), '# Preserved');
    await fs.writeFile(path.join(workspaceRoot, 'notes', 'inside.md'), '[A](./a.md)');
    await fs.writeFile(path.join(workspaceRoot, 'index.md'), '[A](notes/a.md)');
    await fs.writeFile(path.join(workspaceRoot, 'stable.md'), '# Stable');
    await fs.mkdir(path.join(workspaceRoot, 'backup'));
    await runWithAgentExecutionContext({
      userId: 'test', sessionId: 'test', agentId: 'canvas-agent', workspaceId: 'test', workspaceType: 'personal',
      workspaceName: 'Test', organizationId: null, customerId: null, projectId: null,
      workspaceRoot, workspaceRootRelativePath: null, canWrite: true, canDelete: true, canShare: false, legacy: false,
    }, async () => {
      const workspace = getAgentWorkspaceContext()!;
      await fs.mkdir(path.join(workspaceRoot, 'blocked'));
      await fs.writeFile(path.join(workspaceRoot, 'blocked', 'missing.md'), '[Missing](./absent.md)');
      const blocked = await moveAgentPaths({ sourcePaths: ['notes'], destinationPath: 'archive' });
      assert.equal(blocked.changed, false, JSON.stringify(blocked));
      assert.equal(blocked.verified, false);
      assert.equal(blocked.linkStatus, 'incomplete');
      assert.equal(blocked.fileOperation?.status, 'needs_review', JSON.stringify(blocked));
      assert.equal(blocked.fileOperation?.errorCode, 'LINK_WRITE_STALE_DOCUMENT');
      assert.equal(blocked.review, undefined);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'notes', 'a.md'), 'utf8'), '# Preserved');
      await assert.rejects(fs.stat(path.join(workspaceRoot, 'archive')));
      await fs.rm(path.join(workspaceRoot, 'blocked'), { recursive: true });
      await fs.mkdir(path.join(workspaceRoot, 'batch'));
      await fs.writeFile(path.join(workspaceRoot, 'batch', 'one.bin'), 'one');
      await fs.writeFile(path.join(workspaceRoot, 'batch', 'two.bin'), 'two');
      const batch = await moveAgentPaths({
        sourcePaths: ['batch/one.bin', 'batch/two.bin'], destinationPath: 'backup',
      });
      assert.equal(batch.verified, true, JSON.stringify(batch));
      assert.equal(batch.linkStatus, 'complete');
      assert.equal(batch.operationIds?.length, 1, 'all selections belong to one durable direct job');
      assert.equal(batch.fileOperation?.status, 'applied');
      assert.equal(batch.review, undefined);
      const batchRecord = await store.get(batch.fileOperation!.batchId);
      assert.equal(batchRecord?.authorization.mode, 'direct');
      assert.deepEqual(batchRecord?.reviewIds, []);
      assert.equal(batchRecord?.reviewerUserId, null);
      const batchExecution = await getWorkspaceOperationBatchExecution({ batchId: batch.fileOperation!.batchId,
        scope: directScopes.get(batch.fileOperation!.batchId)! });
      assert.equal(batchExecution?.status, 'applied');
      assert.equal(batchExecution?.stepResults?.filter((step) => step.phase === 'path' && step.state === 'applied').length, 2);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'backup', 'one.bin'), 'utf8'), 'one');
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'backup', 'two.bin'), 'utf8'), 'two');
      const plainCopy = await copyAgentPaths({ sourcePaths: ['backup/one.bin'], destinationPath: 'batch/one.bin' });
      assert.equal(plainCopy.verified, true, JSON.stringify(plainCopy));
      assert.equal(plainCopy.linkStatus, 'complete');
      assert.equal(plainCopy.operationIds?.length, 1);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'batch', 'one.bin'), 'utf8'), 'one');

      const overwrittenBytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0x38);
      const replacementBytes = Buffer.from('replacement copy');
      await fs.writeFile(path.join(workspaceRoot, 'backup', 'replace.bin'), overwrittenBytes);
      await fs.writeFile(path.join(workspaceRoot, 'batch', 'replace.bin'), replacementBytes);
      const overwrittenCopy = await copyAgentPaths({
        sourcePaths: ['batch/replace.bin'], destinationPath: 'backup/replace.bin', overwrite: true,
      });
      assert.equal(overwrittenCopy.verified, true);
      assert.equal(overwrittenCopy.backupIds?.length, 1);
      assert.equal(overwrittenCopy.entries[0].backupId, overwrittenCopy.backupIds?.[0]);
      assert.deepEqual(await fs.readFile(path.join(workspaceRoot, 'backup', 'replace.bin')), replacementBytes);
      const copyBackup = await getWorkspaceOperationBackup({ workspace, backupId: overwrittenCopy.backupIds![0] });
      assert.equal(copyBackup.sizeBytes, overwrittenBytes.length);
      assert.equal(copyBackup.entries[0].type, 'file');
      assert.equal((copyBackup.entries[0] as { sha256: string }).sha256,
        createHash('sha256').update(overwrittenBytes).digest('hex'));
      await fs.rm(path.join(workspaceRoot, 'backup', 'replace.bin'));
      await restoreWorkspaceOperationBackup({ workspace, backupId: copyBackup.backupId });
      assert.deepEqual(await fs.readFile(path.join(workspaceRoot, 'backup', 'replace.bin')), overwrittenBytes);

      await fs.writeFile(path.join(workspaceRoot, 'batch', 'move-source.bin'), 'moved content');
      await fs.writeFile(path.join(workspaceRoot, 'backup', 'move-target.bin'), 'previous target');
      const overwrittenMove = await moveAgentPaths({
        sourcePaths: ['batch/move-source.bin'], destinationPath: 'backup/move-target.bin', overwrite: true,
      });
      assert.equal(overwrittenMove.verified, true, JSON.stringify(overwrittenMove));
      assert.equal(overwrittenMove.fileOperation?.status, 'applied');
      assert.equal(overwrittenMove.trashEntries?.length, 1, 'the replaced target has a durable trash receipt');
      assert.equal(overwrittenMove.trashEntries?.[0].originalPath, 'backup/move-target.bin');
      assert.equal(overwrittenMove.entries[0].overwritten, true);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'backup', 'move-target.bin'), 'utf8'), 'moved content');
      await assert.rejects(fs.stat(path.join(workspaceRoot, 'batch', 'move-source.bin')));
      const moveBatch = await store.get(overwrittenMove.fileOperation!.batchId);
      const queuedUndo = await store.enqueue({ batchId: moveBatch!.batchId, planId: moveBatch!.planId,
        userId: 'test', displayName: 'Test', action: 'undo' });
      const undone = await directService.waitForWorkspacePathOperation(queuedUndo);
      assert.equal(undone.status, 'undone', JSON.stringify(undone));
      assert.equal(undone.reviewerUserId, null, 'undo keeps the original direct authority');
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'backup', 'move-target.bin'), 'utf8'), 'previous target');
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'batch', 'move-source.bin'), 'utf8'), 'moved content');

      await fs.writeFile(path.join(workspaceRoot, 'batch', 'live.md'), '# Live source');
      await fs.writeFile(path.join(workspaceRoot, 'backup', 'live.md'), '# Live destination');
      await getFileCollaborationState({ workspace, path: 'backup/live.md', ensureDocument: true });
      await assert.rejects(
        () => copyAgentPaths({ sourcePaths: ['batch/live.md'], destinationPath: 'backup/live.md', overwrite: true }),
        { code: 'AGENT_PATH_LIVE_DOCUMENT_REQUIRES_REVIEW' },
      );
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'backup', 'live.md'), 'utf8'), '# Live destination');

      await fs.writeFile(path.join(workspaceRoot, 'batch', 'partial.bin'), 'new partial');
      const partialDestination = path.join(workspaceRoot, 'backup', 'partial.bin');
      await fs.writeFile(partialDestination, 'old partial');
      const originalCopy = fs.cp;
      let partialError: unknown;
      fs.cp = (async (...args: Parameters<typeof fs.cp>) => {
        if (String(args[1]) === partialDestination) throw new Error('injected copy failure');
        return originalCopy(...args);
      }) as typeof fs.cp;
      try {
        await copyAgentPaths({ sourcePaths: ['batch/partial.bin'], destinationPath: 'backup/partial.bin', overwrite: true });
      } catch (error) {
        partialError = error;
      } finally {
        fs.cp = originalCopy;
      }
      assert.match(String(partialError), /injected copy failure.*Recovery backup IDs/u);
      const partialBackupIds = (partialError as Error & { backupIds: string[] }).backupIds;
      assert.equal(partialBackupIds.length, 1);
      await restoreWorkspaceOperationBackup({ workspace, backupId: partialBackupIds[0] });
      assert.equal(await fs.readFile(partialDestination, 'utf8'), 'old partial');

      await fs.writeFile(path.join(workspaceRoot, 'batch', 'failure-source.bin'), 'new content');
      await fs.writeFile(path.join(workspaceRoot, 'backup', 'failure-target.bin'), 'old content');
      const backupStorageRoot = path.join(root, '.workspace-operation-backups');
      await fs.chmod(backupStorageRoot, 0o755);
      try {
        await assert.rejects(
          () => copyAgentPaths({ sourcePaths: ['batch/failure-source.bin'], destinationPath: 'backup/failure-target.bin', overwrite: true }),
          /private directory/u,
        );
      } finally {
        await fs.chmod(backupStorageRoot, 0o700);
      }
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'backup', 'failure-target.bin'), 'utf8'), 'old content');
      const before = await getFileCollaborationState({ workspace, path: 'stable.md', ensureDocument: true });
      const events: FileEvent[] = [];
      getFileWatcher().subscribe({ id: 'tab', workspaceId: workspace.workspaceId, workspace, send: (event) => events.push(event) });
      const result = await moveAgentPaths({ sourcePaths: ['stable.md'], destinationPath: 'stable-renamed.md' });
      assert.equal(result.verified, true, JSON.stringify(result));
      assert.equal(result.linkStatus, 'complete');
      assert.equal(result.operationIds?.length, 1);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'stable-renamed.md'), 'utf8'), '# Stable');
      const after = await getFileCollaborationState({ workspace, path: 'stable-renamed.md', ensureDocument: true });
      assert.equal(after.document?.id, before.document?.id, 'agent move preserves document identity');
      const rename = events.find((event) => event.type === 'rename');
      assert.equal(rename?.mutation?.oldPath, 'stable.md');
      assert.equal(rename?.mutation?.newPath, 'stable-renamed.md');
      assert.equal(events.some((event) => event.type === 'unlink' && event.relativePath === 'stable.md'), false);

      const linkedBefore = await getFileCollaborationState({ workspace, path: 'notes/a.md', ensureDocument: true });
      const linkedMove = await moveAgentPaths({ sourcePaths: ['notes'], destinationPath: 'archive' });
      assert.equal(linkedMove.changed, false);
      assert.equal(linkedMove.verified, false);
      assert.equal(linkedMove.fileOperation?.status, 'needs_review', JSON.stringify(linkedMove));
      assert.equal(linkedMove.fileOperation?.errorCode, 'LINK_WRITE_STALE_DOCUMENT');
      assert.equal(linkedMove.linkStatus, 'incomplete');
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'notes', 'a.md'), 'utf8'), '# Preserved');
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'index.md'), 'utf8'), '[A](notes/a.md)');
      await assert.rejects(fs.stat(path.join(workspaceRoot, 'archive')));
      const linkedAfter = await getFileCollaborationState({ workspace, path: 'notes/a.md', ensureDocument: true });
      assert.equal(linkedAfter.document?.id, linkedBefore.document?.id);

      const renamedCopy = await copyAgentPaths({ sourcePaths: ['notes/a.md'], destinationPath: 'backup/a-copy.md' });
      assert.equal(renamedCopy.linkStatus, 'incomplete');
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'backup', 'a-copy.md'), 'utf8'), '# Preserved');
      assert.ok(directCalls.length >= 5, 'move requests exercised the direct service and journal');
      assert.ok(directCalls.every((input) => input.actorType === 'agent' && input.actorId === 'canvas-agent'
        && input.actorSessionId === 'test' && input.actorUserId === 'test'));
      assert.equal(reviewCalls.length, 0, 'OFF copy/move/delete execute without optional review submissions');
    });
    console.log('notebook-agent-path-mutations-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
    getFileWatcher().stop();
    setFileCollaborationConnectionFactoryForTests(null);
    Object.assign(Pool.prototype, original);
    await postgres.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

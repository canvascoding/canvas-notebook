import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import type { SqlConnection } from '../app/lib/db';
import type * as BatchWorker from '../app/lib/files/workspace-operation-batch-worker';
import type * as CheckWorker from '../app/lib/files/workspace-operation-check-worker';
import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import { WorkspaceOperationBatchStore } from '../app/lib/files/workspace-operation-batch-store';
import { WorkspaceOperationCheckStore } from '../app/lib/files/workspace-operation-check-store';
import { buildWorkspaceOperationBatchPlan as buildBatchPlan } from '../app/lib/files/workspace-operation-batch-plan';
import { buildWorkspacePlannerSnapshot } from '../app/lib/markdown/workspace-file-operation-preview';
import { workspaceOperationBatchPublic } from '../app/lib/files/workspace-operation-batch-service';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';

const buildWorkspaceOperationBatchPlan = (input: Parameters<typeof buildBatchPlan>[0]) =>
  buildBatchPlan(input, { buildSnapshot: buildWorkspacePlannerSnapshot });

async function main(): Promise<void> {
  const pg = new PGlite();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-worker-ban-'));
  let now = 1_000;
  let integerBooleans = false;
  let scopeResolutions = 0;
  let scans = 0;
  let executions = 0;
  const connect = async (): Promise<SqlConnection> => ({
    get: async (sql, params = []) => {
      const row = (await pg.query<Record<string, unknown>>(sql, params)).rows[0];
      if (row && integerBooleans && typeof row.banned === 'boolean') return { ...row, banned: row.banned ? 1 : 0 };
      return row;
    },
    all: async (sql, params = []) => (await pg.query(sql, params)).rows,
    run: async (sql, params = []) => pg.query(sql, params), close: () => undefined,
  });
  const scope: WorkspaceOperationBatchScope = { workspace: { workspaceId: 'workspace', workspaceType: 'personal',
    rootPath: root, rootRelativePath: 'workspace', ownerUserId: 'reviewer', organizationId: null, status: 'active', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
      canManageWorkspace: true, canCreatePublicLinks: false } }, fileOptions: {} };
  scope.fileOptions = { workspace: scope.workspace };
  const loadWorker = async <T>(filename: string): Promise<T> => {
    const file = path.resolve(filename);
    const source = ts.transpileModule(await fs.readFile(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const load = createRequire(file);
    const compiled = { exports: {} as T };
    new Function('require', 'module', 'exports', source)((name: string) => {
      if (name === 'server-only') return {};
      if (name === '@/app/lib/db') return { openDb: connect };
      if (name === '@/app/lib/workspaces/postgres-runtime') return { resolvePostgresWorkspaceForActor: async () => {
        scopeResolutions += 1;
        return scope.workspace;
      } };
      return load(name);
    }, compiled, compiled.exports);
    return compiled.exports;
  };
  const batches = new WorkspaceOperationBatchStore(connect, () => now);
  const checks = new WorkspaceOperationCheckStore(connect, () => now);
  const lock = async <T>(_id: string, action: () => Promise<T>) => action();
  try {
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await pg.exec(statement);
    await pg.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY,email TEXT,role TEXT,name TEXT,banned BOOLEAN);
      INSERT INTO "user" VALUES ('reviewer','reviewer@example.test','member','Reviewer',FALSE);`);
    await fs.writeFile(path.join(root, 'source.md'), '# Source\n');
    await fs.writeFile(path.join(root, 'index.md'), '[Source](source.md)\n');
    const checkWorker = await loadWorker<typeof CheckWorker>('app/lib/files/workspace-operation-check-worker.ts');
    const batchWorker = await loadWorker<typeof BatchWorker>('app/lib/files/workspace-operation-batch-worker.ts');
    const seed = async (name: string) => {
      now += 1;
      const reviewId = `review_ban_${name}_1234567890`;
      const plan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId, kind: 'move',
        selections: [{ sourcePath: 'source.md', destinationPath: 'moved.md' }] }] });
      await pg.query(`INSERT INTO workspace_file_operation_reviews
        (review_id,plan_id,request_hash,request_json,preview_json,source_workspace_id,destination_workspace_id,
         actor_user_id,actor_id,actor_display_name,status,reason_codes_json,created_at,updated_at)
        VALUES ($1,$2,$2,$3,'{}','workspace','workspace','reviewer','agent','Agent','pending','[]',$4,$4)`,
      [reviewId, plan.planId, JSON.stringify(plan.actions[0]), now]);
      const batch = await batches.create({ batchId: `batch_ban_${name}_1234567890`, plan,
        reviewRefs: [{ reviewId, planId: plan.planId, status: 'pending' }] });
      return { reviewId, batch, plan };
    };
    for (const encoding of ['boolean', 'integer']) {
      integerBooleans = encoding === 'integer';
      await pg.query('UPDATE "user" SET banned=FALSE');
      const checkSeed = await seed(`check_${encoding}`);
      const check = await checks.enqueue({ workspaceId: 'workspace', requesterUserId: 'reviewer', reviewIds: [checkSeed.reviewId] });
      const batchSeed = await seed(`batch_${encoding}`);
      await batches.enqueue({ batchId: batchSeed.batch.batchId, planId: batchSeed.plan.planId, userId: 'reviewer', displayName: 'Reviewer' });
      await pg.query('UPDATE "user" SET banned=TRUE');
      await checkWorker.createWorkspaceOperationCheckWorker({ store: checks, lock,
        preview: async () => { scans += 1; return workspaceOperationBatchPublic(checkSeed.batch); } }).tick();
      await batchWorker.createWorkspaceOperationBatchWorker({ store: batches, lock, hasExecution: async () => false,
        buildPlan: async () => { scans += 1; return batchSeed.plan; },
        execute: async () => { executions += 1; throw new Error('banned reviewer must not write'); } }).tick();
      assert.equal((await checks.get(check.checkId))?.status, 'failed');
      assert.equal((await checks.get(check.checkId))?.errorCode, 'CHECK_ACCESS_DENIED');
      assert.equal((await checks.get(check.checkId))?.batchId, null);
      assert.equal((await batches.get(batchSeed.batch.batchId))?.status, 'failed');
      assert.equal((await batches.get(batchSeed.batch.batchId))?.errorCode, 'BATCH_ACCESS_DENIED');
      assert.equal(scopeResolutions, 0, 'a post-enqueue account ban rejects before workspace bootstrap/resolution');
      assert.equal(scans, 0, 'a banned requester cannot start a background scan or first-apply validation');
      assert.equal(executions, 0);
    }
    await pg.query('UPDATE "user" SET banned=FALSE');
    const during = await seed('during_scan');
    const checking = await checks.enqueue({ workspaceId: 'workspace', requesterUserId: 'reviewer', reviewIds: [during.reviewId] });
    await checkWorker.createWorkspaceOperationCheckWorker({ store: checks, lock, preview: async () => {
      scans += 1;
      await pg.query('UPDATE "user" SET banned=TRUE');
      return workspaceOperationBatchPublic(during.batch);
    } }).tick();
    assert.equal((await checks.get(checking.checkId))?.errorCode, 'CHECK_ACCESS_DENIED');
    assert.equal((await checks.get(checking.checkId))?.batchId, null, 'a ban during a scan prevents publishing the result');
    await pg.query('UPDATE "user" SET banned=FALSE');
    const active = await seed('active_control');
    const activeCheck = await checks.enqueue({ workspaceId: 'workspace', requesterUserId: 'reviewer', reviewIds: [active.reviewId] });
    await checkWorker.createWorkspaceOperationCheckWorker({ store: checks, lock,
      preview: async () => workspaceOperationBatchPublic(active.batch) }).tick();
    assert.equal((await checks.get(activeCheck.checkId))?.status, 'ready', 'an active account still publishes a read-only preview');
    assert.equal(await fs.readFile(path.join(root, 'source.md'), 'utf8'), '# Source\n');
    assert.equal(await fs.readFile(path.join(root, 'index.md'), 'utf8'), '[Source](source.md)\n');
    await assert.rejects(fs.stat(path.join(root, 'moved.md')), { code: 'ENOENT' });
    console.log('worker account bans: real queued checks/approvals denied after ban, boolean/integer adapters, zero scans/writes, mid-scan result withheld and active account control OK');
  } finally { await pg.close(); await fs.rm(root, { recursive: true, force: true }); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

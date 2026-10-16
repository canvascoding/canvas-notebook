import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { WorkspaceOperationBatchError, type WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import type { WorkspaceOperationBatchScope, WorkspaceOperationBatchPlan } from '../app/lib/files/workspace-operation-batch-contract';
import type * as Service from '../app/lib/files/workspace-operation-batch-service';

// A mechanical service-boundary test, not an ACL, claim, database or Owner
// test. Only dependency I/O is replaced; the actual service handles each error.
const servicePath = path.resolve('app/lib/files/workspace-operation-batch-service.ts');
const privateCause = '/private/fixture-root/secret.env: private-sql-and-credential';
let completed = false;
const watchdog = setTimeout(() => { console.error('native Undo service boundary: completion deadline exceeded'); process.exitCode = 1; }, 20_000);
process.on('beforeExit', () => { if (!completed) process.exitCode = 1; });

async function main(): Promise<void> {
  const originalSource = await fs.readFile(servicePath);
  const sourceHash = createHash('sha256').update(originalSource).digest('hex');
  const source = ts.transpileModule(originalSource.toString('utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const workspace: WorkspaceOperationBatchScope['workspace'] = { workspaceId: 'undo-service-boundary', workspaceType: 'personal',
    rootPath: '/no-fixture-filesystem-access', ownerUserId: 'initiator', legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: false, canCreatePublicLinks: false, canManageWorkspace: false } };
  const scope = { workspace, fileOptions: { workspace } };
  let batch: WorkspaceOperationBatchRecord, availabilityFailure: Error | null = null;
  let enqueues = 0, probes = 0, refreshes = 0, lockDepth = 0;
  const store = { WorkspaceOperationBatchError, WorkspaceOperationBatchStore: class {
    async get() { return batch; }
    async enqueue() { enqueues++; return { ...batch, status: 'queued' as const, actionMode: 'undo' as const }; }
  } };
  const dependencies: Record<string, unknown> = {
    'server-only': {}, 'node:crypto': {}, '@/app/lib/db': {},
    '@/app/lib/document-review-availability': { readDocumentReviewAvailability: () => ({ documentReviewEnabled: false, updatedAt: null }) },
    './workspace-operation-batch-store': store,
    './workspace-operation-batch-plan': { workspaceOperationBatchPublicPreview: (plan: WorkspaceOperationBatchPlan) => ({ version: plan.version, planId: plan.planId }) },
    './workspace-mutation-lock': { withWorkspaceMutationLock: async (_id: string, operation: () => Promise<unknown>) => {
      lockDepth++; try { return await operation(); } finally { lockDepth--; }
    } },
    './workspace-operation-batch-executor': { assertWorkspaceOperationBatchUndoAvailable: async () => {
      probes++; assert.equal(lockDepth, 1);
      if (availabilityFailure) throw availabilityFailure;
    } },
    './workspace-operation-review-service': {}, './workspace-operation-batch-approval-fence': {},
  };
  const loaded = { exports: {} as typeof Service };
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (!Object.hasOwn(dependencies, name)) throw new Error('Unexpected service dependency');
    return dependencies[name];
  }, loaded, loaded.exports);
  const select = (version: 1 | 2): void => {
    // No plan execution or decoding is mocked as successful: failure is before
    // enqueue, and the positive case tests only this service's queue contract.
    const plan = { version, workspaceId: workspace.workspaceId, planId: 'a'.repeat(64),
      ...(version === 2 ? { kind: 'native-original-delete' } : {}), actions: [], pathSteps: [], previewContents: [],
    } as unknown as WorkspaceOperationBatchPlan;
    batch = { batchId: 'undo_service_boundary_123456', planId: plan.planId, workspaceId: plan.workspaceId, plan,
      authorization: { mode: 'direct', actorUserId: 'initiator', actorId: 'initiator', actorType: 'user', actorDisplayName: 'Initiator', requestHash: 'b'.repeat(64) },
      status: 'applied', actionMode: 'apply', completedActions: 1, totalActions: 1, phase: 'complete', reviewIds: [], reviewRefs: [],
      reviewerUserId: null, reviewerDisplayName: null, errorCode: null, trashEntryIds: ['original-trash'], leaseOwner: null, createdAt: 1, updatedAt: 2 };
  };
  const invoke = () => loaded.exports.enqueueWorkspaceOperationBatch({ batchId: batch.batchId, planId: batch.planId,
    scope, userId: 'initiator', displayName: 'Initiator', action: 'undo', refreshScope: async () => { refreshes++; return scope; } });
  const denied = async (version: 1 | 2, failureStatus: number, expectedStatus: number, code: string,
    expectedCode = code): Promise<void> => {
    select(version);
    const before = { enqueues, probes, refreshes }, originalBatch = JSON.stringify(batch);
    availabilityFailure = Object.assign(new Error(privateCause, { cause: new Error(privateCause) }), { status: failureStatus, code });
    await assert.rejects(invoke(), (error: unknown) => {
      assert(error instanceof WorkspaceOperationBatchError);
      assert.equal(error.status, expectedStatus); assert.equal(error.code, expectedCode);
      const exposed = JSON.stringify({ status: error.status, code: error.code, message: error.message, cause: error.cause });
      assert(!exposed.includes(privateCause)); assert(!exposed.includes('private-sql-and-credential'));
      return true;
    });
    assert.equal(enqueues, before.enqueues, 'A failed availability check must not enqueue Undo.');
    assert.equal(probes, before.probes + 1); assert.equal(refreshes, before.refreshes + 1);
    assert.equal(JSON.stringify(batch), originalBatch); assert.equal(lockDepth, 0);
  };
  try {
    await denied(2, 503, 503, 'BATCH_JOURNAL_UNAVAILABLE');
    await denied(2, 409, 409, 'BATCH_UNDO_DESTINATION_OCCUPIED');
    await denied(1, 503, 409, 'BATCH_JOURNAL_UNAVAILABLE');
    await denied(2, 503, 503, privateCause, 'BATCH_JOURNAL_UNAVAILABLE');
    select(2); availabilityFailure = null;
    const before = enqueues, queued = await invoke();
    assert.equal(queued.status, 'queued'); assert.equal(enqueues, before + 1); assert.equal(lockDepth, 0);
    assert.equal(createHash('sha256').update(await fs.readFile(servicePath)).digest('hex'), sourceHash);
    completed = true;
  } finally { clearTimeout(watchdog); }
  console.log('native Undo service boundary: 5/5 (native 503/conflict 409, legacy 409, private cause, queue control), source unchanged, complete');
}
void main().catch(() => { console.error('native Undo service boundary failed'); process.exitCode = 1; });

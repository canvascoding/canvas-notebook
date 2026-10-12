import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { resolveExistingWorkspacePath } from '@/app/lib/filesystem/workspace-files';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import { buildWorkspaceOperationBatchPlan } from './workspace-operation-batch-plan';
import { assertWorkspaceHtmlLinkEvidenceCurrent } from './workspace-html-link-evidence-fence';
import { WorkspaceOperationBatchError, WorkspaceOperationBatchStore,
  type WorkspaceOperationBatchRecord } from './workspace-operation-batch-store';
import type { WorkspaceOperationBatchAction, WorkspaceOperationBatchScope,
  WorkspaceOperationDirectAuthorization } from './workspace-operation-batch-contract';

export type WorkspacePathOperationInput = {
  scope: WorkspaceOperationBatchScope;
  kind: 'move' | 'rename' | 'delete';
  selections: Array<{ sourcePath: string; destinationPath?: string }>;
  overwrite?: boolean;
  ignoreMissing?: boolean;
  expectedPlanId?: string;
  idempotencyKey?: string;
  actorUserId: string;
  actorId: string;
  actorDisplayName: string;
  actorType: 'user' | 'agent';
  actorSessionId?: string;
};

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const batchIdFor = (input: WorkspacePathOperationInput) => input.idempotencyKey
  ? hash(['workspace-path-operation-id-v1', input.scope.workspace.workspaceId, input.actorUserId, input.idempotencyKey])
  : randomUUID();
type PlanDependencies = { buildPlan?: typeof buildWorkspaceOperationBatchPlan;
  existingPath?: typeof resolveExistingWorkspacePath; pathIsFile?: (absolutePath: string) => Promise<boolean> };
const pathIsFile = async (absolutePath: string) => (await fs.lstat(absolutePath)).isFile();

/** Preview identity follows the requested final state, independently of a durable job ID. */
export async function buildWorkspacePathOperationPlan(input: Pick<WorkspacePathOperationInput,
  'scope' | 'kind' | 'selections' | 'overwrite' | 'ignoreMissing'>,
dependencies: PlanDependencies = {}) {
  const actionId = hash(['workspace-path-action-v1', input.scope.workspace.workspaceId, input.kind,
    input.selections.map((selection) => ({ sourcePath: selection.sourcePath,
      ...(selection.destinationPath === undefined ? {} : { destinationPath: selection.destinationPath }) })),
    Boolean(input.overwrite), Boolean(input.ignoreMissing)]);
  const actions: WorkspaceOperationBatchAction[] = [];
  if (input.overwrite) {
    const destinations: string[] = [];
    for (const selection of input.selections) {
      if (!selection.destinationPath) throw new WorkspaceOperationBatchError('BATCH_INVALID_REQUEST', 422, 'A destination is required.');
      try {
        const resolve = dependencies.existingPath ?? resolveExistingWorkspacePath;
        const destination = await resolve(selection.destinationPath, input.scope.fileOptions);
        const source = await resolve(selection.sourcePath, input.scope.fileOptions);
        const isFile = dependencies.pathIsFile ?? pathIsFile;
        if (!await isFile(destination) || !await isFile(source)) {
          throw new WorkspaceOperationBatchError('BATCH_OVERWRITE_REQUIRES_FILES', 409,
            'Only an existing file can be replaced by another file.');
        }
        destinations.push(selection.destinationPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (destinations.length) actions.push({ reviewId: `${actionId}-replace`, kind: 'delete',
      selections: [...new Set(destinations)].map((sourcePath) => ({ sourcePath })) });
  }
  actions.push({ reviewId: `${actionId}-request`, kind: input.kind, selections: input.selections,
    ...(input.ignoreMissing ? { ignoreMissing: true } : {}) });
  return (dependencies.buildPlan ?? buildWorkspaceOperationBatchPlan)({ scope: input.scope, actions });
}

/** The request is authorized once; the durable worker rechecks authority before every mutation. */
export async function submitDirectWorkspacePathOperation(input: WorkspacePathOperationInput,
  dependencies: PlanDependencies & { store?: WorkspaceOperationBatchStore; lock?: typeof withWorkspaceMutationLock;
    htmlEvidenceCurrent?: typeof assertWorkspaceHtmlLinkEvidenceCurrent } = {},
): Promise<WorkspaceOperationBatchRecord> {
  const workspace = input.scope.workspace;
  if (!workspace.permissions.canRead || !workspace.permissions.canWrite || !workspace.permissions.canDelete
    || input.scope.fileOptions.workspace && input.scope.fileOptions.workspace.workspaceId !== workspace.workspaceId
    || workspace.status && workspace.status !== 'active') {
    throw new WorkspaceOperationBatchError('BATCH_ACCESS_DENIED', 403, 'Current workspace permissions are required.');
  }
  if (!input.selections.length || input.selections.length > 1000 || input.overwrite && input.kind === 'delete'
    || input.ignoreMissing && input.kind !== 'delete'
    || input.idempotencyKey !== undefined && (!input.idempotencyKey || input.idempotencyKey.length > 512)) {
    throw new WorkspaceOperationBatchError('BATCH_INVALID_REQUEST', 422, 'Invalid file action request.');
  }
  const selections = input.selections.map((selection) => ({ sourcePath: selection.sourcePath,
    ...(selection.destinationPath === undefined ? {} : { destinationPath: selection.destinationPath }) }));
  const requestHash = hash(['workspace-path-operation-v1', workspace.workspaceId, input.kind, selections,
    Boolean(input.overwrite), Boolean(input.ignoreMissing), input.expectedPlanId ?? null, input.actorUserId, input.actorType, input.actorId,
    input.actorSessionId ?? null]);
  const batchId = batchIdFor(input);
  const authorization: WorkspaceOperationDirectAuthorization = { mode: 'direct', actorUserId: input.actorUserId,
    actorId: input.actorId, actorDisplayName: input.actorDisplayName, actorType: input.actorType,
    ...(input.actorSessionId ? { actorSessionId: input.actorSessionId } : {}), requestHash };
  const store = dependencies.store ?? new WorkspaceOperationBatchStore();
  return (dependencies.lock ?? withWorkspaceMutationLock)(workspace.workspaceId, async () => {
    // An acknowledged retry must return the original outcome, even if its source has moved already.
    const known = await store.get(batchId);
    if (known) return store.createDirect({ batchId, plan: known.plan, authorization });
    const plan = await buildWorkspacePathOperationPlan({ ...input, selections }, dependencies);
    if (input.expectedPlanId && input.expectedPlanId !== plan.planId) {
      throw new WorkspaceOperationBatchError('PREVIEW_STALE', 409, 'The file action preview changed.');
    }
    if (plan.readiness === 'ready') await (dependencies.htmlEvidenceCurrent ?? assertWorkspaceHtmlLinkEvidenceCurrent)(plan, input.scope);
    return store.createDirect({ batchId, plan, authorization });
  });
}

/** Waiting is bounded: slow jobs remain durable and visible after the HTTP request ends. */
export async function waitForWorkspacePathOperation(batch: WorkspaceOperationBatchRecord, waitMs = 20_000,
  store = new WorkspaceOperationBatchStore()): Promise<WorkspaceOperationBatchRecord> {
  const deadline = Date.now() + waitMs;
  while (['queued', 'applying'].includes(batch.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    batch = await store.get(batch.batchId) ?? batch;
  }
  return batch;
}

/** Resolve acknowledged tool retries before inspecting a source that the job may have moved/deleted. */
export async function getExistingDirectWorkspacePathOperation(input: WorkspacePathOperationInput,
  store = new WorkspaceOperationBatchStore()): Promise<WorkspaceOperationBatchRecord | null> {
  if (!input.idempotencyKey) return null;
  const batchId = batchIdFor(input);
  if (!await store.get(batchId)) return null;
  // Reenter the common request validation; a matching key alone never authorizes another actor/request.
  return submitDirectWorkspacePathOperation(input, { store });
}

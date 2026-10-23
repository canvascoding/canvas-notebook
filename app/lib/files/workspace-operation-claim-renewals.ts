import 'server-only';

import type { WorkspaceOperationBatchRecord, WorkspaceOperationBatchStore } from './workspace-operation-batch-store';

/** Existing worker lease mechanics shared by fixed synchronous services.
 * These hooks schedule a genuine Store claim; they confer no actor authority.
 * Owner phases pause/drain them through the existing claim scheduler. */
export function createWorkspaceOperationClaimRenewals(store: WorkspaceOperationBatchStore,
  batch: WorkspaceOperationBatchRecord) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let leaseLost = false;
  let renewal: Promise<void> | undefined;
  let renewalsOpen = false;
  const pauseAndDrain = async () => {
    renewalsOpen = false;
    if (timer) { clearInterval(timer); timer = undefined; }
    await renewal;
  };
  const start = () => {
    renewalsOpen = true;
    timer = setInterval(() => {
      if (!renewalsOpen || renewal) return;
      const pending = store.heartbeatClaim(batch).then((owned) => { if (!owned) leaseLost = true; })
        .catch(() => { leaseLost = true; }).finally(() => { if (renewal === pending) renewal = undefined; });
      renewal = pending;
    }, 20_000);
    timer.unref?.();
  };
  return Object.freeze({ start, pauseAndDrain,
    hasLeaseLost: () => leaseLost,
    resume: async () => {
      if (leaseLost || !await store.heartbeatClaim(batch)) throw new Error('BATCH_LEASE_LOST');
      start();
    },
  });
}

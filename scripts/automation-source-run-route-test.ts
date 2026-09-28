import assert from 'node:assert/strict';
import Module from 'node:module';

import type { AutomationRunRecord } from '../app/lib/automations/types';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const internals = Module as typeof Module & { _load: LoadFn };
const originalLoad = internals._load;
let allowSnapshot = true;
let allowCurrentWorkspace = true;
const diagnostics = [{ kind: 'schedule_misfire', scheduledFor: '2026-09-28T09:00:00.000Z',
  observedAt: '2026-09-28T09:02:00.000Z', nextRunAt: '2026-09-29T09:00:00.000Z',
  reason: 'scheduler_downtime' }];
const run = {
  id: 'run', jobId: 'job', metadataJson: {
    automationSources: { version: 1, sources: [{ sourceJobId: 'secret-source', sourceRunId: 'secret-run' }] },
    automationContinuity: { sourceRunId: 'own-run' },
    automationContext: { sourceRunId: 'own-run', sources: [{ sourceJobId: 'secret-source',
      sourceRunId: 'secret-run', reason: 'included' }] },
  },
} as unknown as AutomationRunRecord;

internals._load = (request, parent, isMain) => {
  if (parent?.filename.includes('/api/automations/') && request === '@/app/lib/automations/api') {
    return { requireAutomationSession: async () => ({ session: { user: { id: 'viewer' } }, response: null }),
      applyAutomationRateLimit: () => ({ ok: true }) };
  }
  if (parent?.filename.includes('/api/automations/') && request === '@/app/lib/automations/policy') {
    return { assertCanAccessAutomationJob: async () => undefined,
      assertCanAccessAutomationRun: async () => {
        if (!allowSnapshot) throw new Error('Old workspace access revoked.');
      },
      canAccessAutomationRun: async (_userId: string, target: { id?: string }) => target.id
        ? allowSnapshot : allowCurrentWorkspace };
  }
  if (parent?.filename.includes('/api/automations/') && request === '@/app/lib/automations/store') {
    return { getAutomationJob: async () => ({ id: 'job', scope: 'personal', jobScope: 'personal:viewer:current-workspace', organizationId: 'org',
      workspaceId: 'current-workspace', ownerUserId: 'viewer', createdByUserId: 'viewer' }),
      getAutomationRun: async () => run, listAutomationRuns: async () => [run],
      listAutomationScheduleSkipDiagnostics: async (authorizedJob: { jobScope: string }) => {
        assert.equal(authorizedJob.jobScope, 'personal:viewer:current-workspace');
        return diagnostics;
      } };
  }
  return originalLoad(request, parent, isMain);
};

async function main(): Promise<void> {
  try {
    const { projectAutomationRunForApi } = await import('../app/lib/automations/public-run');
    const projected = projectAutomationRunForApi(run);
    assert.equal(projected.metadataJson?.automationSources, undefined);
    assert.equal(projected.metadataJson?.automationContinuity, undefined);
    assert.equal(((projected.metadataJson?.automationContext as { sources: Array<{ sourceRunId: string | null }> })
      .sources[0]).sourceRunId, null);
    assert.equal((run.metadataJson?.automationSources as { sources: Array<{ sourceRunId: string }> })
      .sources[0].sourceRunId, 'secret-run', 'public projection must not mutate retry pin');

    const detail = await import('../app/api/automations/runs/[runId]/route');
    const list = await import('../app/api/automations/jobs/[jobId]/runs/route');
    const mobileList = await import('../app/api/mobile/v1/automations/jobs/[jobId]/runs/route');
    const request = { headers: new Headers() } as never;
    const detailContext = { params: Promise.resolve({ runId: 'run' }) };
    const listContext = { params: Promise.resolve({ jobId: 'job' }) };
    const detailResponse = await detail.GET(request, detailContext);
    assert.equal(detailResponse.status, 200);
    const detailBody = await detailResponse.json();
    assert.equal(detailBody.data.metadataJson.automationSources, undefined);
    assert.equal(detailBody.data.metadataJson.automationContext.sources[0].sourceRunId, null);
    const listResponse = await list.GET(request, listContext);
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.equal(listBody.data[0].metadataJson.automationSources, undefined);
    assert.deepEqual(listBody.diagnostics, diagnostics,
      'skip diagnostics are additive siblings, not fabricated run records');
    assert.deepEqual((await (await mobileList.GET(request, listContext)).json()).diagnostics, diagnostics,
      'mobile and web expose the same scoped diagnostic contract');

    allowSnapshot = false;
    assert.equal((await detail.GET(request, detailContext)).status, 404,
      'moving a job must not grant access to an old workspace run');
    const historicalDenied = await list.GET(request, listContext);
    assert.equal(historicalDenied.status, 200);
    assert.deepEqual((await historicalDenied.json()).data, []);
    allowCurrentWorkspace = false;
    const currentDenied = await list.GET(request, listContext);
    assert.equal(currentDenied.status, 200, 'historical run listing keeps its previous access behavior');
    assert.deepEqual((await currentDenied.json()).diagnostics, [],
      'skip diagnostics require current workspace read access');
  } finally {
    internals._load = originalLoad;
  }
}

main().then(() => console.log('automation-source-run-route-test: ok')).catch((error) => {
  internals._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});

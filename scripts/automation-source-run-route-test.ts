import assert from 'node:assert/strict';
import Module from 'node:module';

import type { AutomationRunRecord } from '../app/lib/automations/types';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const internals = Module as typeof Module & { _load: LoadFn };
const originalLoad = internals._load;
let allowSnapshot = true;
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
      canAccessAutomationRun: async () => allowSnapshot };
  }
  if (parent?.filename.includes('/api/automations/') && request === '@/app/lib/automations/store') {
    return { getAutomationJob: async () => ({ id: 'job' }), getAutomationRun: async () => run,
      listAutomationRuns: async () => [run] };
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
    assert.equal((await listResponse.json()).data[0].metadataJson.automationSources, undefined);

    allowSnapshot = false;
    assert.equal((await detail.GET(request, detailContext)).status, 404,
      'moving a job must not grant access to an old workspace run');
    assert.deepEqual((await (await list.GET(request, listContext)).json()).data, []);
  } finally {
    internals._load = originalLoad;
  }
}

main().then(() => console.log('automation-source-run-route-test: ok')).catch((error) => {
  internals._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});

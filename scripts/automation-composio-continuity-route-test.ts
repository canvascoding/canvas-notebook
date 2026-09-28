import assert from 'node:assert/strict';
import Module from 'node:module';

import { NextRequest } from 'next/server';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const internals = Module as typeof Module & { _load: LoadFn };
const originalLoad = internals._load;
let createdJobInput: Record<string, unknown> | null = null;
let rejectJob = false;
let deletedTriggerId: string | null = null;
let existingTriggerJob = false;

internals._load = (request, parent, isMain) => {
  if (parent?.filename.endsWith('/api/composio/triggers/route.ts')) {
    if (request === '@/app/lib/automations/api') return {
      requireAutomationSession: async () => ({ session: { user: { id: 'owner' } }, response: null }),
      assertCanCreateRequestedAutomation: async () => undefined,
      getAutomationRouteErrorStatus: (error: { status?: number }) => error.status ?? 500,
    };
    if (request === '@/app/lib/automations/store') return {
      createWebhookAutomationJob: async (input: Record<string, unknown>) => {
        createdJobInput = input;
        if (rejectJob) throw Object.assign(new Error('Source unavailable.'), { status: 404 });
        return { id: 'job', ...input };
      },
      getAutomationJobByComposioTriggerId: async () => existingTriggerJob ? { id: 'existing' } : null,
    };
    if (request === '@/app/lib/automations/presentation') return {
      presentAutomationJobForViewer: (job: unknown) => job,
    };
    if (request === '@/app/lib/composio/composio-gateway') return {
      createGatewayTrigger: async () => ({ trigger: { triggerId: 'gateway-1', triggerSlug: 'new_email',
        toolkitSlug: 'gmail', connectedAccountId: 'account-1' } }),
      deleteGatewayTrigger: async (triggerId: string) => { deletedTriggerId = triggerId; },
    };
    if (request === '@/app/lib/composio/composio-context') return {
      resolveComposioContext: async () => ({ profileId: 'profile-1', composioUserId: 'composio-user' }),
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main(): Promise<void> {
  try {
    const { POST } = await import('../app/api/composio/triggers/route');
    const request = new NextRequest('http://localhost/api/composio/triggers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Mail digest', prompt: 'Summarize', triggerSlug: 'new_email',
        toolkitSlug: 'gmail', continuityMode: 'last_relevant', sourceJobIds: ['upstream'] }),
    });
    const response = await POST(request);
    assert.equal(response.status, 201);
    assert.equal(createdJobInput?.continuityMode, 'last_relevant');
    assert.deepEqual(createdJobInput?.sourceJobIds, ['upstream']);
    assert.equal((await response.json()).data.job.sourceJobIds[0], 'upstream');
    rejectJob = true;
    const rejected = await POST(new NextRequest('http://localhost/api/composio/triggers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Mail digest', prompt: 'Summarize', triggerSlug: 'new_email',
        toolkitSlug: 'gmail', sourceJobIds: ['missing'] }),
    }));
    assert.equal(rejected.status, 404);
    assert.equal(deletedTriggerId, 'gateway-1', 'failed job creation must remove the external trigger');
    deletedTriggerId = null;
    existingTriggerJob = true;
    await POST(new NextRequest('http://localhost/api/composio/triggers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Mail digest', prompt: 'Summarize', triggerSlug: 'new_email',
        toolkitSlug: 'gmail', sourceJobIds: ['missing'] }),
    }));
    assert.equal(deletedTriggerId, null, 'an already-bound trigger must be preserved');
  } finally {
    internals._load = originalLoad;
  }
}

main().then(() => console.log('automation-composio-continuity-route-test: ok')).catch((error) => {
  internals._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});

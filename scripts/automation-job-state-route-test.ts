import assert from 'node:assert/strict';
import Module from 'node:module';

import { NextRequest } from 'next/server';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const internals = Module as typeof Module & { _load: LoadFn };
const originalLoad = internals._load;
const entry = { key: 'cursor', value: 'private-value', revision: 3, updatedAt: '2026-09-28T10:00:00.000Z' };
const auditEvents: Record<string, unknown>[] = [];
let authenticated = true;
let rateLimited = false;
let denyAccess = false;
let stateExists = true;

class StateError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

internals._load = (request, parent, isMain) => {
  if (parent?.filename.endsWith('/automations/jobs/[jobId]/state/route.ts')) {
    if (request === '@/app/lib/automations/api') return {
      requireAutomationSession: async () => authenticated
        ? { session: { user: { id: 'owner' } }, response: null }
        : { session: null, response: Response.json({ success: false }, { status: 401 }) },
      applyAutomationRateLimit: () => rateLimited
        ? { ok: false, response: Response.json({ success: false }, { status: 429 }) }
        : { ok: true },
    };
    if (request === '@/app/lib/automations/job-state-store') return {
      AutomationJobStateError: StateError,
      listAutomationJobState: async (_jobId: string, access: unknown) => {
        assert.deepEqual(access, { kind: 'user', userId: 'owner' });
        if (denyAccess) throw new StateError('hidden access detail', 'ACCESS_DENIED');
        return [{ key: entry.key, revision: entry.revision, updatedAt: entry.updatedAt }];
      },
      getAutomationJobState: async (_jobId: string, key: string, access: unknown) => {
        assert.equal(key, entry.key);
        assert.deepEqual(access, { kind: 'user', userId: 'owner' });
        if (denyAccess) throw new StateError('hidden access detail', 'ACCESS_DENIED');
        return stateExists ? entry : null;
      },
      mutateAutomationJobState: async (input: Record<string, unknown>) => {
        assert.deepEqual(input, { jobId: 'job', key: 'cursor', action: 'delete',
          expectedRevision: 3, mutationId: 'reset-1', access: { kind: 'user', userId: 'owner' } });
        if (denyAccess) throw new StateError('hidden access detail', 'ACCESS_DENIED');
        return { action: 'delete', key: 'cursor', previousRevision: 3 };
      },
    };
    if (request === '@/app/lib/automations/store') return { getAutomationJob: async () => ({
      organizationId: 'org', workspaceId: 'workspace', agentId: null,
    }) };
    if (request === '@/app/lib/audit/audit-service') return { recordAuditEvent: async (event: Record<string, unknown>) => {
      auditEvents.push(event);
    } };
  }
  return originalLoad(request, parent, isMain);
};

async function main(): Promise<void> {
  try {
    const route = await import('../app/api/automations/jobs/[jobId]/state/route');
    const context = { params: Promise.resolve({ jobId: 'job' }) };
    const request = (suffix = '', init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(
      `http://localhost/api/automations/jobs/job/state${suffix}`, init,
    );

    const listed = await route.GET(request(), context);
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).data, [{ key: 'cursor', revision: 3, updatedAt: entry.updatedAt }]);
    assert.equal((await route.GET(request('?key=cursor'), context)).status, 200);
    stateExists = false;
    assert.equal((await route.GET(request('?key=cursor'), context)).status, 404);
    stateExists = true;

    denyAccess = true;
    const denied = await route.GET(request(), context);
    assert.equal(denied.status, 404);
    assert.equal((await denied.json()).error, 'Automation not found.');
    denyAccess = false;
    rateLimited = true;
    assert.equal((await route.GET(request(), context)).status, 429);
    rateLimited = false;
    authenticated = false;
    assert.equal((await route.GET(request(), context)).status, 401);
    authenticated = true;

    const deleted = await route.DELETE(request('', { method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'cursor', expectedRevision: 3, mutationId: 'reset-1' }) }), context);
    assert.equal(deleted.status, 200);
    assert.deepEqual((await deleted.json()).data, { action: 'delete', key: 'cursor', previousRevision: 3 });
    assert.equal(auditEvents.length, 1);
    assert.equal(JSON.stringify(auditEvents[0]).includes('private-value'), false);
    assert.equal((auditEvents[0].metadata as { key: string }).key, 'cursor');
    const invalid = await route.DELETE(request('', { method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'cursor', expectedRevision: 3, mutationId: 'reset-1', value: 'private-value' }) }), context);
    assert.equal(invalid.status, 400);
    assert.equal(auditEvents.length, 1);
  } finally {
    internals._load = originalLoad;
  }
}

main().then(() => console.log('automation-job-state-route-test: ok')).catch((error) => {
  internals._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});

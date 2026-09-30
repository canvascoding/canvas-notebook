import assert from 'node:assert/strict';
import Module from 'node:module';

import { eq } from 'drizzle-orm';

import { createPiTestDatabase } from './helpers/pi-test-database';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const internals = Module as typeof Module & { _load: LoadFn };
const originalLoad = internals._load;
let testDatabase: Awaited<ReturnType<typeof createPiTestDatabase>> | undefined;
let allowedWorkspaceId: string | null = 'workspace-a';
process.env.BETTER_AUTH_BASE_URL ??= 'http://localhost:3001';

internals._load = (request, parent, isMain) => {
  if (testDatabase && (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request))) {
    return testDatabase;
  }
  if (request === './policy' && parent?.filename.includes('/automations/')) {
    return { canAccessAutomationJob: async (userId: string, job: { ownerUserId?: string | null; createdByUserId: string }) =>
      (job.ownerUserId || job.createdByUserId) === userId };
  }
  if (request === '@/app/lib/pi/session-workspace-context' && parent?.filename.includes('/automations/')) {
    return { resolveAgentSessionWorkspaceForUser: async ({ userId, workspaceId }: {
      userId: string; workspaceId: string;
    }) => {
      if (userId !== 'owner' || workspaceId !== allowedWorkspaceId) {
        throw new Error('Workspace access denied.');
      }
      return { workspaceId };
    } };
  }
  return originalLoad(request, parent, isMain);
};

async function main(): Promise<void> {
  testDatabase = await createPiTestDatabase();
  try {
    const { db } = testDatabase;
    const { automationJobs, automationJobState, automationRuns, canvasOrganizationSettings, canvasWorkspaces, user } =
      await import('../app/lib/db/schema');
    const { getAutomationSourceResults, markAutomationRunStarted, moveAutomationJobToWorkspace,
      updateAutomationJob } = await import('../app/lib/automations/store');
    const { getAutomationJobState, listAutomationJobState, mutateAutomationJobState } =
      await import('../app/lib/automations/job-state-store');
    const { AutomationMutationError } = await import('../app/lib/automations/mutation-errors');

    const now = new Date();
    await db.insert(user).values({ id: 'owner', name: 'Owner', email: 'scope-owner@example.test',
      emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(canvasOrganizationSettings).values({ organizationId: 'org', ownerUserId: 'owner',
      deploymentMode: 'single_user', teamFeaturesEnabled: false, createdAt: now, updatedAt: now });
    for (const id of ['workspace-a', 'workspace-b']) {
      await db.insert(canvasWorkspaces).values({ id, organizationId: 'org', type: 'personal',
        ownerUserId: 'owner', rootRelativePath: `${id}/files`, displayName: id,
        workspaceIcon: 'folder', status: 'active', isDefault: id === 'workspace-a',
        createdAt: now, updatedAt: now });
    }
    const job = (id: string, workspaceId: string) => ({
      id, name: id, status: 'active', integrityStatus: 'valid', scope: 'personal',
      jobScope: `personal:owner:${workspaceId}`, organizationId: 'org', workspaceId,
      workspaceType: 'personal', ownerUserId: 'owner', responsibleUserId: 'owner',
      prompt: id, preferredSkill: 'auto', workspaceContextPathsJson: '[]',
      scheduleKind: 'daily', scheduleConfigJson: '{"kind":"daily","times":["09:00"],"timeZone":"UTC"}',
      timeZone: 'UTC', createdByUserId: 'owner', createdAt: now, updatedAt: now,
    } as const);
    await db.insert(automationJobs).values([job('target', 'workspace-a'), job('foreign-source', 'workspace-b')]);

    await assert.rejects(
      updateAutomationJob('target', { sourceJobIds: ['foreign-source'] }, { actorUserId: 'owner' }),
      (error: unknown) => error instanceof AutomationMutationError && error.status === 404,
      'configuration must reject a source in another workspace',
    );

    // Even a damaged stored configuration must not expose a foreign result at run time.
    await db.update(automationJobs).set({ sourceJobIdsJson: '["foreign-source"]' })
      .where(eq(automationJobs.id, 'target'));
    await db.insert(automationRuns).values({ id: 'foreign-result', jobId: 'foreign-source', status: 'success',
      scope: 'personal', jobScope: 'personal:owner:workspace-b', organizationId: 'org',
      workspaceId: 'workspace-b', workspaceType: 'personal', actorType: 'user', actorUserId: 'owner',
      triggerType: 'manual', attemptNumber: 1, resultText: 'Private workspace B result',
      piSessionId: 'foreign-session', finishedAt: now, createdAt: now });
    await db.insert(automationRuns).values({ id: 'target-run', jobId: 'target', status: 'pending',
      scope: 'personal', jobScope: 'personal:owner:workspace-a', organizationId: 'org',
      workspaceId: 'workspace-a', workspaceType: 'personal', actorType: 'user', actorUserId: 'owner',
      triggerType: 'manual', attemptNumber: 1, createdAt: new Date(now.getTime() + 1_000) });
    const started = await markAutomationRunStarted('target-run', {
      outputDir: null, targetOutputPath: null, effectiveTargetOutputPath: null,
      logPath: '', resultPath: null, piSessionId: 'target-session', eventsLog: [], expectedAttemptNumber: 1,
    });
    const pin = started?.metadataJson?.automationSources as {
      sources: Array<{ sourceRunId: string | null; reason: string | null }>;
    };
    assert.deepEqual(pin.sources, [{ sourceJobId: 'foreign-source', sourceRunId: null,
      reason: 'source_scope_changed' }]);
    const sourceScope = { runId: 'target-run', jobId: 'target', actorUserId: 'owner',
      workspaceId: 'workspace-a', workspaceType: 'personal', organizationId: 'org' };
    const [blockedSource] = await getAutomationSourceResults(sourceScope);
    assert.equal(blockedSource.reason, 'source_scope_changed');
    assert.equal(blockedSource.resultText, null);
    assert.equal(blockedSource.sourceJobName, null);
    assert.equal(blockedSource.sourceRunId, null);

    const access = { kind: 'user' as const, userId: 'owner' };
    await db.insert(automationJobState).values([
      { jobId: 'target', jobScope: 'personal:owner:workspace-b', key: 'stale',
        value: 'Private state from B', revision: 1, updatedAt: now },
      { jobId: 'target', jobScope: 'personal:owner:workspace-a', key: 'current',
        value: 'Visible state from A', revision: 1, updatedAt: now },
    ]);
    assert.deepEqual((await listAutomationJobState('target', access)).map((entry) => entry.key), ['current']);
    assert.equal(await getAutomationJobState('target', 'stale', access), null);
    assert.equal((await getAutomationJobState('target', 'current', access))?.value, 'Visible state from A');
    await mutateAutomationJobState({ jobId: 'target', key: 'new', value: 'New state',
      action: 'set', expectedRevision: null, mutationId: 'scope-cleanup', access });
    assert.equal((await db.select().from(automationJobState).where(eq(automationJobState.key, 'stale'))).length, 0,
      'a write removes state left behind by an old scope');

    allowedWorkspaceId = null;
    await assert.rejects(getAutomationJobState('target', 'current', access), { code: 'ACCESS_DENIED' });
    await assert.rejects(listAutomationJobState('target', access), { code: 'ACCESS_DENIED' });
    await assert.rejects(mutateAutomationJobState({ jobId: 'target', key: 'new', value: 'Denied',
      action: 'set', expectedRevision: 1, mutationId: 'scope-denied', access }), { code: 'ACCESS_DENIED' });
    allowedWorkspaceId = 'workspace-a';

    await db.update(automationRuns).set({ status: 'success', finishedAt: new Date() })
      .where(eq(automationRuns.id, 'target-run'));
    const target = {
      scope: 'personal' as const, organizationId: 'org', workspaceId: 'workspace-b',
      workspaceType: 'personal' as const, ownerUserId: 'owner', responsibleUserId: 'owner',
      serviceActorId: null, approvedByUserId: null, lastEditedByUserId: 'owner',
      workspace: { workspaceId: 'workspace-b', workspaceType: 'personal' as const,
        organizationId: 'org', customerId: null, projectId: null },
    };
    await moveAutomationJobToWorkspace('target', target as never,
      { actorUserId: 'owner', responsibleUserId: 'owner' });
    allowedWorkspaceId = 'workspace-b';
    assert.deepEqual(await listAutomationJobState('target', access), []);
    assert.equal((await getAutomationSourceResults(sourceScope))[0]?.reason, 'target_scope_changed',
      'a historic run from workspace A must not be read in the moved job scope');
  } finally {
    await testDatabase.close();
    internals._load = originalLoad;
  }
}

main().then(() => console.log('automation-workspace-scope-test: ok')).catch((error) => {
  internals._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});

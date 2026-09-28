import assert from 'node:assert/strict';
import Module from 'node:module';

import { eq } from 'drizzle-orm';

import { createPiTestDatabase } from './helpers/pi-test-database';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const internals = Module as typeof Module & { _load: LoadFn };
const originalLoad = internals._load;
let testDatabase: Awaited<ReturnType<typeof createPiTestDatabase>> | undefined;
process.env.BETTER_AUTH_BASE_URL ??= 'http://localhost:3001';

internals._load = (request, parent, isMain) => {
  if (testDatabase && (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request))) {
    return testDatabase;
  }
  if (parent?.filename.endsWith('/automations/store.ts') && request === './policy') {
    return { canAccessAutomationJob: async (userId: string, job: { ownerUserId?: string | null; createdByUserId: string }) =>
      (job.ownerUserId || job.createdByUserId) === userId };
  }
  if (parent?.filename.endsWith('/automations/store.ts')
    && request === '@/app/lib/pi/session-workspace-context') {
    return { resolveAgentSessionWorkspaceForUser: async ({ userId }: { userId: string }) => {
      if (userId !== 'owner') throw new Error('Workspace access denied.');
      return {};
    } };
  }
  return originalLoad(request, parent, isMain);
};

async function main(): Promise<void> {
  testDatabase = await createPiTestDatabase();
  try {
    const { db } = testDatabase;
    const { automationJobs, automationRuns, canvasOrganizationSettings, canvasWorkspaces, user } =
      await import('../app/lib/db/schema');
    const { getAutomationJob, getAutomationPreviousRelevantResult, getAutomationSourceResults, markAutomationRunStarted,
      markAutomationRunRetryScheduled, moveAutomationJobToWorkspace, updateAutomationJob } =
      await import('../app/lib/automations/store');
    const { composeAutomationSourceResults, getAutomationTotalContextTokenBudget } =
      await import('../app/lib/automations/context-composer');
    const now = new Date();
    await db.insert(user).values({ id: 'owner', name: 'Owner', email: 'source-owner@example.test',
      emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(user).values({ id: 'executor', name: 'Executor', email: 'source-executor@example.test',
      emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(canvasOrganizationSettings).values({ organizationId: 'org', ownerUserId: 'owner',
      deploymentMode: 'single_user', teamFeaturesEnabled: false, createdAt: now, updatedAt: now });
    for (const id of ['a', 'b']) {
      await db.insert(canvasWorkspaces).values({ id, organizationId: 'org', type: 'personal',
        ownerUserId: 'owner', rootRelativePath: `${id}/files`, displayName: id,
        workspaceIcon: 'folder', status: 'active', isDefault: id === 'a',
        createdAt: now, updatedAt: now });
    }
    const job = (id: string, workspaceId = 'a') => ({
      id, name: id, status: 'active', integrityStatus: 'valid', scope: 'personal',
      jobScope: `personal:owner:${workspaceId}`, organizationId: 'org', workspaceId,
      workspaceType: 'personal', ownerUserId: 'owner', responsibleUserId: 'owner',
      prompt: id, preferredSkill: 'auto', workspaceContextPathsJson: '[]',
      scheduleKind: 'daily', scheduleConfigJson: '{"kind":"daily","times":["09:00"],"timeZone":"UTC"}',
      timeZone: 'UTC', createdByUserId: 'owner', createdAt: now, updatedAt: now,
    } as const);
    await db.insert(automationJobs).values([job('target'), job('source'), job('cross', 'b')]);
    await db.insert(automationJobs).values({ ...job('delegated-target'), responsibleUserId: 'executor' });
    await assert.rejects(updateAutomationJob('delegated-target', { sourceJobIds: ['source'] },
      { actorUserId: 'owner' }), /unavailable or not accessible/);
    await assert.rejects(updateAutomationJob('target', { sourceJobIds: ['cross'] }, { actorUserId: 'owner' }),
      /unavailable or not accessible/);
    assert.deepEqual((await updateAutomationJob('target', { sourceJobIds: ['source'] }, { actorUserId: 'owner' }))?.sourceJobIds, ['source']);
    await assert.rejects(updateAutomationJob('source', { sourceJobIds: ['target'] }, { actorUserId: 'owner' }), /cycle/);
    await assert.rejects(updateAutomationJob('target', { sourceJobIds: ['target'] }, { actorUserId: 'owner' }), /cycle/);
    await assert.rejects(updateAutomationJob('target', { sourceJobIds: ['source', 'source'] }, { actorUserId: 'owner' }), /unique/);
    await db.insert(automationJobs).values([job('parallel-a'), job('parallel-b')]);
    const parallel = await Promise.allSettled([
      updateAutomationJob('parallel-a', { sourceJobIds: ['parallel-b'] }, { actorUserId: 'owner' }),
      updateAutomationJob('parallel-b', { sourceJobIds: ['parallel-a'] }, { actorUserId: 'owner' }),
    ]);
    assert.equal(parallel.filter((result) => result.status === 'fulfilled').length, 1,
      'concurrent opposing edges must not both commit');
    assert.match(String((parallel.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason), /cycle/);
    const parallelA = await getAutomationJob('parallel-a');
    const parallelB = await getAutomationJob('parallel-b');
    assert.equal((parallelA?.sourceJobIds.length || 0) + (parallelB?.sourceJobIds.length || 0), 1);

    const run = (id: string, jobId: string, status: 'pending' | 'success', resultText: string | null,
      createdAt: Date, metadataJson: string | null = null) => db.insert(automationRuns).values({
      id, jobId, status, scope: 'personal', jobScope: 'personal:owner:a',
      organizationId: 'org', workspaceId: 'a', workspaceType: 'personal',
      actorType: 'user', actorUserId: 'owner', triggerType: 'manual', attemptNumber: 1,
      resultText, finishedAt: status === 'success' ? createdAt : null,
      metadataJson, piSessionId: `session-${id}`, createdAt,
    });
    await run('source-success', 'source', 'success', 'Useful result ' + 'x'.repeat(3_000),
      new Date(now.getTime() - 10_000), JSON.stringify({ automation: { outcome: 'message' } }));
    await run('source-noop', 'source', 'success', 'NO_ACTION',
      new Date(now.getTime() - 5_000), JSON.stringify({ automation: { outcome: 'no_action' } }));
    await run('target-run', 'target', 'pending', null, now);
    const started = await markAutomationRunStarted('target-run', {
      outputDir: null, targetOutputPath: null, effectiveTargetOutputPath: null,
      logPath: '', resultPath: null, piSessionId: 'target-session', eventsLog: [], expectedAttemptNumber: 1,
    });
    const pin = started?.metadataJson?.automationSources as { sources: Array<{ sourceRunId: string | null }> };
    assert.equal(pin.sources[0]?.sourceRunId, 'source-success');
    const scope = { runId: 'target-run', jobId: 'target', actorUserId: 'owner',
      workspaceId: 'a', workspaceType: 'personal', organizationId: 'org' };
    assert.equal((await getAutomationSourceResults(scope))[0]?.sourceRunId, 'source-success');
    await run('source-newer', 'source', 'success', 'Newer result', new Date(now.getTime() - 1_000));
    await markAutomationRunRetryScheduled('target-run', new Date(now.getTime() + 60_000), 'retry', [], {},
      { status: 'running', attemptNumber: 1 });
    const restarted = await markAutomationRunStarted('target-run', {
      outputDir: null, targetOutputPath: null, effectiveTargetOutputPath: null,
      logPath: '', resultPath: null, piSessionId: 'target-session', eventsLog: [], expectedAttemptNumber: 2,
    });
    assert.equal(((restarted?.metadataJson?.automationSources as typeof pin).sources)[0]?.sourceRunId, 'source-success');
    await db.update(automationJobs).set({ status: 'paused' }).where(eq(automationJobs.id, 'source'));
    assert.equal((await getAutomationSourceResults(scope))[0]?.reason, 'source_unavailable');
    await db.update(automationJobs).set({ status: 'active' }).where(eq(automationJobs.id, 'source'));
    await updateAutomationJob('target', { sourceJobIds: [] }, { actorUserId: 'owner' });
    assert.equal((await getAutomationSourceResults(scope))[0]?.reason, 'source_unconfigured');

    await updateAutomationJob('target', { sourceJobIds: ['source'] }, { actorUserId: 'owner' });
    const movedScope = (workspaceId: string) => ({ scope: 'personal', organizationId: 'org', workspaceId,
      workspaceType: 'personal', ownerUserId: 'owner', responsibleUserId: 'owner', serviceActorId: null,
      approvedByUserId: null, lastEditedByUserId: 'owner', workspace: { workspaceId,
        customerId: null, projectId: null } });
    await moveAutomationJobToWorkspace('source', movedScope('b') as never,
      { actorUserId: 'owner', responsibleUserId: 'owner' });
    assert.deepEqual((await getAutomationJob('target'))?.sourceJobIds, []);
    await moveAutomationJobToWorkspace('source', movedScope('a') as never,
      { actorUserId: 'owner', responsibleUserId: 'owner' });
    await updateAutomationJob('target', { sourceJobIds: ['source'] }, { actorUserId: 'owner' });
    await run('after-move', 'target', 'pending', null, new Date(now.getTime() + 2_000));
    const afterMove = await markAutomationRunStarted('after-move', {
      outputDir: null, targetOutputPath: null, effectiveTargetOutputPath: null,
      logPath: '', resultPath: null, piSessionId: 'new-target-session', eventsLog: [], expectedAttemptNumber: 1,
    });
    assert.equal(((afterMove?.metadataJson?.automationSources as typeof pin).sources)[0]?.sourceRunId, null,
      'A→B→A must not resurrect results created before the source move');

    await db.insert(automationJobs).values({ ...job('own'), continuityMode: 'last_relevant' });
    await run('own-old', 'own', 'success', 'Old own result', new Date(now.getTime() - 10_000));
    await moveAutomationJobToWorkspace('own', movedScope('b') as never,
      { actorUserId: 'owner', responsibleUserId: 'owner' });
    await moveAutomationJobToWorkspace('own', movedScope('a') as never,
      { actorUserId: 'owner', responsibleUserId: 'owner' });
    await run('own-current', 'own', 'pending', null, new Date(now.getTime() + 3_000));
    const ownStarted = await markAutomationRunStarted('own-current', {
      outputDir: null, targetOutputPath: null, effectiveTargetOutputPath: null,
      logPath: '', resultPath: null, piSessionId: 'own-session', eventsLog: [], expectedAttemptNumber: 1,
    });
    assert.equal((ownStarted?.metadataJson?.automationContinuity as { sourceRunId: string | null }).sourceRunId, null);
    await db.update(automationRuns).set({ metadataJson: JSON.stringify({
      ...ownStarted?.metadataJson,
      automationContinuity: { version: 1, mode: 'last_relevant', sourceRunId: 'own-old',
        selectedAt: now.toISOString(), reason: null },
    }) }).where(eq(automationRuns.id, 'own-current'));
    assert.equal((await getAutomationPreviousRelevantResult({ runId: 'own-current', jobId: 'own',
      workspaceId: 'a', workspaceType: 'personal', organizationId: 'org' })).reason, 'source_scope_reset');

    await db.insert(automationJobs).values(job('empty'));
    await run('empty-current', 'empty', 'pending', null, new Date(now.getTime() + 4_000));
    const emptyStarted = await markAutomationRunStarted('empty-current', {
      outputDir: null, targetOutputPath: null, effectiveTargetOutputPath: null,
      logPath: '', resultPath: null, piSessionId: 'empty-session', eventsLog: [], expectedAttemptNumber: 1,
    });
    assert.deepEqual((emptyStarted?.metadataJson?.automationSources as { sources: unknown[] }).sources, []);
    await updateAutomationJob('empty', { sourceJobIds: ['source'] }, { actorUserId: 'owner' });
    await markAutomationRunRetryScheduled('empty-current', new Date(now.getTime() + 60_000), 'retry', [], {},
      { status: 'running', attemptNumber: 1 });
    const emptyRetried = await markAutomationRunStarted('empty-current', {
      outputDir: null, targetOutputPath: null, effectiveTargetOutputPath: null,
      logPath: '', resultPath: null, piSessionId: 'empty-session', eventsLog: [], expectedAttemptNumber: 2,
    });
    assert.deepEqual((emptyRetried?.metadataJson?.automationSources as { sources: unknown[] }).sources, [],
      'retry must keep the originally empty source selection');

    const hugeSources = ['one', 'two', 'three'].map((id) => ({ sourceJobId: id, sourceJobName: id,
      sourceRunId: id, finishedAt: now.toISOString(), piSessionId: id,
      resultText: 'large result '.repeat(1_000), reason: null }));
    const composed = composeAutomationSourceResults({ sources: hugeSources, maxTokens: 1_024,
      maxBytes: 30_000, currentSessionId: 'current', hasPersistedSession: false });
    assert.ok(composed.estimatedTokens <= 1_024);
    assert.equal(composed.details.length, 3);
    assert.ok(composed.details.every((detail) => detail.reason === 'included_truncated'));
    assert.equal(getAutomationTotalContextTokenBudget({ contextWindowTokens: 100_000, availableTokens: 10_000 }), 2_048);
    assert.equal(getAutomationTotalContextTokenBudget({ contextWindowTokens: 10_000, availableTokens: 10_000 }), 500);
  } finally {
    await testDatabase.close();
    internals._load = originalLoad;
  }
}

main().then(() => console.log('automation-source-jobs-test: ok')).catch((error) => {
  internals._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});

import assert from 'node:assert/strict';
import Module from 'node:module';

import { eq } from 'drizzle-orm';

import { createPiTestDatabase } from './helpers/pi-test-database';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;
let testDatabase: Awaited<ReturnType<typeof createPiTestDatabase>> | undefined;
let hasWorkspaceRights = true;
process.env.BETTER_AUTH_BASE_URL ??= 'http://localhost:3001';

moduleInternals._load = (request, parent, isMain) => {
  if (testDatabase && (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request))) {
    return testDatabase;
  }
  if (request === './policy' && parent?.filename.includes('/automations/job-state-store')) {
    return { canAccessAutomationJob: async () => true };
  }
  if (request === '@/app/lib/pi/session-workspace-context' && parent?.filename.includes('/automations/job-state-store')) {
    return { resolveAgentSessionWorkspaceForUser: async () => {
      if (!hasWorkspaceRights) throw new Error('Workspace permission revoked');
      return { workspaceId: 'workspace-a' };
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
    const { getAutomationJobState, listAutomationJobState, mutateAutomationJobState } =
      await import('../app/lib/automations/job-state-store');
    const { createAutomationJobStateTool } = await import('../app/lib/pi/automation-job-state-tool');
    const { getAutomationJob, moveAutomationJobToWorkspace, updateAutomationJob } =
      await import('../app/lib/automations/store');
    const now = new Date();
    await db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner-state@example.test',
      emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(canvasOrganizationSettings).values({ organizationId: 'org', ownerUserId: 'owner',
      deploymentMode: 'single_user', teamFeaturesEnabled: false, createdAt: now, updatedAt: now });
    for (const id of ['workspace-a', 'workspace-b']) {
      await db.insert(canvasWorkspaces).values({ id, organizationId: 'org', type: 'personal',
        ownerUserId: 'owner', rootRelativePath: `${id}/files`, displayName: id,
        workspaceIcon: 'folder', status: 'active', isDefault: id === 'workspace-a',
        createdAt: now, updatedAt: now });
    }
    await db.insert(automationJobs).values({
      id: 'job', name: 'Job', status: 'active', integrityStatus: 'valid', scope: 'personal',
      jobScope: 'personal:owner:workspace-a', organizationId: 'org', workspaceId: 'workspace-a',
      workspaceType: 'personal', ownerUserId: 'owner', responsibleUserId: 'owner',
      prompt: 'Test', preferredSkill: 'auto', workspaceContextPathsJson: '[]',
      scheduleKind: 'daily', scheduleConfigJson: '{"kind":"daily","times":["09:00"],"timeZone":"UTC"}',
      timeZone: 'UTC', createdByUserId: 'owner', createdAt: now, updatedAt: now,
    });
    assert.equal((await getAutomationJob('job'))?.continuityMode, 'off');
    assert.equal((await updateAutomationJob('job', { continuityMode: 'last_relevant' }))?.continuityMode, 'last_relevant');
    await assert.rejects(updateAutomationJob('job', { continuityMode: 'invalid' as 'off' }));
    const access = { kind: 'user' as const, userId: 'owner' };
    const write = (key: string, value: string, expectedRevision: number | null, mutationId: string) =>
      mutateAutomationJobState({ jobId: 'job', key, value, expectedRevision, mutationId, action: 'set', access });
    const first = await write('cursor', 'one', null, 'create-1');
    assert.equal(first.action, 'set');
    assert.equal(first.action === 'set' && first.entry.revision, 1);
    assert.deepEqual(await write('cursor', 'one', null, 'create-1'), first, 'retry is idempotent');
    await assert.rejects(write('cursor', 'different', null, 'create-1'), { code: 'MUTATION_CONFLICT' });
    await assert.rejects(write('cursor', 'stale', null, 'create-2'), { code: 'REVISION_CONFLICT' });
    const deleted = await mutateAutomationJobState({ jobId: 'job', key: 'cursor', action: 'delete',
      expectedRevision: 1, mutationId: 'delete-1', access });
    assert.deepEqual(deleted, { action: 'delete', key: 'cursor', previousRevision: 1 });
    assert.equal(await getAutomationJobState('job', 'cursor', access), null);
    const recreated = await write('cursor', 'two', null, 'recreate-1');
    assert.equal(recreated.action === 'set' && recreated.entry.revision, 3, 'tombstone keeps revision monotone');
    assert.deepEqual(await write('cursor', 'one', null, 'create-1'), first, 'old retry uses its receipt after later writes');
    await assert.rejects(write('cursor', 'stale-after-recreate', 1, 'stale-3'), { code: 'REVISION_CONFLICT' });
    const race = await Promise.allSettled([
      write('cursor', 'racer-a', 3, 'race-a'), write('cursor', 'racer-b', 3, 'race-b'),
    ]);
    assert.equal(race.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(race.filter((item) => item.status === 'rejected').length, 1);

    hasWorkspaceRights = false;
    await assert.rejects(getAutomationJobState('job', 'cursor', access), { code: 'ACCESS_DENIED' });
    await assert.rejects(write('cursor', 'denied', 4, 'denied-1'), { code: 'ACCESS_DENIED' });
    hasWorkspaceRights = true;

    await db.insert(automationRuns).values({ id: 'run', jobId: 'job', status: 'running',
      scope: 'personal', jobScope: 'personal:owner:workspace-a', organizationId: 'org',
      workspaceId: 'workspace-a', workspaceType: 'personal', actorType: 'user', actorUserId: 'owner',
      triggerType: 'manual', attemptNumber: 1, createdAt: now });
    const runAccess = { kind: 'run' as const, runId: 'run' };
    assert.equal((await getAutomationJobState('job', 'cursor', runAccess))?.value !== undefined, true);
    const tool = createAutomationJobStateTool({ jobId: 'job', runId: 'run' });
    const readToolResult = (result: Awaited<ReturnType<typeof tool.execute>>) =>
      JSON.parse(result.content.find((part) => part.type === 'text')?.text ?? '{}') as Record<string, unknown>;
    const invoke = async (input: Record<string, unknown>) => readToolResult(await tool.execute('state-tool-call', input));
    assert.deepEqual((await invoke({ action: 'list' })).entries, [{ key: 'cursor', revision: 4,
      updatedAt: (await getAutomationJobState('job', 'cursor', runAccess))!.updatedAt }]);
    assert.equal((await invoke({ action: 'get', key: 'cursor' })).entry !== null, true);
    const written = await invoke({ action: 'set', key: 'tool-key', value: 'tool-value', expectedRevision: null,
      mutationId: 'tool-set-1' });
    assert.equal((written.result as { entry: { value: string } }).entry.value, 'tool-value');
    assert.deepEqual(await invoke({ action: 'set', key: 'tool-key', value: 'tool-value', expectedRevision: null,
      mutationId: 'tool-set-1' }), written, 'tool retry reuses the receipt');
    assert.equal((await invoke({ action: 'set', key: 'tool-key', value: 'overwrite', expectedRevision: null,
      mutationId: 'tool-set-2' })).error, 'REVISION_CONFLICT');
    assert.equal((await invoke({ action: 'get', key: 'tool-key', jobId: 'other-job' })).error, 'INVALID_INPUT',
      'model cannot select a different job');
    assert.equal(readToolResult(await createAutomationJobStateTool({ jobId: 'other-job', runId: 'run' })
      .execute('foreign-job', { action: 'list' })).error, 'ACCESS_DENIED');
    assert.equal((await invoke({ action: 'delete', key: 'tool-key', expectedRevision: 1,
      mutationId: 'tool-delete-1' })).result !== undefined, true);
    await invoke({ action: 'set', key: 'A', value: 'upper', expectedRevision: null, mutationId: 'tool-upper-1' });
    await invoke({ action: 'set', key: 'a', value: 'lower', expectedRevision: null, mutationId: 'tool-lower-1' });
    const firstPage = await invoke({ action: 'list', limit: 1 });
    assert.equal((firstPage.entries as Array<{ key: string }>)[0].key, 'A');
    const secondPage = await invoke({ action: 'list', limit: 1, afterKey: firstPage.nextAfterKey });
    assert.equal((secondPage.entries as Array<{ key: string }>)[0].key, 'a', 'cursor uses the same ordering as list');
    await db.update(automationRuns).set({ status: 'success' }).where(eq(automationRuns.id, 'run'));
    assert.equal((await invoke({ action: 'get', key: 'cursor' })).error, 'ACCESS_DENIED',
      'completed run loses state access');
    await db.update(automationRuns).set({ status: 'running' }).where(eq(automationRuns.id, 'run'));
    hasWorkspaceRights = false;
    await assert.rejects(getAutomationJobState('job', 'cursor', runAccess), { code: 'ACCESS_DENIED' });
    assert.equal((await invoke({ action: 'get', key: 'cursor' })).error, 'ACCESS_DENIED',
      'revoked workspace permission blocks an existing tool');
    hasWorkspaceRights = true;

    // Fill the tombstone count in one batch, then verify an additional key is blocked.
    await db.insert(automationJobState).values(Array.from({ length: 1023 }, (_, i) => ({
      jobId: 'job', jobScope: 'personal:owner:workspace-a', key: `t${i}`, value: '',
      deleted: true, revision: 2, updatedAt: now,
    })));
    await assert.rejects(write('extra-key', 'x', null, 'over-key-limit'), { code: 'SIZE_LIMIT' });
    await db.delete(automationJobState).where(eq(automationJobState.jobId, 'job'));
    await assert.rejects(write('too-large', 'x'.repeat(16 * 1024 + 1), null, 'over-value-limit'), { code: 'SIZE_LIMIT' });
    for (let i = 0; i < 3; i++) await write(`large-${i}`, 'x'.repeat(16 * 1024), null, `large-${i}`);
    await assert.rejects(write('large-3', 'x'.repeat(16 * 1024), null, 'large-3'), { code: 'SIZE_LIMIT' });

    // Move A -> B -> A without writing in B. Old state must not reappear.
    await db.update(automationRuns).set({ status: 'success' }).where(eq(automationRuns.id, 'run'));
    const target = (workspaceId: string) => ({
      scope: 'personal' as const, organizationId: 'org', workspaceId,
      workspaceType: 'personal' as const, ownerUserId: 'owner', responsibleUserId: 'owner',
      serviceActorId: null, approvedByUserId: null, lastEditedByUserId: 'owner',
      workspace: { workspaceId, workspaceType: 'personal' as const, organizationId: 'org',
        customerId: null, projectId: null },
    });
    await moveAutomationJobToWorkspace('job', target('workspace-b') as never,
      { actorUserId: 'owner', responsibleUserId: 'owner' });
    await moveAutomationJobToWorkspace('job', target('workspace-a') as never,
      { actorUserId: 'owner', responsibleUserId: 'owner' });
    assert.deepEqual(await listAutomationJobState('job', access), []);
    assert.equal(await getAutomationJobState('job', 'large-0', access), null);
  } finally {
    await testDatabase.close();
    moduleInternals._load = originalLoad;
  }
}

main().then(() => console.log('automation-job-state-store-test: ok')).catch((error) => {
  moduleInternals._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});

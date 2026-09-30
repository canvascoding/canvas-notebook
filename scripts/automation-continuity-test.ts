import assert from 'node:assert/strict';
import Module from 'node:module';

import { eq } from 'drizzle-orm';

import { createPiTestDatabase } from './helpers/pi-test-database';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;
let testDatabase: Awaited<ReturnType<typeof createPiTestDatabase>> | undefined;
process.env.BETTER_AUTH_BASE_URL ??= 'http://localhost:3001';

moduleInternals._load = (request, parent, isMain) => {
  if (testDatabase && (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request))) {
    return testDatabase;
  }
  return originalLoad(request, parent, isMain);
};

async function main(): Promise<void> {
  testDatabase = await createPiTestDatabase();
  try {
    const { db } = testDatabase;
    const { automationJobs, automationRuns, canvasOrganizationSettings, canvasWorkspaces, user } =
      await import('../app/lib/db/schema');
    const { getAutomationPreviousRelevantResult, markAutomationRunRetryScheduled, markAutomationRunStarted } =
      await import('../app/lib/automations/store');
    const { composeAutomationPreviousResult, getAutomationContextTokenBudget } =
      await import('../app/lib/automations/context-composer');
    const { buildAutomationPrompt } = await import('../app/lib/automations/prompt');
    const now = new Date();
    await db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner-continuity@example.test',
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
      workspaceType: 'personal', ownerUserId: 'owner', responsibleUserId: 'owner', continuityMode: 'last_relevant',
      prompt: 'The current task must stay complete.', preferredSkill: 'auto', workspaceContextPathsJson: '[]',
      scheduleKind: 'daily', scheduleConfigJson: '{"kind":"daily","times":["09:00"],"timeZone":"UTC"}',
      timeZone: 'UTC', createdByUserId: 'owner', createdAt: now, updatedAt: now,
    });
    const insertRun = async (id: string, status: 'pending' | 'success', resultText: string | null,
      finishedAt: Date | null, metadataJson: string | null = null) => db.insert(automationRuns).values({
      id, jobId: 'job', status, scope: 'personal', jobScope: 'personal:owner:workspace-a',
      organizationId: 'org', workspaceId: 'workspace-a', workspaceType: 'personal',
      actorType: 'user', actorUserId: 'owner', triggerType: 'manual', attemptNumber: 1,
      resultText, finishedAt, metadataJson, piSessionId: id === 'old' ? 'shared-session' : `auto-${id}`,
      createdAt: now,
    });
    await insertRun('old', 'success', 'First meaningful answer ' + 'x'.repeat(4_000), new Date(now.getTime() - 20_000),
      JSON.stringify({ automation: { outcome: 'message' } }));
    await insertRun('legacy-heartbeat', 'success', 'Heartbeat completed without relevant updates.',
      new Date(now.getTime() - 5_000), JSON.stringify({ heartbeat: {
        outcome: 'no_updates', acknowledgement: 'HEARTBEAT_OK', deliverySuppressed: true,
      } }));
    await insertRun('legacy-acknowledgement', 'success', 'HEARTBEAT_OK', new Date(now.getTime() - 4_000));
    for (let i = 0; i < 101; i++) {
      await insertRun(`noop-${i}`, 'success', 'Automation completed without relevant updates.',
        new Date(now.getTime() - 10_000 + i), JSON.stringify({ automation: { outcome: 'no_action' } }));
    }
    await insertRun('current', 'pending', null, null);
    const started = await markAutomationRunStarted('current', {
      outputDir: null, targetOutputPath: null, effectiveTargetOutputPath: null,
      logPath: '', resultPath: null, piSessionId: 'new-session', eventsLog: [], expectedAttemptNumber: 1,
    });
    assert.equal(started?.status, 'running');
    assert.equal((started?.metadataJson?.automationContinuity as { sourceRunId?: string }).sourceRunId, 'old');
    const scope = { runId: 'current', jobId: 'job', workspaceId: 'workspace-a',
      workspaceType: 'personal', organizationId: 'org' };
    const previous = await getAutomationPreviousRelevantResult(scope);
    assert.equal(previous.sourceRunId, 'old');
    assert.equal(previous.resultText?.length, 'First meaningful answer '.length + 4_000,
      'selection loads the complete text, not the 1000-character preview');

    const baselinePrompt = buildAutomationPrompt({ name: 'Job', prompt: 'The current task must stay complete.', preferredSkill: 'auto' });
    assert.equal(baselinePrompt.includes('Previous Relevant Automation Result'), false);
    assert.equal(getAutomationContextTokenBudget({ contextWindowTokens: 10_000, availableTokens: 3_000 }), 500);
    const composition = composeAutomationPreviousResult({ previous, maxTokens: 500, maxBytes: 8_000,
      currentSessionId: 'new-session', hasPersistedSession: false });
    assert.equal(composition.truncated, true);
    assert.ok(composition.estimatedTokens <= 500);
    assert.ok(composition.block.includes('untrusted output'));
    assert.ok(composition.block.includes('[Previous result truncated]'));
    const enrichedPrompt = buildAutomationPrompt({ name: 'Job', prompt: 'The current task must stay complete.',
      preferredSkill: 'auto', previousResultContext: composition.block });
    assert.ok(enrichedPrompt.indexOf('Previous Relevant Automation Result') < enrichedPrompt.indexOf('### Task'));
    assert.ok(enrichedPrompt.includes('### Task\nThe current task must stay complete.'));
    assert.equal(composeAutomationPreviousResult({ previous, maxTokens: 500, maxBytes: 8_000,
      currentSessionId: 'shared-session', hasPersistedSession: true }).reason, 'already_in_session');
    assert.equal(composeAutomationPreviousResult({ previous, maxTokens: 500, maxBytes: 8_000,
      currentSessionId: 'shared-session', hasPersistedSession: false }).reason, 'included_truncated');
    assert.equal(composeAutomationPreviousResult({ previous, maxTokens: 0, maxBytes: 8_000,
      currentSessionId: 'new-session', hasPersistedSession: false }).reason, 'budget_exhausted');

    const retry = await markAutomationRunRetryScheduled('current', new Date(now.getTime() + 60_000), 'retry', [], {},
      { status: 'running', attemptNumber: 1 });
    assert.equal(retry?.status, 'retry_scheduled');
    await insertRun('newer', 'success', 'A newer answer', new Date(now.getTime() + 1_000),
      JSON.stringify({ automation: { outcome: 'message' } }));
    const restarted = await markAutomationRunStarted('current', {
      outputDir: null, targetOutputPath: null, effectiveTargetOutputPath: null,
      logPath: '', resultPath: null, piSessionId: 'new-session', eventsLog: [], expectedAttemptNumber: 2,
    });
    assert.equal((restarted?.metadataJson?.automationContinuity as { sourceRunId?: string }).sourceRunId, 'old');
    await db.update(automationRuns).set({ metadataJson: JSON.stringify({
      ...restarted?.metadataJson,
      automationContinuity: { ...(restarted?.metadataJson?.automationContinuity as object),
        sourceRunId: 'legacy-heartbeat' },
    }) }).where(eq(automationRuns.id, 'current'));
    assert.equal((await getAutomationPreviousRelevantResult(scope)).reason, 'source_not_relevant');
    await db.update(automationRuns).set({ metadataJson: JSON.stringify(restarted?.metadataJson) })
      .where(eq(automationRuns.id, 'current'));
    await db.update(automationJobs).set({ workspaceId: 'workspace-b', jobScope: 'personal:owner:workspace-b' })
      .where(eq(automationJobs.id, 'job'));
    assert.equal((await getAutomationPreviousRelevantResult({ ...scope, workspaceId: 'workspace-b' })).reason,
      'scope_changed');
    await db.update(automationJobs).set({ workspaceId: 'workspace-a', jobScope: 'personal:owner:workspace-a' })
      .where(eq(automationJobs.id, 'job'));
    await db.delete(automationRuns).where(eq(automationRuns.id, 'old'));
    assert.equal((await getAutomationPreviousRelevantResult(scope)).reason, 'source_missing');
  } finally {
    await testDatabase.close();
    moduleInternals._load = originalLoad;
  }
}

main().then(() => console.log('automation-continuity-test: ok')).catch((error) => {
  moduleInternals._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});

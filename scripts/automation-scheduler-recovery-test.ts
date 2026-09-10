import assert from 'node:assert/strict';
import Module from 'node:module';

import { and, eq } from 'drizzle-orm';

import { createPiTestDatabase } from './helpers/pi-test-database';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;
let testDatabase: Awaited<ReturnType<typeof createPiTestDatabase>> | undefined;

moduleInternals._load = (request, parent, isMain) => {
  if (testDatabase && (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request))) {
    return testDatabase;
  }
  return originalLoad(request, parent, isMain);
};

const NOW = new Date('2026-09-11T10:00:00.000Z');
const OWNER_ID = 'scheduler-owner';
const ORGANIZATION_ID = 'scheduler-organization';
const WORKSPACE_ID = 'scheduler-workspace';

async function insertJob(input: {
  id: string;
  nextRunAt: Date | null;
  schedule?: Record<string, unknown>;
  triggerKind?: 'schedule' | 'event' | 'webhook';
}) {
  if (!testDatabase) throw new Error('Test database is unavailable.');
  const { automationJobs } = await import('../app/lib/db/schema');
  const schedule = input.schedule ?? { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' };
  await testDatabase.db.insert(automationJobs).values({
    id: input.id,
    name: input.id,
    status: 'active',
    integrityStatus: 'valid',
    integrityReason: null,
    revision: 1,
    scope: 'personal',
    jobScope: `personal:${OWNER_ID}:${WORKSPACE_ID}`,
    organizationId: ORGANIZATION_ID,
    workspaceId: WORKSPACE_ID,
    workspaceType: 'personal',
    ownerUserId: OWNER_ID,
    responsibleUserId: OWNER_ID,
    serviceActorId: null,
    approvedByUserId: null,
    lastEditedByUserId: OWNER_ID,
    prompt: 'Run the regression fixture.',
    preferredSkill: 'auto',
    workspaceContextPathsJson: '[]',
    targetOutputPath: null,
    scheduleKind: 'interval',
    scheduleConfigJson: JSON.stringify(schedule),
    timeZone: 'UTC',
    nextRunAt: input.nextRunAt,
    lastRunAt: null,
    lastRunStatus: null,
    createdByUserId: OWNER_ID,
    agentId: 'bradley',
    deliveryMode: 'silent',
    deliveryChannelId: null,
    deliverySessionMode: 'new_session',
    deliverySessionId: null,
    deliveryChannelSessionKey: null,
    triggerKind: input.triggerKind ?? 'schedule',
    resultPolicy: 'record_only',
    eventConfigJson: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function main() {
  testDatabase = await createPiTestDatabase();
  try {
    const { db } = testDatabase;
    const { automationJobs, automationRuns, canvasOrganizationSettings, canvasWorkspaces, user } = await import('../app/lib/db/schema');
    const {
      SCHEDULED_RUN_MISFIRE_GRACE_MS,
      claimDueScheduledAutomationJobRun,
      deleteAutomationJob,
      discardMissedScheduledAutomationRuns,
      listExecutableAutomationRuns,
      markAutomationRunStarted,
      scheduleAutomationJobRun,
      updateAutomationJob,
    } = await import('../app/lib/automations/store');

    await db.insert(user).values({
      id: OWNER_ID,
      name: 'Scheduler Owner',
      email: 'scheduler-owner@example.test',
      emailVerified: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(canvasOrganizationSettings).values({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_ID,
      deploymentMode: 'team',
      teamFeaturesEnabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(canvasWorkspaces).values({
      id: WORKSPACE_ID,
      organizationId: ORGANIZATION_ID,
      type: 'personal',
      rootRelativePath: 'workspaces/scheduler-owner/files',
      displayName: 'Scheduler',
      workspaceIcon: 'clock',
      status: 'active',
      isDefault: true,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await insertJob({ id: 'job-misfire', nextRunAt: new Date(NOW.getTime() - SCHEDULED_RUN_MISFIRE_GRACE_MS - 1) });
    const misfireRun = await claimDueScheduledAutomationJobRun('job-misfire', NOW);
    assert.equal(misfireRun, null, 'a downtime-missed tick must not create a catch-up run');
    const [misfireJob] = await db.select().from(automationJobs).where(eq(automationJobs.id, 'job-misfire'));
    assert.ok(misfireJob.nextRunAt && misfireJob.nextRunAt.getTime() > NOW.getTime(), 'an active misfired job must resume strictly in the future');
    const misfireRuns = await db.select().from(automationRuns).where(eq(automationRuns.jobId, 'job-misfire'));
    assert.equal(misfireRuns.length, 0, 'a skipped tick cannot produce a run, todo, or delivery side effect');

    await insertJob({ id: 'job-concurrent', nextRunAt: new Date(NOW.getTime() - 1_000) });
    const claims = await Promise.all([
      claimDueScheduledAutomationJobRun('job-concurrent', NOW),
      claimDueScheduledAutomationJobRun('job-concurrent', NOW),
    ]);
    assert.equal(claims.filter(Boolean).length, 1, 'parallel scheduler calls may claim an on-time tick only once');
    const concurrentRuns = await db.select().from(automationRuns).where(eq(automationRuns.jobId, 'job-concurrent'));
    assert.equal(concurrentRuns.length, 1);
    assert.equal(concurrentRuns[0].triggerType, 'scheduled');

    await insertJob({ id: 'job-pause', nextRunAt: new Date(NOW.getTime() - 1_000) });
    const queuedBeforePause = await claimDueScheduledAutomationJobRun('job-pause', NOW);
    assert.ok(queuedBeforePause, 'an on-time scheduled run should enter the queue');
    await updateAutomationJob('job-pause', { status: 'paused' });
    const [pausedRun] = await db.select().from(automationRuns).where(eq(automationRuns.id, queuedBeforePause.id));
    assert.equal(pausedRun.status, 'failed', 'pausing must neutralize a pending queued run');
    assert.match(pausedRun.errorMessage || '', /paused before/i);
    const startedAfterPause = await markAutomationRunStarted(queuedBeforePause.id, {
      outputDir: null,
      targetOutputPath: null,
      effectiveTargetOutputPath: null,
      logPath: '',
      resultPath: null,
      piSessionId: 'session-paused',
      eventsLog: [],
      expectedAttemptNumber: queuedBeforePause.attemptNumber,
    });
    assert.equal(startedAfterPause, null, 'a dispatch recheck must reject the status change that happened while queued');

    await insertJob({ id: 'job-pause-retry', nextRunAt: null });
    const retryBeforePause = await scheduleAutomationJobRun('job-pause-retry', 'scheduled', NOW);
    assert.ok(retryBeforePause);
    await db.update(automationRuns).set({ status: 'retry_scheduled' }).where(eq(automationRuns.id, retryBeforePause.id));
    await updateAutomationJob('job-pause-retry', { status: 'paused' });
    const [pausedRetryRun] = await db.select().from(automationRuns).where(eq(automationRuns.id, retryBeforePause.id));
    assert.equal(pausedRetryRun.status, 'failed', 'pausing must neutralize retry-scheduled work too');

    await insertJob({ id: 'job-running', nextRunAt: new Date(NOW.getTime() - 1_000) });
    const running = await claimDueScheduledAutomationJobRun('job-running', NOW);
    assert.ok(running);
    const runningClaim = await markAutomationRunStarted(running.id, {
      outputDir: null,
      targetOutputPath: null,
      effectiveTargetOutputPath: null,
      logPath: '',
      resultPath: null,
      piSessionId: 'session-running',
      eventsLog: [],
      expectedAttemptNumber: running.attemptNumber,
    });
    assert.ok(runningClaim, 'an active queued run can enter the running state');
    await updateAutomationJob('job-running', { status: 'paused' });
    const [stillRunning] = await db.select().from(automationRuns).where(eq(automationRuns.id, running.id));
    assert.equal(stillRunning.status, 'running', 'pausing does not force-cancel a run already past the dispatch barrier');

    await insertJob({ id: 'job-quarantined', nextRunAt: new Date(NOW.getTime() - 1_000) });
    const quarantined = await claimDueScheduledAutomationJobRun('job-quarantined', NOW);
    assert.ok(quarantined);
    await db.update(automationJobs).set({ integrityStatus: 'quarantined' }).where(eq(automationJobs.id, 'job-quarantined'));
    const startedAfterQuarantine = await markAutomationRunStarted(quarantined.id, {
      outputDir: null,
      targetOutputPath: null,
      effectiveTargetOutputPath: null,
      logPath: '',
      resultPath: null,
      piSessionId: 'session-quarantined',
      eventsLog: [],
      expectedAttemptNumber: quarantined.attemptNumber,
    });
    assert.equal(startedAfterQuarantine, null, 'the dispatch recheck must reject a quarantined job');

    await insertJob({ id: 'job-deleted', nextRunAt: new Date(NOW.getTime() - 1_000) });
    const deleted = await claimDueScheduledAutomationJobRun('job-deleted', NOW);
    assert.ok(deleted);
    assert.equal(await deleteAutomationJob('job-deleted'), true);
    const startedAfterDelete = await markAutomationRunStarted(deleted.id, {
      outputDir: null,
      targetOutputPath: null,
      effectiveTargetOutputPath: null,
      logPath: '',
      resultPath: null,
      piSessionId: 'session-deleted',
      eventsLog: [],
      expectedAttemptNumber: deleted.attemptNumber,
    });
    assert.equal(startedAfterDelete, null, 'the dispatch recheck must reject a job deleted while queued');

    await insertJob({ id: 'job-manual', nextRunAt: null });
    const manual = await scheduleAutomationJobRun('job-manual', 'manual', new Date(NOW.getTime() - 8 * 60 * 60_000));
    assert.ok(manual);
    await insertJob({ id: 'job-webhook', nextRunAt: null });
    const webhook = await scheduleAutomationJobRun('job-webhook', 'webhook', new Date(NOW.getTime() - 8 * 60 * 60_000));
    assert.ok(webhook);
    await insertJob({ id: 'job-event', nextRunAt: null, triggerKind: 'event' });
    const event = await scheduleAutomationJobRun('job-event', 'event', new Date(NOW.getTime() - 8 * 60 * 60_000));
    assert.ok(event);
    const discarded = await discardMissedScheduledAutomationRuns(NOW);
    assert.equal(discarded, 0, 'downtime cleanup must not consume manual, webhook, or event work');
    const executable = await listExecutableAutomationRuns(NOW);
    const executableIds = new Set(executable.map((run) => run.id));
    assert.ok(executableIds.has(manual.id), 'manual work remains eligible after scheduler downtime');
    assert.ok(executableIds.has(webhook.id), 'webhook work remains eligible after scheduler downtime');
    assert.ok(executableIds.has(event.id), 'event work remains eligible after scheduler downtime');

    const scheduledRow = concurrentRuns[0];
    await db.update(automationRuns).set({
      scheduledFor: new Date(NOW.getTime() - SCHEDULED_RUN_MISFIRE_GRACE_MS - 1),
    }).where(and(eq(automationRuns.id, scheduledRow.id), eq(automationRuns.status, 'pending')));
    const discardedQueued = await discardMissedScheduledAutomationRuns(NOW);
    assert.equal(discardedQueued, 1, 'old queued scheduled work is discarded exactly once');
    assert.equal(await discardMissedScheduledAutomationRuns(NOW), 0, 'scheduled queue cleanup is idempotent');

    await insertJob({ id: 'job-retry-misfire', nextRunAt: null });
    const queuedRetry = await scheduleAutomationJobRun(
      'job-retry-misfire',
      'scheduled',
      new Date(NOW.getTime() - SCHEDULED_RUN_MISFIRE_GRACE_MS - 1),
    );
    assert.ok(queuedRetry);
    await db.update(automationRuns).set({ status: 'retry_scheduled' }).where(eq(automationRuns.id, queuedRetry.id));
    assert.equal(
      await discardMissedScheduledAutomationRuns(NOW),
      1,
      'downtime cleanup also discards stale scheduled retries',
    );
  } finally {
    await testDatabase?.close();
    testDatabase = undefined;
    moduleInternals._load = originalLoad;
  }
  console.log('Automation scheduler recovery and queue barriers passed.');
}

void main();

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-heartbeat-config-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;

async function main() {
  const { db } = await import('../app/lib/db');
  const { automationJobs, user } = await import('../app/lib/db/schema');
  const { eq } = await import('drizzle-orm');
  const { readHeartbeatConfig, saveHeartbeatConfig } = await import('../app/lib/automations/heartbeat-config');
  const { advanceAutomationJobSchedule, getHeartbeatJob } = await import('../app/lib/automations/store');
  const { buildHeartbeatPrompt } = await import('../app/lib/automations/heartbeat');
  const { writeManagedAgentFile } = await import('../app/lib/agents/storage');

  const now = new Date();
  const userId = 'user-heartbeat-config';

  await db.insert(user).values({
    id: userId,
    name: 'Heartbeat Tester',
    email: 'heartbeat@example.test',
    emailVerified: true,
    image: null,
    role: null,
    createdAt: now,
    updatedAt: now,
  });

  const canvasHeartbeat = await saveHeartbeatConfig({
    userId,
    agentId: 'canvas-agent',
    enabled: true,
    schedule: { kind: 'daily', times: ['08:00'], timeZone: 'UTC' },
    deliveryMode: 'web',
    deliveryChannelId: 'web',
    deliverySessionMode: 'new_session',
  });

  const researchHeartbeat = await saveHeartbeatConfig({
    userId,
    agentId: 'research-agent',
    enabled: true,
    schedule: { kind: 'interval', every: 2, unit: 'hours', timeZone: 'UTC' },
    deliveryMode: 'channel_home',
    deliveryChannelId: 'telegram',
    deliverySessionMode: 'channel_active',
  });

  assert.notEqual(canvasHeartbeat.jobId, researchHeartbeat.jobId);
  assert.equal(canvasHeartbeat.agentId, 'canvas-agent');
  assert.equal(researchHeartbeat.agentId, 'research-agent');
  assert.equal(researchHeartbeat.deliveryChannelId, 'telegram');

  assert.ok(researchHeartbeat.jobId);
  const previousResearchRunAt = new Date('2026-05-31T10:00:00.000Z');
  const dueResearchRunAt = new Date('2026-05-31T12:00:00.000Z');
  await db
    .update(automationJobs)
    .set({
      lastRunAt: previousResearchRunAt,
      nextRunAt: dueResearchRunAt,
    })
    .where(eq(automationJobs.id, researchHeartbeat.jobId));

  await advanceAutomationJobSchedule(researchHeartbeat.jobId, dueResearchRunAt);
  const advancedResearch = await getHeartbeatJob({ userId, agentId: 'research-agent' });
  assert.equal(advancedResearch?.nextRunAt, '2026-05-31T14:00:00.000Z');

  await saveHeartbeatConfig({
    userId,
    agentId: 'canvas-agent',
    enabled: false,
    schedule: { kind: 'weekly', days: ['mon'], times: ['09:30'], timeZone: 'UTC' },
    deliveryMode: 'web',
    deliveryChannelId: 'web',
    deliverySessionMode: 'new_session',
  });

  const updatedCanvas = await readHeartbeatConfig({ userId, agentId: 'canvas-agent' });
  const unchangedResearch = await readHeartbeatConfig({ userId, agentId: 'research-agent' });
  assert.equal(updatedCanvas.enabled, false);
  assert.equal(updatedCanvas.schedule?.kind, 'weekly');
  assert.equal(unchangedResearch.enabled, true);
  assert.equal(unchangedResearch.schedule?.kind, 'interval');

  const defaultHeartbeat = await saveHeartbeatConfig({
    userId,
    agentId: 'sales-agent',
    enabled: true,
  });
  assert.equal(defaultHeartbeat.deliveryMode, 'last_active');
  assert.equal(defaultHeartbeat.deliveryChannelId, null);
  assert.equal(defaultHeartbeat.deliverySessionMode, 'channel_active');
  assert.equal(defaultHeartbeat.schedule?.kind, 'interval');
  assert.equal(defaultHeartbeat.schedule?.workingHours?.enabled, true);
  assert.deepEqual(defaultHeartbeat.schedule?.workingHours?.days, ['mon', 'tue', 'wed', 'thu', 'fri']);
  if (defaultHeartbeat.schedule?.kind === 'interval') {
    assert.equal(defaultHeartbeat.schedule.every, 60);
    assert.equal(defaultHeartbeat.schedule.unit, 'minutes');
  }

  const missing = await readHeartbeatConfig({ userId, agentId: 'support-agent' });
  assert.equal(missing.configured, false);
  assert.equal(missing.agentId, 'support-agent');

  await writeManagedAgentFile('HEARTBEAT.md', 'Canvas heartbeat instructions', 'canvas-agent');
  await writeManagedAgentFile('HEARTBEAT.md', 'Research heartbeat instructions', 'research-agent');

  const canvasJob = await getHeartbeatJob({ userId, agentId: 'canvas-agent' });
  const researchJob = await getHeartbeatJob({ userId, agentId: 'research-agent' });
  assert.ok(canvasJob);
  assert.ok(researchJob);
  const canvasPrompt = await buildHeartbeatPrompt(canvasJob);
  const researchPrompt = await buildHeartbeatPrompt(researchJob);
  const automatedResearchPrompt = await buildHeartbeatPrompt(researchJob, { includeAutomatedRuntimeContext: true });
  assert.match(canvasPrompt, /Canvas heartbeat instructions/);
  assert.match(researchPrompt, /Research heartbeat instructions/);
  assert.doesNotMatch(researchPrompt, /AUTOMATISCHER HEARTBEAT-KONTEXT/);
  assert.match(automatedResearchPrompt, /AUTOMATISCHER HEARTBEAT-KONTEXT/);
  assert.match(automatedResearchPrompt, /Aktueller Heartbeat-Zeitplan: Intervall: alle 2 Stunden/);
  assert.match(automatedResearchPrompt, /\/settings\?tab=agent-settings/);

  console.log('heartbeat config tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

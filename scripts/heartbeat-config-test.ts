import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-heartbeat-config-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;

async function main() {
  const { db } = await import('../app/lib/db');
  const { user } = await import('../app/lib/db/schema');
  const { readHeartbeatConfig, saveHeartbeatConfig } = await import('../app/lib/automations/heartbeat-config');
  const { getHeartbeatJob } = await import('../app/lib/automations/store');
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

  const missing = await readHeartbeatConfig({ userId, agentId: 'sales-agent' });
  assert.equal(missing.configured, false);
  assert.equal(missing.agentId, 'sales-agent');

  await writeManagedAgentFile('HEARTBEAT.md', 'Canvas heartbeat instructions', 'canvas-agent');
  await writeManagedAgentFile('HEARTBEAT.md', 'Research heartbeat instructions', 'research-agent');

  const canvasJob = await getHeartbeatJob({ userId, agentId: 'canvas-agent' });
  const researchJob = await getHeartbeatJob({ userId, agentId: 'research-agent' });
  assert.ok(canvasJob);
  assert.ok(researchJob);
  assert.match(await buildHeartbeatPrompt(canvasJob), /Canvas heartbeat instructions/);
  assert.match(await buildHeartbeatPrompt(researchJob), /Research heartbeat instructions/);

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

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AutomationJobRecord } from '../app/lib/automations/types';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-automation-delivery-'));
process.env.DATA = dataDir;

async function main() {
  const { eq } = await import('drizzle-orm');
  const { db } = await import('../app/lib/db');
  const { user, piSessions, sessionChannelLinks } = await import('../app/lib/db/schema');
  const { setActiveChannelSession } = await import('../app/lib/channels/active-sessions');
  const { getChannelRegistry } = await import('../app/lib/channels/registry');
  const { dispatchAutomationResult, resolveAutomationDeliveryTarget } = await import('../app/lib/automations/delivery');

  const now = new Date();
  const userId = 'user-automation-delivery';

  await db.insert(user).values({
    id: userId,
    name: 'Automation Delivery Tester',
    email: 'automation-delivery@example.test',
    emailVerified: true,
    image: null,
    role: null,
    createdAt: now,
    updatedAt: now,
  });

  const baseJob: AutomationJobRecord = {
    id: 'job-delivery',
    name: 'Delivery Test',
    status: 'active',
    prompt: 'Test',
    preferredSkill: 'auto',
    workspaceContextPaths: [],
    targetOutputPath: null,
    effectiveTargetOutputPath: '',
    schedule: { kind: 'daily', times: ['09:00'], timeZone: 'UTC' },
    timeZone: 'UTC',
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    createdByUserId: userId,
    agentId: 'canvas-agent',
    deliveryMode: 'web',
    deliveryChannelId: 'web',
    deliverySessionMode: 'new_session',
    deliverySessionId: null,
    deliveryChannelSessionKey: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    jobType: 'default',
    channelId: null,
    composioTriggerId: null,
    composioTriggerSlug: null,
    composioToolkitSlug: null,
    composioConnectedAccountId: null,
    composioUserId: null,
    webhookTriggerConfig: null,
  };

  const webNew = await resolveAutomationDeliveryTarget({
    job: baseJob,
    userId,
    defaultSessionId: 'auto-new',
  });
  assert.equal(webNew.sessionId, 'auto-new');
  assert.equal(webNew.mode, 'new_session');
  assert.equal(webNew.channelId, 'web');
  assert.equal(webNew.channelSessionKey, `web:user:${userId}`);

  const webLink = await db.query.sessionChannelLinks.findFirst({
    where: eq(sessionChannelLinks.sessionId, 'auto-new'),
  });
  assert.equal(webLink?.channelId, 'web');

  await db.insert(piSessions).values({
    sessionId: 'fixed-session',
    userId,
    agentId: 'canvas-agent',
    provider: 'test-provider',
    model: 'test-model',
    title: 'Fixed Session',
    createdAt: now,
    updatedAt: now,
  });

  const fixed = await resolveAutomationDeliveryTarget({
    job: {
      ...baseJob,
      deliverySessionMode: 'fixed_session',
      deliverySessionId: 'fixed-session',
    },
    userId,
    defaultSessionId: 'auto-fixed-fallback',
  });
  assert.equal(fixed.sessionId, 'fixed-session');
  assert.equal(fixed.mode, 'fixed_session');
  assert.deepEqual(fixed.warnings, []);

  await db.insert(piSessions).values({
    sessionId: 'active-session',
    userId,
    agentId: 'canvas-agent',
    provider: 'test-provider',
    model: 'test-model',
    title: 'Active Session',
    createdAt: now,
    updatedAt: now,
  });
  await setActiveChannelSession({
    userId,
    channelId: 'telegram',
    channelSessionKey: 'telegram:42',
    sessionId: 'active-session',
  });

  const active = await resolveAutomationDeliveryTarget({
    job: {
      ...baseJob,
      deliveryMode: 'origin',
      deliveryChannelId: 'telegram',
      deliveryChannelSessionKey: 'telegram:42',
      deliverySessionMode: 'channel_active',
    },
    userId,
    defaultSessionId: 'auto-active-fallback',
  });
  assert.equal(active.sessionId, 'active-session');
  assert.equal(active.mode, 'channel_active');
  assert.equal(active.channelId, 'telegram');

  const missingActive = await resolveAutomationDeliveryTarget({
    job: {
      ...baseJob,
      deliveryMode: 'origin',
      deliveryChannelId: 'telegram',
      deliveryChannelSessionKey: 'telegram:missing',
      deliverySessionMode: 'channel_active',
    },
    userId,
    defaultSessionId: 'auto-missing-active',
  });
  assert.equal(missingActive.sessionId, 'auto-missing-active');
  assert.equal(missingActive.mode, 'new_session');
  assert.ok(missingActive.warnings.length > 0);

  const webDispatch = await dispatchAutomationResult({
    job: baseJob,
    userId,
    resolution: webNew,
    text: 'Web result',
  });
  assert.equal(webDispatch.delivered, true);
  assert.equal(webDispatch.error, null);

  const delivered: Array<{ content: string; chatId: string }> = [];
  getChannelRegistry().register({
    id: 'telegram',
    name: 'Telegram Test',
    async start() {},
    async stop() {},
    async deliver(message, target) {
      delivered.push({ content: message.content, chatId: target.chatId });
      return { ok: true };
    },
    getStatus() {
      return { running: true, connected: true };
    },
  });

  const telegramDispatch = await dispatchAutomationResult({
    job: {
      ...baseJob,
      deliveryMode: 'origin',
      deliveryChannelId: 'telegram',
      deliveryChannelSessionKey: 'telegram:42',
    },
    userId,
    resolution: active,
    text: 'Telegram result',
  });
  assert.equal(telegramDispatch.delivered, true);
  assert.deepEqual(delivered, [{ content: 'Telegram result', chatId: '42' }]);
  getChannelRegistry().unregister('telegram');

  console.log('automation delivery tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AutomationJobRecord } from '../app/lib/automations/types';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;
let telegramChannelEnabled = true;
let telegramChannelLinked = true;

moduleInternals._load = (request, parent, isMain) => {
  if (request === '@earendil-works/pi-ai/compat') {
    return {
      getModels: () => [],
      getProviders: () => [],
      registerBuiltInApiProviders: () => undefined,
    };
  }
  if (request === '@/app/lib/channels/availability' || request.endsWith('/channels/availability')) {
    return {
      getChannelDeliveryReadiness: async () => !telegramChannelEnabled
        ? {
          ok: false,
          reason: 'channel_disabled',
          error: 'TELEGRAM_CHANNEL_ENABLED is false',
        }
        : !telegramChannelLinked
          ? {
            ok: false,
            reason: 'channel_unlinked',
            error: 'Telegram channel is no longer linked for this user',
          }
        : { ok: true },
    };
  }
  return originalLoad(request, parent, isMain);
};

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-automation-delivery-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_CHANNEL_ENABLED = 'true';

async function main() {
  const { eq } = await import('drizzle-orm');
  const { db } = await import('../app/lib/db');
  const { channelActiveSessions, user, piSessions, sessionChannelLinks } = await import('../app/lib/db/schema');
  const { setActiveChannelSession } = await import('../app/lib/channels/active-sessions');
  const { createBinding, deleteBinding } = await import('../app/lib/channels/telegram/link-token');
  const { getChannelRegistry } = await import('../app/lib/channels/registry');
  const {
    dispatchAutomationResult,
    getAutomationDeliveryFailureMessage,
    resolveAutomationDeliveryTarget,
    shouldPauseAutomationAfterDeliveryFailure,
  } = await import('../app/lib/automations/delivery');

  const now = new Date();
  const userId = 'user-automation-delivery';
  const personalWorkspace = {
    workspaceId: 'workspace-automation-delivery-personal',
    workspaceType: 'personal' as const,
  };

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
    integrityStatus: 'valid',
    integrityReason: null,
    revision: 1,
    scope: 'personal',
    jobScope: `personal:${userId}:personal`,
    organizationId: null,
    workspaceId: null,
    workspaceType: 'personal',
    ownerUserId: userId,
    responsibleUserId: userId,
    serviceActorId: null,
    approvedByUserId: null,
    lastEditedByUserId: userId,
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
    deletedAt: null,
    jobType: 'default',
    triggerKind: 'schedule',
    resultPolicy: 'deliver_all',
    eventConfig: null,
    channelId: null,
    composioTriggerId: null,
    composioTriggerSlug: null,
    composioToolkitSlug: null,
    composioConnectedAccountId: null,
    composioProfileId: null,
    composioUserId: null,
    webhookTriggerConfig: null,
  };

  const webNew = await resolveAutomationDeliveryTarget({
    job: baseJob,
    userId,
    defaultSessionId: 'auto-new',
    workspace: personalWorkspace,
  });
  assert.equal(webNew.sessionId, 'auto-new');
  assert.equal(webNew.mode, 'new_session');
  assert.equal(webNew.channelId, 'web');
  assert.equal(webNew.channelSessionKey, `web:user:${userId}`);

  const webLink = await db.query.sessionChannelLinks.findFirst({
    where: eq(sessionChannelLinks.sessionId, 'auto-new'),
  });
  assert.equal(webLink, undefined);

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
    workspace: personalWorkspace,
  });
  assert.equal(fixed.sessionId, 'fixed-session');
  assert.equal(fixed.mode, 'fixed_session');
  assert.deepEqual(fixed.warnings, []);
  const fixedLink = await db.query.sessionChannelLinks.findFirst({
    where: eq(sessionChannelLinks.sessionId, 'fixed-session'),
  });
  assert.equal(fixedLink, undefined, 'delivery resolution must remain read-only before the run claim');

  await db.insert(piSessions).values({
    sessionId: 'cross-workspace-session',
    userId,
    agentId: 'canvas-agent',
    provider: 'test-provider',
    model: 'test-model',
    title: 'Cross Workspace Session',
    workspaceId: 'workspace-other',
    workspaceType: 'organization',
    createdAt: now,
    updatedAt: now,
  });
  await assert.rejects(resolveAutomationDeliveryTarget({
    job: {
      ...baseJob,
      deliverySessionMode: 'fixed_session',
      deliverySessionId: 'cross-workspace-session',
    },
    userId,
    defaultSessionId: 'auto-cross-workspace-fallback',
    workspace: personalWorkspace,
  }), /selected chat is no longer available/);

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
    agentId: 'canvas-agent',
    channelId: 'telegram',
    channelSessionKey: 'telegram:42',
    sessionId: 'active-session',
  });
  await createBinding(userId, 'telegram', '42', 'delivery-tester');

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
    workspace: personalWorkspace,
  });
  assert.equal(active.sessionId, 'active-session');
  assert.equal(active.mode, 'channel_active');
  assert.equal(active.channelId, 'telegram');

  await setActiveChannelSession({
    userId,
    agentId: 'canvas-agent',
    channelId: 'telegram',
    channelSessionKey: 'telegram:99',
    sessionId: 'cross-workspace-session',
  });
  await db.update(channelActiveSessions)
    .set({ updatedAt: new Date(now.getTime() + 60_000) })
    .where(eq(channelActiveSessions.sessionId, 'cross-workspace-session'));
  await createBinding(userId, 'telegram', '99', 'other-workspace');

  const inferredActive = await resolveAutomationDeliveryTarget({
    job: {
      ...baseJob,
      deliveryMode: 'origin',
      deliveryChannelId: 'telegram',
      deliveryChannelSessionKey: null,
      deliverySessionMode: 'channel_active',
    },
    userId,
    defaultSessionId: 'auto-inferred-active',
    workspace: personalWorkspace,
  });
  assert.equal(inferredActive.sessionId, 'active-session');
  assert.equal(inferredActive.mode, 'channel_active');
  assert.equal(inferredActive.channelId, 'telegram');
  assert.equal(inferredActive.channelSessionKey, 'telegram:42');

  const lastActive = await resolveAutomationDeliveryTarget({
    job: {
      ...baseJob,
      deliveryMode: 'last_active',
      deliveryChannelId: null,
      deliveryChannelSessionKey: null,
      deliverySessionMode: 'channel_active',
    },
    userId,
    defaultSessionId: 'auto-last-active',
    workspace: personalWorkspace,
  });
  assert.equal(lastActive.sessionId, 'active-session');
  assert.equal(lastActive.mode, 'channel_active');
  assert.equal(lastActive.channelId, 'telegram');
  assert.equal(lastActive.channelSessionKey, 'telegram:42');
  assert.ok(lastActive.warnings.some((warning) => warning.includes('another workspace')));

  telegramChannelEnabled = false;
  const lastActiveFallback = await resolveAutomationDeliveryTarget({
    job: {
      ...baseJob,
      deliveryMode: 'last_active',
      deliveryChannelId: null,
      deliveryChannelSessionKey: null,
      deliverySessionMode: 'channel_active',
    },
    userId,
    defaultSessionId: 'auto-last-active-fallback',
    workspace: personalWorkspace,
  });
  assert.equal(lastActiveFallback.channelId, 'web');
  assert.equal(lastActiveFallback.channelSessionKey, `web:user:${userId}`);
  assert.ok(lastActiveFallback.warnings.some((warning) => warning.includes('falling back')));
  telegramChannelEnabled = true;

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
    workspace: personalWorkspace,
  });
  assert.equal(missingActive.sessionId, 'auto-missing-active');
  assert.equal(missingActive.mode, 'new_session');
  assert.ok(missingActive.warnings.length > 0);

  const missingExternalTarget = await resolveAutomationDeliveryTarget({
    job: {
      ...baseJob,
      agentId: 'other-agent',
      deliveryMode: 'origin',
      deliveryChannelId: 'slack',
      deliveryChannelSessionKey: null,
      deliverySessionMode: 'channel_active',
    },
    userId,
    defaultSessionId: 'auto-missing-external-target',
    workspace: personalWorkspace,
  });
  assert.equal(missingExternalTarget.channelId, 'slack');
  assert.equal(missingExternalTarget.channelSessionKey, '');
  const missingExternalDispatch = await dispatchAutomationResult({
    job: {
      ...baseJob,
      agentId: 'other-agent',
      deliveryMode: 'origin',
      deliveryChannelId: 'slack',
      deliveryChannelSessionKey: null,
    },
    userId,
    resolution: missingExternalTarget,
    text: 'Slack result',
  });
  assert.equal(missingExternalDispatch.delivered, false);
  assert.equal(missingExternalDispatch.skippedReason, 'missing_channel_session_key');
  assert.match(getAutomationDeliveryFailureMessage(missingExternalTarget, missingExternalDispatch) || '', /no channel session key/);

  const silentFallback = await resolveAutomationDeliveryTarget({
    job: {
      ...baseJob,
      deliveryMode: 'silent',
      deliveryChannelId: null,
      deliveryChannelSessionKey: null,
    },
    userId,
    defaultSessionId: 'auto-silent-fallback',
    workspace: personalWorkspace,
  });
  assert.equal(silentFallback.channelId, 'web');
  assert.equal(silentFallback.channelSessionKey, `web:user:${userId}`);
  assert.equal(silentFallback.activeDelivery, true);
  const silentFallbackDispatch = await dispatchAutomationResult({
    job: {
      ...baseJob,
      deliveryMode: 'silent',
      deliveryChannelId: null,
      deliveryChannelSessionKey: null,
    },
    userId,
    resolution: silentFallback,
    text: 'Legacy silent result',
  });
  assert.equal(silentFallbackDispatch.delivered, true);
  assert.equal(silentFallbackDispatch.error, null);

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

  telegramChannelEnabled = false;
  const disabledTelegramDispatch = await dispatchAutomationResult({
    job: {
      ...baseJob,
      deliveryMode: 'origin',
      deliveryChannelId: 'telegram',
      deliveryChannelSessionKey: 'telegram:42',
    },
    userId,
    resolution: active,
    text: 'Disabled Telegram result',
  });
  assert.equal(disabledTelegramDispatch.delivered, false);
  assert.equal(disabledTelegramDispatch.attempted, false);
  assert.equal(disabledTelegramDispatch.skippedReason, 'channel_disabled');
  assert.equal(shouldPauseAutomationAfterDeliveryFailure(disabledTelegramDispatch), true);
  assert.deepEqual(delivered, [{ content: 'Telegram result', chatId: '42' }]);
  assert.match(getAutomationDeliveryFailureMessage(active, disabledTelegramDispatch) || '', /channel is disabled/);
  telegramChannelEnabled = true;

  await deleteBinding(userId, 'telegram');
  telegramChannelLinked = false;
  const unlinkedTelegramDispatch = await dispatchAutomationResult({
    job: {
      ...baseJob,
      deliveryMode: 'origin',
      deliveryChannelId: 'telegram',
      deliveryChannelSessionKey: 'telegram:42',
    },
    userId,
    resolution: active,
    text: 'Unlinked Telegram result',
  });
  assert.equal(unlinkedTelegramDispatch.delivered, false);
  assert.equal(unlinkedTelegramDispatch.attempted, false);
  assert.equal(unlinkedTelegramDispatch.skippedReason, 'channel_unlinked');
  assert.equal(shouldPauseAutomationAfterDeliveryFailure(unlinkedTelegramDispatch), true);
  assert.deepEqual(delivered, [{ content: 'Telegram result', chatId: '42' }]);
  assert.match(getAutomationDeliveryFailureMessage(active, unlinkedTelegramDispatch) || '', /no longer linked/);

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

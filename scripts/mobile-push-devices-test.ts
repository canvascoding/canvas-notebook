import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const testRoot = mkdtempSync(path.join(tmpdir(), 'canvas-mobile-push-'));
process.env.DATA = testRoot;

async function main() {
  try {
  const {
    createAgentResponseReadyMessages,
    createMobilePushMessages,
    getMobilePushDeviceStatus,
    parseMobilePushRegistration,
    pollMobilePushReceipts,
    registerMobilePushDevice,
    sendAgentResponseReadyPush,
    sendMobileAttentionPush,
    unregisterMobilePushDevice,
  } = await import('../app/lib/mobile/push-devices');
  const { closeDatabaseConnections, openDb } = await import('../app/lib/db');
  const database = await openDb();
  const now = Date.now();
  await database.run(
    `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['push-user', 'Push User', 'push@example.test', 1, now, now],
  );
  await database.run(
    `INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['auth-session', now + 60_000, 'session-token', now, now, 'push-user'],
  );
  await database.close();

  const registration = parseMobilePushRegistration({
    installationId: 'installation-1',
    expoPushToken: 'ExpoPushToken[abc_DEF-123]',
    platform: 'ios',
    appVariant: 'preview',
    preferences: {
      agentResponseReady: true,
      todoAttention: true,
      studioCompleted: false,
      failureAttention: true,
    },
  });
  const registered = await registerMobilePushDevice({
    userId: 'push-user',
    authSessionId: 'auth-session',
    registration,
  });
  assert.equal(registered.registered, true);
  assert.equal(registered.enabled, true);
  assert.equal(registered.preferences.previews, false);
  assert.deepEqual(registered.preferences, {
    agentResponseReady: true,
    todoAttention: true,
    studioCompleted: false,
    failureAttention: true,
    previews: false,
  });

  const messages = createAgentResponseReadyMessages({
    tokens: [registration.expoPushToken],
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
  });
  assert.deepEqual(messages[0].data, {
    type: 'agent.response_ready',
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
  });
  assert.equal(messages[0].body.includes('workspace-1'), false);
  assert.equal(messages[0].body.includes('session-1'), false);

  const categoryMessages = createMobilePushMessages({
    tokens: [registration.expoPushToken],
    instanceId: 'cni_0123456789abcdef01234567',
    target: {
      type: 'attention.failure',
      workspaceId: 'workspace-secret',
      entityKind: 'automation',
      entityId: 'run-secret',
    },
  });
  assert.deepEqual(categoryMessages[0].data, {
    type: 'attention.failure',
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-secret',
    entityKind: 'automation',
    entityId: 'run-secret',
  });
  assert.equal(categoryMessages[0].body.includes('workspace-secret'), false);
  assert.equal(categoryMessages[0].body.includes('run-secret'), false);

  let sentPayload: unknown = null;
  const delivery = await sendAgentResponseReadyPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    fetcher: async (_url, init) => {
      sentPayload = JSON.parse(String(init?.body));
      return Response.json({ data: [{ status: 'ok', id: 'ticket-1' }] });
    },
  });
  assert.deepEqual(delivery, { attempted: 1, accepted: 1 });
  assert.deepEqual(sentPayload, messages);

  const afterTicketDatabase = await openDb();
  const ticketDelivery = await afterTicketDatabase.get(
    `SELECT category, entity_id, expo_ticket_id, status
     FROM mobile_push_deliveries
     WHERE expo_ticket_id = ?`,
    ['ticket-1'],
  ) as { category: string; entity_id: string; expo_ticket_id: string; status: string } | undefined;
  await afterTicketDatabase.close();
  assert.deepEqual(ticketDelivery, {
    category: 'agent.response_ready',
    entity_id: 'session-1',
    expo_ticket_id: 'ticket-1',
    status: 'ticket_accepted',
  });

  let receiptPayload: unknown = null;
  const receiptResult = await pollMobilePushReceipts({
    userId: 'push-user',
    now: now + 16 * 60_000,
    fetcher: async (_url, init) => {
      receiptPayload = JSON.parse(String(init?.body));
      return Response.json({ data: { 'ticket-1': { status: 'ok' } } });
    },
  });
  assert.deepEqual(receiptPayload, { ids: ['ticket-1'] });
  assert.deepEqual(receiptResult, { checked: 1, delivered: 1, failed: 0, pending: 0 });
  assert.ok((await getMobilePushDeviceStatus({
    userId: 'push-user',
    installationId: 'installation-1',
  })).lastDeliveryAt);

  const mutedStudio = await sendMobileAttentionPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    target: {
      type: 'studio.completed',
      workspaceId: 'workspace-1',
      generationId: 'generation-1',
    },
    fetcher: async () => {
      throw new Error('Muted category must not contact Expo.');
    },
  });
  assert.deepEqual(mutedStudio, { attempted: 0, accepted: 0 });

  let pushAttempts = 0;
  await sendMobileAttentionPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    target: { type: 'todo.attention', workspaceId: 'workspace-1', todoId: 'todo-1' },
    fetcher: async () => {
      pushAttempts += 1;
      if (pushAttempts === 1) return new Response(null, { status: 503 });
      return Response.json({
        data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
      });
    },
  });
  assert.equal(pushAttempts, 2);
  const disabled = await getMobilePushDeviceStatus({
    userId: 'push-user',
    installationId: 'installation-1',
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.lastErrorCode, 'DeviceNotRegistered');

  await registerMobilePushDevice({
    userId: 'push-user',
    authSessionId: 'auth-session',
    registration,
  });
  await sendMobileAttentionPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    now,
    target: {
      type: 'attention.failure',
      workspaceId: 'workspace-1',
      entityKind: 'automation',
      entityId: 'run-1',
    },
    fetcher: async () => Response.json({ data: [{ status: 'ok', id: 'ticket-2' }] }),
  });
  const failedReceipt = await pollMobilePushReceipts({
    userId: 'push-user',
    now: now + 32 * 60_000,
    fetcher: async () => Response.json({
      data: {
        'ticket-2': { status: 'error', details: { error: 'DeviceNotRegistered' } },
      },
    }),
  });
  assert.deepEqual(failedReceipt, { checked: 1, delivered: 0, failed: 1, pending: 0 });
  const disabledByReceipt = await getMobilePushDeviceStatus({
    userId: 'push-user',
    installationId: 'installation-1',
  });
  assert.equal(disabledByReceipt.enabled, false);
  assert.equal(disabledByReceipt.lastErrorCode, 'DeviceNotRegistered');

  const defaultPreferences = parseMobilePushRegistration({
    installationId: 'installation-2',
    expoPushToken: 'ExpoPushToken[defaults-123]',
    platform: 'android',
    appVariant: 'production',
  }).preferences;
  assert.deepEqual(defaultPreferences, {
    agentResponseReady: true,
    todoAttention: true,
    studioCompleted: true,
    failureAttention: true,
  });

  await unregisterMobilePushDevice({ userId: 'push-user', installationId: 'installation-1' });
  assert.equal((await getMobilePushDeviceStatus({
    userId: 'push-user',
    installationId: 'installation-1',
  })).registered, false);

  assert.throws(() => parseMobilePushRegistration({
    installationId: 'installation-2',
    expoPushToken: 'https://attacker.test/token',
    platform: 'ios',
    appVariant: 'production',
  }), /expoPushToken is invalid/u);

    await closeDatabaseConnections();
    console.log('mobile-push-devices-test: ok');
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

void main();

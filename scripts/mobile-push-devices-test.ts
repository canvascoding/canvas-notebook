import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const testRoot = mkdtempSync(path.join(tmpdir(), 'canvas-mobile-push-'));
process.env.DATA = testRoot;

async function main() {
  try {
  const {
    agentResponsePushSuppressionReason,
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
  const authNow = Math.floor(now / 1_000);
  await database.run(
    `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['push-user', 'Push User', 'push@example.test', 1, now, now],
  );
  await database.run(
    `INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['auth-session', authNow + 60, 'session-token', authNow, authNow, 'push-user'],
  );
  const responseAt = now + 1_000;
  await database.run(
    `INSERT INTO pi_sessions (
       session_id, user_id, provider, model, title, created_at, updated_at,
       last_message_at, last_viewed_at, workspace_id, workspace_type
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ['session-1', 'push-user', 'openai', 'test-model', 'Push session', now, now, responseAt, 'workspace-1', 'personal'],
  );
  const insertedSession = await database.get(
    'SELECT id FROM pi_sessions WHERE user_id = ? AND session_id = ?',
    ['push-user', 'session-1'],
  ) as { id: number };
  await database.run(
    `INSERT INTO pi_messages (pi_session_db_id, role, content, timestamp, sequence)
     VALUES (?, 'assistant', ?, ?, 1)`,
    [insertedSession.id, JSON.stringify({ role: 'assistant', content: 'Done', timestamp: responseAt }), responseAt],
  );
  await database.close();

  const unreadState = { lastMessageAt: responseAt, lastViewedAt: null, lastAssistantMessageId: 1 };
  assert.equal(agentResponsePushSuppressionReason(unreadState, unreadState), null);
  assert.equal(agentResponsePushSuppressionReason(unreadState, { ...unreadState, lastViewedAt: responseAt }), 'read');
  assert.equal(agentResponsePushSuppressionReason(unreadState, { ...unreadState, lastAssistantMessageId: 2 }), 'superseded');

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
    delayMs: 0,
    fetcher: async (_url, init) => {
      sentPayload = JSON.parse(String(init?.body));
      return Response.json({ data: [{ status: 'ok', id: 'ticket-1' }] });
    },
  });
  assert.deepEqual(delivery, { attempted: 1, accepted: 1 });
  assert.deepEqual(sentPayload, messages);

  let duplicatePushAttempts = 0;
  const duplicateFetcher = async () => {
    duplicatePushAttempts += 1;
    return Response.json({
      data: [{ status: 'error', details: { error: 'MessageTooBig' } }],
    });
  };
  const duplicateDeliveries = await Promise.all([
    sendAgentResponseReadyPush({
      userId: 'push-user',
      instanceId: 'cni_0123456789abcdef01234567',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      delayMs: 30,
      fetcher: duplicateFetcher,
    }),
    sendAgentResponseReadyPush({
      userId: 'push-user',
      instanceId: 'cni_0123456789abcdef01234567',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      delayMs: 30,
      fetcher: duplicateFetcher,
    }),
  ]);
  assert.equal(duplicatePushAttempts, 1);
  assert.deepEqual(duplicateDeliveries, [
    { attempted: 1, accepted: 0 },
    { attempted: 1, accepted: 0 },
  ]);

  const readDatabase = await openDb();
  await readDatabase.run(
    'UPDATE pi_sessions SET last_viewed_at = last_message_at WHERE user_id = ? AND session_id = ?',
    ['push-user', 'session-1'],
  );
  await readDatabase.close();
  const readSuppressed = await sendAgentResponseReadyPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    delayMs: 0,
    fetcher: async () => {
      throw new Error('A read agent response must not contact Expo.');
    },
  });
  assert.deepEqual(readSuppressed, { attempted: 0, accepted: 0 });

  const raceDatabase = await openDb();
  await raceDatabase.run(
    'UPDATE pi_sessions SET last_viewed_at = NULL WHERE user_id = ? AND session_id = ?',
    ['push-user', 'session-1'],
  );
  await raceDatabase.close();
  const readDuringDelayPromise = sendAgentResponseReadyPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    delayMs: 30,
    fetcher: async () => {
      throw new Error('A response read during the grace period must not contact Expo.');
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const readDuringDelayDatabase = await openDb();
  await readDuringDelayDatabase.run(
    'UPDATE pi_sessions SET last_viewed_at = last_message_at WHERE user_id = ? AND session_id = ?',
    ['push-user', 'session-1'],
  );
  await readDuringDelayDatabase.close();
  assert.deepEqual(await readDuringDelayPromise, { attempted: 0, accepted: 0 });

  const beforeSupersededDatabase = await openDb();
  await beforeSupersededDatabase.run(
    'UPDATE pi_sessions SET last_viewed_at = NULL WHERE user_id = ? AND session_id = ?',
    ['push-user', 'session-1'],
  );
  await beforeSupersededDatabase.close();
  const supersededPromise = sendAgentResponseReadyPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    delayMs: 30,
    fetcher: async () => {
      throw new Error('A superseded agent response must not contact Expo.');
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const supersedingDatabase = await openDb();
  await supersedingDatabase.run(
    `INSERT INTO pi_messages (pi_session_db_id, role, content, timestamp, sequence)
     VALUES (?, 'assistant', ?, ?, 2)`,
    [insertedSession.id, JSON.stringify({ role: 'assistant', content: 'Newer', timestamp: responseAt + 1_000 }), responseAt + 1_000],
  );
  await supersedingDatabase.run(
    'UPDATE pi_sessions SET last_message_at = ? WHERE user_id = ? AND session_id = ?',
    [responseAt + 1_000, 'push-user', 'session-1'],
  );
  await supersedingDatabase.close();
  assert.deepEqual(await supersededPromise, { attempted: 0, accepted: 0 });

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

  const automaticReregistration = await registerMobilePushDevice({
    userId: 'push-user',
    authSessionId: 'auth-session',
    registration,
  });
  assert.equal(automaticReregistration.enabled, false);
  assert.equal(automaticReregistration.lastErrorCode, 'DeviceNotRegistered');
  const explicitlyReactivated = await registerMobilePushDevice({
    userId: 'push-user',
    authSessionId: 'auth-session',
    registration: { ...registration, reactivate: true },
  });
  assert.equal(explicitlyReactivated.enabled, true);
  assert.equal(explicitlyReactivated.lastErrorCode, null);
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

  await registerMobilePushDevice({
    userId: 'push-user',
    authSessionId: 'auth-session',
    registration: { ...registration, reactivate: true },
  });
  await sendMobileAttentionPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    now,
    target: { type: 'todo.attention', workspaceId: 'workspace-1', todoId: 'todo-2' },
    fetcher: async () => Response.json({ data: [{ status: 'ok', id: 'ticket-3' }] }),
  });
  const badDeviceReceipt = await pollMobilePushReceipts({
    userId: 'push-user',
    now: now + 48 * 60_000,
    fetcher: async () => Response.json({
      data: {
        'ticket-3': {
          status: 'error',
          details: {
            error: 'DeveloperError',
            apns: { reason: 'BadDeviceToken', statusCode: 400 },
          },
        },
      },
    }),
  });
  assert.deepEqual(badDeviceReceipt, { checked: 1, delivered: 0, failed: 1, pending: 0 });
  const disabledByBadDeviceToken = await getMobilePushDeviceStatus({
    userId: 'push-user',
    installationId: 'installation-1',
  });
  assert.equal(disabledByBadDeviceToken.enabled, false);
  assert.equal(disabledByBadDeviceToken.lastErrorCode, 'BadDeviceToken');

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

    const bridgeSource = readFileSync(
      path.join(process.cwd(), 'server/chat-event-bridge.ts'),
      'utf8',
    );
    assert.equal(
      bridgeSource.match(/void sendAgentResponseReadyPush\(\{/gu)?.length,
      1,
      'each saved assistant response must schedule exactly one mobile push decision',
    );

    await closeDatabaseConnections();
    console.log('mobile-push-devices-test: ok');
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

void main();

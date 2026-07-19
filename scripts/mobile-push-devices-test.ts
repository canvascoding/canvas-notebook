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
    getMobilePushDeviceStatus,
    parseMobilePushRegistration,
    registerMobilePushDevice,
    sendAgentResponseReadyPush,
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
    preferences: { agentResponseReady: true },
  });
  const registered = await registerMobilePushDevice({
    userId: 'push-user',
    authSessionId: 'auth-session',
    registration,
  });
  assert.equal(registered.registered, true);
  assert.equal(registered.enabled, true);
  assert.equal(registered.preferences.previews, false);

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

  await sendAgentResponseReadyPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    fetcher: async () => Response.json({
      data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
    }),
  });
  const disabled = await getMobilePushDeviceStatus({
    userId: 'push-user',
    installationId: 'installation-1',
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.lastErrorCode, 'DeviceNotRegistered');

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

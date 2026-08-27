import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalData = process.env.DATA;
const originalInstanceId = process.env.CANVAS_INSTANCE_ID;
const originalControlPlaneUrl = process.env.CANVAS_LICENSE_CONTROL_PLANE_URL;

async function main() {
  const provider = process.env.CANVAS_DATABASE_PROVIDER;
  assert.ok(provider === 'sqlite' || provider === 'postgres');
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), `canvas-license-email-${provider}-`));
  const instanceId = 'self_a634a3e7-67c1-4c1f-b202-d76a4c0bc31b';
  const activationId = '88a79dcb-b35a-4c33-b82a-6e11f7a5f9aa';
  const pollToken = `lep_${'a'.repeat(64)}`;
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  process.env.DATA = path.join(temporaryRoot, 'data');
  process.env.CANVAS_INSTANCE_ID = instanceId;
  process.env.CANVAS_LICENSE_CONTROL_PLANE_URL = 'https://api.canvasnotebook.test';

  const storage = await import('../app/lib/license/email-activation-storage');
  const controlPlane = await import('../app/lib/license/control-plane');

  const registrationRequests: Record<string, unknown>[] = [];
  const registration = await controlPlane.requestCommunityLicenseRegistration({
    email: 'admin@example.test',
    activationUrl: 'https://notebook.example/settings?tab=license',
    marketingOptIn: false,
  }, {
    fetchImpl: async (_input, init) => {
      registrationRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        ok: true,
        status: 'issued',
        expiresAt,
        activation: {
          id: activationId,
          pollToken,
          expiresAt,
          pollIntervalSeconds: 5,
        },
      });
    },
  });
  assert.equal(registration.activation?.activationId, activationId);
  assert.equal(registrationRequests[0]?.instanceId, instanceId);

  await storage.savePendingLicenseEmailActivation({
    ...registration.activation!,
    instanceId,
  });
  const stored = await storage.loadPendingLicenseEmailActivation();
  assert.equal(stored?.pollToken, pollToken);
  assert.equal((await fs.stat(storage.resolvePendingLicenseEmailActivationPath())).mode & 0o777, 0o600);

  const pollRequests: Record<string, unknown>[] = [];
  const pending = await controlPlane.pollPendingLicenseEmailActivation({
    fetchImpl: async (_input, init) => {
      pollRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        activation: {
          status: 'authorization_pending',
          expiresAt,
          pollIntervalSeconds: 5,
        },
      });
    },
  });
  assert.equal(pending.state, 'authorization_pending');
  assert.equal(pollRequests[0]?.activationId, activationId);
  assert.equal(pollRequests[0]?.pollToken, pollToken);
  assert.equal(pollRequests[0]?.instanceId, instanceId);
  assert.equal(JSON.stringify(pending).includes(pollToken), false);

  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

main()
  .then(() => console.log(`license-email-activation-test (${process.env.CANVAS_DATABASE_PROVIDER}): ok`))
  .finally(() => {
    if (originalData === undefined) delete process.env.DATA;
    else process.env.DATA = originalData;
    if (originalInstanceId === undefined) delete process.env.CANVAS_INSTANCE_ID;
    else process.env.CANVAS_INSTANCE_ID = originalInstanceId;
    if (originalControlPlaneUrl === undefined) delete process.env.CANVAS_LICENSE_CONTROL_PLANE_URL;
    else process.env.CANVAS_LICENSE_CONTROL_PLANE_URL = originalControlPlaneUrl;
  });

/** Normal license services against the separately owned issuer fixture. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import path from 'node:path';
import { assertOrigin, hash, privateBytes, type OwnedYjsReceipt } from '../lib/owned-yjs-authority-qa';
import type { AgentWorkflowTeamIssuerReady } from './agent-workflow-team-issuer-fixture';

export async function readOwnedYjsIssuer(receipt: OwnedYjsReceipt): Promise<AgentWorkflowTeamIssuerReady> {
  const ready = JSON.parse((await privateBytes(path.join(receipt.fixtureRoot, 'issuer-ready.json'))).toString()) as AgentWorkflowTeamIssuerReady;
  assert.equal(ready.version, 1); assert.equal(ready.nonce, receipt.nonce); assert.equal(ready.fixtureRoot, receipt.fixtureRoot);
  assert.equal(ready.instanceId, `agent-settings-browser-${receipt.nonce}`);
  const origin = assertOrigin(ready.origin); assert.equal(origin.origin, ready.origin);
  const issued = JSON.parse((await privateBytes(path.join(receipt.fixtureRoot, 'issuer-recovery.json'))).toString());
  assert.equal(issued.nonce, receipt.nonce); assert.equal(issued.processId, receipt.issuerPid); assert.equal(issued.phase, 'ready');
  assert(receipt.issuerPid && issued.createAcknowledged && !issued.uncertain);
  assert(execFileSync('lsof', ['-nP', '-a', '-p', String(receipt.issuerPid), '-iTCP:' + origin.port, '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' })
    .split('\n').includes(`n127.0.0.1:${origin.port}`));
  assert(execFileSync('lsof', ['-a', '-p', String(receipt.issuerPid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').includes(`n${receipt.repo}`));
  assert.equal(ready.certificatePath, path.join(receipt.fixtureRoot, 'issuer-initial-certificate.jwt'));
  await privateBytes(ready.certificatePath);
  for (const [key, fingerprint] of [[ready.initialPublicKey, ready.initialPublicKeyFingerprint], [ready.testPublicKey, ready.testPublicKeyFingerprint]]) {
    assert.equal(hash(createPublicKey(key).export({ type: 'spki', format: 'der' })), fingerprint);
  }
  assert.notEqual(ready.initialPublicKeyFingerprint, ready.testPublicKeyFingerprint);
  assert(ready.controlSecret.length >= 32 && ready.licenseId && ready.cpOrganizationId);
  return ready;
}

export async function activateOwnedYjsTeam(ready: AgentWorkflowTeamIssuerReady, env: NodeJS.ProcessEnv): Promise<void> {
  Object.assign(env, { CANVAS_LICENSE_CONTROL_PLANE_URL: ready.origin, CANVAS_LICENSE_PUBLIC_KEY: ready.initialPublicKey,
    CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS: ready.initialPublicKeyFingerprint,
    CANVAS_LICENSE_TEST_PUBLIC_KEY: ready.testPublicKey, CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS: ready.testPublicKeyFingerprint,
    CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_TEST_AUDIENCE: 'canvas-notebook-test',
    CANVAS_TEAM_SEAT_CLIENT_ENABLED: 'true', CANVAS_TEAM_SEAT_COMMUNITY_CLAIM_ENABLED: 'true',
    CANVAS_TEAM_SEAT_MEMBERSHIP_MUTATIONS_ENABLED: 'true' });
  Object.assign(process.env, env);
  const { activateLicenseCert } = await import('../../app/lib/license');
  const { verifyLicenseJwtDetailed } = await import('../../app/lib/license/jwt');
  const { loadStoredLicenseCert } = await import('../../app/lib/license/storage');
  const { startCommunityLicenseClaim, pollCommunityLicenseClaim, refreshCommunityLicenseCertificate } = await import('../../app/lib/license/control-plane');
  const initialCertificate = (await privateBytes(ready.certificatePath)).toString();
  const initial = await verifyLicenseJwtDetailed(initialCertificate, ready.instanceId);
  assert(initial.ok); assert.equal(initial.payload.licenseId, ready.licenseId);
  const activated = await activateLicenseCert(initialCertificate);
  assert.equal(activated.licensed, true); assert.equal(activated.instanceId, ready.instanceId);
  const control = async (operation: 'approve-claim' | 'development-grant', body: Record<string, unknown>) => {
    const response = await fetch(`${ready.origin}/__owned/${operation}`, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${ready.controlSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200);
    const result = await response.json() as { success?: boolean; licenseId?: string; instanceId?: string };
    assert.equal(result.success, true); assert.equal(result.licenseId, ready.licenseId); assert.equal(result.instanceId, ready.instanceId);
  };
  const claim = await startCommunityLicenseClaim();
  assert.equal(claim.state, 'authorization_pending');
  assert('userCode' in claim && typeof claim.userCode === 'string' && 'claimId' in claim && typeof claim.claimId === 'string');
  await control('approve-claim', { userCode: claim.userCode });
  let connected = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await pollCommunityLicenseClaim(claim.claimId)).state === 'connected') { connected = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  assert(connected); await control('development-grant', {});
  env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'development'; process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'development';
  const refreshed = await refreshCommunityLicenseCertificate();
  assert.equal(refreshed.status.licensed, true); assert.equal(refreshed.status.edition, 'team');
  assert.equal(refreshed.status.licenseClass, 'test'); assert.equal(refreshed.status.licenseEnvironment, 'development');
  assert.equal(refreshed.status.seatLimit, 1); assert.equal(refreshed.details.id, ready.licenseId);
  const stored = await loadStoredLicenseCert(ready.instanceId); assert(stored);
  const verified = await verifyLicenseJwtDetailed(stored, ready.instanceId); assert(verified.ok);
  assert.equal(verified.payload.licenseId, ready.licenseId); assert.equal(verified.payload.nonBillable, true); assert.equal(verified.payload.provider, 'test');
  Object.assign(env, { CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true' }); Object.assign(process.env, env);
}

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url');
}

function publicKeyFingerprint(publicKeyPem: string) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function signLicense(
  privateKey: crypto.KeyObject,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' },
) {
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    privateKey,
  );
  return `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`;
}

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-license-security-'));
  process.env.DATA = dataDir;
  process.env.CANVAS_INSTANCE_ID = 'self_license_test';

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = publicKeyFingerprint(publicKeyPem);
  process.env.CANVAS_LICENSE_PUBLIC_KEY = publicKeyPem;
  process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;

  const { verifyLicenseJwt } = await import('../app/lib/license/jwt');
  const {
    LicenseEntitlementError,
    requireLicenseFeature,
    requireLicenseQuota,
    requireLicensePlan,
    requireTeamRuntimeLicense,
  } = await import('../app/lib/license/entitlements');

  const basePayload = {
    sub: 'self_license_test',
    iss: 'canvas-control-plane',
    aud: 'canvas-notebook',
    plan: 'managed',
    status: 'active',
    deploymentMode: 'managed-team',
    databaseProvider: 'postgres',
    vectorProvider: 'pgvector',
    postgresRequired: true,
    capabilities: { teamWorkspace: true, multiUser: true, vectorSearch: true, liveCollaboration: false },
    features: { teamWorkspace: true, multiUser: true, vectorSearch: true },
    quotas: { users: 10 },
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  const validToken = signLicense(privateKey, basePayload);
  assert.equal((await verifyLicenseJwt(validToken, 'self_license_test'))?.plan, 'managed');

  assert.equal(await verifyLicenseJwt(signLicense(privateKey, { ...basePayload, iss: 'other' }), 'self_license_test'), null);
  assert.equal(await verifyLicenseJwt(signLicense(privateKey, { ...basePayload, aud: 'other' }), 'self_license_test'), null);
  assert.equal(await verifyLicenseJwt(signLicense(privateKey, { ...basePayload, status: 'issued' }), 'self_license_test'), null);
  assert.equal(await verifyLicenseJwt(signLicense(privateKey, { ...basePayload, sub: 'other_instance' }), 'self_license_test'), null);
  assert.equal(
    await verifyLicenseJwt(signLicense(privateKey, { ...basePayload, iat: Math.floor(Date.now() / 1000) + 600 }), 'self_license_test'),
    null,
  );

  const { privateKey: forgedPrivateKey, publicKey: forgedPublicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.CANVAS_LICENSE_PUBLIC_KEY = forgedPublicKey.export({ type: 'spki', format: 'pem' }).toString();
  const forgedToken = signLicense(forgedPrivateKey, basePayload);
  assert.equal(await verifyLicenseJwt(forgedToken, 'self_license_test'), null);

  process.env.CANVAS_LICENSE_PUBLIC_KEY = publicKeyPem;
  process.env.CANVAS_LICENSE_CERT = validToken;
  assert.equal((await requireLicenseFeature('teamWorkspace')).features.teamWorkspace, true);
  assert.equal((await requireLicensePlan(['managed'])).plan, 'managed');
  assert.equal((await requireLicenseQuota('users', 5)).quotas.users, 10);
  const teamRuntimeStatus = await requireTeamRuntimeLicense();
  assert.equal(teamRuntimeStatus.databaseProvider, 'postgres');
  assert.equal(teamRuntimeStatus.vectorProvider, 'pgvector');
  assert.equal(teamRuntimeStatus.postgresRequired, true);

  await assert.rejects(
    () => requireLicenseFeature('teamKnowledgeBase'),
    (error) => error instanceof LicenseEntitlementError && error.code === 'LICENSE_FEATURE_REQUIRED',
  );
  await assert.rejects(
    () => requireLicensePlan(['pro']),
    (error) => error instanceof LicenseEntitlementError && error.code === 'LICENSE_PLAN_REQUIRED',
  );
  await assert.rejects(
    () => requireLicenseQuota('users', 11),
    (error) => error instanceof LicenseEntitlementError && error.code === 'LICENSE_QUOTA_REQUIRED',
  );

  process.env.CANVAS_LICENSE_CERT = signLicense(privateKey, {
    ...basePayload,
    deploymentMode: 'managed-single',
    databaseProvider: 'sqlite',
    vectorProvider: 'none',
    postgresRequired: false,
    capabilities: { teamWorkspace: false, multiUser: false, vectorSearch: false, liveCollaboration: false },
    features: { teamWorkspace: false },
  });
  await assert.rejects(
    () => requireTeamRuntimeLicense(),
    (error) => error instanceof LicenseEntitlementError && error.code === 'LICENSE_FEATURE_REQUIRED',
  );

  rmSync(dataDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

function fingerprint(publicKey: string): string {
  const der = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function sign(privateKey: crypto.KeyObject, payload: Record<string, unknown>, kid: string): string {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

async function main(): Promise<void> {
  const names = [
    'CANVAS_LICENSE_PUBLIC_KEY',
    'CANVAS_LICENSE_TEST_PUBLIC_KEY',
    'CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS',
    'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS',
    'CANVAS_LICENSE_RUNTIME_ENVIRONMENT',
    'CANVAS_LICENSE_TEST_AUDIENCE',
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    const production = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const test = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const productionPublic = production.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const testPublic = test.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const productionFingerprint = fingerprint(productionPublic);
    const testFingerprint = fingerprint(testPublic);
    process.env.CANVAS_LICENSE_PUBLIC_KEY = productionPublic;
    process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY = testPublic;
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = productionFingerprint;
    process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS = testFingerprint;
    process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'development';
    delete process.env.CANVAS_LICENSE_TEST_AUDIENCE;
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    const nowSeconds = Math.floor(Date.now() / 1000);
    const base = {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      licenseId: 'isolation-license',
      instanceId: 'isolation-instance',
      sub: 'isolation-instance',
      iss: 'canvas-control-plane',
      plan: 'community',
      status: 'active',
      hostingMode: 'community',
      edition: 'team',
      seatLimit: 3,
      entitlementsVersion: 7,
      deploymentMode: 'community',
      databaseProvider: 'postgres',
      vectorProvider: 'pgvector',
      postgresRequired: true,
      capabilities: { multiUser: true, teamWorkspace: true },
      features: { multiUser: true, teamWorkspace: true },
      quotas: { users: 3 },
      iat: nowSeconds - 60,
      exp: nowSeconds + 3600,
    };
    const testClaims = {
      ...base,
      licenseClass: 'test',
      licenseEnvironment: 'development',
      provider: 'test',
      grantId: 'test-grant',
      nonBillable: true,
      aud: 'canvas-notebook-test',
    };
    const testToken = sign(test.privateKey, testClaims, `test-${testFingerprint.slice(0, 16)}`);
    assert.equal((await verifyLicenseJwtDetailed(testToken, base.instanceId)).ok, true);
    const wrongKey = sign(production.privateKey, testClaims, `test-${testFingerprint.slice(0, 16)}`);
    const wrongKeyResult = await verifyLicenseJwtDetailed(wrongKey, base.instanceId);
    assert.equal(wrongKeyResult.ok, false);
    if (!wrongKeyResult.ok) assert.equal(wrongKeyResult.code, 'LICENSE_CERT_SIGNATURE_INVALID');
    const productionClaims = {
      ...base,
      licenseClass: 'commercial',
      licenseEnvironment: 'production',
      nonBillable: false,
      aud: 'canvas-notebook',
    };
    const productionToken = sign(production.privateKey, productionClaims, productionFingerprint.slice(0, 16));
    const productionInDevelopment = await verifyLicenseJwtDetailed(productionToken, base.instanceId);
    assert.equal(productionInDevelopment.ok, false);
    if (!productionInDevelopment.ok) assert.equal(productionInDevelopment.code, 'LICENSE_CERT_ENVIRONMENT_INVALID');
    process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'production';
    const testInProduction = await verifyLicenseJwtDetailed(testToken, base.instanceId);
    assert.equal(testInProduction.ok, false);
    if (!testInProduction.ok) assert.equal(testInProduction.code, 'LICENSE_CERT_ENVIRONMENT_INVALID');
    assert.equal((await verifyLicenseJwtDetailed(productionToken, base.instanceId)).ok, true);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
  console.log('license-environment-isolation-test: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

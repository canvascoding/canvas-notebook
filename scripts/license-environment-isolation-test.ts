import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function publicKeyFingerprint(publicKeyPem: string): string {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function keyPair() {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = publicKeyFingerprint(publicKey);
  return {
    privateKey: pair.privateKey,
    publicKey,
    fingerprint,
    productionKid: fingerprint.slice(0, 16),
    testKid: `test-${fingerprint.slice(0, 16)}`,
  };
}

function signLicense(
  privateKey: crypto.KeyObject,
  kid: string,
  payload: Record<string, unknown>,
): string {
  const encodedHeader = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    privateKey,
  );
  return `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`;
}

function modernPayload(input: {
  licenseClass: 'commercial' | 'manual' | 'test';
  licenseEnvironment: 'development' | 'test' | 'staging' | 'production';
  audience: string;
}) {
  const grant = input.licenseClass === 'commercial'
    ? {}
    : {
        grantId: `grant-${input.licenseClass}`,
        nonBillable: true,
        provider: input.licenseClass,
      };
  return {
    sub: 'license-isolation-instance',
    iss: 'canvas-control-plane',
    aud: input.audience,
    plan: 'community',
    status: 'active',
    protocolVersion: 'canvas-team-seat-protocol-v1',
    licenseId: 'license-isolation',
    instanceId: 'license-isolation-instance',
    hostingMode: 'community',
    edition: 'team',
    licenseClass: input.licenseClass,
    licenseEnvironment: input.licenseEnvironment,
    provider: input.licenseClass === 'commercial' ? 'stripe' : input.licenseClass,
    seatLimit: 3,
    entitlementsVersion: 4,
    nonBillable: input.licenseClass !== 'commercial',
    deploymentMode: 'community-team',
    databaseProvider: 'postgres',
    vectorProvider: 'pgvector',
    postgresRequired: true,
    capabilities: {
      multiUser: true,
      teamWorkspace: true,
      vectorSearch: true,
      liveCollaboration: true,
    },
    features: { multiUser: true, teamWorkspace: true },
    quotas: { users: 3 },
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...grant,
  };
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'canvas-license-environment-'));
  const environmentNames = [
    'DATA',
    'CANVAS_DATABASE_PROVIDER',
    'CANVAS_INSTANCE_ID',
    'CANVAS_LICENSE_RUNTIME_ENVIRONMENT',
    'CANVAS_LICENSE_PUBLIC_KEY',
    'CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS',
    'CANVAS_LICENSE_TEST_PUBLIC_KEY',
    'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS',
    'CANVAS_LICENSE_TEST_AUDIENCE',
  ] as const;
  const previousEnvironment = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  const originalFetch = globalThis.fetch;
  const productionOne = keyPair();
  const productionTwo = keyPair();
  const testOne = keyPair();

  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_INSTANCE_ID = 'license-isolation-instance';
  process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'development';
  process.env.CANVAS_LICENSE_PUBLIC_KEY = JSON.stringify([
    productionOne.publicKey,
    productionTwo.publicKey,
  ]);
  process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = [
    productionOne.fingerprint,
    productionTwo.fingerprint,
  ].join(',');
  process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY = testOne.publicKey;
  process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS = testOne.fingerprint;
  process.env.CANVAS_LICENSE_TEST_AUDIENCE = 'canvas-notebook-test';

  try {
    const {
      verifyLicenseJwtDetailed,
    } = await import('../app/lib/license/jwt');
    const {
      resolveLicensePublicKeys,
    } = await import('../app/lib/license/public-key');
    const {
      activateLicenseCert,
    } = await import('../app/lib/license');

    const testPayload = modernPayload({
      licenseClass: 'test',
      licenseEnvironment: 'development',
      audience: 'canvas-notebook-test',
    });
    const validTest = signLicense(testOne.privateKey, testOne.testKid, testPayload);
    assert.equal(
      (await verifyLicenseJwtDetailed(validTest, 'license-isolation-instance')).ok,
      true,
    );

    const testSignedByProduction = await verifyLicenseJwtDetailed(
      signLicense(productionOne.privateKey, productionOne.productionKid, testPayload),
      'license-isolation-instance',
    );
    assert.equal(testSignedByProduction.ok, false);
    if (!testSignedByProduction.ok) {
      assert.equal(testSignedByProduction.code, 'LICENSE_CERT_KEY_ID_UNKNOWN');
    }

    const wrongTestAudience = await verifyLicenseJwtDetailed(
      signLicense(testOne.privateKey, testOne.testKid, {
        ...testPayload,
        aud: 'canvas-notebook',
      }),
      'license-isolation-instance',
    );
    assert.equal(wrongTestAudience.ok, false);
    if (!wrongTestAudience.ok) {
      assert.equal(wrongTestAudience.code, 'LICENSE_CERT_AUDIENCE_INVALID');
    }

    process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'production';
    const productionRejectsTest = await verifyLicenseJwtDetailed(
      signLicense(productionOne.privateKey, productionOne.productionKid, {
        ...testPayload,
        licenseEnvironment: 'test',
      }),
      'license-isolation-instance',
      {
        nowMs: Date.now(),
        licenseEnvironment: 'test',
      } as { nowMs?: number },
    );
    assert.equal(productionRejectsTest.ok, false);
    if (!productionRejectsTest.ok) {
      assert.equal(productionRejectsTest.code, 'LICENSE_CERT_ENVIRONMENT_INVALID');
    }

    const manualPayload = modernPayload({
      licenseClass: 'manual',
      licenseEnvironment: 'production',
      audience: 'canvas-notebook',
    });
    const validManual = await verifyLicenseJwtDetailed(
      signLicense(productionOne.privateKey, productionOne.productionKid, manualPayload),
      'license-isolation-instance',
    );
    assert.equal(validManual.ok, true);
    const activatedManual = await activateLicenseCert(
      signLicense(
        productionOne.privateKey,
        productionOne.productionKid,
        manualPayload,
      ),
      {
        licenseId: 'license-isolation',
        instanceId: 'license-isolation-instance',
        plan: 'community',
        status: 'active',
        hostingMode: 'community',
        edition: 'team',
        licenseClass: 'manual',
        licenseEnvironment: 'production',
        entitlementsVersion: 4,
      },
    );
    assert.equal(activatedManual.licenseClass, 'manual');
    assert.equal(activatedManual.licenseEnvironment, 'production');
    assert.equal(activatedManual.seatLimit, 3);

    for (const invalidManualPayload of [
      { ...manualPayload, grantId: undefined },
      { ...manualPayload, provider: 'test' },
      { ...manualPayload, nonBillable: false },
    ]) {
      const result = await verifyLicenseJwtDetailed(
        signLicense(
          productionOne.privateKey,
          productionOne.productionKid,
          invalidManualPayload,
        ),
        'license-isolation-instance',
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'LICENSE_CERT_CLAIMS_INVALID');
    }

    const manualSignedByTest = await verifyLicenseJwtDetailed(
      signLicense(testOne.privateKey, testOne.testKid, manualPayload),
      'license-isolation-instance',
    );
    assert.equal(manualSignedByTest.ok, false);
    if (!manualSignedByTest.ok) {
      assert.equal(manualSignedByTest.code, 'LICENSE_CERT_KEY_ID_UNKNOWN');
    }

    process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY = productionOne.publicKey;
    process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS =
      productionOne.fingerprint;
    const confusedProductionKeyset = await resolveLicensePublicKeys({
      keyset: 'production',
    });
    assert.deepEqual(
      confusedProductionKeyset.keys.map((key) => key.kid),
      [productionTwo.productionKid],
    );

    delete process.env.CANVAS_LICENSE_PUBLIC_KEY;
    delete process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY;
    process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS =
      testOne.fingerprint;
    let currentProduction = productionOne;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/license/public-key/test')) {
        return Response.json({
          publicKey: testOne.publicKey,
          alg: 'RS256',
          kid: testOne.testKid,
          fingerprint: testOne.fingerprint,
          audience: 'canvas-notebook-test',
          licenseClass: 'test',
        });
      }
      return Response.json({
        publicKey: currentProduction.publicKey,
        alg: 'RS256',
        kid: currentProduction.productionKid,
        fingerprint: currentProduction.fingerprint,
      });
    };

    const firstProductionResolution = await resolveLicensePublicKeys({
      keyset: 'production',
      forceRefresh: true,
    });
    assert.deepEqual(
      firstProductionResolution.keys.map((key) => key.kid),
      [productionOne.productionKid],
    );
    currentProduction = productionTwo;
    const rotatedCommercial = modernPayload({
      licenseClass: 'commercial',
      licenseEnvironment: 'production',
      audience: 'canvas-notebook',
    });
    const rotatedResult = await verifyLicenseJwtDetailed(
      signLicense(
        productionTwo.privateKey,
        productionTwo.productionKid,
        rotatedCommercial,
      ),
      'license-isolation-instance',
    );
    assert.equal(rotatedResult.ok, true);

    process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'development';
    const fetchedTestResolution = await resolveLicensePublicKeys({
      keyset: 'test',
      forceRefresh: true,
    });
    assert.deepEqual(
      fetchedTestResolution.keys.map((key) => key.kid),
      [testOne.testKid],
    );

    const { openDb } = await import('../app/lib/db');
    const database = await openDb();
    const persisted = await database.all(`
      SELECT source, kid
      FROM license_public_keys
      ORDER BY source, kid
    `) as Array<{ source: string; kid: string }>;
    await database.close();
    assert.deepEqual(
      persisted.map((row) => `${row.source}:${row.kid}`).sort(),
      [
        `control_plane_production:${productionOne.productionKid}`,
        `control_plane_production:${productionTwo.productionKid}`,
        `control_plane_test:${testOne.testKid}`,
      ].sort(),
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of environmentNames) {
      const value = previousEnvironment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().then(() => console.log('license-environment-isolation-test: ok'));

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';

const instanceId = 'manual-production-activation-test';

function fingerprint(publicKey: string): string {
  const der = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function sign(privateKey: crypto.KeyObject, payload: Record<string, unknown>, kid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}

async function child(mode: string): Promise<void> {
  const { activateLicenseCert, getLicenseStatus } = await import('../app/lib/license');
  const { loadStoredLicenseCert } = await import('../app/lib/license/storage');
  const token = process.env.CANVAS_ACTIVATION_TEST_CERT;
  const testToken = process.env.CANVAS_ACTIVATION_TEST_TEST_CERT;
  assert(token && testToken);
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount++;
    throw new Error('Unexpected external request during license activation.');
  }) as typeof fetch;
  assert.equal(process.env.STRIPE_SECRET_KEY, undefined);
  assert.equal(process.env.STRIPE_WEBHOOK_SECRET, undefined);

  if (mode === 'activate') {
    const status = await activateLicenseCert(token);
    assert.equal(status.licensed, true);
    assert.equal(status.licenseClass, 'manual');
    assert.equal(status.licenseEnvironment, 'production');
    assert.equal(status.seatLimit, 7);
    assert.equal(status.quotas.users, 7);
    assert.equal(await loadStoredLicenseCert(instanceId), token);
  } else if (mode === 'reload') {
    const status = await getLicenseStatus();
    assert.equal(status.source, 'stored');
    assert.equal(status.licensed, true);
    assert.equal(status.seatLimit, 7);
    assert.equal(status.licenseClass, 'manual');
    assert.equal(await loadStoredLicenseCert(instanceId), token);
    await assert.rejects(activateLicenseCert(testToken), (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'LICENSE_CERT_ENVIRONMENT_INVALID'
    ));
    assert.equal(await loadStoredLicenseCert(instanceId), token);
  } else {
    assert.fail(`Unknown child mode: ${mode}`);
  }
  assert.equal(fetchCount, 0);
  const { closeDatabaseConnections } = await import('../app/lib/db');
  await closeDatabaseConnections();
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'activate' || mode === 'reload') {
    await child(mode);
    return;
  }
  assert.equal(mode, undefined);
  const sourceUrl = process.env.DATABASE_URL;
  assert(sourceUrl, 'Set DATABASE_URL to the single local Team Seat PostgreSQL server.');
  const maintenanceUrl = new URL(sourceUrl);
  assert(['127.0.0.1', 'localhost'].includes(maintenanceUrl.hostname));
  const name = `canvas_manual_activation_${crypto.randomBytes(8).toString('hex')}`;
  const testUrl = new URL(sourceUrl);
  testUrl.pathname = `/${name}`;
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'canvas-manual-activation-'));
  const admin = new Client({ connectionString: sourceUrl });
  let created = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const testDb = new Client({ connectionString: testUrl.toString() });
    try {
      await testDb.connect();
      await testDb.query(`
        CREATE TABLE license_certs (
          id bigserial PRIMARY KEY,
          cert text NOT NULL,
          plan text NOT NULL,
          instance_id text NOT NULL,
          expires_at bigint,
          created_at bigint NOT NULL,
          updated_at bigint NOT NULL
        )
      `);
      await testDb.query('CREATE UNIQUE INDEX idx_license_certs_instance_cert ON license_certs (instance_id, cert)');
    } finally {
      await testDb.end();
    }

    const production = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const test = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const productionPublic = production.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const testPublic = test.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: instanceId,
      instanceId,
      iss: 'canvas-control-plane',
      aud: 'canvas-notebook',
      plan: 'managed',
      status: 'active',
      protocolVersion: 'canvas-team-seat-protocol-v1',
      licenseId: 'manual-production-license',
      hostingMode: 'cloud',
      edition: 'team',
      licenseClass: 'manual',
      licenseEnvironment: 'production',
      provider: 'manual',
      grantId: 'manual-production-grant',
      nonBillable: true,
      seatLimit: 7,
      entitlementsVersion: 9,
      deploymentMode: 'managed-team',
      databaseProvider: 'postgres',
      vectorProvider: 'pgvector',
      postgresRequired: true,
      capabilities: { multiUser: true, teamWorkspace: true },
      features: { multiUser: true, teamWorkspace: true },
      quotas: { users: 7 },
      iat: now - 60,
      exp: now + 3600,
    };
    const productionFingerprint = fingerprint(productionPublic);
    const testFingerprint = fingerprint(testPublic);
    const certificate = sign(production.privateKey, claims, productionFingerprint.slice(0, 16));
    const testCertificate = sign(test.privateKey, {
      ...claims,
      aud: 'canvas-notebook-test',
      licenseClass: 'test',
      licenseEnvironment: 'development',
      provider: 'test',
    }, `test-${testFingerprint.slice(0, 16)}`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: testUrl.toString(),
      DATA: dataRoot,
      CANVAS_INSTANCE_ID: instanceId,
      CANVAS_DATABASE_PROVIDER: 'postgres',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production',
      CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test',
      CANVAS_LICENSE_PUBLIC_KEY: productionPublic,
      CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS: productionFingerprint,
      CANVAS_LICENSE_TEST_PUBLIC_KEY: testPublic,
      CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS: testFingerprint,
      CANVAS_ACTIVATION_TEST_CERT: certificate,
      CANVAS_ACTIVATION_TEST_TEST_CERT: testCertificate,
    };
    delete env.STRIPE_SECRET_KEY;
    delete env.STRIPE_WEBHOOK_SECRET;
    delete env.CANVAS_LICENSE_CERT;
    delete env.CANVAS_INSTANCE_TOKEN;
    const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
    for (const phase of ['activate', 'reload']) {
      const result = spawnSync(tsx, ['--conditions', 'react-server', 'scripts/production-manual-license-activation-test.ts', phase], {
        cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000,
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `${phase} failed:\n${result.stdout}\n${result.stderr}`);
    }
    const verification = new Client({ connectionString: testUrl.toString() });
    try {
      await verification.connect();
      const rows = await verification.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM license_certs');
      assert.equal(rows.rows[0]?.count, '1');
    } finally {
      await verification.end();
    }
    console.log('production-manual-license-activation-test: ok');
  } finally {
    if (created) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
      await admin.query(`DROP DATABASE "${name}"`);
    }
    await admin.end().catch(() => undefined);
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

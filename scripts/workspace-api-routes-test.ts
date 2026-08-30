import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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

function signLicense(
  privateKey: crypto.KeyObject,
  payload: Record<string, unknown>,
): string {
  const encodedHeader = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    privateKey,
  );
  return `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`;
}

async function main(): Promise<void> {
  const environmentKeys = [
    'DATA',
    'DATABASE_URL',
    'CANVAS_DATABASE_PROVIDER',
    'CANVAS_INSTANCE_ID',
    'CANVAS_LICENSE_CERT',
    'CANVAS_LICENSE_PUBLIC_KEY',
    'CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS',
  ] as const;
  const originalEnvironment = new Map(
    environmentKeys.map((key) => [key, process.env[key]] as const),
  );
  const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-workspace-runtime-guard-'));

  try {
    const instanceId = 'self_workspace_runtime_guard_test';
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.DATA = dataDir;
    process.env.CANVAS_INSTANCE_ID = instanceId;
    process.env.CANVAS_LICENSE_PUBLIC_KEY = publicKeyPem;
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = publicKeyFingerprint(publicKeyPem);
    process.env.CANVAS_LICENSE_CERT = signLicense(privateKey, {
      sub: instanceId,
      iss: 'canvas-control-plane',
      aud: 'canvas-notebook',
      plan: 'managed',
      status: 'active',
      deploymentMode: 'managed-team',
      databaseProvider: 'postgres',
      vectorProvider: 'pgvector',
      postgresRequired: true,
      capabilities: { teamWorkspace: true, multiUser: true, vectorSearch: true },
      features: { teamWorkspace: true, multiUser: true, vectorSearch: true },
      quotas: { users: 25 },
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const {
      LicenseEntitlementError,
      requireTeamRuntimeLicense,
    } = await import('../app/lib/license/entitlements');
    const { requireTeamRuntimeRoute } = await import('../app/lib/license/team-route-guard');

    process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
    delete process.env.DATABASE_URL;
    await assert.rejects(
      () => requireTeamRuntimeLicense(),
      (error) => error instanceof LicenseEntitlementError
        && error.code === 'LICENSE_FEATURE_REQUIRED'
        && error.statusCode === 403
        && error.details.runtimeDatabaseProvider === 'sqlite'
        && Array.isArray(error.details.blockers)
        && error.details.blockers.includes('team_requires_postgres'),
    );
    const sqliteRouteResponse = await requireTeamRuntimeRoute();
    assert(sqliteRouteResponse);
    assert.equal(sqliteRouteResponse.status, 403);
    const sqliteRoutePayload = await sqliteRouteResponse.json() as Record<string, unknown>;
    assert.equal(sqliteRoutePayload.code, 'LICENSE_FEATURE_REQUIRED');
    assert.equal(sqliteRoutePayload.runtimeDatabaseProvider, 'sqlite');

    process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
    process.env.DATABASE_URL = 'postgresql://127.0.0.1/canvas_workspace_runtime_guard_test';
    const postgresStatus = await requireTeamRuntimeLicense();
    assert.equal(postgresStatus.licensed, true);
    assert.equal(postgresStatus.edition, 'team');

    delete process.env.DATABASE_URL;
    const missingDatabaseUrlResponse = await requireTeamRuntimeRoute();
    assert(missingDatabaseUrlResponse);
    assert.equal(missingDatabaseUrlResponse.status, 403);
    const missingDatabaseUrlPayload = await missingDatabaseUrlResponse.json() as Record<string, unknown>;
    assert.equal(missingDatabaseUrlPayload.runtimeDatabaseProvider, 'postgres');
    assert.deepEqual(missingDatabaseUrlPayload.blockers, ['postgres_missing_database_url']);
  } finally {
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

void main().then(
  () => console.log('workspace api route runtime guard tests passed'),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);

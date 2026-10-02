import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function signCertificate(
  privateKey: crypto.KeyObject,
  payload: Record<string, unknown>,
  kid: string,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}

async function main(): Promise<void> {
  const environmentNames = [
    'DATA', 'CANVAS_DATA_ROOT', 'CANVAS_INSTANCE_ID', 'CANVAS_LICENSE_CERT',
    'CANVAS_LICENSE_PUBLIC_KEY', 'CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS',
    'CANVAS_LICENSE_TEST_PUBLIC_KEY', 'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS',
    'CANVAS_LICENSE_RUNTIME_ENVIRONMENT', 'CANVAS_LICENSE_CONTROL_PLANE_URL', 'NEXT_PHASE',
  ] as const;
  const previous = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-license-claim-selection-'));
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  try {
    const trusted = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const untrusted = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKey = trusted.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const fingerprint = crypto.createHash('sha256')
      .update(trusted.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    const kid = fingerprint.slice(0, 16);
    const instanceId = 'instance-claim-certificate-selection';
    process.env.DATA = dataRoot;
    process.env.CANVAS_DATA_ROOT = dataRoot;
    process.env.CANVAS_INSTANCE_ID = instanceId;
    process.env.CANVAS_LICENSE_PUBLIC_KEY = publicKey;
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    delete process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY;
    delete process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS;
    process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'production';
    process.env.CANVAS_LICENSE_CONTROL_PLANE_URL = 'https://control.example.test';
    // The loader is the only injected dependency. Accidental runtime DB access must fail.
    process.env.NEXT_PHASE = 'phase-production-build';
    globalThis.fetch = async () => {
      fetches += 1;
      throw new Error('Certificate selection must use the configured trusted public key without network IO.');
    };

    const { claimCertificate, LicenseControlPlaneError } = await import('../app/lib/license/control-plane');
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    const { DatabaseUnavailableError } = await import('../app/lib/db/errors');
    const now = Math.floor(Date.now() / 1000);
    const base = {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      licenseId: 'license-claim-certificate-selection',
      sub: instanceId,
      instanceId,
      iss: 'canvas-control-plane',
      aud: 'canvas-notebook',
      plan: 'community',
      status: 'active',
      hostingMode: 'community',
      edition: 'team',
      licenseClass: 'commercial',
      licenseEnvironment: 'production',
      nonBillable: false,
      seatLimit: 5,
      quotas: { users: 5 },
      entitlementsVersion: 6,
      iat: now - 60,
      exp: now + 3600,
    };
    const certificate = (overrides: Record<string, unknown> = {}, privateKey = trusted.privateKey) =>
      signCertificate(privateKey, { ...base, ...overrides }, kid);
    const stored = certificate();
    assert.equal((await verifyLicenseJwtDetailed(stored, instanceId)).ok, true);
    let cases = 0;
    async function expectSelection(
      name: string,
      environmentCertificate: string | undefined,
      storedCertificate: string | null,
      expected: string,
    ): Promise<void> {
      if (environmentCertificate === undefined) delete process.env.CANVAS_LICENSE_CERT;
      else process.env.CANVAS_LICENSE_CERT = environmentCertificate;
      let loads = 0;
      const selected = await claimCertificate(instanceId, async requestedInstance => {
        assert.equal(requestedInstance, instanceId, name);
        loads += 1;
        return storedCertificate;
      });
      assert.equal(selected, expected, name);
      assert.equal(loads, 1, `${name}: load stored even when ENV is configured`);
      cases += 1;
    }

    await expectSelection('stale ENV keeps stored version', certificate({ entitlementsVersion: 5 }), stored, stored);
    await expectSelection('equal ENV keeps stored certificate', stored, stored, stored);
    await expectSelection('equal revision with different claims keeps stored',
      certificate({ seatLimit: 6, quotas: { users: 6 } }), stored, stored);
    const newer = certificate({ entitlementsVersion: 7, iat: now - 90 });
    await expectSelection('newer ENV remains available for bootstrap upgrade', newer, stored, newer);
    const newerIssue = certificate({ iat: now - 30 });
    await expectSelection('same version uses issue time ordering', newerIssue, stored, newerIssue);
    const laterExpiry = certificate({ exp: now + 7200 });
    await expectSelection('same version and issue time use expiry ordering', laterExpiry, stored, laterExpiry);
    await expectSelection('stored without ENV remains accepted for server validation', undefined, stored, stored);
    await expectSelection('malformed ENV cannot displace valid stored', 'not-a-jwt', stored, stored);
    await expectSelection('foreign high-version ENV cannot displace valid stored',
      certificate({ sub: 'foreign-instance', instanceId: 'foreign-instance', entitlementsVersion: 99 }), stored, stored);
    await expectSelection('forged high-version ENV cannot displace valid stored',
      certificate({ entitlementsVersion: 99 }, untrusted.privateKey), stored, stored);
    await expectSelection('expired high-version ENV cannot displace valid stored',
      certificate({ entitlementsVersion: 99, iat: now - 7200, exp: now - 60 }), stored, stored);
    await expectSelection('future-issued high-version ENV cannot displace valid stored',
      certificate({ entitlementsVersion: 99, iat: now + 600 }), stored, stored);
    await expectSelection('invalid product claims cannot displace valid stored',
      certificate({ entitlementsVersion: 99, seatLimit: 0 }), stored, stored);
    await expectSelection('malformed stored preserves valid ENV fallback', newer, 'invalid-stored', newer);
    await expectSelection('foreign stored preserves valid ENV fallback', newer,
      certificate({ sub: 'foreign-instance', instanceId: 'foreign-instance', entitlementsVersion: 99 }), newer);
    await expectSelection('expired stored preserves valid ENV fallback', newer,
      certificate({ entitlementsVersion: 99, iat: now - 7200, exp: now - 60 }), newer);
    const dummy = 'dummy-community-certificate-for-control-plane-validation';
    await expectSelection('ENV-only dummy remains unchanged for server validation', ` ${dummy} `, null, dummy);
    await expectSelection('stored-only preserves existing server validation contract', undefined, 'invalid-stored', 'invalid-stored');
    delete process.env.CANVAS_LICENSE_CERT;
    await assert.rejects(() => claimCertificate(instanceId, async () => null),
      error => error instanceof LicenseControlPlaneError
        && error.status === 409 && error.code === 'TEAM_SEAT_SUBJECT_NOT_FOUND');
    cases += 1;
    const unavailable = new DatabaseUnavailableError('postgres_unavailable', 'Isolated fixture database is unavailable.');
    const unavailableLoader = async (): Promise<null> => { throw unavailable; };
    process.env.CANVAS_LICENSE_CERT = dummy;
    assert.equal(await claimCertificate(instanceId, unavailableLoader), dummy,
      'typed database outage preserves ENV-only server validation');
    cases += 1;
    delete process.env.CANVAS_LICENSE_CERT;
    await assert.rejects(() => claimCertificate(instanceId, unavailableLoader), error => error === unavailable,
      'database outage without ENV remains an error');
    cases += 1;
    process.env.CANVAS_LICENSE_CERT = dummy;
    const unexpected = new Error('Isolated fixture loader corruption.');
    await assert.rejects(() => claimCertificate(instanceId, async () => { throw unexpected; }),
      error => error === unexpected, 'unknown loader failures are never hidden by ENV');
    cases += 1;
    assert.equal(fetches, 0, 'actual JWT verification performs no external requests with configured keys');
    console.log(`license-claim-certificate-selection-test: ${cases}/${cases} passed (real RSA/JWT, injected read-only loader, no database or network IO)`);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of environmentNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

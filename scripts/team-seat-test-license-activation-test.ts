import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fixtures from '../app/lib/license/fixtures/team-seat-protocol-v1.json';
import {
  parseTeamSeatEntitlements,
  parseTeamSeatLicenseClaims,
  parseTeamSeatQuote,
} from '../app/lib/license/team-seat-contract';
import { assertSeatActivationCapacity, SeatLimitGuardError } from '../app/lib/license/seat-limit';
import { adoptActiveTeamMembership } from '../app/lib/organization/team-membership';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

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
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const previous = {
    CANVAS_LICENSE_TEST_PUBLIC_KEY: process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY,
    CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS: process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS,
    CANVAS_LICENSE_RUNTIME_ENVIRONMENT: process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT,
    CANVAS_LICENSE_TEST_AUDIENCE: process.env.CANVAS_LICENSE_TEST_AUDIENCE,
  };
  try {
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const publicFingerprint = fingerprint(publicKey);
    process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY = publicKey;
    process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS = publicFingerprint;
    process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'development';
    delete process.env.CANVAS_LICENSE_TEST_AUDIENCE;
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    const nonBillableTerms = { provider: 'test', nonBillable: true, recurringAmountCents: 0 } as const;
    const claims = parseTeamSeatLicenseClaims({ ...fixtures.positive.licenseClaims, ...nonBillableTerms });
    const entitlements = parseTeamSeatEntitlements({ ...fixtures.positive.entitlements, ...nonBillableTerms });
    const quote = parseTeamSeatQuote({
      ...fixtures.positive.quote,
      unitAmountCents: 0,
      immediateAmountCents: 0,
      recurringAmountCents: nonBillableTerms.recurringAmountCents,
    });
    assert.equal(claims.provider, 'test');
    assert.equal(entitlements.nonBillable, true);
    assert.equal(entitlements.billedSeats, 0);
    assert.equal(quote.recurringAmountCents, 0);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: 'test-activation-instance',
      instanceId: 'test-activation-instance',
      iss: 'canvas-control-plane',
      aud: 'canvas-notebook-test',
      plan: 'community',
      status: 'active',
      protocolVersion: claims.protocolVersion,
      licenseId: claims.licenseId,
      hostingMode: claims.hostingMode,
      edition: claims.edition,
      licenseClass: claims.licenseClass,
      licenseEnvironment: claims.licenseEnvironment,
      provider: claims.provider,
      grantId: claims.grantId,
      nonBillable: claims.nonBillable,
      seatLimit: claims.seatLimit,
      entitlementsVersion: claims.entitlementsVersion,
      deploymentMode: 'community',
      databaseProvider: 'postgres',
      vectorProvider: 'pgvector',
      postgresRequired: true,
      capabilities: { multiUser: true, teamWorkspace: true },
      features: { multiUser: true, teamWorkspace: true },
      quotas: { users: claims.seatLimit },
      iat: now - 60,
      exp: now + 3600,
    };
    const kid = `test-${publicFingerprint.slice(0, 16)}`;
    const certificate = sign(keys.privateKey, payload, kid);
    const verified = await verifyLicenseJwtDetailed(certificate, payload.instanceId);
    assert.equal(verified.ok, true);
    if (!verified.ok) assert.fail('signed test license must verify');
    assert.equal(verified.payload.seatLimit, 3);
    await withTeamSeatTestDatabase(async (database) => {
      const organizationId = 'signed-test-activation';
      const timestamp = Date.now();
      await seedTeamSeatOrganization(database, organizationId, timestamp);
      await adoptActiveTeamMembership(database, {
        organizationId, userId: `owner-${organizationId}`, role: 'owner', source: 'first_owner', now: timestamp,
      });
      assert.deepEqual(await assertSeatActivationCapacity(database, {
        organizationId, desiredQuantity: 2, signedSeatLimit: verified.payload.seatLimit!,
      }), { observedQuantity: 1 });
      for (const index of [2, 3]) {
        const userId = `signed-member-${index}`;
        await database.run(`
          INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
          VALUES ($1, $1, $2, 1, 'user', $3, $3)
        `, [userId, `${userId}@example.test`, timestamp]);
        await adoptActiveTeamMembership(database, {
          organizationId, userId, role: 'member', source: 'migration', now: timestamp,
        });
      }
      await assert.rejects(
        assertSeatActivationCapacity(database, {
          organizationId, desiredQuantity: 4, signedSeatLimit: verified.payload.seatLimit!,
        }),
        (error) => error instanceof SeatLimitGuardError && error.code === 'SEAT_LIMIT_EXCEEDED',
      );
    });
    for (const [changed, code] of [
      [{ ...payload, status: 'revoked' }, 'LICENSE_CERT_STATUS_INVALID'],
      [{ ...payload, exp: now - 1 }, 'LICENSE_CERT_EXPIRED'],
    ] as const) {
      const result = await verifyLicenseJwtDetailed(sign(keys.privateKey, changed, kid), payload.instanceId);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, code);
    }
    const wrongInstance = await verifyLicenseJwtDetailed(certificate, 'other-instance');
    assert.equal(wrongInstance.ok, false);
    if (!wrongInstance.ok) assert.equal(wrongInstance.code, 'LICENSE_CERT_INSTANCE_MISMATCH');
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  console.log('team-seat-test-license-activation-test: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

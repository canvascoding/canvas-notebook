import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NextRequest } from 'next/server';
import { Pool } from 'pg';

if (!process.env.DATABASE_URL?.includes('team_sync_offline_http_')) {
  throw new Error('Use a dedicated team_sync_offline_http_ PostgreSQL database');
}

function sign(privateKey: crypto.KeyObject, payload: Record<string, unknown>, kid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'canvas-managed-offline-http-'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  process.env.DATA = dataDir;
  process.env.CANVAS_INSTANCE_ID = `managed-offline-${randomUUID()}`;
  process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
  process.env.CANVAS_INSTANCE_TOKEN = `ms_${crypto.randomBytes(32).toString('hex')}`;
  process.env.CANVAS_LICENSE_CONTROL_PLANE_URL = 'http://127.0.0.1:9';
  process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'production';
  process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = crypto.createHash('sha256')
    .update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  process.env.CANVAS_LICENSE_PUBLIC_KEY = publicKey;
  process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
  const organizationId = `offline-http-${randomUUID()}`;
  const memberId = `member-${organizationId}`;
  const expirySeconds = Math.floor(Date.now() / 1000) + 30;
  const cert = sign(keys.privateKey, {
    sub: process.env.CANVAS_INSTANCE_ID,
    instanceId: process.env.CANVAS_INSTANCE_ID,
    organizationId,
    iss: 'canvas-control-plane',
    aud: 'canvas-notebook',
    plan: 'managed',
    status: 'active',
    protocolVersion: 'canvas-team-seat-protocol-v1',
    licenseId: `license-${organizationId}`,
    hostingMode: 'cloud',
    edition: 'team',
    licenseClass: 'manual',
    licenseEnvironment: 'production',
    provider: 'manual',
    grantId: `grant-${organizationId}`,
    nonBillable: true,
    seatLimit: 2,
    entitlementsVersion: 1,
    deploymentMode: 'managed-team',
    databaseProvider: 'postgres',
    vectorProvider: 'none',
    postgresRequired: true,
    capabilities: { multiUser: true, teamWorkspace: true },
    features: { multiUser: true, teamWorkspace: true },
    quotas: { users: 2 },
    iat: expirySeconds - 60,
    exp: expirySeconds,
  }, fingerprint.slice(0, 16));
  process.env.CANVAS_LICENSE_CERT = cert;

  try {
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations(pool);
    const { openDb, closeDatabaseConnections } = await import('../app/lib/db');
    const { seedTeamSeatOrganization } = await import('./team-seat-test-db');
    const { adoptActiveTeamMembership } = await import('../app/lib/organization/team-membership');
    const { getLicenseStatus } = await import('../app/lib/license');
    const { recordManagedTeamAccessPolicy, readManagedTeamAccessPolicy } = await import('../app/lib/license/managed-team-access-policy');
    const { reconcileTeamLicenseLifecycle } = await import('../app/lib/license/team-license-lifecycle');
    const { GET } = await import('../app/api/license/status/route');
    const database = await openDb();
    try {
      const now = Date.now();
      await seedTeamSeatOrganization(database, organizationId, now);
      await database.run(`
        INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
        VALUES ($1, 'Offline Member', 'offline-member@example.test', 1, 'user', $2, $2)
      `, [memberId, now]);
      await adoptActiveTeamMembership(database, {
        organizationId, userId: `owner-${organizationId}`, role: 'owner', source: 'first_owner', now,
      });
      await adoptActiveTeamMembership(database, {
        organizationId, userId: memberId, role: 'member', source: 'migration', now,
      });
      await database.run(`
        INSERT INTO organization_user_permissions
          (organization_id, user_id, role, status, created_at, updated_at)
        VALUES ($1, $2, 'owner', 'active', $4, $4),
          ($1, $3, 'member', 'active', $4, $4)
      `, [organizationId, `owner-${organizationId}`, memberId, now]);

      await recordManagedTeamAccessPolicy({
        instanceId: process.env.CANVAS_INSTANCE_ID!, entitlementsVersion: 1,
        policy: { state: 'grace', reason: 'grant_expired',
          graceEndsAt: new Date(expirySeconds * 1000).toISOString(), allowNewMembers: false },
      });
      assert.equal((await readManagedTeamAccessPolicy(process.env.CANVAS_INSTANCE_ID!))?.state, 'grace');
      const activeResponse = await GET(new NextRequest('http://127.0.0.1:3101/api/license/status'));
      const active = await activeResponse.json();
      assert.equal(activeResponse.status, 200);
      assert.equal(active.licensed, true);
      assert.equal(active.licenseState, 'active');
      assert.equal(active.teamSeatHealth, undefined);

      await delay(Math.max(0, expirySeconds * 1000 - Date.now() + 100));
      const expiredResponse = await GET(new NextRequest('http://127.0.0.1:3101/api/license/status'));
      const expired = await expiredResponse.json();
      assert.equal(expiredResponse.status, 200);
      assert.equal(expired.licensed, false);
      assert.equal(expired.licenseState, 'grace_required');
      assert.equal(expired.code, 'LICENSE_CERT_EXPIRED');
      assert.equal((await readManagedTeamAccessPolicy(process.env.CANVAS_INSTANCE_ID!))?.state, 'grace');
      const expiredStatus = await getLicenseStatus();
      const fallback = await reconcileTeamLicenseLifecycle(expiredStatus, { database });
      assert.equal(fallback.mode, 'solo');
      assert.equal(fallback.disabledUsers, 1);
      const members = await database.all(`
        SELECT membership.user_id, membership.status, "user".banned
        FROM team_memberships membership JOIN "user" ON "user".id = membership.user_id
        WHERE membership.organization_id = $1 ORDER BY membership.role DESC
      `, [organizationId]) as Array<{ user_id: string; status: string; banned: number | boolean | null }>;
      assert.equal(members.find((member) => member.user_id === `owner-${organizationId}`)?.status, 'active');
      assert.equal(Number(members.find((member) => member.user_id === `owner-${organizationId}`)?.banned ?? 0), 0);
      assert.equal(members.find((member) => member.user_id === memberId)?.status, 'suspended');
      assert.equal(Number(members.find((member) => member.user_id === memberId)?.banned), 1);
    } finally {
      await database.close();
      await closeDatabaseConnections();
    }
  } finally {
    await pool.end();
    await rm(dataDir, { recursive: true, force: true });
  }
  console.info('Managed grace policy remains bounded by certificate expiry; offline expiry exposes status and owner-only fallback.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
